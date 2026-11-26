'use strict';
/**
 * test_sys_monitor_layout.js - System Monitor's pages as drawn (apps/sys_monitor/main.js), no head unit, SDK or
 * build needed; in CI on Node 8 too.
 *
 * It runs the app as the kit would, on its sample data (sample.js) with a few harder cases added: a long app
 * name, a long program name and command line, a program with many processes. The clock is made up, so three
 * minutes of samples take no time. Every page, sort, scroll position and detail view is drawn, and each text
 * drawn must
 *   - stay on the page (the 1600 px wide drawing, down to its bottom),
 *   - stay inside the panel it starts in (tiles, lists, charts), and
 *   - not overlap another text.
 * Each is drawn three ways: as in the emulator, with the room the full-screen layout gives under the page
 * (cv.extra: panels reach further down), and with the smallest readable text size of the 8.8" panel (the kit
 * draws smaller text at that size: what is cut to fit must still fit).
 *
 *   node kit/tools/test_sys_monitor_layout.js [pngDir]     pngDir: also save every page drawn there, to look at
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'sys_monitor');
const KIT = path.join(ROOT, 'kit', 'runtime');
const PNG_DIR = process.argv[2] ? path.resolve(process.argv[2]) : null;
const { Recorder, play } = require(path.join(KIT, 'record'));
const { Canvas } = require(path.join(KIT, 'canvas'));
const themes = require(path.join(KIT, 'themes'));
const realG = require(path.join(KIT, 'gauges'));
const realProcs = require(path.join(APP, 'procs'));
const { SampleSampler } = require(path.join(APP, 'sample'));

const MB = 1024 * 1024;
const W = 1600, H = 520;
// the 8.8" panel's smallest readable text: 2.6 mm (display.js MIN_TEXT_MM) at its logical px per mm, about 21
const MIN_TEXT_88 = 21;

/* ---------------- a made-up clock and timers: three minutes of samples in no time ---------------- */
let now = Date.UTC(2026, 0, 1, 8, 40);
const realNow = Date.now, realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
let timers = [], timerSeq = 0;
function fakeTime() {
    Date.now = () => now;
    global.setTimeout = (fn, ms) => { const id = { id: ++timerSeq, at: now + (ms || 0), fn }; timers.push(id); return id; };
    global.clearTimeout = (id) => { timers = timers.filter((x) => x !== id); };
}
function realTime() { Date.now = realNow; global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; }
/** Run what is due over the next s seconds, in order. */
function advance(s) {
    const end = now + s * 1000;
    for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = Math.max(now, next.at);
        next.fn();
    }
    now = end;
}

/* ---------------- the sample data, with the harder cases ---------------- */
const LONG_APP = 'The Longest App Name the MGU Store Has Ever Seen, With a Subtitle';
const LONG_PROG = 'com.example.navigation.background-map-tile-prefetcher-service';
const fixture = {
    extra: true,             // the harder cases below
    restricted: false,       // the head unit shows the app only its own processes
    noMem: false,            // no /proc/meminfo
    noCpu: false,            // processor use not measured (yet)
    gone: null,              // a pid that ended
};
class FixtureSampler extends SampleSampler {
    sample() {
        const s = super.sample();
        if (fixture.extra) {
            const base = s.procs[s.procs.length - 1];
            const add = (o) => s.procs.push(Object.assign({}, base, { state: 'S', ppid: 1, swap: 0, threads: 4, age: 600, self: false }, o));
            add({ pid: 2001, name: 'node', uid: 12470, mem: 54 * MB, rss: 90 * MB, cpu: 0.7, app: LONG_APP, named: true, kind: 'app', store: true });
            add({ pid: 2002, name: LONG_PROG, uid: 0, mem: 33 * MB, rss: 50 * MB, cpu: 99.9, app: null, kind: null, store: false });
            for (let i = 0; i < 14; i++) {
                add({ pid: 2100 + i, name: 'gst-launch-1.0', uid: 1004, mem: (14 - i) * MB, rss: (20 - i) * MB, cpu: i * 0.3, app: null, kind: null, store: false });
            }
        }
        if (fixture.gone) s.procs = s.procs.filter((p) => p.pid !== fixture.gone);
        if (fixture.restricted) { s.procs = s.procs.filter((p) => p.self); s.restricted = true; }
        if (fixture.noMem) s.mem = null;
        if (fixture.noCpu) { s.cpu = null; s.procs.forEach((p) => { p.cpu = null; }); s.load = null; s.temp = null; s.freq = null; }
        return s;
    }
    command(pid) {
        if (pid === 2002) return '/opt/nav/bin/' + LONG_PROG + ' --cache-dir=/var/opt/nav/cache/tiles --prefetch-radius-km=40 --verbose';
        if (pid >= 2100 && pid < 2200) return 'gst-launch-1.0 playbin uri=file:///var/opt/media/stream-' + pid + '.mp4';
        if (pid === 2001) return 'node /var/opt/public/oap/oap_12470/source/javascript/app.js';
        return super.command(pid);
    }
}
class NoProc { available() { return false; } }

