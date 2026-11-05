# -*- coding: utf-8 -*-
"""
地籍共作平台 — 伺服器（只用 Python 內建模組，不用另外安裝任何東西）

啟動：python server/app.py        （預設 http://本機IP:8080）
      python server/app.py --port 9000 --data D:\\共作平台資料
"""
import argparse
import base64
import gzip
import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import traceback
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import basemap   # noqa: E402
import datum     # noqa: E402
import parsers   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')

SCHEMA = """
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surveyor TEXT NOT NULL,
  note TEXT DEFAULT '',
  created REAL NOT NULL,
  sections TEXT DEFAULT '',
  files TEXT DEFAULT '[]',
  report TEXT DEFAULT '[]',
  stats TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  section TEXT, kind TEXT, name TEXT, y REAL, x REAL, src TEXT, extra TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS used (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  section TEXT, name TEXT, y REAL, x REAL, src TEXT, how TEXT, ctl_id TEXT, delta REAL
);
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  section TEXT, station TEXT, sy REAL, sx REAL, back TEXT, by REAL, bx REAL,
  target TEXT, ty REAL, tx REAL, angle TEXT, dist REAL, src TEXT
);
CREATE INDEX IF NOT EXISTS i_points_batch ON points(batch_id);
CREATE INDEX IF NOT EXISTS i_used_batch ON used(batch_id);
CREATE INDEX IF NOT EXISTS i_links_batch ON links(batch_id);
"""

# 同一位測量員、同一段、同一種點、同一點名，只看最新那次上傳
LATEST_POINTS = """
SELECT p.*, b.surveyor, b.created FROM points p JOIN batches b ON b.id = p.batch_id
WHERE p.id IN (
  SELECT id FROM (
    SELECT p2.id, ROW_NUMBER() OVER (PARTITION BY b2.surveyor, p2.section, p2.kind, UPPER(p2.name)
                                     ORDER BY p2.batch_id DESC) AS rn
    FROM points p2 JOIN batches b2 ON b2.id = p2.batch_id) WHERE rn = 1)
"""


