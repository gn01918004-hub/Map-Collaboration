# -*- coding: utf-8 -*-
"""執行：python -m unittest discover tests"""
import io
import os
import struct
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server'))
import parsers  # noqa: E402


def make_dbf(fields, rows):
    """fields: [(name, type, len, dec)]"""
    hlen = 32 + 32 * len(fields) + 1
    rlen = 1 + sum(f[2] for f in fields)
    h = bytearray(32)
    h[0] = 3
    h[4:8] = struct.pack('<I', len(rows))
    h[8:12] = struct.pack('<HH', hlen, rlen)
    for name, t, ln, dec in fields:
        fd = bytearray(32)
        fd[0:len(name)] = name.encode()
        fd[11] = ord(t)
        fd[16] = ln
        fd[17] = dec
        h += fd
    h += b'\r'
    for r in rows:
        rec = b' '
        for (name, t, ln, dec) in fields:
            v = str(r.get(name, ''))
            rec += (v.rjust(ln) if t == 'N' else v.ljust(ln)).encode()
        h += rec
    return bytes(h) + b'\x1a'


D20_FIELDS = [('CTL_NAME', 'C', 8, 0), ('CTL_Y', 'N', 12, 3), ('CTL_X', 'N', 11, 3), ('CTL_LEVEL', 'C', 3, 0)]
D14_FIELDS = [('COT_NUMBER', 'N', 5, 0), ('COT_REF', 'N', 2, 0), ('COT_Y', 'N', 16, 8), ('COT_X', 'N', 15, 8)]


class CtlTest(unittest.TestCase):
    def test_messy_lines(self):
        text = '\n'.join([
            'KCK020000000',
            'BDC347  2702678.552215848.4905 ',     # 尾巴有註記碼
            'B280-1\t 2698637.348216035.973  ',    # 點名裡有 tab
            'QHB186-12701422.114213923.583  ',     # 點名 8 字跟 Y 黏在一起
            'Q5A     3182.303   5000.000    ',     # 假設坐標
            'H484A   2706252.8510.000       ',     # X = 0
        ])
        r = parsers.parse_ctl(text)
        self.assertEqual([p['name'] for p in r], ['BDC347', 'B280-1', 'QHB186-1', 'Q5A', 'H484A'])
        self.assertAlmostEqual(r[0]['x'], 215848.490)
        self.assertEqual(r[0]['flag'], '5')
        self.assertEqual(r[2]['y'], 2701422.114)
        self.assertEqual(r[3]['status'], 'local')
        self.assertEqual(r[4]['status'], 'zero')

    def test_clean_same_name_different_points(self):
        e = lambda n, y, x, s: {'name': n, 'y': y, 'x': x, 'flag': '', 'status': 'ok', 'section': s, 'line': 2}
        pts, issues = parsers.clean_controls([
            e('A1', 2706015.152, 214841.649, 'KC0354'),
            e('A1', 2706015.152, 214841.649, 'KC0355'),
            e('A1', 2712300.262, 218320.284, 'KC0381'),   # 同名、相距數公里 → 不同點
            e('A103', 2722956.659, 222458.478, 'KC0354'),
            e('A103', 2722956.676, 222458.476, 'KC0381'),  # 差 1.7 cm → 同一點
            e('A103', 2722956.659, 222458.478, 'KC0355'),
        ])
        a1 = [p for p in pts if p['name'] == 'A1']
        self.assertEqual(len(a1), 2)
        self.assertEqual(sorted(p['id'] for p in a1), ['A1#1', 'A1#2'])
        a103 = [p for p in pts if p['name'] == 'A103']
        self.assertEqual(len(a103), 1)
        self.assertEqual((a103[0]['y'], a103[0]['x']), (2722956.659, 222458.478))   # 取多數
        self.assertGreater(a103[0]['spread'], 0.015)
        types = sorted(i['type'] for i in issues)
        self.assertIn('samename', types)
        self.assertIn('spread', types)


