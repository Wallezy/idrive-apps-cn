// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The touch kit: the look and the widgets every Vizualyse touch screen is
 * built from, and the renderer that redraws only what changed. Pure (no I/O
 * but loadFonts): ui_host.js puts the result on the central screen, the
 * tests draw it to a PNG. Node 8.
 *
 * A screen is a list of widget descriptors, drawn in order (later on top):
 *   { id, kind, x, y, w, h, act (a tap does something), on (false: shown
 *     disabled), swipe (a horizontal swipe is an action), ...the kind's props }
 * Kinds: panel, text, button, seg, toggle, dropdown, sheet, tabs, status,
 * chip, image, tile, info, progress, qr, icon. A picture is passed as `img`
 * ({ w, h, rgba }) with an `imgKey` naming it (pictures are not compared:
 * a live picture needs a new imgKey for each frame to be redrawn; set
 * `opaque: true` on a picture known to be opaque, or the first draw scans
 * its alpha). A qr's `matrix` is compared by its content, worked out once
 * per matrix object: keep one per link.
 *
 * Surface.render(widgets, pressed) compares each widget with the last
 * render's by id; the rectangles of what changed (old and new place) are
 * merged, and each is cleared and redrawn, clipped, with every widget that
 * touches it. A press redraws one button; a tab change, the body.
 *
 * The frame (frame()): the app area's 1790x638 (mgu-render's, at +108+82 of
 * the screen; the HMI's title bar and back strip stay the car's): tabs or a
 * title at the top left, the List corner at the top right, the body at
 * BODY, the status line at the bottom.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Canvas, measure, fit } = require('./ui_canvas.js');

/* Green on graphite (chosen 2026-11-15) */
const T = {
    bg: 0x0b0e12, panel: 0x1a1f27, hi: 0x2a323e, line: 0x242b35, text: 0xf1f4f8, dim: 0x8d97a6,
    mute: 0x5d6675, off: 0x9aa4b2, accent: 0x23875a, accentInk: 0xd3f0e1, warn: 0xf2a33a, ok: 0x8be0b8,
    bad: 0xef5350, white: 0xffffff, black: 0x000000,
};
const AREA = { w: 1790, h: 638 };
const TOP = { x: 24, y: 16, h: 64 };
const BODY = { x: 24, y: 104, w: 1742, h: 462 };
const STATUS = { y: 582, h: 56 };
const CORNER = { x: AREA.w - 24 - 152, y: TOP.y, w: 152, h: TOP.h };
const MIN_TARGET = 64;
const FONTS = { f20: { size: 20, weight: 500 }, f24: { size: 24, weight: 600 }, f32: { size: 32, weight: 600 }, f44: { size: 44, weight: 600 } };
const GLYPHS = Array.from({ length: 95 }, (x, i) => String.fromCharCode(32 + i)).join('') + '·×°';

/* the fonts: <prefix>.fonts.json and its atlases in dir */
function loadFonts(dir, prefix) {
    prefix = prefix || 'ui';
    const meta = JSON.parse(fs.readFileSync(path.join(dir, prefix + '.fonts.json'), 'utf8'));
    const out = {};
    Object.keys(meta).forEach((k) => {
        const f = meta[k], index = {};
        f.glyphs.split('').forEach((c, i) => { index[c] = i; });
        out[k] = { w: f.w, h: f.h, top: f.top, cell: f.cell, lineH: f.lineH, adv: f.adv, index: index, r8: zlib.gunzipSync(fs.readFileSync(path.join(dir, f.file))) };
    });
    return out;
}

function col(c) { return typeof c === 'string' ? (T[c] !== undefined ? T[c] : T.text) : c === undefined ? T.text : c; }

