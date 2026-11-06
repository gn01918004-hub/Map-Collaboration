/*
 * 地籍共作平台（共用資料夾版）— 核心：檔案讀取、67→97、圖根點整理、底圖建立。
 * 純函式，不碰畫面，瀏覽器與 Node（測試）都能用。
 *
 * 讀取規則與「土地重測資料轉換系統」相同：
 *   .COA  界址點：點號(5) 空白 Y(16) X(15) 註記(1)
 *   .CTL  圖根點：點名(8) Y(11) X(10)，例如「BE20    2697345.532219817.771」
 *   .PAR  地號：  母號(4) 子號(4) 段(4) 面積(10) … 地目(1) … 中心 Y(9) X(8)
 *   .BNP  地號界址點：母號(4) 子號(4) 行序(3) 點數(4) 點號…
 *   .D14  重測系統界址點／參考點（dBASE）：COT_REF 非 0 = 參考點
 *   .D20  重測系統補點（dBASE）：全部是 Q 開頭的補點
 *   .L02 控制點清單、.L14 界址點/參考點、.L20 補點、.B90 協助指界計算
 *   Y/X：整數 7 位是 Y（縱、N）、6 位是 X（橫、E），寫反自動對調
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── 共用 ─────────────────────────
  var utf8 = new TextDecoder('utf-8', { fatal: true });
  var big5 = new TextDecoder('big5');
  function decode(u8) {
    if (typeof u8 === 'string') return u8;
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) u8 = u8.subarray(3);
    try { return utf8.decode(u8); } catch (e) { return big5.decode(u8); }
  }
  function isNum(s) { return s !== null && s !== undefined && String(s).trim() !== '' && isFinite(Number(s)); }
  function intDigits(v) { var n = Math.abs(parseFloat(v)); return isFinite(n) && n >= 1 ? String(Math.floor(n)).length : 0; }
  function isY(v) { return intDigits(v) === 7; }
  function isX(v) { return intDigits(v) === 6; }
  function coordStatus(y, x) {
    if (!y || !x) return 'zero';
    if (y > 2400000 && y < 2950000 && x > 100000 && x < 400000) return 'ok';
    return 'local';
  }
  function baseName(p) { var b = String(p).replace(/\\/g, '/').split('/').pop(); var i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; }
  function extName(p) { var b = String(p).replace(/\\/g, '/').split('/').pop(); var i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toUpperCase() : ''; }
  function fileName(p) { return String(p).replace(/\\/g, '/').split('/').pop(); }
  function sectionOf(path) {
    var p = String(path).replace(/\\/g, '/'), m = /^([A-Z]{2})(\d{4})$/i.exec(baseName(p));
    if (m && m[2] !== '0000') return m[0].toUpperCase();
    var parts = p.split('/').slice(0, -1).reverse();
    for (var i = 0; i < parts.length; i++) {
      m = /^([A-Z]{2})(\d{4})$/i.exec(parts[i].trim());
      if (m && m[2] !== '0000') return m[0].toUpperCase();
    }
    return null;
  }
  function lines(text) { return String(text).replace(/\r\n?/g, '\n').split('\n'); }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function hypot(a, b) { return Math.sqrt(a * a + b * b); }
  function fmtDist(d) { return d < 1 ? (d * 100).toFixed(1) + ' 公分' : d.toFixed(2) + ' 公尺'; }
  function sortStr(a) { return a.slice().sort(); }
  function uniq(a) { var s = {}, o = []; a.forEach(function (v) { if (!s[v]) { s[v] = 1; o.push(v); } }); return o; }

  // ───────────────────────── zip（讀＋寫） ─────────────────────────
  var HASHU = /#U([0-9a-fA-F]{4})/g;
  function zipEntryName(bytes, utf8flag) {
    var s = utf8flag ? new TextDecoder('utf-8').decode(bytes) : big5.decode(bytes);
    return s.replace(HASHU, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
  }
  function inflateRaw(u8) {
    if (typeof DecompressionStream !== 'undefined') {
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([u8]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    if (typeof require === 'function') return Promise.resolve(new Uint8Array(require('zlib').inflateRawSync(u8)));
    return Promise.reject(new Error('這個瀏覽器不能解 zip'));
  }
  /** 讀 zip：回傳 Promise<[{path, bytes}]> */
  function unzip(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return Promise.reject(new Error('不是 zip 檔'));
    var n = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), jobs = [];
    for (var k = 0; k < n; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var flag = dv.getUint16(off + 8, true), method = dv.getUint16(off + 10, true);
      var csize = dv.getUint32(off + 20, true), nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = zipEntryName(u8.subarray(off + 46, off + 46 + nlen), flag & 0x800);
      off += 46 + nlen + elen + clen;
      if (/\/$/.test(name)) continue;
      var dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      var raw = u8.subarray(dataStart, dataStart + csize);
      jobs.push((function (name, method, raw) {
        if (method === 0) return Promise.resolve({ path: name, bytes: raw });
        if (method === 8) return inflateRaw(raw).then(function (b) { return { path: name, bytes: b }; });
        return Promise.resolve(null);
      })(name, method, raw));
    }
    return Promise.all(jobs).then(function (a) { return a.filter(Boolean); });
  }
  /** files：[{path, bytes}] → zip 一律展開（最多兩層） */
  function expandZips(files, depth) {
    depth = depth || 0;
    return Promise.all(files.map(function (f) {
      if (extName(f.path) !== 'ZIP' || depth >= 2) return Promise.resolve([f]);
      return unzip(f.bytes).then(function (inner) {
        var pre = baseName(f.path) + '/';
        return expandZips(inner.map(function (x) { return { path: pre + x.path, bytes: x.bytes }; }), depth + 1);
      }, function () { return [f]; });
    })).then(function (a) { return [].concat.apply([], a); });
  }
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  /** 寫 zip（不壓縮）：files [{path, bytes|text}] → Uint8Array */
  function zipStore(files) {
    var enc = new TextEncoder(), parts = [], cent = [], off = 0;
    files.forEach(function (f) {
      var data = f.bytes || enc.encode(f.text), name = enc.encode(f.path), crc = crc32(data);
      var h = new Uint8Array(30 + name.length), dv = new DataView(h.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x800, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true); dv.setUint16(26, name.length, true);
      h.set(name, 30);
      var c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, off, true); c.set(name, 46);
      parts.push(h, data); cent.push(c); off += h.length + data.length;
    });
    var csize = cent.reduce(function (a, c) { return a + c.length; }, 0);
    var e = new Uint8Array(22), ev = new DataView(e.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, csize, true); ev.setUint32(16, off, true);
    var all = parts.concat(cent, [e]), total = all.reduce(function (a, p) { return a + p.length; }, 0), out = new Uint8Array(total), p = 0;
    all.forEach(function (x) { out.set(x, p); p += x.length; });
    return out;
  }

  // ───────────────────────── 數值地籍圖 ─────────────────────────
  function parseCoa(text) {
    var pts = {};
    lines(text).forEach(function (l, i) {
      if (i === 0 || !l.trim()) return;
      var id = l.slice(0, 5).trim(), y = l.slice(6, 22).trim(), x = l.slice(22, 37).trim();
      if (!/^\d+$/.test(id) || !isNum(y) || !isNum(x)) {
        var m = /^\s*(\d+)\s+(\d+\.\d+?)(\d{6}\.\d+?)(\d)?\s*$/.exec(l);
        if (!m) return;
        id = m[1]; y = m[2]; x = m[3];
      }
      pts[String(parseInt(id, 10))] = [parseFloat(y), parseFloat(x)];
    });
    return pts;
  }
  function parcelLabel(m, c) { m = parseInt(m, 10); c = parseInt(c || '0', 10); return c === 0 ? String(m) : m + '-' + c; }
  function parcelKeyOf(s) {
    var m = /^\s*0*(\d+)\s*(?:[-之]\s*0*(\d+))?\s*(?:地號)?\s*$/.exec(String(s));
    return m ? parcelLabel(m[1], m[2] || '0') : null;
  }
  function parseBnp(text) {
    var out = {}, order = [];
    lines(text).forEach(function (l, i) {
      if (i === 0) return;
      var t = l.trim().split(/\s+/);
      if (t.length < 4 || !/^\d+$/.test(t[0]) || !/^\d+$/.test(t[1])) return;
      var k = parcelLabel(t[0], t[1]);
      if (!out[k]) { out[k] = []; order.push(k); }
      for (var j = 4; j < t.length; j++) if (/^\d+$/.test(t[j])) out[k].push(String(parseInt(t[j], 10)));
    });
    return { map: out, order: order };
  }
  function parsePar(text) {
    var out = {};
    lines(text).forEach(function (l, i) {
      if (i === 0 || l.length < 30) return;
      var mo = l.slice(0, 4).trim(), ch = l.slice(4, 8).trim();
      if (!/^\d+$/.test(mo)) return;
      var area = l.slice(12, 22).trim(), info = { area: isNum(area) ? parseFloat(area) : null, use: l.length > 40 ? l.slice(40, 41).trim() : '' };
      var m = /([A-Z ])\s*\d?\s*(\d{7}\.\d)\s*(\d{6}\.\d)/.exec(l.slice(30));
      if (m) { info.cy = parseFloat(m[2]); info.cx = parseFloat(m[3]); }
      out[parcelLabel(mo, ch || '0')] = info;
    });
    return out;
  }

  function parseCtl(text) {
    var res = [];
    lines(text).forEach(function (raw, i) {
      if (i === 0 || !raw.trim()) return;
      var fix = [], l = raw;
      if (l.indexOf('\t') >= 0) { l = l.replace(/\t/g, ' '); fix.push('點名裡有 tab'); }
      var name = l.slice(0, 8).trim(), y = l.slice(8, 19).trim(), x = l.slice(19, 29).trim(), flag = l.slice(29, 31).trim();
      if (!name || !isNum(y) || !isNum(x) || name.indexOf(' ') >= 0) {
        var t = l.trim().split(/\s+/);
        if (t.length >= 3 && isNum(t[1]) && isNum(t[2])) { name = t[0]; y = t[1]; x = t[2]; flag = t.slice(3).join(' '); fix.push('欄位沒對齊'); }
        else { res.push({ name: l.trim(), y: null, x: null, flag: '', status: 'bad', line: i + 1, fix: ['看不懂'] }); return; }
      }
      if (!((isY(y) && isX(x)) || (isX(y) && isY(x)))) {
        var m = /^\s*(\d{6,7}\.\d{3})\s*(\d{6,7}\.\d{3})(\S*)/.exec(l.slice(8));
        if (m) { y = m[1]; x = m[2]; flag = m[3]; fix.push('欄位沒對齊'); }
      }
      if (flag) fix.push('X 後面多了「' + flag + '」（已捨去）');
      if (isX(y) && isY(x)) { var tmp = y; y = x; x = tmp; fix.push('Y、X 寫反（已對調）'); }
      y = parseFloat(y); x = parseFloat(x);
      res.push({ name: name, y: y, x: x, flag: flag, status: coordStatus(y, x), line: i + 1, fix: fix });
    });
    return res;
  }
  function padR(s, w) { s = String(s); while (s.length < w) s += ' '; return s; }
  function padL(s, w) { s = String(s); while (s.length < w) s = ' ' + s; return s; }
  /** 標準格式：點名(8) Y(11) X(10)，例如「BE20    2697345.532219817.771」 */
  function formatCtlLine(name, y, x) {
    name = String(name).replace(/\t/g, '').trim();
    if (name.length > 8) throw new Error('點名超過 8 個字：' + name);
    var ys = y.toFixed(3), xs = x.toFixed(3);
    if (!(isY(ys) && isX(xs))) throw new Error(name + ' 的坐標不是台灣 TM2（Y 要 7 位整數、X 要 6 位整數）：' + ys + ' ' + xs);
    return padR(name, 8) + padL(ys, 11) + padL(xs, 10);
  }

  // ───────────────────────── 坐標 ─────────────────────────
  function twd67to97(y, x) {
    var A = 0.00001549, B = 0.000006521;
    return [y - 248.6 + A * y + B * x, x + 807.8 + A * x + B * y];
  }
  function tm2ToLatLng(y, x) {
    var a = 6378137.0, b = 6356752.314245, lon0 = 121 * Math.PI / 180, k0 = 0.9999, e = Math.sqrt(1 - (b * b) / (a * a));
    x -= 250000;
    var M = y / k0, e2 = e * e, e4 = e2 * e2, e6 = e4 * e2;
    var mu = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    var e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    var fp = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) +
      (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var ep2 = Math.pow(e * a / b, 2), C1 = ep2 * Math.pow(Math.cos(fp), 2), T1 = Math.pow(Math.tan(fp), 2);
    var R1 = a * (1 - e2) / Math.pow(1 - e2 * Math.pow(Math.sin(fp), 2), 1.5), N1 = a / Math.sqrt(1 - e2 * Math.pow(Math.sin(fp), 2));
    var D = x / (N1 * k0);
    var lat = fp - (N1 * Math.tan(fp) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24 +
      (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 3 * C1 * C1 - 252 * ep2) * Math.pow(D, 6) / 720);
    var lon = lon0 + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / Math.cos(fp);
    return [Math.round(lat * 180 / Math.PI * 1e7) / 1e7, Math.round(lon * 180 / Math.PI * 1e7) / 1e7];
  }
  function ll(y, x) { return coordStatus(y, x) === 'ok' ? tm2ToLatLng(y, x) : null; }

  // ── 67 → 97 ──
  var CELL = 10;
  function grid(pts, cell) {
    cell = cell || CELL;
    var g = new Map();
    pts.forEach(function (p) { var k = Math.floor(p[0] / cell) * 1e6 + Math.floor(p[1] / cell); var a = g.get(k); if (a) a.push(p); else g.set(k, [p]); });
    g.cell = cell;
    return g;
  }
  function eachNear(g, y, x, r, fn) {
    var c = g.cell, i = Math.floor(y / c), j = Math.floor(x / c), k = Math.ceil(r / c);
    for (var di = -k; di <= k; di++) for (var dj = -k; dj <= k; dj++) {
      var a = g.get((i + di) * 1e6 + (j + dj));
      if (a) for (var n = 0; n < a.length; n++) fn(a[n]);
    }
  }
  function nearestDist(g, y, x, r) {
    var best = Infinity;
    eachNear(g, y, x, r, function (q) { var d = (q[0] - y) * (q[0] - y) + (q[1] - x) * (q[1] - x); if (d < best) best = d; });
    return Math.sqrt(best);
  }
  function peak(src, g, shift, search) {
    var h = new Map(), cand = [], best = 0, bk = null;
    src.forEach(function (p) {
      var q0 = shift ? twd67to97(p[0], p[1]) : p;
      eachNear(g, q0[0], q0[1], search, function (q) {
        var dy = q[0] - q0[0], dx = q[1] - q0[1];
        if (Math.abs(dy) >= search || Math.abs(dx) >= search) return;
        var k = Math.round(dy / 0.05) * 10000 + Math.round(dx / 0.05);
        var v = (h.get(k) || 0) + 1; h.set(k, v);
        if (v > best) { best = v; bk = [Math.round(dy / 0.05) * 0.05, Math.round(dx / 0.05) * 0.05]; }
        cand.push([p, q, dy, dx]);
      });
    });
    if (!best) return { n: 0, off: null, pairs: [] };
    var pairs = cand.filter(function (c) { return Math.abs(c[2] - bk[0]) <= 0.15 && Math.abs(c[3] - bk[1]) <= 0.15; }).map(function (c) { return [c[0], c[1]]; });
    return { n: best, off: bk, pairs: pairs };
  }
  function bbox(pts, pad) {
    var b = [Infinity, -Infinity, Infinity, -Infinity];
    pts.forEach(function (p) { if (p[0] < b[0]) b[0] = p[0]; if (p[0] > b[1]) b[1] = p[0]; if (p[1] < b[2]) b[2] = p[1]; if (p[1] > b[3]) b[3] = p[1]; });
    return [b[0] - pad, b[1] + pad, b[2] - pad, b[3] + pad];
  }
  function overlap(a, b) { return !(a[0] > b[1] || b[0] > a[1] || a[2] > b[3] || b[2] > a[3]); }

  /** 判斷 67 段：coa {段: [[y,x]…]} */
  function detectDatum(coa) {
    var secs = Object.keys(coa).filter(function (s) { return coa[s].length; }).sort();
    var grids = {}, boxes = {}, same = {}, cross = [];
    secs.forEach(function (s) { grids[s] = grid(coa[s]); boxes[s] = bbox(coa[s], 900); same[s] = []; });
    secs.forEach(function (a) {
      secs.forEach(function (b) {
        if (a === b || !overlap(boxes[a], boxes[b])) return;
        if (a < b) {
          var r = peak(coa[a], grids[b], false, 0.5);
          if (r.n >= 8 && Math.abs(r.off[0]) < 1e-9 && Math.abs(r.off[1]) < 1e-9) { same[a].push(b); same[b].push(a); }
        }
        var c = peak(coa[a], grids[b], true, 3);
        if (c.n >= 8) cross.push([a, b, c.pairs]);
      });
    });
    var groupOf = {}, groups = [];
    secs.forEach(function (s) {
      if (s in groupOf) return;
      var gid = groups.length, stack = [s], mem = [];
      while (stack.length) { var u = stack.pop(); if (u in groupOf) continue; groupOf[u] = gid; mem.push(u); stack.push.apply(stack, same[u]); }
      groups.push(mem.sort());
    });
    var v67 = {}, v97 = {};
    cross.forEach(function (c) { v67[groupOf[c[0]]] = (v67[groupOf[c[0]]] || 0) + c[2].length; v97[groupOf[c[1]]] = (v97[groupOf[c[1]]] || 0) + c[2].length; });
    var g67 = {};
    Object.keys(v67).forEach(function (g) { if (v67[g] > (v97[g] || 0)) g67[g] = 1; });
    var auto67 = [], common = {};
    secs.forEach(function (s) { if (g67[groupOf[s]]) auto67.push(s); });
    cross.forEach(function (c) { if (g67[groupOf[c[0]]] && !g67[groupOf[c[1]]]) (common[c[0]] = common[c[0]] || []).push.apply(common[c[0]], c[2]); });
    return { groups: groups, groupOf: groupOf, auto67: auto67, common: common };
  }
  function solve3(rows, rhs) {
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [0, 0, 0], i, j, k;
    rows.forEach(function (r, n) { for (i = 0; i < 3; i++) { B[i] += r[i] * rhs[n]; for (j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } });
    for (i = 0; i < 3; i++) {
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (j = i + 1; j < 3; j++) { var f = A[j][i] / A[i][i]; for (k = 0; k < 3; k++) A[j][k] -= f * A[i][k]; B[j] -= f * B[i]; }
    }
    var x = [0, 0, 0];
    for (i = 2; i >= 0; i--) { var s = B[i]; for (k = i + 1; k < 3; k++) s -= A[i][k] * x[k]; x[i] = s / A[i][i]; }
    return x;
  }
  /** 六參數仿射轉換（共同點重心為原點、公里為單位） */
  function Transform(pairs, label) {
    this.label = label || ''; this.n = 0; this.rms = null; this.cy = 0; this.cx = 0; this.py = null; this.px = null;
    if (!pairs || pairs.length < 6) return;
    var self = this;
    var fit = function (ps) {
      self.cy = ps.reduce(function (a, p) { return a + p[0][0]; }, 0) / ps.length;
      self.cx = ps.reduce(function (a, p) { return a + p[0][1]; }, 0) / ps.length;
      var rows = ps.map(function (p) { return [1, (p[0][0] - self.cy) / 1000, (p[0][1] - self.cx) / 1000]; });
      var py = solve3(rows, ps.map(function (p) { return p[1][0] - p[0][0]; })), px = solve3(rows, ps.map(function (p) { return p[1][1] - p[0][1]; }));
      if (py && px) { self.py = py; self.px = px; self.n = ps.length; }
    };
    var err = function (p) { var q = self.apply(p[0][0], p[0][1]); return hypot(p[1][0] - q[0], p[1][1] - q[1]); };
    fit(pairs);
    if (!this.py) return;
    var res = pairs.map(err), med = res.slice().sort(function (a, b) { return a - b; })[Math.floor(res.length / 2)];
    var keep = pairs.filter(function (p, i) { return res[i] <= Math.max(3 * med, 0.05); });
    if (keep.length >= 6 && keep.length < pairs.length) { fit(keep); pairs = keep; }
    res = pairs.map(err);
    this.rms = Math.sqrt(res.reduce(function (a, e) { return a + e * e; }, 0) / res.length);
  }
  Transform.prototype.apply = function (y, x) {
    if (!this.py) return twd67to97(y, x);
    var u = (y - this.cy) / 1000, v = (x - this.cx) / 1000;
    return [y + this.py[0] + this.py[1] * u + this.py[2] * v, x + this.px[0] + this.px[1] * u + this.px[2] * v];
  };
  Transform.prototype.describe = function () {
    return this.py ? this.label + '：' + this.n + ' 個共同點，殘差 RMS ' + (this.rms * 100).toFixed(1) + ' 公分' : '近似公式（誤差約 1～2 公尺）';
  };
  Transform.prototype.toJSON = function () { return { cy: this.cy, cx: this.cx, py: this.py, px: this.px, n: this.n, rms: this.rms, label: this.label }; };
  Transform.from = function (d) { var t = new Transform(null, d.label); ['cy', 'cx', 'py', 'px', 'n', 'rms'].forEach(function (k) { t[k] = d[k]; }); return t; };

  // ───────────────────────── 段轉換參數檔（GPS 實測共同點） ─────────────────────────
  /**
   * 讀 .inp（地籍坐標轉換程式的輸入檔）：點名 權 N97 E97 N67 E67
   * 例：「GA13     1    2699294.056     216844.448    2699499.318     216015.293」
   */
  function parseParamInp(text) {
    var out = [];
    lines(text).forEach(function (l, i) {
      var t = l.trim().split(/\s+/);
      if (t.length < 6 || !isNum(t[1]) || !isNum(t[2]) || !isNum(t[3]) || !isNum(t[4]) || !isNum(t[5])) return;
      var n97 = +t[2], e97 = +t[3], n67 = +t[4], e67 = +t[5];
      if (isX(t[2]) && isY(t[3])) { var a = n97; n97 = e97; e97 = a; }
      if (isX(t[4]) && isY(t[5])) { var b = n67; n67 = e67; e67 = b; }
      out.push({ name: t[0], wt: +t[1], n97: n97, e97: e97, n67: n67, e67: e67, line: i + 1 });
    });
    return out;
  }
  /** 「367」「0367」「KC0367」→ KC0367 */
  function sectionFromName(path) {
    var s = sectionOf(path); if (s) return s;
    var parts = String(path).replace(/\\/g, '/').split('/'), m;
    for (var i = parts.length - 1; i >= 0; i--) {
      var b = i === parts.length - 1 ? baseName(parts[i]) : parts[i];
      if ((m = /^(?:KC)?(\d{3,4})$/i.exec(b.trim()))) return 'KC' + ('0000' + m[1]).slice(-4);
    }
    return null;
  }
  /** 一個參數檔可能給好幾段用：資料夾「378、379、380」或檔名「KC0378_KC0379_KC0380.inp」→ 三段 */
  /** 一個名稱裡的段號：「378、379、380」「378_379_380」「346-353」（範圍）「KC0378_KC0379」 */
  function sectionNums(b) {
    var out = [];
    var rest = String(b).replace(/(?:KC)?(?<!\d)(\d{3,4})(?!\d)\s*[-~～至到]\s*(?:KC)?(?<!\d)(\d{3,4})(?!\d)/gi, function (_, a, c) {
      a = +a; c = +c;
      if (c > a && c - a <= 30) { for (var k = a; k <= c; k++) out.push(k); } else out.push(a, c);
      return ' ';
    });
    rest.split(/[、,，_\-\s和及~～]+/).forEach(function (t) { if (/^(?:KC)?\d{3,4}$/i.test(t)) out.push(+t.replace(/^KC/i, '')); });
    return uniq(out.map(function (n) { return 'KC' + ('0000' + n).slice(-4); })).sort();
  }
  /**
   * 參數檔給哪幾段用：從檔案往上找，第一個有段號的資料夾說了算。
   *   375\計算成果\1140703\375.inp → 375（自己的資料夾）
   *   346-353\成果解算\1140701_2\349.inp → 346～353 八段
   *   370_375_376\計算成果\1140718\370.inp → 370、375、376
   */
  function sectionsFromPath(path) {
    var parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
    var ownN = sectionNums(baseName(parts[parts.length - 1])), own = ownN.length === 1 ? ownN[0] : null;
    if (ownN.length > 1) return ownN;
    for (var i = parts.length - 2; i >= 0; i--) {
      var nums = sectionNums(parts[i]);
      if (!nums.length) continue;
      if (nums.length === 1) return own ? [own] : nums;
      return !own || nums.indexOf(own) >= 0 ? nums : [own];
    }
    return own ? [own] : [];
  }
  /** 原有圖根改算.txt：點名 改算前N 改算前E 改算後N 改算後E（67） */
  function parseCtlFix(text) {
    var out = [];
    lines(text).forEach(function (l) {
      var t = l.trim().split(/\s+/);
      if (t.length >= 5 && isNum(t[1]) && isNum(t[2]) && isNum(t[3]) && isNum(t[4]) && isY(t[1]) && isY(t[3]))
        out.push({ name: t[0], on: +t[1], oe: +t[2], nn: +t[3], ne: +t[4] });
    });
    return out;
  }
  /**
   * zip 裡常有好幾份 .inp（最上層的工作檔、計算成果\日期\ 的正式版、加經緯度的版本）。
   * 選法：同一組段裡，有 .out 一起的（真的算過）＞日期新的＞其他；檔名有「經緯度」的不用。
   * 回傳 [{ sections, path, text, pts, alternatives:[{path, n, added, removed}] }]
   */
  function pickParamFiles(files) {
    var dirs = {};
    files.forEach(function (f) { var d = f.path.replace(/\\/g, '/').replace(/[^/]*$/, ''); (dirs[d] = dirs[d] || []).push(extName(f.path)); });
    var groups = {};
    files.filter(function (f) { return /\.inp$/i.test(f.path) && !/經緯/.test(fileName(f.path)); }).forEach(function (f) {
      var secs = sectionsFromPath(f.path), text = decode(f.bytes), pts = parseParamInp(text);
      if (!secs.length || !pts.length) return;
      // 日期資料夾（1140701、1140701_2、1140703_剔除HL129）：日期新的優先，同一天有後綴的是修正版、再優先
      var d = f.path.replace(/\\/g, '/').replace(/[^/]*$/, ''), m = /(?:^|\/)(\d{6,7})(_[^/]*)?\/$/.exec(d);
      var score = ((dirs[d] || []).indexOf('OUT') >= 0 ? 1e9 : 0) + (m ? +m[1] * 10 + (m[2] ? 1 : 0) : 0);
      var k = secs.join(',');
      (groups[k] = groups[k] || []).push({ sections: secs, path: f.path, text: text, pts: pts, score: score });
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k].sort(function (a, b) { return b.score - a.score; }), best = g[0], seen = {};
      var names = best.pts.map(function (p) { return p.name; });
      best.alternatives = g.slice(1).filter(function (o) { if (seen[o.text] || o.text === best.text) return false; seen[o.text] = 1; return true; }).map(function (o) {
        var on = o.pts.map(function (p) { return p.name; });
        return { path: o.path, n: o.pts.length, added: on.filter(function (n) { return names.indexOf(n) < 0; }), removed: names.filter(function (n) { return on.indexOf(n) < 0; }) };
      });
      return best;
    });
  }
  function solveN(A, b) {
    var n = b.length, M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var i = 0; i < n; i++) {
      var piv = i; for (var r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
      var t = M[i]; M[i] = M[piv]; M[piv] = t;
      if (Math.abs(M[i][i]) < 1e-15) return null;
      for (r = i + 1; r < n; r++) { var f = M[r][i] / M[i][i]; for (var k = i; k <= n; k++) M[r][k] -= f * M[i][k]; }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) { var sm = M[i][n]; for (k = i + 1; k < n; k++) sm -= M[i][k] * x[k]; x[i] = sm / M[i][i]; }
    return x;
  }
  /**
   * GPS 共同點轉換（67 → 97）：六參數仿射（權重 0 的點不用）＋最小二乘配置法殘差內插（線性協方差，
   * 跟成大「地籍坐標轉換」程式同一種做法），共同點上會完全吻合，離共同點越遠越接近六參數結果。
   */
  function GpsTransform(pts, label) {
    var use = pts.filter(function (p) { return p.wt > 0; });
    var pairs = use.map(function (p) { return [[p.n67, p.e67], [p.n97, p.e97]]; });
    var T = new Transform(null, label);
    // 不剔除（照參數檔，全部用）
    T.cy = pairs.reduce(function (a, p) { return a + p[0][0]; }, 0) / pairs.length;
    T.cx = pairs.reduce(function (a, p) { return a + p[0][1]; }, 0) / pairs.length;
    var rows = pairs.map(function (p) { return [1, (p[0][0] - T.cy) / 1000, (p[0][1] - T.cx) / 1000]; });
    T.py = solve3(rows, pairs.map(function (p) { return p[1][0] - p[0][0]; }));
    T.px = solve3(rows, pairs.map(function (p) { return p[1][1] - p[0][1]; }));
    T.n = pairs.length;
    var res = pairs.map(function (p) { var q = T.apply(p[0][0], p[0][1]); return [p[1][0] - q[0], p[1][1] - q[1]]; });
    var vv = res.reduce(function (a, r) { return a + r[0] * r[0] + r[1] * r[1]; }, 0), dof = 2 * pairs.length - 6;
    T.rms = Math.sqrt(vv / pairs.length);
    T.sigma0 = dof > 0 ? Math.sqrt(vv / dof) : null;
    // 殘差內插：C(d) = c0 (1 - d/a)，a = 共同點最遠距離
    var a = 0;
    pairs.forEach(function (p) { pairs.forEach(function (q) { a = Math.max(a, hypot(p[0][0] - q[0][0], p[0][1] - q[0][1])); }); });
    var C = pairs.map(function (p) { return pairs.map(function (q) { var d = hypot(p[0][0] - q[0][0], p[0][1] - q[0][1]); return Math.max(0, 1 - d / a) + (p === q ? 1e-9 : 0); }); });
    var an = solveN(C, res.map(function (r) { return r[0]; })), ae = solveN(C, res.map(function (r) { return r[1]; }));
    if (an && ae && a > 0) T.lsc = { a: a, pts: pairs.map(function (p) { return [p[0][0], p[0][1]]; }), an: an, ae: ae };
    T.residuals = use.map(function (p, i) { return { name: p.name, dn: res[i][0], de: res[i][1], d: hypot(res[i][0], res[i][1]) }; });
    T.gps = true;
    return T;
  }
  var baseApply = Transform.prototype.apply;
  Transform.prototype.apply = function (y, x) {
    var q = baseApply.call(this, y, x);
    if (this.lsc) {
      var L = this.lsc, dn = 0, de = 0;
      for (var i = 0; i < L.pts.length; i++) {
        var c = 1 - hypot(y - L.pts[i][0], x - L.pts[i][1]) / L.a;
        if (c > 0) { dn += c * L.an[i]; de += c * L.ae[i]; }
      }
      q = [q[0] + dn, q[1] + de];
    }
    if (this.supp) {   // 第二層：管理者確認過的外業檢核點（區域偏差修正）
      var P = this.supp, sn = 0, se = 0;
      for (var j = 0; j < P.pts.length; j++) {
        var cc = 1 - hypot(y - P.pts[j][0], x - P.pts[j][1]) / P.a;
        if (cc > 0) { sn += cc * P.an[j]; se += cc * P.ae[j]; }
      }
      q = [q[0] + sn, q[1] + se];
    }
    return q;
  };
  /**
   * 第二層修正：外業檢核點（67 已知、97 實測）加進來做局部配置。
   * pairs 有雜訊（權重比 GPS 圖根點低，不會硬拉到完全吻合）；anchors（GPS 共同點）修正量固定為 0，不動原本的參數。
   */
  function addSupplement(T, pairs, anchors, opts) {
    opts = opts || {};
    var a = opts.range || 500, noise = opts.noise == null ? 0.3 : opts.noise;
    if (!pairs.length) return T;
    var res = pairs.map(function (p) { var q = T.apply(p.n67, p.e67); return [p.n97 - q[0], p.e97 - q[1]]; });
    // 所有 GPS 共同點都當固定點（只篩近的會讓稍遠的共同點被間接拉動）
    var anc = (anchors || []).filter(function (c) { return !pairs.some(function (p) { return hypot(p.n67 - c[0], p.e67 - c[1]) < 0.01; }); });
    var pts = pairs.map(function (p) { return [p.n67, p.e67]; }).concat(anc), n = pairs.length;
    var C = pts.map(function (p, i) { return pts.map(function (q, j) { return Math.max(0, 1 - hypot(p[0] - q[0], p[1] - q[1]) / a) + (i === j ? (i < n ? noise : 1e-6) : 0); }); });
    var an = solveN(C, res.map(function (r) { return r[0]; }).concat(anc.map(function () { return 0; })));
    var ae = solveN(C, res.map(function (r) { return r[1]; }).concat(anc.map(function () { return 0; })));
    if (an && ae) T.supp = { a: a, pts: pts, an: an, ae: ae, n: n };
    return T;
  }
  /** 97 → 67：同一組參數反算（疊代，來回誤差 < 0.1 mm） */
  Transform.prototype.inverse = function (y, x) {
    var g = this.py ? [y - this.py[0], x - this.px[0]] : [y + 205.3, x - 829.1];
    for (var i = 0; i < 20; i++) {
      var q = this.apply(g[0], g[1]), dy = y - q[0], dx = x - q[1];
      g = [g[0] + dy, g[1] + dx];
      if (Math.abs(dy) < 1e-6 && Math.abs(dx) < 1e-6) break;
    }
    return g;
  };
  var baseDescribe = Transform.prototype.describe;
  Transform.prototype.describe = function () {
    var sup = this.supp ? '，加外業檢核點 ' + this.supp.n + ' 點修正' : '';
    if (!this.gps) return baseDescribe.call(this) + sup;
    return this.label + '：GPS 實測共同點 ' + this.n + ' 點，六參數標準誤差 ' + (this.sigma0 * 100).toFixed(1) + ' 公分' + (this.lsc ? '，加殘差內插（共同點上完全吻合）' : '') + sup;
  };
  var baseToJSON = Transform.prototype.toJSON;
  Transform.prototype.toJSON = function () { var o = baseToJSON.call(this); if (this.lsc) o.lsc = this.lsc; if (this.supp) o.supp = this.supp; if (this.gps) { o.gps = true; o.sigma0 = this.sigma0; } return o; };
  var baseFrom = Transform.from;
  Transform.from = function (d) { var t = baseFrom(d); if (d.lsc) t.lsc = d.lsc; if (d.supp) t.supp = d.supp; if (d.gps) { t.gps = true; t.sigma0 = d.sigma0; } return t; };

  /**
   * 參數檔品質檢查：殘差、留一法（拿掉一點後用其他點推它，看差多少）、
   * 邊長檢核（兩點間 97 距離 vs 67 距離，相對精度分 1/5000、1/10000、1/15000、1/20000 四級，跟 chkdist 一樣）
   */
  function checkParams(pts, sectionPts) {
    var use = pts.filter(function (p) { return p.wt > 0; });
    var T = GpsTransform(pts, '');
    var loo = use.map(function (p) {
      var others = use.filter(function (q) { return q !== p; });
      if (others.length < 4) return { name: p.name, d: null };
      var t = GpsTransform(others, ''), q = t.apply(p.n67, p.e67);
      return { name: p.name, d: hypot(q[0] - p.n97, q[1] - p.e97) };
    });
    var classes = [0, 0, 0, 0, 0], bad = {}, worst = [];
    for (var i = 0; i < use.length; i++) for (var j = i + 1; j < use.length; j++) {
      var A = use[i], B = use[j];
      var d97 = hypot(A.n97 - B.n97, A.e97 - B.e97), d67 = hypot(A.n67 - B.n67, A.e67 - B.e67), diff = d97 - d67;
      var ratio = diff ? Math.abs(d97 / diff) : Infinity;
      var c = ratio < 5000 ? 0 : ratio < 10000 ? 1 : ratio < 15000 ? 2 : ratio < 20000 ? 3 : 4;
      classes[c]++;
      if (c <= 1) { bad[A.name] = (bad[A.name] || 0) + 1; bad[B.name] = (bad[B.name] || 0) + 1; }
      worst.push({ from: A.name, to: B.name, d97: d97, d67: d67, diff: diff, ratio: ratio });
    }
    worst.sort(function (a, b) { return a.ratio - b.ratio; });
    var sig = T.sigma0 || 0.01;
    // 可疑點：自己的殘差大（坐標可能有問題）；外圍點：殘差小但拿掉後推不準（在邊邊，影響外插）
    var suspects = T.residuals.filter(function (r) { return r.d > 2.5 * sig; }).map(function (r) { return r.name; });
    var edges = T.residuals.filter(function (r, k) { return suspects.indexOf(r.name) < 0 && loo[k].d != null && loo[k].d > 3.5 * sig; }).map(function (r) { return r.name; });
    // 段內離最近共同點多遠（外插的地方比較不準）
    var far = null;
    if (sectionPts && sectionPts.length) {
      var maxd = 0, over = 0;
      sectionPts.forEach(function (c) {
        var m = Infinity; use.forEach(function (p) { m = Math.min(m, hypot(c[0] - p.n67, c[1] - p.e67)); });
        maxd = Math.max(maxd, m); if (m > 500) over++;
      });
      far = { max: maxd, over500: over / sectionPts.length };
    }
    // 離其他共同點很遠的點（例如 AA2 離其他點 8 公里）：會把整組參數拉歪
    var nn = use.map(function (p) { var m = Infinity; use.forEach(function (q) { if (q !== p) m = Math.min(m, hypot(p.n67 - q.n67, p.e67 - q.e67)); }); return m; });
    var med = nn.slice().sort(function (a, b) { return a - b; })[Math.floor(nn.length / 2)] || 0;
    var isolated = use.filter(function (p, k) { return nn[k] > Math.max(2000, 6 * med); }).map(function (p, k) { return { name: p.name, dist: nn[use.indexOf(p)] }; });
    var excluded = pts.filter(function (p) { return !(p.wt > 0); }).map(function (p) { return p.name; });
    return { n: use.length, sigma0: T.sigma0, residuals: T.residuals, loo: loo, classes: classes, worst: worst.slice(0, 8), badPairs: bad, suspects: suspects, edges: edges, far: far,
      isolated: isolated, excluded: excluded };
  }

  function buildTransforms(det, sec67) {
    var is67 = {}; sec67.forEach(function (s) { is67[s] = 1; });
    var all = [];
    Object.keys(det.common).forEach(function (s) { if (is67[s]) all.push.apply(all, det.common[s]); });
    var glob = new Transform(all, '全區共同點'), byG = {}, out = {};
    Object.keys(det.common).forEach(function (s) { if (is67[s]) { var g = det.groupOf[s]; (byG[g] = byG[g] || []).push.apply(byG[g], det.common[s]); } });
    sec67.forEach(function (s) {
      var g = det.groupOf[s], ps = byG[g] || [];
      if (ps.length >= 30) {
        var mem = det.groups[g];
        out[s] = new Transform(ps, '同群共同點（' + mem.slice(0, 4).join('、') + (mem.length > 4 ? '…' : '') + '）');
      } else out[s] = glob;
    });
    return { trans: out, glob: glob };
  }

  // ───────────────────────── 圖根點整理 ─────────────────────────
  function cleanControls(entries, tol) {
    tol = tol || 0.10;
    var byName = {}, issues = [], points = [];
    entries.forEach(function (e) {
      if (e.status === 'bad') { issues.push({ type: 'bad', name: e.name, section: e.section, msg: '看不懂的一行（第 ' + e.line + ' 行）' }); return; }
      var k = e.name.toUpperCase(); (byName[k] = byName[k] || []).push(e);
    });
    Object.keys(byName).sort().forEach(function (key) {
      var groups = [];
      byName[key].forEach(function (e) {
        var e67 = e.datum === 'TWD67';
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i], t = e67 !== g.d67 ? 0.5 : tol;
          if (hypot(g.y - e.y, g.x - e.x) <= t) { g.items.push(e); return; }
        }
        groups.push({ y: e.y, x: e.x, items: [e], d67: e67 });
      });
      groups.forEach(function (g, gi) {
        var votes = {}, best = null;
        g.items.forEach(function (e) { var k = r3(e.y) + ',' + r3(e.x); votes[k] = (votes[k] || 0) + 1; if (!best || votes[k] > votes[best]) best = k; });
        var yx = best.split(',').map(Number), ks = Object.keys(votes).map(function (k) { return k.split(',').map(Number); });
        var spread = 0;
        ks.forEach(function (a) { ks.forEach(function (b) { spread = Math.max(spread, hypot(a[0] - b[0], a[1] - b[1])); }); });
        var name = g.items[0].name, secs = sortStr(uniq(g.items.map(function (e) { return e.section; })));
        var p = { id: groups.length === 1 ? name : name + '#' + (gi + 1), name: name, y: yx[0], x: yx[1], sections: secs,
          flags: sortStr(uniq(g.items.map(function (e) { return e.flag; }).filter(Boolean))), count: g.items.length,
          status: g.items[0].status, spread: r3(spread), same_name: groups.length };
        var notes = [], spreadNote = '';
        if (p.status === 'local') notes.push('假設坐標，無法放到地圖上');
        else if (p.status === 'zero') notes.push('坐標有 0，無法放到地圖上');
        if (spread > 0.0005) { spreadNote = '各檔坐標不一致，最多差 ' + (spread * 100).toFixed(1) + ' cm（取出現最多次的）'; notes.push(spreadNote); }
        if (groups.length > 1) notes.push('同名但不同點：共有 ' + groups.length + ' 個「' + name + '」');
        var dms = {}; g.items.forEach(function (e) { if (e.datum) dms[e.datum] = 1; });
        if (dms.TWD97) {
          p.datum = 'TWD97';
          if (dms.TWD67) {
            var vv = {}, bb = null;
            g.items.filter(function (e) { return e.datum === 'TWD97'; }).forEach(function (e) { var k = r3(e.y) + ',' + r3(e.x); vv[k] = (vv[k] || 0) + 1; if (!bb || vv[k] > vv[bb]) bb = k; });
            var q = bb.split(',').map(Number); p.y = q[0]; p.x = q[1];
            notes.push('同一點在某些 CTL 是 67、某些是 97，用 97 的坐標');
          }
        } else if (dms.TWD67) { p.datum = 'TWD67'; notes.push('原為 TWD67，已換算成 97（' + (g.items[0].datum_why || '') + '）'); }
        else if (dms['?']) { p.datum = '?'; notes.push('看不出是 67 還是 97，暫時當作 97，請確認'); }
        var raws = uniq(g.items.filter(function (e) { return e.raw; }).map(function (e) { return e.raw[0] + ',' + e.raw[1]; }));
        if (raws.length && raws.some(function (r) { return r !== p.y + ',' + p.x; })) p.raw = raws.sort().map(function (r) { return r.split(',').map(Number); });
        var fixes = sortStr(uniq([].concat.apply([], g.items.map(function (e) { return e.fix || []; }))));
        if (fixes.length) p.fix = fixes;
        p.notes = notes;
        if (p.status === 'ok') p.ll = tm2ToLatLng(p.y, p.x);
        points.push(p);
        var sj = secs.join(',');
        if (p.datum === '?') issues.push({ type: 'datum', name: name, section: sj, msg: '看不出是 67 還是 97（暫時當作 97）', id: p.id });
        if (p.status !== 'ok') issues.push({ type: p.status, name: name, section: sj, msg: notes[0], id: p.id });
        if (spreadNote) issues.push({ type: 'spread', name: name, section: sj, msg: spreadNote, id: p.id });
      });
      if (groups.length > 1) {
        var md = Infinity;
        groups.forEach(function (a) { groups.forEach(function (b) { if (a !== b) md = Math.min(md, hypot(a.y - b.y, a.x - b.x)); }); });
        var all = sortStr(uniq([].concat.apply([], groups.map(function (g) { return g.items.map(function (e) { return e.section; }); }))));
        issues.push({ type: 'samename', name: groups[0].items[0].name, section: all.join(','), msg: '同名 ' + groups.length + ' 個不同點，最近相距 ' + md.toFixed(2) + ' m', id: groups[0].items[0].name + '#1' });
      }
    });
    return { points: points, issues: issues };
  }

  // ───────────────────────── 建立底圖（數值地籍圖 → 全部 97） ─────────────────────────
  var SHEET_67 = ('0346 0347 0348 0349 0350 0351 0352 0353 0357 0358 0359 0360 0361 0362 0363 0364 0365 ' +
    '0367 0370 0375 0376 0377 0378 0379 0380').split(' ').map(function (s) { return 'KC' + s; });
  var ABOLISHED = ['KC0326', 'KC0371', 'KC0372', 'KC0373', 'KC0374'];
  var NO_NEIGHBOUR = '旁邊是圖解區，沒有 97 數值段可以算共同點，用全區參數';
  var BASE_EXT = { COA: 1, BNP: 1, PAR: 1, CTL: 1 };

  /** files [{path, bytes}] → {段: {COA: text, …}}；同段同副檔名出現兩次用後面那個 */
  function groupBaseFiles(files) {
    var found = {};
    files.forEach(function (f) {
      var e = extName(f.path); if (!BASE_EXT[e]) return;
      var s = sectionOf(f.path); if (!s) return;
      (found[s] = found[s] || {})[e] = f.text != null ? f.text : decode(f.bytes);
    });
    return found;
  }
  var tick = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  /**
   * opts：{ sec67: null|[…]（null = 段名表紅字 + 自動偵測）, abolished: […], progress: fn(text) }
   * 回傳 Promise<{ index, sections: {段: {section, parcels}}, controls, issues, ctlEntries, parcelIndex }>
   */
  function buildBase(found, opts) {
    opts = opts || {};
    var progress = opts.progress || function () {};
    var abolished = {}; (opts.abolished || ABOLISHED).forEach(function (s) { abolished[s] = 1; });
    var all = Object.keys(found).sort(), secs = all.filter(function (s) { return !abolished[s]; });
    var skipped = all.filter(function (s) { return abolished[s]; });
    var coaRaw = {}, okPts = {}, det, eff67, trans, glob, gpsSets = [], out = { sections: {} };
    progress('讀界址點…');
    return tick().then(function () {
      secs.forEach(function (s) {
        coaRaw[s] = found[s].COA ? parseCoa(found[s].COA) : {};
        okPts[s] = Object.keys(coaRaw[s]).map(function (k) { return coaRaw[s][k]; }).filter(function (c) { return coordStatus(c[0], c[1]) === 'ok'; });
      });
      progress('判斷 TWD67 / TWD97（比對相鄰段的界址點）…');
      return tick();
    }).then(function () {
      det = detectDatum(okPts);
      var is = {};
      if (opts.sec67) opts.sec67.forEach(function (s) { if (found[s] && !abolished[s]) is[s] = 1; });
      else {
        SHEET_67.concat(det.auto67).forEach(function (s) { if (found[s] && !abolished[s]) is[s] = 1; });
        var gs = {}; Object.keys(is).forEach(function (s) { if (s in det.groupOf) gs[det.groupOf[s]] = 1; });
        Object.keys(gs).forEach(function (g) { det.groups[g].forEach(function (s) { is[s] = 1; }); });
      }
      // 轉換參數檔：可能好幾份（整組的、分段的）。單段的檔 → 那段一定是 67；整組的只套在本來就是 67 的段
      gpsSets = (opts.gpsSets || []).slice();
      if (opts.gps) {   // 舊的寫法 {段: 點}
        var seen = [];
        Object.keys(opts.gps).forEach(function (s) {
          var hit = seen.filter(function (x) { return x.pts === opts.gps[s]; })[0];
          if (hit) hit.sections.push(s); else { hit = { file: (opts.gpsFile || {})[s] || s + '.inp', sections: [s], pts: opts.gps[s] }; seen.push(hit); }
        });
        gpsSets = gpsSets.concat(seen);
      }
      gpsSets = gpsSets.filter(function (x) { return x.pts.filter(function (p) { return p.wt > 0; }).length >= 4; });
      gpsSets.forEach(function (x) { if (x.sections.length === 1 && found[x.sections[0]] && !abolished[x.sections[0]]) is[x.sections[0]] = 1; });
      eff67 = Object.keys(is).sort();
      var bt = buildTransforms(det, eff67); trans = bt.trans; glob = bt.glob;
      out.gpsCheck = {}; out.gpsChoice = {};
      var fits = {};
      var fitOf = function (x) { return fits[x.file] || (fits[x.file] = GpsTransform(x.pts, x.file)); };
      eff67.forEach(function (s) {
        // 候選：檔名／資料夾寫了這段的，加上在這段範圍內（300 m）有 3 點以上共同點的（檔名寫漏了也能用到）
        var sb = okPts[s] && okPts[s].length ? bbox(okPts[s], 300) : null;
        var cands = gpsSets.filter(function (x) {
          if (x.sections.indexOf(s) >= 0) return true;
          if (!sb) return false;
          return x.pts.filter(function (p) { return p.wt > 0 && p.n67 >= sb[0] && p.n67 <= sb[1] && p.e67 >= sb[2] && p.e67 <= sb[3]; }).length >= 3;
        });
        if (!cands.length) return;
        var choice = cands[0], cmp = [];
        if (cands.length > 1) {
          // 好幾份都能用 → 拿這段附近（300 m 內）的共同點來考：自己有的點用留一法，沒有的直接推，平均差最小的勝出
          var b = okPts[s] && okPts[s].length ? bbox(okPts[s], 300) : null, chk = [], keys = {};
          cands.forEach(function (x) { x.pts.forEach(function (p) {
            var k = p.name + '|' + p.n67.toFixed(3) + '|' + p.e67.toFixed(3);
            if (p.wt > 0 && !keys[k] && (!b || (p.n67 >= b[0] && p.n67 <= b[1] && p.e67 >= b[2] && p.e67 <= b[3]))) { keys[k] = 1; chk.push(p); }
          }); });
          cands.forEach(function (x) {
            var e = chk.map(function (p) {
              var inX = x.pts.filter(function (q) { return q.wt > 0 && q.name === p.name && Math.abs(q.n67 - p.n67) < 0.001 && Math.abs(q.e67 - p.e67) < 0.001; })[0];
              var t = inX ? GpsTransform(x.pts.filter(function (q) { return q !== inX; }), '') : fitOf(x), q2 = t.apply(p.n67, p.e67);
              return hypot(q2[0] - p.n97, q2[1] - p.e97);
            });
            cmp.push({ file: x.file, n: x.pts.filter(function (p) { return p.wt > 0; }).length, sections: x.sections, checks: e.length, byArea: x.sections.indexOf(s) < 0,
              err: e.length ? e.reduce(function (a, v) { return a + v; }, 0) / e.length : null });
          });
          var pin = (opts.paramChoice || {})[s];
          var best = cmp.filter(function (c) { return c.file === pin; })[0] || cmp.slice().sort(function (a, c) { return (a.err == null ? 1e9 : a.err) - (c.err == null ? 1e9 : c.err); })[0];
          choice = cands.filter(function (x) { return x.file === best.file; })[0];
          cmp.forEach(function (c) { c.chosen = c.file === choice.file; c.pinned = c.file === pin; });
        }
        trans[s] = fitOf(choice);
        out.gpsChoice[s] = { file: choice.file, sections: choice.sections, candidates: cmp };
        // 外插範圍只看有用在地號上的界址點（COA 裡偶爾有跑很遠的孤點）
        var inParcel = okPts[s];
        if (found[s].BNP) {
          var used = {}, bn = parseBnp(found[s].BNP).map;
          Object.keys(bn).forEach(function (k) { bn[k].forEach(function (n) { used[n] = 1; }); });
          inParcel = Object.keys(coaRaw[s]).filter(function (k) { return used[k]; }).map(function (k) { return coaRaw[s][k]; }).filter(function (c) { return coordStatus(c[0], c[1]) === 'ok'; });
        }
        out.gpsCheck[s] = checkParams(choice.pts, inParcel);
      });
      // 第二層：管理者確認過的外業檢核點，加在各段轉換上（每段自己一份，不動共用的參數）
      out.suppCount = {};
      if (opts.supp && opts.supp.length) {
        eff67.forEach(function (s) {
          if (!trans[s] || !okPts[s] || !okPts[s].length) return;
          var b = bbox(okPts[s], 500);
          var mine = opts.supp.filter(function (p) { return p.n67 != null && p.n67 >= b[0] && p.n67 <= b[1] && p.e67 >= b[2] && p.e67 <= b[3]; });
          if (!mine.length) return;
          var T = Transform.from(trans[s].toJSON()), ch = out.gpsChoice[s];
          var anchors = ch ? gpsSets.filter(function (x) { return x.file === ch.file; })[0].pts.filter(function (p) { return p.wt > 0; }).map(function (p) { return [p.n67, p.e67]; }) : [];
          trans[s] = addSupplement(T, mine, anchors, { range: opts.suppRange || 500 });
          out.suppCount[s] = mine.length;
        });
      }
      progress('組地號、換算坐標…');
      return tick();
    }).then(function () {
      var sheet = {}, auto = {}; SHEET_67.forEach(function (s) { sheet[s] = 1; }); det.auto67.forEach(function (s) { auto[s] = 1; });
      var entries = [], coa97 = {}, parcelIndex = [];
      secs.forEach(function (sec) {
        var f = found[sec], T = trans[sec], coa = {};
        Object.keys(coaRaw[sec]).forEach(function (k) { var c = coaRaw[sec][k]; coa[k] = T && coordStatus(c[0], c[1]) === 'ok' ? T.apply(c[0], c[1]) : c; });
        coa97[sec] = Object.keys(coa).map(function (k) { return coa[k]; }).filter(function (c) { return coordStatus(c[0], c[1]) === 'ok'; });
        var bnp = f.BNP ? parseBnp(f.BNP) : { map: {}, order: [] }, par = f.PAR ? parsePar(f.PAR) : {};
        var parcels = [], missing = 0, b = [Infinity, -Infinity, Infinity, -Infinity];
        var ext = function (c) { if (c[0] < b[0]) b[0] = c[0]; if (c[0] > b[1]) b[1] = c[0]; if (c[1] < b[2]) b[2] = c[1]; if (c[1] > b[3]) b[3] = c[1]; };
        bnp.order.forEach(function (key) {
          var ring = [];
          bnp.map[key].forEach(function (pid) {
            var c = coa[pid];
            if (!c) { missing++; return; }
            if (coordStatus(c[0], c[1]) !== 'ok') return;
            var q = tm2ToLatLng(c[0], c[1]); ring.push(q[0], q[1]); ext(c);
          });
          if (ring.length < 6) return;
          var info = par[key] || {}, center;
          if (info.cy && coordStatus(info.cy, info.cx) === 'ok') { var cc = T ? T.apply(info.cy, info.cx) : [info.cy, info.cx]; center = tm2ToLatLng(cc[0], cc[1]); }
          else {
            var sy = 0, sx = 0; for (var i = 0; i < ring.length; i += 2) { sy += ring[i]; sx += ring[i + 1]; }
            center = [Math.round(sy / (ring.length / 2) * 1e7) / 1e7, Math.round(sx / (ring.length / 2) * 1e7) / 1e7];
          }
          parcels.push({ k: key, a: info.area == null ? null : info.area, u: info.use || '', c: center, r: ring,
            n: bnp.map[key].filter(function (pid) { return coa[pid] && coordStatus(coa[pid][0], coa[pid][1]) === 'ok'; }) });
          parcelIndex.push([sec, key, center[0], center[1], info.area == null ? null : info.area]);
        });
        if (!parcels.length) coa97[sec].forEach(ext);
        out.sections[sec] = { section: sec, parcels: parcels };
        // 界址點坐標（給外業包、寫回用）：{點號: [97Y, 97X]（67 段再加 [67Y, 67X]）}
        var cp = {};
        Object.keys(coa).forEach(function (k) {
          var c = coa[k], r = coaRaw[sec][k];
          if (coordStatus(c[0], c[1]) !== 'ok') return;
          cp[k] = T ? [r3(c[0]), r3(c[1]), r[0], r[1]] : [r[0], r[1]];
        });
        out.coa = out.coa || {}; out.coa[sec] = cp;
        var src = [];
        if (sheet[sec]) src.push('段名表紅字');
        if (auto[sec]) src.push('自動偵測');
        var e67 = eff67.indexOf(sec) >= 0, gc = out.gpsCheck[sec];
        if (gc) src.push('有轉換參數檔');
        var entry = { section: sec, parcels: parcels.length, points: Object.keys(coaRaw[sec]).length, missing: missing,
          files: Object.keys(f).sort(), datum: e67 ? 'TWD67' : 'TWD97',
          datum_src: e67 ? (opts.sec67 ? '管理者指定' : src.join('、')) : '',
          transform: T ? T.describe() + (T === glob ? '（' + NO_NEIGHBOUR + '）' : '') : '', tparams: T ? T.toJSON() : null, supp: out.suppCount[sec] || 0 };
        var gch = out.gpsChoice[sec];
        if (gc) entry.gps = { file: gch.file, candidates: gch.candidates, isolated: gc.isolated, excluded: gc.excluded,
          shared: Object.keys(out.gpsChoice).filter(function (o) { return o !== sec && out.gpsChoice[o].file === gch.file; }), n: gc.n, sigma0: gc.sigma0, suspects: gc.suspects, edges: gc.edges, classes: gc.classes, far: gc.far,
          residuals: gc.residuals.map(function (r, k) { return { name: r.name, d: r.d, loo: gc.loo[k].d }; }),
          worst: gc.worst.slice(0, 5).map(function (w) { return { from: w.from, to: w.to, d: w.d97, diff: w.diff, ratio: w.ratio }; }) };
        if (sheet[sec] && !e67) entry.datum_warn = '段名表標紅字（67），但目前設定為 97';
        else if (auto[sec] && !e67) entry.datum_warn = '自動偵測像是 67，但目前設定為 97';
        if (b[0] < Infinity) { var sw = tm2ToLatLng(b[0], b[2]), ne = tm2ToLatLng(b[1], b[3]); entry.bbox = [sw[0], sw[1], ne[0], ne[1]]; }
        entries.push(entry);
      });
      out.entriesIdx = entries; out.coa97 = coa97; out.parcelIndex = parcelIndex;
      progress('整理圖根點（每一點判斷 67 或 97）…');
      return tick();
    }).then(function () {
      var is67 = {}; eff67.forEach(function (s) { is67[s] = 1; });
      var ctlFiles = {}, headers = {}, sets2 = {}, fixedCtl = {};
      secs.forEach(function (s) {
        if (!found[s].CTL) return;
        headers[s] = lines(found[s].CTL)[0].trim();
        ctlFiles[s] = parseCtl(found[s].CTL);
        // 原有圖根改算：CTL 裡還是舊坐標的，改成新的（67）
        (opts.ctlFix || []).forEach(function (fx) {
          ctlFiles[s].forEach(function (e) {
            if (e.status === 'ok' && e.name.toUpperCase() === fx.name.toUpperCase() && hypot(e.y - fx.on, e.x - fx.oe) <= 0.01) {
              e.fix = (e.fix || []).concat(['原有圖根改算：' + fx.on.toFixed(3) + ', ' + fx.oe.toFixed(3) + ' → ' + fx.nn.toFixed(3) + ', ' + fx.ne.toFixed(3) + '（移動 ' + hypot(fx.nn - fx.on, fx.ne - fx.oe).toFixed(3) + ' m）']);
              e.y = fx.nn; e.x = fx.ne; fixedCtl[fx.name] = (fixedCtl[fx.name] || 0) + 1;
            }
          });
        });
        sets2[s] = new Set(ctlFiles[s].filter(function (e) { return e.status === 'ok'; }).map(function (e) { return e.name.toUpperCase() + '|' + e.y + '|' + e.x; }));
      });
      // 共用清單：跟另一種坐標系統的段的 CTL 有一半以上相同
      var shared = {}, big = Object.keys(sets2).filter(function (s) { return sets2[s].size > 50; });
      big.forEach(function (a) {
        big.forEach(function (b) {
          if (a === b || !!is67[a] === !!is67[b]) return;
          var n = 0; sets2[a].forEach(function (k) { if (sets2[b].has(k)) n++; });
          if (n >= 0.5 * Math.min(sets2[a].size, sets2[b].size)) { shared[a] = 1; shared[b] = 1; }
        });
      });
      var prior = new Map();
      Object.keys(sets2).forEach(function (s) {
        if (shared[s]) return;
        var d = is67[s] ? 'TWD67' : 'TWD97';
        sets2[s].forEach(function (k) { var p = prior.get(k); if (!p) prior.set(k, p = {}); p[d] = 1; });
      });
      var g97 = grid([].concat.apply([], secs.map(function (s) { return out.coa97[s]; })), 50);
      var g67 = grid([].concat.apply([], eff67.map(function (s) { return okPts[s] || []; })), 50);
      // 67 的點用「最近的 67 界址點所在段」的轉換參數
      var g67s = grid([].concat.apply([], eff67.map(function (s) { return (okPts[s] || []).map(function (p) { return [p[0], p[1], s]; }); })), 50);
      var tcache = new Map();
      var transFor = function (y, x) {
        var key = y + '|' + x;
        if (tcache.has(key)) return tcache.get(key);
        var best = null, bd = Infinity;
        var scan = function (q) { var d = (q[0] - y) * (q[0] - y) + (q[1] - x) * (q[1] - x); if (d < bd || (d === bd && q[2] < best)) { bd = d; best = q[2]; } };
        eachNear(g67s, y, x, 300, scan);
        if (bd > 300 * 300) eachNear(g67s, y, x, 1500, scan);
        var t = best && bd <= 1500 * 1500 ? (trans[best] || glob) : glob;
        tcache.set(key, t);
        return t;
      };
      // GPS 實測過的圖根點：67 坐標跟參數檔一樣 → 直接用實測的 97
      var gpsBy = {};
      gpsSets.forEach(function (x) { x.pts.forEach(function (p) { if (p.wt > 0) (gpsBy[p.name.toUpperCase()] = gpsBy[p.name.toUpperCase()] || []).push({ p: p, sec: x.sections.join('、') }); }); });
      var gpsHit = function (name, y, x) {
        var a = gpsBy[name.toUpperCase()] || [];
        for (var i = 0; i < a.length; i++) {
          if (hypot(a[i].p.n67 - y, a[i].p.e67 - x) <= 0.01) return { as: 'TWD67', p: a[i].p, sec: a[i].sec };
          if (hypot(a[i].p.n97 - y, a[i].p.e97 - x) <= 0.01) return { as: 'TWD97', p: a[i].p, sec: a[i].sec };
        }
        return null;
      };
      var decided = new Map();
      var decide = function (k, y, x) {
        if (decided.has(k)) return decided.get(k);
        var p = prior.get(k), r, ks = p ? Object.keys(p) : [], g = gpsHit(k.split('|')[0], y, x);
        if (g) r = [g.as, g.as === 'TWD67' ? 'GPS 實測（' + g.sec + ' 轉換參數檔）' : '跟 ' + g.sec + ' 轉換參數檔的 GPS 實測一致'];
        else if (ks.length === 1) r = [ks[0], '依所在段'];
        else {
          var d97 = nearestDist(g97, y, x, 300), d67 = eff67.length ? nearestDist(g67, y, x, 300) : Infinity;
          if (d67 < 25 && d97 > Math.max(60, 4 * d67)) r = ['TWD67', '依位置判斷（離 67 界址點 ' + Math.round(d67) + ' m、離 97 界址點 ' + (d97 > 1e5 ? '很遠' : Math.round(d97) + ' m') + '）'];
          else if (d97 < 25 && d67 > Math.max(60, 4 * d97)) r = ['TWD97', '依位置判斷'];
          else r = ['?', '判斷不出 67 或 97（當作 97，請確認）'];
        }
        decided.set(k, r);
        return r;
      };
      Object.keys(ctlFiles).forEach(function (s) {
        var keys = ctlFiles[s].map(function (e) { return e.status === 'ok' ? e.name.toUpperCase() + '|' + e.y + '|' + e.x : null; });
        keys.forEach(function (k, i) { if (k) decide(k, ctlFiles[s][i].y, ctlFiles[s][i].x); });
      });
      if (opts.debug) opts.debug({ decided: decided, ctlFiles: ctlFiles });
      // 判斷不出來的點：看同一份 CTL 前後 15 行（CTL 一批一批測的，前後點同一系統；抽測準確率約 99%）。最多傳 3 輪。
      for (var pass = 0; pass < 3; pass++) {
        var changed = 0;
        Object.keys(ctlFiles).forEach(function (s) {
          var keys = ctlFiles[s].map(function (e) { return e.status === 'ok' ? e.name.toUpperCase() + '|' + e.y + '|' + e.x : null; });
          keys.forEach(function (k, i) {
            if (!k || decided.get(k)[0] !== '?') return;
            var cnt = {}, tot = 0;
            keys.slice(Math.max(0, i - 15), i + 16).forEach(function (q) {
              if (!q || q === k) return;
              var dq = decided.get(q);
              if (dq[0] === '?') return;
              cnt[dq[0]] = (cnt[dq[0]] || 0) + 1; tot++;
            });
            if (tot >= 4) {
              var bestD = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0];
              if (cnt[bestD] >= 0.85 * tot) { decided.set(k, [bestD, '依同一份 CTL 前後的點（' + cnt[bestD] + '/' + tot + ' 點是 ' + bestD.slice(-2) + '）']); changed++; }
            }
          });
        });
        if (!changed) break;
      }
      var ctlEntries = [], stats = { TWD67: 0, TWD97: 0, '?': 0 };
      Object.keys(ctlFiles).forEach(function (s) {
        ctlFiles[s].forEach(function (e) {
          e.section = s;
          if (e.status === 'ok') {
            var d = decide(e.name.toUpperCase() + '|' + e.y + '|' + e.x, e.y, e.x);
            e.raw = [e.y, e.x]; e.datum = d[0]; e.datum_why = d[1];
            var gh = d[0] === 'TWD67' && /^GPS 實測/.test(d[1]) ? gpsHit(e.name, e.y, e.x) : null;
            if (gh) { e.y = gh.p.n97; e.x = gh.p.e97; }
            else if (d[0] === 'TWD67') { var q = transFor(e.y, e.x).apply(e.y, e.x); e.y = r3(q[0]); e.x = r3(q[1]); }
            stats[d[0]]++;
          }
          ctlEntries.push(e);
        });
      });
      var cc = cleanControls(ctlEntries);
      var summary = {}; cc.issues.forEach(function (i) { summary[i.type] = (summary[i.type] || 0) + 1; });
      out.controls = cc.points; out.issues = cc.issues;
      out.ctlEntries = { headers: headers, entries: ctlEntries.map(function (e) {
        return { section: e.section, line: e.line, name: e.name, y: e.y, x: e.x, raw: e.raw || null, status: e.status, datum: e.datum || null, datum_why: e.datum_why || null, fix: e.fix };
      }) };
      out.index = { version: 1, built: Date.now(), sections: out.entriesIdx, abolished: skipped,
        gps: Object.keys(out.gpsCheck).sort(), ctlFixed: fixedCtl,
        datum: { sec67: eff67, auto67: det.auto67, sheet67: SHEET_67, configured: !!opts.sec67, global: glob.describe(), ctl: stats, shared_ctl: Object.keys(shared).sort() },
        ctl: { lines: ctlEntries.length, points: cc.points.length, issues: summary } };
      delete out.entriesIdx; delete out.coa97;
      progress('完成：' + secs.length + ' 段（67 段 ' + eff67.length + ' 個已換成 97）、' + out.parcelIndex.length + ' 筆地號、圖根點 ' + cc.points.length + ' 點');
      return out;
    });
  }

  /** 標準格式 CTL 匯出（每段一份 + 全區 + 說明）→ zip Uint8Array */
  function exportCtl(ctlEntries, controls) {
    var bySec = {}, notes = ['圖根點整理說明（' + new Date().toLocaleString() + '）', '',
      '格式：點名 8 字、Y（縱、N）11 字、X（橫、E）10 字，小數 3 位，全部是 TWD97。',
      'Y/X 判斷：整數 7 位是 Y、6 位是 X（同轉換系統），寫反的已對調。',
      'X 後面多出來的字（第 4 位小數或註記碼）照固定欄寬捨去。', ''];
    ctlEntries.entries.forEach(function (e) { (bySec[e.section] = bySec[e.section] || []).push(e); });
    var files = [];
    Object.keys(bySec).sort().forEach(function (s) {
      var out = [ctlEntries.headers[s] || ''];
      bySec[s].forEach(function (e) {
        var tag = s + ' 第 ' + e.line + ' 行 ' + e.name;
        if (e.status !== 'ok') { notes.push('拿掉 ' + tag + '：' + ({ local: '假設坐標', zero: '坐標是 0', bad: '看不懂' }[e.status] || e.status)); return; }
        try { out.push(formatCtlLine(e.name, e.y, e.x)); } catch (err) { notes.push('拿掉 ' + tag + '：' + err.message); return; }
        var m = (e.fix || []).slice();
        if (e.datum === 'TWD67') m.push('67→97（原 ' + e.raw[0].toFixed(3) + ' ' + e.raw[1].toFixed(3) + '；' + (e.datum_why || '') + '）');
        else if (e.datum === '?') m.push('看不出 67 或 97，照原值當 97，請確認');
        if (m.length) notes.push(tag + '：' + m.join('；'));
      });
      files.push({ path: s + '/' + s + '.CTL', text: out.join('\r\n') + '\r\n' });
    });
    var allp = [];
    controls.forEach(function (p) { if (p.status !== 'ok') return; try { allp.push(formatCtlLine(p.name, p.y, p.x)); } catch (e) { /* 略過 */ } });
    files.push({ path: '全區圖根點_TWD97.CTL', text: ['KCK000000000'].concat(allp).join('\r\n') + '\r\n' });
    files.push({ path: '整理說明.txt', text: '﻿' + notes.join('\r\n') });
    return zipStore(files);
  }

  // ───────────────────────── 段名表 xlsx ─────────────────────────
  function xmlText(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
  function sectionNamesFromXlsx(u8) {
    return unzip(u8).then(function (files) {
      var get = function (n) { var f = files.filter(function (x) { return x.path === n; })[0]; return f ? new TextDecoder('utf-8').decode(f.bytes) : ''; };
      var shared = [];
      (get('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || []).forEach(function (si) {
        shared.push(xmlText((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(function (t) { return t.replace(/<[^>]+>/g, ''); }).join('')));
      });
      var sheet = files.map(function (f) { return f.path; }).filter(function (p) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(p); }).sort()[0];
      var out = {};
      (get(sheet).match(/<row[\s\S]*?<\/row>/g) || []).forEach(function (row) {
        var cells = [];
        (row.match(/<c [^>]*(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(function (c) {
          var t = (/ t="(\w+)"/.exec(c) || [])[1], v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1], val = null;
          if (t === 's' && v != null) val = shared[+v];
          else if (t === 'inlineStr') val = xmlText((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
          else if (v != null) val = xmlText(v);
          cells.push(val);
        });
        cells.forEach(function (v, k) {
          if (v == null || k + 1 >= cells.length) return;
          v = String(v).trim();
          if (/^\d{3,4}(\.0)?$/.test(v)) {
            var name = String(cells[k + 1] || '').trim();
            if (/段$/.test(name) || name.indexOf('小段') >= 0) out['KC' + ('0000' + v.split('.')[0]).slice(-4)] = name;
          }
        });
      });
      return out;
    });
  }

  // ───────────────────────── 重測系統 D 檔（dBASE） ─────────────────────────
  function parseDbf(u8) {
    if (u8.length < 33 || (u8[0] & 7) !== 3) throw new Error('不是 dBASE III 檔');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var nrec = dv.getUint32(4, true), hlen = dv.getUint16(8, true), rlen = dv.getUint16(10, true);
    var fields = [], off = 32, pos = 1;
    while (off < hlen - 1 && u8[off] !== 0x0D) {
      var nm = ''; for (var i = 0; i < 11 && u8[off + i]; i++) nm += String.fromCharCode(u8[off + i]);
      fields.push({ name: nm, len: u8[off + 16], pos: pos }); pos += u8[off + 16]; off += 32;
    }
    var recs = [];
    for (var r = 0; r < nrec; r++) {
      var b = hlen + r * rlen;
      if (b + rlen > u8.length) break;
      if (u8[b] === 0x2A) continue;
      var rec = {};
      fields.forEach(function (f) { rec[f.name] = big5.decode(u8.subarray(b + f.pos, b + f.pos + f.len)).replace(/\0/g, '').trim(); });
      recs.push(rec);
    }
    return { fields: fields.map(function (f) { return f.name; }), records: recs };
  }

  // ───────────────────────── L 檔、CSV、B90 ─────────────────────────
  function extractTriples(line) {
    var t = line.trim().split(/[\s,]+/).filter(Boolean), res = [], i = 0;
    while (i + 2 < t.length) {
      if (/^[A-Za-z0-9_\-.+]+$/.test(t[i]) && isNum(t[i + 1]) && isNum(t[i + 2]) && t[i + 1].indexOf('.') >= 0 && t[i + 2].indexOf('.') >= 0) {
        var a = t[i + 1], b = t[i + 2];
        if (isX(a) && isY(b)) { var tmp = a; a = b; b = tmp; }
        res.push({ name: t[i], y: parseFloat(a), x: parseFloat(b) });
        i += 3;
      } else i++;
    }
    return res;
  }
  function parseL(text) { var out = []; lines(text).forEach(function (l, i) { extractTriples(l).forEach(function (p) { p.line = i + 1; out.push(p); }); }); return out; }
  function parseCsvPoints(text) {
    var out = [];
    lines(text).forEach(function (l, i) {
      var t = l.split(/[,\t]/).map(function (v) { return v.trim().replace(/^"|"$/g, ''); });
      if (t.length >= 3 && t[0] && isNum(t[1]) && isNum(t[2])) {
        var y = parseFloat(t[1]), x = parseFloat(t[2]);
        if (isX(t[1]) && isY(t[2])) { var tmp = y; y = x; x = tmp; }
        out.push({ name: t[0], y: y, x: x, line: i + 1 });
      }
    });
    return out;
  }
  var B90_PT = /(測\s*站|標\s*定\s*點|施\s*測\s*點)\s*[:：]\s*(\S+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s*(.*)$/;
  function parseB90(text) {
    var setups = [], cur = null;
    lines(text).forEach(function (l) {
      var m = B90_PT.exec(l); if (!m) return;
      var role = m[1].replace(/\s/g, ''), p = { name: m[2], y: parseFloat(m[3]), x: parseFloat(m[4]) }, rest = m[5].trim().split(/\s+/).filter(Boolean);
      if (role === '測站') { cur = { station: p, back: null, targets: [] }; setups.push(cur); }
      else if (!cur) return;
      else if (role === '標定點') { if (rest.length && isNum(rest[rest.length - 1])) p.dist = parseFloat(rest[rest.length - 1]); cur.back = p; }
      else {
        if (rest.length && /^\d+-\d+-\d+$/.test(rest[0])) { p.angle = rest[0]; rest = rest.slice(1); }
        if (rest.length && isNum(rest[0])) p.dist = parseFloat(rest[0]);
        cur.targets.push(p);
      }
    });
    return setups;
  }
  function looksLikeB90(t) { return /測\s*站\s*[:：]/.test(t) && /施\s*測\s*點\s*[:：]/.test(t); }
  function isBoundaryName(n) { return /^\d+(\.\d+)?$/.test(n); }
  function refName(num, ref) { return parseInt(num, 10) + '.' + ('0' + parseInt(ref, 10)).slice(-2); }

  var WANT = /\.(d13|d14|d20|l02|l14|l20|b9\d|csv|txt|raw|zip)$/i;
  function wanted(p) { return WANT.test(p); }

  /** 「123, 124-1」「1114 123、1114 124之2」→ [{section: 'KC1114'|null, key: '123'}]；看不懂的放 bad */
  function parseParcelList(text) {
    var out = [], bad = [], seen = {};
    var push = function (sec, key) { var k = (sec || '') + '|' + key; if (!seen[k]) { seen[k] = 1; out.push({ section: sec, key: key }); } };
    String(text || '').split(/[,，、;；\n]+/).forEach(function (part) {
      part = part.trim(); if (!part) return;
      var m = /^(?:(?:[A-Za-z]{2})?(\d{4})\s*(?:段|:|：|\s)\s*)?0*(\d+)\s*(?:[-之]\s*0*(\d+))?\s*(?:地號)?$/.exec(part);
      if (m) { push(m[1] ? 'KC' + m[1] : null, parcelLabel(m[2], m[3] || '0')); return; }
      part.split(/\s+/).forEach(function (t) { var k = parcelKeyOf(t); if (k) push(null, k); else bad.push(t); });
    });
    return { parcels: out, bad: bad };
  }

  /** D13：地號 → 界址點號（依序） */
  function parseD13(db) {
    var out = {};
    db.records.forEach(function (r) {
      if (!/^\d+$/.test(r.O_PARCEL || '')) return;
      var k = parcelLabel(r.O_PARCEL, r.O_PARCEL_E || '0'), a = out[k] = out[k] || [];
      for (var i = 1; i <= 8; i++) { var v = r['COORD_' + i]; if (/^\d+$/.test(v || '') && +v) a.push(String(+v)); }
    });
    return out;
  }

  /**
   * 重測系統上傳檔 → 補點、參考點、宗地、用到的圖根點、設站。files：[{path, bytes}]（zip 已展開）
   * opts.parcels：[{section, key}] 這次測量的地號 → 只讀這幾筆土地（D13 找界址點、D14 取坐標，參考點取這幾筆附近的）
   * opts.refBuffer：參考點範圍（公尺，預設 50）
   */
  function parseFieldFiles(files, opts) {
    opts = opts || {};
    var want = opts.parcels && opts.parcels.length ? opts.parcels : null, buf = opts.refBuffer || 50;
    var report = [], groups = {}, skipped = [];
    files.forEach(function (f) {
      if (!wanted(f.path)) { skipped.push(f.path); return; }
      if (baseName(f.path).toUpperCase() === 'KC0000') return;
      var s = sectionOf(f.path) || '未知段';
      (groups[s] = groups[s] || []).push(f);
    });
    var known = Object.keys(groups).filter(function (k) { return k !== '未知段'; });
    if (groups['未知段'] && known.length === 1) { groups[known[0]] = groups[known[0]].concat(groups['未知段']); delete groups['未知段']; }
    if (skipped.length) report.push(['info', '有 ' + skipped.length + ' 個檔案用不到，已略過（例如 ' + skipped.slice(0, 3).map(fileName).join('、') + '）']);
    var points = [], links = [], used = [], secData = {};
    Object.keys(groups).sort().forEach(function (sec) {
      var byExt = {};
      groups[sec].forEach(function (f) { var e = extName(f.path); (byExt[e] = byExt[e] || []).push(f); });
      var secPts = {}, order = [], sd = secData[sec] = { d13: null, bnd: {}, refs: [], hasD14: !!byExt.D14 };
      var add = function (kind, name, y, x, src, extra) {
        var k = kind + '|' + name.toUpperCase(), old = secPts[k];
        if (old) {
          var d = hypot(old.y - y, old.x - x);
          if (d > 0.005) report.push(['warn', sec + ' ' + kind + '「' + name + '」在 ' + fileName(old.src) + ' 與 ' + fileName(src) + ' 的坐標不同（差 ' + (d * 100).toFixed(1) + ' cm），用 ' + fileName(old.src) + ' 的']);
          return;
        }
        var p = { section: sec, kind: kind, name: name, y: y, x: x, src: src };
        if (extra) Object.keys(extra).forEach(function (q) { p[q] = extra[q]; });
        secPts[k] = p; order.push(k);
      };
      sd.add = add;
      var dbf = function (f, need, label) {
        try { var db = parseDbf(f.bytes); } catch (e) { report.push(['error', f.path + ' 讀不出來：' + e.message]); return null; }
        if (db.fields.indexOf(need) < 0) { report.push(['error', f.path + ' 不是重測系統的 ' + label + '（欄位不對）']); return null; }
        return db;
      };
      (byExt.D20 || []).forEach(function (f) {
        var db = dbf(f, 'CTL_NAME', 'D20'); if (!db) return;
        db.records.forEach(function (r) { if (r.CTL_NAME && isNum(r.CTL_Y) && isNum(r.CTL_X)) add('補點', r.CTL_NAME, parseFloat(r.CTL_Y), parseFloat(r.CTL_X), f.path, { level: r.CTL_LEVEL || '' }); });
      });
      (byExt.D13 || []).forEach(function (f) { var db = dbf(f, 'COORD_1', 'D13'); if (db) sd.d13 = parseD13(db); });
      (byExt.D14 || []).forEach(function (f) {
        var db = dbf(f, 'COT_REF', 'D14'); if (!db) return;
        db.records.forEach(function (r) {
          if (!/^\d+$/.test(r.COT_NUMBER) || !isNum(r.COT_Y)) return;
          var ref = /^\d+$/.test(r.COT_REF) ? parseInt(r.COT_REF, 10) : 0, y = parseFloat(r.COT_Y), x = parseFloat(r.COT_X);
          if (!ref) sd.bnd[String(+r.COT_NUMBER)] = [y, x];
          else sd.refs.push({ num: String(+r.COT_NUMBER), name: refName(r.COT_NUMBER, ref), y: y, x: x, src: f.path, remark: r.COT_REMARK || '' });
        });
        if (!want) { sd.refs.forEach(function (q) { add('參考點', q.name, q.y, q.x, q.src, { remark: q.remark }); }); report.push(['info', sec + ' 的 D14 有 ' + db.records.length + ' 筆資料，其中參考點 ' + sd.refs.length + ' 點']); }
      });
      if (!byExt.D20) (byExt.L20 || []).forEach(function (f) { parseL(decode(f.bytes)).forEach(function (p) { add('補點', p.name, p.y, p.x, f.path); }); });
      if (!byExt.D14 && !want) (byExt.L14 || []).forEach(function (f) {
        parseL(decode(f.bytes)).forEach(function (p) { var m = /^(\d+)\.(\d+)$/.exec(p.name); if (m && parseInt(m[2], 10)) add('參考點', refName(m[1], m[2]), p.y, p.x, f.path); });
      });
      var secUsed = {}, usedOrder = [];
      var use = function (name, y, x, src, how) { var k = name.toUpperCase(); if (!secUsed[k]) { secUsed[k] = { section: sec, name: name, y: y, x: x, src: src, how: how }; usedOrder.push(k); } };
      (byExt.L02 || []).forEach(function (f) { parseL(decode(f.bytes)).forEach(function (p) { use(p.name, p.y, p.x, f.path, 'L02 控制點清單'); }); });
      var bfiles = [];
      Object.keys(byExt).forEach(function (e) { if (/^B9\d$/.test(e)) bfiles = bfiles.concat(byExt[e]); });
      (byExt.TXT || []).forEach(function (f) { if (looksLikeB90(decode(f.bytes))) bfiles.push(f); });
      bfiles.forEach(function (f) {
        var setups = parseB90(decode(f.bytes));
        setups.forEach(function (s) {
          var st = s.station, bk = s.back;
          s.targets.forEach(function (t) {
            if (isBoundaryName(t.name)) return;
            links.push({ section: sec, station: st.name, sy: st.y, sx: st.x, back: bk ? bk.name : '', by: bk ? bk.y : null, bx: bk ? bk.x : null,
              target: t.name, ty: t.y, tx: t.x, angle: t.angle || '', dist: t.dist == null ? null : t.dist, src: f.path });
          });
          [st, bk].forEach(function (p) { if (p && !isBoundaryName(p.name)) use(p.name, p.y, p.x, f.path, '協助指界 測站/標定點'); });
        });
        if (setups.length) report.push(['info', sec + '：' + fileName(f.path) + ' 有 ' + setups.length + ' 次設站']);
      });
      // 儀器檔：已知點 → 用到的圖根點；實測點 → 檢核點候選（數字點名是細部點，不當檢核點）
      sd.instr = [];
      (byExt.CSV || []).concat((byExt.TXT || []).filter(function (f) { return !looksLikeB90(decode(f.bytes)); })).forEach(function (f) {
        var g = parseGnssCsv(decode(f.bytes));
        g.known.forEach(function (p) { if (!isBoundaryName(p.name)) use(p.name, p.y, p.x, f.path, 'CSV 儀器檔'); });
        var named = g.measured.filter(function (p) { return !isBoundaryName(p.name); });
        if (g.measured.length) report.push(['info', sec + '：' + fileName(f.path) + ' 有實測點 ' + g.measured.length + ' 點' + (named.length ? '（有點名的 ' + named.length + ' 點會拿來當檢核點）' : '（都是細部點號）')]);
        sd.instr.push({ file: f.path, type: 'GNSS', known: g.known, measured: named });
      });
      (byExt.RAW || []).forEach(function (f) {
        var r = parseNikonRaw(decode(f.bytes), opts.raw);
        r.known.forEach(function (p) { if (!isBoundaryName(p.name)) use(p.name, p.y, p.x, f.path, 'Nikon RAW 已知點'); });
        r.backsights.forEach(function (b) {
          var d0 = (b.raw - b.coord) * 1000, d1 = (b.grid - b.coord) * 1000;
          report.push([Math.min(Math.abs(d0), Math.abs(d1)) > 20 ? 'warn' : 'info', sec + '：後視檢核 ' + b.station + '→' + b.back + '（' + b.coord.toFixed(1) + ' m）坐標反算跟觀測差：不改正 ' + d0.toFixed(1) + ' mm、改算到平面 ' + d1.toFixed(1) + ' mm']);
        });
        var named = r.shots.filter(function (p) { return !isBoundaryName(p.name); });
        sd.instr.push({ file: f.path, type: 'RAW', known: r.known, measured: named, backsights: r.backsights });
      });
      sd.finish = function () {
        usedOrder = usedOrder.filter(function (k) { return !secPts['補點|' + k]; });
        var pts = order.map(function (k) { return secPts[k]; });
        points = points.concat(pts);
        used = used.concat(usedOrder.map(function (k) { return secUsed[k]; }));
        var cnt = {}; pts.forEach(function (p) { cnt[p.kind] = (cnt[p.kind] || 0) + 1; });
        report.push(['ok', sec + '：' + (Object.keys(cnt).sort().map(function (k) { return k + ' ' + cnt[k] + ' 點'; }).join('、') || '沒有補點或參考點') + '，用到圖根點 ' + usedOrder.length + ' 點']);
      };
    });

    // 這次測量的地號：D13 找界址點、D14 取坐標、附近的參考點
    var parcels = [];
    if (want) {
      want.forEach(function (w) {
        var cands = Object.keys(secData).filter(function (s) { return (!w.section || s === w.section) && secData[s].d13 && secData[s].d13[w.key]; });
        var label = (w.section ? w.section + ' ' : '') + w.key + ' 地號';
        if (!cands.length) {
          var noD13 = Object.keys(secData).filter(function (s) { return !secData[s].d13; });
          report.push(['error', label + '：' + (noD13.length && noD13.length === Object.keys(secData).length ? '上傳的資料裡沒有 D13（地號的界址點表），請把整個資料夾放進來' : '在 D13 裡找不到這筆土地，請確認地號')]);
          parcels.push({ section: w.section, parcel: w.key, found: false });
          return;
        }
        if (cands.length > 1) { report.push(['error', label + '：好幾段都有這個地號（' + cands.join('、') + '），請寫成「段號 地號」，例如 ' + cands[0].slice(2) + ' ' + w.key]); parcels.push({ section: null, parcel: w.key, found: false }); return; }
        var sec = cands[0], sd = secData[sec], nums = sd.d13[w.key], ring = [], miss = 0;
        nums.forEach(function (n) { var c = sd.bnd[n]; if (c) ring.push([c[0], c[1], n]); else miss++; });
        if (!sd.hasD14) report.push(['error', label + '：沒有 D14（界址點坐標）']);
        else if (miss) report.push(['warn', label + '：有 ' + miss + ' 個界址點在 D14 裡找不到坐標']);
        parcels.push({ section: sec, parcel: w.key, found: ring.length >= 3, ring: ring, points: nums.length });
        if (ring.length >= 3) report.push(['ok', sec + ' ' + w.key + ' 地號：' + nums.length + ' 個界址點']);
      });
      // 參考點：點號跟這幾筆的界址點一樣，或在界址點 buf 公尺內
      Object.keys(secData).forEach(function (sec) {
        var sd = secData[sec], mine = parcels.filter(function (p) { return p.section === sec && p.found; });
        if (!mine.length) return;
        var numSet = {}, verts = [];
        mine.forEach(function (p) { p.ring.forEach(function (c) { numSet[c[2]] = 1; verts.push(c); }); });
        var n = 0;
        sd.refs.forEach(function (q) {
          var near = numSet[q.num] || verts.some(function (c) { return Math.abs(c[0] - q.y) < buf && Math.abs(c[1] - q.x) < buf && hypot(c[0] - q.y, c[1] - q.x) <= buf; });
          if (near) { n++; sd.add('參考點', q.name, q.y, q.x, q.src, { remark: q.remark }); }
        });
        report.push(['info', sec + '：這幾筆土地附近（' + buf + ' 公尺內）的參考點 ' + n + ' 點（D14 全部有 ' + sd.refs.length + ' 點參考點）']);
      });
    }
    Object.keys(secData).sort().forEach(function (s) { secData[s].finish(); });
    if (!Object.keys(groups).length) report.push(['error', '找不到重測系統的資料（需要 KCxxxx.D20、D14、D13、L02 或 B90 等檔案）']);
    var bnd = {}, instr = []; Object.keys(secData).forEach(function (k) { bnd[k] = secData[k].bnd; (secData[k].instr || []).forEach(function (x) { x.section = k; instr.push(x); }); });
    return { points: points, links: links, used: used, parcels: parcels, report: report, sections: Object.keys(groups).sort(), bnd: bnd, instr: instr };
  }

  /** 補點清冊：某位測量員全部上傳（不含已刪除）的補點；最大編號連已刪除的也算，號碼不會重複用 */
  function buildRegistry(batches, surveyor, code) {
    var re = new RegExp('^Q' + code + '(\\d+)$', 'i'), maxNum = 0, seen = {}, pts = [];
    batches.slice().sort(function (a, b) { return a.created - b.created; }).forEach(function (b) {
      if (b.surveyor !== surveyor) return;
      (b.points || []).forEach(function (p) {
        if (p.kind !== '補點') return;
        var m = re.exec(p.name); if (m) maxNum = Math.max(maxNum, +m[1]);
        if (b.deleted || seen[p.name.toUpperCase()]) return;
        seen[p.name.toUpperCase()] = 1;
        pts.push({ name: p.name, y: p.y, x: p.x, section: p.section, orig_name: p.orig_name || '', created: b.created, batch: b.id,
          caseType: b.caseType || (b.import ? '匯入既有清冊' : ''), parcels: (b.parcels || []).filter(function (q) { return q.found !== false; }).map(function (q) { return q.parcel; }).join('、') });
      });
      if (b.maxNum && b.code === code) maxNum = Math.max(maxNum, b.maxNum);
    });
    return { points: pts, maxNum: maxNum };
  }

  /**
   * 解析後的上傳資料 → 比對圖根點、67 段換 97、補點編號（比對清冊）、跟別人的補點比對。
   * ctx：{ ctlByName, trans, others, surveyor, code, registry:{points,maxNum}, tol(公尺), dupTol(公尺), secName }
   */
  function analyzeUpload(res, ctx) {
    var tol = ctx.tol || 0.02, dupTol = ctx.dupTol || 0.02, report = res.report.slice(), bad = 0, secName = ctx.secName || function (s) { return s; };
    var vote = {};   // 每段：用到的圖根點對到 97 還是 67 坐標 → 這次上傳的資料是哪個坐標系統
    res.used.forEach(function (u) {
      var best = null;
      (ctx.ctlByName[u.name.toUpperCase()] || []).forEach(function (p) {
        [[p.y, p.x, 'TWD97']].concat((p.raw || []).map(function (r) { return [r[0], r[1], 'TWD67']; })).forEach(function (c) { var d = hypot(c[0] - u.y, c[1] - u.x); if (!best || d < best[1]) best = [p, d, c[2]]; });
      });
      if (best && best[1] < 0.03) { var v = vote[u.section] = vote[u.section] || { TWD97: 0, TWD67: 0 }; v[best[2]]++; }
      if (best && best[1] > 5) {   // 同名但差好幾公尺以上：不是同一點（點名在別區重複用）
        u.ctl_id = null; u.delta = null; u.samename = Math.round(best[1]);
        if (!/^Q/i.test(u.name)) report.push(['info', u.section + ' 用到的「' + u.name + '」在圖根點檔裡只有同名的別的點（' + fmtDist(best[1]) + ' 外），當作圖根點檔裡沒有']);
      } else if (!best) {
        u.ctl_id = null; u.delta = null;
        if (!/^Q/i.test(u.name)) report.push(['info', u.section + ' 用到的「' + u.name + '」在圖根點檔（.CTL）裡找不到']);
      } else {
        u.ctl_id = best[0].id; u.delta = Math.round(best[1] * 10000) / 10000;
        if (best[1] > tol) { bad++; report.push(['warn', u.section + ' 用到的圖根點「' + u.name + '」跟圖根點檔差 ' + fmtDist(best[1]) + '（' + fileName(u.src) + '）']); }
      }
    });
    var conv = {};
    // 67 段的資料：用到的圖根點多數對到 97 坐標 → 測量員已經用 97 作業，不要再換一次（不然會差 800 多公尺）
    res.frames = {};
    Object.keys(ctx.trans).forEach(function (sec) {
      var v = vote[sec];
      if (!v || (!v.TWD97 && !v.TWD67)) { res.frames[sec] = 'TWD67?'; return; }
      res.frames[sec] = v.TWD97 > v.TWD67 ? 'TWD97' : 'TWD67';
      if (res.sections.indexOf(sec) >= 0) report.push(['info', sec + ' 上傳的資料是 ' + res.frames[sec] + '（用到的圖根點 ' + (v.TWD97 + v.TWD67) + ' 點，對到 97 坐標 ' + v.TWD97 + ' 點、67 坐標 ' + v.TWD67 + ' 點）' + (res.frames[sec] === 'TWD97' ? '，不用換算' : '')]);
    });
    var trans = {};
    Object.keys(ctx.trans).forEach(function (sec) { if (res.frames[sec] !== 'TWD97') trans[sec] = ctx.trans[sec]; });
    res.sections.forEach(function (sec) { if (ctx.trans[sec] && res.frames[sec] === 'TWD67?') report.push(['warn', sec + ' 是 TWD67 的段，但這次沒有用到圖根點可以確認資料的坐標系統，先當作 67 換算；如果測量員是用 97 作業，請告訴管理者']); });
    ctx = Object.assign({}, ctx, { trans: trans });
    var to97 = function (sec, y, x) { var T = ctx.trans[sec]; if (!T || coordStatus(y, x) !== 'ok') return [y, x]; var q = T.apply(y, x); return [r3(q[0]), r3(q[1])]; };
    res.points.concat(res.used).forEach(function (p) {
      if (!ctx.trans[p.section]) return;
      conv[p.section] = 1; p.orig = [p.y, p.x]; var q = to97(p.section, p.y, p.x); p.y = q[0]; p.x = q[1];
    });
    res.links.forEach(function (l) {
      if (!ctx.trans[l.section]) return;
      var q = to97(l.section, l.sy, l.sx); l.sy = q[0]; l.sx = q[1];
      q = to97(l.section, l.ty, l.tx); l.ty = q[0]; l.tx = q[1];
      if (l.by) { q = to97(l.section, l.by, l.bx); l.by = q[0]; l.bx = q[1]; }
    });
    (res.parcels || []).forEach(function (p) {
      if (!p.ring) return;
      if (ctx.trans[p.section]) { conv[p.section] = 1; p.ring = p.ring.map(function (c) { var q = to97(p.section, c[0], c[1]); return [q[0], q[1], c[2]]; }); }
    });
    var cs = Object.keys(conv).sort();
    if (cs.length) report.push(['info', cs.map(secName).join('、') + ' 是 TWD67 的段，坐標已換成 TWD97 顯示（' + ctx.trans[cs[0]].describe() + '）']);

    // 補點編號：Q + 補點代碼 + 流水號；坐標跟清冊裡的點一樣（dupTol 內）就用原本的名字，不重複加
    var nNew = 0, nOld = 0;
    if (ctx.code) {
      var reg = (ctx.registry && ctx.registry.points) || [], next = (ctx.registry && ctx.registry.maxNum) || 0, fresh = [], map = {}, keep = [];
      res.points.forEach(function (p) {
        if (p.kind !== '補點') { keep.push(p); return; }
        var orig = p.name, hit = null, hd = Infinity;
        reg.forEach(function (r) { var d = hypot(r.y - p.y, r.x - p.x); if (d <= dupTol && d < hd) { hit = r; hd = d; } });
        if (hit) {
          p.orig_name = orig; p.name = hit.name; p.reg = 'existing'; nOld++;
          var when = new Date(hit.created * 1000);
          report.push(['info', '補點 ' + orig + '：跟清冊裡的 ' + hit.name + ' 是同一點（差 ' + fmtDist(hd) + '，' + (when.getFullYear() - 1911) + '.' + (when.getMonth() + 1) + '.' + when.getDate() + ' 登錄），不重複加入']);
        } else {
          var dup = fresh.filter(function (f) { return hypot(f.y - p.y, f.x - p.x) <= dupTol; })[0];
          if (dup) { map[orig.toUpperCase()] = dup.name; report.push(['info', '補點 ' + orig + ' 跟這次的 ' + dup.orig_name + ' 同一點，合併成 ' + dup.name]); return; }
          next++; p.orig_name = orig; p.name = 'Q' + ctx.code + next; p.reg = 'new'; nNew++; fresh.push(p);
          report.push(['ok', '補點 ' + orig + ' → 新編 ' + p.name]);
        }
        map[orig.toUpperCase()] = p.name;
        if (keep.some(function (k) { return k.kind === '補點' && k.name === p.name; })) return;
        keep.push(p);
      });
      res.points = keep;
      res.maxNum = next;
      res.links.forEach(function (l) {
        ['station', 'back', 'target'].forEach(function (f) { var v = map[String(l[f]).toUpperCase()]; if (v) { l[f + '_orig'] = l[f]; l[f] = v; } });
      });
      res.used.forEach(function (u) { var v = map[u.name.toUpperCase()]; if (v) { u.orig_name = u.name; u.name = v; } });
    }
    res.points.forEach(function (p) {
      if (p.kind !== '補點') return;
      (ctx.others || []).forEach(function (o) {
        if (o.surveyor === ctx.surveyor) return;
        var d = hypot(o.y - p.y, o.x - p.x);
        if (d <= dupTol) report.push(['info', '補點 ' + p.name + ' 跟 ' + o.surveyor + ' 的補點 ' + o.name + ' 幾乎同一位置（' + fmtDist(d) + '），可能是同一點']);
      });
    });
    res.report = report;
    res.stats = { '補點': res.points.filter(function (p) { return p.kind === '補點'; }).length, '新補點': nNew, '既有補點': nOld,
      '參考點': res.points.filter(function (p) { return p.kind === '參考點'; }).length, '宗地': (res.parcels || []).filter(function (p) { return p.found; }).length,
      '圖根點': res.used.length, '圖根點不符': bad, '設站': res.links.length };
    return res;
  }

  // ───────────────────────── 儀器檔：衛星接收儀 CSV、Nikon RAW ─────────────────────────
  /**
   * 衛星接收儀 CSV：點名,N,E,高程,編碼
   *   高程 0、沒有編碼 → 上傳到接收儀的已知點；有高程或編碼 → 實測點（數字點名是細部點）
   */
  function parseGnssCsv(text) {
    var known = [], measured = [];
    lines(text).forEach(function (l, i) {
      var t = l.split(/[,\t]/).map(function (v) { return v.trim().replace(/^"|"$/g, ''); });
      if (t.length < 3 || !t[0] || !isNum(t[1]) || !isNum(t[2])) return;
      var y = +t[1], x = +t[2], h = isNum(t[3]) ? +t[3] : 0, code = t[4] || '';
      if (!y || !x) return;
      if (isX(t[1]) && isY(t[2])) { var a = y; y = x; x = a; }
      (h === 0 && !code ? known : measured).push({ name: t[0], y: y, x: x, h: h, code: code, line: i + 1 });
    });
    return { known: known, measured: measured };
  }
  function dmsDeg(sv) { var v = parseFloat(sv); if (!isFinite(v)) return null; var sg = v < 0 ? -1 : 1; v = Math.abs(v); var d = Math.floor(v), m = Math.floor((v - d) * 100 + 1e-9), sec = ((v - d) * 100 - m) * 100; return sg * (d + m / 60 + sec / 3600); }
  /** TM2（中央經線 121°、k0 0.9999）的尺度比 */
  function tm2Scale(E) { var R = 6371000; return 0.9999 * (1 + Math.pow(E - 250000, 2) / (2 * R * R)); }
  /**
   * Nikon RAW：UP 已知點、ST 測站（測站,,後視,,儀器高,後視方位角）、F1 後視觀測、SS 前視觀測（HA 以後視為 0、天頂角）。
   * 算出每個前視點坐標，並做後視檢核（觀測水平距 vs 坐標反算）。
   * opts.grid：true = 距離改算到 TM2 平面（× 尺度比 × R/(R+h)），opts.h：平均高程（公尺）
   */
  function parseNikonRaw(text, opts) {
    opts = opts || {};
    var R = 6371000, h = opts.h == null ? 50 : opts.h;
    var known = {}, knownList = [], shots = [], bs = [], st = null;
    var red = function (hd, E) { return opts.grid === false ? hd : hd * tm2Scale(E) * R / (R + h); };
    lines(text).forEach(function (l) {
      var f = l.split(',').map(function (v) { return v.trim(); }), ty = (f[0] || '').toUpperCase();
      if ((ty === 'UP' || ty === 'MP' || ty === 'CC') && f[1] && isNum(f[3]) && isNum(f[4])) { known[f[1]] = [+f[3], +f[4]]; knownList.push({ name: f[1], y: +f[3], x: +f[4] }); }
      else if (ty === 'ST') st = { s: f[1], b: f[3] || f[2], az: dmsDeg(f[6]), bh: dmsDeg(f[7]) || 0 };
      else if ((ty === 'F1' || ty === 'F2') && st && known[st.s] && known[st.b] && isNum(f[3])) {
        var S = known[st.s], B = known[st.b], va = dmsDeg(f[5]) * Math.PI / 180, hd0 = +f[3] * Math.sin(va);
        var dc = hypot(B[0] - S[0], B[1] - S[1]);
        bs.push({ station: st.s, back: st.b, coord: dc, raw: hd0, grid: hd0 * tm2Scale(S[1]) * R / (R + h) });
      } else if (ty === 'SS' && st && known[st.s] && isNum(f[3])) {
        var S2 = known[st.s], va2 = dmsDeg(f[5]) * Math.PI / 180, hd = red(+f[3] * Math.sin(va2), S2[1]);
        var az = st.az != null ? st.az : (known[st.b] ? Math.atan2(known[st.b][1] - S2[1], known[st.b][0] - S2[0]) * 180 / Math.PI : 0);
        var a = (az + dmsDeg(f[4]) - st.bh) * Math.PI / 180;
        var P = [S2[0] + hd * Math.cos(a), S2[1] + hd * Math.sin(a)];
        shots.push({ name: f[1], y: P[0], x: P[1], station: st.s, code: f[7] || '' });
        if (!known[f[1]]) known[f[1]] = P;   // 先測、後來當測站的點（例如 QT60-2）
      }
    });
    return { known: knownList, shots: shots, backsights: bs };
  }


  // ───────────────────────── 寫回重測系統（D14／D20） ─────────────────────────
  // 以下 toU8、parseDbfRaw、encodeField、appendDbf、d14Index、d20Index、nextFreeName、planDbfWrite、buildDbfFiles
  // 照搬自「土地重測資料轉換系統」，寫入規則跟它完全一樣：
  //   Q 開頭 → D20 補點；數字點號＋編碼 → D14 參考點；6 公分內的同點視為重測、預設不寫；原檔另存 .bak
  function pad2(n, w) { var t = String(n); while (t.length < w) t = '0' + t; return t; }
  function toU8(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    return new Uint8Array(b);
  }
  function bytesToStr(u8, a, n) {
    var s = '';
    for (var i = a; i < a + n; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function parseDbfRaw(bytes) {
    var u8 = toU8(bytes);
    if (u8.length < 33 || (u8[0] & 0x07) !== 3) throw new Error('不是 dBASE III 檔');
    var nrec = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
    var hlen = u8[8] | (u8[9] << 8), rlen = u8[10] | (u8[11] << 8);
    var fields = [], off = 32, pos = 1;
    while (off < hlen - 1 && u8[off] !== 0x0D) {
      var name = bytesToStr(u8, off, 11).replace(/\0.*$/, '');
      var f = { name: name, type: String.fromCharCode(u8[off + 11]), len: u8[off + 16], dec: u8[off + 17], pos: pos };
      fields.push(f); pos += f.len; off += 32;
    }
    var records = [];
    for (var i = 0; i < nrec; i++) {
      var base = hlen + i * rlen;
      if (base + rlen > u8.length) break;
      var rec = { deleted: u8[base] === 0x2A, values: {} };
      fields.forEach(function (fd) { rec.values[fd.name] = bytesToStr(u8, base + fd.pos, fd.len); });
      records.push(rec);
    }
    var dataEnd = hlen + nrec * rlen;
    return { u8: u8, nrec: nrec, hlen: hlen, rlen: rlen, fields: fields, records: records,
      hasEof: u8.length > dataEnd && u8[dataEnd] === 0x1A };
  }

  function encodeField(fd, v) {
    var s;
    if (fd.type === 'N' || fd.type === 'F') {
      if (v === '' || v == null) s = '';
      else s = typeof v === 'number' ? (fd.dec ? v.toFixed(fd.dec) : String(Math.round(v))) : String(v);
      if (s.length > fd.len) throw new Error('欄位 ' + fd.name + ' 放不下「' + s + '」（最多 ' + fd.len + ' 字）');
      while (s.length < fd.len) s = ' ' + s;
      return s;
    }
    if (fd.type === 'L') return v ? 'T' : 'F';
    s = String(v == null ? '' : v);
    if (s.length > fd.len) throw new Error('欄位 ' + fd.name + ' 放不下「' + s + '」（最多 ' + fd.len + ' 字）');
    while (s.length < fd.len) s += ' ';
    return s;
  }

  /** 在原檔後面加上新紀錄，回傳新檔的 Uint8Array（更新筆數與日期，其餘位元組原封不動） */
  function appendDbf(db, rows, now) {
    var d = now ? new Date(now) : new Date();
    var n = rows.length;
    var dataEnd = db.hlen + db.nrec * db.rlen;
    var out = new Uint8Array(dataEnd + n * db.rlen + (db.hasEof ? 1 : 0));
    out.set(db.u8.subarray(0, dataEnd), 0);
    out[1] = d.getFullYear() - 1900; out[2] = d.getMonth() + 1; out[3] = d.getDate();
    var total = db.nrec + n;
    out[4] = total & 255; out[5] = (total >> 8) & 255; out[6] = (total >> 16) & 255; out[7] = (total >> 24) & 255;
    // 沒指定的欄位沿用最後一筆的內容（例如 D20 的 \0 與 T），沒有舊紀錄時用空白
    var tmpl = db.nrec ? db.u8.subarray(dataEnd - db.rlen, dataEnd) : null;
    rows.forEach(function (row, i) {
      var base = dataEnd + i * db.rlen;
      if (tmpl) out.set(tmpl, base); else for (var k = 0; k < db.rlen; k++) out[base + k] = 0x20;
      out[base] = 0x20;
      db.fields.forEach(function (fd) {
        if (!tmpl && fd.type === 'L') out[base + fd.pos] = 0x54;
        if (!Object.prototype.hasOwnProperty.call(row, fd.name)) return;
        var str = encodeField(fd, row[fd.name]);
        for (var k = 0; k < fd.len; k++) out[base + fd.pos + k] = str.charCodeAt(k) & 255;
      });
    });
    if (db.hasEof) out[out.length - 1] = 0x1A;
    return out;
  }

  /**
   * D14 已有的參考點（編碼不是 00 的，X.XX）：點號 → 紀錄；以及參考點目前最大點號。
   * 編碼 00 的是計算求得的界址點（X.00），不算在內。
   */
  function d14Index(db) {
    var refByNum = {}, maxRef = 0, keys = {};
    (db ? db.records : []).forEach(function (r) {
      if (r.deleted) return;
      var num = parseInt(r.values.COT_NUMBER, 10), ref = parseInt(r.values.COT_REF, 10) || 0;
      if (!isFinite(num)) return;
      keys[num + '.' + ref] = 1;
      if (ref === 0) return;
      (refByNum[num] = refByNum[num] || []).push({ ref: ref, y: parseFloat(r.values.COT_Y), x: parseFloat(r.values.COT_X) });
      if (num > maxRef) maxRef = num;
    });
    return { refByNum: refByNum, maxRef: maxRef, keys: keys };
  }
  function d20Index(db) {
    var names = {};
    (db ? db.records : []).forEach(function (r) {
      if (!r.deleted) names[r.values.CTL_NAME.trim().toUpperCase()] = { y: parseFloat(r.values.CTL_Y), x: parseFloat(r.values.CTL_X) };
    });
    return names;
  }

  function nextFreeName(name, used) {
    var m = /^(.*?)(\d+)$/.exec(name);
    var cand, i;
    if (m) {
      for (i = parseInt(m[2], 10) + 1; ; i++) { cand = m[1] + i; if (!used[cand.toUpperCase()]) return cand; }
    }
    for (i = 1; ; i++) { cand = name + '-' + i; if (!used[cand.toUpperCase()]) return cand; }
  }

  var NEAR_M = 0.06; // 6 公分內視為同一點重測

  /**
   * 規劃要寫進 D14／D20 的點：
   *   點名 Q 開頭 → D20 補點；數字點號 → D14 參考點（點號＋編碼）；其他 → 不能寫入
   *   參考點點號已被用過（D14 任何 X.XX 參考點，或這批資料）→ 改成參考點最大號＋1
   *   同點號／同補點名稱且坐標相差 6 公分內 → 視為重測，預設不寫入並列出差值；
   *     使用者勾選寫入時，改成參考點（最大號＋1，編碼預設 11）寫進 D14
   * points：[{ key, name, code, y, x, src, line }]
   * edits：{ key: { num, ref, name, skip, write } }
   */
  function planDbfWrite(input) {
    var d14 = input.d14, d20 = input.d20, edits = input.edits || {};
    var badTo = String(input.badCodeTo || '11');
    var idx14 = d14Index(d14), idx20 = d20Index(d20);
    var usedNum = {}, used20 = {}, maxRef = idx14.maxRef;
    Object.keys(idx14.refByNum).forEach(function (n) { usedNum[n] = 1; });
    Object.keys(idx20).forEach(function (k) { used20[k] = 1; });
    var rows = [];
    var cm = function (d) { return d < 1 ? (d * 100).toFixed(1) + ' cm' : d < 1000 ? d.toFixed(1) + ' m' : (d / 1000).toFixed(1) + ' km'; };
    var nextNum = function () { maxRef += 1; while (usedNum[maxRef]) maxRef++; return maxRef; };
    var take = function (row, num, ref) {
      row.target = 'D14'; row.num = num; row.ref = ref;
      usedNum[num] = 1; if (num > maxRef) maxRef = num;
      row.out = num + '.' + pad2(ref, 2);
    };

    (input.points || []).forEach(function (p) {
      var e = edits[p.key] || {};
      var row = { key: p.key, origName: p.name, origCode: p.code == null ? '' : p.code, y: Number(p.y), x: Number(p.x), src: p.src, line: p.line, file: p.file,
        status: '', reason: '' };
      var name = String(p.name).trim();
      if (/^q/i.test(name)) row.target = 'D20';
      else if (/^\d+$/.test(name)) row.target = 'D14';
      else { row.target = null; row.status = 'skip'; row.reason = '點名不是數字也不是 Q 開頭，無法寫入'; rows.push(row); return; }
      if (e.skip) { row.status = 'excluded'; row.reason = '不寫入'; rows.push(row); return; }

      // 6 公分內的重測點
      var near = null;
      if (row.target === 'D20' && idx20[name.toUpperCase()]) {
        var q = idx20[name.toUpperCase()];
        near = { d: Math.hypot(q.y - row.y, q.x - row.x), what: 'D20 已有補點 ' + name };
      } else if (row.target === 'D14' && idx14.refByNum[parseInt(name, 10)]) {
        idx14.refByNum[parseInt(name, 10)].forEach(function (c) {
          var d = Math.hypot(c.y - row.y, c.x - row.x);
          if (!near || d < near.d) near = { d: d, what: 'D14 已有參考點 ' + parseInt(name, 10) + '.' + pad2(c.ref, 2) };
        });
      }
      if (near) row.dist = near.d;
      if (near && near.d <= NEAR_M) {
        row.near = true;
        if (!e.write) {
          row.status = 'near';
          row.reason = near.what + '，相差 ' + cm(near.d) + '（6 cm 內，視為同一點重測，預設不寫入；要寫入請打勾）';
          rows.push(row); return;
        }
        if (!d14) { row.status = 'noFile'; row.reason = '要寫成參考點，但沒有放入 .D14'; rows.push(row); return; }
        var wref = e.ref != null && e.ref !== '' ? parseInt(e.ref, 10) : (row.target === 'D14' && p.code ? parseInt(p.code, 10) : parseInt(badTo, 10));
        if (!(wref >= 1 && wref <= 99)) { row.target = 'D14'; row.status = 'needCode'; row.reason = '請填編碼（01～99）'; rows.push(row); return; }
        var wn = e.num != null && e.num !== '' ? parseInt(e.num, 10) : null;
        if (wn != null && usedNum[wn]) { row.target = 'D14'; row.num = wn; row.ref = wref; row.status = 'conflict'; row.reason = '你指定的點號 ' + wn + ' 已經有參考點了'; rows.push(row); return; }
        take(row, wn != null ? wn : nextNum(), wref);
        row.status = 'remeasure';
        row.reason = near.what + '（差 ' + cm(near.d) + '），依你的選擇寫成新的參考點 ' + row.out;
        rows.push(row); return;
      }

      if (row.target === 'D14' && !d14) { row.status = 'noFile'; row.reason = '沒有放入 .D14'; rows.push(row); return; }
      if (row.target === 'D20' && !d20) { row.status = 'noFile'; row.reason = '沒有放入 .D20'; rows.push(row); return; }

      if (row.target === 'D14') {
        var num = e.num != null && e.num !== '' ? parseInt(e.num, 10) : parseInt(name, 10);
        var refRaw = e.ref != null && e.ref !== '' ? e.ref : p.code;
        var ref = refRaw === '' || refRaw == null ? null : parseInt(refRaw, 10);
        row.num = num; row.ref = ref;
        if (ref === null || !isFinite(ref) || ref < 0 || ref > 99) { row.status = 'needCode'; row.reason = '缺編碼（00～99），請填'; rows.push(row); return; }
        if (!(num >= 1 && num <= 99999)) { row.status = 'conflict'; row.reason = '點號要是 1～99999'; rows.push(row); return; }
        if (usedNum[num]) {
          if (e.num != null && e.num !== '') { row.status = 'conflict'; row.reason = '你指定的點號 ' + num + ' 已經有參考點了'; rows.push(row); return; }
          var from = num;
          take(row, nextNum(), ref);
          row.status = 'renumbered';
          row.reason = (idx14.refByNum[from] ? 'D14 已有參考點 ' + from + '.xx' + (near ? '（相差 ' + cm(near.d) + '，不是同一點）' : '') : '這批資料裡重複 ' + from) +
            '，改成參考點最大號＋1：' + row.out;
        } else {
          take(row, num, ref);
          row.status = e.num != null && e.num !== '' ? 'edited' : 'new';
        }
      } else {
        var nm = e.name ? String(e.name).trim() : name;
        if (nm.length > 8) { row.status = 'conflict'; row.reason = '補點名稱最多 8 個字'; row.name = nm; rows.push(row); return; }
        if (used20[nm.toUpperCase()]) {
          if (e.name) { row.status = 'conflict'; row.reason = '你指定的 ' + nm + ' 已經有了'; row.name = nm; rows.push(row); return; }
          var nn2 = nextFreeName(nm, used20);
          if (nn2.length > 8) { row.status = 'conflict'; row.reason = nm + ' 已存在，自動改號後超過 8 個字，請手動指定'; row.name = nm; rows.push(row); return; }
          row.reason = (idx20[nm.toUpperCase()] ? 'D20 已有 ' + nm + (near ? '（相差 ' + cm(near.d) + '，不是同一點）' : '') : '這批資料裡重複 ' + nm) + '，自動改成 ' + nn2;
          row.status = 'renumbered'; nm = nn2;
        } else row.status = e.name ? 'edited' : 'new';
        used20[nm.toUpperCase()] = 1;
        row.name = nm; row.out = nm;
      }
      rows.push(row);
    });

    var ok = rows.filter(function (r) { return r.status === 'new' || r.status === 'renumbered' || r.status === 'edited' || r.status === 'remeasure'; });
    var blocking = rows.filter(function (r) { return r.status === 'needCode' || r.status === 'conflict'; });
    return {
      rows: rows,
      toD14: ok.filter(function (r) { return r.target === 'D14'; }),
      toD20: ok.filter(function (r) { return r.target === 'D20'; }),
      blocking: blocking,
      near: rows.filter(function (r) { return r.status === 'near'; }).length,
      renumbered: rows.filter(function (r) { return r.status === 'renumbered'; }).length
    };
  }

  /** 依規劃產生新的 D14／D20 位元組與對照表 */
  function buildDbfFiles(plan, d14, d20, now) {
    var out = {};
    if (d14 && plan.toD14.length) {
      out.d14 = appendDbf(d14, plan.toD14.map(function (r) {
        return { COT_NUMBER: r.num, COT_REF: r.ref, COT_Y: Number(r.y), COT_X: Number(r.x), COT_MATTER: 0, COT_SOURCE: 2,
          COT_SURVEY: 0, COT_MSE: 0, COT_REMARK: '', TAU_ID: '' };
      }), now);
    }
    if (d20 && plan.toD20.length) {
      out.d20 = appendDbf(d20, plan.toD20.map(function (r) {
        return { CTL_NAME: r.name, CTL_Y: Number(r.y), CTL_X: Number(r.x), CTL_LEVEL: 'Q' };
      }), now);
    }
    var STATUS = { new: '新增', renumbered: '自動改號', edited: '手動指定', needCode: '缺編碼', conflict: '衝突', skip: '無法寫入', excluded: '不寫入', noFile: '缺檔案',
      near: '重測（未寫入）', remeasure: '重測→新參考點' };
    var cell = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [['原點名', '原編碼', '寫入檔案', '寫入點號', 'Y', 'X', '與已有點相差(cm)', '來源', '狀態', '說明'].join(',')];
    plan.rows.forEach(function (r) {
      lines.push([r.origName, r.origCode, r.target && r.out ? '.' + r.target : '', r.out || '', Number(r.y).toFixed(3), Number(r.x).toFixed(3),
        r.dist != null ? (r.dist * 100).toFixed(1) : '', r.src, STATUS[r.status] || r.status, r.reason].map(cell).join(','));
    });
    out.table = '\uFEFF' + lines.join('\r\n');
    return out;
  }


  /**
   * 案件局部修正：這件案子附近重測到的舊 67 點（已知 67 ↔ 實測 97 反算回 67），
   * 1～2 點 → 只平移；3 點以上 → 四參數（平移、旋轉、尺度）。讓新測的點跟周圍舊 67 資料接得上。
   * pairs：[{ name, from:[y,x]（反算的 67）, to:[y,x]（已知 67） }]
   */
  function localFit(pairs) {
    var n = pairs.length;
    if (!n) return { type: 'none', n: 0, apply: function (y, x) { return [y, x]; }, residuals: [] };
    var my = 0, mx = 0, ty = 0, tx = 0;
    pairs.forEach(function (p) { my += p.from[0]; mx += p.from[1]; ty += p.to[0]; tx += p.to[1]; });
    my /= n; mx /= n; ty /= n; tx /= n;
    var a = 1, b = 0;
    if (n >= 3) {
      var sxx = 0, sab = 0, sba = 0;
      pairs.forEach(function (p) {
        var u = p.from[0] - my, v = p.from[1] - mx, U = p.to[0] - ty, V = p.to[1] - tx;
        sxx += u * u + v * v; sab += u * U + v * V; sba += u * V - v * U;
      });
      if (sxx > 0) { a = sab / sxx; b = sba / sxx; }
    }
    var f = function (y, x) { var u = y - my, v = x - mx; return [ty + a * u - b * v, tx + b * u + a * v]; };
    var res = pairs.map(function (p) { var q = f(p.from[0], p.from[1]); return { name: p.name, before: hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]), after: hypot(p.to[0] - q[0], p.to[1] - q[1]) }; });
    var rms = Math.sqrt(res.reduce(function (s2, r) { return s2 + r.after * r.after; }, 0) / n);
    return { type: n >= 3 ? 'helmert' : 'shift', n: n, apply: f, residuals: res, rms: rms, shift: [ty - my, tx - mx],
      scalePpm: (Math.sqrt(a * a + b * b) - 1) * 1e6, rotSec: Math.atan2(b, a) * 206264.8 };
  }

  /**
   * 回寫重測系統：97 外業成果 → 這段的坐標系統（67 段反算回 67）→ 案件局部修正 → 規劃寫進 D14／D20。
   * o：{ section, T（67 段的轉換，97 段給 null）, measured:[{name, code, y, x, src}]（97）, coa:{點號:[97Y,97X,67Y,67X]},
   *      ctlByName, d14, d20（parseDbfRaw 的結果）, registry:{points,maxNum}, svCode, dupTol, tol, warn, radius }
   */
  function planWriteBack(o) {
    var report = [], tol = o.tol || 0.06, warn = o.warn || 0.05, R = o.radius || 200, is67 = !!o.T;
    var toSys = function (y, x) { return is67 ? o.T.inverse(y, x) : [y, x]; };
    var newPts = [], checks = [], skipped = [];
    o.measured.forEach(function (m) {
      var nm = String(m.name).trim();
      // 重測到的舊點：數字點號對到這段界址點、或點名對到圖根點（實測 97 跟換算 97 差 0.5 m 內）
      if (/^\d+$/.test(nm) && o.coa[String(+nm)]) {
        var c = o.coa[String(+nm)];
        if (hypot(c[0] - m.y, c[1] - m.x) < 0.5) { checks.push({ name: nm, kind: '界址點', meas: [m.y, m.x], known: is67 ? [c[2], c[3]] : [c[0], c[1]], src: m.src }); return; }
      }
      if (!/^\d+$/.test(nm) && !/^Q/i.test(nm)) {
        var best = null;
        (o.ctlByName[nm.toUpperCase()] || []).forEach(function (c) { var d = hypot(c.y - m.y, c.x - m.x); if (!best || d < best.d) best = { c: c, d: d }; });
        if (best && best.d < 0.5) {
          var c2 = best.c, kn = is67 ? (c2.datum === 'TWD67' && c2.raw && c2.raw[0]) : [c2.y, c2.x];
          if (kn) { checks.push({ name: nm, kind: '圖根點', meas: [m.y, m.x], known: kn, src: m.src }); return; }
        }
        skipped.push(nm); return;
      }
      if (/^Q/i.test(nm)) { newPts.push({ kind: '補點', name: nm, code: '', y97: m.y, x97: m.x, src: m.src }); return; }
      newPts.push({ kind: '參考點', name: nm, code: m.code == null ? '' : String(m.code).trim(), y97: m.y, x97: m.x, src: m.src });
    });
    if (skipped.length) report.push(['info', '不寫入、也不是已知點：' + skipped.slice(0, 10).join('、') + (skipped.length > 10 ? '…' : '')]);
    // 補點：照補點清冊編號（97 坐標比，同一點不重複）
    var reg = (o.registry && o.registry.points) || [], next = (o.registry && o.registry.maxNum) || 0, assigned = [];
    newPts.filter(function (p) { return p.kind === '補點'; }).forEach(function (p) {
      p.orig_name = p.name;
      if (!o.svCode) return;
      var hit = null; reg.concat(assigned).forEach(function (r) { var d = hypot(r.y - p.y97, r.x - p.x97); if (d <= (o.dupTol || 0.02) && (!hit || d < hit.d)) hit = { r: r, d: d }; });
      if (hit) { p.name = hit.r.name; p.reg = 'existing'; }
      else { next++; p.name = 'Q' + o.svCode + next; p.reg = 'new'; assigned.push({ name: p.name, y: p.y97, x: p.x97 }); }
      report.push(['info', '補點 ' + p.orig_name + (p.reg === 'new' ? ' → 新編 ' : ' → 清冊已有 ') + p.name]);
    });
    // 換到這段的坐標系統
    newPts.forEach(function (p) { var q = toSys(p.y97, p.x97); p.y0 = q[0]; p.x0 = q[1]; });
    checks.forEach(function (c) { c.from = toSys(c.meas[0], c.meas[1]); });
    // 案件局部修正：用這件案子附近 R 公尺內重測到的舊點
    var cy = 0, cx = 0; newPts.forEach(function (p) { cy += p.y0; cx += p.x0; });
    if (newPts.length) { cy /= newPts.length; cx /= newPts.length; }
    var nearChk = checks.filter(function (c) { return !newPts.length || newPts.some(function (p) { return hypot(c.from[0] - p.y0, c.from[1] - p.x0) <= R; }); });
    var used = nearChk.slice(), fit = localFit(used.map(function (c) { return { name: c.name, from: c.from, to: c.known }; }));
    // 單點差太大（超過容許差）的不拿來修正（那是點本身的問題），剩 1 點以上就重算
    for (var it = 0; it < 5 && fit.n >= 3; it++) {
      var worst = fit.residuals.slice().sort(function (a, b) { return b.after - a.after; })[0];
      if (worst.after <= tol) break;
      used = used.filter(function (c) { return c.name !== worst.name; });
      fit = localFit(used.map(function (c) { return { name: c.name, from: c.from, to: c.known }; }));
    }
    checks.forEach(function (c) {
      c.before = hypot(c.known[0] - c.from[0], c.known[1] - c.from[1]);
      var q = fit.apply(c.from[0], c.from[1]); c.after = hypot(c.known[0] - q[0], c.known[1] - q[1]);
      c.used = used.indexOf(c) >= 0; c.near = nearChk.indexOf(c) >= 0;
      c.level = c.after > tol ? 'bad' : c.after > warn ? 'warn' : 'ok';
    });
    var lbl = is67 ? '67' : '97';
    if (!checks.length) report.push(['warn', '這次沒有重測到附近的舊點，沒辦法做案件局部修正；建議外業在宗地附近多測 3 點以上舊界址點或圖根點']);
    else if (fit.type === 'none') report.push(['warn', '重測到的舊點都離這次的新點超過 ' + R + ' 公尺，沒有做局部修正']);
    else report.push(['ok', '案件局部修正：用 ' + fit.n + ' 個重測舊點（' + (fit.type === 'helmert' ? '四參數' : '平移') + '），修正量 ' + fmtDist(hypot(fit.shift[0], fit.shift[1])) +
      (fit.type === 'helmert' ? '、尺度 ' + fit.scalePpm.toFixed(0) + ' ppm、旋轉 ' + fit.rotSec.toFixed(1) + '″' : '') + '，修正後殘差 RMS ' + fmtDist(fit.rms)]);
    checks.forEach(function (c) {
      if (c.level !== 'ok') report.push([c.level === 'bad' ? 'error' : 'warn', c.kind + ' ' + c.name + '：實測換回 ' + lbl + ' 跟已知差 ' + fmtDist(c.before) + '，修正後 ' + fmtDist(c.after) +
        (c.level === 'bad' ? '（超過容許差' + (c.used ? '' : '，沒拿來修正') + '）' : '（超過提醒門檻）')]);
    });
    if (fit.n < 3 && checks.length) report.push(['warn', '重測舊點少於 3 點，只做平移，沒辦法檢查旋轉、尺度']);
    newPts.forEach(function (p) { var q = fit.apply(p.y0, p.x0); p.y = r3(q[0]); p.x = r3(q[1]); });
    // 規劃寫入（規則同資料轉換系統）
    var plan = planDbfWrite({ d14: o.d14, d20: o.d20, points: newPts.map(function (p, i) { return { key: 'p' + i, name: p.name, code: p.code, y: p.y, x: p.x, src: fileName(p.src || '') }; }) });
    plan.rows.forEach(function (r, i) { r.kind = newPts[i].kind; r.y97 = newPts[i].y97; r.x97 = newPts[i].x97; r.orig_name = newPts[i].orig_name || newPts[i].name; r.reg = newPts[i].reg; });
    return { report: report, plan: plan, checks: checks, fit: { type: fit.type, n: fit.n, rms: fit.rms, shift: fit.shift, scalePpm: fit.scalePpm, rotSec: fit.rotSec },
      newPts: newPts, maxNum: next, frame: lbl };
  }

  // ───────────────────────── 第二層：外業檢核點 ─────────────────────────
  /**
   * 實測檢核點（TWD97，點名,Y,X）對應到已知的 67 點：
   *   數字點號 → 這次上傳 D14 的界址點（這段的系統坐標）；其他點名 → 圖根點（CTL 整理結果）
   * 回傳 { checks:[{name, kind, section, n67, e67, conv:[y,x], meas:[y,x], dn, de, d}], unmatched:[名] }
   */
  function matchChecks(meas, ctx) {
    var checks = [], unmatched = [];
    meas.forEach(function (m) {
      var hit = null;
      if (/^\d+(\.0+)?$/.test(m.name)) {
        var num = String(parseInt(m.name, 10));
        (ctx.sections || []).some(function (sec) {
          var c = ctx.bnd && ctx.bnd[sec] && ctx.bnd[sec][num];
          if (!c) return false;
          var T = ctx.trans[sec], q = T && coordStatus(c[0], c[1]) === 'ok' ? T.apply(c[0], c[1]) : c;
          hit = { kind: '界址點', section: sec, n67: T ? c[0] : null, e67: T ? c[1] : null, conv: [r3(q[0]), r3(q[1])], datum: T ? 'TWD67' : 'TWD97' };
          return true;
        });
      } else {
        var best = null;
        (ctx.ctlByName[m.name.toUpperCase()] || []).forEach(function (c) {
          if (!c.ll) return;
          var d = hypot(c.y - m.y, c.x - m.x);
          if (!best || d < best.d) best = { c: c, d: d };
        });
        if (best) {
          var c = best.c, raw = c.datum === 'TWD67' && c.raw && c.raw.length ? c.raw[0] : null;
          hit = { kind: '圖根點', section: (c.sections || [])[0] || '', n67: raw ? raw[0] : null, e67: raw ? raw[1] : null, conv: [c.y, c.x], datum: c.datum, ctl_id: c.id };
        }
      }
      if (!hit) { unmatched.push(m.name); return; }
      hit.name = m.name; hit.meas = [m.y, m.x];
      hit.dn = Math.round((m.y - hit.conv[0]) * 10000) / 10000; hit.de = Math.round((m.x - hit.conv[1]) * 10000) / 10000;
      hit.d = hypot(hit.dn, hit.de);
      checks.push(hit);
    });
    return { checks: checks, unmatched: unmatched };
  }
  /**
   * 把檢核點分類（看附近 R 公尺內其他檢核點的差值）：
   *   ok     差在容許差內
   *   area   附近好幾點差的方向、大小都差不多 → 這一區轉換有偏差（可以加進內插修正）
   *   single 只有這一點跟旁邊不一樣 → 點本身的問題（房屋、圍牆細部、舊測量誤差），不改參數
   *   lone   差超過容許差，但附近檢核點不夠，還看不出是哪一種
   *   wrong  差超過 1 公尺，多半是點名對錯或不是同一點
   */
  function classifyChecks(checks, opts) {
    opts = opts || {};
    var tol = opts.tol || 0.03, R = opts.range || 150;
    checks.forEach(function (c) {
      if (c.d > 1) { c.cls = 'wrong'; return; }
      var nb = checks.filter(function (o) { return o !== c && o.d <= 1 && o.name !== c.name && hypot(o.meas[0] - c.meas[0], o.meas[1] - c.meas[1]) <= R; });
      c.neighbors = nb.length;
      if (nb.length >= 2) {
        var mn = nb.reduce(function (a, o) { return a + o.dn; }, 0) / nb.length, me = nb.reduce(function (a, o) { return a + o.de; }, 0) / nb.length;
        var off = hypot(c.dn - mn, c.de - me), mag = hypot(mn, me);
        c.area = [Math.round(mn * 10000) / 10000, Math.round(me * 10000) / 10000];
        if (c.d <= tol && mag <= tol) c.cls = 'ok';
        else if (mag > tol && off <= Math.max(tol, 0.5 * mag)) c.cls = 'area';
        else if (off > tol) c.cls = 'single';
        else c.cls = 'ok';
      } else c.cls = c.d <= tol ? 'ok' : 'lone';
    });
    return checks;
  }

  /** 補點：每人每個點名只留最新一筆；參考點：每人、每段、每個點名 */
  function latestPoints(batches, tol) {
    var best = {};
    batches.forEach(function (b) {
      (b.points || []).forEach(function (p) {
        var k = b.surveyor + '|' + (p.kind === '補點' ? '' : p.section) + '|' + p.kind + '|' + p.name.toUpperCase();
        if (!best[k] || best[k].created < b.created) best[k] = Object.assign({}, p, { surveyor: b.surveyor, created: b.created, batch_id: b.id });
      });
    });
    var pts = Object.keys(best).map(function (k) { return best[k]; }), byKey = {};
    pts.forEach(function (p) { p.ll = ll(p.y, p.x); var k = p.section + '|' + p.kind + '|' + p.name.toUpperCase(); (byKey[k] = byKey[k] || []).push(p); });
    Object.keys(byKey).forEach(function (k) {
      var g = byKey[k]; if (g.length < 2) return;
      g.forEach(function (p) {
        p.others = g.filter(function (o) { return o !== p; }).map(function (o) { return { surveyor: o.surveyor, y: o.y, x: o.x, d: Math.round(hypot(o.y - p.y, o.x - p.x) * 10000) / 10000 }; });
        p.conflict = p.others.some(function (o) { return o.d > tol; });
      });
    });
    return pts;
  }

  /** 每筆土地的案件時間軸：{ '段|地號': [{batch, created, surveyor, caseType, caseNo, note, ring(經緯度)}…]（舊到新） } */
  function parcelHistory(batches) {
    var h = {};
    batches.forEach(function (b) {
      (b.parcels || []).forEach(function (p) {
        if (!p.found || !p.ring) return;
        var k = p.section + '|' + p.parcel;
        (h[k] = h[k] || []).push({ batch: b.id, created: b.created, surveyor: b.surveyor, caseType: b.caseType || '', caseNo: b.caseNo || '', note: b.note || '',
          section: p.section, parcel: p.parcel, ring: p.ring.map(function (c) { return ll(c[0], c[1]); }).filter(Boolean), ring97: p.ring });
      });
    });
    Object.keys(h).forEach(function (k) { h[k].sort(function (a, b) { return a.created - b.created; }); });
    return h;
  }

  return {
    decode: decode, isNum: isNum, isY: isY, isX: isX, coordStatus: coordStatus, baseName: baseName, extName: extName, fileName: fileName,
    sectionOf: sectionOf, unzip: unzip, expandZips: expandZips, zipStore: zipStore, crc32: crc32,
    parseCoa: parseCoa, parseBnp: parseBnp, parsePar: parsePar, parseCtl: parseCtl, formatCtlLine: formatCtlLine, parcelKeyOf: parcelKeyOf, parcelLabel: parcelLabel,
    twd67to97: twd67to97, tm2ToLatLng: tm2ToLatLng, ll: ll, detectDatum: detectDatum, Transform: Transform, buildTransforms: buildTransforms,
    cleanControls: cleanControls, groupBaseFiles: groupBaseFiles, buildBase: buildBase, exportCtl: exportCtl, sectionNamesFromXlsx: sectionNamesFromXlsx,
    parseDbf: parseDbf, parseL: parseL, parseCsvPoints: parseCsvPoints, parseB90: parseB90, parseFieldFiles: parseFieldFiles,
    analyzeUpload: analyzeUpload, latestPoints: latestPoints, wanted: wanted, fmtDist: fmtDist,
    matchChecks: matchChecks, classifyChecks: classifyChecks, addSupplement: addSupplement,
    localFit: localFit, planWriteBack: planWriteBack, parseDbfRaw: parseDbfRaw, appendDbf: appendDbf, planDbfWrite: planDbfWrite, buildDbfFiles: buildDbfFiles,
    parseGnssCsv: parseGnssCsv, parseNikonRaw: parseNikonRaw, tm2Scale: tm2Scale,
    parseParamInp: parseParamInp, parseCtlFix: parseCtlFix, sectionNums: sectionNums, sectionFromName: sectionFromName, sectionsFromPath: sectionsFromPath, pickParamFiles: pickParamFiles, GpsTransform: GpsTransform, checkParams: checkParams,
    parseParcelList: parseParcelList, parseD13: parseD13, buildRegistry: buildRegistry, parcelHistory: parcelHistory,
    SHEET_67: SHEET_67, ABOLISHED: ABOLISHED
  };
});
