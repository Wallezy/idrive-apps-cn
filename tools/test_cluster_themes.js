'use strict';
// Render the shipped page with real resources and fake vehicle data. No car or BMW SDK.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '..');
const local = path.join(root, 'localized/cluster-themes');
const app = path.join(root, 'apps/cluster_themes/package');
const js = path.join(app, 'javascript'), kit = path.join(js, 'kit');
const spec = require(path.join(kit, 'app-spec.json'));
const source = require(path.join(local, 'apps/cluster_themes/app.json'));
const { Recorder, play } = require(path.join(kit, 'record'));
const { Canvas } = require(path.join(kit, 'canvas'));
const fonts = require(path.join(kit, 'fonts'));
const data = require(path.join(js, 'hud_data'));
const sensors = require(path.join(js, 'sensors'));
const locale = require(path.join(js, 'page_locale'));
const values = {}, items = {};
source.settings.forEach((s, i) => {
    const localized = spec.settings[i];
    assert.deepStrictEqual([localized.key, localized.default, (localized.options || []).map((o) => o[0])],
        [s.key, s.default, (s.options || []).map((o) => o[0])], 'keep settings values and defaults');
    assert(/[\u3400-\u9fff]/.test(localized.label), 'setting not translated: ' + s.key);
    values[s.key] = s.default; items[s.key] = localized;
});
const choices = source.settings.find((s) => s.key === 'inSport').options.slice(1);
for (const [id, name] of choices) {
    assert.strictEqual(items.inSport.options.find((o) => o[0] === id)[1], name, 'preserve theme name');
    assert.deepStrictEqual(data.json('layouts/' + id + '.json'),
        require(path.join(local, 'apps/cluster_themes/hud/layouts/' + id + '.json')), 'preserve instrument layout');
}
for (const name of ['hud.js', 'hud_text.js', 'hud_data.js', 'sensors.js', 'shaders.js', 'waze.js',
    'cluster_render_client.js', 'shift_cue.js', 'vehicle_state.js']) {
    assert(fs.readFileSync(path.join(js, name)).equals(fs.readFileSync(path.join(local, 'shared', name))),
        'no change to vehicle or instrument runtime: ' + name);
}
let state = 'themes', page, frame, labels, checks = 0;
const previews = process.env.CLUSTER_THEMES_PREVIEW_DIR;
if (previews) fs.mkdirSync(previews, { recursive: true });
const all = new Set();
const realText = Recorder.prototype.text;
Recorder.prototype.text = function (value, x, y, size, color, opts) {
    const text = String(value), o = opts || {};
    const width = this.textWidth(text, size, Object.assign({}, o, { literal: true }));
    const left = o.align === 'center' ? x - width / 2 : o.align === 'right' ? x - width : x;
    assert(left >= -1 && left + width <= this.w + 1, state + ': text outside canvas: ' + text);
    assert(y <= this.h + 1, state + ': text below canvas: ' + text);
    for (const c of text) if (/[\u3400-\u9fff]/.test(c)) {
        assert(fonts.get(o.font || 'label', size, text).glyphs[c.codePointAt(0)], 'missing glyph: ' + c);
        checks++;
    }
    labels.push(text); all.add(text);
    return realText.apply(this, arguments);
};
let playing = false, blocked = null, speed = 0, picked = null;
const hud = {
    setting: (k) => values[k], activeName: 'gt3', driveMode: 'sport',
    _layoutName: () => values.hudLayout, onStatus() {}, start() {}, stop() {},
    car: { data: () => ({ demo: false, speed }) },
    screen: { otherOn: () => false, release() {} },
    slotsOf: (id) => id === 'off' ? [] : data.json('layouts/' + id + '.json').slots || [],
    slotSensor: (id, slot, slots) => sensors.get((slots.find((s) => s.id === slot) || {}).default),
    sensorValue: () => '12.3', sensorUnit: (s) => typeof s.unit === 'function' ? s.unit(false) : '',
    setSlot: (layout, slot, sensor) => { picked = [layout, slot, sensor]; },
    waze: { info: () => ({ text: "Waze on Cluster isn't running" }) },
    playDemo: () => { playing = true; }, stopDemo: () => { playing = false; },
    demoPlaying: () => playing, demoBlocked: () => blocked, demoLeft: () => 25000,
    testShift: () => true, shiftTesting: () => false,
};
const ctx = {
    spec, settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; }, item: (k) => items[k], onChange() {} },
    theme: () => require(path.join(kit, 'themes')).theme('m_tricolour'),
    onLayout() {}, loop: () => ({ kick() {} }), log: { error: (e) => { throw new Error(e); } },
    canvas: (w, h) => { frame = new Recorder(w, h); labels = []; return frame; },
    ui: { image() {
        if (previews) {
            const canvas = new Canvas(frame.w, frame.h);
            play(frame.words(), canvas);
            fs.writeFileSync(path.join(previews, state + '.png'), canvas.png());
        }
    } },
};
const Page = require(path.join(js, 'page'));
const load = Module._load;
Module._load = function (request, parent) {
    if (parent && parent.filename === path.join(js, 'localized-entry.js')) {
        if (request === './app.js') return {};
        if (request === './kit/mgu') return { run: (impl) => impl.start(ctx) };
        if (request === './hud') return function () { return hud; };
        if (request === './page') return class extends Page { constructor(...args) { super(...args); page = this; } };
    }
    return load.apply(this, arguments);
};
function render(name) { state = name; page.render(); }
function tap(key) {
    const target = frame.targets.find((t) => t.key === key);
    assert(target, state + ': missing target ' + key);
    target.run();
}
try {
    require(path.join(js, 'localized-entry.js'));
    Module._load = load;
    assert(labels.includes('主题') && labels.includes('随驾驶模式切换'));
    const cv = new Recorder(1600, 520);
    locale.localizeCanvas(cv); const textFn = cv.text; locale.localizeCanvas(cv);
    assert.strictEqual(cv.text, textFn, 'reused renderers must not stack translation wrappers');
    for (const tab of page.cfg.tabs) { page.tab = tab; render(tab); }
    page.tab = 'look'; render('picker-open'); tap('set:inSport');
    const reachable = new Set();
    for (let i = 0; i < 10; i++) {
        render('picker-' + i);
        frame.targets.filter((t) => /^pick:inSport:/.test(t.key)).forEach((t) => {
            assert(t.y + t.h <= frame.h, 'off-screen theme choice');
            reachable.add(t.key.split(':').pop());
        });
        if (!frame.targets.some((t) => t.key === 'pick:next')) break;
        tap('pick:next');
    }
    assert.deepStrictEqual([...reachable].sort(), source.settings.find((s) => s.key === 'inSport').options.map((o) => o[0]).sort());
    tap('pick:inSport:ribbon'); assert.strictEqual(values.inSport, 'ribbon');
    page.tab = 'readouts';
    for (const category of sensors.CATS) { page.cat = category; render('readouts-' + category); }
    tap('sensor:time'); assert.strictEqual(picked[2], 'time');
    page.tab = 'map'; values.mapInTheme = true; render('map-unavailable');
    assert(labels.includes('当前主题不支持地图，请选 GT3、Sport 或 M'));
    page.tab = 'look'; playing = true; render('demo-playing'); assert(labels.includes('仪表演示中 · 25 秒'));
    playing = false; blocked = 'moving'; speed = 20; render('demo-moving');
    assert(!frame.targets.some((t) => t.key === 'demo:play'), 'moving car cannot start demo');
    page.tab = 'alerts'; render('alerts-moving');
    assert(!frame.targets.some((t) => t.key === 'test:shift'), 'moving car cannot test shift lights');
    page.tab = 'look'; blocked = null; speed = 0;
    hud.screen.otherOn = () => true; hud.screen.otherName = 'HUD Widgets';
    hud.screen.claim = () => {};
    page.chooseLayout('hudLayout', 'gt3'); render('confirmation');
    assert(labels.includes('关闭 HUD'));
    tap('confirm:no'); assert.strictEqual(page.confirm, null);
    require('../apps/robertn_waze_cluster/tools/check_rhmi').check(path.join(app, 'rhmiData/uiDescriptions/ID7'));
    assert.strictEqual(fs.readdirSync(path.join(app, 'rhmiData/variantGroups/Common/texts')).length, 33);
    if (previews) fs.writeFileSync(path.join(previews, 'labels.json'), JSON.stringify([...all], null, 2));
    console.log('Cluster Themes: 12 original layouts, 7 Chinese tabs, all theme choices, controls, moving-car guards; ' + checks + ' glyph checks');
} finally { Module._load = load; Recorder.prototype.text = realText; }