class Platform:
    def __init__(self, data_dir):
        self.data = os.path.abspath(data_dir)
        self.base = os.path.join(self.data, 'base')
        self.cache = os.path.join(self.data, 'cache')
        self.uploads = os.path.join(self.data, 'uploads')
        for d in (self.base, self.cache, self.uploads):
            os.makedirs(d, exist_ok=True)
        self.cfg_path = os.path.join(self.data, 'config.json')
        # twd67_sections：None = 段名表紅字 + 自動偵測；清單 = 管理者指定
        self.cfg = {'tolerance_cm': 2.0, 'section_names': {}, 'twd67_sections': None,
                    'abolished_sections': list(basemap.ABOLISHED)}
        if os.path.exists(self.cfg_path):
            with open(self.cfg_path, encoding='utf-8') as f:
                self.cfg.update(json.load(f))
        self.cfg.pop('datum', None)   # 舊版設定：現在一律換成 TWD97
        self.save_cfg()
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'section_names.json'), encoding='utf-8') as f:
            self.default_names = json.load(f)
        self.lock = threading.Lock()
        self.db_path = os.path.join(self.data, 'platform.sqlite')
        with self.db() as c:
            c.executescript(SCHEMA)
        self.ready = False
        self.build_error = None
        self.index = {'sections': [], 'ctl': {}, 'datum': {}}
        self.controls, self.ctl_by_name, self.trans, self.parcel_index = [], {}, {}, None

    def start(self):
        """背景整理底圖（第一次大約 40 秒），網頁先開得起來"""
        def run():
            try:
                self.rebuild(False)
            except Exception as e:   # noqa: BLE001
                traceback.print_exc()
                self.build_error = str(e)
        threading.Thread(target=run, daemon=True).start()

    def save_cfg(self):
        with open(self.cfg_path, 'w', encoding='utf-8') as f:
            json.dump(self.cfg, f, ensure_ascii=False, indent=2)

    def db(self):
        c = sqlite3.connect(self.db_path, timeout=30)
        c.row_factory = sqlite3.Row
        return c

    # ── 底圖 ──
    def rebuild(self, force=True):
        with self.lock:
            self.index = basemap.build(self.base, self.cache, self.cfg.get('twd67_sections'), force=force,
                                       abolished=self.cfg.get('abolished_sections'))
            self.trans = {s['section']: datum.Transform.from_json(s['tparams'])
                          for s in self.index['sections'] if s.get('tparams')}
            with open(os.path.join(self.cache, 'controls.json'), encoding='utf-8') as f:
                self.controls = json.load(f)
            self.ctl_by_name = {}
            for p in self.controls:
                self.ctl_by_name.setdefault(p['name'].upper(), []).append(p)
            self.parcel_index = None
            self.ready = True

    def parcels(self):
        """地號索引（第一次查詢時才建立）：[(段, 地號, 中心)]"""
        if self.parcel_index is None:
            idx = []
            for s in self.index['sections']:
                p = os.path.join(self.cache, 'sections', s['section'] + '.json')
                if not os.path.exists(p):
                    continue
                with open(p, encoding='utf-8') as f:
                    for q in json.load(f)['parcels']:
                        idx.append((s['section'], q['k'], q['c'], q.get('a')))
            self.parcel_index = idx
        return self.parcel_index

    def ll(self, y, x):
        if parsers.coord_status(y, x) != 'ok':
            return None
        return [round(v, 7) for v in parsers.tm2_to_latlng(y, x)]

    def names(self):
        n = dict(self.default_names)
        n.update(self.cfg.get('section_names') or {})
        return n

    def to97(self, sec, y, x):
        T = self.trans.get(sec)
        if T and parsers.coord_status(y, x) == 'ok':
            return tuple(round(v, 3) for v in T(y, x))
        return y, x

    def nearest_ctl(self, name, y, x):
        """同名圖根點裡最近的一點；換算後（97）與原始坐標（可能是 67）都比，取比較近的"""
        best = None
        for p in self.ctl_by_name.get(name.upper(), []):
            for cy, cx in [(p['y'], p['x'])] + [tuple(r) for r in p.get('raw', [])]:
                d = math.hypot(cy - y, cx - x)
                if best is None or d < best[1]:
                    best = (p, d)
        return best

    # ── 上傳 ──
    def analyze(self, surveyor, files):
        """先看看（不存檔）：解析、比對圖根點、檢查跟別人的補點有沒有衝突"""
        res = parsers.parse_field_files(files)
        tol = self.cfg.get('tolerance_cm', 2.0) / 100.0
        report = [list(r) for r in res['report']]
        bad_ctl = []
        for u in res['used']:
            hit = self.nearest_ctl(u['name'], u['y'], u['x'])
            if hit is None:
                u['ctl_id'], u['delta'] = None, None
                if not u['name'].upper().startswith('Q'):
                    report.append(['info', '%s 用到的「%s」在圖根點檔（.CTL）裡找不到' % (u['section'], u['name'])])
            else:
                u['ctl_id'], u['delta'] = hit[0]['id'], round(hit[1], 4)
                if hit[1] > tol:
                    bad_ctl.append(u)
                    report.append(['warn', '%s 用到的圖根點「%s」跟圖根點檔差 %s（%s）' % (
                        u['section'], u['name'], fmt_dist(hit[1]), os.path.basename(u['src']))])
        # 67 段的資料換成 97 再存（原始坐標留在 orig）
        conv = sorted(set(p['section'] for p in res['points'] + res['used'] + res['links'] if p['section'] in self.trans))
        for p in res['points'] + res['used']:
            if p['section'] in self.trans:
                p['orig'] = [p['y'], p['x']]
                p['y'], p['x'] = self.to97(p['section'], p['y'], p['x'])
        for l in res['links']:
            if l['section'] in self.trans:
                l['sy'], l['sx'] = self.to97(l['section'], l['sy'], l['sx'])
                l['ty'], l['tx'] = self.to97(l['section'], l['ty'], l['tx'])
                if l['by']:
                    l['by'], l['bx'] = self.to97(l['section'], l['by'], l['bx'])
        if conv:
            report.append(['info', '%s 是 TWD67 的段，坐標已換成 TWD97 顯示（%s）' % (
                '、'.join(self.sec_name(c) for c in conv), self.trans[conv[0]].describe())])
        # 跟其他測量員的補點比對
        with self.db() as c:
            others = [dict(r) for r in c.execute(LATEST_POINTS + " AND p.kind = '補點'")]
        for p in res['points']:
            if p['kind'] != '補點':
                continue
            for o in others:
                if o['surveyor'] == surveyor:
                    continue
                d = math.hypot(o['y'] - p['y'], o['x'] - p['x'])
                if o['name'].upper() == p['name'].upper() and o['section'] == p['section'] and d > tol:
                    report.append(['warn', '補點「%s」%s 也有上傳，但坐標差 %s，請兩位確認' % (
                        p['name'], o['surveyor'], fmt_dist(d))])
                elif o['name'].upper() != p['name'].upper() and d <= tol:
                    report.append(['info', '補點「%s」跟 %s 的補點「%s」幾乎同一位置（%s），可能是同一點' % (
                        p['name'], o['surveyor'], o['name'], fmt_dist(d))])
        res['report'] = report
        res['stats'] = {
            '補點': sum(1 for p in res['points'] if p['kind'] == '補點'),
            '參考點': sum(1 for p in res['points'] if p['kind'] == '參考點'),
            '控制點': sum(1 for p in res['points'] if p['kind'] == '控制點'),
            '圖根點': len(res['used']),
            '圖根點不符': len(bad_ctl),
            '設站': len(res['links']),
        }
        return res

    def save(self, surveyor, note, files, res):
        names = [p for p, _ in files]
        with self.lock, self.db() as c:
            cur = c.execute('INSERT INTO batches(surveyor, note, created, sections, files, report, stats) '
                            'VALUES (?,?,?,?,?,?,?)',
                            (surveyor, note, time.time(), ','.join(res['sections']),
                             json.dumps(names, ensure_ascii=False), json.dumps(res['report'], ensure_ascii=False),
                             json.dumps(res['stats'], ensure_ascii=False)))
            bid = cur.lastrowid
            for p in res['points']:
                extra = {k: v for k, v in p.items() if k not in ('section', 'kind', 'name', 'y', 'x', 'src')}
                c.execute('INSERT INTO points(batch_id, section, kind, name, y, x, src, extra) VALUES (?,?,?,?,?,?,?,?)',
                          (bid, p['section'], p['kind'], p['name'], p['y'], p['x'], p['src'],
                           json.dumps(extra, ensure_ascii=False)))
            for u in res['used']:
                c.execute('INSERT INTO used(batch_id, section, name, y, x, src, how, ctl_id, delta) VALUES (?,?,?,?,?,?,?,?,?)',
                          (bid, u['section'], u['name'], u['y'], u['x'], u['src'], u['how'], u['ctl_id'], u['delta']))
            for l in res['links']:
                c.execute('INSERT INTO links(batch_id, section, station, sy, sx, back, by, bx, target, ty, tx, angle, dist, src) '
                          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                          (bid, l['section'], l['station'], l['sy'], l['sx'], l['back'], l['by'], l['bx'],
                           l['target'], l['ty'], l['tx'], l['angle'], l['dist'], l['src']))
        # 原始檔留一份（zip），之後可以下載
        with zipfile.ZipFile(os.path.join(self.uploads, '%d.zip' % bid), 'w', zipfile.ZIP_DEFLATED) as zf:
            for path, data in files:
                zf.writestr(path.replace('\\', '/').lstrip('/'), data)
        return bid

    def delete_batch(self, bid):
        with self.lock, self.db() as c:
            for t in ('points', 'used', 'links'):
                c.execute('DELETE FROM %s WHERE batch_id = ?' % t, (bid,))
            c.execute('DELETE FROM batches WHERE id = ?', (bid,))
        p = os.path.join(self.uploads, '%d.zip' % bid)
        if os.path.exists(p):
            os.remove(p)

    # ── 查詢 ──
    def field_data(self):
        with self.db() as c:
            pts = [dict(r) for r in c.execute(LATEST_POINTS)]
            batches = [dict(r) for r in c.execute('SELECT id, surveyor, note, created, sections, stats FROM batches ORDER BY id DESC')]
            used = [dict(r) for r in c.execute('SELECT u.*, b.surveyor, b.created FROM used u JOIN batches b ON b.id=u.batch_id')]
            links = [dict(r) for r in c.execute('SELECT l.*, b.surveyor, b.created FROM links l JOIN batches b ON b.id=l.batch_id')]
        latest_batch = {}
        for p in pts:
            p['ll'] = self.ll(p['y'], p['x'])
            p['extra'] = json.loads(p['extra'] or '{}')
        # 同一點被不同測量員上傳 → 加註
        groups = {}
        for p in pts:
            groups.setdefault((p['section'], p['kind'], p['name'].upper()), []).append(p)
        tol = self.cfg.get('tolerance_cm', 2.0) / 100.0
        for g in groups.values():
            if len(g) > 1:
                for p in g:
                    p['others'] = [{'surveyor': o['surveyor'], 'y': o['y'], 'x': o['x'],
                                    'd': round(math.hypot(o['y'] - p['y'], o['x'] - p['x']), 4)}
                                   for o in g if o is not p]
                    p['conflict'] = any(o['d'] > tol for o in p['others'])
        # 用到的圖根點：同一點只留最新的一筆，但保留「不符」的紀錄
        used_out = {}
        for u in sorted(used, key=lambda r: r['batch_id']):
            k = (u['surveyor'], u['name'].upper(), round(u['y'], 3), round(u['x'], 3))
            u['ll'] = self.ll(u['y'], u['x'])
            used_out[k] = u
        for l in links:
            l['sll'], l['tll'] = self.ll(l['sy'], l['sx']), self.ll(l['ty'], l['tx'])
            l['bll'] = self.ll(l['by'], l['bx']) if l['by'] else None
        for b in batches:
            b['stats'] = json.loads(b['stats'] or '{}')
            latest_batch.setdefault(b['surveyor'], b['id'])
        return {'points': pts, 'used': list(used_out.values()), 'links': links, 'batches': batches}

    def search(self, q):
        q = q.strip()
        out = []
        if not q:
            return out
        qu = q.upper()
        # 地號：「123」「123-4」「123之4」「1114 123-4」「KC1114 123-4」
        m = re.fullmatch(r'(?:(?:[A-Z]{2})?(\d{3,4})\s*[段\s,，]\s*)?0*(\d+)\s*(?:[-之]\s*0*(\d+))?\s*(?:地號)?', qu)
        if m:
            sec = m.group(1)
            key = parsers.parcel_label(m.group(2), m.group(3) or '0')
            for s, k, c, a in self.parcels():
                if k == key and (not sec or s.endswith(sec.zfill(4))):
                    out.append({'type': '地號', 'label': '%s %s 地號' % (self.sec_name(s), k), 'section': s,
                                'parcel': k, 'll': c, 'area': a})
        with self.db() as c:
            for r in c.execute(LATEST_POINTS + ' AND UPPER(p.name) LIKE ? ORDER BY p.name LIMIT 50', (qu + '%',)):
                out.append({'type': r['kind'], 'label': '%s（%s，%s）' % (r['name'], r['surveyor'], self.sec_name(r['section'])),
                            'll': self.ll(r['y'], r['x']), 'name': r['name'], 'section': r['section']})
            for r in c.execute('SELECT id, surveyor, created, sections FROM batches WHERE surveyor LIKE ? ORDER BY id DESC LIMIT 20',
                               ('%' + q + '%',)):
                out.append({'type': '上傳', 'label': '%s 的上傳（%s，%s）' % (
                    r['surveyor'], time.strftime('%m/%d %H:%M', time.localtime(r['created'])), r['sections']),
                    'batch': r['id']})
        n = 0
        for p in self.controls:
            if p['name'].upper().startswith(qu):
                out.append({'type': '圖根點', 'label': '%s（%s）' % (p['name'], ','.join(p['sections'][:3]) + ('…' if len(p['sections']) > 3 else '')),
                            'll': p.get('ll'), 'name': p['name'], 'id': p['id']})
                n += 1
                if n >= 50:
                    break
        return out[:150]

    def export_ctl_zip(self):
        """
        每段一份標準格式的 CTL（全部 TWD97）：點名(8) Y(11) X(10)，例如「BE20    2697345.532219817.771」。
        另附「全區圖根點_TWD97.CTL」（去重複）與「整理說明.txt」（改了什麼、哪些行拿掉）。
        """
        with open(os.path.join(self.cache, 'ctl_entries.json'), encoding='utf-8') as f:
            d = json.load(f)
        by_sec = {}
        for e in d['entries']:
            by_sec.setdefault(e['section'], []).append(e)
        notes = ['圖根點整理說明（%s）' % time.strftime('%Y-%m-%d %H:%M'), '',
                 '格式：點名 8 字、Y（縱、N）11 字、X（橫、E）10 字，小數 3 位，全部是 TWD97。',
                 'Y/X 判斷：整數 7 位是 Y、6 位是 X（同轉換系統），寫反的已對調。',
                 'X 後面多出來的字（第 4 位小數或註記碼）照固定欄寬捨去。', '']
        buf = BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for sec in sorted(by_sec):
                lines = [d['headers'].get(sec, '')]
                for e in by_sec[sec]:
                    tag = '%s 第 %s 行 %s' % (sec, e['line'], e['name'])
                    if e['status'] != 'ok':
                        notes.append('拿掉 %s：%s' % (tag, {'local': '假設坐標', 'zero': '坐標是 0', 'bad': '看不懂'}.get(e['status'], e['status'])))
                        continue
                    try:
                        lines.append(parsers.format_ctl_line(e['name'], e['y'], e['x']))
                    except ValueError as err:
                        notes.append('拿掉 %s：%s' % (tag, err))
                        continue
                    msg = list(e.get('fix') or [])
                    if e.get('datum') == 'TWD67':
                        msg.append('67→97（原 %.3f %.3f；%s）' % (e['raw'][0], e['raw'][1], e.get('datum_why', '')))
                    elif e.get('datum') == '?':
                        msg.append('看不出 67 或 97，照原值當 97，請確認')
                    if msg:
                        notes.append('%s：%s' % (tag, '；'.join(msg)))
                zf.writestr('%s/%s.CTL' % (sec, sec), '\r\n'.join(lines) + '\r\n')
            allp = []
            for p in self.controls:
                if p['status'] != 'ok':
                    continue
                try:
                    allp.append(parsers.format_ctl_line(p['name'], p['y'], p['x']))
                except ValueError:
                    pass
            zf.writestr('全區圖根點_TWD97.CTL', '\r\n'.join(['KCK000000000'] + allp) + '\r\n')
            zf.writestr('整理說明.txt', '\ufeff' + '\r\n'.join(notes))
        return buf.getvalue()

    def sec_name(self, s):
        n = self.names().get(s)
        return '%s(%s)' % (n, s) if n else s


