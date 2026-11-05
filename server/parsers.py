# -*- coding: utf-8 -*-
"""
地籍／重測資料讀取（純函式，不碰資料庫）。

讀取規則參考「土地重測資料轉換系統」：
  .COA  界址點坐標：點號(5) 空白 Y(16) X(15) 註記(1)
  .CTL  圖根點：    點名(8) Y(11) X(10) 註記(2)
  .PAR  地號：      母號(4) 子號(4) 段(4) 面積(10) … 地目(1) … 中心 Y(9) X(8)
  .BNP  地號界址點：母號(4) 子號(4) 行序(3) 點數(4) 點號(6)×最多 11
  .D14  重測系統界址點／參考點（dBASE）：COT_NUMBER、COT_REF（編碼，非 0 = 參考點）、COT_Y、COT_X
  .D20  重測系統補點（dBASE）：CTL_NAME、CTL_Y、CTL_X、CTL_LEVEL（Q = 補點）
  .L02  控制點清單（列印檔）、.L14 界址點/參考點清單、.L20 補點清單
  .B90  協助指界計算（測站、標定點、施測點）
"""
import io
import math
import os
import re
import struct
import zipfile

# ───────────────────────── 共用 ─────────────────────────

def decode(b):
    """台灣舊系統多半是 Big5（cp950），新檔可能是 UTF-8。"""
    if isinstance(b, str):
        return b
    if b.startswith(b'\xef\xbb\xbf'):
        return b[3:].decode('utf-8', 'replace')
    try:
        return b.decode('utf-8')
    except UnicodeDecodeError:
        return b.decode('cp950', 'replace')


def is_num(s):
    try:
        float(s)
        return True
    except (TypeError, ValueError):
        return False


def int_digits(v):
    try:
        n = abs(float(v))
    except (TypeError, ValueError):
        return 0
    return len(str(int(n))) if n >= 1 else 0


def is_y(v):
    """台灣 TM2 縱坐標（Y、N）整數部分 7 位"""
    return int_digits(v) == 7


def is_x(v):
    """台灣 TM2 橫坐標（X、E）整數部分 6 位"""
    return int_digits(v) == 6


def coord_status(y, x):
    """'ok' 正常台灣 TM2 坐標；'zero' 有 0；'local' 假設／局部坐標（無法套到地圖上）"""
    if not y or not x:
        return 'zero'
    if 2400000 < y < 2950000 and 100000 < x < 400000:
        return 'ok'
    return 'local'


def ext_of(name):
    b = os.path.basename(name.replace('\\', '/'))
    return b.rsplit('.', 1)[1].upper() if '.' in b else ''


def base_of(name):
    b = os.path.basename(name.replace('\\', '/'))
    return b.rsplit('.', 1)[0] if '.' in b else b


SECTION_RE = re.compile(r'([A-Z]{2})(\d{4})', re.I)


def section_of(path):
    """從檔名或資料夾名找出段代碼，例如 KC1114。"""
    p = path.replace('\\', '/')
    m = SECTION_RE.fullmatch(base_of(p).upper())
    if m and m.group(2) != '0000':
        return m.group(0).upper()
    for part in reversed(p.split('/')[:-1]):
        m = SECTION_RE.fullmatch(part.upper().strip())
        if m and m.group(2) != '0000':
            return m.group(0).upper()
    return None


_HASHU = re.compile(r'#U([0-9a-fA-F]{4})')


def zip_name(info):
    """zip 內的檔名：UTF-8 旗標、Big5、或 #Uxxxx 跳脫寫法都能還原。"""
    n = info.filename
    if not (info.flag_bits & 0x800):
        try:
            n = n.encode('cp437').decode('cp950')
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return _HASHU.sub(lambda m: chr(int(m.group(1), 16)), n)


def expand_zips(files, depth=0):
    """[(path, bytes)] → 把 zip 解開（最多兩層），回傳 [(path, bytes)]"""
    out = []
    for path, data in files:
        if ext_of(path) == 'ZIP' and depth < 2:
            try:
                zf = zipfile.ZipFile(io.BytesIO(data))
            except zipfile.BadZipFile:
                out.append((path, data))
                continue
            inner = []
            prefix = base_of(path)
            for info in zf.infolist():
                if info.is_dir():
                    continue
                inner.append((prefix + '/' + zip_name(info), zf.read(info)))
            out.extend(expand_zips(inner, depth + 1))
        else:
            out.append((path, data))
    return out


