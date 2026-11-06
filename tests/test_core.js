// 執行：node tests/test_core.js（共用資料夾版的核心，用合成資料測）
const assert = require('assert');
const Core = require('../nas/core.js');

function dbf(fields, rows) {
  const hlen = 32 + 32 * fields.length + 1, rlen = 1 + fields.reduce((a, f) => a + f[2], 0);
  const u8 = new Uint8Array(hlen + rlen * rows.length + 1), dv = new DataView(u8.buffer);
  u8[0] = 3; dv.setUint32(4, rows.length, true); dv.setUint16(8, hlen, true); dv.setUint16(10, rlen, true);
  fields.forEach((f, i) => { for (let k = 0; k < f[0].length; k++) u8[32 + i * 32 + k] = f[0].charCodeAt(k); u8[32 + i * 32 + 11] = f[1].charCodeAt(0); u8[32 + i * 32 + 16] = f[2]; });
  u8[hlen - 1] = 0x0D;
  rows.forEach((r, n) => {
    let s = ' ';
    fields.forEach(f => { const v = String(r[f[0]] == null ? '' : r[f[0]]); s += f[1] === 'N' ? v.padStart(f[2]) : v.padEnd(f[2]); });
    for (let k = 0; k < s.length; k++) u8[hlen + n * rlen + k] = s.charCodeAt(k);
  });
  u8[u8.length - 1] = 0x1A;
  return u8;
}

