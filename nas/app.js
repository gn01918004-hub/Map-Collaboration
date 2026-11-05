/* 地籍共作平台（共用資料夾版）— 畫面。資料讀寫交給 store.js 的 Local.api（不用伺服器） */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function f3(v) { return v == null ? '' : Number(v).toFixed(3); }
  function dist(d) { return d == null ? '' : d < 1 ? (d * 100).toFixed(1) + ' 公分' : d.toFixed(2) + ' 公尺'; }
  function when(t) { var d = new Date(t * 1000), p = function (n) { return (n < 10 ? '0' : '') + n; }; return (d.getFullYear() - 1911) + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var toastTimer;
  function toast(msg, ms) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 3000); }
  function busy(on, text) { $('busy').classList.toggle('hidden', !on); $('busyText').textContent = text || '處理中…'; }
  function api(path, body) { return Local.api(path, body); }
  function progressTo(prefix) { return function (t) { busy(true, (prefix ? prefix + '：' : '') + t); }; }
  var COLORS = ['#d92d20', '#1f6feb', '#13834a', '#7a3fd1', '#e8730c', '#0e9384', '#c11574', '#4e5ba6', '#b54708', '#344054'];
  var whoColor = {};
  function colorOf(who) { if (!whoColor[who]) whoColor[who] = COLORS[Object.keys(whoColor).length % COLORS.length]; return whoColor[who]; }

  // ───────────────────────── 地圖 ─────────────────────────
  var map = L.map('map', { preferCanvas: true, zoomControl: true, maxZoom: 22 }).setView([24.43, 120.69], 13);
  var renderer = L.canvas({ padding: 0.3 });
  var BASES = {
    emap: L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: '國土測繪中心' }),
    photo: L.tileLayer('https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: '國土測繪中心' }),
    none: null
  };
  var curBase = null;
  function setBase(k) {
    if (curBase) map.removeLayer(curBase);
    curBase = BASES[k] || null;
    if (curBase) curBase.addTo(map).bringToBack();
    store('base', k);
  }
  var tileFails = 0;
  [BASES.emap, BASES.photo].forEach(function (t) {
    t.on('tileerror', function () { if (++tileFails === 8) toast('連不到國土測繪中心的底圖（沒有網路？），地籍線和點位還是可以看'); });
  });

  var layers = {
    secBox: L.layerGroup().addTo(map),
    parcel: L.layerGroup().addTo(map),
    plabel: L.layerGroup().addTo(map),
    ctl: L.layerGroup().addTo(map),
    clabel: L.layerGroup().addTo(map),
    links: L.layerGroup().addTo(map),
    bad: L.layerGroup().addTo(map),
    ref: L.layerGroup().addTo(map),
    field: L.layerGroup().addTo(map),
    hl: L.layerGroup().addTo(map)
  };
  var show = { field: true, ref: true, ctl: true, bad: true, links: true, parcel: true };

  var S = { info: null, controls: [], field: null, sections: {}, secCache: {}, secLoading: {}, onlyWho: '' };

  // ── 段範圍框（拉遠時看得到每一段在哪）──
  function drawSectionBoxes() {
    layers.secBox.clearLayers();
    (S.info.sections || []).forEach(function (s) {
      if (!s.bbox) return;
      var b = [[s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]];
      L.rectangle(b, { renderer: renderer, color: '#12355b', weight: 1, dashArray: '4 4', fill: false, interactive: false }).addTo(layers.secBox);
      S.sections[s.section] = s;
    });
  }
  function drawSectionLabels() {
    var z = map.getZoom();
    layers.secBox.eachLayer(function (l) { if (l instanceof L.Marker) layers.secBox.removeLayer(l); });
    if (z >= 16 || z < 12) return;
    var vb = map.getBounds(), placed = [];
    (S.info.sections || []).forEach(function (s) {
      if (!s.bbox) return;
      var c = L.latLng((s.bbox[0] + s.bbox[2]) / 2, (s.bbox[1] + s.bbox[3]) / 2);
      if (!vb.contains(c)) return;
      // 字疊在一起就不畫
      var px = map.latLngToContainerPoint(c);
      if (placed.some(function (q) { return Math.abs(q.x - px.x) < 80 && Math.abs(q.y - px.y) < 24; })) return;
      placed.push(px);
      L.marker(c, { interactive: false, icon: L.divIcon({ className: '', html: '<span class="slbl">' + esc(secName(s.section)) + '</span>', iconSize: [0, 0] }) }).addTo(layers.secBox);
    });
  }
  function secName(code) { var n = (S.info.section_names || {})[code]; return n ? n + ' ' + code.slice(2) : code; }

  // ── 地籍線：放大到 16 級以上才載入畫面內的段 ──
  var PARCEL_ZOOM = 16;
  function loadSection(code) {
    if (S.secCache[code] || S.secLoading[code]) return;
    S.secLoading[code] = true;
    api('/api/section/' + code).then(function (d) {
      S.secCache[code] = { parcels: d.parcels, layer: null, used: Date.now() };
      delete S.secLoading[code];
      refreshParcels();
    }).catch(function () { delete S.secLoading[code]; });
  }
  function sectionsInView() {
    var vb = map.getBounds();
    return (S.info.sections || []).filter(function (s) {
      return s.bbox && vb.intersects([[s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]]) && s.parcels;
    }).map(function (s) { return s.section; });
  }
  function parcelPopup(code, p) {
    return '<div class="pop"><h4>' + esc(secName(code)) + '　' + esc(p.k) + ' 地號</h4><table>' +
      (p.a != null ? '<tr><td>面積</td><td>' + Number(p.a).toLocaleString() + ' ㎡</td></tr>' : '') +
      (p.u ? '<tr><td>地目代碼</td><td>' + esc(p.u) + '</td></tr>' : '') + '</table></div>';
  }
  function buildSectionLayer(code) {
    var c = S.secCache[code];
    if (c.layer) return c.layer;
    var g = L.layerGroup();
    c.parcels.forEach(function (p) {
      var ring = [];
      for (var i = 0; i < p.r.length; i += 2) ring.push([p.r[i], p.r[i + 1]]);
      var poly = L.polygon(ring, { renderer: renderer, color: '#c0392b', weight: 1, fillColor: '#c0392b', fillOpacity: 0.02 });
      poly.on('click', function (e) { L.popup().setLatLng(e.latlng).setContent(parcelPopup(code, p)).openOn(map); });
      poly._p = p;
      g.addLayer(poly);
    });
    c.layer = g;
    return g;
  }
  function refreshParcels() {
    var z = map.getZoom();
    layers.parcel.clearLayers();
    layers.plabel.clearLayers();
    if (!show.parcel || z < PARCEL_ZOOM) return;
    var vis = sectionsInView();
    vis.forEach(function (code) {
      if (!S.secCache[code]) return loadSection(code);
      S.secCache[code].used = Date.now();
      layers.parcel.addLayer(buildSectionLayer(code));
    });
    // 記憶體保護：最多留 12 段
    var keys = Object.keys(S.secCache);
    if (keys.length > 12) keys.sort(function (a, b) { return S.secCache[a].used - S.secCache[b].used; }).slice(0, keys.length - 12)
      .forEach(function (k) { if (vis.indexOf(k) < 0) delete S.secCache[k]; });
    // 地號標籤
    if (z >= 18) {
      var vb = map.getBounds(), n = 0;
      vis.forEach(function (code) {
        var c = S.secCache[code];
        if (!c) return;
        c.parcels.forEach(function (p) {
          if (n > 600 || !vb.contains(p.c)) return;
          n++;
          L.marker(p.c, { interactive: false, icon: L.divIcon({ className: '', html: '<span class="plbl">' + esc(p.k) + '</span>', iconSize: [0, 0] }) }).addTo(layers.plabel);
        });
      });
    }
  }

  // ── 圖根點 ──
  var CTL_ZOOM = 15;
  var usedByCtl = {};
  function ctlPopup(p) {
    var h = '<div class="pop"><h4>圖根點 ' + esc(p.name) + '</h4><table>' +
      '<tr><td>Y（縱）</td><td>' + f3(p.y) + '</td></tr><tr><td>X（橫）</td><td>' + f3(p.x) + '</td></tr>' +
      '<tr><td>出現在</td><td>' + esc(p.sections.map(secName).join('、')) + '（' + p.count + ' 次）</td></tr>' +
      (p.flags.length ? '<tr><td>註記碼</td><td>' + esc(p.flags.join(' ')) + '</td></tr>' : '') +
      '<tr><td>坐標系統</td><td>' + (p.datum === 'TWD67' ? '原為 67，已換成 97' : p.datum === '?' ? '<b style="color:#d92d20">不確定</b>' : 'TWD97') + '</td></tr>' +
      (p.raw ? '<tr><td>CTL 原始值</td><td>' + p.raw.map(function (r) { return f3(r[0]) + ', ' + f3(r[1]); }).join('<br>') + '</td></tr>' : '') +
      (p.fix ? '<tr><td>格式修正</td><td class="small">' + esc(p.fix.join('、')) + '</td></tr>' : '') + '</table>';
    (p.notes || []).forEach(function (n) { h += '<div class="w">⚠ ' + esc(n) + '</div>'; });
    var us = usedByCtl[p.id] || [];
    if (us.length) {
      h += '<div style="margin-top:6px"><b>測量員使用紀錄</b></div>';
      us.forEach(function (u) {
        h += '<div class="' + (u.delta > tolM() ? 'w' : 'small') + '">' + esc(u.surveyor) + '（' + when(u.created) + '）' +
          (u.delta > tolM() ? '：坐標差 ' + dist(u.delta) + '，用的是 ' + f3(u.y) + ', ' + f3(u.x) : '：相符') + '</div>';
      });
    }
    return h + copyBtn(p.name, p.y, p.x) + '</div>';
  }
  function copyBtn(n, y, x) { return '<button class="copy" data-copy="' + esc(n + ',' + f3(y) + ',' + f3(x)) + '">📋 複製坐標</button>'; }
  function tolM() { return ((S.info && S.info.tolerance_cm) || 2) / 100; }
  function refreshCtl() {
    layers.ctl.clearLayers();
    layers.clabel.clearLayers();
    var z = map.getZoom();
    if (!show.ctl || z < CTL_ZOOM) return;
    var vb = map.getBounds().pad(0.2), n = 0, lab = z >= 17;
    S.controls.forEach(function (p) {
      if (!p.ll || n > 4000 || !vb.contains(p.ll)) return;
      n++;
      var warn = p.notes && p.notes.length;
      var m = L.circleMarker(p.ll, { renderer: renderer, radius: z >= 18 ? 6 : 4, color: '#fff', weight: 2, fillColor: warn ? '#7c8db5' : '#1f6feb', fillOpacity: 1 });
      m.bindPopup(function () { return ctlPopup(p); });
      layers.ctl.addLayer(m);
      if (lab && n < 600) L.marker(p.ll, { interactive: false, icon: L.divIcon({ className: '', html: '<div class="clbl">' + esc(p.name) + '</div>', iconSize: [0, 0] }) }).addTo(layers.clabel);
    });
  }

  // ── 測量員的資料 ──
  function fieldPopup(p) {
    var h = '<div class="pop"><h4>' + esc(p.kind) + ' ' + esc(p.name) + '</h4><table>' +
      '<tr><td>Y（縱）</td><td>' + f3(p.y) + '</td></tr><tr><td>X（橫）</td><td>' + f3(p.x) + '</td></tr>' +
      '<tr><td>段</td><td>' + esc(secName(p.section)) + '</td></tr>' +
      (p.extra && p.extra.orig ? '<tr><td>原始(67)</td><td>' + f3(p.extra.orig[0]) + ', ' + f3(p.extra.orig[1]) + '</td></tr>' : '') +
      '<tr><td>測量員</td><td><span class="dot-who" style="background:' + colorOf(p.surveyor) + '"></span>' + esc(p.surveyor) + '</td></tr>' +
      '<tr><td>上傳時間</td><td>' + when(p.created) + '</td></tr>' +
      '<tr><td>來源檔</td><td>' + esc(String(p.src).split('/').pop()) + '</td></tr></table>';
    var ls = (S.field.links || []).filter(function (l) { return l.target.toUpperCase() === p.name.toUpperCase() && l.section === p.section && l.surveyor === p.surveyor; });
    ls.forEach(function (l) {
      h += '<div class="small">📐 由 <b>' + esc(l.station) + '</b> 設站、後視 <b>' + esc(l.back) + '</b> 測得' +
        (l.angle ? '（夾角 ' + esc(l.angle) + '，距離 ' + (l.dist != null ? l.dist.toFixed(3) + ' m' : '') + '）' : '') + '</div>';
    });
    (p.others || []).forEach(function (o) {
      h += '<div class="' + (o.d > tolM() ? 'w' : 'small') + '">' + (o.d > tolM() ? '⚠ ' : '✔ ') + esc(o.surveyor) + ' 也有這點，' +
        (o.d > tolM() ? '坐標差 ' + dist(o.d) + '（' + f3(o.y) + ', ' + f3(o.x) + '）' : '坐標相符') + '</div>';
    });
    return h + copyBtn(p.name, p.y, p.x) + '</div>';
  }
  function mkIcon(cls, name, who, conflict) {
    return L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="mk ' + cls + (conflict ? ' conflict' : '') + '"><div class="shape"' +
      (cls === 'warn' ? '>!' : '>') + '</div><div class="lbl">' + esc(name) + (who ? ' <small>' + esc(who) + '</small>' : '') + '</div></div>' });
  }
  function visibleWho(w) { return !S.onlyWho || S.onlyWho === w; }
  function refreshField() {
    ['field', 'ref', 'links', 'bad'].forEach(function (k) { layers[k].clearLayers(); });
    if (!S.field) return;
    var z = map.getZoom(), lab = z >= 15;
    S.field.points.forEach(function (p) {
      if (!p.ll || !visibleWho(p.surveyor)) return;
      var isRef = p.kind === '參考點';
      if (isRef ? !show.ref : !show.field) return;
      if (isRef && z < 16) return;
      var cls = p.kind === '補點' ? 'tri' : isRef ? 'sq' : 'dia';
      var m = L.marker(p.ll, { icon: mkIcon(cls, lab ? p.name : '', lab ? p.surveyor : '', p.conflict), zIndexOffset: isRef ? 0 : 1000 });
      m.bindPopup(function () { return fieldPopup(p); });
      layers[isRef ? 'ref' : 'field'].addLayer(m);
    });
    if (show.links) {
      S.field.links.forEach(function (l) {
        if (!l.sll || !l.tll || !visibleWho(l.surveyor)) return;
        L.polyline([l.sll, l.tll], { renderer: renderer, color: '#13834a', weight: 2, dashArray: '6 6' })
          .bindPopup('<div class="pop"><h4>設站 ' + esc(l.station) + ' → ' + esc(l.target) + '</h4><table><tr><td>後視</td><td>' + esc(l.back) +
            '</td></tr><tr><td>夾角</td><td>' + esc(l.angle) + '</td></tr><tr><td>距離</td><td>' + (l.dist != null ? l.dist.toFixed(3) + ' m' : '') +
            '</td></tr><tr><td>測量員</td><td>' + esc(l.surveyor) + '</td></tr></table></div>').addTo(layers.links);
        if (l.bll) L.polyline([l.sll, l.bll], { renderer: renderer, color: '#667085', weight: 1, dashArray: '2 4', interactive: false }).addTo(layers.links);
      });
    }
    if (show.bad) {
      S.field.used.forEach(function (u) {
        if (!u.ll || !(u.delta > tolM()) || !visibleWho(u.surveyor)) return;
        var m = L.marker(u.ll, { icon: mkIcon('warn', lab ? u.name : '', lab ? u.surveyor : ''), zIndexOffset: 2000 });
        m.bindPopup('<div class="pop"><h4>⚠ ' + esc(u.name) + ' 坐標不符</h4><div class="w">' + esc(u.surveyor) + ' 用的坐標跟圖根點檔差 <b>' + dist(u.delta) +
          '</b></div><table><tr><td>測量員用的</td><td>' + f3(u.y) + ', ' + f3(u.x) + '</td></tr>' +
          '<tr><td>來源</td><td>' + esc(u.how) + '（' + esc(String(u.src).split('/').pop()) + '）</td></tr>' +
          '<tr><td>上傳時間</td><td>' + when(u.created) + '</td></tr></table></div>');
        layers.bad.addLayer(m);
      });
    }
  }
  function hintZoom() {
    var z = map.getZoom(), t = '';
    if (z < CTL_ZOOM) t = '再放大一點就會出現圖根點和地籍線';
    else if (z < PARCEL_ZOOM && show.parcel) t = '再放大一點就會出現地籍線';
    $('zoomHint').textContent = t;
  }
  function refreshAll() { drawSectionLabels(); refreshParcels(); refreshCtl(); refreshField(); hintZoom(); }
  map.on('moveend', refreshAll);

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (!b) return;
    var t = b.getAttribute('data-copy');
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast('已複製：' + t); }, function () { window.prompt('請手動複製：', t); });
  });

  function flyTo(ll, z, popupHtml) {
    if (!ll) { toast('這個點的坐標不能放到地圖上（假設坐標或是 0）'); return; }
    map.flyTo(ll, Math.max(map.getZoom(), z || 18), { duration: 0.8 });
    layers.hl.clearLayers();
    var c = L.circleMarker(ll, { radius: 22, color: '#f5b400', weight: 4, fill: false, interactive: false }).addTo(layers.hl);
    setTimeout(function () { layers.hl.removeLayer(c); }, 6000);
    if (popupHtml) setTimeout(function () { L.popup().setLatLng(ll).setContent(popupHtml).openOn(map); }, 900);
    if (window.innerWidth < 760) closeSide();
  }

  // ───────────────────────── 側邊面板 ─────────────────────────
  function openPanel(name) {
    $('side').classList.remove('hidden');
    $('side').scrollTop = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) { p.classList.toggle('on', p.id === 'p-' + name); });
    Array.prototype.forEach.call(document.querySelectorAll('#top [data-panel]'), function (b) { b.classList.toggle('on', b.getAttribute('data-panel') === name); });
    setTimeout(function () { map.invalidateSize(); }, 50);
    if (name === 'search') setTimeout(function () { $('q').focus(); }, 60);
    if (name === 'recent') renderBatches();
    if (name === 'admin') renderAdmin();
  }
  function closeSide() {
    $('side').classList.add('hidden');
    Array.prototype.forEach.call(document.querySelectorAll('#top [data-panel]'), function (b) { b.classList.remove('on'); });
    setTimeout(function () { map.invalidateSize(); }, 50);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#top [data-panel]'), function (b) {
    b.onclick = function () {
      var n = b.getAttribute('data-panel');
      if (b.classList.contains('on')) closeSide(); else openPanel(n);
    };
  });
  $('sideClose').onclick = closeSide;

  // ── 查詢 ──
  function doSearch() {
    var q = $('q').value.trim();
    if (!q) return;
    $('results').innerHTML = '<div class="empty">找找看…</div>';
    api('/api/search?q=' + encodeURIComponent(q)).then(function (rs) {
      if (!rs.length) { $('results').innerHTML = '<div class="empty">找不到「' + esc(q) + '」<br>地號可以打 123 或 123-4；點名打開頭幾個字就好</div>'; return; }
      $('results').innerHTML = '';
      rs.forEach(function (r) {
        var d = document.createElement('div');
        d.className = 'res';
        d.innerHTML = '<span class="tag ' + esc(r.type) + '">' + esc(r.type) + '</span><span>' + esc(r.label) + (r.area != null ? '　<span class="small">' + Number(r.area).toLocaleString() + ' ㎡</span>' : '') + '</span>';
        d.onclick = function () { pickResult(r); };
        $('results').appendChild(d);
      });
      if (rs.length === 1) pickResult(rs[0]);
    }).catch(function (e) { $('results').innerHTML = '<div class="msg error">' + esc(e.message) + '</div>'; });
  }
  function pickResult(r) {
    if (r.type === '地號') {
      flyTo(r.ll, 19);
      var tryOpen = function (n) {
        var c = S.secCache[r.section];
        if (!c) { if (n < 30) setTimeout(function () { tryOpen(n + 1); }, 300); return; }
        var p = c.parcels.filter(function (x) { return x.k === r.parcel; })[0];
        if (!p) return;
        var ring = []; for (var i = 0; i < p.r.length; i += 2) ring.push([p.r[i], p.r[i + 1]]);
        layers.hl.clearLayers();
        var hl = L.polygon(ring, { color: '#f5b400', weight: 5, fillOpacity: 0.15, interactive: false }).addTo(layers.hl);
        setTimeout(function () { layers.hl.removeLayer(hl); }, 8000);
        L.popup().setLatLng(p.c).setContent(parcelPopup(r.section, p)).openOn(map);
      };
      setTimeout(function () { tryOpen(0); }, 900);
    } else if (r.type === '圖根點') {
      var p = S.controls.filter(function (x) { return x.id === r.id; })[0];
      flyTo(r.ll, 18, p ? ctlPopup(p) : null);
    } else if (r.type === '上傳') {
      showBatch(r.batch);
    } else {
      var f = S.field.points.filter(function (x) { return x.name === r.name && x.section === r.section; })[0];
      flyTo(r.ll, 18, f ? fieldPopup(f) : null);
    }
  }
  $('qGo').onclick = doSearch;
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-q]'), function (a) { a.onclick = function () { $('q').value = a.getAttribute('data-q'); doSearch(); }; });

  // ── 誰上傳了什麼 ──
  function batchCounts(st) {
    var parts = [];
    ['補點', '參考點', '控制點'].forEach(function (k) { if (st[k]) parts.push(k + ' <b>' + st[k] + '</b>'); });
    if (st['圖根點']) parts.push('圖根點 ' + st['圖根點']);
    if (st['圖根點不符']) parts.push('<span style="color:#d92d20">⚠ 不符 ' + st['圖根點不符'] + '</span>');
    return parts.join('、') || '（沒有點）';
  }
  function renderBatches() {
    if (!S.field) return;
    var sel = $('whoFilter'), cur = sel.value;
    var whos = {};
    S.field.batches.forEach(function (b) { whos[b.surveyor] = 1; });
    sel.innerHTML = '<option value="">全部的人</option>' + Object.keys(whos).sort().map(function (w) { return '<option' + (w === cur ? ' selected' : '') + '>' + esc(w) + '</option>'; }).join('');
    var list = S.field.batches.filter(function (b) { return !cur || b.surveyor === cur; });
    if (!list.length) { $('batches').innerHTML = '<div class="empty">還沒有人上傳。按上面綠色的「📤 上傳外業資料」開始！</div>'; return; }
    $('batches').innerHTML = '';
    list.forEach(function (b) {
      var d = document.createElement('div');
      d.className = 'batch';
      d.innerHTML = '<div class="who"><span class="dot-who" style="background:' + colorOf(b.surveyor) + '"></span>' + esc(b.surveyor) + '</div>' +
        '<div class="when">' + when(b.created) + '　' + esc((b.sections || '').split(',').map(secName).join('、')) + '</div>' +
        (b.note ? '<div class="small">📝 ' + esc(b.note) + '</div>' : '') +
        '<div class="cnt">' + batchCounts(b.stats) + '</div>' +
        '<div class="acts"><button class="ghost" data-a="see">👀 在地圖上看</button><button class="ghost" data-a="detail">📄 詳細</button>' +
        '<button class="ghost" data-a="dl">⬇ 原始檔</button><button class="ghost" data-a="del">🗑 刪除</button></div><div class="det"></div>';
      d.querySelector('[data-a=see]').onclick = function () { showBatch(b.id); };
      d.querySelector('[data-a=dl]').onclick = function () { api('/api/batch/' + encodeURIComponent(b.id) + '/download').catch(function (e) { toast(e.message); }); };
      d.querySelector('[data-a=detail]').onclick = function () {
        var box = d.querySelector('.det');
        if (box.innerHTML) { box.innerHTML = ''; return; }
        api('/api/batch/' + encodeURIComponent(b.id)).then(function (full) {
          box.innerHTML = full.report.map(function (r) { return '<div class="msg ' + r[0] + '">' + esc(r[1]) + '</div>'; }).join('') +
            '<div class="small">檔案：' + esc(full.files.map(function (f) { return f.split('/').pop(); }).join('、')) + '</div>';
        });
      };
      d.querySelector('[data-a=del]').onclick = function () {
        if (!confirm('確定要刪除 ' + b.surveyor + ' 在 ' + when(b.created) + ' 的這次上傳？\n（刪掉後地圖上就看不到這次的點）')) return;
        api('/api/batch/' + encodeURIComponent(b.id) + '/delete', { by: store('who') || '' }).then(function () { toast('已刪除（檔案還留在共用資料夾，需要可以救回）'); loadField(); });
      };
      $('batches').appendChild(d);
    });
  }
  $('whoFilter').onchange = renderBatches;
  function showBatch(id) {
    var pts = S.field.points.filter(function (p) { return p.batch_id === id && p.ll; });
    var used = S.field.used.filter(function (u) { return u.batch_id === id && u.ll; });
    var all = pts.length ? pts : used;
    if (!all.length) { toast('這次上傳沒有可以顯示的點（可能被同一人後來的上傳取代了）'); return; }
    var b = L.latLngBounds(all.map(function (p) { return p.ll; }));
    map.flyToBounds(b.pad(0.3), { maxZoom: 18, duration: 0.8 });
    layers.hl.clearLayers();
    pts.forEach(function (p) { L.circleMarker(p.ll, { radius: 18, color: '#f5b400', weight: 4, fill: false, interactive: false }).addTo(layers.hl); });
    setTimeout(function () { layers.hl.clearLayers(); }, 6000);
    if (window.innerWidth < 760) closeSide();
  }

  // ── 上傳 ──
  var pending = [];   // [{path, file}]
  var WANT = /\.(d14|d20|l02|l14|l20|b9\d|csv|txt|zip)$/i;
  $('who').value = store('who') || '';
  $('who').addEventListener('change', function () { store('who', $('who').value.trim()); });
  $('pickDir').onclick = function () { $('dirInput').click(); };
  $('pickFile').onclick = function () { $('fileInput').click(); };
  $('dirInput').onchange = function () { addFiles(Array.prototype.map.call(this.files, function (f) { return { path: f.webkitRelativePath || f.name, file: f }; })); this.value = ''; };
  $('fileInput').onchange = function () { addFiles(Array.prototype.map.call(this.files, function (f) { return { path: f.name, file: f }; })); this.value = ''; };
  var drop = $('drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault(); drop.classList.remove('over');
    readDrop(e.dataTransfer).then(addFiles);
  });
  // 整個資料夾拖進來也可以
  function readDrop(dt) {
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (i) { return i.webkitGetAsEntry && i.webkitGetAsEntry(); }).filter(Boolean);
    if (!entries.length) return Promise.resolve(Array.prototype.map.call(dt.files, function (f) { return { path: f.name, file: f }; }));
    var out = [];
    function walk(entry, prefix) {
      if (entry.isFile) return new Promise(function (res) { entry.file(function (f) { out.push({ path: prefix + f.name, file: f }); res(); }, res); });
      var reader = entry.createReader();
      return new Promise(function (res) {
        var all = [];
        (function more() {
          reader.readEntries(function (ents) {
            if (!ents.length) return Promise.all(all.map(function (en) { return walk(en, prefix + entry.name + '/'); })).then(res);
            all = all.concat(Array.prototype.slice.call(ents)); more();
          }, res);
        })();
      });
    }
    return Promise.all(entries.map(function (en) { return walk(en, ''); })).then(function () { return out; });
  }
  function addFiles(list) {
    var ok = list.filter(function (x) { return WANT.test(x.path); });
    pending = pending.concat(ok);
    var skip = list.length - ok.length;
    $('picked').innerHTML = pending.length ? '已選 <b>' + pending.length + '</b> 個有用的檔案' + (skip ? '（另外 ' + skip + ' 個用不到的已略過）' : '') +
      '：' + esc(pending.slice(0, 8).map(function (x) { return x.path.split('/').pop(); }).join('、')) + (pending.length > 8 ? '…' : '') : (skip ? '這些檔案都用不到（要 D20、D14、L02、B90、CSV 或 zip）' : '');
    if (pending.length) preview();
  }
  function payload() {
    var who = $('who').value.trim();
    if (!who) { toast('請先在第 1 步填你的名字'); $('who').focus(); return Promise.reject(new Error('no name')); }
    store('who', who);
    return Local.fileListToItems(pending).then(function (files) { return { surveyor: who, note: $('note').value.trim(), files: files }; });
  }
  function renderPreview(r) {
    var st = r.stats || {};
    var h = '<div class="stats"><div class="stat"><b>' + (st['補點'] || 0) + '</b>補點</div><div class="stat"><b>' + (st['參考點'] || 0) + '</b>參考點</div>' +
      '<div class="stat' + (st['圖根點不符'] ? ' warn' : '') + '"><b>' + (st['圖根點'] || 0) + '</b>圖根點' + (st['圖根點不符'] ? '<br>⚠ ' + st['圖根點不符'] + ' 點不符' : '') + '</div></div>';
    h += '<div class="small">段：' + esc((r.sections || []).map(secName).join('、') || '（看不出來）') + '</div>';
    var order = { error: 0, warn: 1, ok: 2, info: 3 };
    (r.report || []).slice().sort(function (a, b) { return order[a[0]] - order[b[0]]; }).forEach(function (m) {
      h += '<div class="msg ' + m[0] + '">' + ({ error: '❌ ', warn: '⚠ ', ok: '✅ ', info: 'ℹ ' }[m[0]] || '') + esc(m[1]) + '</div>';
    });
    if ((r.points || []).length) {
      h += '<details><summary>看點位清單（' + r.points.length + ' 點）</summary><div class="small">' + r.points.slice(0, 300).map(function (p) {
        return esc(p.kind + ' ' + p.name + '　' + f3(p.y) + ', ' + f3(p.x));
      }).join('<br>') + '</div></details>';
    }
    $('preview').innerHTML = h;
  }
  function preview() {
    busy(true, '讀取檔案中…');
    payload().then(function (body) { return api('/api/preview', body); }).then(function (r) {
      busy(false);
      $('u3').classList.remove('hidden');
      renderPreview(r);
      var nothing = !(r.stats['補點'] || r.stats['參考點'] || r.stats['控制點'] || r.stats['圖根點'] || r.stats['設站']);
      $('doUpload').disabled = nothing;
      $('doUpload').textContent = nothing ? '沒有可以上傳的資料' : '✅ 沒問題，上傳！';
      $('u3').scrollIntoView({ behavior: 'smooth' });
    }).catch(function (e) { busy(false); if (e.message !== 'no name') toast(e.message); });
  }
  $('who').addEventListener('keydown', function (e) { if (e.key === 'Enter' && pending.length) preview(); });
  $('doUpload').onclick = function () {
    busy(true, '上傳中…');
    payload().then(function (body) { return api('/api/upload', body); }).then(function (r) {
      busy(false);
      toast('上傳完成！謝謝 ' + $('who').value.trim(), 4000);
      resetUpload();
      return loadField().then(function () { showBatch(r.batch); });
    }).catch(function (e) { busy(false); toast(e.message); });
  };
  function resetUpload() { pending = []; $('picked').innerHTML = ''; $('note').value = ''; $('u3').classList.add('hidden'); $('preview').innerHTML = ''; }
  $('cancelUpload').onclick = resetUpload;

  // ── 管理 ──
  var ISSUE_TEXT = { samename: '同名不同點', spread: '各段坐標不一致', local: '假設坐標', zero: '坐標是 0', bad: '看不懂的行', datum: '看不出 67 或 97' };
  var issues = null;
  function renderAdmin() {
    var i = S.info, secs = i.sections || [];
    var parcels = secs.reduce(function (a, s) { return a + s.parcels; }, 0);
    var miss = secs.filter(function (s) { return s.missing; });
    $('baseInfo').innerHTML = '<h3>數值地籍圖</h3><div class="stats"><div class="stat"><b>' + secs.length + '</b>段</div><div class="stat"><b>' + parcels.toLocaleString() +
      '</b>筆地號</div><div class="stat"><b>' + (i.ctl.points || 0).toLocaleString() + '</b>圖根點</div></div>' +
      '<div class="small">' + (miss.length ? '有 ' + miss.length + ' 段的 BNP 用到 COA 裡沒有的點號（' + esc(miss.slice(0, 5).map(function (s) { return s.section + ' ' + s.missing + ' 個'; }).join('、')) + '），那些邊畫不出來。' : '') + '</div>';
    var dm = i.datum || {}, s67 = dm.sec67 || [];
    $('datumInfo').innerHTML = '<div class="small">目前 <b>' + s67.length + '</b> 段是 TWD67，已換成 97。換算參數用 67 段跟旁邊 97 段<b>共同的界址點</b>算（' + esc(dm.global || '') +
      '）。' + (dm.configured ? '（管理者指定的清單）' : '（段名表紅字 + 自動偵測）') + '</div>' +
      '<div class="small">圖根點每一行各自判斷：67 ' + ((dm.ctl || {}).TWD67 || 0).toLocaleString() + ' 行、97 ' + ((dm.ctl || {}).TWD97 || 0).toLocaleString() +
      ' 行、看不出來 ' + ((dm.ctl || {})['?'] || 0).toLocaleString() + ' 行（大份 CTL 是好幾段共用的，67、97 混在一起）。</div>' +
      secs.filter(function (s) { return s.datum_warn; }).map(function (s) { return '<div class="msg warn">' + esc(secName(s.section) + '：' + s.datum_warn) + '</div>'; }).join('');
    $('sec67').value = s67.map(function (c) { return c + ' ' + ((i.section_names || {})[c] || ''); }).join('\n');
    $('datumTable').innerHTML = '<table class="dt"><tr><th>段</th><th>系統</th><th>依據</th></tr>' + secs.map(function (s) {
      return '<tr><td>' + esc(secName(s.section)) + '</td><td>' + (s.datum === 'TWD67' ? '<b style="color:#d92d20">67</b>' : '97') + '</td><td class="small">' +
        esc([s.datum_src, s.transform, s.datum_warn].filter(Boolean).join('；')) + '</td></tr>';
    }).join('') + '</table>';
    $('secAbolished').value = (i.abolished || []).join('\n');
    $('tol').value = i.tolerance_cm;
    $('secNames').value = Object.keys(i.section_names || {}).map(function (k) { return k + '=' + i.section_names[k]; }).join('\n');
    var c = i.ctl;
    $('ctlSummary').innerHTML = '<div class="small">所有 .CTL 共 ' + (c.lines || 0).toLocaleString() + ' 行（各段重複很多），整理後是 <b>' + (c.points || 0).toLocaleString() + '</b> 個點。</div>' +
      Object.keys(c.issues || {}).map(function (k) { return '<div class="msg warn">' + esc(ISSUE_TEXT[k] || k) + '：' + c.issues[k] + '</div>'; }).join('');
    if (!secs.length) { $('issues').innerHTML = ''; return; }
    if (!issues) api('/api/ctl_issues').then(function (d) { issues = d; drawIssues(); }); else drawIssues();
  }
  function drawIssues() {
    var t = $('issueType').value;
    var list = issues.filter(function (x) { return !t || x.type === t; });
    $('issues').innerHTML = list.slice(0, 300).map(function (x, k) {
      return '<div class="issue" data-i="' + k + '"><b>' + esc(x.name) + '</b>　' + esc(x.msg) + '<br><span class="small">' + esc(x.section) + '</span></div>';
    }).join('') + (list.length > 300 ? '<div class="small">只列前 300 筆，全部請下載 CSV</div>' : '');
    Array.prototype.forEach.call($('issues').querySelectorAll('.issue'), function (d) {
      d.onclick = function () {
        var x = list[+d.getAttribute('data-i')];
        var p = S.controls.filter(function (c) { return c.id === x.id || (!x.id && c.name === x.name); })[0];
        if (p) flyTo(p.ll, 18, ctlPopup(p)); else toast('這筆沒有坐標可以看');
      };
    });
  }
  $('issueType').onchange = drawIssues;
  $('saveCfg').onclick = function () {
    var names = {};
    $('secNames').value.split(/\n/).forEach(function (l) { var m = /^\s*([A-Za-z]{2}\d{4})\s*[=,，:：\s]\s*(.+?)\s*$/.exec(l); if (m) names[m[1].toUpperCase()] = m[2]; });
    busy(true, '儲存中…');
    api('/api/config', { tolerance_cm: parseFloat($('tol').value) || 2, section_names: names })
      .then(function () { busy(false); toast('已儲存'); return loadInfo().then(renderAdmin); })
      .catch(function (e) { busy(false); toast(e.message); });
  };
  function save67(list) {
    busy(true, '重新換算坐標中，大約要一分鐘…');
    api('/api/config', { twd67_sections: list, progress: progressTo('重新換算') }).then(function () { busy(false); restart(); })
      .catch(function (e) { busy(false); toast(e.message); });
  }
  $('save67').onclick = function () {
    var list = ($('sec67').value.match(/[A-Za-z]{2}\d{4}|\b\d{4}\b/g) || []).map(function (c) { return /^\d/.test(c) ? 'KC' + c : c.toUpperCase(); });
    if (!confirm('把這 ' + list.length + ' 段當成 TWD67 重新換算？')) return;
    save67(list);
  };
  $('saveAbolished').onclick = function () {
    var list = ($('secAbolished').value.match(/[A-Za-z]{2}\d{4}|\b\d{4}\b/g) || []).map(function (c) { return /^\d/.test(c) ? 'KC' + c : c.toUpperCase(); });
    if (!confirm('把這 ' + list.length + ' 段當成廢段（不顯示），重新整理底圖？')) return;
    busy(true, '重新整理底圖中，大約要一分鐘…');
    api('/api/config', { abolished_sections: list, progress: progressTo('重新整理底圖') }).then(function () { busy(false); restart(); })
      .catch(function (e) { busy(false); toast(e.message); });
  };
  $('auto67').onclick = function () { if (confirm('改回「段名表紅字 + 自動偵測」？')) save67(null); };
  $('pickXlsx').onclick = function () { $('xlsxInput').click(); };
  $('xlsxInput').onchange = function () {
    var f = this.files[0]; this.value = '';
    if (!f) return;
    busy(true, '讀取段名表…');
    f.arrayBuffer().then(function (b) { return api('/api/section_names/xlsx', { bytes: new Uint8Array(b) }); })
      .then(function (r) { busy(false); toast('匯入 ' + r.count + ' 個段名'); return loadInfo().then(renderAdmin); })
      .catch(function (e) { busy(false); toast(e.message); });
  };
  function baseUpload(list) {
    var ok = list.filter(function (x) { return /\.(coa|bnp|par|ctl|zip)$/i.test(x.path); });
    if (!ok.length) { toast('沒有 COA / BNP / PAR / CTL 或 zip 檔'); return; }
    if (!confirm('要用這 ' + ok.length + ' 個檔案更新數值地籍圖嗎？\n（大約要 1 分鐘，過程中不要關網頁）')) return;
    busy(true, '讀取檔案中…');
    Local.fileListToItems(ok).then(function (items) { return api('/api/base/upload', { items: items, progress: progressTo('更新底圖') }); })
      .then(function () { busy(false); toast('底圖已更新'); restart(); })
      .catch(function (e) { console.error(e); busy(false); toast('失敗：' + e.message, 8000); });
  }
  $('basePickDir').onclick = function () { $('baseDir').click(); };
  $('basePickFile').onclick = function () { $('baseFile').click(); };
  $('baseDir').onchange = function () { baseUpload(Array.prototype.map.call(this.files, function (f) { return { path: f.webkitRelativePath || f.name, file: f }; })); this.value = ''; };
  $('baseFile').onchange = function () { baseUpload(Array.prototype.map.call(this.files, function (f) { return { path: f.name, file: f }; })); this.value = ''; };
  $('baseRebuild').onclick = function () {
    busy(true, '重新整理底圖中…');
    api('/api/base/rebuild', { progress: progressTo('重新整理底圖') }).then(function () { busy(false); restart(); }).catch(function (e) { busy(false); toast(e.message); });
  };

  // ── 圖例 ──
  Array.prototype.forEach.call(document.querySelectorAll('#legend [data-layer]'), function (c) {
    c.onchange = function () { show[c.getAttribute('data-layer')] = c.checked; refreshAll(); };
  });
  if (window.innerWidth < 760) { $('legendBody').classList.add('hidden'); $('legendToggle').textContent = '＋'; }
  $('legendToggle').onclick = function () { var b = $('legendBody'); b.classList.toggle('hidden'); this.textContent = b.classList.contains('hidden') ? '＋' : '－'; };
  $('baseLayer').value = store('base') || 'emap';
  $('baseLayer').onchange = function () { setBase(this.value); };
  setBase($('baseLayer').value);
  $('onlyWho').onchange = function () { S.onlyWho = this.value; refreshField(); };
  $('locate').onclick = function () {
    if (!navigator.geolocation) return toast('這台裝置不能定位');
    navigator.geolocation.getCurrentPosition(function (p) {
      var ll = [p.coords.latitude, p.coords.longitude];
      map.flyTo(ll, 18);
      layers.hl.clearLayers();
      L.circleMarker(ll, { radius: 10, color: '#fff', weight: 3, fillColor: '#1f6feb', fillOpacity: 1 }).addTo(layers.hl);
    }, function () { toast('定位失敗（要允許瀏覽器使用位置，而且網址要是 https 或 localhost）'); }, { enableHighAccuracy: true, timeout: 10000 });
  };

  // ───────────────────────── 載入 ─────────────────────────
  function loadInfo() {
    return api('/api/info').then(function (i) { S.info = i; drawSectionBoxes(); });
  }
  function loadField() {
    return api('/api/field').then(function (d) {
      S.field = d;
      usedByCtl = {};
      d.used.forEach(function (u) { if (u.ctl_id) (usedByCtl[u.ctl_id] = usedByCtl[u.ctl_id] || []).push(u); });
      var sel = $('onlyWho'), cur = sel.value, whos = {};
      d.batches.slice().reverse().forEach(function (b) { whos[b.surveyor] = 1; colorOf(b.surveyor); });
      sel.innerHTML = '<option value="">看全部人的資料</option>' + Object.keys(whos).map(function (w) { return '<option' + (w === cur ? ' selected' : '') + '>只看 ' + esc(w) + '</option>'; }).join('');
      Array.prototype.forEach.call(sel.options, function (o, k) { o.value = k ? Object.keys(whos)[k - 1] : ''; });
      sel.value = cur;
      refreshField();
      if ($('p-recent').classList.contains('on')) renderBatches();
    });
  }
  // 下載按鈕（共用資料夾版沒有網址可以連，改成按了才產生檔案）
  Array.prototype.forEach.call(document.querySelectorAll('[data-act]'), function (b) {
    b.onclick = function () { busy(true, '準備檔案中…'); api(b.getAttribute('data-act')).then(function () { busy(false); }, function (e) { busy(false); toast(e.message); }); };
  });

  var EMPTY_INFO = { sections: [], ctl: {}, datum: {}, section_names: {}, abolished: [], tolerance_cm: 2 };
  function start() {
    $('connect').classList.add('hidden');
    $('folderName').textContent = '📁 ' + Local.folderName();
    busy(true, '載入地圖資料中…');
    return api('/api/info').then(function () { return loadInfo(); }).then(function () {
      var secs = S.info.sections.filter(function (s) { return s.bbox; });
      if (secs.length) {
        var b = L.latLngBounds([]);
        secs.forEach(function (s) { b.extend([s.bbox[0], s.bbox[1]]); b.extend([s.bbox[2], s.bbox[3]]); });
        map.fitBounds(b);
      }
      return Promise.all([api('/api/controls').then(function (c) { S.controls = c; }), loadField()]);
    }).then(function () { busy(false); refreshAll(); window.__started = (window.__started || 0) + 1; }).catch(function (e) {
      busy(false);
      if (e.data && e.data.nobase) {
        S.info = EMPTY_INFO; S.controls = [];
        loadField().catch(function () {});
        openPanel('admin');
        toast('共用資料夾裡還沒有底圖：請按「更新數值地籍圖」把數值資料夾或 zip 放進來（只要做一次）', 10000);
        return;
      }
      toast('載入失敗：' + e.message, 8000);
    });
  }
  function restart() {
    S.secCache = {}; S.secLoading = {}; issues = null;
    Object.keys(layers).forEach(function (k) { layers[k].clearLayers(); });
    closeSide();
    return start();
  }
  function showConnect(state) {
    $('connect').classList.remove('hidden');
    $('connectAgain').classList.toggle('hidden', state !== 'need-click');
    $('connectAgain').textContent = '📂 連接共用資料夾（上次是「' + (Local.lastName || '') + '」）';
    $('connectNew').textContent = state === 'need-click' ? '選別的資料夾' : '📂 選共用資料夾';
    $('connectNew').className = state === 'need-click' ? 'ghost' : 'go';
    $('connectFirst').classList.toggle('hidden', state === 'need-click');
  }
  $('connectAgain').onclick = function () { Local.connect(false).then(start).catch(function (e) { if (e.name !== 'AbortError') toast(e.message); }); };
  $('connectNew').onclick = function () { Local.connect(true).then(start).catch(function (e) { if (e.name !== 'AbortError') toast(e.message); }); };
  $('switchFolder').onclick = function () { Local.connect(true).then(restart).catch(function () {}); };
  if (!window.showDirectoryPicker) {
    $('connect').classList.remove('hidden');
    $('connectBox').innerHTML = '<h2>這個瀏覽器不能用</h2><p>請用 <b>Microsoft Edge</b> 或 <b>Google Chrome</b> 打開這個檔案。</p>';
  } else {
    Local.tryResume().then(function (st) { if (st === 'ok') start(); else showConnect(st); }).catch(function () { showConnect('none'); });
  }
  // 每 2 分鐘自動更新別人上傳的資料
  setInterval(function () { if (!document.hidden && S.info) loadField().catch(function () {}); }, 120000);
})();