def lines_of(text):
    return text.replace('\r\n', '\n').replace('\r', '\n').split('\n')


# ───────────────────────── 數值地籍圖 ─────────────────────────

_COA_RE = re.compile(r'^\s*(\d+)\s+(\d+\.\d+?)(\d{6}\.\d+?)(\d)?\s*$')


def parse_coa(text):
    """回傳 {點號: (y, x)}"""
    pts = {}
    for i, l in enumerate(lines_of(text)):
        if i == 0 or not l.strip():
            continue
        pid, y, x = l[0:5].strip(), l[6:22].strip(), l[22:37].strip()
        if not pid.isdigit() or not is_num(y) or not is_num(x):
            m = _COA_RE.match(l)
            if not m:
                continue
            pid, y, x = m.group(1), m.group(2), m.group(3)
        pts[str(int(pid))] = (float(y), float(x))
    return pts


def parcel_label(mother, child):
    mother, child = int(mother), int(child or 0)
    return str(mother) if child == 0 else '%d-%d' % (mother, child)


def parse_bnp(text):
    """回傳 {地號: [點號…]}（保持檔案順序）"""
    out = {}
    for i, l in enumerate(lines_of(text)):
        if i == 0:
            continue
        t = l.split()
        if len(t) < 4 or not t[0].isdigit() or not t[1].isdigit():
            continue
        key = parcel_label(t[0], t[1])
        lst = out.setdefault(key, [])
        lst.extend(str(int(v)) for v in t[4:] if v.isdigit())
    return out


_PAR_TAIL = re.compile(r'([A-Z ])\s*\d?\s*(\d{7}\.\d)\s*(\d{6}\.\d)')


def parse_par(text):
    """回傳 {地號: {'area': 面積, 'use': 地目代碼, 'cy':, 'cx':}}"""
    out = {}
    for i, l in enumerate(lines_of(text)):
        if i == 0 or len(l) < 30:
            continue
        mother, child = l[0:4].strip(), l[4:8].strip()
        if not mother.isdigit():
            continue
        key = parcel_label(mother, child or '0')
        area = l[12:22].strip()
        use = l[40:41].strip() if len(l) > 40 else ''
        info = {'area': float(area) if is_num(area) else None, 'use': use}
        m = _PAR_TAIL.search(l, 30)
        if m:
            info['cy'], info['cx'] = float(m.group(2)), float(m.group(3))
        out[key] = info
    return out


def parse_ctl(text):
    """
    .CTL 圖根點。固定欄寬：點名(8) Y(11) X(10) 註記(2)。
    很亂的地方：點名裡夾 tab、點名剛好 8 字跟 Y 黏在一起、假設坐標、X=0、尾巴有註記碼。
    回傳 [{'name','y','x','flag','status','line'}]
    """
    res = []
    for i, raw in enumerate(lines_of(text)):
        if i == 0 or not raw.strip():
            continue
        l = raw.replace('\t', ' ')
        name, y, x, flag = l[0:8].strip(), l[8:19].strip(), l[19:29].strip(), l[29:31].strip()
        if not name or not is_num(y) or not is_num(x):
            t = l.split()
            if len(t) >= 3 and is_num(t[1]) and is_num(t[2]):
                name, y, x, flag = t[0], t[1], t[2], ' '.join(t[3:])
            else:
                res.append({'name': l.strip(), 'y': None, 'x': None, 'flag': '', 'status': 'bad', 'line': i + 1})
                continue
        y, x = float(y), float(x)
        res.append({'name': name, 'y': y, 'x': x, 'flag': flag, 'status': coord_status(y, x), 'line': i + 1})
    return res


