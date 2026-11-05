/*
 * 地籍共作平台（共用資料夾版）— 存取共用資料夾。
 * 不用伺服器：網頁直接讀寫 \\Kcland-nas\kc外網共用\二課 底下的「地籍共作平台資料」資料夾。
 *
 *   地籍共作平台資料\
 *     設定.json
 *     底圖\目前.json                → { version: 'v1730…' }
 *     底圖\v1730…\index.json、controls.json、ctl_issues.json、ctl_entries.json、parcels.json、sections\KCxxxx.json
 *     上傳\20261105-083012_王小明\結果.json、原始檔\…   （每次上傳一個資料夾，不會互相蓋掉）
 *     上傳\…\已刪除.json             （刪除只做記號，檔案還在，可以救回來）
 *
 * 對外提供 Local.api(path, body)，跟伺服器版的 /api/... 一樣，畫面程式不用改太多。
 */
(function (root) {
  'use strict';
  var Core = root.Core;
  var DATA = '地籍共作平台資料';
  var S = { root: null, data: null, cfg: null, index: null, version: null, controls: null, ctlByName: null, trans: {},
    issues: null, parcels: null, secCache: {}, batches: {}, names: {} };
  var DEFAULT_NAMES = root.DEFAULT_SECTION_NAMES || {};

  // ── IndexedDB：記住上次選的資料夾 ──
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('地籍共作平台', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function kv(key, val) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction('kv', val === undefined ? 'readonly' : 'readwrite'), st = tx.objectStore('kv');
        var r = val === undefined ? st.get(key) : st.put(val, key);
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
    }).catch(function () { return null; });
  }

  // ── 檔案工具 ──
  function dirOf(path, create) {
    var parts = path.split('/').filter(Boolean), p = Promise.resolve(S.data);
    parts.forEach(function (n) { p = p.then(function (d) { return d.getDirectoryHandle(n, { create: !!create }); }); });
    return p;
  }
  function split(path) { var i = path.lastIndexOf('/'); return i < 0 ? ['', path] : [path.slice(0, i), path.slice(i + 1)]; }
  function readBytes(path) {
    var s = split(path);
    return dirOf(s[0]).then(function (d) { return d.getFileHandle(s[1]); }).then(function (h) { return h.getFile(); })
      .then(function (f) { return f.arrayBuffer(); }).then(function (b) { return new Uint8Array(b); });
  }
  function readJson(path) { return readBytes(path).then(function (u8) { return JSON.parse(new TextDecoder('utf-8').decode(u8)); }); }
  function write(path, data) {
    var s = split(path);
    return dirOf(s[0], true).then(function (d) { return d.getFileHandle(s[1], { create: true }); }).then(function (h) {
      return h.createWritable().then(function (w) { return w.write(data).then(function () { return w.close(); }); });
    }).catch(function (e) { var e2 = new Error('寫入「' + path + '」失敗：' + e.message); e2.name = e.name; throw e2; });
  }
  function writeJson(path, obj) { return write(path, JSON.stringify(obj)); }
  function exists(path) {
    var s = split(path);
    return dirOf(s[0]).then(function (d) { return d.getFileHandle(s[1]); }).then(function () { return true; }, function () { return false; });
  }
  function listDirs(path) {
    return dirOf(path, true).then(function (d) {
      var out = [], it = d.values();
      function next() { return it.next().then(function (r) { if (r.done) return out; if (r.value.kind === 'directory') out.push(r.value.name); return next(); }); }
      return next();
    });
  }
  /** 讀一個資料夾裡全部檔案（遞迴）→ [{path, bytes}]，filter(path) 決定要不要讀內容 */
  function walk(dirHandle, prefix, filter) {
    var out = [], it = dirHandle.values();
    function next() {
      return it.next().then(function (r) {
        if (r.done) return out;
        var h = r.value, p = prefix + h.name;
        if (h.kind === 'directory') return walk(h, p + '/', filter).then(function (a) { out = out.concat(a); return next(); });
        if (filter && !filter(p)) return next();
        return h.getFile().then(function (f) { return f.arrayBuffer(); }).then(function (b) { out.push({ path: p, bytes: new Uint8Array(b) }); return next(); });
      });
    }
    return next();
  }
  function fileListToItems(list) {
    return Promise.all(Array.prototype.map.call(list, function (x) {
      var f = x.file || x;
      return f.arrayBuffer().then(function (b) { return { path: x.path || f.webkitRelativePath || f.name, bytes: new Uint8Array(b) }; });
    }));
  }
  function download(name, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── 連接共用資料夾 ──
  function useRoot(h) {
    // 選到的是「地籍共作平台資料」本身，或是它的上一層（二課）
    S.root = h;
    var p = h.name === DATA ? Promise.resolve(h) : h.getDirectoryHandle(DATA, { create: true });
    return p.then(function (d) { S.data = d; return kv('root', h); });
  }
  var Local = {
    /** 回傳 Promise<'ok'|'need-click'|'none'>：有記住的資料夾而且權限還在就直接連 */
    tryResume: function () {
      return kv('root').then(function (h) {
        if (!h) return 'none';
        Local.lastName = h.name;
        return h.queryPermission({ mode: 'readwrite' }).then(function (p) {
          if (p === 'granted') return useRoot(h).then(function () { return 'ok'; });
          return 'need-click';
        });
      });
    },
    /** 一定要在使用者按按鈕時呼叫 */
    connect: function (pickNew) {
      var go = function () { return window.showDirectoryPicker({ id: 'map-collab', mode: 'readwrite' }).then(useRoot); };
      if (pickNew) return go();
      return kv('root').then(function (h) {
        if (!h) return go();
        return h.requestPermission({ mode: 'readwrite' }).then(function (p) { return p === 'granted' ? useRoot(h) : go(); });
      });
    },
    folderName: function () { return S.root ? S.root.name + (S.root.name === DATA ? '' : '\\' + DATA) : ''; },
    api: function (path, body) { return route(path, body); },
    download: download,
    fileListToItems: fileListToItems
  };

  // ── 設定、底圖 ──
  function loadCfg() {
    return readJson('設定.json').catch(function () { return {}; }).then(function (c) {
      S.cfg = Object.assign({ tolerance_cm: 2.0, section_names: {}, twd67_sections: null, abolished_sections: Core.ABOLISHED.slice() }, c);
      S.names = Object.assign({}, DEFAULT_NAMES, S.cfg.section_names || {});
      return S.cfg;
    });
  }
  function saveCfg() { return writeJson('設定.json', S.cfg); }
  function loadBase() {
    return readJson('底圖/目前.json').then(function (cur) {
      if (S.version === cur.version && S.index) return S.index;
      S.version = cur.version; S.secCache = {}; S.parcels = null; S.issues = null;
      var v = '底圖/' + cur.version + '/';
      return Promise.all([readJson(v + 'index.json'), readJson(v + 'controls.json')]).then(function (a) {
        S.index = a[0]; S.controls = a[1]; S.ctlByName = {}; S.trans = {};
        S.controls.forEach(function (p) { var k = p.name.toUpperCase(); (S.ctlByName[k] = S.ctlByName[k] || []).push(p); });
        S.index.sections.forEach(function (s) { if (s.tparams) S.trans[s.section] = Core.Transform.from(s.tparams); });
        return S.index;
      });
    }, function () { S.index = null; S.controls = []; S.ctlByName = {}; S.trans = {}; return null; });
  }
  function vpath(f) { return '底圖/' + S.version + '/' + f; }
  function secName(s) { var n = S.names[s]; return n ? n + '(' + s + ')' : s; }

  /** 讀數值地籍圖（資料夾或 zip 的檔案）→ 建底圖 → 寫進共用資料夾 */
  function rebuildFrom(items, progress) {
    progress = progress || function () {};
    return Core.expandZips(items).then(function (files) {
      var found = Core.groupBaseFiles(files);
      if (!Object.keys(found).length) throw new Error('找不到 COA / BNP / PAR / CTL 檔（要選「數值」資料夾或它的 zip）');
      return loadCfg().then(function () {
        return Core.buildBase(found, { sec67: S.cfg.twd67_sections, abolished: S.cfg.abolished_sections, progress: progress });
      });
    }).then(function (r) {
      var ver = 'v' + Date.now(), v = '底圖/' + ver + '/';
      progress('寫進共用資料夾（' + Object.keys(r.sections).length + ' 段）…');
      var p = writeJson(v + 'index.json', r.index)
        .then(function () { return writeJson(v + 'controls.json', r.controls); })
        .then(function () { return writeJson(v + 'ctl_issues.json', r.issues); })
        .then(function () { return writeJson(v + 'ctl_entries.json', r.ctlEntries); })
        .then(function () { return writeJson(v + 'parcels.json', r.parcelIndex); });
      Object.keys(r.sections).forEach(function (s) { p = p.then(function () { return writeJson(v + 'sections/' + s + '.json', r.sections[s]); }); });
      return p.then(function () { return writeJson('底圖/目前.json', { version: ver, built: Date.now() }); })
        .then(function () { return cleanupVersions(ver); })
        .then(function () { S.version = null; return loadBase(); })
        .then(function () { progress('完成'); return r.index; });
    });
  }
  function cleanupVersions(keep) {
    return dirOf('底圖').then(function (d) {
      return listDirs('底圖').then(function (vs) {
        vs = vs.filter(function (v) { return /^v\d+$/.test(v) && v !== keep; }).sort();
        // 留前一版當備份，其他刪掉
        return Promise.all(vs.slice(0, -1).map(function (v) { return d.removeEntry(v, { recursive: true }).catch(function () {}); }));
      });
    });
  }
  /** 數值原始檔存在 底圖/數值原始檔/，改設定時可以直接重算 */
  function saveSource(items) {
    var p = Promise.resolve();
    items.filter(function (f) { return /\.(coa|bnp|par|ctl|zip)$/i.test(f.path); }).forEach(function (f) {
      var parts = f.path.split('/').filter(function (x) { return x && x !== '.' && x !== '..'; });
      p = p.then(function () { return write('底圖/數值原始檔/' + parts.join('/'), f.bytes); });
    });
    return p;
  }
  function rebuildFromSaved(progress) {
    return dirOf('底圖/數值原始檔').then(function (d) { return walk(d, '', function (p) { return /\.(coa|bnp|par|ctl|zip)$/i.test(p); }); },
      function () { throw new Error('共用資料夾裡沒有數值原始檔，請先用「更新數值地籍圖」上傳一次'); })
      .then(function (items) { return rebuildFrom(items, progress); });
  }

  // ── 上傳紀錄 ──
  function loadBatches() {
    return listDirs('上傳').then(function (names) {
      return Promise.all(names.map(function (n) {
        var b = S.batches[n];
        var p = b ? Promise.resolve(b) : readJson('上傳/' + n + '/結果.json').then(function (j) { j.id = n; S.batches[n] = j; return j; }, function () { return null; });
        return p.then(function (j) {
          if (!j) return null;
          return exists('上傳/' + n + '/已刪除.json').then(function (del) { j.deleted = del; return j; });
        });
      }));
    }).then(function (all) {
      return all.filter(function (b) { return b && !b.deleted; }).sort(function (a, b) { return b.created - a.created; });
    });
  }
  function tolM() { return (S.cfg.tolerance_cm || 2) / 100; }
  function fieldData() {
    return loadBatches().then(function (bs) {
      var pts = Core.latestPoints(bs, tolM()), used = {}, links = [];
      bs.slice().reverse().forEach(function (b) {
        (b.used || []).forEach(function (u) {
          var k = b.surveyor + '|' + u.name.toUpperCase() + '|' + u.y.toFixed(3) + '|' + u.x.toFixed(3);
          used[k] = Object.assign({}, u, { surveyor: b.surveyor, created: b.created, batch_id: b.id, ll: Core.ll(u.y, u.x) });
        });
        (b.links || []).forEach(function (l) {
          links.push(Object.assign({}, l, { surveyor: b.surveyor, created: b.created, batch_id: b.id, sll: Core.ll(l.sy, l.sx), tll: Core.ll(l.ty, l.tx), bll: l.by ? Core.ll(l.by, l.bx) : null }));
        });
      });
      return { points: pts, used: Object.keys(used).map(function (k) { return used[k]; }), links: links,
        batches: bs.map(function (b) { return { id: b.id, surveyor: b.surveyor, note: b.note, created: b.created, sections: b.sections.join(','), stats: b.stats }; }) };
    });
  }
  function stamp(d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function analyze(body) {
    return Core.expandZips(body.files).then(function (files) {
      var res = Core.parseFieldFiles(files);
      return loadBatches().then(function (bs) {
        var others = Core.latestPoints(bs, tolM()).filter(function (p) { return p.kind === '補點'; });
        Core.analyzeUpload(res, { ctlByName: S.ctlByName, trans: S.trans, others: others, surveyor: body.surveyor, tol: tolM(), secName: secName });
        res.expanded = files;
        return res;
      });
    });
  }
  function upload(body) {
    return analyze(body).then(function (res) {
      if (!res.points.length && !res.used.length && !res.links.length) { var e = new Error('這些檔案裡沒有可以用的資料'); throw e; }
      var created = Date.now() / 1000, safe = body.surveyor.replace(/[\\/:*?"<>|]/g, '_');
      var id = stamp(new Date()) + '_' + safe, dir = '上傳/' + id + '/';
      var keep = body.files.filter(function (f) { return Core.wanted(f.path); });
      var rec = { surveyor: body.surveyor, note: body.note || '', created: created, sections: res.sections, stats: res.stats, report: res.report,
        points: res.points, used: res.used, links: res.links, files: keep.map(function (f) { return f.path; }) };
      var p = Promise.resolve();
      keep.forEach(function (f) {
        var parts = f.path.split('/').filter(function (x) { return x && x !== '.' && x !== '..'; });
        p = p.then(function () { return write(dir + '原始檔/' + parts.join('/'), f.bytes); });
      });
      return p.then(function () { return writeJson(dir + '結果.json', rec); }).then(function () {
        rec.id = id; S.batches[id] = rec;
        return { batch: id, stats: res.stats, report: res.report };
      });
    });
  }
  function batchZip(id) {
    return dirOf('上傳/' + id + '/原始檔').then(function (d) { return walk(d, '', null); }).then(function (files) { return Core.zipStore(files); });
  }

  // ── 查詢 ──
  function parcelsIndex() {
    if (S.parcels) return Promise.resolve(S.parcels);
    return readJson(vpath('parcels.json')).then(function (p) { S.parcels = p; return p; });
  }
  function search(q) {
    q = q.trim(); var qu = q.toUpperCase(), out = [];
    if (!q) return Promise.resolve(out);
    var m = /^(?:(?:[A-Z]{2})?(\d{3,4})\s*[段\s,，]\s*)?0*(\d+)\s*(?:[-之]\s*0*(\d+))?\s*(?:地號)?$/.exec(qu);
    var p = m ? parcelsIndex().then(function (idx) {
      var key = Core.parcelLabel(m[2], m[3] || '0'), sec = m[1] ? ('0000' + m[1]).slice(-4) : null;
      idx.forEach(function (r) { if (r[1] === key && (!sec || r[0].slice(-4) === sec)) out.push({ type: '地號', label: secName(r[0]) + ' ' + r[1] + ' 地號', section: r[0], parcel: r[1], ll: [r[2], r[3]], area: r[4] }); });
    }) : Promise.resolve();
    return p.then(fieldData).then(function (fd) {
      fd.points.filter(function (r) { return r.name.toUpperCase().indexOf(qu) === 0; }).slice(0, 50).forEach(function (r) {
        out.push({ type: r.kind, label: r.name + '（' + r.surveyor + '，' + secName(r.section) + '）', ll: r.ll, name: r.name, section: r.section });
      });
      fd.batches.filter(function (b) { return b.surveyor.indexOf(q) >= 0; }).slice(0, 20).forEach(function (b) {
        var d = new Date(b.created * 1000);
        out.push({ type: '上傳', label: b.surveyor + ' 的上傳（' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2) + '，' + b.sections + '）', batch: b.id });
      });
      var n = 0;
      S.controls.some(function (c) {
        if (c.name.toUpperCase().indexOf(qu) !== 0) return false;
        out.push({ type: '圖根點', label: c.name + '（' + c.sections.slice(0, 3).join(',') + (c.sections.length > 3 ? '…' : '') + '）', ll: c.ll, name: c.name, id: c.id });
        return ++n >= 50;
      });
      return out.slice(0, 150);
    });
  }

  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  // ── 路由（跟伺服器版的 /api 一樣） ──
  function route(path, body) {
    var m;
    if (!S.data) return Promise.reject(new Error('還沒連接共用資料夾'));
    if (path === '/api/info') {
      return loadCfg().then(loadBase).then(function (idx) {
        if (!idx) { var e = new Error('還沒有底圖'); e.data = { nobase: true }; throw e; }
        return { datum: idx.datum, tolerance_cm: S.cfg.tolerance_cm, section_names: S.names, custom_names: S.cfg.section_names,
          abolished: S.cfg.abolished_sections, sections: idx.sections, ctl: idx.ctl, built: idx.built };
      });
    }
    if (path === '/api/controls') return Promise.resolve(S.controls);
    if (path === '/api/ctl_issues') return S.issues ? Promise.resolve(S.issues) : readJson(vpath('ctl_issues.json')).then(function (d) { S.issues = d; return d; });
    if ((m = /^\/api\/section\/([A-Z]{2}\d{4})$/i.exec(path))) return readJson(vpath('sections/' + m[1].toUpperCase() + '.json'));
    if (path === '/api/field') return fieldData();
    if ((m = /^\/api\/search\?q=(.*)$/.exec(path))) return search(decodeURIComponent(m[1]));
    if ((m = /^\/api\/batch\/([^/]+)$/.exec(path))) {
      var id = decodeURIComponent(m[1]);
      return readJson('上傳/' + id + '/結果.json');
    }
    if ((m = /^\/api\/batch\/([^/]+)\/delete$/.exec(path))) {
      return writeJson('上傳/' + decodeURIComponent(m[1]) + '/已刪除.json', { at: Date.now(), by: body && body.by || '' }).then(function () { return { ok: true }; });
    }
    if ((m = /^\/api\/batch\/([^/]+)\/download$/.exec(path))) {
      return batchZip(decodeURIComponent(m[1])).then(function (z) { download('上傳_' + decodeURIComponent(m[1]) + '.zip', z, 'application/zip'); return { ok: true }; });
    }
    if (path === '/api/preview') {
      return analyze(body).then(function (r) {
        return { report: r.report, stats: r.stats, sections: r.sections, points: r.points,
          used: r.used.filter(function (u) { return u.delta == null || u.delta > tolM(); }) };
      });
    }
    if (path === '/api/upload') return upload(body);
    if (path === '/api/config') {
      return loadCfg().then(function () {
        var rebuild = false;
        if (Array.isArray(body.abolished_sections)) { S.cfg.abolished_sections = body.abolished_sections; rebuild = true; }
        if ('twd67_sections' in body) { S.cfg.twd67_sections = body.twd67_sections; rebuild = true; }
        if ('tolerance_cm' in body) S.cfg.tolerance_cm = body.tolerance_cm;
        if (body.section_names) {
          var c = {};
          Object.keys(body.section_names).forEach(function (k) { if (body.section_names[k] && DEFAULT_NAMES[k] !== body.section_names[k]) c[k] = body.section_names[k]; });
          S.cfg.section_names = c;
        }
        return saveCfg().then(function () { S.names = Object.assign({}, DEFAULT_NAMES, S.cfg.section_names); return rebuild ? rebuildFromSaved(body.progress) : null; })
          .then(function () { return { ok: true }; });
      });
    }
    if (path === '/api/section_names/xlsx') {
      return Core.sectionNamesFromXlsx(body.bytes).then(function (names) {
        if (!Object.keys(names).length) throw new Error('這個 Excel 裡找不到「段代碼＋段名」');
        return loadCfg().then(function () { Object.assign(S.cfg.section_names, names); return saveCfg(); })
          .then(function () { S.names = Object.assign({}, DEFAULT_NAMES, S.cfg.section_names); return { ok: true, count: Object.keys(names).length }; });
      });
    }
    if (path === '/api/base/upload') {
      // body.items：[{path, bytes}]（數值資料夾或 zip）
      return saveSource(body.items).then(function () { return rebuildFrom(body.items, body.progress); }).then(function (idx) { return { ok: true, sections: idx.sections.length }; });
    }
    if (path === '/api/base/rebuild') return rebuildFromSaved(body && body.progress).then(function () { return { ok: true }; });
    if (path === '/api/export/ctl.zip') {
      return readJson(vpath('ctl_entries.json')).then(function (e) { download('圖根點_TWD97.zip', Core.exportCtl(e, S.controls), 'application/zip'); return { ok: true }; });
    }
    if (path === '/api/export/controls.csv') {
      var rows = ['點名,Y(縱),X(橫),出現在哪些段,出現次數,坐標系統,說明'];
      S.controls.forEach(function (p) { rows.push([p.id, p.y.toFixed(3), p.x.toFixed(3), p.sections.join(' '), p.count, p.datum || '', (p.notes || []).join('；')].map(csvCell).join(',')); });
      download('圖根點整理.csv', '\ufeff' + rows.join('\r\n'), 'text/csv');
      return Promise.resolve({ ok: true });
    }
    if (path === '/api/export/field.csv') {
      return fieldData().then(function (d) {
        var rows = ['種類,點名,Y(縱),X(橫),段,測量員,上傳時間,來源檔'];
        d.points.forEach(function (p) { rows.push([p.kind, p.name, p.y.toFixed(3), p.x.toFixed(3), secName(p.section), p.surveyor, new Date(p.created * 1000).toLocaleString(), Core.fileName(p.src)].map(csvCell).join(',')); });
        download('補點參考點.csv', '\ufeff' + rows.join('\r\n'), 'text/csv');
        return { ok: true };
      });
    }
    return Promise.reject(new Error('不認得的動作：' + path));
  }

  root.Local = Local;
})(typeof self !== 'undefined' ? self : this);
