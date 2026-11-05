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

  // zip 讀寫來回
  const back = await Core.unzip(Core.zipStore([{ path: '中文/a.txt', text: '測試' }]));
  assert.strictEqual(back[0].path, '中文/a.txt');
  assert.strictEqual(new TextDecoder().decode(back[0].bytes), '測試');
  console.log('core.js 測試全部通過');
})().catch(e => { console.error(e); process.exit(1); });