def clean_controls(entries, tol=0.10):
    """
    把所有段的 .CTL 合在一起整理成「實際的點」。
    entries：[{'name','y','x','flag','status','section','header'}]
    同名不一定同點（不同地區重複使用 A1、A10…），所以用「點名＋坐標」分群：
      坐標相差 tol（預設 10 cm）以內 → 同一點（坐標取出現最多次的那組）
      超過 → 不同點，各自保留並標記「同名點」。
    回傳 (points, issues)
    """
    by_name = {}
    issues = []
    for e in entries:
        if e['status'] == 'bad':
            issues.append({'type': 'bad', 'name': e['name'], 'section': e['section'],
                           'msg': '看不懂的一行（第 %d 行）' % e['line']})
            continue
        by_name.setdefault(e['name'].upper(), []).append(e)
    points = []
    for key in sorted(by_name):
        groups = []
        for e in by_name[key]:
            for g in groups:
                if math.hypot(g['y'] - e['y'], g['x'] - e['x']) <= tol:
                    g['items'].append(e)
                    break
            else:
                groups.append({'y': e['y'], 'x': e['x'], 'items': [e]})
        for gi, g in enumerate(groups):
            votes = {}
            for e in g['items']:
                k = (round(e['y'], 3), round(e['x'], 3))
                votes[k] = votes.get(k, 0) + 1
            (y, x), _ = max(votes.items(), key=lambda kv: kv[1])
            secs = sorted(set(e['section'] for e in g['items']))
            flags = sorted(set(e['flag'] for e in g['items'] if e['flag']))
            name = g['items'][0]['name']
            spread = 0.0
            ks = list(votes)
            for a in ks:
                for b in ks:
                    spread = max(spread, math.hypot(a[0] - b[0], a[1] - b[1]))
            p = {'id': name if len(groups) == 1 else '%s#%d' % (name, gi + 1), 'name': name,
                 'y': y, 'x': x, 'sections': secs, 'flags': flags, 'count': len(g['items']),
                 'status': g['items'][0]['status'], 'spread': round(spread, 3),
                 'same_name': len(groups)}
            notes = []
            if p['status'] == 'local':
                notes.append('假設坐標，無法放到地圖上')
            elif p['status'] == 'zero':
                notes.append('坐標有 0，無法放到地圖上')
            if spread > 0.0005:
                notes.append('各檔坐標不一致，最多差 %.1f cm（取出現最多次的）' % (spread * 100))
            if len(groups) > 1:
                notes.append('同名但不同點：共有 %d 個「%s」' % (len(groups), name))
            p['notes'] = notes
            points.append(p)
            if p['status'] != 'ok':
                issues.append({'type': p['status'], 'name': name, 'section': ','.join(secs), 'msg': notes[0],
                               'id': p['id']})
            if spread > 0.0005:
                issues.append({'type': 'spread', 'name': name, 'section': ','.join(secs), 'msg': notes[-2 if len(groups) > 1 else -1],
                               'id': p['id']})
        if len(groups) > 1:
            dists = [math.hypot(a['y'] - b['y'], a['x'] - b['x']) for a in groups for b in groups if a is not b]
            issues.append({'type': 'samename', 'name': groups[0]['items'][0]['name'],
                           'section': ','.join(sorted(set(e['section'] for g in groups for e in g['items']))),
                           'msg': '同名 %d 個不同點，最近相距 %.2f m' % (len(groups), min(dists)),
                           'id': groups[0]['items'][0]['name'] + '#1'})
    return points, issues


# ───────────────────────── 坐標轉換 TM2 → WGS84 ─────────────────────────

def twd67_to_twd97(y, x):
    """TWD67 TM2 → TWD97 TM2 近似公式（誤差約 1～2 公尺，只用於套底圖）"""
    A, B = 0.00001549, 0.000006521
    x97 = x + 807.8 + A * x + B * y
    y97 = y - 248.6 + A * y + B * x
    return y97, x97


