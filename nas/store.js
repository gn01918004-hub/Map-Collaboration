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
      S.cfg = Object.assign({ tolerance_cm: 2.0, section_names: {}, twd67_sections: null, abolished_sections: Core.ABOLISHED.slice(),
        surveyors: [], case_types: ['保存登記', '鑑界', '分割'], dup_tol_cm: 2.0, ref_buffer_m: 50,
        param_exclude: {}, param_choice: {}, param_exclude_names: [], check_tol_cm: 3.0, check_range_m: 150,
        case_tol_cm: 6, case_warn_cm: 5, case_radius_m: 200 }, c);
      // 115.11.06 決定：HL129 不用、0360 用自己的 1140730（只套一次，之後管理頁可以改）
      if (!S.cfg.defaults_v2) {
        S.cfg.defaults_v2 = true;
        if (S.cfg.param_exclude_names.indexOf('HL129') < 0) S.cfg.param_exclude_names.push('HL129');
        if (!S.cfg.param_choice.KC0360) S.cfg.param_choice.KC0360 = 'KC0360.inp';
      }
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
        return loadGps().then(function (g) {
          return Core.buildBase(found, { sec67: S.cfg.twd67_sections, abolished: S.cfg.abolished_sections, gpsSets: g.sets, ctlFix: g.fixes, supp: g.supp,
            paramChoice: S.cfg.param_choice || {}, progress: progress });
        });
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
      Object.keys(r.coa || {}).forEach(function (s) { p = p.then(function () { return writeJson(v + 'coa/' + s + '.json', r.coa[s]); }); });
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
  /**
   * 各段轉換參數：底圖/轉換參數/ 底下
   *   KC0367.inp、KC0378_KC0379_KC0380.inp、KC0346_…_KC0353.inp（檔名就是給哪幾段用）
   *   圖根改算_*.txt（原有圖根改算：點名 改算前N E 改算後N E）
   * 設定.json 的 param_exclude {檔名: [不用的點]}、param_choice {段: 檔名}
   */
  function loadGps() {
    return dirOf('底圖/轉換參數').then(function (d) { return walk(d, '', function (p) { return /\.(inp|txt)$|檢核點\.json$/i.test(p); }); }, function () { return []; })
      .then(function (files) {
        var sets = [], fixes = [], supp = [], ex = (S.cfg && S.cfg.param_exclude) || {}, exAll = (S.cfg && S.cfg.param_exclude_names) || [];
        files.forEach(function (f) {
          if (/\.txt$/i.test(f.path)) { fixes = fixes.concat(Core.parseCtlFix(Core.decode(f.bytes))); return; }
          if (/檢核點\.json$/.test(f.path)) { try { supp = JSON.parse(Core.decode(f.bytes)); } catch (e) { supp = []; } return; }
          var pts = Core.parseParamInp(Core.decode(f.bytes)), secs = Core.sectionsFromPath(f.path), drop = ex[f.path] || [];
          pts.forEach(function (p) { if (drop.indexOf(p.name) >= 0 || exAll.indexOf(p.name) >= 0) p.wt = 0; });
          if (secs.length && pts.length) sets.push({ file: f.path, sections: secs, pts: pts });
        });
        return { sets: sets, fixes: fixes, supp: supp };
      });
  }
  /** 上傳轉換參數（zip、資料夾或 .inp）：每一組段挑正式計算成果存起來，原有圖根改算也存，再重新整理底圖 */
  function uploadParams(body) {
    return Core.expandZips(body.items).then(function (files) {
      var report = [], picks = Core.pickParamFiles(files);
      var fixFiles = files.filter(function (f) { return /改算.*\.txt$/i.test(Core.fileName(f.path)); });
      if (!picks.length && !fixFiles.length) throw new Error('沒找到 .inp 轉換參數檔（檔名或資料夾名要有段號，例如 367、「378、379、380」或「346-353」；格式：點名 權 N97 E97 N67 E67）');
      var p = Promise.resolve();
      picks.forEach(function (g) {
        var c = Core.checkParams(g.pts), label = g.sections.map(function (s) { return s.slice(2); }).join('、');
        report.push(['ok', label + '：用 ' + g.path.split('/').slice(-3).join('/') + '，' + c.n + ' 點，標準誤差 ' + (c.sigma0 * 100).toFixed(1) + ' 公分' +
          (c.suspects.length ? '，可疑點 ' + c.suspects.join('、') : '') + (c.isolated.length ? '，離其他點很遠 ' + c.isolated.map(function (x) { return x.name; }).join('、') : '')]);
        g.alternatives.forEach(function (a) {
          report.push(['info', '　另有 ' + a.path.split('/').slice(-2).join('/') + '（' + a.n + ' 點' + (a.added.length ? '，多 ' + a.added.join('、') : '') + (a.removed.length ? '，少 ' + a.removed.length + ' 點' : '') + '）沒用']);
        });
        p = p.then(function () { return write('底圖/轉換參數/' + g.sections.join('_') + '.inp', g.text); });
      });
      fixFiles.forEach(function (f, i) {
        var n = Core.parseCtlFix(Core.decode(f.bytes)).length;
        if (!n) return;
        report.push(['ok', '原有圖根改算 ' + n + ' 點（' + f.path.split('/').slice(-2).join('/') + '）']);
        var tag = Core.baseName(body.items[0] ? body.items[0].path : 'x').replace(/[^\w\u4e00-\u9fff-]/g, '') + '_' + i;
        p = p.then(function () { return write('底圖/轉換參數/圖根改算_' + tag + '.txt', Core.decode(f.bytes)); });
      });
      return p.then(function () { return rebuildFromSaved(body.progress); }).then(function () { return { ok: true, report: report }; });
    });
  }
  function rebuildFromSaved(progress) {
    return dirOf('底圖/數值原始檔').then(function (d) { return walk(d, '', function (p) { return /\.(coa|bnp|par|ctl|zip)$/i.test(p); }); },
      function () { throw new Error('共用資料夾裡沒有數值原始檔，請先用「更新數值地籍圖」上傳一次'); })
      .then(function (items) { return rebuildFrom(items, progress); });
  }

  // ── 上傳紀錄 ──
  function loadBatches(withDeleted) {
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
      return all.filter(function (b) { return b && (withDeleted || !b.deleted); }).sort(function (a, b) { return b.created - a.created; });
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
      return loadApproved().then(function (appr) {
      var chks = Core.classifyChecks(allChecks(bs), { tol: chkTol(), range: S.cfg.check_range_m || 150 });
      var ak = {}; appr.forEach(function (a) { ak[a.key] = 1; });
      chks.forEach(function (c) { c.ll = Core.ll(c.meas[0], c.meas[1]); c.approved = !!ak[c.key]; });
      return { points: pts, used: Object.keys(used).map(function (k) { return used[k]; }), links: links, history: Core.parcelHistory(bs),
        checks: chks, approved: appr, check_tol_cm: S.cfg.check_tol_cm || 3,
        backsights: [].concat.apply([], bs.map(function (b) { return (b.backsights || []).map(function (x) { return Object.assign({ surveyor: b.surveyor, created: b.created }, x); }); })),
        surveyors: S.cfg.surveyors, case_types: S.cfg.case_types,
        batches: bs.map(function (b) {
          return { id: b.id, surveyor: b.surveyor, note: b.note, created: b.created, sections: (b.sections || []).join(','), stats: b.stats,
            caseType: b.caseType || (b.import ? '匯入既有清冊' : ''), caseNo: b.caseNo || '',
            parcels: (b.parcels || []).filter(function (p) { return p.found; }).map(function (p) { return p.parcel; }) };
        }) };
      });
    });
  }
  function loadApproved() { return readJson('底圖/轉換參數/檢核點.json').catch(function () { return []; }); }
  /** 管理者確認：把檢核點加進內插（或拿掉），再重新整理底圖 */
  function setApproved(body) {
    return loadApproved().then(function (list) {
      if (body.add) {
        var have = {}; list.forEach(function (a) { have[a.key] = 1; });
        body.add.forEach(function (c) {
          if (have[c.key] || c.n67 == null) return;
          list.push({ key: c.key, name: c.name, section: c.section, kind: c.kind, n67: c.n67, e67: c.e67, n97: c.meas[0], e97: c.meas[1],
            surveyor: c.surveyor, batch: c.batch_id, approved_at: Date.now(), by: body.by || '' });
        });
      }
      if (body.remove) list = list.filter(function (a) { return body.remove.indexOf(a.key) < 0; });
      return writeJson('底圖/轉換參數/檢核點.json', list);
    }).then(function () { return rebuildFromSaved(body.progress); }).then(function () { return { ok: true }; });
  }
  function stamp(d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  // ── 外業包（97 CSV）：宗地界址點、附近圖根點、附近補點 ──
  function readCoa(sec) {
    return readJson(vpath('coa/' + sec + '.json')).catch(function () { throw new Error('底圖是舊版，請到 ⚙ 管理按一次「重新整理」再用'); });
  }
  function fieldKit(body) {
    var pl = Core.parseParcelList(body.parcelsText), R = +body.radius || 200;
    if (!pl.parcels.length) return Promise.reject(new Error('請填地號'));
    return parcelsIndex().then(function (idx) {
      var want = [];
      pl.parcels.forEach(function (w) {
        var hit = idx.filter(function (r) { return r[1] === w.key && (!w.section || r[0] === w.section); });
        var secs = hit.map(function (r) { return r[0]; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
        if (!secs.length) throw new Error(w.key + ' 地號找不到');
        if (secs.length > 1) throw new Error(w.key + ' 地號好幾段都有（' + secs.map(secName).join('、') + '），請寫成「段號 地號」，例如 ' + secs[0].slice(2) + ' ' + w.key);
        want.push({ section: secs[0], key: w.key });
      });
      var secs = want.map(function (w) { return w.section; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      return Promise.all(secs.map(function (sec) { return Promise.all([readJson(vpath('sections/' + sec + '.json')), readCoa(sec)]); })).then(function (arr) {
        var rows = [], seen = {}, pts = [];
        var add = function (name, y, x, kind) { var k = name.toUpperCase(); if (seen[k]) return; seen[k] = 1; rows.push({ name: name, y: y, x: x, kind: kind }); };
        secs.forEach(function (sec, i) {
          var parcels = arr[i][0].parcels, coa = arr[i][1];
          want.filter(function (w) { return w.section === sec; }).forEach(function (w) {
            var pc = parcels.filter(function (p) { return p.k === w.key; })[0];
            if (!pc || !pc.n) throw new Error('底圖是舊版，請到 ⚙ 管理按一次「重新整理」再用');
            pc.n.forEach(function (id) { var c = coa[id]; if (c) { pts.push([c[0], c[1]]); add(id, c[0], c[1], '界址點'); } });
          });
        });
        var near = function (y, x) { return pts.some(function (q) { return Math.hypot(q[0] - y, q[1] - x) <= R; }); };
        var head = [];
        S.controls.forEach(function (c) { if (c.status === 'ok' && c.datum !== '?' && near(c.y, c.x)) head.push({ name: c.name, y: c.y, x: c.x, kind: '圖根點' }); });
        return fieldData().then(function (fd) {
          fd.points.filter(function (p) { return p.kind === '補點' && near(p.y, p.x); }).forEach(function (p) { head.push({ name: p.name, y: p.y, x: p.x, kind: '補點' }); });
          var all = head.concat(rows), out = [], seen2 = {};
          all.forEach(function (r) { var k = r.name.toUpperCase(); if (seen2[k]) return; seen2[k] = 1; out.push(r.name + ',' + r.y.toFixed(3) + ',' + r.x.toFixed(3) + ',0.000,'); });
          var fn = '外業包_' + secs.map(function (x) { return x.slice(2); }).join('_') + '_' + want.map(function (w) { return w.key; }).slice(0, 5).join('_') + '.csv';
          download(fn, out.join('\r\n') + '\r\n', 'text/csv');
          var cnt = {}; all.forEach(function (r) { cnt[r.kind] = (cnt[r.kind] || 0) + 1; });
          return { ok: true, file: fn, counts: cnt };
        });
      });
    });
  }

  // ── 回寫重測系統：97 外業成果 → 這段坐標（67 段反算）→ 案件局部修正 → D14／D20 ──
  var WB = {};   // 預覽時的狀態（寫入時要確認檔案沒被別人改過）
  function readSysFolder(dir) {
    var files = {}, it = dir.values();
    function next() {
      return it.next().then(function (r) {
        if (r.done) return files;
        var h = r.value, e = Core.extName(h.name);
        if (h.kind === 'file' && (e === 'D14' || e === 'D20') && Core.baseName(h.name).toUpperCase() !== 'KC0000') {
          return h.getFile().then(function (f) { return f.arrayBuffer(); }).then(function (b) { (files[e] = files[e] || []).push({ name: h.name, handle: h, bytes: new Uint8Array(b) }); return next(); });
        }
        return next();
      });
    }
    return next();
  }
  function writeBackPreview(body) {
    var sv = surveyorOf(body.surveyor);
    if (!sv) return Promise.reject(new Error('請先選測量員'));
    if (!body.dir) return Promise.reject(new Error('請先選重測系統的資料夾（裡面要有 KCxxxx.D14、D20）'));
    return readSysFolder(body.dir).then(function (sys) {
      var d14f = (sys.D14 || [])[0], d20f = (sys.D20 || [])[0];
      if (!d14f && !d20f) throw new Error('這個資料夾裡找不到 D14 或 D20，請選某一段的資料夾（例如 KC0370）');
      var sec = Core.sectionOf((d14f || d20f).name);
      var info = (S.index.sections || []).filter(function (x) { return x.section === sec; })[0];
      if (!info) throw new Error('底圖裡沒有 ' + sec);
      var T = info.datum === 'TWD67' ? S.trans[sec] : null;
      return Promise.all([Core.expandZips(body.items), readCoa(sec), loadBatches(true)]).then(function (a) {
        var files = a[0], coa = a[1], all = a[2], meas = [], report = [];
        files.forEach(function (f) {
          var e = Core.extName(f.path), known = [], m = [];
          if (e === 'RAW') { var r = Core.parseNikonRaw(Core.decode(f.bytes), { h: 50 }); known = r.known; m = r.shots; }
          else if (e === 'CSV' || e === 'TXT') { var g = Core.parseGnssCsv(Core.decode(f.bytes)); known = g.known; m = g.measured; }
          else return;
          var fr = frameOf({ known: known, measured: m.filter(function (p) { return !/^\d+$/.test(p.name); }), section: sec }, {});
          if (fr === 'unknown' && T) {   // 再用這段的界址點號比：對到 97 還是 67 坐標
            var v7 = 0, v9 = 0;
            known.concat(m).forEach(function (p) { var c = /^\d+$/.test(p.name) && coa[String(+p.name)]; if (!c) return; if (Math.hypot(c[0] - p.y, c[1] - p.x) < 1) v9++; if (Math.hypot(c[2] - p.y, c[3] - p.x) < 1) v7++; });
            if (v7 > v9) fr = 'TWD67'; else if (v9) fr = 'TWD97';
          }
          if (fr === 'unknown' && T) report.push(['warn', Core.fileName(f.path) + '：看不出是 67 還是 97，先當作 97；如果是 67 坐標的檔案，結果會差 800 多公尺，請確認']);
          if (fr === 'TWD67') { report.push(['error', Core.fileName(f.path) + ' 是 67 坐標的檔案；回寫要用 97 的外業成果']); return; }
          m.forEach(function (p) { meas.push({ name: p.name, code: p.code, y: p.y, x: p.x, src: f.path }); });
          report.push(['info', Core.fileName(f.path) + '：實測 ' + m.length + ' 點']);
        });
        if (!meas.length) throw new Error('沒有讀到 97 的實測點（衛星接收儀 CSV 或 Nikon RAW）');
        var res = Core.planWriteBack({ section: sec, T: T, measured: meas, coa: coa, ctlByName: S.ctlByName,
          d14: d14f ? Core.parseDbfRaw(d14f.bytes) : null, d20: d20f ? Core.parseDbfRaw(d20f.bytes) : null,
          registry: Core.buildRegistry(all, sv.name, sv.code), svCode: sv.code, dupTol: (S.cfg.dup_tol_cm || 2) / 100,
          tol: (S.cfg.case_tol_cm || 6) / 100, warn: (S.cfg.case_warn_cm || 5) / 100, radius: +body.radius || S.cfg.case_radius_m || 200 });
        res.report = report.concat(res.report);
        if (T) res.report.unshift(['info', secName(sec) + ' 是 67 段：97 成果用同一組參數反算回 67（' + T.describe() + '）']);
        res.section = sec; res.datum = info.datum; res.files = { d14: d14f && d14f.name, d20: d20f && d20f.name };
        WB = { sv: sv, sec: sec, res: res, d14f: d14f, d20f: d20f, items: body.items, dir: body.dir };
        return { section: sec, datum: info.datum, report: res.report, checks: res.checks, fit: res.fit, frame: res.frame,
          rows: res.plan.rows.map(function (r) { return { kind: r.kind, orig: r.orig_name, out: r.out, target: r.target, y: r.y, x: r.x, y97: r.y97, x97: r.x97, status: r.status, reason: r.reason, reg: r.reg }; }),
          toD14: res.plan.toD14.length, toD20: res.plan.toD20.length, blocking: res.plan.blocking.length + res.report.filter(function (x) { return x[0] === 'error'; }).length };
      });
    });
  }
  function writeBackCommit(body) {
    if (!WB.res) return Promise.reject(new Error('請先按「檢查」'));
    var res = WB.res, built = Core.buildDbfFiles(res.plan, WB.d14f ? Core.parseDbfRaw(WB.d14f.bytes) : null, WB.d20f ? Core.parseDbfRaw(WB.d20f.bytes) : null);
    var jobs = [];
    if (built.d14) jobs.push({ f: WB.d14f, data: built.d14 });
    if (built.d20) jobs.push({ f: WB.d20f, data: built.d20 });
    if (!jobs.length) return Promise.reject(new Error('沒有要寫入的點'));
    var st = stamp(new Date());
    // 確認檔案沒被改過 → 原檔備份成 .bak → 寫入
    return jobs.reduce(function (p, j) {
      return p.then(function () { return j.f.handle.getFile(); }).then(function (f) { return f.arrayBuffer(); }).then(function (b) {
        var cur = new Uint8Array(b);
        if (cur.length !== j.f.bytes.length || cur.some(function (v, i) { return v !== j.f.bytes[i]; })) throw new Error(j.f.name + ' 在檢查之後被改過了，請重新按「檢查」');
        return WB.dir.getFileHandle(j.f.name + '.' + st + '.bak', { create: true });
      }).then(function (bh) { return bh.createWritable().then(function (w) { return w.write(j.f.bytes).then(function () { return w.close(); }); }); })
        .then(function () { return j.f.handle.createWritable(); }).then(function (w) { return w.write(j.data).then(function () { return w.close(); }); });
    }, Promise.resolve()).then(function () {
      // 平台留紀錄：補點進清冊（97 坐標）、參考點、檢核結果、用的參數版本
      var created = Date.now() / 1000, id = st + '_' + WB.sv.name.replace(/[\\/:*?"<>|]/g, '_') + '_回寫';
      var written = res.plan.toD14.concat(res.plan.toD20);
      var rec = { version: 2, writeback: true, surveyor: WB.sv.name, code: WB.sv.code, caseType: '回寫重測系統', caseNo: body.caseNo || '', note: body.note || '',
        created: created, sections: [WB.sec], maxNum: res.maxNum, parcels: [], used: [], links: [],
        points: written.map(function (r) { return { section: WB.sec, kind: r.kind, name: r.target === 'D20' ? r.out : r.out, y: r.y97, x: r.x97, sys: [r.y, r.x], src: r.src, reg: r.reg, orig_name: r.orig_name }; }),
        stats: { '補點': res.plan.toD20.length, '新補點': res.plan.toD20.filter(function (r) { return r.reg === 'new'; }).length, '參考點': res.plan.toD14.length, '重測舊點': res.checks.length },
        report: res.report, fit: res.fit, checks: [], wbChecks: res.checks.map(function (c) { return { name: c.name, kind: c.kind, before: c.before, after: c.after, used: c.used }; }),
        paramVersion: S.version, transform: res.datum === 'TWD67' ? (S.index.sections.filter(function (x) { return x.section === WB.sec; })[0] || {}).transform : '', files: [] };
      var p = writeJson('上傳/' + id + '/結果.json', rec);
      p = p.then(function () { return write('上傳/' + id + '/寫入對照表.csv', built.table); });
      (WB.items || []).forEach(function (f) { p = p.then(function () { return write('上傳/' + id + '/原始檔/' + f.path.split('/').filter(Boolean).join('/'), f.bytes); }); });
      return p.then(function () {
        rec.id = id; S.batches[id] = rec; var out = { ok: true, d14: built.d14 ? res.plan.toD14.length : 0, d20: built.d20 ? res.plan.toD20.length : 0, backup: st };
        download('寫入對照表_' + WB.sec + '_' + st + '.csv', built.table, 'text/csv');
        WB = {}; return out;
      });
    });
  }
  function surveyorOf(name) { return (S.cfg.surveyors || []).filter(function (x) { return x.name === name; })[0]; }
  function registryOf(name) {
    var sv = surveyorOf(name);
    return loadBatches(true).then(function (bs) { return Core.buildRegistry(bs, name, sv ? sv.code : ''); });
  }
  var CLS = { ok: '在容許差內', area: '附近好幾點都差不多 → 這一區轉換有偏差', single: '只有這點跟旁邊不同 → 點本身的細部差', lone: '附近檢核點不夠，還看不出是哪一種', wrong: '差超過 1 公尺，可能點名對錯' };
  /** 儀器檔是 67 還是 97：已知點跟圖根點（換算後 97／原始 67）對，對不到就看段 */
  function frameOf(ins, bnd) {
    var v97 = 0, v67 = 0;
    var vote = function (k, tol) {
      (S.ctlByName[k.name.toUpperCase()] || []).forEach(function (c) {
        if (Math.hypot(c.y - k.y, c.x - k.x) < tol) v97++;
        (c.raw || []).forEach(function (r) { if (Math.hypot(r[0] - k.y, r[1] - k.x) < tol) v67++; });
      });
    };
    ins.known.forEach(function (k) { vote(k, 0.02); });
    ins.measured.forEach(function (k) { vote(k, 0.5); });   // 實測的圖根點：差幾公分，用 0.5 公尺判斷
    if (v97 || v67) return v97 >= v67 ? 'TWD97' : 'TWD67';
    // 對不到圖根點（例如都是補點）：看離這次上傳的 D14 界址點（這段系統的坐標）近不近
    var b = bnd && bnd[ins.section], near = Infinity;
    if (b) ins.known.concat(ins.measured).slice(0, 50).forEach(function (k) {
      Object.keys(b).forEach(function (n) { var c = b[n]; var d = Math.hypot(c[0] - k.y, c[1] - k.x); if (d < near) near = d; });
    });
    if (near < 300) {
      var sec = (S.index.sections || []).filter(function (x) { return x.section === ins.section; })[0];
      return sec && sec.datum === 'TWD67' ? 'TWD67' : 'TWD97';
    }
    return 'unknown';
  }
  function chkTol() { return (S.cfg.check_tol_cm || 3) / 100; }
  /** 全部上傳裡的檢核點；有 67 坐標的用「現在的參數」重算換算值（確認過的修正會讓差變小） */
  function allChecks(bs) {
    var out = [];
    bs.forEach(function (b) {
      (b.checks || []).forEach(function (c) {
        var o = Object.assign({}, c, { surveyor: b.surveyor, created: b.created, batch_id: b.id, key: b.id + '|' + c.name });
        o.d0 = c.d;
        var conv = null;
        if (c.kind === '圖根點') {   // 圖根點：用現在底圖裡重新換算過的坐標
          var cur = (S.ctlByName[c.name.toUpperCase()] || []).filter(function (x) { return x.id === c.ctl_id; })[0];
          if (cur) conv = [cur.y, cur.x];
        } else if (c.n67 != null && S.trans[c.section]) {
          var q = S.trans[c.section].apply(c.n67, c.e67); conv = [Math.round(q[0] * 1000) / 1000, Math.round(q[1] * 1000) / 1000];
        }
        if (conv) { o.conv = conv; o.dn = c.meas[0] - conv[0]; o.de = c.meas[1] - conv[1]; o.d = Math.hypot(o.dn, o.de); }
        out.push(o);
      });
    });
    return out;
  }
  function analyze(body) {
    var sv = surveyorOf(body.surveyor);
    if (!sv) return Promise.reject(new Error('請先選測量員（測量員要先在 ⚙ 管理 新增）'));
    var pl = Core.parseParcelList(body.parcelsText);
    return Core.expandZips(body.files).then(function (files) {
      var res = Core.parseFieldFiles(files, { parcels: pl.parcels, refBuffer: S.cfg.ref_buffer_m || 50 });
      if (pl.bad.length) res.report.push(['error', '看不懂的地號：' + pl.bad.join('、')]);
      if (!pl.parcels.length) res.report.push(['error', '請填這次測量的地號']);
      return loadBatches(true).then(function (all) {
        var live = all.filter(function (b) { return !b.deleted; });
        var others = Core.latestPoints(live, tolM()).filter(function (p) { return p.kind === '補點'; });
        Core.analyzeUpload(res, { ctlByName: S.ctlByName, trans: S.trans, others: others, surveyor: sv.name, code: sv.code,
          registry: Core.buildRegistry(all, sv.name, sv.code), tol: tolM(), dupTol: (S.cfg.dup_tol_cm || 2) / 100, secName: secName });
        res.blocking = res.report.filter(function (r) { return r[0] === 'error'; }).length + (pl.parcels.length ? 0 : 1);
        if (!body.caseType) { res.report.unshift(['error', '請選案件種類']); res.blocking++; }
        res.code = sv.code;
        // 實測檢核點：選填的檢核點檔＋儀器檔裡有點名的實測點（97 坐標的才拿來檢核轉換）
        var meas = [], src67 = [];
        (body.checkFiles || []).forEach(function (f) { Core.parseCsvPoints(Core.decode(f.bytes)).forEach(function (p) { p.src = f.path; meas.push(p); }); });
        res.backsights = [];
        (res.instr || []).forEach(function (ins) {
          var fr = frameOf(ins, res.bnd);
          ins.frame = fr;
          (ins.backsights || []).forEach(function (b) { res.backsights.push({ section: ins.section, station: b.station, back: b.back, coord: b.coord, raw: b.raw, grid: b.grid, frame: fr, file: Core.fileName(ins.file) }); });
          if (fr === 'TWD97') ins.measured.forEach(function (p) { meas.push({ name: p.name, y: p.y, x: p.x, src: ins.file }); });
          else if (fr === 'TWD67') src67.push(ins);
          else if (ins.measured.length) res.report.push(['warn', Core.fileName(ins.file) + '：看不出是 67 還是 97 坐標（已知點對不到圖根點、也不在這次上傳的段附近），實測點先不拿來檢核']);
        });
        // 67 坐標系的儀器檔：只做 67 內部檢核（實測 vs 已知），不拿來修正轉換
        src67.forEach(function (ins) {
          var kn = {}; ins.known.forEach(function (k) { kn[k.name.toUpperCase()] = k; });
          ins.measured.forEach(function (p) {
            var nm = p.name.toUpperCase(), k = kn[nm] || kn[nm.replace(/-\d+$/, '')];
            if (k) res.report.push(['info', '67 內部檢核（' + Core.fileName(ins.file) + '）：' + p.name + ' 實測跟已知 ' + k.name + ' 差 ' + Core.fmtDist(Math.hypot(p.y - k.y, p.x - k.x))]);
          });
          res.report.push(['info', Core.fileName(ins.file) + ' 是 TWD67 坐標（' + ins.section + '），實測點不拿來檢核 67→97 轉換']);
        });
        if (meas.length) {
          // 點名後面的 -1、-2（同一點重測）對不到時，用原點名再對一次
          meas.forEach(function (m) { if (!S.ctlByName[m.name.toUpperCase()] && /-\d+$/.test(m.name) && S.ctlByName[m.name.toUpperCase().replace(/-\d+$/, '')]) { m.orig = m.name; m.name = m.name.replace(/-\d+$/, ''); } });
          var mc = Core.matchChecks(meas, { bnd: (body.checkFiles || []).length ? res.bnd : {}, sections: res.sections, trans: S.trans, ctlByName: S.ctlByName });
          var prev = allChecks(live);
          Core.classifyChecks(prev.concat(mc.checks), { tol: chkTol(), range: S.cfg.check_range_m || 150 });
          res.checks = mc.checks;
          res.report.push(['ok', '實測檢核點 ' + meas.length + ' 點，對到已知點 ' + mc.checks.length + ' 點' + (mc.unmatched.length ? '（對不到：' + mc.unmatched.slice(0, 8).join('、') + (mc.unmatched.length > 8 ? '…' : '') + '）' : '')]);
          mc.checks.filter(function (c) { return c.cls !== 'ok'; }).forEach(function (c) {
            res.report.push([c.cls === 'wrong' ? 'warn' : 'info', '檢核點 ' + c.name + '（' + c.kind + '）實測跟換算差 ' + Core.fmtDist(c.d) + '：' + CLS[c.cls]]);
          });
          res.stats['檢核點'] = mc.checks.length;
        }
        delete res.instr;
        delete res.bnd;
        return res;
      });
    });
  }
  function upload(body) {
    return analyze(body).then(function (res) {
      if (res.blocking) throw new Error('還有紅色的問題要先處理（地號、案件種類…）');
      var created = Date.now() / 1000, safe = body.surveyor.replace(/[\\/:*?"<>|]/g, '_');
      var id = stamp(new Date()) + '_' + safe, dir = '上傳/' + id + '/';
      var keep = body.files.filter(function (f) { return Core.wanted(f.path); }).concat((body.checkFiles || []).map(function (f) { return { path: '檢核點/' + f.path, bytes: f.bytes }; }));
      var rec = { version: 2, surveyor: body.surveyor, code: res.code, caseType: body.caseType, caseNo: body.caseNo || '', note: body.note || '',
        created: created, sections: res.sections, stats: res.stats, report: res.report, maxNum: res.maxNum || 0,
        parcels: res.parcels.map(function (p) { return { section: p.section, parcel: p.parcel, found: p.found, ring: p.ring || null }; }),
        points: res.points, used: res.used, links: res.links, checks: res.checks || [], backsights: res.backsights || [], files: keep.map(function (f) { return f.path; }).concat((body.checkFiles || []).map(function (f) { return '檢核點/' + f.path; })) };
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
  /** 匯入既有補點清冊（CSV：點名,Y,X[,段]，TWD97）→ 存成一次「匯入」上傳 */
  function importRegistry(body) {
    var sv = surveyorOf(body.surveyor);
    if (!sv) return Promise.reject(new Error('找不到這位測量員'));
    var re = new RegExp('^Q' + sv.code + '(\\d+)$', 'i'), pts = [], bad = [], maxNum = 0, seen = {};
    Core.decode(body.bytes).split(/\r?\n/).forEach(function (l, i) {
      var t = l.split(/[,\t]/).map(function (v) { return v.trim().replace(/^"|"$/g, ''); });
      if (!t[0] || !Core.isNum(t[1]) || !Core.isNum(t[2])) { if (l.trim() && i > 0) bad.push(i + 1); return; }
      var y = parseFloat(t[1]), x = parseFloat(t[2]);
      if (Core.isX(t[1]) && Core.isY(t[2])) { var tmp = y; y = x; x = tmp; }
      var m = re.exec(t[0]); if (m) maxNum = Math.max(maxNum, +m[1]);
      if (seen[t[0].toUpperCase()]) return; seen[t[0].toUpperCase()] = 1;
      pts.push({ section: t[3] ? (/^\d{4}$/.test(t[3]) ? 'KC' + t[3] : t[3].toUpperCase()) : '', kind: '補點', name: t[0], y: y, x: x, src: body.name || '匯入', reg: 'import' });
    });
    if (!pts.length) return Promise.reject(new Error('檔案裡沒有「點名,Y,X」的資料'));
    var id = stamp(new Date()) + '_' + body.surveyor.replace(/[\\/:*?"<>|]/g, '_') + '_清冊匯入';
    var rec = { version: 2, import: true, surveyor: sv.name, code: sv.code, caseType: '匯入既有清冊', note: body.name || '', created: Date.now() / 1000,
      sections: [], stats: { '補點': pts.length }, report: [], maxNum: maxNum, parcels: [], points: pts, used: [], links: [], files: [] };
    return writeJson('上傳/' + id + '/結果.json', rec).then(function () { rec.id = id; S.batches[id] = rec; return { ok: true, count: pts.length, bad: bad, maxNum: maxNum }; });
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
      fd.batches.filter(function (b) { return b.surveyor.indexOf(q) >= 0 || (b.caseNo && b.caseNo.indexOf(q) >= 0); }).slice(0, 20).forEach(function (b) {
        var d = new Date(b.created * 1000);
        out.push({ type: '上傳', label: b.surveyor + (b.caseType ? ' ' + b.caseType : '') + (b.caseNo ? '（' + b.caseNo + '）' : '') + '，' + (d.getFullYear() - 1911) + '.' + (d.getMonth() + 1) + '.' + d.getDate() + '，' + b.parcels.join('、'), batch: b.id });
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
        if (!idx) {
          var e = new Error('還沒有底圖');
          e.data = { nobase: true, cfg: { tolerance_cm: S.cfg.tolerance_cm, surveyors: S.cfg.surveyors, case_types: S.cfg.case_types, dup_tol_cm: S.cfg.dup_tol_cm,
            ref_buffer_m: S.cfg.ref_buffer_m, section_names: S.names, abolished: S.cfg.abolished_sections } };
          throw e;
        }
        return { datum: idx.datum, tolerance_cm: S.cfg.tolerance_cm, surveyors: S.cfg.surveyors, case_types: S.cfg.case_types,
          dup_tol_cm: S.cfg.dup_tol_cm, ref_buffer_m: S.cfg.ref_buffer_m, section_names: S.names, custom_names: S.cfg.section_names,
          abolished: S.cfg.abolished_sections, sections: idx.sections, ctl: idx.ctl, built: idx.built,
          ctlFixed: idx.ctlFixed || {}, param_exclude: S.cfg.param_exclude || {}, param_choice: S.cfg.param_choice || {},
          param_exclude_names: S.cfg.param_exclude_names || [], check_tol_cm: S.cfg.check_tol_cm || 3,
          case_tol_cm: S.cfg.case_tol_cm, case_warn_cm: S.cfg.case_warn_cm, case_radius_m: S.cfg.case_radius_m };
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
        return { report: r.report, stats: r.stats, sections: r.sections, points: r.points, parcels: r.parcels, blocking: r.blocking, code: r.code,
          used: r.used.filter(function (u) { return u.delta == null || u.delta > tolM(); }) };
      });
    }
    if ((m = /^\/api\/registry\?surveyor=(.*)$/.exec(path))) return loadCfg().then(function () { return registryOf(decodeURIComponent(m[1])); });
    if (path === '/api/registry/import') return loadCfg().then(function () { return importRegistry(body); });
    if ((m = /^\/api\/registry\/export\?surveyor=(.*)$/.exec(path))) {
      var who = decodeURIComponent(m[1]);
      return loadCfg().then(function () { return registryOf(who); }).then(function (r) {
        var rows = ['點名,Y(縱),X(橫),段,第一次登錄,案件種類,地號,重測系統原名'];
        r.points.forEach(function (p) { rows.push([p.name, p.y.toFixed(3), p.x.toFixed(3), secName(p.section), new Date(p.created * 1000).toLocaleString(), p.caseType, p.parcels, p.orig_name].map(csvCell).join(',')); });
        download('補點清冊_' + who + '.csv', '\ufeff' + rows.join('\r\n'), 'text/csv');
        return { ok: true };
      });
    }
    if (path === '/api/upload') return upload(body);
    if (path === '/api/config') {
      return loadCfg().then(function () {
        var rebuild = false;
        if (Array.isArray(body.abolished_sections)) { S.cfg.abolished_sections = body.abolished_sections; rebuild = true; }
        if ('twd67_sections' in body) { S.cfg.twd67_sections = body.twd67_sections; rebuild = true; }
        if ('tolerance_cm' in body) S.cfg.tolerance_cm = body.tolerance_cm;
        if (Array.isArray(body.surveyors)) S.cfg.surveyors = body.surveyors;
        if (Array.isArray(body.case_types)) S.cfg.case_types = body.case_types;
        if ('dup_tol_cm' in body) S.cfg.dup_tol_cm = body.dup_tol_cm;
        if ('ref_buffer_m' in body) S.cfg.ref_buffer_m = body.ref_buffer_m;
        if ('check_tol_cm' in body) S.cfg.check_tol_cm = body.check_tol_cm;
        ['case_tol_cm', 'case_warn_cm', 'case_radius_m'].forEach(function (k) { if (k in body) S.cfg[k] = body[k]; });
        if (Array.isArray(body.param_exclude_names)) { S.cfg.param_exclude_names = body.param_exclude_names; rebuild = true; }
        if (body.param_choice) { S.cfg.param_choice = Object.assign(S.cfg.param_choice || {}, body.param_choice); Object.keys(S.cfg.param_choice).forEach(function (k) { if (!S.cfg.param_choice[k]) delete S.cfg.param_choice[k]; }); rebuild = true; }
        if (body.param_exclude) { S.cfg.param_exclude = Object.assign(S.cfg.param_exclude || {}, body.param_exclude); rebuild = true; }
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
    if (path === '/api/kit') return loadCfg().then(function () { return fieldKit(body); });
    if (path === '/api/writeback/preview') return loadCfg().then(function () { return writeBackPreview(body); });
    if (path === '/api/writeback/commit') return writeBackCommit(body);
    if (path === '/api/checks/approve') return loadCfg().then(function () { return setApproved(body); });
    if (path === '/api/params/upload') return loadCfg().then(function () { return uploadParams(body); });
    if (path === '/api/params/delete') {
      return dirOf('底圖/轉換參數').then(function (d) { return d.removeEntry(body.file || body.section + '.inp'); })
        .then(function () { return rebuildFromSaved(body.progress); }).then(function () { return { ok: true }; });
    }
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
