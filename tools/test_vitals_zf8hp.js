'use strict';
// Offline contract, telemetry boundaries and seven-page demo rendering. No car I/O.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { createRequire } = require('module');
const link = require('./oap_link');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-vitals-zf8hp-'));
const appDir = (id) => path.join(root, 'apps', id);
const jsDir = (id) => path.join(appDir(id), 'package/javascript');
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const log = { info() {}, warn() {}, error() {}, debug() {} };
let passed = 0;
function ok(name) { passed++; console.log('PASS ' + name); }

function walk(dir) {
    return fs.readdirSync(dir).sort().reduce((out, n) => {
        const p = path.join(dir, n);
        return out.concat(fs.statSync(p).isDirectory() ? walk(p) : [p]);
    }, []);
}

function packages() {
    for (const id of ['car_vitals', 'zf8hp']) {
        const app = appDir(id), p = path.join(app, 'package');
        const manifest = link.readManifest(app), pkg = json(path.join(p, 'package.json'));
        assert.strictEqual(pkg.main, 'javascript/localized-entry.js');
        assert.strictEqual(pkg.version, manifest.version);
        assert.strictEqual(json(path.join(p, 'rhmiData/application.json')).application.version, manifest.version);
        const spec = json(path.join(p, 'javascript/kit/app-spec.json'));
        assert.strictEqual(spec.version, manifest.version);
        assert.strictEqual(spec.settings.find((s) => s.key === 'demo').default, 'off', 'real telemetry is the install default');
        assert.strictEqual(pkg.license, 'MIT');
        const provenance = json(path.join(p, 'PROVENANCE.json'));
        assert.strictEqual(provenance.publicSource.commit, '8d860de5818a2da11d3a3750aab36866cecf6bde');
        assert(provenance.publicSource.identicalFiles.includes('javascript/app.js'), 'upstream application source verified');
        assert(fs.readFileSync(path.join(p, 'LICENSE'), 'utf8').includes('cauliflowermossgrape'));
        assert.strictEqual(require(path.join(p, 'javascript/kit/i18n')).getLanguage(), 'zh-CN');
        assert.strictEqual(json(path.join(p, 'config/base.json')).rhmiLoadingEnabled, true);
        assert.strictEqual(json(path.join(p, 'config/base.json')).entryPointLoadingEnabled, true);
        const first = path.join(tmp, id + '-1.tgz'), second = path.join(tmp, id + '-2.tgz');
        const files = link.packSource(app, first);
        link.packSource(app, second);
        assert(fs.readFileSync(first).equals(fs.readFileSync(second)), 'repeatable source package');
        assert(!files.some((f) => /(^|\/)(node_modules|someipInterfaces|data|oap-sdk)(\/|$)/.test(f)));
        assert(!files.some((f) => /\/javascript\/app\.js$/.test(f)));
        for (const f of walk(p).filter((f) => /\.js$/.test(f))) {
            new vm.Script('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(f, 'utf8') + '\n})', { filename: f });
        }
        const strings = json(path.join(p, 'rhmiData/variantGroups/Common/texts/zh_CN.json'));
        assert(Object.values(strings).some((s) => s === '设置'));
        const ui = json(path.join(p, 'rhmiData/uiDescriptions/ID7/uiDescription.json'));
        function checkRefs(v) {
            if (!v || typeof v !== 'object') return;
            if (v.type === 'StringId') assert(Object.prototype.hasOwnProperty.call(strings, v.value), 'missing HMI string ' + v.value);
            Object.values(v).forEach(checkRefs);
        }
        checkRefs(ui);
        for (const f of fs.readdirSync(path.join(p, 'rhmiData/variantGroups/Common/texts'))) {
            assert.deepStrictEqual(json(path.join(p, 'rhmiData/variantGroups/Common/texts', f)), strings, 'fixed Chinese for every HMI locale');
        }
        ok(id + ': donor SDK package, syntax, fixed Chinese and complete HMI references');
    }
}

