'use strict';
// Source-package contract and real Chinese runtime checks; no firmware required.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');
const link = require('./oap_link');
const root = path.resolve(__dirname, '..');
const ids = require('../release/repo.json').unprefixedAppIds;
const imports = require('../release/community-import-plan.json').apps;
const community = new Set(imports.map(x => x.id));
const iterio = new Set(['iteriodev_turnview', 'oap-driverecorder-next']);
const bmrmodz = new Set(['osa', 'dpf', 'spritmonitor']);
const linkedUnits = new Set(imports.filter(x => x.format === 'unit').map(x => x.id));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-localized-'));
try {
    for (const id of ids) {
        const app = path.join(root, 'apps', id);
        const manifest = link.readManifest(app);
        const tree = path.join(app, manifest.tree);
        const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json')));
        const release = JSON.parse(fs.readFileSync(path.join(app, 'release.json')));
        assert.strictEqual(pkg.name, id);
        assert.strictEqual(pkg.version, manifest.version);
        assert.strictEqual(pkg.mguLocalOnly, true);
        assert.deepStrictEqual(release.mguHmi, ['ID7']);
        assert.strictEqual(release.requires['mgu-deploy'], id === 'sys_monitor' ? '0.8.25' :
            id === 'cluster_metrics' ? '0.8.23' : iterio.has(id) || bmrmodz.has(id) ? '0.8.28' : '0.8.18');
        if (linkedUnits.has(id) || iterio.has(id)) {
            assert(['javascript/app.js', 'javascript/runner.js'].includes(pkg.main));
            assert(manifest.modules.length > 0);
            for (const module of manifest.modules) assert(fs.existsSync(path.join(app, module)));
        } else {
            assert(fs.existsSync(path.join(tree, pkg.main)));
        }
        assert(!fs.existsSync(path.join(tree, 'javascript/app.js')));
        const files = link.packSource(app, path.join(tmp, id + '.tgz'));
        assert(files.every((f) => !/(^|\/)(oap-sdk|node_modules)(\/|$)|javascript\/app\.js$/.test(f)));
        const first = fs.readFileSync(path.join(tmp, id + '.tgz'));
        link.packSource(app, path.join(tmp, id + '.tgz'));
        assert(first.equals(fs.readFileSync(path.join(tmp, id + '.tgz'))), 'deterministic source package');
        assert(zlib.gunzipSync(first).length > 0);
        const kit = path.join(tree, 'javascript/kit');
        const suite = bmrmodz.has(id) ? 'tools/test_bmrmodz.js' : iterio.has(id) ? 'tools/test_iterio.js' : id === 'sys_monitor' ? 'tools/test_system_monitor.js' :
            community.has(id) ? 'tools/test_community_locale.js' : id === 'ambient_config' ? 'tools/test_ambient.js' :
            id === 'cluster_themes' ? 'tools/test_cluster_themes.js' : id === 'cluster_metrics' ? 'tools/test_cluster_metrics.js' : 'localized/kit/tools/test_zh.js';
        const result = cp.spawnSync(process.execPath, [path.join(root, suite), community.has(id) || iterio.has(id) || bmrmodz.has(id) ? app : kit],
            { encoding: 'utf8', timeout: 30000 });
        assert.strictEqual(result.status, 0, id + ': ' + result.stdout + result.stderr);
        if (fs.existsSync(kit)) assert.strictEqual(require(path.join(kit, 'i18n')).getLanguage(), 'zh-CN');
        console.log('PASS ' + id + '@' + manifest.version + ': source package, Chinese resources and metrics');
    }
    const wad = fs.readFileSync(path.join(root, 'apps/doom/package/javascript/freedoom1.wad'));
    assert.strictEqual(crypto.createHash('sha256').update(wad).digest('hex'),
        '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
