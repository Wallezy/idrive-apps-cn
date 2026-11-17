// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Steam's touch screen, in the touch kit (ui_kit.js): what it shows for a
 * model. Pure (no I/O): touch_screen.js feeds it the tool's state and puts
 * it on the central screen; test/touch_test.js draws it to a PNG.
 *
 * Two tabs, in the kit's frame (tabs top left, List top right, the status
 * line at the bottom):
 *
 *   Library   +------------------------------------------------------------+
 *             | (Running · 28 pictures/s)   [> Show on the screen] [# Stop] |
 *             | Slay the Spire 2                                           |
 *             | hidden: it keeps running until Stop                        |
 *             +------------------------------------------------------------+
 *             Library · page 1 of 2         Downloading Celeste · 42 %  [====    ]
 *             [<] [plate] [plate] [plate] [plate] [>]   four games a page, never scrolling
 *
 *   Settings  [Shape: 16:9 | the screen's]  [Picture size v]     +-----------+
 *             Upscaling [Off | FSR | FSR, no sharpening]        | Phone page|
 *                                                               |   (QR)    |
 *             [Steam                                  (on) ]    |  link     |
 *                                                               +-----------+
 *
 * The model (touch_screen.js): enabled, ready (the bundles), line { tone,
 * text } (the status line), right, game (null, or { appId, name, state
 * 'starting' | 'running' | 'ended', fps, gpuBuffers, note, shown }),
 * running, moving, library [{ appId, name, playable, why }], page,
 * download (null, or { text, percent: 0..100 while downloading }),
 * resolution, upscale, resolutions [{ id, short, shape }], link, qr (the
 * link's modules, or null).
 *
 * Game tiles are plain colour plates (no cover art: the tool would have to
 * download and convert pictures while Steam installs games).
 */
'use strict';

const TABS = [['library', 'Library'], ['settings', 'Settings']];
/* the body's places (body pixels: 1742 x 462) */
const W = 1742;
const CARD = { x: 0, y: 0, w: W, h: 150 };
const SHOW = { w: 380, h: 88 };
const STOP = { w: 280, h: 88 };
const LINE = { y: 166, h: 40 };
const ROW = { y: 222, h: 240 };
const PAGE = { w: 88 };
const PER_PAGE = 4;
const GAP = 16;
const TILE_W = Math.floor((W - 2 * (PAGE.w + GAP) - (PER_PAGE - 1) * GAP) / PER_PAGE);
const QR = { x: 1314, w: 428 };
/* the plates' colours, dark enough for white names; a game's is fixed by its app id */
const PLATES = [0x45215f, 0x5a2219, 0x174866, 0x5a420f, 0x1f5038, 0x175050, 0x501b3e, 0x2c3850];
const UPSCALES = [{ v: 'off', l: 'Off', s: 'bilinear' }, { v: 'fsr', l: 'FSR', s: 'sharpened' }, { v: 'fsr-soft', l: 'FSR', s: 'no sharpening' }];
const SHAPES = [{ v: '16:9', l: '16:9', s: 'bars at the sides' }, { v: 'screen', l: "The screen's shape", s: 'fills the screen' }];

function plate(appId) {
    let h = 0;
    String(appId).split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    return PLATES[h % PLATES.length];
}
function pages(m) { return Math.max(1, Math.ceil((m.library || []).length / PER_PAGE)); }
function pageOf(m) { return Math.max(0, Math.min(pages(m) - 1, m.page || 0)); }

/* the running (or last) game's card */
function card(m, chipW) {
    const b = [], g = m.game;
    const live = !!(g && g.state === 'running'), starting = !!(g && g.state === 'starting');
    b.push({ id: 'card', kind: 'panel', x: CARD.x, y: CARD.y, w: CARD.w, h: CARD.h });
    const chip = live ? { text: 'Running · ' + (g.fps || 0) + ' pictures/s' + (g.gpuBuffers === false ? ' · no GPU buffers' : ''), tone: 'live' }
        : starting ? { text: 'Starting', tone: 'warn' }
            : g ? { text: 'Ended', tone: '' } : { text: 'Nothing running', tone: '' };
    b.push({ id: 'chip', kind: 'chip', x: 24, y: 18, w: chipW(chip.text), h: 36, text: chip.text, tone: chip.tone });
    const btnX = CARD.w - 24 - STOP.w - GAP - SHOW.w, textW = btnX - 24 - 24;
    b.push({ id: 'title', kind: 'text', x: 24, y: 56, w: textW, h: 58, font: 'f44', text: g ? g.name : 'No game running' });
    const sub = live ? (g.shown ? 'On the screen' : 'Hidden: it keeps running until you stop it')
        : starting ? 'Wine, then the game: this can take a minute'
            : g ? (g.note ? 'Ended: ' + g.note : 'Ended') : 'Play one from the library below';
    b.push({ id: 'sub', kind: 'text', x: 24, y: 112, w: textW, h: 30, font: 'f20', colour: 'dim', text: sub });
    const y = Math.round((CARD.h - SHOW.h) / 2);
    b.push({ id: 'show', kind: 'button', x: btnX, y: y, w: SHOW.w, h: SHOW.h, act: true, on: live && !m.moving && !g.shown,
        style: 'primary', icon: 'play', label: 'Show on the screen' });
    b.push({ id: 'stop', kind: 'button', x: CARD.w - 24 - STOP.w, y: y, w: STOP.w, h: STOP.h, act: true, on: !!m.running,
        style: 'raised', icon: 'stop', label: 'Stop the game' });
    return b;
}

function library(m, chipW) {
    const b = card(m, chipW), n = pages(m), p = pageOf(m), games = m.library || [];
    b.push({ id: 'pageLabel', kind: 'text', x: 0, y: LINE.y, w: 560, h: LINE.h, font: 'f20', colour: 'dim',
        text: games.length ? 'Library · page ' + (p + 1) + ' of ' + n : 'Library' });
    const d = m.download;
    if (d && d.text) {
        const bar = d.percent !== null && d.percent !== undefined;
        const barW = bar ? 480 : 0, tx = 600, tw = W - tx - (bar ? barW + 24 : 0);
        b.push({ id: 'download', kind: 'text', x: tx, y: LINE.y, w: tw, h: LINE.h, font: 'f20', align: bar ? 'right' : 'left', text: d.text });
        if (bar) b.push({ id: 'progress', kind: 'progress', x: W - barW, y: LINE.y + 14, w: barW, h: 12, value: d.percent / 100 });
    }
    if (!games.length) {
        b.push({ id: 'empty', kind: 'panel', x: 0, y: ROW.y, w: W, h: ROW.h });
        b.push({ id: 'emptyText', kind: 'text', x: 40, y: ROW.y + 70, w: W - 80, h: 58, font: 'f32',
            text: m.enabled ? (m.ready ? 'No games yet' : 'Steam is installing itself on the car') : 'Steam is off' });
        b.push({ id: 'emptySub', kind: 'text', x: 40, y: ROW.y + 130, w: W - 80, h: 36, font: 'f24', colour: 'dim',
            text: m.enabled ? 'Scan the QR code in Settings with your phone: sign in to Steam and install a game there' : 'Turn it on in Settings' });
        return b;
    }
    b.push({ id: 'prev', kind: 'button', x: 0, y: ROW.y, w: PAGE.w, h: ROW.h, act: true, on: p > 0, icon: 'back' });
    b.push({ id: 'next', kind: 'button', x: W - PAGE.w, y: ROW.y, w: PAGE.w, h: ROW.h, act: true, on: p < n - 1, icon: 'fwd' });
    games.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE).forEach((g, i) => {
        const x = PAGE.w + GAP + i * (TILE_W + GAP);
        const playing = !!(m.game && m.game.state !== 'ended' && m.game.appId === g.appId);
        const can = g.playable && !m.running && !m.moving && m.enabled;
        b.push({ id: 'play:' + g.appId, kind: 'button', x: x, y: ROW.y, w: TILE_W, h: ROW.h, act: true, on: can, style: 'quiet', r: 14,
            under: g.playable || playing ? plate(g.appId) : 'panel', label: '' });
        b.push({ id: 'name:' + g.appId, kind: 'text', x: x + 24, y: ROW.y + ROW.h - 112, w: TILE_W - 48, h: 44, font: 'f32',
            colour: g.playable || playing ? 'text' : 'dim', text: g.name });
        const sub = playing ? 'Running now' : g.why ? g.why : m.running ? 'Play (once the game stops)' : 'Play';
        b.push({ id: 'what:' + g.appId, kind: 'text', x: x + 24, y: ROW.y + ROW.h - 62, w: TILE_W - 48, h: 32, font: 'f20',
            colour: playing ? 'ok' : can ? 'accentInk' : 'dim', text: sub });
    });
    return b;
}

/* a resolution's shape: 16:9, or the screen's (2.8:1) */
function shapeOf(m, id) { const r = (m.resolutions || []).filter((x) => x.id === id)[0]; return r ? r.shape : '16:9'; }

function settings(m) {
    const b = [], shape = shapeOf(m, m.resolution), off = !m.enabled;
    const sizes = (m.resolutions || []).filter((r) => r.shape === shape).map((r) => ({ v: r.id, l: r.short }));
    b.push({ id: 'shapeLabel', kind: 'text', x: 0, y: 0, w: 600, h: 30, font: 'f20', colour: 'dim',
        text: 'The picture the game draws' + (m.running ? ' (from the next game)' : '') });
    b.push({ id: 'shape', kind: 'seg', x: 0, y: 36, w: 600, h: 80, act: true, on: !off, value: shape, options: SHAPES });
    b.push({ id: 'res', kind: 'dropdown', x: 624, y: 36, w: 666, h: 80, act: true, on: !off, label: 'Picture size', value: m.resolution, options: sizes });
    b.push({ id: 'upLabel', kind: 'text', x: 0, y: 140, w: 1290, h: 30, font: 'f20', colour: 'dim', text: 'Upscaling (a smaller picture enlarged to the screen; at once)' });
    b.push({ id: 'upscale', kind: 'seg', x: 0, y: 176, w: 1290, h: 80, act: true, on: !off, value: m.upscale, options: UPSCALES });
    b.push({ id: 'enabled', kind: 'toggle', x: 0, y: 382, w: 1290, h: 80, act: true, value: !!m.enabled,
        label: 'Steam', sub: m.enabled ? 'on: games and downloads run, the phone page is open' : 'off: no game, no download, no phone page' });
    b.push({ id: 'qrCard', kind: 'panel', x: QR.x, y: 0, w: QR.w, h: 462 });
    b.push({ id: 'qrLabel', kind: 'text', x: QR.x + 24, y: 12, w: QR.w - 48, h: 30, font: 'f20', colour: 'dim', text: 'Phone page' });
    if (m.qr && m.link) {
        b.push({ id: 'qr', kind: 'qr', x: QR.x + (QR.w - 300) / 2, y: 48, w: 300, h: 300, matrix: m.qr });
        b.push({ id: 'link', kind: 'text', x: QR.x + 16, y: 356, w: QR.w - 32, h: 30, font: 'f20', align: 'center', text: m.link.replace(/^http:\/\//, '') });
        b.push({ id: 'qrHint', kind: 'text', x: QR.x + 16, y: 392, w: QR.w - 32, h: 30, font: 'f20', colour: 'dim', align: 'center', text: 'Scan it: sign in, install games' });
        b.push({ id: 'qrHint2', kind: 'text', x: QR.x + 16, y: 420, w: QR.w - 32, h: 30, font: 'f20', colour: 'dim', align: 'center', text: "from the phone whose hotspot the car is on" });
    } else {
        b.push({ id: 'noLink', kind: 'text', x: QR.x + 24, y: 160, w: QR.w - 48, h: 42, font: 'f24', align: 'center', text: m.enabled ? 'No phone connected' : 'Steam is off' });
        b.push({ id: 'noLink2', kind: 'text', x: QR.x + 24, y: 206, w: QR.w - 48, h: 30, font: 'f20', colour: 'dim', align: 'center',
            text: m.enabled ? "Turn on the phone's hotspot" : 'Turn it on to open the page' });
    }
    return b;
}

/* the kit's view for a model: { tabs, status, body }; chipW(text) the kit's chip width */
function view(m, ui, chipW) {
    const line = m.line || {};
    return {
        tabs: TABS,
        status: { tone: line.tone || '', text: line.text || '', right: m.right || '' },
        body: ui.tab === 'settings' ? settings(m) : library(m, chipW),
    };
}

module.exports = { TABS, PER_PAGE, TILE_W, ROW, view, pages, plate, shapeOf };