async function pairs() {
    const Pair = require(path.join(jsDir('car_vitals'), 'paired_reading'));
    let calls = [];
    const config = { boostTarget: ['target'], boostActual: ['actual'], loadTarget: ['chargeTarget'], loadActual: ['chargeActual'] };
    function reader(values) {
        return { async value(key, candidates) { calls.push([key, candidates]); return values[key]; } };
    }
    const boost = await Pair.readPair(reader({ boostTarget: 250, boostActual: 235 }), config, 'boostCtl', async () => 100);
    assert.deepStrictEqual(boost, { target: 1.5, actual: 1.35 });
    assert.deepStrictEqual(calls, [['boostTarget', ['target']], ['boostActual', ['actual']]]);
    assert.deepStrictEqual(await Pair.readPair(reader({ boostTarget: 250, boostActual: null }), config, 'boostCtl', async () => 100),
        { target: 1.5, actual: null }, 'missing actual must not become -1 bar');
    assert.strictEqual(await Pair.readPair(reader({ boostTarget: NaN, boostActual: 200 }), config, 'boostCtl', async () => 100), null);
    assert.strictEqual(await Pair.readPair(reader({ boostTarget: 250, boostActual: 200 }), config, 'boostCtl', async () => null), null);
    assert.deepStrictEqual(await Pair.readPair(reader({ loadTarget: 165, loadActual: 162 }), config, 'load', () => { throw new Error('not a pressure'); }),
        { target: 165, actual: 162 }, 'air charge remains percent');
    assert.deepStrictEqual(await Pair.readPair(reader({ loadTarget: 0, loadActual: Infinity }), config, 'load', () => 0),
        { target: 0, actual: null }, 'zero target is valid; nonfinite actual is unavailable');
    await assert.rejects(() => Pair.readPair(reader({}), config, 'arbitrary', async () => 100), /Unknown paired/);
    const cfg = json(path.join(jsDir('car_vitals'), 'kit/app-spec.json')).config.dme;
    for (const key of Object.values(Pair.PAIRS).reduce((a, b) => a.concat(b), [])) assert(cfg[key].length, 'missing ECU configuration ' + key);
    ok('M Vitals: paired boost/charge values, shared conversion and invalid-data boundaries');
}

async function egs() {
    const E = require(path.join(jsDir('zf8hp'), 'egs'));
    const Reader = require(path.join(jsDir('zf8hp'), 'reader'));
    const reply = (did, bytes) => Buffer.from([0x62, parseInt(did.slice(0, 2), 16), parseInt(did.slice(2), 16)].concat(bytes));
    assert.deepStrictEqual(E.decode('6000', reply('6000', [100])).values, [60]);
    assert.strictEqual(E.decode('6000', reply('6000', [100, 0])).ok, false);
    assert.strictEqual(E.decode('6000', reply('6005', [100])).ok, false);
    assert.strictEqual(E.decode('6000', [0x7f, 0x22, 0x31]).ok, false);
    assert.deepStrictEqual(E.decode('413A', reply('413A', [0xff, 0xff, 0, 0, 1, 0, 2, 0, 3, 0])).values, [-1, 0, 1, 2, 3]);
    const options = { variants: 'verified' }, requests = [];
    const r = new Reader({ dataDir: tmp, log, settings: { get: (k) => options[k] } });
    let response = reply('F150', [0x0f, 0x25, 0xd0]);
    r.diag = { available: true, async physical(...args) { requests.push(args); return response; } };
    await r.read('6000');
    assert.strictEqual(requests.length, 0, 'do not read live records before identifying EGS');
    await assert.rejects(() => r.read('FFFF'), /allowed read identifier/);
    await r.read('F150');
    assert(r.verified && r.supported);
    response = reply('6000', [100]); await r.read('6000');
    const at = r.records['6000'].at;
    response = Buffer.from([0x7f, 0x22, 0x31]); await r.read('6000');
    assert.deepStrictEqual(r.records['6000'].values, [60]);
    assert.strictEqual(r.records['6000'].at, at, 'failed reads do not freshen last good data');
    assert(r.records['6000'].error);
    r.save();
    const cached = new Reader({ dataDir: tmp, log, settings: { get: (k) => options[k] } });
    assert.strictEqual(cached.records['6000'].cached, true);
    assert.strictEqual(cached.supported, false, 'cached identity never grants live access');
    cached.diag = r.diag;
    response = reply('F150', [0x0f, 0x21, 0xe0]);
    await cached.read('F150');
    assert.strictEqual(cached.records['6000'], undefined, 'another EGS discards previous unit snapshots');
    const count = requests.length; await cached.read('412F');
    assert.strictEqual(requests.length, count, 'unsupported hybrid records are not requested');
    assert(cached.records['412F'].absent);
    response = reply('4137', Array(36).fill(0)); await cached.read('4137');
    assert.strictEqual(cached.records['4137'].values.length, 18);
    cached.sgbd = 'FFFFFF'; assert.strictEqual(cached.supported, false);
    options.variants = 'any'; assert.strictEqual(cached.supported, true);
    await cached.readFaults();
    assert(requests.every((q) => q[0] === 0x18 && [0x22, 0x19].includes(q[1])), 'only fixed EGS read services');
    ok('ZF 8HP: response identity/length, signed decoding, variant gating and stale snapshot protection');
}

