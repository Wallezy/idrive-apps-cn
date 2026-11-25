'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const { contributorsOf } = require('../release/contributors');
const { components, catalogEntry, retext } = require('../release/release');
const records = require('../release/contributors.json').components;
const all = components();
assert.deepStrictEqual(Object.keys(records).sort(), all.map((c) => c.id).sort(), 'all published components have reviewed records');
for (const c of all) {
    assert.deepStrictEqual(contributorsOf(records[c.id]), records[c.id], c.id + ': validated metadata');
    const author = records[c.id].filter((x) => x.role === 'author').map((x) => x.name).join(' / ');
    assert.strictEqual(c.author, author);
    const file = path.join(root, c.dir, c.kind === 'app' ? 'package/package.json' : 'component.json');
    assert.deepStrictEqual(catalogEntry(c, file).contributors, records[c.id], c.id + ': catalog credits');
    if (c.kind !== 'app') continue;
    const packageDir = path.join(root, c.dir, 'package');
    const attribution = JSON.parse(fs.readFileSync(path.join(packageDir, 'ATTRIBUTION.json')));
    assert.strictEqual(attribution.component, c.id);
    assert.deepStrictEqual(attribution.contributors, records[c.id], c.id + ': shipped credits match the catalog');
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')));
    assert(pkg.files.includes('ATTRIBUTION.json') && pkg.files.includes('CONTRIBUTORS.zh-CN.md'));
}
function people(id, role) { return records[id].filter((c) => c.role === role).map((c) => c.name).join(' / '); }
assert(people('ram_mic_calibration', 'author').includes('小白151'), 'RAM original author retained');
assert(people('dpf_monitor', 'author').includes('alexp50'), 'shared kit does not replace the app author');
assert(people('dpf_monitor', 'translation').includes('小白151'), 'reused translation is credited');
assert.strictEqual(people('sys_monitor', 'translation'), 'Wallezy', 'the app-specific dictionary has its own translator');
for (const id of ['osa', 'dpf', 'spritmonitor']) {
    assert.strictEqual(people(id, 'translation'), '', 'upstream multilingual resources are not claimed as our translation');
}
for (const id of ['iteriodev_turnview', 'oap-driverecorder-next', 'iteriodev-turnview', 'iteriodev-drplay']) {
    assert(!JSON.stringify(records[id]).includes('Wallezy'), 'Iterio credits have no distribution branding');
}
const stale = [{ id: all[0].id, version: all[0].version, artifact: { sha256: 'a'.repeat(64) } }];
assert.strictEqual(retext(stale, all).length, 1, 'metadata can accompany unchanged artifacts');
assert.deepStrictEqual(stale[0].contributors, records[all[0].id]);
assert.strictEqual(stale[0].artifact.sha256, 'a'.repeat(64), 'metadata leaves artifact identity intact');
assert.strictEqual(retext(stale, all).length, 0, 'metadata updates are idempotent');
const strings = JSON.parse(fs.readFileSync(path.join(root,
    'apps/sys_monitor/package/rhmiData/variantGroups/Common/texts/en_GB.json')));
assert.strictEqual(strings.SID_SYS_MONITOR_CN_CREDITS_LINK, 'Wallezy');
assert.strictEqual(strings.SID_SYS_MONITOR_REPO_CREDITS_LINK, 'hexlay');
console.log('attribution: 40 component records, 33 shipped app records, role boundaries and metadata updates pass');
