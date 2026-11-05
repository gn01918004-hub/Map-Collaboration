# -*- coding: utf-8 -*-
"""
數值地籍圖底圖：掃描 data/base 底下的 KCxxxx 資料夾（或 zip），全部換算成 TWD97，
整理成網頁要用的快取檔（每段一個 JSON），以及整理過的圖根點清單。
"""
import collections
import hashlib
import json
import math
import os
import zipfile

import datum
import parsers

# 段名表裡紅字（67 數值）的段
SHEET_67 = ['KC' + s for s in (
    '0346 0347 0348 0349 0350 0351 0352 0353 0357 0358 0359 0360 0361 0362 0363 0364 0365 '
    '0367 0370 0375 0376 0377 0378 0379 0380').split()]

VERSION = 3   # 快取格式／演算法改了就加 1，強制重建


def _unzip_all(base_dir):
    """data/base 底下的 zip 解到 data/base/_解開/<zip 名稱>/（只解一次）"""
    out_root = os.path.join(base_dir, '_解開')
    for fn in os.listdir(base_dir):
        if not fn.lower().endswith('.zip'):
            continue
        src = os.path.join(base_dir, fn)
        dst = os.path.join(out_root, fn[:-4])
        stamp = os.path.join(dst, '.stamp')
        sig = '%d-%d' % (os.path.getsize(src), int(os.path.getmtime(src)))
        if os.path.exists(stamp) and open(stamp).read() == sig:
            continue
        with zipfile.ZipFile(src) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = parsers.zip_name(info).replace('\\', '/')
                parts = [p for p in name.split('/') if p and p != '.']
                if '..' in parts or any(':' in p for p in parts):
                    continue
                target = os.path.join(dst, *parts)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as f:
                    f.write(zf.read(info))
        with open(stamp, 'w') as f:
            f.write(sig)


def find_sections(base_dir):
    """回傳 {段代碼: {副檔名: 路徑}}；同一段出現兩次時用比較新的檔"""
    os.makedirs(base_dir, exist_ok=True)
    _unzip_all(base_dir)
    found = {}
    for root, _dirs, files in os.walk(base_dir):
        for fn in files:
            ext = parsers.ext_of(fn)
            if ext not in ('COA', 'BNP', 'PAR', 'CTL'):
                continue
            path = os.path.join(root, fn)
            sec = parsers.section_of(path)
            if not sec:
                continue
            d = found.setdefault(sec, {})
            if ext not in d or os.path.getmtime(path) > os.path.getmtime(d[ext]):
                d[ext] = path
    return found


def _signature(found, sec67):
    h = hashlib.sha1(('v%d|%s' % (VERSION, ','.join(sorted(sec67 or [])) if sec67 is not None else 'auto')).encode())
    for sec in sorted(found):
        for ext in sorted(found[sec]):
            p = found[sec][ext]
            h.update(('%s|%s|%d|%d' % (sec, ext, os.path.getsize(p), int(os.path.getmtime(p)))).encode())
    return h.hexdigest()


def _read(path):
    with open(path, 'rb') as f:
        return parsers.decode(f.read())


