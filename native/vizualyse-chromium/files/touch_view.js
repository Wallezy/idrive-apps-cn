// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The browser's touch screen, in the platform's touch kit (ui_kit.js): what
 * it shows for a model. Pure (no I/O): touch_screen.js feeds it the tool's
 * state and puts it on the central screen; test/touch_test.js draws it to a
 * PNG.
 *
 * Two tabs, in the kit's frame (tabs top left, List top right, the status
 * line at the bottom):
 *
 *   Browse    +- the page ----------------------------+  +- Phone page -+
 *             | its title (44)                        |  |   QR code    |
 *             | its address                           |  |   the link   |
 *             +---------------------------------------+  |   the hint   |
 *             [> Show on the screen       ] [<] [R] [H]  |              |
 *             GPU: what the probe found                  +--------------+
 *
 *   Settings  Resolution (a dropdown: the tool's scales and their sizes)
 *             Browser on / off           GPU mode (experimental)
 *                                        Game mode (experimental)
 *
 * The model (server.js, from memory): enabled, bundle ('checking' |
 * 'unpacking' | 'ready' | 'failed'), browser ('off' | 'starting' | 'running'
 * | 'crashed'), paused (who asks it off, or null), error, gpuMode, gameMode,
 * gpuNote, gpu (the last probe), scale, resolutions [{ scale, w, h }],
 * moving, kmh, link (the phone page's, or null), uplink, url, title, oomMb
 * (the memory cap, while a kill at it is recent), qr (the link's QR code: rows
 * of booleans).
 */
'use strict';

const TABS = [['browse', 'Browse'], ['settings', 'Settings']];
/* the body's places (body pixels: 1742 x 462) */
const LEFT = { w: 1318 };
const CARD = { x: 1342, w: 400, h: 462 };
const ICON = 96, GAP = 12;
const QR = 300;
const COL = 859;
const RES_NAMES = [[1, 'Full'], [0.75, '3/4'], [0.5, '1/2'], [1 / 3, '1/3'], [0.25, '1/4']];

function resName(s) { const n = RES_NAMES.filter((x) => x[0] === s)[0]; return n ? n[1] : String(s); }

/* ANGLE's renderer string, short (as the iDrive app's glName) */
function glName(s) {
    const t = String(s || 'none');
    if (/SwiftShader/i.test(t)) return 'CPU (SwiftShader)';
    const clean = (x) => x.replace(/ \(0x[0-9A-Fa-f]+\)$/, '').replace(/\((R|TM)\)/g, '').replace(/^Mesa (DRI )?/, '').replace(/\s+/g, ' ').trim();
    const gles = /^ANGLE \([^,]+, (.+?)\s*, OpenGL( ES)? ([\d.]+)/.exec(t);
    if (gles) return (gles[2] ? 'GLES ' : 'GL ') + gles[3] + ', ' + clean(gles[1]);
    const m = /^ANGLE \(([^,]+), (\S+)[^(]*\((.+)\), [^,]+\)$/.exec(t);
    return m ? m[2] + ', ' + clean(m[3]) : t;
}

/* what the probe found, one line */
function gpuLine(m) {
    const g = m.gpu;
    if (!g || (m.gpuMode && g.mode !== 'gpu')) return m.browser === 'running' ? 'checking...' : 'not probed yet';
    const soft = g.webgpuFallback && /swiftshader/i.test(g.webgpu || '');
    const compat = g.webgpuBackend === 'openGLES' ? 'GLES compat' + (g.webgpuFallback ? ' (CPU)' : '') : null;
    const webgpu = !g.webgpu || /^no |error/.test(g.webgpu) ? 'WebGPU: ' + (g.webgpu || 'none')
        : 'WebGPU: ' + (compat || (soft ? 'CPU (SwiftShader)' : g.webgpu + (g.webgpuFallback ? ' (software)' : ''))) + (g.webgpuCompute === 'ok' ? '' : ', compute ' + g.webgpuCompute);
    return webgpu + ' · WebGL 2: ' + glName(g.webgl2) + ' · JSPI: ' + (g.jspi || '?');
}

function status(m) {
    if (!m.enabled) return { tone: '', text: 'Off: turn the browser on in Settings' };
    if (m.bundle === 'unpacking' || m.bundle === 'checking') return { tone: 'warn', text: 'Installing the browser (about a minute, once)...' };
    if (m.bundle === 'failed' || m.error) return { tone: 'bad', text: 'Error: ' + (m.error || 'the browser could not be installed') };
    if (m.paused) return { tone: 'warn', text: 'Paused: ' + m.paused + '; it starts again after (or turn Game mode on)' };
    if (m.browser === 'starting' || m.browser === 'crashed') return { tone: 'warn', text: 'Starting the browser' + (m.gpuMode ? ' on the GPU' : '') + '...' };
    if (m.browser !== 'running') return { tone: '', text: 'The browser is not running' };
    if (m.oomMb) return { tone: 'warn', text: 'Out of memory: the page needed more than ' + m.oomMb + ' MB (phone page: Memory)' };
    if (m.moving) return { tone: 'warn', text: 'Only while parked: the car is moving' };
    return { tone: 'ok', text: 'Ready. Show puts the page on the screen' };
}

/* UK units: the speed in mph */
function right(m) {
    if (m.kmh === null || m.kmh === undefined) return 'Speed unknown';
    const mph = Math.round(m.kmh * 0.621371);
    return m.moving ? mph + ' mph' : 'Parked · ' + mph + ' mph';
}

function address(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }

function browse(m) {
    const run = m.enabled && m.browser === 'running', b = [];
    const title = m.title || (run ? address(m.url).split('/')[0] : '') || (run ? 'A page' : 'No page');
    b.push({ id: 'pageCard', kind: 'panel', x: 0, y: 0, w: LEFT.w, h: 160 });
    b.push({ id: 'pageLabel', kind: 'text', x: 24, y: 14, w: LEFT.w - 48, h: 30, font: 'f20', colour: 'dim', text: 'The page' });
    b.push({ id: 'pageTitle', kind: 'text', x: 24, y: 44, w: LEFT.w - 48, h: 58, font: 'f44', text: title });
    b.push({ id: 'pageUrl', kind: 'text', x: 24, y: 108, w: LEFT.w - 48, h: 34, font: 'f24', colour: 'dim',
        text: run ? address(m.url) : !m.enabled ? 'The browser is off' : 'Shown once the browser runs' });
    const showW = LEFT.w - 3 * (ICON + GAP);
    b.push({ id: 'show', kind: 'button', x: 0, y: 184, w: showW, h: ICON, act: true, on: run && !m.moving, style: 'primary', icon: 'play', label: 'Show on the screen' });
    ['back', 'reload', 'home'].forEach((ic, i) => b.push({ id: ic, kind: 'button', x: showW + GAP + i * (ICON + GAP), y: 184, w: ICON, h: ICON, act: true, on: run, icon: ic }));
    const rows = [['GPU', gpuLine(m)]];
    if (m.gpuNote) rows.push(['GPU mode', m.gpuNote]);
    const h = 8 + rows.length * 56;
    b.push({ id: 'gpu', kind: 'info', x: 0, y: 462 - h, w: LEFT.w, h: h, rows: rows });
    /* the phone page */
    b.push({ id: 'qrCard', kind: 'panel', x: CARD.x, y: 0, w: CARD.w, h: CARD.h });
    b.push({ id: 'qrLabel', kind: 'text', x: CARD.x + 24, y: 14, w: CARD.w - 48, h: 30, font: 'f20', colour: 'dim', text: 'Phone page' });
    const qx = CARD.x + (CARD.w - QR) / 2, qy = 50;
    if (m.enabled && m.link) {
        b.push({ id: 'qr', kind: 'qr', x: qx, y: qy, w: QR, h: QR, matrix: m.qr || [] });
        b.push({ id: 'qrLink', kind: 'text', x: CARD.x + 24, y: qy + QR + 14, w: CARD.w - 48, h: 30, font: 'f20', align: 'center', text: m.link.replace(/\?t=.*$/, '') });
        b.push({ id: 'qrHint', kind: 'text', x: CARD.x + 24, y: qy + QR + 50, w: CARD.w - 48, h: 30, font: 'f20', colour: 'dim', align: 'center', text: 'Scan it to type addresses and text' });
    } else {
        b.push({ id: 'qrNone', kind: 'panel', x: qx, y: qy, w: QR, h: QR, r: 10, colour: 'hi' });
        b.push({ id: 'qrLink', kind: 'text', x: CARD.x + 24, y: qy + QR + 14, w: CARD.w - 48, h: 30, font: 'f20', align: 'center',
            text: m.enabled ? "Waiting for the phone's hotspot" : 'The browser is off' });
        b.push({ id: 'qrHint', kind: 'text', x: CARD.x + 24, y: qy + QR + 50, w: CARD.w - 48, h: 30, font: 'f20', colour: 'dim', align: 'center',
            text: m.enabled ? 'the uplink is ' + (m.uplink || 'unknown') : 'turn it on in Settings' });
    }
    return b;
}

function settings(m) {
    const run = m.enabled && m.browser === 'running', b = [];
    b.push({ id: 'resolution', kind: 'dropdown', x: 0, y: 0, w: COL, h: 80, act: true, on: !!m.enabled, label: 'Resolution (the page drawn with fewer pixels, scaled up)', value: m.scale,
        options: (m.resolutions || []).map((r) => ({ v: r.scale, l: resName(r.scale) + ' · ' + r.w + ' × ' + r.h })) });
    b.push({ id: 'enabled', kind: 'toggle', x: 0, y: 96, w: COL, h: 80, act: true, value: !!m.enabled,
        label: 'Browser', sub: m.enabled ? 'on: Chromium runs' : 'off: Chromium is stopped' });
    /* on once the browser runs; off at any time (also while it restarts) */
    b.push({ id: 'gpuMode', kind: 'toggle', x: COL + 24, y: 0, w: COL, h: 80, act: true, value: !!(m.enabled && m.gpuMode), on: !!(m.enabled && (run || m.gpuMode)),
        label: 'GPU mode', sub: "experimental: WebGL on the car's GPU" });
    b.push({ id: 'game', kind: 'toggle', x: COL + 24, y: 96, w: COL, h: 80, act: true, value: !!(m.enabled && m.gameMode), on: !!(m.enabled && (run || m.gameMode || m.paused)),
        label: 'Game mode', sub: 'experimental: trusted games only' });
    return b;
}

/* the kit's view for a model: { tabs, status, body } */
function view(m, ui) {
    const st = status(m);
    return { tabs: TABS, status: { tone: st.tone, text: st.text, right: right(m) }, body: ui.tab === 'settings' ? settings(m) : browse(m) };
}

module.exports = { TABS, view, gpuLine, glName, resName };
