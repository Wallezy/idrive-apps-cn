'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'apps/sys_monitor');
const kit = path.join(app, 'package/javascript/kit');
const i18n = require(path.join(kit, 'i18n'));
const words = require('../localized/system-monitor/translations.zh-CN.json');
const fonts = require(path.join(kit, 'fonts'));
for (const key of Object.keys(words)) {
    const text = words[key];
    assert.strictEqual(i18n.t(key), text, key);
    const font = fonts.get('label', 24, text);
    for (const char of text) {
        if (char.codePointAt(0) > 127) {
            assert(font.glyphs[char.codePointAt(0)], 'Missing Chinese glyph: ' + char);
        }
    }
}
const release = require(path.join(app, 'release.json'));
assert.deepStrictEqual(release.mguHmi, ['ID7']);
assert(release.requires['mgu-render']);
assert(!release.requires['idrive7-renderd']);
assert.strictEqual(release.requires['mgu-inputgate'], '1.2.2');
assert.strictEqual(require(path.join(kit, 'app-spec.json')).title, '系统监控');
assert(!require(path.join(kit, 'locale.json')).credit);
const render = fs.readFileSync(path.join(kit, 'renderd.js'), 'utf8');
assert(render.includes("['/run/mgu-render/render.sock',"), 'Use maintained CN renderer socket first');
assert(!fs.existsSync(path.join(app, 'package/javascript/app.js')));
console.log('PASS system monitor Chinese labels/glyphs, ID7 source package and CN renderer/input dependencies');
