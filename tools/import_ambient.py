#!/usr/bin/env python3
"""Stage the pinned Ambient app and its matching runtime as a Chinese source package."""
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCAL = ROOT / 'localized/ambient'
sys.path.insert(0, str(LOCAL / 'kit/tools'))
import build
from localize import localize_spec


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    provenance = json.loads((LOCAL / 'provenance.json').read_text())
    version = provenance['releaseVersion']
    spec = json.loads((LOCAL / 'apps/ambient_config/app.json').read_text())
    assert spec['version'] == provenance['upstreamVersion']
    words = json.loads((LOCAL / 'kit/runtime/locales/zh-CN.json').read_text())
    words.update(json.loads((LOCAL / 'translations.zh-CN.json').read_text()))
    write(LOCAL / 'kit/runtime/locales/zh-CN.json', words)
    (LOCAL / 'kit/runtime/locales/zh-CN.tsv').write_text(
        '# English<TAB>简体中文。只用于显示文本，不改协议字段或设置值。\n'
        + ''.join(key + '\t' + value + '\n' for key, value in words.items()))
    build.localize_spec = lambda value, language: dict(localize_spec(value, language), version=version)
    with tempfile.TemporaryDirectory(prefix='mgu-ambient-') as temp:
        build.DIST = temp
        build.build('ambient_config', 'zh-CN', include_sdk=False)
        app = ROOT / 'apps/ambient_config'
        app.mkdir(exist_ok=True)
        package = app / 'package'
        if package.exists():
            shutil.rmtree(package)
        shutil.copytree(pathlib.Path(temp) / 'ambient_config/source', package)
        shutil.rmtree(package / 'node_modules')
        entry = package / 'javascript/app.js'
        text = entry.read_text()
        entry.unlink()
        (package / 'javascript/localized-entry.js').write_text("require('./app.js');\n" + text)
        runtime = package / 'javascript/kit/mgu.js'
        runtime.write_text(runtime.read_text().replace("require('oap-sdk')", 'global.__mguLocalizedSdk'))
        pkg = json.loads((package / 'package.json').read_text())
        pkg.update(main='javascript/localized-entry.js', mguLocalOnly=True, license='MIT',
                   description='自定义氛围灯颜色、亮度和动画，按驾驶模式切换并保存收藏。',
                   files=['package.json', 'npm-shrinkwrap.json', 'manifest.json', 'permissions.json',
                          'config', 'javascript', 'rhmiData', 'LICENSE', 'NOTICE.zh-CN.md',
                          'provenance.json', 'CHANGELOG.md'])
        write(package / 'package.json', pkg)
        for name in ['LICENSE', 'NOTICE.zh-CN.md', 'provenance.json']:
            shutil.copy2(LOCAL / name, package / name)
        (package / 'CHANGELOG.md').write_text(
            '# 氛围灯设置\n\n## Unreleased\n\n## ' + version + '\n\n'
            '- 新增完整简体中文界面与状态提示。\n'
            '- 支持从国内商店安装和在线更新。\n\n'
            '上游版本：' + provenance['upstreamVersion'] + '；CN 修订：1。\n')
        (app / 'src').mkdir(exist_ok=True)
        shutil.copy2(ROOT / 'apps/warmup/src/sdk.js', app / 'src/sdk.js')
        write(app / 'mgu-app.json', {'schema': 1, 'id': 'ambient_config', 'version': version,
              'tree': 'package', 'modules': ['src/sdk.js'],
              'sdk': ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging']})
        write(app / 'release.json', {'build': 'node ../../tools/build_localized.js',
              'requires': {'mgu-deploy': '0.8.18', 'mgu-render': '0.6.19'}, 'uninstallable': True, 'mguHmi': ['ID7']})
        write(app / 'release-notes.json', [{
            'version': version, 'upstreamVersion': provenance['upstreamVersion'],
            'cnRevision': provenance['cnRevision'],
            'changes': ['新增完整简体中文界面与状态提示。', '支持从国内商店安装和在线更新。'],
        }])
    path = ROOT / 'release/repo.json'
    repo = json.loads(path.read_text())
    repo['unprefixedAppIds'] = sorted(set(repo['unprefixedAppIds']) | {'ambient_config'})
    write(path, repo)
    path = ROOT / 'release/cn-localization-versions.json'
    baseline = json.loads(path.read_text())
    baseline['components']['ambient_config'] = version
    write(path, baseline)
    path = ROOT / 'release/texts/zh-CN.json'
    texts = json.loads(path.read_text())
    texts['ambient_config'] = {'title': '氛围灯设置',
                              'description': '自定义氛围灯颜色、亮度和动画，按驾驶模式切换并保存收藏。简体中文界面，支持国内源在线更新。'}
    write(path, texts)


if __name__ == '__main__':
    main()
