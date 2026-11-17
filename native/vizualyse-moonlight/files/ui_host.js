// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A tool's touch screen on the central screen: the kit's widgets
 * (ui_kit.js) in mgu-render's app area, read by touch. Grown from
 * vizualyse-cluster's picker. Node 8.
 *
 *   const ui = new TouchScreen({ name, dir, clientPath, log, touch,
 *       state: () => model, view: (model, ui) => view, act: (id, value) => error | null });
 *   ui.show(); ui.invalidate(); ui.hide(why); ui.on('list', ...)
 *
 * - The picture: one opaque RGBX pixmap the size of the app area (1790x638
 *   at +108+82: the HMI's title bar and back strip stay the HMI's). Only
 *   the rectangles that changed go to mgu-render; an IMAGE op at least once
 *   a second keeps the app shown (three silent seconds and mgu-render hides
 *   it).
 * - Frames: invalidate() asks for one; at most one every FRAME_MS. A frame
 *   asks the tool for its model once (state()), so a tool must answer that
 *   from memory, never from disk.
 * - Touch: read passively (touch_reader.py on mgu-python, an AF_PACKET copy
 *   of the display's PDUs on vlan73), never claimed: a claim through
 *   mgu-render restarted the head unit. The HMI gets every touch too, so the
 *   app shows an empty RHMI state under the picture. A tap is a down and an
 *   up on the same widget within SLOP px; the press shows at once (its own
 *   frame), the action runs on the next turn of the event loop. A finger
 *   moving within SLOP draws nothing.
 * - The kit's own taps: the List corner (emits 'list': the app goes to its
 *   iDrive list), tabs, dropdowns and their sheet. Every other tap is the
 *   tool's: act(id, value), value a seg's or sheet's option, a toggle's new
 *   state, 'next' / 'prev' for a swipe. An error it returns shows in the
 *   status line for ERROR_MS.
 * - Timing: each tap's time from its touch to the pixels sent is logged as a
 *   summary every TIMING_EVERY taps and when the screen hides.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const kit = require('./ui_kit.js');

const PIXMAP = 1;
const DEFAULT_AREA = { x: 108, y: 82, w: kit.AREA.w, h: kit.AREA.h };
const SLOP = 24;
const SWIPE = 80;
const FRAME_MS = 33;
const ERROR_MS = 6000;
const TIMING_EVERY = 20;

function ms(t0) { const d = process.hrtime(t0); return d[0] * 1e3 + d[1] / 1e6; }

