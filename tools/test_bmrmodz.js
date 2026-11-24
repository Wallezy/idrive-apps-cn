'use strict';
// Run the shipped app pages with real Chinese drawing code and offline vehicle interfaces.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const Module = require('module'), cp = require('child_process');
if (!process.argv[2]) {
    for (const id of ['osa', 'dpf', 'spritmonitor']) {
        const result = cp.spawnSync(process.execPath, [__filename, path.join(__dirname, '../apps', id)],
            {stdio: 'inherit', timeout: 30000});
        assert.strictEqual(result.status, 0, id);
    }
} else {
    const app = path.resolve(process.argv[2]), id = path.basename(app);
    const js = path.join(app, 'package/javascript'), kit = path.join(js, 'kit');
    const spec = require(path.join(kit, 'app-spec.json'));
    const {Recorder, play, atlasById} = require(path.join(kit, 'record'));
    const {Canvas} = require(path.join(kit, 'canvas'));
    const fonts = require(path.join(kit, 'fonts')), {t} = require(path.join(kit, 'i18n'));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmrmodz-ui-'));
    const callbacks = {}, actions = {}, clicks = {}, warnings = [], labels = [];
    const schema = JSON.parse(JSON.stringify(spec.settings));
    const values = Object.fromEntries(schema.map(s => [s.key, s.default]));
    const changes = [];
    const settings = {
        schema, values, item: key => schema.find(s => s.key === key), get: key => values[key],
        set(key, value) { values[key] = value; changes.forEach(fn => fn(key, value)); },
        onChange(fn) { changes.push(fn); }, onAction(key, fn) { actions[key] = fn; },
        shown(s) { return !s.hidden && (!s.when || values[s.when.key] === s.when.value); },
        display(key) {
            const s = this.item(key), option = s.options && s.options.find(o => o[0] === values[key]);
            return option ? option[1] : String(values[key] == null ? '' : values[key]);
        },
        cycle() {},
    };
    const log = {info() {}, warn: message => warnings.push(String(message)),
        error(message) { throw new Error(String(message)); }};
    let frame, tab, tick, scroll, pageName = 'main', impl, frames = 0, glyphs = 0, targets = 0;
    const originalText = Recorder.prototype.text;
    Recorder.prototype.text = function(text, x, y, size, color, opts) {
        const shown = opts && opts.literal ? String(text) : t(text);
        labels.push(shown);
        for (const c of shown) if (/[\u3400-\u9fff]/.test(c)) {
            assert(fonts.get(opts && opts.font || 'label', size, shown).glyphs[c.codePointAt(0)],
                id + ': missing glyph ' + c);
            glyphs++;
        }
        return originalText.apply(this, arguments);
    };
    const context = {
        spec, settings, log, dataDir: temp, hideButton() {}, setButtonVisible() {},
        signals: {async watch() { return {}; }},
        theme: () => require(path.join(kit, 'themes')).theme('m_tricolour'),
        canvas(w, h) {
            frame = new Recorder(w, h); frame.own = true;
            frame.target = () => { targets++; };
            return frame;
        },
        ui: {
            text() {}, selected() {}, checked() {}, visible() {},
            comp: () => ({getStringBundle: () => ({setStrings: async () => {}})}),
            onClick(key, fn) { clicks[key] = fn; }, onVisible() {}, isVisible: () => true,
            async image() {
                assert(frame && frame.n > 0, 'nonempty frame'); frames++;
                for (const a of frame.atlases) assert(atlasById(a).atlasH <= 512);
                if (process.env.BMRMODZ_PREVIEW_DIR) {
                    fs.mkdirSync(process.env.BMRMODZ_PREVIEW_DIR, {recursive: true});
                    const canvas = new Canvas(frame.w, frame.h);
                    play(frame.u.subarray(0, frame.n), canvas);
                    fs.writeFileSync(path.join(process.env.BMRMODZ_PREVIEW_DIR, id + '-' + pageName + '.png'), canvas.png());
                }
            },
        },
        onTab(fn) { tab = fn; }, onScroll(fn) { scroll = fn; }, loop(_name, _fps, fn) { tick = fn; },
    };
    const load = Module._load, interval = global.setInterval, timers = [];
    Module._load = function(request, parent) {
        if (parent && parent.filename === path.join(js, 'localized-entry.js')) {
            if (request === './app.js') return {};
            if (request === './kit/mgu') return {run: value => { impl = value; }};
            if (request === './kit/car') return class {
                data() { return {rpm: 800, speed: 0, oil: 60, coolant: 70, sample: 1, demo: false}; }
                onSample() {}
            };
            if (request === './transmission') return class {
                constructor() { this.statusText = 'Waiting for data'; this.error = ''; this.fresh = false; }
                setVisible() {} async init() {}
            };
            if (request === './kit/readonly-diag') return {ReadOnlyDiag: class {
                init() { return new Promise(() => {}); }
            }};
        }
        if (request === './kit/car-equipment') return {
            check: async () => ({ok: true, results: {'6WB': true, '6U3': false}}),
        };
        if (request === 'net' || request === 'http' || request === 'https') {
            // Socket and web access are unexpected during an unconfigured app's UI test.
            return new Proxy({}, {get(_target, key) {
                return () => { throw new Error('Unexpected external I/O: ' + request + '.' + String(key)); };
            }});
        }
        return load.apply(this, arguments);
    };
    global.setInterval = fn => { timers.push(fn); return {unref() {}}; };
    (async () => {
        try {
            require(path.join(js, 'localized-entry.js'));
            await impl.start(context); await Promise.resolve(); await tick();
            const pages = id === 'osa' ? ['engine', 'transmission', 'statistics', 'settings', 'about'] :
                id === 'dpf' ? ['overview', 'detail', 'settings', 'about'] : ['my-car', 'about'];
            for (let i = 0; i < pages.length; i++) {
                pageName = pages[i]; await tab(i); await tick();
                if (pages[i] === 'settings' && scroll) {
                    for (let n = 0; n < schema.length; n++) { scroll(1); await tick(); }
                }
            }
            assert(frames >= pages.length);
            assert(glyphs > 100, 'Chinese visible UI rendered');
            assert(targets > 0, 'canvas controls generated');
            assert(!warnings.some(s => /first render|TypeError|ReferenceError|Unexpected external/.test(s)), warnings.join('\n'));
            for (const c of Object.values(require(path.join(kit, 'locale.json')).strings).join('')) {
                if (/[\u3400-\u9fff]/.test(c)) assert(fonts.get('label', 24, c).glyphs[c.codePointAt(0)], 'catalog glyph ' + c);
            }
            require('../apps/robertn_waze_cluster/tools/check_rhmi').check(path.join(app, 'package/rhmiData/uiDescriptions/ID7'));
            assert.strictEqual(require(path.join(kit, 'i18n')).getLanguage(), 'zh-CN');
            console.log(`${id}: ${pages.length} pages, ${frames} frames, ${glyphs} Chinese glyphs, ${targets} input targets; offline start and settings passed`);
        } finally {
            Module._load = load; global.setInterval = interval; Recorder.prototype.text = originalText;
            fs.rmSync(temp, {recursive: true, force: true});
        }
    })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