/* ---- icons, drawn in a size x size box centred on cx, cy ---- */
function icon(cv, name, cx, cy, size, colour) {
    const s = size / 32, w = 3.2 * s, c = col(colour);
    const L = (a, b, d, e) => cv.line(cx + (a - 16) * s, cy + (b - 16) * s, cx + (d - 16) * s, cy + (e - 16) * s, w, c);
    switch (name) {
    case 'list': L(11, 9, 26, 9); L(11, 16, 26, 16); L(11, 23, 26, 23); L(5, 9, 5, 9); L(5, 16, 5, 16); L(5, 23, 5, 23); break;
    case 'back': L(20, 6, 10, 16); L(10, 16, 20, 26); break;
    case 'fwd': L(12, 6, 22, 16); L(22, 16, 12, 26); break;
    case 'down': L(9, 12, 16, 19); L(16, 19, 23, 12); break;
    case 'plus': L(8, 16, 24, 16); L(16, 8, 16, 24); break;
    case 'minus': L(8, 16, 24, 16); break;
    case 'check': L(8, 17, 14, 23); L(14, 23, 25, 10); break;
    case 'stop': cv.rrect(cx - 7 * s, cy - 7 * s, 14 * s, 14 * s, 2 * s, c); break;
    case 'play': cv.tri(cx - 5 * s, cy - 9 * s, cx - 5 * s, cy + 9 * s, cx + 9 * s, cy, c); break;
    case 'home': L(5, 15, 16, 6); L(16, 6, 27, 15); L(8, 13, 8, 26); L(8, 26, 24, 26); L(24, 26, 24, 13); break;
    case 'reload': {
        let px = null, py = null;
        for (let k = 0; k <= 12; k++) {
            const a = -0.75 + k * (4.9 / 12), x = 16 + 9 * Math.cos(a), y = 16 + 9 * Math.sin(a);
            if (px !== null) L(px, py, x, y);
            px = x; py = y;
        }
        L(23, 4, 23, 10); L(23, 10, 17, 10);
        break;
    }
    default: cv.rrect(cx - 4 * s, cy - 4 * s, 8 * s, 8 * s, 4 * s, c);
    }
}

/* ---- sizes the kit works out ---- */
function chipW(F, text) { return measure(F.f20, String(text)) + 32 + 20; }
function tabWidths(F, tabs) { return tabs.map((t) => Math.max(200, measure(F.f24, t[1]) + 72)); }

/* ---- the kinds ---- */
const PRESS = 0.16;

function centreText(cv, F, d, label, sub, colour, subColour, x, w) {
    x = x === undefined ? d.x : x; w = w === undefined ? d.w : w;
    const cx = x + w / 2;
    if (sub) {
        const top = d.y + (d.h - 58) / 2;
        cv.text(F.f24, fit(F.f24, label, w - 20), cx, top, colour, 'center');
        cv.text(F.f20, fit(F.f20, sub, w - 20), cx, top + 32, subColour, 'center');
    } else {
        cv.text(F.f24, fit(F.f24, label, w - 20), cx, d.y + (d.h - F.f24.lineH) / 2, colour, 'center');
    }
}

