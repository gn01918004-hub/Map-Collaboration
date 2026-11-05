# -*- coding: utf-8 -*-
"""
數值地籍圖底圖：掃描 data/base 底下的 KCxxxx 資料夾（或 zip），
整理成網頁要用的快取檔（每段一個 JSON），以及整理過的圖根點清單。
"""
import hashlib
import json
import os
import zipfile

import parsers


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
                if '..' in name.split('/'):
                    continue
                target = os.path.join(dst, *name.split('/'))
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
            sec = parsers.section_of(os.path.join(root, fn))
            if not sec:
                continue
            path = os.path.join(root, fn)
            d = found.setdefault(sec, {})
            if ext not in d or os.path.getmtime(path) > os.path.getmtime(d[ext]):
                d[ext] = path
    return found


def _signature(found, datum):
    h = hashlib.sha1(datum.encode())
    for sec in sorted(found):
        for ext in sorted(found[sec]):
            p = found[sec][ext]
            h.update(('%s|%s|%d|%d' % (sec, ext, os.path.getsize(p), int(os.path.getmtime(p)))).encode())
    return h.hexdigest()


def _read(path):
    with open(path, 'rb') as f:
        return parsers.decode(f.read())


def build(base_dir, cache_dir, datum='TWD97', force=False, log=print):
    """建立快取，回傳索引（sections、controls、issues 的摘要）"""
    found = find_sections(base_dir)
    sig = _signature(found, datum)
    os.makedirs(os.path.join(cache_dir, 'sections'), exist_ok=True)
    idx_path = os.path.join(cache_dir, 'index.json')
    if not force and os.path.exists(idx_path):
        with open(idx_path, encoding='utf-8') as f:
            idx = json.load(f)
        if idx.get('signature') == sig:
            return idx
    log('重新整理底圖：%d 個段' % len(found))
    ll = lambda y, x: [round(v, 7) for v in parsers.tm2_to_latlng(y, x, datum)]
    sections = []
    ctl_entries = []
    for sec in sorted(found):
        files = found[sec]
        coa = parsers.parse_coa(_read(files['COA'])) if 'COA' in files else {}
        bnp = parsers.parse_bnp(_read(files['BNP'])) if 'BNP' in files else {}
        par = parsers.parse_par(_read(files['PAR'])) if 'PAR' in files else {}
        if 'CTL' in files:
            text = _read(files['CTL'])
            header = parsers.lines_of(text)[0].strip()
            for e in parsers.parse_ctl(text):
                e['section'] = sec
                e['header'] = header
                ctl_entries.append(e)
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
                center = ll(info['cy'], info['cx'])
            else:
                center = [round(sum(p[0] for p in ring) / len(ring), 7), round(sum(p[1] for p in ring) / len(ring), 7)]
            parcels.append({'k': key, 'a': info.get('area'), 'u': info.get('use', ''), 'c': center,
                            'r': [v for p in ring for v in p]})
        if not parcels:   # 沒有 BNP（例如只有界址點），用 COA 的範圍
            for c in coa.values():
                if parsers.coord_status(*c) == 'ok':
                    miny, maxy = min(miny, c[0]), max(maxy, c[0])
                    minx, maxx = min(minx, c[1]), max(maxx, c[1])
        with open(os.path.join(cache_dir, 'sections', sec + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'section': sec, 'parcels': parcels}, f, ensure_ascii=False, separators=(',', ':'))
        entry = {'section': sec, 'parcels': len(parcels), 'points': len(coa), 'missing': missing,
                 'files': sorted(files)}
        if miny < 1e17:
            sw, ne = ll(miny, minx), ll(maxy, maxx)
            entry['bbox'] = [sw[0], sw[1], ne[0], ne[1]]
        sections.append(entry)
    controls, issues = parsers.clean_controls(ctl_entries)
    for p in controls:
        if p['status'] == 'ok':
            p['ll'] = ll(p['y'], p['x'])
    with open(os.path.join(cache_dir, 'controls.json'), 'w', encoding='utf-8') as f:
        json.dump(controls, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(cache_dir, 'ctl_issues.json'), 'w', encoding='utf-8') as f:
        json.dump(issues, f, ensure_ascii=False, separators=(',', ':'))
    summary = {}
    for i in issues:
        summary[i['type']] = summary.get(i['type'], 0) + 1
    idx = {'signature': sig, 'datum': datum, 'sections': sections,
           'ctl': {'lines': len(ctl_entries), 'points': len(controls), 'issues': summary}}
    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False)
    log('底圖整理完成：%d 段、%d 筆地號、圖根點 %d 行 → %d 點' % (
        len(sections), sum(s['parcels'] for s in sections), len(ctl_entries), len(controls)))
    return idx
