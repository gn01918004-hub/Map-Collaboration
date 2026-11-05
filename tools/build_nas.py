# -*- coding: utf-8 -*-
"""把共用資料夾版打包成一個 HTML 檔：dist/地籍共作平台.html（Leaflet、程式、段名全部包進去）

執行：python tools/build_nas.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*p):
    with open(os.path.join(ROOT, *p), encoding='utf-8') as f:
        return f.read()


def main():
    html = read('nas', 'index.html')
    css = read('web', 'vendor', 'leaflet', 'leaflet.css') + '\n' + read('nas', 'style.css')
    names = json.load(open(os.path.join(ROOT, 'server', 'section_names.json'), encoding='utf-8'))
    scripts = [
        read('web', 'vendor', 'leaflet', 'leaflet.js'),
        'window.DEFAULT_SECTION_NAMES = ' + json.dumps(names, ensure_ascii=False) + ';',
        read('nas', 'core.js'),
        read('nas', 'store.js'),
        read('nas', 'app.js'),
    ]
    for s in scripts:
        if '</script' in s.lower():
            raise SystemExit('程式裡有 </script>，不能直接包進 HTML')
    html = html.replace('<!--CSS-->', '<style>\n' + css + '\n</style>')
    html = html.replace('<!--JS-->', '\n'.join('<script>\n' + s + '\n</script>' for s in scripts))
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    out = os.path.join(ROOT, 'dist', '地籍共作平台.html')
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print('已產生', out, '%.0f KB' % (os.path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