const DRAW = {
    panel(cv, F, d) { cv.rrect(d.x, d.y, d.w, d.h, d.r === undefined ? 16 : d.r, col(d.colour || 'panel')); },

    text(cv, F, d) {
        const f = F[d.font || 'f24'], s = fit(f, d.text || '', d.w);
        const x = d.align === 'center' ? d.x + d.w / 2 : d.align === 'right' ? d.x + d.w : d.x;
        cv.text(f, s, x, d.y + (d.h - f.lineH) / 2, col(d.colour), d.align || 'left');
    },

    button(cv, F, d, pressed) {
        const dis = d.on === false, style = d.style || 'secondary';
        const r = d.r === undefined ? 12 : d.r;
        if (dis || style === 'quiet') {
            if (d.under !== undefined) cv.rrect(d.x, d.y, d.w, d.h, r, col(d.under));
            /* the raised colour: it shows on the ground and on a panel card */
            cv.ring(d.x, d.y, d.w, d.h, r, 2, T.hi);
        } else {
            cv.rrect(d.x, d.y, d.w, d.h, r, style === 'primary' ? T.accent : style === 'raised' ? T.hi : T.panel);
        }
        if (pressed && !dis) cv.rrect(d.x, d.y, d.w, d.h, r, T.white, PRESS);
        const fg = dis ? T.mute : style === 'quiet' ? T.dim : T.text;
        const subFg = dis ? T.mute : style === 'primary' ? T.accentInk : T.dim;
        if (d.icon && !d.label) { icon(cv, d.icon, d.x + d.w / 2, d.y + d.h / 2, 34, fg); return; }
        if (d.icon) {
            const lw = measure(F.f24, d.label), gw = 34 + 12 + lw, x0 = d.x + (d.w - gw) / 2;
            icon(cv, d.icon, x0 + 17, d.y + d.h / 2, 30, fg);
            cv.text(F.f24, d.label, x0 + 46, d.y + (d.h - F.f24.lineH) / 2, fg);
            return;
        }
        centreText(cv, F, d, d.label || '', d.sub, fg, subFg);
    },

    seg(cv, F, d, pressed) {
        cv.rrect(d.x, d.y, d.w, d.h, 12, T.panel);
        const n = d.options.length, inner = { x: d.x + 4, y: d.y + 4, w: d.w - 8, h: d.h - 8 };
        d.options.forEach((o, i) => {
            const x = inner.x + Math.round(i * (inner.w + 4) / n), x1 = inner.x + Math.round((i + 1) * (inner.w + 4) / n) - 4;
            const chosen = o.v === d.value;
            if (chosen) cv.rrect(x, inner.y, x1 - x, inner.h, 9, d.on === false ? T.hi : T.accent);
            else if (pressed === i) cv.rrect(x, inner.y, x1 - x, inner.h, 9, T.white, 0.12);
            const fg = chosen ? T.text : d.on === false ? T.mute : T.dim;
            centreText(cv, F, { x: x, y: d.y, w: x1 - x, h: d.h }, o.l, o.s, fg, chosen ? T.accentInk : T.dim);
        });
    },

    toggle(cv, F, d, pressed) {
        const dis = d.on === false;
        cv.rrect(d.x, d.y, d.w, d.h, 12, T.panel);
        if (pressed && !dis) cv.rrect(d.x, d.y, d.w, d.h, 12, T.white, PRESS);
        const sx = d.x + d.w - 20 - 76, sy = d.y + (d.h - 40) / 2, tw = sx - d.x - 24 - 16;
        const fg = dis ? T.mute : T.text;
        if (d.sub) {
            const top = d.y + (d.h - 58) / 2;
            cv.text(F.f24, fit(F.f24, d.label, tw), d.x + 24, top, fg);
            cv.text(F.f20, fit(F.f20, d.sub, tw), d.x + 24, top + 32, dis ? T.mute : T.dim);
        } else cv.text(F.f24, fit(F.f24, d.label, tw), d.x + 24, d.y + (d.h - F.f24.lineH) / 2, fg);
        cv.rrect(sx, sy, 76, 40, 20, d.value ? (dis ? T.hi : T.accent) : T.hi);
        cv.rrect(sx + (d.value ? 40 : 4), sy + 4, 32, 32, 16, d.value && !dis ? T.white : dis ? T.mute : T.off);
    },

    dropdown(cv, F, d, pressed) {
        const dis = d.on === false;
        cv.rrect(d.x, d.y, d.w, d.h, 12, T.panel);
        if (d.open) cv.ring(d.x, d.y, d.w, d.h, 12, 2, T.accent);
        if (pressed && !dis) cv.rrect(d.x, d.y, d.w, d.h, 12, T.white, PRESS);
        const o = d.options.filter((x) => x.v === d.value)[0] || { l: d.placeholder || '' };
        const top = d.y + (d.h - 58) / 2, tw = d.w - 24 - 70;
        cv.text(F.f20, fit(F.f20, d.label, tw), d.x + 24, top, dis ? T.mute : T.dim);
        cv.text(F.f24, fit(F.f24, o.l, tw), d.x + 24, top + 26, dis ? T.mute : T.text);
        icon(cv, d.open ? 'fwd' : 'down', d.x + d.w - 40, d.y + d.h / 2, 30, T.dim);
    },

    sheet(cv, F, d, pressed) {
        cv.rrect(d.x, d.y, d.w, d.h, 12, T.hi);
        d.options.forEach((o, i) => {
            const y = d.y + 6 + i * 66;
            if (o.v === d.value) cv.rrect(d.x + 6, y, d.w - 12, 64, 9, T.accent, 0.45);
            if (pressed === i) cv.rrect(d.x + 6, y, d.w - 12, 64, 9, T.white, 0.12);
            cv.text(F.f24, fit(F.f24, o.l, d.w - 90), d.x + 24, y + (64 - F.f24.lineH) / 2, T.text);
            if (o.v === d.value) icon(cv, 'check', d.x + d.w - 40, y + 32, 28, T.accentInk);
        });
    },

    tabs(cv, F, d, pressed) {
        let x = d.x;
        tabWidths(F, d.tabs).forEach((w, i) => {
            const t = d.tabs[i], chosen = t[0] === d.value;
            if (chosen) {
                cv.rrect(x, d.y, w, d.h, 12, T.panel);
                cv.rrect(x + 8, d.y + d.h - 6, w - 16, 6, 3, T.accent);
            } else if (pressed === i) cv.rrect(x, d.y, w, d.h, 12, T.white, 0.08);
            cv.text(F.f24, t[1], x + w / 2, d.y + (d.h - 6 - F.f24.lineH) / 2, chosen ? T.text : T.dim, 'center');
            x += w + 4;
        });
    },

    status(cv, F, d) {
        cv.fill(d.x, d.y, d.w, 2, T.line);
        const cy = d.y + 2 + (d.h - 2) / 2;
        const tone = { ok: T.ok, warn: T.warn, bad: T.bad, live: T.accent }[d.tone] || T.dim;
        cv.rrect(d.x + 24, cy - 7, 14, 14, 7, tone);
        const rw = d.right ? measure(F.f20, d.right) : 0;
        cv.text(F.f24, fit(F.f24, d.text || '', d.w - 24 - 28 - rw - 48), d.x + 52, cy - F.f24.lineH / 2, d.tone === 'bad' || d.tone === 'warn' ? T.warn : T.text);
        if (d.right) cv.text(F.f20, d.right, d.x + d.w - 24, cy - F.f20.lineH / 2, T.dim, 'right');
    },

    chip(cv, F, d) {
        const tone = d.tone || '', bg = tone === 'live' ? T.accent : T.hi;
        if (tone === 'warn') cv.rrect(d.x, d.y, d.w, 36, 18, T.warn, 0.18); else cv.rrect(d.x, d.y, d.w, 36, 18, bg);
        let x = d.x + 16;
        if (tone !== 'live' && tone !== 'warn') {
            cv.rrect(x, d.y + 13, 10, 10, 5, { ok: T.ok, bad: T.bad }[tone] || T.dim);
            x += 20;
        }
        cv.text(F.f20, d.text, x, d.y + (36 - F.f20.lineH) / 2, tone === 'warn' ? T.warn : T.text);
    },

    image(cv, F, d) {
        if (d.img) cv.image(d.img, d.x, d.y, d.r || 0); else cv.rrect(d.x, d.y, d.w, d.h, d.r || 0, T.panel);
    },

    /* a picture tile: the rect includes 6 px around the picture for the ring */
    tile(cv, F, d, pressed) {
        const x = d.x + 6, y = d.y + 6, w = d.w - 12, h = d.h - 12;
        if (d.img) cv.image(d.img, x, y, 10); else cv.rrect(x, y, w, h, 10, T.panel);
        if (d.caption) {
            cv.fade(x, y + h - 40, w, 40, T.black, 0, 0.85);
            cv.text(F.f20, fit(F.f20, d.caption, w - 20), x + 10, y + h - 30, T.text);
        }
        if (d.badge) DRAW.chip(cv, F, { x: x + w - chipW(F, d.badge) + 8 - 16, y: y + 6, w: chipW(F, d.badge) - 8, text: d.badge, tone: 'live' });
        if (d.current) cv.ring(d.x, d.y, d.w, d.h, 14, 3, T.text);
        if (pressed) cv.rrect(x, y, w, h, 10, T.white, PRESS);
    },

    info(cv, F, d) {
        cv.rrect(d.x, d.y, d.w, d.h, 16, T.panel);
        const rh = d.rowH || 56;
        d.rows.forEach((r, i) => {
            const y = d.y + 4 + i * rh;
            if (i) cv.fill(d.x + 24, y, d.w - 48, 2, T.line);
            cv.text(F.f20, fit(F.f20, r[0], 220), d.x + 24, y + (rh - F.f20.lineH) / 2, T.dim);
            cv.text(F.f24, fit(F.f24, r[1], d.w - 24 - 254), d.x + 254, y + (rh - F.f24.lineH) / 2, T.text);
        });
    },

    progress(cv, F, d) {
        cv.rrect(d.x, d.y, d.w, d.h, d.h / 2, T.hi);
        const w = Math.round(d.w * Math.max(0, Math.min(1, d.value || 0)));
        if (w > 0) cv.rrect(d.x, d.y, Math.max(w, d.h), d.h, d.h / 2, T.accent);
    },

    /* a QR code: d.matrix, an array of rows of booleans (true: dark) */
    qr(cv, F, d) {
        cv.rrect(d.x, d.y, d.w, d.h, 10, T.white);
        const m = d.matrix || [];
        if (!m.length) return;
        /* d.pad: the white margin each side (the quiet zone), 14 px unless given */
        const pad = d.pad === undefined ? 14 : d.pad;
        const n = m.length, cell = Math.floor((Math.min(d.w, d.h) - 2 * pad) / n), ox = d.x + Math.floor((d.w - n * cell) / 2), oy = d.y + Math.floor((d.h - n * cell) / 2);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) cv.fill(ox + c * cell, oy + r * cell, cell, cell, T.black);
    },

    icon(cv, F, d) { icon(cv, d.icon, d.x + d.w / 2, d.y + d.h / 2, Math.min(d.w, d.h), d.colour || 'text'); },
};