class TouchScreen extends EventEmitter {
    /* opts: name (mgu-render's client name), dir (the kit's folder: fonts,
     * touch_reader.py), clientPath (mgu-render's client), log, touch
     * { python, iface, src, file, cmd }, state(), view(model, ui), act(id, value),
     * tabs: the first tab's id (optional) */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        this.F = null;
        this.surface = null;
        this.gpu = null;
        this.area = null;
        this.keepAlive = null;
        this.tick = null;
        this.touch = null;
        this.ui = { tab: null, open: null };
        this.pressed = null;
        this.gesture = null;
        this.error = null;
        this.widgets = [];
        this.timer = null;
        this.lastFrame = 0;
        this.taps = [];
        this.tapAt = null;
    }

    shown() { return !!this.gpu; }

    show() {
        if (this.gpu) return null;
        let client;
        try {
            if (!this.F) this.F = kit.loadFonts(this.o.dir);
            client = require(this.o.clientPath);
        } catch (e) { return 'the touch screen cannot start: ' + e.message; }
        const say = (s) => this.log('ui: ' + s);
        const gpu = new client.RenderClient(this.o.name, { info: say, warn: say, error: say }, { mode: 'layer' });
        this.gpu = gpu;
        this.imageOp = client.imageOp;
        this.surface = new kit.Surface(this.F);
        gpu.on('ready', (screen, info) => {
            if (this.gpu !== gpu) return;
            const a = info && info.appArea && info.appArea.w ? info.appArea : DEFAULT_AREA;
            this.area = { x: a.x, y: a.y, w: kit.AREA.w, h: kit.AREA.h };
            if (a.w !== kit.AREA.w || a.h !== kit.AREA.h) say('app area ' + a.w + 'x' + a.h + '+' + a.x + '+' + a.y + ': drawn at ' + kit.AREA.w + 'x' + kit.AREA.h);
            gpu.mode('layer');
            gpu.place({ x: this.area.x, y: this.area.y, w: this.area.w, h: this.area.h, scale: 1, ox: 0, oy: 0 });
            gpu.pixmap(PIXMAP, kit.AREA.w, kit.AREA.h, 'rgbx', 'nearest');
            this.surface.reset();
            this.frame();
            gpu.show(true);
            say('shown at ' + this.area.w + 'x' + this.area.h + '+' + this.area.x + '+' + this.area.y);
        });
        gpu.on('renderer-error', (e) => say('renderer error: ' + e));
        gpu.connect();
        this.keepAlive = setInterval(() => this._op(), 1000);
        /* countdowns and what changed elsewhere: once a second at least */
        this.tick = setInterval(() => this.invalidate(), 1000);
        this._startTouch();
        return null;
    }

    hide(why) {
        if (!this.gpu) return;
        const gpu = this.gpu;
        this.gpu = null;
        clearInterval(this.keepAlive);
        clearInterval(this.tick);
        clearTimeout(this.timer);
        this.timer = null;
        this._stopTouch();
        try { gpu.show(false); gpu.close(); } catch (e) { /* gone */ }
        this.area = null;
        this.pressed = null;
        this.gesture = null;
        this.ui.open = null;
        /* a tap that hid the screen (List) has no frame to time */
        this.tapAt = null;
        this._timing(true);
        this.log('ui: hidden' + (why ? ' (' + why + ')' : ''));
    }

    /* a frame soon: at once if the last was long enough ago */
    invalidate() {
        if (!this.gpu || !this.area || this.timer) return;
        const wait = Math.max(0, FRAME_MS - (Date.now() - this.lastFrame));
        this.timer = setTimeout(() => { this.timer = null; this.frame(); }, wait);
    }

    /* the widgets for the tool's model now */
    build() {
        const model = this.o.state();
        const view = this.o.view(model, { tab: this.ui.tab });
        if (view.tabs && view.tabs.length && (!this.ui.tab || !view.tabs.some((t) => t[0] === this.ui.tab))) {
            this.ui.tab = view.tabs[0][0];
            return this.build();
        }
        view.tab = this.ui.tab;
        const err = this.error && Date.now() - this.error.at < ERROR_MS ? this.error.text : null;
        if (err) view.status = Object.assign({}, view.status, { tone: 'bad', text: 'Error: ' + err });
        if (this.ui.open && !(view.body || []).some((d) => d.id === this.ui.open && d.kind === 'dropdown' && d.on !== false)) this.ui.open = null;
        return kit.frame(this.F, view, this.ui);
    }

    frame() {
        if (!this.gpu || !this.area) return;
        this.lastFrame = Date.now();
        this.widgets = this.build();
        const rects = this.surface.render(this.widgets, this.pressed);
        if (rects.length) {
            this.gpu.pixels(PIXMAP, rects, this.surface.cv.px);
            this._op();
        }
        if (this.tapAt) { this.taps.push(ms(this.tapAt)); this.tapAt = null; this._timing(false); }
    }

    _op() { if (this.gpu && this.area) this.gpu.frameWords(this.imageOp(PIXMAP, 0, 0, kit.AREA.w, kit.AREA.h, 0)); }

    _timing(flush) {
        if (!this.taps.length || (!flush && this.taps.length < TIMING_EVERY)) return;
        const t = this.taps.slice().sort((a, b) => a - b);
        this.log('ui: ' + t.length + ' touches to pixels: median ' + t[t.length >> 1].toFixed(1) + ' ms, max ' + t[t.length - 1].toFixed(1) + ' ms');
        this.taps = [];
    }

    /* ---- touch ---- */
    _startTouch() {
        const t = this.o.touch || {};
        const cmd = t.cmd || [t.python, path.join(this.o.dir, 'touch_reader.py')].concat(t.file ? ['--file', t.file] : ['--iface', t.iface, '--src', t.src]);
        if (!t.cmd && (!t.python || !fs.existsSync(t.python))) { this.log('ui: touch: no ' + t.python); return; }
        let p;
        try { p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this.log('ui: touch: ' + e.message); return; }
        this.touch = p;
        let rest = '';
        p.stdout.on('data', (d) => {
            const lines = (rest + d).split('\n');
            rest = lines.pop();
            lines.forEach((l) => {
                if (this.touch !== p) return;   /* a reader already stopped */
                let e;
                try { e = JSON.parse(l); } catch (x) { return; }
                if (e.ev === 'touch') this.onTouch(e.p, e.x, e.y);
                else if (e.ev === 'ready') this.log('ui: touch ready (' + (e.touch ? 'reading' : 'no touch') + ')');
                else if (e.ev === 'error') this.log('ui: touch: ' + e.error);
            });
        });
        p.stderr.on('data', (d) => this.log('ui: touch: ' + String(d).trim().slice(0, 300)));
        p.stdin.on('error', () => { /* it exited */ });
        p.on('error', (e) => this.log('ui: touch: ' + e.message));
        p.on('exit', (code, sig) => { if (this.touch === p) { this.touch = null; this.log('ui: touch exited (' + (sig || code) + ')'); } });
    }

    _stopTouch() {
        if (!this.touch) return;
        const p = this.touch;
        this.touch = null;
        try { p.stdin.end(); } catch (e) { /* gone */ }
        setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
    }

    /* phase 1 down, 2 move, 3 up; x, y screen pixels (-1 when the up was lost) */
    onTouch(phase, sx, sy) {
        if (!this.gpu || !this.area) return;
        const x = sx - this.area.x, y = sy - this.area.y;
        if (phase === 1 || (phase === 2 && !this.gesture)) {
            const h = kit.hit(this.F, this.widgets, x, y);
            const tappable = h && h.w.act && h.w.on !== false;
            this.gesture = { x: x, y: y, hit: h, moved: false };
            const p = tappable ? { id: h.w.id, part: h.part } : null;
            if (!same(p, this.pressed)) { this.pressed = p; this.tapAt = process.hrtime(); this.invalidate(); }
            return;
        }
        const g = this.gesture;
        if (!g) return;
        if (phase === 2) {
            if (!g.moved && (Math.abs(x - g.x) > SLOP || Math.abs(y - g.y) > SLOP)) {
                g.moved = true;
                if (this.pressed) { this.pressed = null; this.invalidate(); }
            }
            return;
        }
        /* up */
        this.gesture = null;
        const was = this.pressed;
        this.pressed = null;
        if (sx < 0) { this.invalidate(); return; }
        const dx = x - g.x, dy = y - g.y;
        const h = g.hit;
        if (h && h.w.swipe && Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy)) {
            this._later(h.w, dx < 0 ? 'next' : 'prev');
        } else if (was && !g.moved && Math.abs(dx) <= SLOP && Math.abs(dy) <= SLOP) {
            this._later(h.w, h.part);
        } else if (this.ui.open && !h) {
            /* a touch beside an open sheet closes it */
            this.ui.open = null;
        }
        this.tapAt = process.hrtime();
        this.invalidate();
    }

    /* the action on the next turn: the release is drawn first */
    _later(w, p) { setImmediate(() => this.tap(w.id, p)); }

    /* a widget's action by id (a tap, or the tool's own: the iDrive app's) */
    tap(id, p) {
        const w = this.widgets.filter((d) => d.id === id)[0];
        if (!w || (w.on === false && !w.swipe)) return;
        let value = null;
        if (id === '_list') { this.ui.open = null; this.log('ui: list'); this.emit('list'); return; }
        if (id === '_tabs') { const t = w.tabs[p]; if (t) { this.ui.tab = t[0]; this.ui.open = null; } this.invalidate(); return; }
        if (w.kind === 'dropdown') { this.ui.open = this.ui.open === id ? null : id; this.invalidate(); return; }
        if (id === '_sheet') {
            this.ui.open = null;
            const o = w.options[p];
            if (!o) { this.invalidate(); return; }
            return this._act(w.of, o.v);
        }
        this.ui.open = null;
        if (p === 'next' || p === 'prev') value = p;
        else if (w.kind === 'seg') { const o = w.options[p]; if (!o || o.v === w.value) { this.invalidate(); return; } value = o.v; }
        else if (w.kind === 'toggle') value = !w.value;
        else if (w.value !== undefined) value = w.value;
        return this._act(id, value);
    }

    _act(id, value) {
        this.log('ui: ' + id + (value === null || value === undefined ? '' : ' ' + value));
        let err = null;
        try { err = this.o.act(id, value); } catch (e) { err = e.message; }
        this.error = err ? { text: err, at: Date.now() } : null;
        this.emit('change');
        this.invalidate();
    }
}

function same(a, b) { return (!a && !b) || (a && b && a.id === b.id && a.part === b.part); }

module.exports = { TouchScreen, SLOP, SWIPE, FRAME_MS };