/* ---------------- what each frame drew: its texts and panels ---------------- */
let frame = null;               // { texts: [{ s, x0, x1, top, bottom, size }], panels: [{ x, y, w, h, title }] }
let mode = { extra: 0, minText: 0 };
function box(s, x, y, size, opts, w) {
    opts = opts || {};
    const x0 = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
    // the glyphs' reach round the baseline: capitals and digits over it, descenders under it
    return { s: String(s), x0, x1: x0 + w, top: y - size * 0.74, bottom: y + size * 0.2, size };
}
function recorder(w, h) {
    const r = new Recorder(w, h);
    r.own = true;                       // the kit runs the screen: targets and the app's own buttons are drawn
    r.extra = mode.extra;
    r.minText = mode.minText;
    const text = r.text.bind(r);
    r.text = (str, x, y, size, c, opts) => {
        const drawn = text(str, x, y, size, c, opts);
        const sz = Math.max(size, r.minText);
        if (drawn > 0 && frame) frame.texts.push(box(str, x, y, sz, opts, drawn));
        return drawn;
    };
    return r;
}
// G.panel draws its title in a cached layer: noted here, where it lands on the page
const G = Object.assign({}, realG, {
    panel(cv, t, x, y, w, h, title, literal) {
        const p = realG.panel(cv, t, x, y, w, h, title, literal);
        if (frame) {
            frame.panels.push({ x: p.x, y: p.y, w: p.w, h: p.h, title });
            if (title) {
                const size = Math.max(26, cv.minText || 0);
                frame.texts.push(box(title, p.x + 18, p.y + 42, size, null, cv.textWidth(String(title), 26, { font: 'bold', literal })));
            }
        }
        return p;
    },
});

/* ---------------- the checks ---------------- */
const problems = [];
function check(name, f, cv) {
    const bottom = H + (cv.extra || 0), say = (what) => problems.push(name + ': ' + what);
    const label = (b) => JSON.stringify(b.s.length > 48 ? b.s.slice(0, 46) + '..' : b.s);
    const T = 1;                                            // px of slack for rounding
    f.texts.forEach((b) => {
        if (b.x0 < -T || b.x1 > W + T || b.top < -T || b.bottom > bottom + T) {
            say(label(b) + ' leaves the page (x ' + Math.round(b.x0) + '..' + Math.round(b.x1) + ', y ' + Math.round(b.top) + '..' + Math.round(b.bottom) + ')');
        }
        // the panel it starts in: the innermost one round its start
        const inside = f.panels.filter((p) => b.x0 + 2 >= p.x && b.x0 + 2 <= p.x + p.w && b.top + b.size * 0.4 >= p.y && b.top + b.size * 0.4 <= p.y + p.h)
            .sort((a, c) => a.w * a.h - c.w * c.h)[0];
        if (inside && (b.x1 > inside.x + inside.w + T || b.bottom > inside.y + inside.h + T || b.top < inside.y - T)) {
            say(label(b) + ' leaves its panel ' + JSON.stringify(inside.title || '') + ' (x ' + Math.round(b.x0) + '..' + Math.round(b.x1)
                + ' of ' + inside.x + '..' + (inside.x + inside.w) + ', y ' + Math.round(b.top) + '..' + Math.round(b.bottom) + ' of ' + inside.y + '..' + (inside.y + inside.h) + ')');
        }
    });
    for (let i = 0; i < f.texts.length; i++) {
        for (let j = i + 1; j < f.texts.length; j++) {
            const a = f.texts[i], b = f.texts[j];
            const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 2 && oy > 2) say(label(a) + ' and ' + label(b) + ' overlap');
        }
    }
}

