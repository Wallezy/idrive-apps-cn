'use strict';
// Offline integration checks. Transport and timers are mocked: no vehicle calls.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const link = require('./oap_link');
const root = path.resolve(__dirname, '..');
const appPath = (id, file) => path.join(root, 'apps', id, 'package', 'javascript', file);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-edrive-dtc-'));
let count = 0;
function passed(name) { count++; console.log('PASS ' + name); }
function preview(name, canvas) {
    const png = canvas.png();
    assert(png.length > 1000 && png.slice(1, 4).toString() === 'PNG');
    if (process.env.MGU_PREVIEW_DIR) {
        fs.mkdirSync(process.env.MGU_PREVIEW_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.MGU_PREVIEW_DIR, name + '.png'), png);
    }
}

function load(file, overrides, clock) {
    const local = Module.createRequire(file);
    const module = { exports: {} };
    class ClockDate extends Date {
        static now() { return clock ? clock.now : Date.now(); }
    }
    const timers = clock ? clock.timers : [];
    const sandbox = {
        module, exports: module.exports, __dirname: path.dirname(file), __filename: file,
        Buffer, console, Date: ClockDate, Map, Set, Promise, Uint8Array, Uint8ClampedArray,
        process: { on() {}, env: {} },
        require(name) { return Object.prototype.hasOwnProperty.call(overrides || {}, name) ? overrides[name] : local(name); },
        setTimeout(fn, ms) { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
        clearTimeout(t) { if (t) t.cancelled = true; },
        setInterval(fn, ms) { const t = { fn, ms, recurring: true, cancelled: false }; timers.push(t); return t; },
        clearInterval(t) { if (t) t.cancelled = true; },
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    return module.exports;
}

async function main() {
    for (const id of ['edrive', 'dtc_scanner']) {
        const app = path.join(root, 'apps', id);
        const packageDir = path.join(app, 'package');
        const manifest = link.readManifest(app);
        const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json')));
        const shrink = JSON.parse(fs.readFileSync(path.join(packageDir, 'npm-shrinkwrap.json')));
        assert.strictEqual(pkg.version, manifest.version);
        assert.strictEqual(shrink.version, manifest.version);
        assert.strictEqual(pkg.main, 'javascript/localized-entry.js');
        assert.strictEqual(pkg.license, 'MIT');
        const provenance = JSON.parse(fs.readFileSync(path.join(packageDir, 'PROVENANCE.json')));
        assert.strictEqual(provenance.publicSource.commit, '8d860de5818a2da11d3a3750aab36866cecf6bde');
        assert.strictEqual(provenance.sourceLicense, 'MIT', 'License follows verified public source, not generated export metadata');
        assert(!fs.existsSync(path.join(packageDir, 'node_modules')));
        assert(!fs.existsSync(path.join(packageDir, 'javascript/app.js')));
        const source = path.join(temp, id + '.tgz');
        const files = link.packSource(app, source);
        assert(files.every((f) => !/(^|\/)(node_modules|oap-sdk|data)(\/|$)/.test(f)));
        if (id === 'dtc_scanner') {
            for (const required of ['javascript/diagnostic_i18n.pack', 'javascript/dtc_db.pack',
                'javascript/diagnostic-text.js', 'javascript/kit/fonts/cjk.json']) assert(files.includes('package/' + required), required);
        } else assert(files.includes('package/rhmiDataStartWidget/application.json'), 'Home widget is in the published source package');
        const first = fs.readFileSync(source);
        link.packSource(app, source);
        assert(first.equals(fs.readFileSync(source)), 'Source package is deterministic');
        const jsDir = path.join(packageDir, 'javascript');
        function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const file = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(file);
                else if (/\.js$/.test(file)) {
                    const text = fs.readFileSync(file, 'utf8');
                    new vm.Script(text, { filename: file });
                    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
                    for (const m of code.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
                        if (m[1] === './app.js' && /localized-entry\.js$/.test(file)) continue;
                        const target = path.resolve(path.dirname(file), m[1]);
                        // Optional private diagnostic overrides intentionally fall back.
                        if (['dtc_texts'].includes(path.basename(target))) continue;
                        assert([target, target + '.js', target + '.json'].some(fs.existsSync), file + ': missing ' + m[1]);
                    }
                }
            }
        }
        walk(jsDir);
        const i18n = require(path.join(jsDir, 'kit/i18n'));
        assert.strictEqual(i18n.getLanguage(), 'zh-CN');
        assert.strictEqual(i18n.t('Settings'), '设置');
        const config = JSON.parse(fs.readFileSync(path.join(jsDir, 'kit/app-spec.json')));
        assert.strictEqual(config.settings.find((s) => s.key === 'demo').default, 'off',
            'No simulated numbers on an unconnected vehicle unless demo is explicitly enabled');
        const rhmi = JSON.parse(fs.readFileSync(path.join(packageDir, 'rhmiData/application.json')));
        assert.strictEqual(rhmi.application.version, pkg.version);
        assert(rhmi.application.uiDescriptions.every((x) => x.hmi.length === 1 && x.hmi[0] === 'ID7'));
        passed(id + ': source package, syntax, dependency closure, language and version consistency');
    }

    const widget = JSON.parse(fs.readFileSync(path.join(root, 'apps/edrive/package/rhmiDataStartWidget/application.json')));
    assert.strictEqual(widget.application.type, 'StartWidget');
    for (const d of widget.application.uiDescriptions) {
        assert(fs.existsSync(path.join(root, 'apps/edrive/package/rhmiDataStartWidget', d.applicationFilePath)));
        assert(fs.existsSync(path.join(root, 'apps/edrive/package/rhmiDataStartWidget', d.uiDescriptionFilePath)));
    }
    const spec = require(appPath('edrive', 'kit/app-spec.json'));
    assert(spec.startWidget && spec.startWidget.image === 'BackgroundImage1');
    passed('eDrive home widget includes its layout and matching runtime specification');

    const { FastKw, FRESH_MS, MIN_FIT } = require(appPath('edrive', 'fastkw.js'));
    const fast = new FastKw();
    assert.strictEqual(fast.now(10000), null);
    for (let i = 0; i < 40; i++) {
        const at = 10000 + i * 500, drive = 5 + (i % 7) * 3, recup = i % 4 === 0 ? 5 : 0;
        fast.needle(drive, recup, at);
        fast.ac(0.5);
        fast.reading(1.5 * drive - 0.6 * recup + 1.3, at + 250);
        if (i + 1 < MIN_FIT) assert.strictEqual(fast.now(at + 250), null);
    }
    const at = 10000 + 39 * 500;
    assert(Number.isFinite(fast.now(at + 250)));
    assert(Math.abs(fast.now(at + 250) - (1.5 * (5 + (39 % 7) * 3) + 1.3)) < 0.5);
    assert.strictEqual(fast.now(at + FRESH_MS + 1), null, 'Stale needle must not look live');
    const n = fast.fit.n;
    fast.reading(NaN, at + 250);
    assert.strictEqual(fast.fit.n, n);
    passed('Fast power estimator requires calibration, fits known readings and rejects stale/invalid samples');

    const clock = { now: 1000000000, timers: [] }, log = { info() {}, warn() {}, error() {}, debug() {} };
    const L = { speed: 0, rpm: 0, rpmT: clock.now, left: false, x12: {}, x12T: {} };
    const state = { v12Pick: 0 }, requests = [], replies = [];
    const reader = {
        pick: {}, raws: {}, key: (c) => c.did,
        async read(c) { requests.push(c.did); return replies.length ? replies.shift() : null; },
    };
    const settings = { get(k) { return ({ demo: 'off', slowPoll: 5, scanUnit: '7', kwFast: 'fast', gaugeKw: 100 })[k]; }, onChange() {} };
    const context = { settings, log, dataDir: temp, spec: { config: { battery: { v12: [{ did: 'A' }, { did: 'B' }] } } } };
    const b12 = load(appPath('edrive', 'battery12.js'), {}, clock)(context, {
        diag: { available: true }, reader, exclusive: (fn) => fn(), st: state, save() {}, live: L,
        usingDemo: () => false, kind: () => 'none',
    });
    assert(b12.allowed(false));
    clock.now += 10 * 60000 + 1;
    assert(!b12.allowed(false), 'Parked without interaction stops reads');
    b12.touched(); assert(b12.allowed(false));
    L.left = true; assert(!b12.allowed(false), 'Locked/left suppresses background reads');
    L.left = false;
    replies.push(13.7); assert.strictEqual(await b12.readVolt(true), 13.7);
    replies.push(null, null, null, 14.1);
    await b12.readVolt(true); await b12.readVolt(true);
    assert.strictEqual(requests.join(','), 'A,A,A', 'Transient misses do not probe every ECU');
    assert.strictEqual(await b12.readVolt(true), 14.1);
    assert.strictEqual(requests.join(','), 'A,A,A,A,B');
    assert.strictEqual(state.v12Pick, 1);
    passed('12V diagnostics pause while idle/left and retain a working source through transient misses');

    class FittedPower {
        now() { return 12.5; }
        needle() {} ac() {} reading() {}
        get fit() { return { n: 10, err: 0.1 }; }
    }
    let estimatedBar;
    const live = load(appPath('edrive', 'live.js'), {
        './fastkw': { FastKw: FittedPower },
        './kit/gauges': Object.assign({}, require(appPath('edrive', 'kit/gauges')), {
            bar(cv, theme, x, y, w, h, value) { estimatedBar = value; },
        }),
    }, clock)(
        Object.assign({}, context, { spec: { config: { battery: {} } } }),
        { diag: { available: true, on() {} }, reader, exclusive: (fn) => fn(), live: L, page: () => 'battery', kind: () => 'phev' });
    const power = live.powerNow({ text: '#fff', dim: '#999', warn: '#f00' });
    assert.strictEqual(power.estimated, true);
    assert(power.text.startsWith('~') && power.label.includes('ESTIMATED'));
    live.drawPowerBar({}, {}, 0, 0, 740);
    assert(estimatedBar.label.includes('ESTIMATED') && estimatedBar.text.startsWith('~'),
        'The Range page bar explicitly identifies fitted power too');
    clock.now += 10 * 60000 + 1;
    assert.strictEqual(live.powerNow({ dim: '#999' }).kw, null);
    passed('Fast estimated power is labelled and hidden when the application becomes idle');

    const { Canvas: ECanvas } = require(appPath('edrive', 'kit/canvas'));
    const { Recorder: ERecorder, play: ePlay } = require(appPath('edrive', 'kit/record'));
    const etheme = require(appPath('edrive', 'kit/themes')).theme('m_tricolour');
    const defaults = Object.fromEntries(spec.settings.map((s) => [s.key, s.default]));
    let drawWidget;
    const demoContext = {
        dataDir: temp, log, spec, theme: () => etheme,
        settings: { get: (k) => k === 'demo' ? 'on' : defaults[k], onChange() {} },
        widget: { loop(fps, draw) { drawWidget = draw; }, active: () => false, onChange() {}, set() {} },
    };
    const demoLive = load(appPath('edrive', 'live.js'), {}, clock)(demoContext, {
        diag: { available: false, on() {} }, reader, exclusive: (fn) => fn(), live: L,
        page: () => 'battery', kind: () => 'phev', rangeText: () => '36 km',
    });
    const batteryCanvas = new ERecorder(1600, 520).clear(etheme.bg);
    assert(demoLive.draw('battery', batteryCanvas, etheme).demo);
    preview('edrive-cell-detail-demo', ePlay(batteryCanvas.words(), new ECanvas(1600, 520)));
    preview('edrive-widget-demo', drawWidget({ spawnId: 1, big: true }));
    const demo12 = load(appPath('edrive', 'battery12.js'), {}, clock)(demoContext, {
        diag: { available: false }, reader, exclusive: (fn) => fn(), st: {}, save() {}, live: L,
        usingDemo: () => true, kind: () => 'none', ambient: () => 18.5, render() {},
    });
    const voltageCanvas = new ERecorder(1600, 520).clear(etheme.bg);
    demo12.draw('main', voltageCanvas, etheme);
    preview('edrive-12v-demo', ePlay(voltageCanvas.words(), new ECanvas(1600, 520)));
    passed('Chinese battery page, 12V page and home widget render offline with demo data');

    class OfflineDiag {
        constructor() { this.available = false; }
        async init() { return this; }
        on() {}
        physical() { throw new Error('Offline page attempted vehicle diagnostic IO'); }
        functional() { throw new Error('Offline page attempted vehicle diagnostic IO'); }
    }
    for (const [system, pageCount] of [['yes', 5], ['48v', 3], ['no', 3]]) {
        let impl, selectPage, fullFrame;
        const warnings = [], systemDir = path.join(temp, 'render-' + system);
        fs.mkdirSync(systemDir);
        const file = appPath('edrive', 'localized-entry.js');
        const diag = require(appPath('edrive', 'kit/diag'));
        load(file, {
            './app.js': {},
            './kit/mgu': { run(value) { impl = value; } },
            './kit/diag': Object.assign({}, diag, { Diag: OfflineDiag }),
            './live': (ctx, sh) => load(appPath('edrive', 'live.js'), {}, clock)(ctx, sh),
            './battery12': (ctx, sh) => load(appPath('edrive', 'battery12.js'), {}, clock)(ctx, sh),
        }, clock);
        await impl.start(Object.assign({}, demoContext, {
            dataDir: systemDir,
            log: Object.assign({}, log, { warn: (s) => warnings.push(s) }),
            settings: { get: (k) => ({ demo: 'on', hybrid: system, diagPage: true })[k] ?? defaults[k], onChange() {} },
            signals: { async watch() { return {}; } },
            ui: { async image(name, frame) { fullFrame = frame; }, text() {}, onClick() {}, onVisible() {} },
            canvas: (w, h) => Object.assign(new ERecorder(w, h), { own: true, target() {} }),
            onTab(fn) { selectPage = fn; }, onScroll() {}, hideButton() {}, loop() {},
        }));
        for (let page = 0; page < pageCount; page++) {
            await selectPage(page);
            assert(fullFrame && fullFrame.w === 1600 && fullFrame.h === 520);
            preview('edrive-' + system + '-page-' + page + '-demo',
                ePlay(fullFrame.words(), new ECanvas(fullFrame.w, fullFrame.h)));
        }
        assert.deepStrictEqual(warnings, [], 'Every eDrive page renders without a swallowed exception');
    }
    passed('All eleven complete eDrive pages render for plug-in hybrid, 48V and 12V systems');

    for (const system of ['yes', '48v', 'no']) {
        const idleClock = { now: 1000000000, timers: [] }, reads = [], dir = path.join(temp, 'idle-' + system);
        let impl, onVisible;
        fs.mkdirSync(dir);
        class PollDiag extends OfflineDiag {
            constructor() { super(); this.available = true; }
            async physical(addr, sid) { reads.push([addr, sid]); return null; }
        }
        load(appPath('edrive', 'localized-entry.js'), {
            './app.js': {}, './kit/mgu': { run(value) { impl = value; } },
            './kit/diag': Object.assign({}, require(appPath('edrive', 'kit/diag')), { Diag: PollDiag }),
            './live': (ctx, sh) => load(appPath('edrive', 'live.js'), {}, idleClock)(ctx, sh),
            './battery12': (ctx, sh) => load(appPath('edrive', 'battery12.js'), {}, idleClock)(ctx, sh),
        }, idleClock);
        await impl.start(Object.assign({}, demoContext, {
            dataDir: dir,
            spec: Object.assign({}, spec, { config: { battery: { ecu: 7,
                soc: [{ did: '1001', bytes: 1 }], v12: [{ did: '1002', bytes: 1 }] } } }),
            settings: { get: (k) => ({ demo: 'off', hybrid: system, diagPage: false })[k] ?? defaults[k], onChange() {} },
            signals: { async watch() { return {}; } },
            ui: { async image() {}, text() {}, onClick() {}, onVisible(fn) { onVisible = fn; } },
            canvas: (w, h) => new ERecorder(w, h),
            onTab() {}, onScroll() {}, hideButton() {}, loop() {},
        }));
        for (let i = 0; i < 100; i++) await Promise.resolve();
        const pollTimer = () => idleClock.timers.filter((t) => !t.cancelled && t.fn.toString().includes('poll(false).then(schedule)')).pop();
        assert(reads.length > 0 && pollTimer(), 'Initial activity permits the mocked polling');
        const initialReads = reads.length;
        idleClock.now += 10 * 60000 + 1;
        await pollTimer().fn();
        assert.strictEqual(reads.length, initialReads, system + ': parked slow polling must stop');
        onVisible('MAIN', true);
        await pollTimer().fn();
        assert(reads.length > initialReads, system + ': reopening resumes polling');
    }
    passed('All three powertrains stop slow polling after ten parked minutes and resume on reopening');

    const diagnosticText = require(appPath('dtc_scanner', 'diagnostic-text.js')).diagnosticText;
    const raw = 'DME 123ABC: Uncatalogued sensor feedback';
    assert.strictEqual(diagnosticText(raw), raw, 'Missing diagnostic dictionary preserves original detail');
    assert.strictEqual(diagnosticText('3 possible texts (depends on unit type)'), '3 个候选说明（取决于单元型号）');
    assert.strictEqual(diagnosticText('GM: General module 5: Processor internal fault'), 'GM：通用模块 5，处理器内部故障');
    assert.strictEqual(diagnosticText(''), '');
    const missingCatalog = load(appPath('dtc_scanner', 'diagnostic-text.js'), {
        './kit/pack': { open() { return null; } },
    });
    assert.strictEqual(missingCatalog.diagnosticText(raw), raw, 'Missing catalog must not rewrite unknown descriptions');
    passed('Diagnostic translations preserve uncatalogued original text and ambiguous-code context');

    const dtcKit = path.join(root, 'apps/dtc_scanner/package/javascript/kit');
    const catalog = require(path.join(dtcKit, 'pack')).open(path.join(dtcKit, '../diagnostic_i18n')).json('zh-CN.json');
    assert.strictEqual(Object.keys(catalog).length, 87210);
    const glyphs = require(path.join(dtcKit, 'fonts/cjk.json')).sizes[0];
    assert(glyphs.atlasH <= 2048, 'Dedicated diagnostic atlas fits GPU budget');
    const { fitText } = require(path.join(dtcKit, 'text-layout'));
    const fonts = require(path.join(dtcKit, 'fonts'));
    for (const [source, text] of Object.entries(catalog)) {
        assert.strictEqual(diagnosticText(source), text);
        for (const hex of source.match(/0x[0-9A-Fa-f]+/g) || []) assert(text.includes(hex), 'Lost diagnostic ID: ' + source);
        for (const ch of text) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) assert(glyphs.glyphs[ch.codePointAt(0)], 'Missing ' + ch);
    }
    for (const Ctor of [require(path.join(dtcKit, 'canvas')).Canvas, require(path.join(dtcKit, 'record')).Recorder]) {
        const cv = new Ctor(1600, 520), unknown = 'ACC receiver: uncatalogued power software fault';
        const opt = { literal: true }, f = fonts.get('label', 22, unknown);
        assert(Math.abs(cv.textWidth(unknown, 22, opt) - fonts.measure(f, unknown) * 22 / f.size) < 0.001);
        assert.strictEqual(fitText(cv, unknown, 22, 1500, opt), unknown);
    }
    passed('All 87,210 diagnostic entries retain IDs and glyphs; original prose bypasses UI substitutions');

    let implementation, visible, scrollList, lastCanvas;
    const buttons = {}, writes = [], renderWarnings = [];
    class FakeDiag {
        constructor() { this.available = true; }
        async init() { return this; }
        async functional(sid) { writes.push(sid); return new Map([[0x12, [0x54]]]); }
        async physical(addr, sid) { writes.push(sid); return [0x54]; }
    }
    const diagModule = require(appPath('dtc_scanner', 'kit/diag'));
    const dtcClock = { now: 1000000000, timers: [] };
    fs.writeFileSync(path.join(temp, 'last_scan.json'), JSON.stringify({
        at: dtcClock.now, demo: false, ecus: [{ addr: 0x12,
            dtcs: Array.from({ length: 12 }, (_, i) => ({ code: '1234' + String(i).padStart(2, '0'), status: 1, mem: 'fault' })) }],
    }));
    load(appPath('dtc_scanner', 'localized-entry.js'), {
        './app.js': {},
        './kit/mgu': { run(value) { implementation = value; } },
        './kit/diag': Object.assign({}, diagModule, { Diag: FakeDiag }),
    }, dtcClock);
    const { Canvas } = require(appPath('dtc_scanner', 'kit/canvas'));
    const { Recorder, play } = require(appPath('dtc_scanner', 'kit/record'));
    const theme = require(appPath('dtc_scanner', 'kit/themes')).theme('m_tricolour');
    await implementation.start({
        dataDir: temp, log: Object.assign({}, log, { warn: (s) => renderWarnings.push(s) }),
        settings: { get: (k) => ({ demo: 'off', autoScan: false, scope: 'current' })[k], onChange() {} },
        signals: { watch() {} },
        ui: {
            text() {}, image(id, canvas) { lastCanvas = canvas; }, onClick(id, fn) { buttons[id] = fn; },
            onVisible(fn) { visible = fn; }, isVisible() { return false; },
        },
        canvas: (w, h) => Object.assign(new Recorder(w, h), { own: true, target() {} }), theme: () => theme,
        hideButton() {}, onLayout() {}, onScroll(fn) { scrollList = fn; }, onTab() {}, loop: () => ({ kick() {} }),
    });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    assert.deepStrictEqual(renderWarnings, [], 'First application frame must render without hidden errors');
    assert(lastCanvas && lastCanvas.scroll, 'Long fault list advertises its scroll area');
    assert.strictEqual(scrollList(100), true);
    preview('dtc-fault-list-fixture', play(lastCanvas.words(), new Canvas(lastCanvas.w, lastCanvas.h)));
    passed('Long Chinese fault list renders and accepts touch/controller scroll movement');
    assert.deepStrictEqual(writes, []);
    await buttons.BTN_CLEAR(); assert.deepStrictEqual(writes, [], 'First press only arms');
    const expired = dtcClock.timers.filter((t) => t.ms === 5000 && !t.cancelled).pop();
    assert(expired); expired.fn();
    await buttons.BTN_CLEAR(); assert.deepStrictEqual(writes, [], 'Confirmation expiry requires a fresh first press');
    visible('MAIN', false);
    await buttons.BTN_CLEAR(); assert.deepStrictEqual(writes, [], 'Leaving the page cancels confirmation');
    const confirmed = buttons.BTN_CLEAR();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert(writes.includes(0x14), 'Second explicit press reaches the mocked clear transport');
    assert(dtcClock.timers.some((t) => t.ms === 1500 && !t.cancelled), 'Rescan waits after a confirmed clear');
    // Do not advance the rescan timer; there is no real timer or car connection.
    void confirmed;
    passed('Fault clearing never runs on startup or one click and confirmation resets when leaving');
    console.log('PASS ' + count + ' enhanced eDrive/DTC checks; no vehicle transport used');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
    fs.rmSync(temp, { recursive: true, force: true });
});
