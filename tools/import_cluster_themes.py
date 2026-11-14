#!/usr/bin/env python3
"""Regenerate the pinned Cluster Themes source package without a BMW SDK or network."""
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCAL = ROOT / 'localized/cluster-themes'
sys.path.insert(0, str(LOCAL / 'kit/tools'))
import build
from localize import localize_spec


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    provenance = json.loads((LOCAL / 'provenance.json').read_text())
    version = provenance['releaseVersion']
    spec = json.loads((LOCAL / 'apps/cluster_themes/app.json').read_text())
    assert spec['version'] == provenance['upstreamVersion']
    words = json.loads((LOCAL / 'kit/runtime/locales/zh-CN.json').read_text())
    words.update(dict(line.split('\t', 1) for line in
                      (LOCAL / 'translations.zh-CN.tsv').read_text().splitlines() if line))
    # These are theme names, also used in screenshots and troubleshooting.
    for name in ['GT3', 'M', 'Sport', 'Minimal', 'Roadster', 'Track', 'Drag', 'Rally',
                 'Retro 80s', 'Cruise', 'Dyno', 'Ribbon']:
        words[name] = name
    write(LOCAL / 'kit/runtime/locales/zh-CN.json', words)
    build.localize_spec = lambda value, language: dict(localize_spec(value, language), version=version)
    with tempfile.TemporaryDirectory(prefix='mgu-cluster-themes-') as temp:
        build.DIST = temp
        build.build('cluster_themes', 'zh-CN', include_sdk=False)
        app = ROOT / 'apps/cluster_themes'
        app.mkdir(exist_ok=True)
        package = app / 'package'
        if package.exists():
            shutil.rmtree(package)
        shutil.copytree(pathlib.Path(temp) / 'cluster_themes/source', package)
        shutil.rmtree(package / 'node_modules')
        entry = package / 'javascript/app.js'
        body = entry.read_text()
        entry.unlink()
        (package / 'javascript/localized-entry.js').write_text("require('./app.js');\n" + body)
        shutil.copy2(LOCAL / 'shared/page_locale.js', package / 'javascript/page_locale.js')
        runtime = package / 'javascript/kit/mgu.js'
        runtime.write_text(runtime.read_text().replace("require('oap-sdk')", 'global.__mguLocalizedSdk'))
        pkg = json.loads((package / 'package.json').read_text())
        pkg.update(main='javascript/localized-entry.js', mguLocalOnly=True, license='MIT',
                   description='12 套仪表主题，支持驾驶模式切换、自定义数据及 Waze 地图。中控操作简体中文，保留原版仪表风格。',
                   files=['package.json', 'npm-shrinkwrap.json', 'manifest.json', 'permissions.json',
                          'config', 'javascript', 'rhmiData', 'LICENSE', 'MPL-2.0.txt', 'NOTICE', 'NOTICE.zh-CN.md',
                          'provenance.json', 'CHANGELOG.md'])
        write(package / 'package.json', pkg)
        for name in ['LICENSE', 'NOTICE.zh-CN.md', 'provenance.json']:
            shutil.copy2(LOCAL / name, package / name)
        shutil.copy2(ROOT / 'LICENSES/MPL-2.0.txt', package / 'MPL-2.0.txt')
        shutil.copy2(LOCAL / 'apps/cluster_themes/NOTICE', package / 'NOTICE')
        (package / 'CHANGELOG.md').write_text(
            '# 仪表主题\n\n## Unreleased\n\n## ' + version + '\n\n'
            '- 新增 12 套仪表主题，中控设置与操作提示适度汉化。\n'
            '- 保留原版主题名称、仪表风格和单位，支持国内源在线更新。\n\n'
            '上游版本：' + provenance['upstreamVersion'] + '；CN 修订：1。\n')
        (app / 'src').mkdir(exist_ok=True)
        shutil.copy2(ROOT / 'apps/warmup/src/sdk.js', app / 'src/sdk.js')
        write(app / 'mgu-app.json', {'schema': 1, 'id': 'cluster_themes', 'version': version,
              'tree': 'package', 'modules': ['src/sdk.js'],
              'sdk': ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging']})
        write(app / 'release.json', {'build': 'node ../../tools/build_localized.js',
              'requires': {'mgu-deploy': '0.8.18', 'mgu-render': '0.6.19', 'cluster-render': '0.5.9'},
              'uninstallable': True, 'mguHmi': ['ID7']})
        write(app / 'release-notes.json', [{
            'version': version, 'upstreamVersion': provenance['upstreamVersion'],
            'cnRevision': provenance['cnRevision'],
            'changes': ['新增 12 套仪表主题，中控设置与操作提示适度汉化。',
                        '保留原版主题名称、仪表风格和单位，支持国内源在线更新。'],
        }])
    path = ROOT / 'release/repo.json'
    repo = json.loads(path.read_text())
    repo['unprefixedAppIds'] = sorted(set(repo['unprefixedAppIds']) | {'cluster_themes'})
    write(path, repo)
    path = ROOT / 'release/cn-localization-versions.json'
    baseline = json.loads(path.read_text())
    baseline['components']['cluster_themes'] = version
    write(path, baseline)
    for path in (ROOT / 'release/texts').glob('*.json'):
        texts = json.loads(path.read_text())
        texts['cluster_themes'] = {
            'title': '仪表主题 (Cluster Themes)' if path.stem == 'zh-CN' else 'Cluster Themes (简体中文)',
            'description': pkg['description'] if path.stem == 'zh-CN' else
            '12 instrument cluster themes with Chinese centre-screen controls. Original theme names and instrument styling preserved.',
        }
        write(path, texts)


if __name__ == '__main__':
    main()