/* which part of a widget x, y falls on (seg options, tabs, sheet rows), or 0 */
function part(F, d, x, y) {
    if (d.kind === 'seg') {
        const n = d.options.length, i = Math.floor((x - d.x - 4) * n / (d.w - 4));
        return Math.max(0, Math.min(n - 1, i));
    }
    if (d.kind === 'sheet') {
        const i = Math.floor((y - d.y - 6) / 66);
        return i >= 0 && i < d.options.length ? i : -1;
    }
    if (d.kind === 'tabs') {
        let x0 = d.x;
        const ws = tabWidths(F, d.tabs);
        for (let i = 0; i < ws.length; i++) { if (x >= x0 && x < x0 + ws[i]) return i; x0 += ws[i] + 4; }
        return -1;
    }
    return 0;
}

/* the topmost tappable widget at x, y: { w, part } or null */
function hit(F, widgets, x, y) {
    for (let i = widgets.length - 1; i >= 0; i--) {
        const d = widgets[i];
        if (!(d.act || d.swipe) || x < d.x || x >= d.x + d.w || y < d.y || y >= d.y + d.h) continue;
        const p = part(F, d, x, y);
        if (p < 0) continue;
        return { w: d, part: p };
    }
    return null;
}

/* ---- the renderer ---- */
/* a QR matrix's text, worked out once per matrix (tools keep one per link) */
const MATRIX_KEYS = new WeakMap();
function matrixKey(m) {
    if (!m || typeof m !== 'object') return '';
    let k = MATRIX_KEYS.get(m);
    if (k === undefined) { k = m.map((r) => r.map((c) => (c ? 1 : 0)).join('')).join('/'); MATRIX_KEYS.set(m, k); }
    return k;
}
function keyOf(d, pressed) {
    const o = {};
    Object.keys(d).forEach((k) => { if (k === 'matrix') o.matrix = matrixKey(d.matrix); else if (k !== 'img') o[k] = d[k]; });
    return JSON.stringify(o) + '|' + (pressed === undefined || pressed === null ? '' : pressed);
}
function meets(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
function union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: x, y: y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function clampRect(r, w, h) {
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    return { x: x, y: y, w: Math.min(w, Math.ceil(r.x + r.w)) - x, h: Math.min(h, Math.ceil(r.y + r.h)) - y };
}
/* overlapping rectangles merged, until none overlap */
function merge(rects) {
    let out = rects.slice(), again = true;
    while (again) {
        again = false;
        for (let i = 0; i < out.length && !again; i++) {
            for (let j = i + 1; j < out.length; j++) {
                if (meets(out[i], out[j])) { out[i] = union(out[i], out[j]); out.splice(j, 1); again = true; break; }
            }
        }
    }
    return out;
}

class Surface {
    constructor(fonts, w, h) {
        this.F = fonts;
        this.w = w || AREA.w; this.h = h || AREA.h;
        this.cv = new Canvas(this.w, this.h, T.bg);
        this.last = null;
        this.stats = { widgets: 0, redrawn: 0 };
    }

    /* draws what changed since the last render; returns the rectangles
     * changed (empty: nothing to send). pressed: { id, part } or null */
    render(widgets, pressed) {
        const pp = (d) => (pressed && pressed.id === d.id ? pressed.part : null);
        const now = new Map();
        widgets.forEach((d) => now.set(d.id, { key: keyOf(d, pp(d)), rect: { x: d.x, y: d.y, w: d.w, h: d.h } }));
        let damage = [];
        if (!this.last) damage = [{ x: 0, y: 0, w: this.w, h: this.h }];
        else {
            now.forEach((v, id) => {
                const was = this.last.get(id);
                if (!was) damage.push(v.rect);
                else if (was.key !== v.key) { damage.push(was.rect); damage.push(v.rect); }
            });
            this.last.forEach((v, id) => { if (!now.has(id)) damage.push(v.rect); });
        }
        this.last = now;
        damage = merge(damage.map((r) => clampRect(r, this.w, this.h)).filter((r) => r.w > 0 && r.h > 0));
        if (damage.reduce((a, r) => a + r.w * r.h, 0) > 0.6 * this.w * this.h) damage = [{ x: 0, y: 0, w: this.w, h: this.h }];
        let redrawn = 0;
        damage.forEach((r) => {
            this.cv.setClip(r);
            this.cv.fill(r.x, r.y, r.w, r.h, T.bg);
            widgets.forEach((d) => {
                if (!meets(r, d)) return;
                const f = DRAW[d.kind];
                if (!f) throw new Error('touch_ui: no kind ' + d.kind + ' (' + d.id + ')');
                f(this.cv, this.F, d, pp(d));
                redrawn++;
            });
        });
        this.cv.setClip(null);
        this.stats = { widgets: widgets.length, redrawn: redrawn };
        return damage;
    }

    /* everything again on the next render (a new pixmap) */
    reset() { this.last = null; }
}

/* ---- the frame ---- */

/* The whole screen for a view and the kit's own state:
 * view { title | tabs [[id, label]], tab, status { tone, text, right },
 *        body: widgets at BODY-relative x, y }
 * ui { open: a dropdown's id or null, list: true to show the List corner }
 * Returns the widgets in drawing order, at app-area x, y. */
function frame(F, view, ui) {
    const out = [];
    if (view.tabs && view.tabs.length > 1) {
        const ws = tabWidths(F, view.tabs);
        out.push({ id: '_tabs', kind: 'tabs', x: TOP.x, y: TOP.y, w: ws.reduce((a, w) => a + w, 0) + 4 * (ws.length - 1), h: TOP.h, tabs: view.tabs, value: view.tab, act: true });
    } else if (view.title) {
        out.push({ id: '_title', kind: 'text', x: TOP.x, y: TOP.y, w: CORNER.x - TOP.x - 24, h: TOP.h, font: 'f32', text: view.title });
    }
    if (ui.list !== false) out.push({ id: '_list', kind: 'button', x: CORNER.x, y: CORNER.y, w: CORNER.w, h: CORNER.h, icon: 'list', label: 'List', act: true });
    let sheet = null;
    (view.body || []).forEach((d) => {
        const w = Object.assign({}, d, { x: d.x + BODY.x, y: d.y + BODY.y });
        if (w.kind === 'dropdown') {
            w.open = ui.open === w.id;
            if (w.open) sheet = w;
        }
        out.push(w);
    });
    const st = view.status || {};
    out.push({ id: '_status', kind: 'status', x: 0, y: STATUS.y, w: AREA.w, h: STATUS.h, tone: st.tone || '', text: st.text || '', right: st.right || '' });
    if (sheet) {
        const n = sheet.options.length, h = 12 + n * 66 - 2;
        let y = sheet.y + sheet.h + 8;
        if (y + h > AREA.h - 8) y = Math.max(8, sheet.y - 8 - h);
        out.push({ id: '_sheet', kind: 'sheet', x: sheet.x, y: y, w: sheet.w, h: h, options: sheet.options, value: sheet.value, of: sheet.id, act: true });
    }
    out.push({ id: '_translationCredit', kind: 'text', x: 24, y: 566, w: 1742, h: 16, font: 'f14', align: 'right', colour: 'mute', text: require('./i18n.js').CREDIT });
    return out;
}

/* problems with a screen's widgets: tappable ones too small or outside the
 * app area, overlapping tappable ones (the tests) */
function lint(widgets) {
    const problems = [], taps = widgets.filter((d) => d.act && d.kind !== 'sheet');
    widgets.forEach((d) => {
        if (d.x < 0 || d.y < 0 || d.x + d.w > AREA.w || d.y + d.h > AREA.h) problems.push(d.id + ' is outside the app area');
        if (d.act && (d.w < MIN_TARGET || d.h < MIN_TARGET) && d.kind !== 'tabs') problems.push(d.id + ' is smaller than ' + MIN_TARGET + ' px (' + d.w + 'x' + d.h + ')');
        /* a dropdown's sheet must fit the app area whichever way it opens */
        if (d.kind === 'dropdown' && 12 + d.options.length * 66 - 2 > AREA.h - 16) problems.push(d.id + ': ' + d.options.length + ' options are too many for one sheet (at most 9)');
    });
    taps.forEach((a, i) => taps.slice(i + 1).forEach((b) => { if (meets(a, b)) problems.push(a.id + ' overlaps ' + b.id); }));
    return problems;
}

module.exports = { T, AREA, TOP, BODY, STATUS, CORNER, FONTS, GLYPHS, MIN_TARGET, loadFonts, Surface, frame, hit, lint, chipW, tabWidths, icon, merge, DRAW };