async function renderZf() {
    const js = jsDir('zf8hp'), filename = path.join(js, 'localized-entry.js');
    const nativeRequire = createRequire(filename);
    let impl, loop, tab;
    class OfflineReader {
        constructor() { this.records = {}; this.history = []; this.diag = { available: false }; }
        setVisible() {} setWanted() {} refresh() {}
        async init() {}
        status() { return 'NO LINK'; }
    }
    const loader = (name) => name === './app.js' ? {} : name === './reader' ? OfflineReader :
        name === './kit/mgu' ? { run: (x) => { impl = x; } } : nativeRequire(name);
    new vm.Script('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(filename, 'utf8') + '\n})')
        .runInThisContext()(loader, { exports: {} }, {}, filename, js);
    const spec = json(path.join(js, 'kit/app-spec.json')), values = {};
    spec.settings.forEach((x) => { values[x.key] = x.default; }); values.demo = 'on';
    const { Canvas } = nativeRequire('./kit/canvas');
    const { Recorder, play } = nativeRequire('./kit/record');
    const theme = nativeRequire('./kit/themes').theme('m_tricolour');
    let image;
    const ctx = { log, dataDir: tmp, spec, signals: {},
        settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; }, onChange() {} },
        ui: { onClick() {}, onVisible() {}, isVisible: () => true, text() {}, image: (_n, cv) => { image = cv; } },
        onScroll() {}, onTab(fn) { tab = fn; }, hideButton() {},
        loop(_screen, _fps, fn) { loop = fn; }, theme: () => theme, canvas: (w, h) => new Recorder(w, h),
    };
    await impl.start(ctx);
    for (let page = 0; page < 7; page++) {
        tab(page, false); loop();
        assert(image && image.w === 1600 && image.h === 520);
        const frame = play(image.words(), new Canvas(image.w, image.h));
        assert(frame.d.some((v) => v !== 0));
        if (process.env.MGU_PREVIEW_DIR) {
            fs.mkdirSync(process.env.MGU_PREVIEW_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.MGU_PREVIEW_DIR, 'zf8hp-demo-page-' + page + '.png'), frame.png());
        }
    }
    ok('ZF 8HP: all seven Chinese pages render offline with synthetic data');
}

async function renderVitals() {
    const js = jsDir('car_vitals'), filename = path.join(js, 'localized-entry.js');
    const nativeRequire = createRequire(filename);
    let impl, tab, image;
    class OfflineDiag { constructor() { this.available = false; } async init() {} }
    const loader = (name) => name === './app.js' ? {} :
        name === './kit/mgu' ? { run: (x) => { impl = x; } } :
        name === './kit/diag' ? { Diag: OfflineDiag } : nativeRequire(name);
    const context = { Buffer, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
    new vm.Script('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(filename, 'utf8') + '\n})')
        .runInNewContext(context)(loader, { exports: {} }, {}, filename, js);
    const spec = json(path.join(js, 'kit/app-spec.json')), values = {};
    spec.settings.forEach((x) => { values[x.key] = x.default; }); values.demo = 'on';
    const { Canvas } = nativeRequire('./kit/canvas');
    const { Recorder, play } = nativeRequire('./kit/record');
    const theme = nativeRequire('./kit/themes').theme('m_tricolour');
    const ctx = { log, dataDir: tmp, spec,
        signals: { async watch(iface) { return { iface, available: false }; } },
        settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; }, onChange() {} },
        ui: { onClick() {}, onVisible() {}, isVisible: () => true, text() {}, async image(_n, cv) { image = cv; } },
        onTab(fn) { tab = fn; }, loop() {}, theme: () => theme, canvas: (w, h) => new Recorder(w, h),
    };
    await impl.start(ctx);
    for (let page = 0; page < 4; page++) {
        await tab(page);
        const frame = play(image.words(), new Canvas(image.w, image.h));
        assert(frame.d.some((v) => v !== 0));
        if (process.env.MGU_PREVIEW_DIR) {
            fs.mkdirSync(process.env.MGU_PREVIEW_DIR, { recursive: true });
            fs.writeFileSync(path.join(process.env.MGU_PREVIEW_DIR, 'car-vitals-demo-page-' + page + '.png'), frame.png());
        }
    }
    ok('M Vitals: four Chinese telemetry pages render with simulated data and no timers/diagnostic traffic');
}

(async () => {
    try {
        packages(); await pairs(); await egs(); await renderZf(); await renderVitals();
        console.log('PASS ' + passed + ' suites; no vehicle connected');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