/* ---------------- the app, as the kit runs it ---------------- */
async function runApp(m, name) {
    mode = m;
    fixture.extra = true; fixture.restricted = false; fixture.noMem = false; fixture.noCpu = false; fixture.gone = null;
    timers = [];
    const values = { theme: 'm_tricolour', group: true, interval: 2 };
    const settingsListeners = [], visible = [], clicks = {}, errors = [];
    let impl = null, onTab = null, onScroll = null, last = null, frames = 0;
    const realLoad = Module._load;
    Module._load = function (req, parent) {
        if (parent && parent.filename && path.dirname(parent.filename) === APP) {
            if (req === './kit/mgu') return { run: (x) => { impl = x; } };
            if (req === './kit/canvas') return require(path.join(KIT, 'canvas'));
            if (req === './kit/gauges') return G;
            if (req === './kit/i18n') return require(path.join(KIT, 'i18n'));
            if (req === './procs') return Object.assign({}, realProcs, { Sampler: NoProc });
            if (req === './sample') return { SampleSampler: FixtureSampler };
        }
        return realLoad.apply(this, arguments);
    };
    try {
        delete require.cache[require.resolve(path.join(APP, 'main.js'))];
        require(path.join(APP, 'main.js'));
    } finally { Module._load = realLoad; }
    assert(impl, 'main.js calls mgu.run');
    const log = { debug() {}, info() {}, warn: (m) => errors.push('warn ' + m), error: (m, e) => errors.push('error ' + m + ' ' + (e && e.stack || e || '')) };
    const ctx = {
        log, dataDir: path.join(ROOT, 'dist', 'nowhere', 'data'), spec: { title: 'System Monitor' },
        settings: { get: (k) => values[k], set: (k, v) => { values[k] = v; settingsListeners.forEach((fn) => fn(k, v)); }, onChange: (fn) => settingsListeners.push(fn) },
        ui: {
            onVisible: (fn) => visible.push(fn), isVisible: () => false, onClick: (n, fn) => { clicks[n] = fn; },
            image: async (n, cv) => { last = cv; frames++; },
        },
        canvas: (w, h) => { frame = { texts: [], panels: [] }; return recorder(w, h); },
        theme: () => themes.theme(values.theme),
        onTab: (fn) => { onTab = fn; }, onScroll: (fn) => { onScroll = fn; }, onLayout() {},
        loop: () => ({ stop() {}, kick() {} }),
    };
    await impl.start(ctx);
    const settle = () => new Promise((res) => setImmediate(res));
    let shot = 0;
    const app = {
        values, errors,
        async show(on) { visible.forEach((fn) => fn('MAIN', on)); await settle(); },
        async wait(s) { advance(s); await settle(); },
        async tab(i) { await onTab(i); await settle(); },
        async tap(key) {
            const tg = last.targets.find((x) => x.key === key);
            assert(tg, name + ': nothing to tap with key ' + key + ' (' + last.targets.map((x) => x.key).join(', ') + ')');
            await tg.run(); await settle();
        },
        /** Tap a row of the Processes page, scrolling down to it first. */
        async row(key) {
            await this.scroll(-100000);
            for (let i = 0; i < 60 && !last.targets.some((x) => x.key === key); i++) await this.scroll(46);
            await this.tap(key);
        },
        keys(prefix) { return last.targets.map((x) => x.key).filter((k) => k.indexOf(prefix) === 0); },
        async scroll(dy) { onScroll(dy); await settle(); },
        async set(k, v) { ctx.settings.set(k, v); await settle(); },
        /** Check the last frame drawn (as name / what). */
        look(what) {
            assert(last && frames, name + ': nothing drawn');
            const f = frame, cv = last;
            check(name + ' / ' + what, f, cv);
            if (PNG_DIR) {
                const c = new Canvas(W, H + (cv.extra || 0));
                play(cv.words(), c);
                const file = path.join(PNG_DIR, (name + '-' + String(++shot).padStart(2, '0') + '-' + what).replace(/[^\w.-]+/g, '_') + '.png');
                fs.writeFileSync(file, c.png());
            }
            return cv;
        },
    };
    return app;
}

