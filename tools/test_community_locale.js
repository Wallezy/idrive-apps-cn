'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const app = path.resolve(process.argv[2]);
const spec = JSON.parse(fs.readFileSync(path.join(app, 'mgu-app.json')));
const pkg = path.join(app, spec.tree);
const provenance = JSON.parse(fs.readFileSync(path.join(pkg, 'PROVENANCE.json')));
assert(provenance.sourceArtifact.sha256.match(/^[a-f0-9]{64}$/));
assert(fs.readFileSync(path.join(pkg, 'NOTICE.zh-CN.md'), 'utf8').includes('版权'));
const kit = path.join(pkg, 'javascript/kit');
if (fs.existsSync(kit)) {
    const i18n = require(path.join(kit, 'i18n'));
    assert.strictEqual(i18n.getLanguage(), 'zh-CN');
    assert.strictEqual(i18n.t('rpm'), 'rpm');
    assert(!i18n.t('RAM 麦克风校准').includes('undefined'));
    const locale = JSON.parse(fs.readFileSync(path.join(kit, 'locale.json')));
    assert(!locale.credit);
    const credit = require(path.join(kit, 'credits'));
    assert.strictEqual(credit.CREDIT, '');
    credit.drawCredit({ text() { throw Error('promotional watermark drawn'); } });
    const fonts = require(path.join(kit, 'fonts'));
    const label = fonts.get('label', 32, '简体中文');
    assert(label && label.alpha && label.alpha.length === label.atlasW * label.atlasH);
    const strings = Object.values(locale.strings || {}).join('');
    const missing = [...new Set([...strings].filter(c => /[\u3400-\u9fff]/.test(c)
        && !label.glyphs[c.codePointAt(0)]))];
    assert.deepStrictEqual(missing, [], 'Chinese translation glyphs must exist');
    // Preserve signal identifiers; localisation is applied only at display time.
    assert.strictEqual(i18n.t('de.bmw.infotainment.vehicle.Vehicle2'), 'de.bmw.infotainment.vehicle.Vehicle2');
    const { HmiText } = require(path.join(kit, 'hmi-text'));
    if (HmiText) {
        const calls = [];
        const comp = { getStringBundle: () => ({ setStrings: async s => calls.push(['bundle', s]) }),
            setValue: async (...args) => calls.push(['value', ...args]) };
        new HmiText().set(comp, 'STATUS', 0, 'Text', '中文状态').then(() => {
            assert(calls.some(c => c[0] === 'bundle'), 'Chinese must use native string bundle');
            assert(calls.some(c => c[c.length - 1] === 'StringId'));
        }).catch(e => { console.error(e); process.exitCode = 1; });
    }
} else {
    const i18n = require(path.join(app, 'src/i18n'));
    assert.strictEqual(i18n.CREDIT, '');
    assert.strictEqual(typeof i18n.translate, 'function');
}
for (const hmi of fs.readdirSync(path.join(pkg, 'rhmiData/uiDescriptions'))) {
    const file = path.join(pkg, 'rhmiData/uiDescriptions', hmi, 'uiDescription.json');
    if (!fs.existsSync(file)) continue;
    const ui = JSON.parse(fs.readFileSync(file));
    for (const container of Object.values(ui.containers || {})) {
        for (const component of Object.values(container.components || {})) {
            assert(!/^CREDIT_/.test(component.name || '') && component.name !== 'translationCredit');
        }
    }
}
console.log('Community package: source provenance, Chinese rendering resources and promotional UI cleanup checked');
