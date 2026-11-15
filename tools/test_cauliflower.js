'use strict';
// Pinned port provenance, input requirements and upstream offline behavior.
// All upstream suites use fake transports; none connect to a vehicle.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'localized/cauliflower');
const plan = require(path.join(vendor, 'release-plan.json'));
for (const id of Object.keys(plan)) {
    const pkg = path.join(root, 'apps', id, 'package');
    const provenance = require(path.join(pkg, 'PROVENANCE.json'));
    assert.strictEqual(provenance.commit, 'b2880634eb214e29f008422b970cf22ea2de280f');
    assert.strictEqual(provenance.upstreamVersion, plan[id].upstreamVersion);
    for (const name of Object.keys(provenance.adaptedSourceFilesSha256)) {
        assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, name))).digest('hex'),
            provenance.adaptedSourceFilesSha256[name], id + ': source hash ' + name);
    }
    const release = require(path.join(root, 'apps', id, 'release.json'));
    assert.strictEqual(release.requires['mgu-render'], '0.6.24');
    assert.strictEqual(release.requires['mgu-inputgate'], '1.1.1');
    assert.strictEqual(release.requires.robertn_store, '0.9.45');
    const spec = require(path.join(pkg, 'javascript/kit/app-spec.json'));
    for (const setting of spec.settings || []) {
        if (setting.key === 'demo') assert.strictEqual(setting.default, 'off');
    }
    const credits = require(path.join(pkg, 'javascript/kit/credits'));
    assert(credits);
    assert(!require(path.join(pkg, 'javascript/kit/locale.json')).credit);
}
const input = require('../native/mgu-inputgate/component.json');
assert.deepStrictEqual(input.restart, [], 'Installing input support must not restart the HMI');
assert.deepStrictEqual(input.dropins.map((d) => d.unit), ['hmi.service']);
const suites = [
    'runtime', 'live_data', 'live_adjustments', 'live_adjustments_exhaust', 'xdrive_live',
    'engine', 'bm3_protocol', 'edrive', 'warmup', 'service', 'service_engine',
    'brake_test', 'draggy', 'gforce', 'redline_call', 'widget_fixes',
];
for (const name of suites) {
    const p = cp.spawnSync(process.execPath, [path.join(vendor, 'kit/tools/test_' + name + '.js')],
        { encoding: 'utf8', timeout: 90000 });
    assert.strictEqual(p.status, 0, name + '\n' + p.stdout + p.stderr);
    console.log('PASS upstream offline suite: ' + name);
}
console.log('PASS 15 ported packages: source hashes, dependencies, real-data defaults and no watermark');