async function scenario(m, name) {
    const a = await runApp(m, name);
    await a.show(true);
    a.look('overview, first sample');
    await a.wait(1.2);
    a.look('overview, processor measured');
    await a.wait(190);
    a.look('overview');
    await a.tab(1); a.look('processor');
    await a.tab(2); a.look('processes');
    // every column, both ways round
    for (const by of ['name', 'count', 'mem', 'pct', 'grow', 'cpu']) {
        await a.tap('sort_' + by); a.look('processes by ' + by);
        await a.tap('sort_' + by); a.look('processes by ' + by + ', reversed');
    }
    await a.tap('sort_mem');
    await a.scroll(100000); a.look('processes, scrolled to the end');
    await a.scroll(-100000);
    // a group's details: one with many processes (its list scrolls), the largest program, the one that grows, a long name, this app
    for (const key of ['row_name:gst-launch-1.0', 'row_name:HmiMain3D', 'row_app:12449', 'row_app:12470', 'row_app:12447']) {
        await a.row(key);
        a.look('details ' + key.slice(4));
        await a.scroll(100000); a.look('details ' + key.slice(4) + ', scrolled');
        await a.tap('back');
    }
    // one process's details (not grouped): the long command line, and one that ends while shown
    await a.set('group', false);
    a.look('processes, not grouped');
    await a.scroll(100000); a.look('processes, not grouped, scrolled to the end');
    await a.scroll(-100000);
    await a.row('row_pid:2002'); a.look('details of one process');
    fixture.gone = 2002;
    await a.wait(4); a.look('details of a process that ended');
    await a.tap('back');
    await a.set('group', true);
    // from the overview's lists
    await a.tab(0);
    await a.tap(a.keys('top_')[0]); a.look('details from the overview'); await a.tap('back');
    // what the head unit may not say
    fixture.noCpu = true; await a.wait(4);
    await a.tab(0); a.look('overview, no processor figures');
    await a.tab(1); a.look('processor, no processor figures');
    fixture.noCpu = false; fixture.noMem = true; await a.wait(4);
    await a.tab(0); a.look('overview, no memory figures');
    await a.tab(2); a.look('processes, no memory figures');
    fixture.noMem = false; fixture.restricted = true; await a.wait(4);
    await a.tab(0); a.look('overview, own processes only');
    await a.tab(1); a.look('processor, own processes only');
    await a.tab(2); a.look('processes, own processes only');
    // off screen and back: it starts again
    await a.show(false);
    await a.wait(600);
    fixture.restricted = false;
    await a.show(true);
    await a.tab(0); a.look('overview, back after a while');
    await a.show(false);
    assert.deepStrictEqual(a.errors.filter((e) => !/temperature sensor/.test(e)), [], name + ': the app logged problems');
}

(async () => {
    if (PNG_DIR && !fs.existsSync(PNG_DIR)) fs.mkdirSync(PNG_DIR);
    fakeTime();
    try {
        await scenario({ extra: 0, minText: 0 }, 'emulator');
        await scenario({ extra: 128, minText: 0 }, 'full screen');
        await scenario({ extra: 0, minText: MIN_TEXT_88 }, '8.8 inch');
    } finally { realTime(); }
    if (problems.length) {
        console.error(problems.length + ' layout problems:\n  ' + problems.join('\n  '));
        process.exit(1);
    }
    console.log('test_sys_monitor_layout: ok');
})().catch((e) => { realTime(); console.error(e && e.stack || e); process.exit(1); });
