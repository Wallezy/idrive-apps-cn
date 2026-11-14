'use strict';
// Exercise the shipped Chinese UI with the real renderer and fake vehicle state.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');
const root = path.resolve(__dirname, '..');
const app = path.join(root, 'apps/ambient_config/package');
const js = path.join(app, 'javascript');
const kit = path.join(js, 'kit');
const { t } = require(path.join(kit, 'i18n'));
const { Canvas } = require(path.join(kit, 'canvas'));
const { Recorder, play } = require(path.join(kit, 'record'));
const fonts = require(path.join(kit, 'fonts'));
const spec = require(path.join(kit, 'app-spec.json'));
const original = require('../localized/ambient/apps/ambient_config/app.json');
const { Control, DEFAULT_LOOK } = require(path.join(js, 'control'));
const S = require(path.join(js, 'scenes'));
const { sample } = require(path.join(js, 'lin'));
const out = process.env.AMBIENT_PREVIEW_DIR;
if (out) fs.mkdirSync(out, { recursive: true });
const values = Object.assign({}, ...spec.settings.map((s) => ({ [s.key]: s.default })), { on: true });
const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; }, onChange() {} };
const log = { info() {}, warn(e) { console.error(e); }, error(e) { throw new Error(e); } };
const ambient = Object.assign(new EventEmitter(), {
    mode: () => 'sport', modes: () => ['sport', 'comfort', 'eco', 'adaptive'],
    slot: () => 1, available: true, setSlot() {},
});
const lights = Object.assign(new EventEmitter(), {
    state: 'ours', lights: sample(), scene: DEFAULT_LOOK, rate: 8, fps: 4.5,
    at: (l) => S.lightAt(lights.scene, l, 1000),
    show(scene) { this.scene = scene; }, carColour() { this.scene = null; this.state = 'car'; },
    hold: async () => {}, find: async () => {}, overlay() {}, dim() {},
});
const control = new Control({ settings, lights, ambient, log });
const others = Object.assign(new EventEmitter(), { comfort: false });
const strobe = Object.assign(new EventEmitter(), {
    kind: 'fn', kindName: 'body controller light functions', mask: true, patterns: true, running: null,
});
let tab, frame, name = 'colour', targets = {}, labels = [], checks = 0;
let inputReady = false, layoutChanged, loopTick, frames = 0;
const allLabels = [];
function ok(value, message) { checks++; assert(value, message); }
const drawText = Recorder.prototype.text;
Recorder.prototype.text = function (text, x, y, size, color, options) {
    const opts = options || {}, shown = opts.literal ? String(text) : t(text);
    labels.push(shown);
    allLabels.push(shown);
    const width = this.textWidth(shown, size, Object.assign({}, opts, { literal: true }));
    const left = opts.align === 'center' ? x - width / 2 : opts.align === 'right' ? x - width : x;
    ok(left >= -1 && left + width <= this.w + 1, name + ': text outside screen: ' + shown);
    for (const c of shown) if (/[\u3400-\u9fff]/.test(c)) {
        ok(fonts.get(opts.font || 'label', size, shown).glyphs[c.codePointAt(0)], 'missing glyph ' + c);
    }
    return drawText.call(this, text, x, y, size, color, opts);
};
const timers = [];
const context = {
    settings, log, background: { ambient, lights, control, others, strobe, active() {},
        checks: () => [['Switched on in the settings', true], ['Someone in the car', true]] },
    theme: () => require(path.join(kit, 'themes')).theme('m_tricolour'),
    canvas(w, h) {
        const cv = new Recorder(w, h);
        cv.own = inputReady;
        targets = {}; labels = [];
        cv.target = (x, y, width, height, fn, key) => { if (cv.own) targets[key] = fn; };
        frame = cv;
        return cv;
    },
    ui: { image: async () => {
        frames++;
        if (out) {
            const cv = new Canvas(frame.w, frame.h);
            play(frame.u.subarray(0, frame.n), cv);
            fs.writeFileSync(path.join(out, name + '.png'), cv.png());
        }
    } },
    onTab(fn) { tab = fn; }, onTap() {},
    onLayout(fn) { layoutChanged = fn; }, loop(_screen, _fps, fn) { loopTick = fn; },
};
const realLoad = Module._load, realInterval = global.setInterval;
let impl;
Module._load = function (request, parent) {
    if (request === './app.js' && parent && parent.filename === path.join(js, 'localized-entry.js')) return {};
    if (request === './kit/mgu') return { run: (value) => { impl = value; } };
    return realLoad.apply(this, arguments);
};
require(path.join(js, 'localized-entry.js'));
Module._load = realLoad;
global.setInterval = (fn, ms) => { const id = realInterval(fn, ms); timers.push(id); return id; };

