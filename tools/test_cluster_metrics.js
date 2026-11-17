'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const local = path.join(root, 'localized/cluster-metrics');
const pkg = path.join(root, 'apps/cluster_metrics/package');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const spec = read(path.join(pkg, 'javascript/kit/app-spec.json'));
const words = read(path.join(pkg, 'javascript/kit/locale.json')).strings;
const original = read(path.join(local, 'apps/cluster_metrics/app.json'));
const visible = [original.title];
for (const s of original.screens) {
    visible.push(s.title);
    for (const b of s.buttons || []) visible.push(b[1]);
    for (const i of s.items || []) if (typeof i[2] === 'string') visible.push(i[2]);
}
for (const s of original.settings) {
    visible.push(s.label);
    for (const o of s.options || []) visible.push(o[1]);
}
for (const s of visible.filter(Boolean)) assert(Object.prototype.hasOwnProperty.call(words, s), 'Missing translation: ' + s);
assert.strictEqual(spec.settings.find((s) => s.key === 'enabled').default, false);
assert.strictEqual(spec.settings.find((s) => s.key === 'hudNavMode').default, 'yield_route');
const cn = require(path.join(pkg, 'javascript/cn_text'));
assert.strictEqual(cn.text('Metrics Active | Live PHEV'), '数据显示已开启 | 实时 插混');
assert.strictEqual(cn.text('Speed: 42 km/h @ 1800 rpm'), '车速: 42 km/h @ 1800 rpm');
assert.strictEqual(cn.text('/tmp/cluster-metrics-probe.log'), '/tmp/cluster-metrics-probe.log');
assert.strictEqual(cn.text('原有中文'), '原有中文');

// Exercise Chinese media and road names through the shipped raster path.
const { MediaTracker } = require(path.join(pkg, 'javascript/media_tracker'));
const { Canvas } = require(path.join(pkg, 'javascript/kit/canvas'));
const { OverlayRenderer } = require(path.join(pkg, 'javascript/overlay_renderer'));
const { foldAscii, drawHudRoadBanner } = require(path.join(pkg, 'javascript/hud_nav_renderer'));
const fonts = require(path.join(pkg, 'javascript/kit/fonts'));
assert.strictEqual(foldAscii('南京东路 · 晴天'), '南京东路 晴天');
const media = new MediaTracker();
media.feedHmiMetadata({ firstLineText: '晴天', secondLineText: '周杰伦', firstLineType: 'TITLE', secondLineType: 'ARTIST' });
const snap = media.snapshot(1000, false);
assert.strictEqual(snap.title, '晴天');
assert.strictEqual(snap.artist, '周杰伦');
const cv = new Canvas(312, 266), rendered = [];
const draw = cv.text.bind(cv);
cv.text = (text, ...args) => { rendered.push(text); return draw(text, ...args); };
const painter = new OverlayRenderer({ allowPanel: true });
painter._paintRightMedia(cv, snap);
assert(rendered.includes('晴天') && rendered.includes('周杰伦'));
painter._paintRightMedia(cv, null);
assert(rendered.includes('暂无媒体播放'));
for (const c of '晴天周杰伦南京东路暂无媒体播放行程与车辆信息') {
    assert(fonts.get('bold', 21, c).glyphs[c.codePointAt(0)], 'missing glyph: ' + c);
}
const road = new Canvas(544, 38);
assert(drawHudRoadBanner(road, { road: '南京东路', exitBadge: '14B' }));
assert(road.d.some(x => x !== 0));
media.stop(); painter.close();

// Exercise the shipped entry with fake telemetry/UI, never with a car transport.
let launch;
let cleanupCalled = 0;
const rows = [], buttons = [];
const ui = {
    cells: (name, row, value) => { rows.push(value); },
    text: (name, value) => { buttons.push(value); },
    onClick() {}, onVisible() {}, open() {},
};
class Hub {
    constructor() { this.uds = { stats: {} }; }
    start() {}
    stop() { cleanupCalled++; }
    snapshot() { return { rpm: 800, stage: 'P', gear: null, hudNav: {}, dscBrake: {} }; }
    resolvedUnits() { return { system: 'metric', tempUnit: 'C', distUnit: 'km', speedUnit: 'km/h' }; }
}
class Renderer {
    constructor() { this.ready = true; this.slotStatus = {}; this.refused = []; this.lastSummary = {}; }
    connect() {}
    render() {}
    layerCount() { return 0; }
    pixelBytesTotal() { return 0; }
    close() { cleanupCalled++; }
}
const actualRequire = (name) => require(path.join(pkg, 'javascript', name));
const source = fs.readFileSync(path.join(pkg, 'javascript/localized-entry.js'), 'utf8');
vm.runInNewContext(source, {
    require(name) {
        if (name === './app.js') return {};
        if (name === './kit/mgu') return { run: (s) => { launch = s.start; } };
        if (name === './signals') return { SignalHub: Hub };
        if (name === './overlay_renderer') return { OverlayRenderer: Renderer };
        if (name === './efficiency') return { EfficiencyTracker: class { update() { return {}; } } };
        if (name === './vehicle_profile') return { VehicleProfile: class { evaluate() { return { mode: 'ev', vehicleType: 'phev' }; } } };
        return actualRequire(name);
    },
    process: { env: {} }, setInterval: () => 1, clearInterval() {}, console,
});
(async () => {
    const ctx = { ui, settings: { get: () => undefined, values: {}, onChange() {} }, log: {
        info() {}, warn(message) { throw new Error(message); },
    } };
    const stop = await launch(ctx);
    assert(rows.length >= 8, 'Main and diagnosis must render');
    assert(rows.some((v) => /数据显示已开启/.test(v.Text1stRow)), 'Dynamic status translated');
    assert(rows.some((v) => /动力电池/.test(v.Text1stRow)), 'Diagnostic title translated');
    stop();
    assert.strictEqual(cleanupCalled, 2, 'Signals and renderer stopped');
    const { HmiText } = require(path.join(pkg, 'javascript/kit/hmi-text'));
    let saved, handle;
    await new HmiText().set({
        getStringBundle: () => ({ setStrings: async (s) => { saved = s; } }),
        setValue: (r, c, value, kind) => { handle = { value, kind }; },
    }, 'STATUS_SUMMARY', 0, 'Text1stRow', '数据显示已暂停');
    assert.strictEqual(handle.kind, 'StringId', 'Chinese must use Unicode StringBundle');
    assert.strictEqual(saved[handle.value], '数据显示已暂停');
    assert(!fs.existsSync(path.join(pkg, 'node_modules')), 'No SDK shipped');
    assert(!fs.existsSync(path.join(pkg, 'javascript/app.js')), 'Donor link performed on head unit');
    for (const name of ['LICENSE', 'KIT-LICENSE', 'MPL-2.0.txt', 'APACHE-2.0.txt', 'NOTICE', 'provenance.json']) {
        assert(fs.statSync(path.join(pkg, name)).size > 0);
    }
    const release = read(path.join(root, 'apps/cluster_metrics/release.json'));
    assert.strictEqual(release.requires['cluster-render'], '0.6.7');
    assert(release.uninstallable);
    console.log('Cluster Metrics CN: all static labels, runtime UI, Unicode transport, safe defaults, cleanup and packaging passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
