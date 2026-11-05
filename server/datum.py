# -*- coding: utf-8 -*-
"""
TWD67 → TWD97：哪些段是 67、怎麼轉。

1. 判斷段別：
   - 相鄰同坐標系統的段，界址點會「完全重合」（差 2 cm 內）→ 連成一群。
   - 一群 67 的段，用近似公式轉成 97 之後，會跟旁邊 97 段的界址點「整批差同一個小量」重合
     （所有共同點的差值集中在同一格 5 cm 內）→ 這群是 67。
   - 再加上管理者給的 67 清單（段名表裡紅字的段），兩者合併。
2. 轉換參數：用上面找到的共同點（67 坐標 ↔ 97 坐標）做最小二乘六參數（仿射）轉換，
   每一群 67 段各自算（共同點夠多時），不夠就用全部共同點算的整體參數，再不行才用近似公式。
"""
import collections
import math

import parsers

CELL = 10.0


def _grid(pts):
    g = collections.defaultdict(list)
    for p in pts:
        g[(int(p[0] // CELL), int(p[1] // CELL))].append(p)
    return g


def _near(g, y, x, r):
    i, j = int(y // CELL), int(x // CELL)
    k = int(math.ceil(r / CELL))
    for di in range(-k, k + 1):
        for dj in range(-k, k + 1):
            for q in g.get((i + di, j + dj), ()):
                if abs(q[0] - y) < r and abs(q[1] - x) < r:
                    yield q


def _bbox(pts, pad):
    return (min(p[0] for p in pts) - pad, max(p[0] for p in pts) + pad,
            min(p[1] for p in pts) - pad, max(p[1] for p in pts) + pad)


def _overlap(a, b):
    return not (a[0] > b[1] or b[0] > a[1] or a[2] > b[3] or b[2] > a[3])


def _peak(src, g, shift, search=3.0):
    """src 每點（shift=True 時先用近似公式轉 97）找 g 裡 search 公尺內的點，差值做 5 cm 直方圖。
    回傳 (峰值點數, 峰值差值, 配對 [(src點, g點)])"""
    h = collections.Counter()
    cand = []
    for p in src:
        y, x = parsers.twd67_to_twd97(*p) if shift else p
        for q in _near(g, y, x, search):
            dy, dx = q[0] - y, q[1] - x
            k = (round(dy / 0.05), round(dx / 0.05))
            h[k] += 1
            cand.append((p, q, dy, dx))
    if not h:
        return 0, None, []
    k, n = h.most_common(1)[0]
    py, px = k[0] * 0.05, k[1] * 0.05
    pairs = [(p, q) for p, q, dy, dx in cand if abs(dy - py) <= 0.15 and abs(dx - px) <= 0.15]
    return n, (py, px), pairs


def detect(coa):
    """
    coa：{段: [(y, x), …]}（原始坐標）
    回傳 {'groups': [[段…]…], 'group_of': {段: 群號}, 'auto67': set(段), 'pairs': [(67段, 97段, 點數)],
          'common': {67段: [(67點, 97點)…]}}
    """
    secs = [s for s in coa if coa[s]]
    grids = {s: _grid(coa[s]) for s in secs}
    boxes = {s: _bbox(coa[s], 900) for s in secs}
    same = collections.defaultdict(set)
    cross = []
    for a in secs:
        for b in secs:
            if a == b or not _overlap(boxes[a], boxes[b]):
                continue
            if a < b:
                n, off, _ = _peak(coa[a], grids[b], False, 0.5)
                if n >= 8 and off == (0.0, 0.0):
                    same[a].add(b)
                    same[b].add(a)
            n, off, pairs = _peak(coa[a], grids[b], True)
            if n >= 8:
                cross.append((a, b, pairs))
    group_of, groups = {}, []
    for s in sorted(secs):
        if s in group_of:
            continue
        gid = len(groups)
        stack, members = [s], []
        while stack:
            u = stack.pop()
            if u in group_of:
                continue
            group_of[u] = gid
            members.append(u)
            stack.extend(same[u])
        groups.append(sorted(members))
    # 一個 67 段 a 跟 97 段 b 對上 → a 那群是 67、b 那群是 97。用投票避免單一偶然。
    vote67 = collections.Counter()
    vote97 = collections.Counter()
    for a, b, pairs in cross:
        vote67[group_of[a]] += len(pairs)
        vote97[group_of[b]] += len(pairs)
    g67 = {g for g in vote67 if vote67[g] > vote97.get(g, 0)}
    auto67 = set(s for g in g67 for s in groups[g])
    common = collections.defaultdict(list)
    pairs_out = []
    for a, b, pairs in cross:
        if group_of[a] in g67 and group_of[b] not in g67:
            common[a].extend(pairs)
            pairs_out.append((a, b, len(pairs)))
    return {'groups': groups, 'group_of': group_of, 'auto67': auto67, 'pairs': pairs_out, 'common': dict(common)}


def _solve3(rows, rhs):
    A = [[0.0] * 3 for _ in range(3)]
    B = [0.0] * 3
    for r, v in zip(rows, rhs):
        for i in range(3):
            B[i] += r[i] * v
            for j in range(3):
                A[i][j] += r[i] * r[j]
    for i in range(3):
        p = A[i][i]
        if abs(p) < 1e-12:
            return None
        for j in range(i + 1, 3):
            f = A[j][i] / p
            for k in range(3):
                A[j][k] -= f * A[i][k]
            B[j] -= f * B[i]
    x = [0.0] * 3
    for i in reversed(range(3)):
        x[i] = (B[i] - sum(A[i][k] * x[k] for k in range(i + 1, 3))) / A[i][i]
    return x


class Transform:
    """六參數仿射轉換（以共同點重心為原點，單位公里，數值穩定）"""

    def __init__(self, pairs=None, label=''):
        self.label = label
        self.n = 0
        self.rms = None
        self.cy = self.cx = 0.0
        self.py = self.px = None
        if pairs and len(pairs) >= 6:
            self.cy = sum(p[0] for p, _ in pairs) / len(pairs)
            self.cx = sum(p[1] for p, _ in pairs) / len(pairs)
            rows = [(1.0, (p[0] - self.cy) / 1000, (p[1] - self.cx) / 1000) for p, _ in pairs]
            py = _solve3(rows, [q[0] - p[0] for p, q in pairs])
            px = _solve3(rows, [q[1] - p[1] for p, q in pairs])
            if py and px:
                self.py, self.px = py, px
                self.n = len(pairs)
                # 去掉離群點（> 3 倍中位數）再算一次
                res = [math.hypot(*self._err(p, q)) for p, q in pairs]
                med = sorted(res)[len(res) // 2]
                keep = [pq for pq, e in zip(pairs, res) if e <= max(3 * med, 0.05)]
                if len(keep) >= 6 and len(keep) < len(pairs):
                    rows = [(1.0, (p[0] - self.cy) / 1000, (p[1] - self.cx) / 1000) for p, _ in keep]
                    self.py = _solve3(rows, [q[0] - p[0] for p, q in keep]) or self.py
                    self.px = _solve3(rows, [q[1] - p[1] for p, q in keep]) or self.px
                    pairs = keep
                    self.n = len(keep)
                res = [math.hypot(*self._err(p, q)) for p, q in pairs]
                self.rms = math.sqrt(sum(e * e for e in res) / len(res))

    def _err(self, p, q):
        y, x = self(p[0], p[1])
        return q[0] - y, q[1] - x

    def __call__(self, y, x):
        if self.py is None:
            return parsers.twd67_to_twd97(y, x)
        u, v = (y - self.cy) / 1000, (x - self.cx) / 1000
        return (y + self.py[0] + self.py[1] * u + self.py[2] * v,
                x + self.px[0] + self.px[1] * u + self.px[2] * v)

    def to_json(self):
        return {'cy': self.cy, 'cx': self.cx, 'py': self.py, 'px': self.px, 'n': self.n, 'rms': self.rms, 'label': self.label}

    @classmethod
    def from_json(cls, d):
        t = cls(None, d.get('label', ''))
        for k in ('cy', 'cx', 'py', 'px', 'n', 'rms'):
            setattr(t, k, d.get(k))
        return t

    def describe(self):
        if self.py is None:
            return '近似公式（誤差約 1～2 公尺）'
        return '%s：%d 個共同點，殘差 RMS %.1f 公分' % (self.label, self.n, self.rms * 100)


def build_transforms(det, sec67):
    """每一群 67 段一組參數；共同點不足 30 點的群用整體參數。回傳 ({段: Transform}, 整體 Transform)"""
    all_pairs = [pq for s in det['common'] for pq in det['common'][s] if s in sec67]
    glob = Transform(all_pairs, '全區共同點')
    by_group = collections.defaultdict(list)
    for s, pairs in det['common'].items():
        if s in sec67:
            by_group[det['group_of'][s]].extend(pairs)
    out = {}
    for s in sec67:
        g = det['group_of'].get(s)
        pairs = by_group.get(g, [])
        if len(pairs) >= 30:
            out[s] = Transform(pairs, '同群共同點（%s）' % '、'.join(det['groups'][g][:4]) + ('…' if len(det['groups'][g]) > 4 else ''))
        else:
            out[s] = glob
    return out, glob