(async () => {
    try {
        ok(require(path.join(app, 'package.json')).mguAppStartType === 'autostart', 'preserve autostart');
        ok(!fs.existsSync(path.join(app, 'node_modules')), 'SDK-free source package');
        for (let i = 0; i < original.settings.length; i++) {
            const a = original.settings[i], b = spec.settings[i];
            assert.deepStrictEqual([b.key, b.default, (b.options || []).map((o) => o[0])],
                [a.key, a.default, (a.options || []).map((o) => o[0])], 'settings keys and defaults unchanged');
            ok(/[\u3400-\u9fff]/.test(b.label), 'untranslated setting: ' + b.label);
        }
        require('../apps/robertn_waze_cluster/tools/check_rhmi').check(path.join(app, 'rhmiData/uiDescriptions/ID7'));
        const tables = fs.readdirSync(path.join(app, 'rhmiData/variantGroups/Common/texts'));
        ok(tables.length === 33, 'all HMI languages use the fixed Chinese bundle');
        const catalog = require(path.join(kit, 'locale.json'));
        const glyphText = Object.values(catalog.strings).join('') + require(path.join(kit, 'ambient-patterns.json')).map((p) => p[1]).join('');
        for (const c of glyphText) if (/[\u3400-\u9fff]/.test(c)) {
            ok(fonts.get('label', 24, c).glyphs[c.codePointAt(0)], 'missing catalog glyph ' + c);
        }
        assert.strictEqual(t('Colour for Sport'), '运动模式配色');
        assert.strictEqual(t('On in the car: 19 lights'), '已控制 19 组车内灯光');
        assert.strictEqual(t('the lights rest 12 s more'), '灯光还需休息 12 秒');
        assert.strictEqual(t('Strobe stopped: the headlights got hot (90 °C)'), '频闪已停止：前灯温度过高 (90 °C)');
        await impl.start(context);
        await Promise.resolve();
        ok(labels.includes('交互控件暂不可用'), 'unavailable renderer has an actionable message');
        assert.strictEqual(Object.keys(targets).length, 0, 'renderer not ready: no input targets yet');
        const firstFrames = frames;
        inputReady = true;
        ok(typeof layoutChanged === 'function', 'renderer readiness/layout changes trigger a redraw');
        layoutChanged();
        await loopTick();
        ok(frames > firstFrames && Object.keys(targets).length > 0,
            'renderer ready: buttons become usable without any vehicle event');
        ok(labels.includes('颜色') && labels.includes('保存收藏'), 'main colour screen');
        name = 'animations'; await tab(1);
        ok(labels.includes('呼吸') && labels.includes('流光'), 'animation labels');
        name = 'modes'; await tab(2);
        ok(labels.includes('运动') && labels.includes('选择颜色'), 'driving modes');
        name = 'edit-sport'; await targets['sport-any']();
        ok(labels.includes('运动模式配色') && labels.includes('正在设置运动模式'), 'dynamic mode text');
        name = 'favourites'; control.saveFav(); await tab(3);
        ok(labels.includes('收藏') && labels.includes('未保存'), 'saved and empty favourites');
        name = 'module-unavailable'; lights.state = 'none'; await tab(0);
        ok(labels.includes('车身模块未响应，暂时无法自定义颜色。'), 'unavailable fallback');
        name = 'conflicting-app'; others.comfort = true; await tab(0);
        ok(labels.includes('其他应用同时控灯'), 'conflict warning wraps');
        name = 'strobe'; others.comfort = false; values.strobe = true; await tab(4);
        ok(labels.includes('仅限私人场地使用。') && labels.includes('启动频闪'), 'translated safety and controls');
        const untranslated = allLabels.filter((s) => /[A-Za-z]{3}/.test(s.replace(/BDC_G11|BDC_G05|BDC|BMW|FLM01|FLE|Comfort|Redline/g, '')));
        assert.deepStrictEqual(untranslated, [], 'visible English leftovers across all screens');
        console.log('Ambient Chinese UI: ' + checks + ' checks, 8 rendered states; settings and control keys preserved');
    } finally {
        timers.forEach(clearInterval);
        global.setInterval = realInterval;
        Recorder.prototype.text = drawText;
    }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
