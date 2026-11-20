#!/usr/bin/env python3
"""Build the pinned Cluster Metrics CN source package, without a BMW SDK."""
import json
import pathlib
import shutil
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCAL = ROOT / 'localized/cluster-metrics'
sys.path.insert(0, str(LOCAL / 'kit/tools'))
import build
from localize import localize_spec


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    provenance = json.loads((LOCAL / 'provenance.json').read_text())
    version = provenance['releaseVersion']
    spec = json.loads((LOCAL / 'apps/cluster_metrics/app.json').read_text())
    assert spec['version'] == provenance['upstreamVersion']
    words = dict(line.split('\t', 1) for line in
                 (LOCAL / 'translations.zh-CN.tsv').read_text().splitlines() if line)
    write(LOCAL / 'kit/runtime/locales/zh-CN.json', words)
    build.localize_spec = lambda value, language: dict(localize_spec(value, language), version=version)
    with tempfile.TemporaryDirectory(prefix='mgu-cluster-metrics-') as temp:
        build.DIST = temp
        build.build('cluster_metrics', 'zh-CN', omit_sdk=True)
        app = ROOT / 'apps/cluster_metrics'
        app.mkdir(exist_ok=True)
        package = app / 'package'
        if package.exists():
            shutil.rmtree(package)
        shutil.copytree(pathlib.Path(temp) / 'cluster_metrics/source', package)
        entry = package / 'javascript/app.js'
        body = entry.read_text()
        entry.unlink()
        (package / 'javascript/localized-entry.js').write_text("require('./app.js');\n" + body)
        runtime = package / 'javascript/kit/mgu.js'
        runtime.write_text(runtime.read_text().replace("require('oap-sdk')", 'global.__mguLocalizedSdk'))
        pkg = json.loads((package / 'package.json').read_text())
        pkg.update(main='javascript/localized-entry.js', mguLocalOnly=True, license='GPL-3.0-only',
                   description='在仪表或抬头显示上查看能耗、温度、电量与挡位，支持导航叠加。简体中文设置；首次使用需手动开启。',
                   files=['package.json', 'npm-shrinkwrap.json', 'manifest.json', 'permissions.json',
                          'config', 'javascript', 'rhmiData', 'LICENSE', 'KIT-LICENSE', 'MPL-2.0.txt',
                          'NOTICE', 'APACHE-2.0.txt', 'NOTICE.zh-CN.md', 'provenance.json', 'CHANGELOG.md'])
        write(package / 'package.json', pkg)
        for name in ['LICENSE', 'APACHE-2.0.txt', 'NOTICE.zh-CN.md', 'provenance.json']:
            shutil.copy2(LOCAL / name, package / name)
        shutil.copy2(LOCAL / 'kit/LICENSE', package / 'KIT-LICENSE')
        shutil.copy2(ROOT / 'LICENSES/MPL-2.0.txt', package / 'MPL-2.0.txt')
        shutil.copy2(LOCAL / 'apps/cluster_metrics/NOTICE', package / 'NOTICE')
        changes = ['新增 HUD 跟车距离、车内温度与电量信息。', '改进挡位和右侧媒体、行程显示，保留中文歌名与导航路名。']
        (package / 'CHANGELOG.md').write_text(
            '# 组合仪表数据\n\n## Unreleased\n\n## ' + version + '\n\n' +
            '\n'.join('- ' + x for x in changes) + '\n\n上游：' +
            provenance['upstreamVersion'] + '；CN 修订：1。\n')
        (app / 'src').mkdir(exist_ok=True)
        shutil.copy2(ROOT / 'apps/warmup/src/sdk.js', app / 'src/sdk.js')
        write(app / 'mgu-app.json', {
            'schema': 1, 'id': 'cluster_metrics', 'version': version, 'tree': 'package',
            'modules': ['src/sdk.js'],
            'sdk': ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging']})
        write(app / 'release.json', {
            'build': 'node ../../tools/build_localized.js',
            'requires': {'mgu-deploy': '0.8.23', 'cluster-render': '0.6.7'},
            'uninstallable': True, 'mguHmi': ['ID7']})
        write(app / 'release-notes.json', [{
            'version': version, 'upstreamVersion': provenance['upstreamVersion'],
            'cnRevision': provenance['cnRevision'], 'changes': changes}])
        notes_path = ROOT / 'release/notes.json'
        notes = json.loads(notes_path.read_text())
        notes['cluster_metrics'] = json.loads((app / 'release-notes.json').read_text())
        write(notes_path, notes)
    path = ROOT / 'release/repo.json'
    repo = json.loads(path.read_text())
    repo['unprefixedAppIds'] = sorted(set(repo['unprefixedAppIds']) | {'cluster_metrics'})
    write(path, repo)
    path = ROOT / 'release/cn-localization-versions.json'
    baseline = json.loads(path.read_text())
    baseline['components']['cluster_metrics'] = version
    write(path, baseline)
    for path in (ROOT / 'release/texts').glob('*.json'):
        texts = json.loads(path.read_text())
        texts['cluster_metrics'] = {
            'title': '组合仪表数据',
            'description': '在仪表或抬头显示上查看能耗、温度、电量与挡位，支持导航叠加。简体中文设置；首次使用需手动开启。' if path.stem == 'zh-CN' else
            'Cluster and HUD telemetry with Chinese controls. Enable manually after choosing a display.',
        }
        write(path, texts)


if __name__ == '__main__':
    main()