def fmt_dist(d):
    return '%.1f 公分' % (d * 100) if d < 1 else '%.2f 公尺' % d


# ───────────────────────── HTTP ─────────────────────────

LOGIN_HTML = '''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>地籍共作平台</title>
<style>body{font-family:"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif;background:#12355b;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh}form{background:#fff;padding:28px;border-radius:16px;
width:320px;max-width:90%%}h1{font-size:22px;margin:0 0 16px}input{width:100%%;box-sizing:border-box;font-size:20px;padding:12px;
border:2px solid #d0d5dd;border-radius:10px}button{margin-top:12px;width:100%%;font-size:20px;padding:12px;border:0;border-radius:10px;
background:#13834a;color:#fff;font-weight:bold}p{color:#d92d20}</style></head><body>
<form method="post" action="/login"><h1>🗺 地籍共作平台</h1><input type="password" name="pw" placeholder="請輸入共用密碼" autofocus>
<button>進入</button>%s</form></body></html>'''


class Handler(BaseHTTPRequestHandler):
    platform = None
    password = os.environ.get('ACCESS_PASSWORD', '')
    server_version = 'MapCollab/1.0'

    def token(self):
        return hmac.new(self.password.encode(), b'map-collab', hashlib.sha256).hexdigest()

    def authed(self):
        if not self.password:
            return True
        for part in (self.headers.get('Cookie') or '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == 'mc_auth' and hmac.compare_digest(v, self.token()):
                return True
        return False

    def need_login(self):
        if self.path.startswith('/api/'):
            self.send(401, {'error': '請重新整理網頁並輸入密碼'})
        else:
            self.send(200, LOGIN_HTML % '', 'text/html; charset=utf-8')

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    def send(self, code, body, ctype='application/json; charset=utf-8', cache=False):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        elif isinstance(body, str):
            body = body.encode('utf-8')
        if len(body) > 2048 and 'gzip' in self.headers.get('Accept-Encoding', ''):
            body = gzip.compress(body, 5)
            gz = True
        else:
            gz = False
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        if gz:
            self.send_header('Content-Encoding', 'gzip')
        self.send_header('Cache-Control', 'max-age=3600' if cache else 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, cache=False):
        if not os.path.isfile(path):
            return self.send(404, {'error': '找不到'})
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        with open(path, 'rb') as f:
            self.send(200, f.read(), ctype, cache)

    def body_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}

    def do_GET(self):
        try:
            if self.path.split('?')[0] == '/login':   # 也是 Render 的健康檢查
                return self.send(200, LOGIN_HTML % '', 'text/html; charset=utf-8')
            if not self.authed():
                return self.need_login()
            self.route_get()
        except Exception as e:   # noqa: BLE001
            traceback.print_exc()
            self.send(500, {'error': str(e)})

    def do_POST(self):
        try:
            if self.path == '/login':
                n = int(self.headers.get('Content-Length') or 0)
                pw = urllib.parse.parse_qs(self.rfile.read(n).decode('utf-8')).get('pw', [''])[0]
                if self.password and hmac.compare_digest(pw, self.password):
                    self.send_response(303)
                    self.send_header('Location', '/')
                    self.send_header('Set-Cookie', 'mc_auth=%s; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax' % self.token())
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                return self.send(200, LOGIN_HTML % '<p>密碼不對，再試一次</p>', 'text/html; charset=utf-8')
            if not self.authed():
                return self.need_login()
            self.route_post()
        except Exception as e:   # noqa: BLE001
            traceback.print_exc()
            self.send(500, {'error': str(e)})

    def route_get(self):
        P = self.platform
        u = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(u.path)
        qs = urllib.parse.parse_qs(u.query)
        if path.startswith('/api/') and not P.ready:
            return self.send(503, {'error': P.build_error and ('底圖整理失敗：' + P.build_error) or '底圖整理中，請等一分鐘再重新整理網頁',
                                   'building': True})
        if path == '/' or path == '/index.html':
            return self.send_file(os.path.join(WEB, 'index.html'))
        if path.startswith('/web/'):
            full = os.path.normpath(os.path.join(WEB, path[5:]))
            if not full.startswith(WEB):
                return self.send(403, {'error': '不可以'})
            return self.send_file(full, cache='/vendor/' in path)
        if path == '/api/info':
            return self.send(200, {'datum': P.index.get('datum', {}), 'tolerance_cm': P.cfg.get('tolerance_cm', 2.0),
                                   'section_names': P.names(), 'custom_names': P.cfg.get('section_names', {}),
                                   'abolished': P.cfg.get('abolished_sections', []),
                                   'sections': P.index['sections'], 'ctl': P.index['ctl']})
        if path == '/api/controls':
            return self.send_file(os.path.join(P.cache, 'controls.json'))
        if path == '/api/ctl_issues':
            return self.send_file(os.path.join(P.cache, 'ctl_issues.json'))
        m = re.fullmatch(r'/api/section/([A-Za-z]{2}\d{4})', path)
        if m:
            return self.send_file(os.path.join(P.cache, 'sections', m.group(1).upper() + '.json'))
        if path == '/api/field':
            return self.send(200, P.field_data())
        if path == '/api/search':
            return self.send(200, P.search((qs.get('q') or [''])[0]))
        m = re.fullmatch(r'/api/batch/(\d+)', path)
        if m:
            with P.db() as c:
                b = c.execute('SELECT * FROM batches WHERE id=?', (int(m.group(1)),)).fetchone()
            if not b:
                return self.send(404, {'error': '找不到這次上傳'})
            b = dict(b)
            for k in ('files', 'report', 'stats'):
                b[k] = json.loads(b[k])
            return self.send(200, b)
        m = re.fullmatch(r'/api/batch/(\d+)/download', path)
        if m:
            p = os.path.join(P.uploads, m.group(1) + '.zip')
            if not os.path.exists(p):
                return self.send(404, {'error': '原始檔不見了'})
            with open(p, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Disposition', 'attachment; filename="upload_%s.zip"' % m.group(1))
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if path == '/api/export/controls.csv':
            rows = ['點名,Y(縱),X(橫),出現在哪些段,出現次數,註記碼,說明']
            for p in P.controls:
                rows.append(','.join(csv_cell(v) for v in [p['id'], '%.3f' % p['y'], '%.3f' % p['x'],
                                                          ' '.join(p['sections']), p['count'], ' '.join(p['flags']),
                                                          '；'.join(p['notes'])]))
            return self.send_download('\ufeff' + '\r\n'.join(rows), '圖根點整理.csv')
        if path == '/api/export/ctl.zip':
            return self.send_bytes(P.export_ctl_zip(), 'application/zip', '圖根點_TWD97.zip')
        if path == '/api/export/field.csv':
            d = P.field_data()
            rows = ['種類,點名,Y(縱),X(橫),段,測量員,上傳時間,來源檔']
            for p in d['points']:
                rows.append(','.join(csv_cell(v) for v in [p['kind'], p['name'], '%.3f' % p['y'], '%.3f' % p['x'], p['section'],
                                                          p['surveyor'], time.strftime('%Y-%m-%d %H:%M', time.localtime(p['created'])),
                                                          os.path.basename(p['src'])]))
            return self.send_download('\ufeff' + '\r\n'.join(rows), '補點參考點.csv')
        return self.send(404, {'error': '找不到 ' + path})

    def send_bytes(self, data, ctype, filename):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + urllib.parse.quote(filename))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_download(self, text, filename):
        data = text.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/csv; charset=utf-8')
        self.send_header('Content-Disposition', "attachment; filename*=UTF-8''" + urllib.parse.quote(filename))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def route_post(self):
        P = self.platform
        path = urllib.parse.urlparse(self.path).path
        if path in ('/api/upload', '/api/preview'):
            d = self.body_json()
            surveyor = (d.get('surveyor') or '').strip()
            if not surveyor:
                return self.send(400, {'error': '請先填你的名字'})
            files = [(f['path'], base64.b64decode(f['b64'])) for f in d.get('files', [])]
            if not files:
                return self.send(400, {'error': '沒有收到檔案'})
            res = P.analyze(surveyor, files)
            out = {'report': res['report'], 'stats': res['stats'], 'sections': res['sections'],
                   'points': res['points'], 'used': [u for u in res['used'] if u['delta'] is None or
                                                     u['delta'] > P.cfg.get('tolerance_cm', 2.0) / 100]}
            if path == '/api/upload':
                if not res['points'] and not res['used'] and not res['links']:
                    return self.send(400, {'error': '這些檔案裡沒有可以用的資料', 'report': res['report']})
                out['batch'] = P.save(surveyor, d.get('note', ''), files, res)
            return self.send(200, out)
        m = re.fullmatch(r'/api/batch/(\d+)/delete', path)
        if m:
            P.delete_batch(int(m.group(1)))
            return self.send(200, {'ok': True})
        if path == '/api/base/upload':
            d = self.body_json()
            for f in d.get('files', []):
                name = os.path.basename(f['path'].replace('\\', '/'))
                parts = [x for x in f['path'].replace('\\', '/').split('/') if x and x != '.']
                if not parts or '..' in parts or any(':' in x for x in parts):
                    continue
                rel = '/'.join(parts)
                target = os.path.join(P.base, *rel.split('/')) if not name.lower().endswith('.zip') else os.path.join(P.base, name)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as fh:
                    fh.write(base64.b64decode(f['b64']))
            P.rebuild(True)
            return self.send(200, {'ok': True, 'sections': len(P.index['sections']), 'ctl': P.index['ctl']})
        if path == '/api/section_names/xlsx':
            d = self.body_json()
            names = parsers.section_names_from_xlsx(base64.b64decode(d['b64']))
            if not names:
                return self.send(400, {'error': '這個 Excel 裡找不到「段代碼＋段名」'})
            P.cfg.setdefault('section_names', {}).update(names)
            P.save_cfg()
            return self.send(200, {'ok': True, 'count': len(names)})
        if path == '/api/base/rebuild':
            P.rebuild(True)
            return self.send(200, {'ok': True, 'sections': len(P.index['sections']), 'ctl': P.index['ctl']})
        if path == '/api/config':
            d = self.body_json()
            changed = False
            if isinstance(d.get('abolished_sections'), list):
                v = sorted(set(str(x).strip().upper() for x in d['abolished_sections'] if str(x).strip()))
                if v != P.cfg.get('abolished_sections'):
                    P.cfg['abolished_sections'] = v
                    changed = True
            if 'twd67_sections' in d:
                v = d['twd67_sections']
                v = None if v is None else sorted(set(str(x).strip().upper() for x in v if str(x).strip()))
                if v != P.cfg.get('twd67_sections'):
                    P.cfg['twd67_sections'] = v
                    changed = True
            if 'tolerance_cm' in d:
                P.cfg['tolerance_cm'] = float(d['tolerance_cm'])
            if isinstance(d.get('section_names'), dict):
                # 只存跟預設段名表不一樣的
                P.cfg['section_names'] = {k.upper(): v for k, v in d['section_names'].items()
                                          if v and P.default_names.get(k.upper()) != v}
            P.save_cfg()
            if changed:
                P.rebuild(True)
            return self.send(200, {'ok': True})
        return self.send(404, {'error': '找不到 ' + path})


def csv_cell(v):
    v = '' if v is None else str(v)
    return '"' + v.replace('"', '""') + '"' if re.search(r'[",\n]', v) else v


def local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for i in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(i[4][0])
    except OSError:
        pass
    ips.discard('127.0.0.1')
    return sorted(ips)


def main():
    ap = argparse.ArgumentParser(description='地籍共作平台')
    # 雲端（Render）用環境變數：PORT、DATA_DIR、ACCESS_PASSWORD
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8080)))
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--data', default=os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data'))
    a = ap.parse_args()
    print('讀取資料中，第一次可能要等一兩分鐘…')
    Handler.platform = Platform(a.data)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    Handler.platform.start()
    print('=' * 56)
    print(' 地籍共作平台已啟動！請大家用瀏覽器打開：')
    for ip in local_ips() or ['本機IP']:
        print('   http://%s:%d' % (ip, a.port))
    print('   （這台電腦自己用：http://localhost:%d）' % a.port)
    print(' 資料放在：' + Handler.platform.data)
    print(' 密碼：' + ('已設定（ACCESS_PASSWORD）' if Handler.password else '沒有設定，誰都能進'))
    print(' 要關掉平台：關閉這個視窗')
    print('=' * 56)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
