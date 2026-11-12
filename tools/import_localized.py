#!/usr/bin/env python3
"""Stage the owner's Chinese applications as SDK-free Store source packages."""
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCAL = ROOT / 'localized'
sys.path.insert(0, str(LOCAL / 'kit/tools'))
import build
from localize import localize_spec


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    selected = sys.argv[1:] or sorted(p.parent.name for p in (LOCAL / 'apps').glob('*/app.json'))
    translations = json.loads((ROOT / 'release/texts/zh-CN.json').read_text())
    baseline = json.loads((ROOT / 'release/cn-localization-versions.json').read_text())
    with tempfile.TemporaryDirectory(prefix='mgu-cn-apps-') as temp:
        build.DIST = temp
        for identity in selected:
            spec = json.loads((LOCAL / 'apps' / identity / 'app.json').read_text())
            localized = localize_spec(spec, 'zh-CN')
            parts = list(map(int, spec['version'].split('.')))
            parts[2] += 1
            version = '.'.join(map(str, parts))
            build.localize_spec = lambda value, language, v=version: dict(localize_spec(value, language), version=v)
            build.build(identity, 'zh-CN', include_sdk=False)
            app = ROOT / 'apps' / identity
            app.mkdir(exist_ok=True)
            package = app / 'package'
            if package.exists():
                shutil.rmtree(package)
            shutil.copytree(pathlib.Path(temp) / identity / 'source', package)
            entry = package / 'javascript/app.js'
            text = entry.read_text()
            entry.unlink()
            (package / 'javascript/localized-entry.js').write_text("require('./app.js');\n" + text)
            runtime = package / 'javascript/kit/mgu.js'
            runtime.write_text(runtime.read_text().replace("require('oap-sdk')", 'global.__mguLocalizedSdk'))
            pkg = json.loads((package / 'package.json').read_text())
            pkg.update(main='javascript/localized-entry.js', mguLocalOnly=True,
                       license='MIT' if identity != 'doom' else 'GPL-2.0-only',
                       files=['package.json', 'npm-shrinkwrap.json', 'manifest.json', 'permissions.json',
                              'config', 'javascript', 'rhmiData', 'LICENSE', 'NOTICE.zh-CN.md'])
            write(package / 'package.json', pkg)
            shutil.copy2(LOCAL / 'LICENSE', package / 'LICENSE')
            shutil.copy2(LOCAL / 'NOTICE.zh-CN.md', package / 'NOTICE.zh-CN.md')
            (package / 'CHANGELOG.md').write_text('# ' + localized['title'] + '\n\n## ' + version + '\n\n固定简体中文界面；SDK 由车机 donor 链接，保留原有汉化署名。\n')
            (app / 'src').mkdir(exist_ok=True)
            (app / 'src/sdk.js').write_text("'use strict';\nconst online = require('oap-sdk/src/core/OnlineApp.js');\nconst logging = require('oap-sdk/src/logging/logging');\nglobal.__mguLocalizedSdk = { OnlineApp: online.OnlineApp || online, logging: logging.logging || logging };\n")
            write(app / 'mgu-app.json', {'schema': 1, 'id': identity, 'version': version,
                  'tree': 'package', 'modules': ['src/sdk.js'],
                  'sdk': ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging']})
            write(app / 'release.json', {'build': 'node ../../tools/build_localized.js',
                  'requires': {'mgu-deploy': '0.8.18'}, 'uninstallable': True, 'mguHmi': ['ID7']})
            baseline['components'][identity] = version
            translations.setdefault(identity, {'title': localized['title'],
                'description': localized['title'] + '，简体中文菜单、设置与提示。'})
    write(ROOT / 'release/repo.json', {'unprefixedAppIds': sorted(set(selected) | set(json.loads((ROOT / 'release/repo.json').read_text()).get('unprefixedAppIds', []) if (ROOT / 'release/repo.json').exists() else []))})
    write(ROOT / 'release/texts/zh-CN.json', translations)
    write(ROOT / 'release/cn-localization-versions.json', baseline)


if __name__ == '__main__':
    main()