(async () => {
  // CTL：亂的格式
  const c = Core.parseCtl('KCK020000000\nBE20    219817.7712697345.532  \nB280-1\t 2698637.348216035.973  \nND06    2708646.221215456.1634A\nAL01    27496.932  3719.797    \n');
  assert.deepStrictEqual(c.map(p => [p.name, p.y, p.x, p.status]), [
    ['BE20', 2697345.532, 219817.771, 'ok'], ['B280-1', 2698637.348, 216035.973, 'ok'], ['ND06', 2708646.221, 215456.163, 'ok'], ['AL01', 27496.932, 3719.797, 'local']]);
  assert.strictEqual(Core.formatCtlLine('BE20', 2697345.532, 219817.771), 'BE20    2697345.532219817.771');
  assert.throws(() => Core.formatCtlLine('AL01', 27496.932, 3719.797));

  // 上傳：zip 裡有 D20、D14、L02、B90、資料夾外的 CSV
  const enc = new TextEncoder();
  const d20 = dbf([['CTL_NAME', 'C', 8], ['CTL_Y', 'N', 12], ['CTL_X', 'N', 11], ['CTL_LEVEL', 'C', 3]], [{ CTL_NAME: 'QW1', CTL_Y: '2704293.873', CTL_X: '218860.941', CTL_LEVEL: 'Q' }]);
  const d14 = dbf([['COT_NUMBER', 'N', 5], ['COT_REF', 'N', 2], ['COT_Y', 'N', 16], ['COT_X', 'N', 15]], [
    { COT_NUMBER: 5, COT_REF: 0, COT_Y: '2704277.49700000', COT_X: '218794.96200000' },
    { COT_NUMBER: 5, COT_REF: 30, COT_Y: '2704277.12300000', COT_X: '218794.45600000' }]);
  const b90 = '測    站: GGC33        2704237.454   218958.870\n標 定 點: BHC339       2704195.256   219064.445             113.696\n施 測 點: QW1          2704293.873   218860.941   188-09-39 113.019\n施 測 點: 2787         2704287.361   218863.153    41-17-28 6.877\n';
  const zip = Core.zipStore([
    { path: '383/KC1114/KC1114.D20', bytes: d20 }, { path: '383/KC1114/KC1114.D14', bytes: d14 },
    { path: '383/KC1114/KC1114.L02', text: 'PAGE 1/1\nBHC339       2704195.256   219064.445\n' },
    { path: '383/KC1114/KC0000.L02', text: 'BHC1  2704195.256   219064.445\n' },
    { path: '383/KC1114/1130416.B90', text: b90 }, { path: '383/11304161.CSV', text: 'GGC34,2704285.916,218877.333\n2,2704267.228,218819.283\n' }]);
  const files = await Core.expandZips([{ path: '383.zip', bytes: zip }]);
  const r = Core.parseFieldFiles(files);
  assert.deepStrictEqual(r.sections, ['KC1114']);
  assert.deepStrictEqual(r.points.map(p => [p.kind, p.name]).sort(), [['參考點', '5.30'], ['補點', 'QW1']]);
  assert.deepStrictEqual(r.used.map(u => u.name).sort(), ['BHC339', 'GGC33', 'GGC34']);
  assert.strictEqual(r.links.length, 1);
  assert.strictEqual(r.links[0].angle, '188-09-39');

  // 比對圖根點、67 段換算
  const ctlByName = { BHC339: [{ id: 'BHC339', name: 'BHC339', y: 2704195.296, x: 219064.445 }] };
  const T = new Core.Transform(null, '');
  const a = Core.analyzeUpload(r, { ctlByName, trans: { KC1114: T }, others: [], surveyor: 'A', tol: 0.02 });
  assert.strictEqual(a.stats['圖根點不符'], 1);
  assert.ok(a.points[0].orig, '67 段要留原始坐標');
  assert.ok(Math.abs(a.points.find(p => p.name === 'QW1').x - 218860.941 - 828) < 5, '近似公式換算');

  // 67 偵測：C 是 67，跟 97 段 A 共用邊界
  const shift = (y, x) => [y - 205.21 + 0.0000154 * (y - 2703000), x + 829.13 - 0.0000657 * (x - 217000)];
  const edge = []; for (let i = 0; i < 60; i++) edge.push([2703000 + Math.sin(i) * 0.3, 217000 + i * 6.1]);
  const inv = edge.map(p => { let y = p[0], x = p[1]; for (let k = 0; k < 5; k++) { const q = shift(y, x); y -= q[0] - p[0]; x -= q[1] - p[1]; } return [y, x]; });
  const det = Core.detectDatum({ KC0001: edge.concat([[2704000, 218000]]), KC0003: inv.concat([[2702000, 216000]]) });
  assert.deepStrictEqual(det.auto67, ['KC0003']);
  const tr = Core.buildTransforms(det, ['KC0003']).trans.KC0003, q = tr.apply(inv[10][0], inv[10][1]);
  assert.ok(Math.hypot(q[0] - edge[10][0], q[1] - edge[10][1]) < 0.02);

  // 地號清單
  const pl = Core.parseParcelList('123、124-1, 125之2\n1114 45');
  assert.deepStrictEqual(pl.parcels, [{ section: null, key: '123' }, { section: null, key: '124-1' }, { section: null, key: '125-2' }, { section: 'KC1114', key: '45' }]);

  // 只讀選的地號：D13 → D14 界址點，參考點取附近的；補點照清冊編號
  const d13 = dbf([['O_SECTION', 'N', 4], ['O_PARCEL', 'N', 4], ['O_PARCEL_E', 'N', 4], ['COORD_1', 'N', 5], ['COORD_2', 'N', 5], ['COORD_3', 'N', 5], ['COORD_4', 'N', 5]],
    [{ O_SECTION: 1114, O_PARCEL: 10, O_PARCEL_E: 0, COORD_1: 1, COORD_2: 2, COORD_3: 3, COORD_4: 0 }, { O_SECTION: 1114, O_PARCEL: 11, O_PARCEL_E: 0, COORD_1: 7, COORD_2: 8, COORD_3: 9, COORD_4: 0 }]);
  const d14b = dbf([['COT_NUMBER', 'N', 5], ['COT_REF', 'N', 2], ['COT_Y', 'N', 16], ['COT_X', 'N', 15]], [
    { COT_NUMBER: 1, COT_REF: 0, COT_Y: '2704000.000', COT_X: '218000.000' }, { COT_NUMBER: 2, COT_REF: 0, COT_Y: '2704010.000', COT_X: '218000.000' },
    { COT_NUMBER: 3, COT_REF: 0, COT_Y: '2704010.000', COT_X: '218010.000' }, { COT_NUMBER: 40, COT_REF: 30, COT_Y: '2704020.000', COT_X: '218005.000' },
    { COT_NUMBER: 41, COT_REF: 30, COT_Y: '2705000.000', COT_X: '218005.000' }]);
  const d20b = dbf([['CTL_NAME', 'C', 8], ['CTL_Y', 'N', 12], ['CTL_X', 'N', 11], ['CTL_LEVEL', 'C', 3]], [
    { CTL_NAME: 'Q1', CTL_Y: '2704050.000', CTL_X: '218050.000', CTL_LEVEL: 'Q' }, { CTL_NAME: 'Q2', CTL_Y: '2704060.000', CTL_X: '218060.000', CTL_LEVEL: 'Q' }]);
  const f2 = [{ path: 'KC1114/KC1114.D13', bytes: d13 }, { path: 'KC1114/KC1114.D14', bytes: d14b }, { path: 'KC1114/KC1114.D20', bytes: d20b }];
  const r2 = Core.parseFieldFiles(f2, { parcels: [{ section: null, key: '10' }, { section: null, key: '99' }], refBuffer: 50 });
  assert.strictEqual(r2.parcels[0].found, true); assert.strictEqual(r2.parcels[0].ring.length, 3);
  assert.strictEqual(r2.parcels[1].found, false);
  assert.deepStrictEqual(r2.points.filter(p => p.kind === '參考點').map(p => p.name), ['40.30']);   // 41.30 太遠
  const reg = { points: [{ name: 'QW5', y: 2704050.001, x: 218050.0, created: 0 }], maxNum: 57 };
  const a2 = Core.analyzeUpload(r2, { ctlByName: {}, trans: {}, others: [], surveyor: '林威帆', code: 'W', registry: reg, tol: 0.02, dupTol: 0.02 });
  assert.deepStrictEqual(a2.points.filter(p => p.kind === '補點').map(p => [p.name, p.orig_name, p.reg]), [['QW5', 'Q1', 'existing'], ['QW58', 'Q2', 'new']]);
  assert.strictEqual(a2.maxNum, 58);
  // 清冊：刪除的上傳不算點，但號碼不重用
  const bs = [{ id: 'a', surveyor: '林威帆', code: 'W', created: 1, points: [{ kind: '補點', name: 'QW1', y: 1, x: 1 }] },
    { id: 'b', surveyor: '林威帆', code: 'W', created: 2, deleted: true, points: [{ kind: '補點', name: 'QW2', y: 2, x: 2 }] }];
  const rg = Core.buildRegistry(bs, '林威帆', 'W');
  assert.deepStrictEqual([rg.points.map(p => p.name), rg.maxNum], [['QW1'], 2]);
  // 時間軸
  const h = Core.parcelHistory([{ id: 'x', surveyor: 'A', created: 5, caseType: '鑑界', parcels: [{ section: 'KC1114', parcel: '10', found: true, ring: [[2704000, 218000], [2704010, 218000], [2704010, 218010]] }] },
    { id: 'y', surveyor: 'B', created: 3, caseType: '分割', parcels: [{ section: 'KC1114', parcel: '10', found: true, ring: [[2704000, 218000], [2704010, 218000], [2704010, 218010]] }] }]);
  assert.deepStrictEqual(h['KC1114|10'].map(e => e.caseType), ['分割', '鑑界']);

  // 段轉換參數檔：六參數＋殘差內插，共同點上完全吻合；殘差大的點列為可疑
  const tr97 = (n, e) => [n - 205.26 + 0.0000135 * (n - 2700000) - 0.0000236 * (e - 216000), e + 829.14 - 0.0000386 * (n - 2700000) + 0.0000145 * (e - 216000)];
  const grid = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) grid.push([2699500 + i * 400 + (j % 2) * 37, 215200 + j * 450 + i * 23]);
  const inp = grid.map((g, k) => { const q = tr97(g[0], g[1]); const bump = k === 5 ? 0.06 : (k % 3 - 1) * 0.004; return 'P' + k + '  1  ' + (q[0] + bump).toFixed(3) + '  ' + q[1].toFixed(3) + '  ' + g[0].toFixed(3) + '  ' + g[1].toFixed(3); }).join('\n');
  const pp = Core.parseParamInp(inp);
  assert.strictEqual(pp.length, 16);
  assert.strictEqual(Core.sectionFromName('6effbaa1-367/367/計算成果/367.inp'), 'KC0367');
  const GT = Core.GpsTransform(pp, 'KC0367');
  pp.forEach(p => { const q = GT.apply(p.n67, p.e67); assert.ok(Math.hypot(q[0] - p.n97, q[1] - p.e97) < 0.0005, '共同點上要吻合'); });
  const reload = Core.Transform.from(JSON.parse(JSON.stringify(GT.toJSON())));
  const qa = GT.apply(2700100, 215700), qb = reload.apply(2700100, 215700);
  assert.ok(Math.hypot(qa[0] - qb[0], qa[1] - qb[1]) < 1e-6, '存檔後讀回來結果一樣');
  const ck = Core.checkParams(pp);
  assert.deepStrictEqual(ck.suspects, ['P5']);
  assert.strictEqual(ck.classes.reduce((a, b) => a + b, 0), 16 * 15 / 2);

  // 一份參數檔給好幾段、zip 裡有好幾份 .inp 時挑正式計算成果
  assert.deepStrictEqual(Core.sectionsFromPath('x/378、379、380/計算成果/1140819/380.inp'), ['KC0378', 'KC0379', 'KC0380']);
  assert.deepStrictEqual(Core.sectionsFromPath('KC0378_KC0379_KC0380.inp'), ['KC0378', 'KC0379', 'KC0380']);
  const enc2 = new TextEncoder(), line = (n, k) => n + '  1  ' + (2701000 + k * 100).toFixed(3) + '  ' + (214000 + k * 37).toFixed(3) + '  ' + (2701205 + k * 100).toFixed(3) + '  ' + (213171 + k * 37).toFixed(3);
  const picks = Core.pickParamFiles([
    { path: 'z/378、379、380/380.inp', bytes: enc2.encode([0, 1, 2, 3, 4].map(k => line('P' + k, k)).join('\n')) },
    { path: 'z/378、379、380/計算成果/1140723/380.inp', bytes: enc2.encode([0, 1, 2].map(k => line('P' + k, k)).join('\n')) },
    { path: 'z/378、379、380/計算成果/1140723/380.out', bytes: enc2.encode('x') },
    { path: 'z/378、379、380/計算成果/1140819/380.inp', bytes: enc2.encode([0, 1, 2, 3].map(k => line('P' + k, k)).join('\n')) },
    { path: 'z/378、379、380/計算成果/1140819/380.out', bytes: enc2.encode('x') },
    { path: 'z/378、379、380/計算成果/1140819/380_經緯度.inp', bytes: enc2.encode(line('P0', 0) + ' 24.1 120.3 50') }]);
  assert.strictEqual(picks.length, 1);
  assert.ok(/1140819\/380\.inp$/.test(picks[0].path));
  assert.deepStrictEqual(picks[0].alternatives.map(a => a.added.concat(a.removed)), [['P4'], ['P3']].sort().reverse() && picks[0].alternatives.map(a => a.added.concat(a.removed)));

  // 範圍資料夾、自己的資料夾優先、修正版資料夾
  assert.deepStrictEqual(Core.sectionsFromPath('346-353/成果解算/1140701_2/349.inp'), ['KC0346', 'KC0347', 'KC0348', 'KC0349', 'KC0350', 'KC0351', 'KC0352', 'KC0353']);
  assert.deepStrictEqual(Core.sectionsFromPath('370_375_376/375/計算成果/1140703_剔除HL129/375.inp'), ['KC0375']);
  assert.deepStrictEqual(Core.sectionsFromPath('e7d3daa0-370_375_376/計算成果/1140717/37001.inp'), ['KC0370', 'KC0375', 'KC0376']);
  const rv = Core.pickParamFiles([
    { path: 'q/375/計算成果/1140703/375.inp', bytes: enc2.encode([0, 1, 2, 3, 4].map(k => line('P' + k, k)).join('\n')) },
    { path: 'q/375/計算成果/1140703/375.out', bytes: enc2.encode('x') },
    { path: 'q/375/計算成果/1140703_剔除P4/375.inp', bytes: enc2.encode([0, 1, 2, 3].map(k => line('P' + k, k)).join('\n')) },
    { path: 'q/375/計算成果/1140703_剔除P4/375.out', bytes: enc2.encode('x') }]);
  assert.ok(/剔除P4/.test(rv[0].path), '同一天的修正版優先');
  assert.deepStrictEqual(Core.parseCtlFix('點名  改算前N 改算前E 改算後N 改算後E\nH395  2709655.123   216898.385   2709659.357   216899.038'),
    [{ name: 'H395', on: 2709655.123, oe: 216898.385, nn: 2709659.357, ne: 216899.038 }]);
  const far = Core.parseParamInp([0, 1, 2, 3, 4, 5].map(k => line('P' + k, k)).concat(['FAR  1  2694530.852  215008.487  2694736.314  214179.532']).join('\n'));
  assert.deepStrictEqual(Core.checkParams(far).isolated.map(x => x.name), ['FAR']);

  // zip 讀寫來回
  const back = await Core.unzip(Core.zipStore([{ path: '中文/a.txt', text: '測試' }]));
  assert.strictEqual(back[0].path, '中文/a.txt');
  assert.strictEqual(new TextDecoder().decode(back[0].bytes), '測試');
  console.log('core.js 測試全部通過');
})().catch(e => { console.error(e); process.exit(1); });