def tm2_to_latlng(y, x, datum='TWD97'):
    if datum == 'TWD67':
        y, x = twd67_to_twd97(y, x)
    a = 6378137.0
    b = 6356752.314245
    lon0 = math.radians(121)
    k0 = 0.9999
    dx = 250000.0
    e = math.sqrt(1 - (b * b) / (a * a))
    x -= dx
    M = y / k0
    mu = M / (a * (1.0 - e ** 2 / 4.0 - 3 * e ** 4 / 64.0 - 5 * e ** 6 / 256.0))
    e1 = (1.0 - math.sqrt(1.0 - e ** 2)) / (1.0 + math.sqrt(1.0 - e ** 2))
    J1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32.0
    J2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32.0
    J3 = 151 * e1 ** 3 / 96.0
    J4 = 1097 * e1 ** 4 / 512.0
    fp = mu + J1 * math.sin(2 * mu) + J2 * math.sin(4 * mu) + J3 * math.sin(6 * mu) + J4 * math.sin(8 * mu)
    e2 = (e * a / b) ** 2
    C1 = e2 * math.cos(fp) ** 2
    T1 = math.tan(fp) ** 2
    R1 = a * (1 - e ** 2) / (1 - e ** 2 * math.sin(fp) ** 2) ** 1.5
    N1 = a / math.sqrt(1 - e ** 2 * math.sin(fp) ** 2)
    D = x / (N1 * k0)
    Q1 = N1 * math.tan(fp) / R1
    Q2 = D * D / 2.0
    Q3 = (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * D ** 4 / 24.0
    Q4 = (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * e2) * D ** 6 / 720.0
    lat = fp - Q1 * (Q2 - Q3 + Q4)
    Q6 = (1 + 2 * T1 + C1) * D ** 3 / 6
    Q7 = (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * D ** 5 / 120.0
    lon = lon0 + (D - Q6 + Q7) / math.cos(fp)
    return math.degrees(lat), math.degrees(lon)


# ───────────────────────── dBASE（重測系統 D 檔） ─────────────────────────

def parse_dbf(data):
    if len(data) < 33 or (data[0] & 0x07) != 3:
        raise ValueError('不是 dBASE III 檔')
    nrec = struct.unpack('<I', data[4:8])[0]
    hlen, rlen = struct.unpack('<HH', data[8:12])
    fields, off, pos = [], 32, 1
    while off < hlen - 1 and data[off] != 0x0D:
        name = data[off:off + 11].split(b'\0')[0].decode('ascii', 'replace')
        ln = data[off + 16]
        fields.append((name, ln, pos))
        pos += ln
        off += 32
    recs = []
    for i in range(nrec):
        s = hlen + i * rlen
        if s + rlen > len(data):
            break
        r = data[s:s + rlen]
        if r[0:1] == b'*':
            continue
        recs.append({n: r[p:p + ln].decode('cp950', 'replace').replace('\0', '').strip() for n, ln, p in fields})
    return {'fields': [f[0] for f in fields], 'records': recs}


# ───────────────────────── L 檔、CSV、B90 ─────────────────────────

def extract_triples(line):
    t = [v for v in re.split(r'[\s,]+', line.strip()) if v]
    res, i = [], 0
    while i + 2 < len(t):
        if re.fullmatch(r'[A-Za-z0-9_\-.+]+', t[i]) and is_num(t[i + 1]) and is_num(t[i + 2]) \
                and '.' in t[i + 1] and '.' in t[i + 2]:
            a, b = t[i + 1], t[i + 2]
            if is_x(a) and is_y(b):
                a, b = b, a
            res.append((t[i], float(a), float(b)))
            i += 3
        else:
            i += 1
    return res


def parse_l(text):
    out = []
    for i, l in enumerate(lines_of(text)):
        for name, y, x in extract_triples(l):
            out.append({'name': name, 'y': y, 'x': x, 'line': i + 1})
    return out


def parse_csv_points(text):
    out = []
    for i, l in enumerate(lines_of(text)):
        t = [v.strip().strip('"') for v in re.split(r'[,\t]', l)]
        if len(t) >= 3 and t[0] and is_num(t[1]) and is_num(t[2]):
            y, x = float(t[1]), float(t[2])
            if is_x(t[1]) and is_y(t[2]):
                y, x = x, y
            out.append({'name': t[0], 'y': y, 'x': x, 'line': i + 1})
    return out


_B90_PT = re.compile(r'(測\s*站|標\s*定\s*點|施\s*測\s*點)\s*[:：]\s*(\S+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s*(.*)$')


def parse_b90(text):
    """協助指界計算：回傳 [{'station':{name,y,x}, 'back':{…}, 'targets':[{name,y,x,angle,dist}]}]"""
    setups, cur = [], None
    for l in lines_of(text):
        m = _B90_PT.search(l)
        if not m:
            continue
        role = re.sub(r'\s', '', m.group(1))
        p = {'name': m.group(2), 'y': float(m.group(3)), 'x': float(m.group(4))}
        rest = m.group(5).split()
        if role == '測站':
            cur = {'station': p, 'back': None, 'targets': []}
            setups.append(cur)
        elif cur is None:
            continue
        elif role == '標定點':
            if rest and is_num(rest[-1]):
                p['dist'] = float(rest[-1])
            cur['back'] = p
        else:
            if rest and re.fullmatch(r'\d+-\d+-\d+', rest[0]):
                p['angle'] = rest[0]
                rest = rest[1:]
            if rest and is_num(rest[0]):
                p['dist'] = float(rest[0])
            cur['targets'].append(p)
    return setups


def looks_like_b90(text):
    return bool(re.search(r'測\s*站\s*[:：]', text)) and bool(re.search(r'施\s*測\s*點\s*[:：]', text))


def is_boundary_name(name):
    """界址點：純數字或數字.編碼"""
    return bool(re.fullmatch(r'\d+(\.\d+)?', name))


def ref_name(num, ref):
    return '%d.%02d' % (int(num), int(ref))


# ───────────────────────── 測量員上傳：整理成點位 ─────────────────────────

WANTED_EXT = {'D14', 'D20', 'L02', 'L14', 'L20', 'CSV', 'TXT', 'ZIP'}


def wanted(path):
    e = ext_of(path)
    return e in WANTED_EXT or re.fullmatch(r'B9\d', e or '') is not None


def parse_field_files(files):
    """
    files：[(path, bytes)]（zip 會自動解開）
    回傳 {'sections': {段: {...}}, 'points': [...], 'links': [...], 'report': [...], 'used': [...]}
      points 的 kind：'補點'、'參考點'、'控制點'（測量員新增、不是 Q 開頭的）
      used：這次外業用到的圖根點（L02、B90 測站／標定點、CSV 的非數字點名）
    """
    files = expand_zips(files)
    report = []
    groups = {}
    skipped = []
    for path, data in files:
        if not wanted(path):
            skipped.append(path)
            continue
        if base_of(path).upper() == 'KC0000':   # 重測系統預設檔，每個資料夾都有
            continue
        groups.setdefault(section_of(path) or '未知段', []).append((path, data))
    # 放在資料夾外面、檔名看不出段別的檔案（例如 11304161.CSV）：只有一個段時就歸到那個段
    known = [k for k in groups if k != '未知段']
    if '未知段' in groups and len(known) == 1:
        groups[known[0]].extend(groups.pop('未知段'))
    if skipped:
        report.append(('info', '有 %d 個檔案用不到，已略過（例如 %s）' % (
            len(skipped), '、'.join(os.path.basename(p) for p in skipped[:3]))))

    points, links, used = [], [], []
    for sec, items in sorted(groups.items()):
        by_ext = {}
        for path, data in items:
            by_ext.setdefault(ext_of(path), []).append((path, data))
        sec_pts = {}

        def add(kind, name, y, x, src, **extra):
            key = (kind, name.upper())
            if key in sec_pts:
                old = sec_pts[key]
                if math.hypot(old['y'] - y, old['x'] - x) > 0.005:
                    report.append(('warn', '%s %s「%s」在 %s 與 %s 的坐標不同（差 %.1f cm），用 %s 的' % (
                        sec, kind, name, os.path.basename(old['src']), os.path.basename(src),
                        math.hypot(old['y'] - y, old['x'] - x) * 100, os.path.basename(old['src']))))
                return
            p = {'section': sec, 'kind': kind, 'name': name, 'y': y, 'x': x, 'src': src}
            p.update(extra)
            sec_pts[key] = p

        # D20：補點（權威）
        for path, data in by_ext.get('D20', []):
            try:
                db = parse_dbf(data)
            except ValueError as e:
                report.append(('error', '%s 讀不出來：%s' % (path, e)))
                continue
            if 'CTL_NAME' not in db['fields']:
                report.append(('error', '%s 不是重測系統的 D20（欄位不對）' % path))
                continue
            for r in db['records']:
                if not r['CTL_NAME'] or not is_num(r['CTL_Y']) or not is_num(r['CTL_X']):
                    continue
                lvl = r.get('CTL_LEVEL', '')
                kind = '補點' if 'Q' in lvl.upper() or r['CTL_NAME'].upper().startswith('Q') else '控制點'
                add(kind, r['CTL_NAME'], float(r['CTL_Y']), float(r['CTL_X']), path, level=lvl)
        # D14：參考點（COT_REF 非 0）
        for path, data in by_ext.get('D14', []):
            try:
                db = parse_dbf(data)
            except ValueError as e:
                report.append(('error', '%s 讀不出來：%s' % (path, e)))
                continue
            if 'COT_REF' not in db['fields']:
                report.append(('error', '%s 不是重測系統的 D14（欄位不對）' % path))
                continue
            n = 0
            for r in db['records']:
                ref = int(r['COT_REF']) if r['COT_REF'].isdigit() else 0
                if ref == 0 or not r['COT_NUMBER'].isdigit() or not is_num(r['COT_Y']):
                    continue
                n += 1
                add('參考點', ref_name(r['COT_NUMBER'], ref), float(r['COT_Y']), float(r['COT_X']), path,
                    remark=r.get('COT_REMARK', ''))
            report.append(('info', '%s 的 D14 有 %d 筆資料，其中參考點 %d 點' % (sec, len(db['records']), n)))
        # 沒有 D 檔時退而求其次：L20 補點、L14 參考點
        if not by_ext.get('D20'):
            for path, data in by_ext.get('L20', []):
                for p in parse_l(decode(data)):
                    add('補點', p['name'], p['y'], p['x'], path)
        if not by_ext.get('D14'):
            for path, data in by_ext.get('L14', []):
                for p in parse_l(decode(data)):
                    m = re.fullmatch(r'(\d+)\.(\d+)', p['name'])
                    if m and int(m.group(2)) != 0:
                        add('參考點', ref_name(m.group(1), m.group(2)), p['y'], p['x'], path)
        # 用到的圖根點：L02
        sec_used = {}

        def use(name, y, x, src, how):
            k = name.upper()
            if k not in sec_used:
                sec_used[k] = {'section': sec, 'name': name, 'y': y, 'x': x, 'src': src, 'how': how}

        for path, data in by_ext.get('L02', []):
            for p in parse_l(decode(data)):
                use(p['name'], p['y'], p['x'], path, 'L02 控制點清單')
        # B90 協助指界計算
        b_files = [(p, d) for e, lst in by_ext.items() if re.fullmatch(r'B9\d', e) for p, d in lst]
        b_files += [(p, d) for p, d in by_ext.get('TXT', []) if looks_like_b90(decode(d))]
        for path, data in b_files:
            setups = parse_b90(decode(data))
            for s in setups:
                st, bk = s['station'], s['back']
                for t in s['targets']:
                    if is_boundary_name(t['name']):
                        continue
                    links.append({'section': sec, 'station': st['name'], 'sy': st['y'], 'sx': st['x'],
                                  'back': bk['name'] if bk else '', 'by': bk['y'] if bk else None,
                                  'bx': bk['x'] if bk else None, 'target': t['name'], 'ty': t['y'], 'tx': t['x'],
                                  'angle': t.get('angle', ''), 'dist': t.get('dist'), 'src': path})
                for p in [st, bk]:
                    if p and not is_boundary_name(p['name']):
                        use(p['name'], p['y'], p['x'], path, '協助指界 測站/標定點')
            if setups:
                report.append(('info', '%s：%s 有 %d 次設站' % (sec, os.path.basename(path), len(setups))))
        # CSV（儀器檔）：非數字點名
        for path, data in by_ext.get('CSV', []) + [(p, d) for p, d in by_ext.get('TXT', [])
                                                    if not looks_like_b90(decode(d))]:
            for p in parse_csv_points(decode(data)):
                if not is_boundary_name(p['name']):
                    use(p['name'], p['y'], p['x'], path, 'CSV 儀器檔')
        # 補點本身也會出現在 used 清單裡，拿掉
        for k in list(sec_used):
            if ('補點', k) in sec_pts or ('控制點', k) in sec_pts:
                del sec_used[k]
        pts = list(sec_pts.values())
        points.extend(pts)
        used.extend(sec_used.values())
        cnt = {}
        for p in pts:
            cnt[p['kind']] = cnt.get(p['kind'], 0) + 1
        report.append(('ok', '%s：%s，用到圖根點 %d 點' % (
            sec, '、'.join('%s %d 點' % kv for kv in sorted(cnt.items())) or '沒有補點或參考點', len(sec_used))))
    if not groups:
        report.append(('error', '找不到重測系統的資料（需要 KCxxxx.D20、D14、L02 或 B90 等檔案）'))
    return {'points': points, 'links': links, 'used': used, 'report': report, 'sections': sorted(groups)}
