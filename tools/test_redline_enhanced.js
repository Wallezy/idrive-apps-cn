'use strict';
// Offline behavioral checks: no SDK, network, vehicle signals or diagnostic writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'apps/redline');
const js = path.join(app, 'package/javascript');
const spec = require(path.join(js, 'kit/app-spec.json'));
const Hud = require(path.join(js, 'hud'));
const Draw = require(path.join(js, 'hud-draw'));
const Nav = require(path.join(js, 'hud-nav'));
const Tyres = require(path.join(js, 'hud-tyres'));
const { Canvas } = require(path.join(js, 'kit/canvas'));
const { t, getLanguage } = require(path.join(js, 'kit/i18n'));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function settings(overrides) {
    const values = {};
    spec.settings.forEach((s) => { values[s.key] = s.default; });
    Object.assign(values, overrides);
    const listeners = [];
    return {
        get: (k) => values[k],
        set: (k, v) => { values[k] = v; listeners.forEach((fn) => fn(k)); },
        onChange: (fn) => listeners.push(fn),
        item: (k) => spec.settings.find((s) => s.key === k),
    };
}
function overlap(a, b) {
    return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

check('SDK-free source identity, reproducible package and required dependencies', () => {
    const link = require('./oap_link'), manifest = link.readManifest(app);
    const pkg = require(path.join(app, 'package/package.json'));
    assert.strictEqual(manifest.id, 'redline');
    assert.strictEqual(pkg.version, manifest.version);
    assert.strictEqual(spec.version, manifest.version);
    assert.strictEqual(pkg.main, 'javascript/localized-entry.js');
    assert.strictEqual(pkg.license, 'MIT');
    assert(fs.existsSync(path.join(app, 'package/MPL-2.0.txt')));
    assert(fs.readFileSync(path.join(js, 'localized-entry.js'), 'utf8').startsWith("require('./app.js');"));
    assert(fs.readFileSync(path.join(js, 'kit/mgu.js'), 'utf8').includes('global.__mguLocalizedSdk'));
    const release = require(path.join(app, 'release.json'));
    assert(release.requires['cluster-render']);
    assert(release.requires['mgu-render']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-src-'));
    try {
        const target = path.join(dir, 'redline.tgz');
        const files = link.packSource(app, target);
        assert(files.every((f) => !/(^|\/)(node_modules|oap-sdk|data|someipInterfaces)(\/|$)/.test(f)));
        assert(!files.includes('package/javascript/app.js'));
        const before = fs.readFileSync(target);
        link.packSource(app, target);
        assert(before.equals(fs.readFileSync(target)), 'reproducible source archive');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

check('all shipped relative requires resolve; no generated app or external SDK shipped', () => {
    function scan(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
            const filename = path.join(dir, entry.name);
            if (entry.isDirectory()) return scan(filename);
            if (!entry.name.endsWith('.js')) return;
            const text = fs.readFileSync(filename, 'utf8');
            new vm.Script(text, { filename }); // syntax only; never evaluates app initialization
            const executable = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            const re = /\brequire\(['"](\.[^'"]+)['"]\)/g;
            let match;
            while ((match = re.exec(executable))) {
                if (entry.name === 'localized-entry.js' && match[1] === './app.js') continue;
                const p = path.resolve(dir, match[1]);
                assert([p, p + '.js', p + '.json'].some((f) => fs.existsSync(f)), filename + ': ' + match[1]);
            }
        });
    }
    scan(js);
    assert(!fs.existsSync(path.join(js, 'app.js')));
    assert(fs.readFileSync(path.join(js, 'kit/renderd.js')).equals(
        fs.readFileSync(path.join(root, 'apps/ambient_config/package/javascript/kit/renderd.js'))),
        'the HUD app uses the renderer client with handshake timeout and Store socket priority');
    assert(fs.readFileSync(path.join(js, 'cluster_render_client.js')).equals(
        fs.readFileSync(path.join(root, 'native/cluster-render/js/cluster_render_client.js'))),
        'the HUD uses the compatible local cluster client');
});

check('Chinese HUD settings, static RHMI strings and glyph coverage', () => {
    assert.strictEqual(getLanguage(), 'zh-CN');
    assert.strictEqual(settings().get('hud'), 'off', 'HUD is explicitly enabled by the user');
    assert.strictEqual(settings().get('demo'), 'off', 'missing live data never automatically enables sample readings');
    const allowed = new Set(['Barlow', 'Ubuntu', 'Nm', 'PS', 'bar', 'hp', 'kPa', 'kW', 'kgm',
        'km/h', 'km/l', 'l/100 km', 'lb-ft', 'mpg (UK)', 'mpg (US)', 'mph', 'psi', '°C', '°F']);
    const labels = [];
    spec.settings.forEach((s) => {
        labels.push(s.label);
        (s.options || []).forEach((o) => labels.push(o[1]));
        if (s.group) labels.push(s.group);
    });
    labels.filter((s) => /[A-Za-z]/.test(s) && !/[\u4e00-\u9fff]/.test(s))
        .forEach((s) => assert(allowed.has(s), 'untranslated setting: ' + s));
    const strings = require(path.join(app, 'package/rhmiData/variantGroups/Common/texts/zh_CN.json'));
    assert(Object.keys(strings).length <= 1024);
    assert.strictEqual(strings.SID_REDLINE_TITLE, '换挡转速');
    ['Show on HUD (experimental)', 'HUD looks', 'Play on HUD', 'PERFECT SHIFT', 'HUD: giving way to BMW',
        'HUD: waits for the car to be switched on'].forEach((s) => assert.notStrictEqual(t(s), s));
    const atlas = require(path.join(js, 'kit/fonts/cjk.json')).sizes[0];
    Object.values(require(path.join(js, 'kit/locale.json')).strings).join('').split('')
        .forEach((ch) => assert(atlas.glyphs[ch.codePointAt(0)], 'missing glyph: ' + ch));
});

check('shift cue follows RPM, releases after a gear change and rejects missing RPM', () => {
    const state = {};
    Hud.shiftCue(state, 5000, 1000, 6500, 7000, 200, 3);
    const rising = Hud.shiftCue(state, 6200, 1400, 6500, 7000, 200, 3);
    assert(rising.shift, 'rising revs trigger the anticipatory light');
    assert(rising.at >= 5700 && rising.at < 6500, 'reaction lead is bounded at 800 RPM');
    const changed = Hud.shiftCue(state, 5000, 1450, 6500, 7000, 200, 4);
    assert.strictEqual(changed.shift, false, 'the upshift clears the flash');
    const missing = Hud.shiftCue(state, null, 1500, 6500, 7000, 200, 4);
    assert.strictEqual(missing.shift, false);
    assert.strictEqual(missing.limiter, false);
    const plain = Hud.shiftCue({}, 7000, 1500, 6500, 7000, 200, 4, 7000, 4000);
    assert.strictEqual(plain.shift, true);
    assert.strictEqual(plain.limiter, true);
    assert.strictEqual(plain.from, 4000);
});

check('driving profiles preserve independently configured HUD placement', () => {
    const s = settings();
    assert.strictEqual(Hud.profileOf('sport', s), 'sport');
    assert.strictEqual(Hud.profileOf('eco', s), 'comfort');
    assert.strictEqual(Hud.calmFor('comfort', Hud.comfortMode(s)), 'hide');
    const view = Hud.profileView(s, 'comfort');
    view.set('hudSize', 70);
    view.set('hudStyle', 'minimal');
    assert.strictEqual(s.get('hudComfortMode'), 'hide', 'editing a hidden setup does not activate it');
    Hud.setSetupMode(s, 'comfort', 'own');
    assert.strictEqual(s.get('hudComfortMode'), 'own');
    assert.strictEqual(Hud.profileView(s, 'comfort').get('hudSize'), 70);
    assert.notStrictEqual(s.get('hudStyle'), 'minimal', 'Sport was not overwritten');
    assert.strictEqual(Hud.optsFrom(s, 'comfort').style, 'minimal');
    s.set('hudHybridSeen', true);
    assert.strictEqual(Hud.profileOf('hybrid', s), 'hybrid');
    assert.strictEqual(Hud.profileView(s, 'hybrid').get('hudStyle'), s.get('hudStyle'));
});

check('default navigation rectangle avoids OEM speed and Redline tach', () => {
    Hud.useScene('map:1088x480,panel:1920x720,hud:800x480');
    const s = settings(), nav = Hud.navPlaceOf(s), tach = Hud.placeOf(s);
    assert.strictEqual(overlap(nav, Hud.BMW_SPEED), 0);
    assert.strictEqual(overlap(nav, tach), 0);
    assert(nav.x >= 0 && nav.y >= 0 && nav.x + nav.w <= 800 && nav.y + nav.h <= 480);
});

check('ten HUD layouts render real pixels from the same preview renderer', () => {
    const styles = spec.settings.find((s) => s.key === 'hudStyle').options.map((o) => o[0]);
    assert.strictEqual(styles.length, 10);
    const output = process.env.REDLINE_PREVIEW_DIR;
    const contact = new Canvas(840, 1000);
    contact.clear('#0c111b');
    styles.forEach((style, i) => {
        const s = settings({ hudStyle: style });
        const frame = Hud.demoFrame(2500, Hud.optsFrom(s), {}, 200, 2500);
        const cv = new Canvas(Draw.IW, Draw.IH);
        Draw.drawHud(cv, frame);
        assert(cv.d.some((v, j) => j % 4 === 3 && v > 0), style + ': empty frame');
        const x = (i % 2) * 420 + 10, y = Math.floor(i / 2) * 200 + 10;
        contact.text(spec.settings.find((s) => s.key === 'hudStyle').options[i][1], x + 8, y + 26, 18, '#ffffff');
        contact.blit(cv, x, y + 42);
    });
    if (output) {
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'hud-layouts.png'), contact.png());
        console.log('PREVIEW ' + path.join(output, 'hud-layouts.png'));
    }
});

function harness(overrides) {
    let time = 100000;
    const timers = new Set(), clients = [], logs = [], claimStates = [];
    class FakeClient extends EventEmitter {
        constructor() { super(); this.ready = false; this.targets = 'hud:800x480'; this.backend = 'id7'; this.layers = new Map(); this.sent = []; this.seq = 0; clients.push(this); }
        connect() { this.ready = true; this.emit('ready'); }
        image(options) { const id = ++this.seq; this.layers.set(id, options); return id; }
        set(id, options) { if (this.layers.has(id)) Object.assign(this.layers.get(id), options); return true; }
        drop(id) { this.layers.delete(id); }
        pixels(id, rects, pixels) {
            this.sent.push({ id, rects, bytes: pixels.length, accepted: !this.failNext });
            if (this.failNext) { this.failNext = false; return false; }
            return true;
        }
        status() {}
        close() { this.ready = false; this.layers.clear(); }
    }
    class Claim {
        hold(on) { claimStates.push(on); }
        thisBoot() { return true; }
        static standingOn() { return false; }
    }
    const hudPath = path.join(js, 'hud.js'), actualRequire = createRequire(hudPath);
    const context = {
        module: { exports: {} }, exports: {}, Buffer, console,
        Date: class extends Date { static now() { return time; } },
        process: Object.assign({}, process, { hrtime: () => [Math.floor(time / 1000), (time % 1000) * 1e6] }),
        setInterval(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
        clearInterval(timer) { timers.delete(timer); },
        require(name) {
            if (name === './cluster_render_client') return { ClusterRender: FakeClient };
            if (name === './kit/hud_claim') return { HudClaim: Claim };
            return actualRequire(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(hudPath, 'utf8'), context, { filename: hudPath });
    const s = settings(Object.assign({ hud: 'on', hudTyreWidget: 'always' }, overrides));
    const data = { rpm: 3000, gear: 3, oil: 96, coolant: 95, condition: 7, conditionKnown: true };
    let drive = 'sport', navigation = { show: null, giveWay: false }, stops = 0, starts = 0;
    const source = {
        data: () => data, driveMode: () => drive, shiftPoint: () => ({ rpm: 6500, cold: false }),
        redline: () => 7000, maxRpm: () => 8000, mode: () => 'M',
        nav: { view: () => navigation }, tyres: { value: () => Tyres.SAMPLE },
        gearbox: { start: () => starts++, stop: () => stops++, value: () => 80 },
    };
    const api = context.module.exports.start({
        settings: s, dataDir: '/nonexistent-redline-test', backWaitMs: 0,
        log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push('ERROR ' + m) },
    }, source);
    return {
        api, s, data, clients, timers, logs, claimStates,
        drive: (value) => { drive = value; }, navigation: (value) => { navigation = value; },
        reads: () => ({ starts, stops }),
        tick(ms) { time += ms || 50; [...timers].filter((t) => t.ms < 1000).forEach((t) => t.fn()); },
    };
}

check('HUD off performs no render connection', () => {
    const h = harness({ hud: 'off' });
    assert.strictEqual(h.clients.length, 0);
    h.api.stop();
    assert.strictEqual(h.timers.size, 0);
});

check('HUD uses image layers; navigation takes priority over the tyre corner', () => {
    const h = harness(), cr = h.clients[0];
    try {
        h.tick();
        assert.strictEqual(h.api.corner(), 'tyres');
        assert.strictEqual(cr.layers.size, 2);
        h.navigation({ show: Nav.SAMPLE, giveWay: false });
        h.tick();
        assert.strictEqual(h.api.corner(), 'nav');
        assert.strictEqual(cr.layers.size, 2, 'one corner layer shared');
        for (const layer of cr.layers.values()) assert.strictEqual(layer.target, 'hud');
        assert(!h.logs.some((s) => s.startsWith('ERROR ')), h.logs.join('\n'));
    } finally { h.api.stop(); }
});

check('Comfort and original navigation yield, then HUD resumes in Sport', () => {
    const h = harness(), cr = h.clients[0];
    try {
        h.tick();
        h.drive('comfort'); h.tick();
        assert.strictEqual(cr.layers.size, 0);
        assert.strictEqual(h.claimStates[h.claimStates.length - 1], false);
        h.drive('sport'); h.tick();
        assert(cr.layers.size > 0);
        h.navigation({ show: null, giveWay: true }); h.tick();
        assert.strictEqual(cr.layers.size, 0);
        assert.strictEqual(h.claimStates[h.claimStates.length - 1], true, 'reserve space for OEM guidance');
        h.navigation({ show: Nav.SAMPLE, giveWay: false }); h.tick();
        assert(cr.layers.size > 0);
    } finally { h.api.stop(); }
});

check('parked renderer pauses pixels and reads; shown renderer resends a complete frame', () => {
    const h = harness(), cr = h.clients[0];
    try {
        h.tick();
        cr.emit('target', 'hud', 'parked', '', '', false, false);
        const count = cr.sent.length, stops = h.reads().stops;
        h.data.rpm = 4000; h.tick();
        assert.strictEqual(cr.sent.length, count);
        assert(h.reads().stops > stops);
        cr.emit('target', 'hud', 'shown', '', '', false, false); h.tick();
        assert(cr.sent.slice(count).some((s) => s.rects === null));
    } finally { h.api.stop(); }
});

check('failed pixel upload retries a full frame even when inputs stay unchanged', () => {
    const h = harness({ hudTyreWidget: 'off', hudShowRpm: true }), cr = h.clients[0];
    try {
        h.tick();
        cr.failNext = true; h.data.rpm = 4200; h.tick(400);
        assert.strictEqual(cr.sent[cr.sent.length - 1].accepted, false);
        h.tick(400);
        const retry = cr.sent[cr.sent.length - 1];
        assert.strictEqual(retry.accepted, true);
        assert.strictEqual(retry.rects, null);
    } finally { h.api.stop(); }
});

check('vehicle switch-off drops layers; stopped HUD clears timers and cannot reopen', () => {
    const h = harness(), cr = h.clients[0];
    h.tick();
    h.data.condition = 12; h.tick();
    assert.strictEqual(cr.layers.size, 0);
    h.api.stop();
    assert.strictEqual(h.timers.size, 0);
    assert.strictEqual(h.claimStates[h.claimStates.length - 1], false);
    h.s.set('hud', 'test');
    assert.strictEqual(h.clients.length, 1);
    assert.strictEqual(h.timers.size, 0);
});

console.log('PASS Redline enhanced: ' + passed + ' offline checks; no vehicle validation.');