def _grid(pts, cell=50.0):
    g = collections.defaultdict(list)
    for p in pts:
        g[(int(p[0] // cell), int(p[1] // cell))].append(p)
    return g


def _nearest(g, y, x, cell=50.0, r=6):
    i, j = int(y // cell), int(x // cell)
    best = 1e18
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            for q in g.get((i + di, j + dj), ()):
                d = (q[0] - y) ** 2 + (q[1] - x) ** 2
                if d < best:
                    best = d
    return math.sqrt(best)


def build(base_dir, cache_dir, sec67=None, force=False, log=print):
    """
    建立快取。sec67：管理者指定的 67 段清單（None = 用段名表紅字 + 自動偵測）。
    回傳索引（sections、controls、datum 的摘要）
    """
    found = find_sections(base_dir)
    sig = _signature(found, sec67)
    os.makedirs(os.path.join(cache_dir, 'sections'), exist_ok=True)
    idx_path = os.path.join(cache_dir, 'index.json')
    if not force and os.path.exists(idx_path):
        with open(idx_path, encoding='utf-8') as f:
            idx = json.load(f)
        if idx.get('signature') == sig:
            return idx
    log('重新整理底圖：%d 個段' % len(found))
    ll = lambda y, x: [round(v, 7) for v in parsers.tm2_to_latlng(y, x)]

    # 1. 讀界址點（原始坐標）
    coa_raw = {}
    for sec in sorted(found):
        coa_raw[sec] = parsers.parse_coa(_read(found[sec]['COA'])) if 'COA' in found[sec] else {}
    ok_pts = {s: [c for c in v.values() if parsers.coord_status(*c) == 'ok'] for s, v in coa_raw.items()}

    # 2. 判斷哪些段是 67、算轉換參數
    log('判斷 TWD67 / TWD97 …')
    det = datum.detect(ok_pts)
    auto67 = det['auto67']
    if sec67 is None:
        # 段名表紅字 + 自動偵測；同一群（界址點互相重合）的段一起算
        seed = set(s for s in SHEET_67 if s in found) | auto67
        groups67 = set(det['group_of'][s] for s in seed if s in det['group_of'])
        eff67 = seed | set(s for g in groups67 for s in det['groups'][g])
    else:
        eff67 = set(s for s in sec67 if s in found)
    trans, glob_t = datum.build_transforms(det, eff67)

    # 3. 每段：界址點換成 97、組地號多邊形
    sections = []
    coa97 = {}
    for sec in sorted(found):
        files = found[sec]
        T = trans.get(sec)
        coa = {k: (T(*c) if T and parsers.coord_status(*c) == 'ok' else c) for k, c in coa_raw[sec].items()}
        coa97[sec] = [c for c in coa.values() if parsers.coord_status(*c) == 'ok']
        bnp = parsers.parse_bnp(_read(files['BNP'])) if 'BNP' in files else {}
        par = parsers.parse_par(_read(files['PAR'])) if 'PAR' in files else {}
        parcels = []
        missing = 0
        miny = minx = 1e18
        maxy = maxx = -1e18
        for key, ids in bnp.items():
            ring = []
            for pid in ids:
                c = coa.get(pid)
                if not c:
                    missing += 1
                    continue
                if parsers.coord_status(*c) != 'ok':
                    continue
                ring.append(ll(*c))
                miny, maxy = min(miny, c[0]), max(maxy, c[0])
                minx, maxx = min(minx, c[1]), max(maxx, c[1])
            if len(ring) < 3:
                continue
            info = par.get(key, {})
            if 'cy' in info and parsers.coord_status(info['cy'], info['cx']) == 'ok':
                center = ll(*(T(info['cy'], info['cx']) if T else (info['cy'], info['cx'])))
            else:
                center = [round(sum(p[0] for p in ring) / len(ring), 7), round(sum(p[1] for p in ring) / len(ring), 7)]
            parcels.append({'k': key, 'a': info.get('area'), 'u': info.get('use', ''), 'c': center,
                            'r': [v for p in ring for v in p]})
        if not parcels:
            for c in coa97[sec]:
                miny, maxy = min(miny, c[0]), max(maxy, c[0])
                minx, maxx = min(minx, c[1]), max(maxx, c[1])
        with open(os.path.join(cache_dir, 'sections', sec + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'section': sec, 'parcels': parcels}, f, ensure_ascii=False, separators=(',', ':'))
        src = []
        if sec in SHEET_67:
            src.append('段名表紅字')
        if sec in auto67:
            src.append('自動偵測')
        entry = {'section': sec, 'parcels': len(parcels), 'points': len(coa_raw[sec]), 'missing': missing,
                 'files': sorted(files), 'datum': 'TWD67' if sec in eff67 else 'TWD97',
                 'datum_src': '、'.join(src) if sec in eff67 and sec67 is None else ('管理者指定' if sec in eff67 else ''),
                 'transform': T.describe() if T else '', 'tparams': T.to_json() if T else None,
                 'group': det['group_of'].get(sec)}
        if sec in SHEET_67 and sec not in eff67:
            entry['datum_warn'] = '段名表標紅字（67），但目前設定為 97'
        elif sec in auto67 and sec not in eff67:
            entry['datum_warn'] = '自動偵測像是 67，但目前設定為 97'
        if miny < 1e17:
            sw, ne = ll(miny, minx), ll(maxy, maxx)
            entry['bbox'] = [sw[0], sw[1], ne[0], ne[1]]
        sections.append(entry)

    # 4. 圖根點：每一點各自判斷坐標系統（大份 CTL 是好幾段共用的同一份，67、97 混在一起）
    log('整理圖根點 …')
    ctl_files = {}
    headers = {}
    for sec in sorted(found):
        if 'CTL' in found[sec]:
            text = _read(found[sec]['CTL'])
            headers[sec] = parsers.lines_of(text)[0].strip()
            ctl_files[sec] = parsers.parse_ctl(text)
    line_sets = {s: set((e['name'].upper(), e['y'], e['x']) for e in v if e['status'] == 'ok') for s, v in ctl_files.items()}
    # 「共用清單」：跟另一種坐標系統的段的 CTL 有一半以上相同 → 這份檔的段別不能拿來判斷
    shared = set()
    big = [s for s in line_sets if len(line_sets[s]) > 50]
    for a in big:
        for b in big:
            if a != b and ((a in eff67) != (b in eff67)) and \
                    len(line_sets[a] & line_sets[b]) >= 0.5 * min(len(line_sets[a]), len(line_sets[b])):
                shared.add(a)
                shared.add(b)
    prior = collections.defaultdict(set)
    for s, keys in line_sets.items():
        if s in shared:
            continue
        for k in keys:
            prior[k].add('TWD67' if s in eff67 else 'TWD97')
    g97 = _grid([c for v in coa97.values() for c in v])
    g67 = _grid([c for s in eff67 for c in ok_pts.get(s, [])])
    raw_box = {s: (min(p[0] for p in ok_pts[s]), max(p[0] for p in ok_pts[s]), min(p[1] for p in ok_pts[s]), max(p[1] for p in ok_pts[s]))
               for s in eff67 if ok_pts.get(s)}

    def transform_for(y, x):
        best, bd = None, 1e18
        for s, b in raw_box.items():
            dy = max(b[0] - y, 0, y - b[1])
            dx = max(b[2] - x, 0, x - b[3])
            d = math.hypot(dy, dx)
            if d < bd:
                best, bd = s, d
        return trans.get(best, glob_t) if best and bd < 1500 else glob_t

    decided = {}

    def decide(k):
        if k in decided:
            return decided[k]
        p = prior.get(k)
        if p and len(p) == 1:
            r = (next(iter(p)), '依所在段')
        else:
            d97 = _nearest(g97, k[1], k[2])
            d67 = _nearest(g67, k[1], k[2]) if raw_box else 1e18
            if d67 < 25 and d97 > max(60, 4 * d67):
                r = ('TWD67', '依位置判斷（離 67 界址點 %.0f m、離 97 界址點 %s）' % (d67, '很遠' if d97 > 1e5 else '%.0f m' % d97))
            elif d97 < 25 and d67 > max(60, 4 * d97):
                r = ('TWD97', '依位置判斷')
            else:
                r = ('?', '判斷不出 67 或 97（當作 97，請確認）')
        decided[k] = r
        return r

    # 判斷不出來的點：看同一份 CTL 前後 15 行已判斷出來的點（CTL 通常是一批一批測的，前後點同一系統）
    for lst in ctl_files.values():
        keys = [(e['name'].upper(), e['y'], e['x']) if e['status'] == 'ok' else None for e in lst]
        for k in keys:
            if k:
                decide(k)
        for i, k in enumerate(keys):
            if not k or decided[k][0] != '?' or decided[k][1].startswith('依前後'):
                continue
            near = collections.Counter(decided[q][0] for q in keys[max(0, i - 15):i + 16]
                                       if q and q != k and decided[q][0] != '?' and not decided[q][1].startswith('依前後'))
            tot = sum(near.values())
            if tot >= 4:
                dm, n = near.most_common(1)[0]
                if n >= 0.85 * tot:
                    decided[k] = (dm, '依同一份 CTL 前後的點（%d/%d 點是 %s）' % (n, tot, dm[-2:]))

    ctl_entries = []
    stats = collections.Counter()
    for sec, lst in ctl_files.items():
        for e in lst:
            e['section'] = sec
            e['header'] = headers[sec]
            e['shared'] = sec in shared
            if e['status'] == 'ok':
                k = (e['name'].upper(), e['y'], e['x'])
                dm, why = decide(k)
                e['raw'] = [e['y'], e['x']]
                e['datum'], e['datum_why'] = dm, why
                if dm == 'TWD67':
                    e['y'], e['x'] = [round(v, 3) for v in transform_for(e['y'], e['x'])(e['y'], e['x'])]
                stats[dm] += 1
            ctl_entries.append(e)
    controls, issues = parsers.clean_controls(ctl_entries)
    for p in controls:
        if p['status'] == 'ok':
            p['ll'] = ll(p['y'], p['x'])
    with open(os.path.join(cache_dir, 'controls.json'), 'w', encoding='utf-8') as f:
        json.dump(controls, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(cache_dir, 'ctl_issues.json'), 'w', encoding='utf-8') as f:
        json.dump(issues, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(cache_dir, 'ctl_entries.json'), 'w', encoding='utf-8') as f:
        json.dump({'headers': headers, 'entries': [{k: e.get(k) for k in ('section', 'line', 'name', 'y', 'x', 'raw', 'status',
                                                                          'datum', 'datum_why', 'fix')} for e in ctl_entries]},
                  f, ensure_ascii=False, separators=(',', ':'))
    summary = collections.Counter(i['type'] for i in issues)
    idx = {'signature': sig, 'sections': sections,
           'datum': {'sec67': sorted(eff67), 'auto67': sorted(auto67), 'sheet67': SHEET_67, 'configured': sec67 is not None,
                     'global': glob_t.describe(), 'ctl': dict(stats), 'shared_ctl': sorted(shared)},
           'ctl': {'lines': len(ctl_entries), 'points': len(controls), 'issues': dict(summary)}}
    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False)
    log('底圖整理完成：%d 段（67 段 %d 個已換成 97）、%d 筆地號、圖根點 %d 行 → %d 點（67 %d、97 %d、不確定 %d）' % (
        len(sections), len(eff67), sum(s['parcels'] for s in sections), len(ctl_entries), len(controls),
        stats['TWD67'], stats['TWD97'], stats['?']))
    return idx