class CadastreTest(unittest.TestCase):
    def test_coa_bnp_par(self):
        coa = parsers.parse_coa('KC9999 1 500 3\n    1 2704480.54200000219713.247000003\n   12 2704267.22800000218819.283000000\n')
        self.assertEqual(coa['1'], (2704480.542, 219713.247))
        self.assertIn('12', coa)
        bnp = parsers.parse_bnp('KC9999 1300\n 120   4  1   3  2892  2893  2894\n 120   4  2   1  2897\n 121   0  1   1     5\n')
        self.assertEqual(bnp['120-4'], ['2892', '2893', '2894', '2897'])
        self.assertEqual(bnp['121'], ['5'])
        par = parsers.parse_par('KC9999  94711011 3 930\n'
                                '   1  119999   2509.99   1  11   2509.99C 02704729.9218416.8  0\n'
                                ' 129   0 308     69.00 129   0      0.00A 0      0.0     0.0  0\n')
        self.assertEqual(par['1-11']['area'], 2509.99)
        self.assertEqual(par['1-11']['use'], 'C')
        self.assertEqual(par['1-11']['cy'], 2704729.9)
        self.assertNotIn('cy', par['129'])

    def test_tm2(self):
        lat, lng = parsers.tm2_to_latlng(2704293.873, 218860.941)
        self.assertAlmostEqual(lat, 24.4446, places=3)
        self.assertAlmostEqual(lng, 120.6929, places=3)
        lat0, lng0 = parsers.tm2_to_latlng(0.0001, 250000)
        self.assertAlmostEqual(lng0, 121.0, places=6)


class FieldTest(unittest.TestCase):
    def build_zip(self):
        d20 = make_dbf(D20_FIELDS, [{'CTL_NAME': 'QW1', 'CTL_Y': '2704293.873', 'CTL_X': '218860.941', 'CTL_LEVEL': 'Q'}])
        d14 = make_dbf(D14_FIELDS, [
            {'COT_NUMBER': 5, 'COT_REF': 0, 'COT_Y': '2704277.49700000', 'COT_X': '218794.96200000'},
            {'COT_NUMBER': 5, 'COT_REF': 30, 'COT_Y': '2704277.12300000', 'COT_X': '218794.45600000'},
        ])
        l02 = 'PAGE 1/1\nBHC339       2704195.256   219064.445   \nGGC33        2704237.454   218958.870   \n'
        b90 = ('-- 協 助 指 界 計 算 --\n'
               '測    站: GGC33        2704237.454   218958.870\n'
               '標 定 點: BHC339       2704195.256   219064.445             113.696\n'
               '施 測 點: QW1          2704293.873   218860.941   188-09-39 113.019\n'
               '測    站: QW1          2704293.873   218860.941\n'
               '標 定 點: GGC33        2704237.454   218958.870             113.019\n'
               '施 測 點: 2787         2704287.361   218863.153    41-17-28 6.877\n').encode('cp950')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('383/KC1114/KC1114.D20', d20)
            z.writestr('383/KC1114/KC1114.D14', d14)
            z.writestr('383/KC1114/KC1114.L02', l02)
            z.writestr('383/KC1114/KC0000.L02', 'BHC1  2704195.256   219064.445\n')
            z.writestr('383/KC1114/1130416.B90', b90)
            z.writestr('383/KC1114/BOUNDARY.NTX', b'xx')
            z.writestr('383/11304161.CSV', 'GGC34,2704285.916,218877.333\n2,2704267.228,218819.283\n')
        return buf.getvalue()

    def test_parse_upload(self):
        r = parsers.parse_field_files([('383.zip', self.build_zip())])
        self.assertEqual(r['sections'], ['KC1114'])
        kinds = sorted((p['kind'], p['name']) for p in r['points'])
        self.assertEqual(kinds, [('參考點', '5.30'), ('補點', 'QW1')])
        used = sorted(u['name'] for u in r['used'])
        self.assertEqual(used, ['BHC339', 'GGC33', 'GGC34'])   # KC0000.L02 被略過、CSV 沒資料夾也歸到 KC1114
        self.assertEqual(len(r['links']), 1)                    # 只記錄打到補點的那條，界址點不記
        l = r['links'][0]
        self.assertEqual((l['station'], l['back'], l['target'], l['angle'], l['dist']), ('GGC33', 'BHC339', 'QW1', '188-09-39', 113.019))

    def test_zip_names(self):
        info = zipfile.ZipInfo('115-11-01#U6578#U503c/KC0308/KC0308.COA')
        self.assertEqual(parsers.zip_name(info), '115-11-01數值/KC0308/KC0308.COA')
        self.assertEqual(parsers.section_of('115-11-01數值/KC0308/KC0308.COA'), 'KC0308')
        self.assertEqual(parsers.section_of('x/KC1114/1130416.B90'), 'KC1114')
        self.assertIsNone(parsers.section_of('383/11304161.CSV'))


if __name__ == '__main__':
    unittest.main()
