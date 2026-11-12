// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/* Every CN release uses its reviewed numeric component versions. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const baseline = read('release/cn-localization-versions.json');
const chinese = read('release/texts/zh-CN.json');
const found = {};
const checked = [];

assert.strictEqual(baseline.schema, 1);
assert(/^[a-f0-9]{40}$/.test(baseline.sourceCommit));
function version(id, value, file) {
    assert.strictEqual(value, baseline.components[id], `${file}: localization must keep ${id}'s reviewed version`);
    assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), `${file}: numeric x.y.z version`);
    checked.push(file);
}

for (const dir of fs.readdirSync(path.join(root, 'native'))) {
    const file = `native/${dir}/component.json`;
    if (!fs.existsSync(path.join(root, file))) {
        continue;
    }
    const component = read(file);
    version(component.id, component.version, file);
    found[component.id] = component.version;
}
for (const dir of fs.readdirSync(path.join(root, 'apps'))) {
    const file = `apps/${dir}/mgu-app.json`;
    if (!fs.existsSync(path.join(root, file))) {
        continue;
    }
    const component = read(file);
    version(component.id, component.version, file);
    found[component.id] = component.version;
    const staged = `apps/${dir}/${component.tree}`;
    for (const name of ['package.json', 'npm-shrinkwrap.json']) {
        version(component.id, read(`${staged}/${name}`).version, `${staged}/${name}`);
    }
    const application = `${staged}/rhmiData/application.json`;
    version(component.id, read(application).application.version, application);
}
assert.deepStrictEqual(found, baseline.components, 'The localization baseline must cover every component');
assert.deepStrictEqual(Object.keys(chinese).sort(), Object.keys(found).sort(), 'Every catalog component needs Chinese text');
for (const [id, text] of Object.entries(chinese)) {
    assert.deepStrictEqual(Object.keys(text).sort(), ['description', 'title']);
    for (const [field, maximum] of [['title', 80], ['description', 1000]]) {
        const value = text[field];
        assert(typeof value === 'string' && value.trim() === value && value.length <= maximum, `${id}.${field}: release limits`);
        assert(/[\u4e00-\u9fff]/.test(value) && !/\ufffd|[\r\n]/.test(value), `${id}.${field}: valid Chinese single-line text`);
    }
}
console.log(`CN catalog: ${Object.keys(found).length} components translated; ${checked.length} version fields consistent`);
