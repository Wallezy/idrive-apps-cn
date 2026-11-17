// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Cast's touch screen, in the touch kit (ui_kit.js): what it shows for a
 * model. Pure (no I/O): touch.js feeds it the tool's status (from memory)
 * and puts it on the central screen; test/touch_test.js draws it to a PNG.
 *
 * Three tabs, in the kit's frame (tabs top left, List top right, the status
 * line at the bottom):
 *
 *   Cast     +---------+  +-----------------------------------------------+
 *            | Phone   |  | (Playing · 0:12) Stream from the phone [Stop] |
 *            | page    |  | On the cluster map, with sound                |
 *            |  [QR]   |  +-----------------------------------------------+
 *            | link    |  Play the last stream again on
 *            | how to  |  [ Cluster map | HUD | This screen ]
 *            |         |  (Cast to cluster on/off) (QR code on the cluster)
 *            +---------+
 *
 *   CarPlay  +------------------------+  (CarPlay second screen)
 *            | live preview of the    |  (Directions card)
 *            | CarPlay map, or "Not   |  (Time and distance card)
 *            | playing"               |  (Centre the map)
 *            +------------------------+  (HUD alternate mode)
 *            [ Cluster | HUD ] [-] [+]
 *
 *   Info     the uplink, the renderer, hook111, the last stream, the speed
 *
 * The model (touch.js): the tool's status (server.js status(): enabled,
 * state, output, audio, seconds, url, source, note, error, link, canReplay,
 * outputs, qr, uplink, render, carplay {...}, moving, speed), plus qrMatrix (the
 * link's QR code, a matrix) and preview ({ img, key, at } or null).
 */
'use strict';

const TABS = [['cast', 'Cast'], ['carplay', 'CarPlay'], ['info', 'Info']];
const WHERE = { map: 'the cluster map', hud: 'the HUD', console: 'this screen', none: 'the speakers only' };
const SHORT = { map: 'Cluster map', hud: 'HUD', console: 'This screen' };
/* the body's places (body pixels: 1742 x 462) */
const QR_CARD = { x: 0, y: 0, w: 400, h: 462 };
const RIGHT = { x: 424, w: 1318 };
const PREVIEW = { x: 0, y: 0, w: 760, h: 370 };
const TOGGLES = { x: 784, w: 958 };
/* a preview picture older than this is not live any more */
const PREVIEW_STALE_MS = 2500;
const MPH = 0.621371;

function clock(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

/* the link without its token (the QR code has it) */
function shortLink(link) { return link ? String(link).replace(/\?t=.*$/, '?t=...') : ''; }
function hostOf(link) { const m = /^https?:\/\/([^:/]+)/.exec(link || ''); return m ? m[1] : null; }

/* the kit's fonts have ASCII and · × ° only */
function plain(s) {
    return String(s === undefined || s === null ? '' : s).replace(/…/g, '...').replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"').replace(/[–—]/g, '-');
}
/* every text of a screen through plain() (what the tool says comes from
 * logs and URLs) */
function plainAll(v) {
    v.status.text = plain(v.status.text);
    v.body.forEach((d) => {
        ['text', 'sub', 'label'].forEach((k) => { if (typeof d[k] === 'string') d[k] = plain(d[k]); });
        if (d.rows) d.rows = d.rows.map((r) => [plain(r[0]), plain(r[1])]);
    });
    return v;
}

function cp(m) { return m.carplay || {}; }
function sw(m) { return cp(m).switch || { installed: false, on: false, pending: null }; }
function active(m) { return m.state === 'playing' || m.state === 'paused' || m.state === 'waiting'; }
/* the CarPlay picture playing (or waiting for its stream): its output, or null */
function carplayOut(m) { return active(m) && m.source === 'carplay' ? m.output : null; }

/* the status line */
function line(m) {
    const right = m.link ? 'Hotspot · ' + hostOf(m.link) : 'No hotspot';
    if (m.enabled === false) return { tone: '', text: 'Cast to cluster is off: nothing plays', right: right };
    const where = WHERE[m.output] || m.output || '';
    if (m.state === 'playing') return { tone: 'live', text: 'Playing on ' + where + (m.audio ? ', with sound' : ''), right: right };
    if (m.state === 'paused') return { tone: 'warn', text: 'Paused on ' + where + (m.note ? ': ' + m.note : ''), right: right };
    if (m.state === 'waiting') return { tone: 'warn', text: 'Waiting for the CarPlay picture on ' + where, right: right };
    if (m.state === 'error') return { tone: 'bad', text: 'The stream failed: ' + (m.error || 'ffmpeg ended'), right: right };
    if (!m.link) return { tone: 'warn', text: "Waiting for the phone's hotspot (uplink " + (m.uplink || 'unknown') + ')', right: right };
    if (m.state === 'ended') return { tone: 'ok', text: 'Ended on ' + where + '. Scan the QR code to cast again', right: right };
    return { tone: 'ok', text: 'Ready: scan the QR code with your phone', right: right };
}

/* the stream's card: chip, title, line under it */
function card(m) {
    const where = WHERE[m.output] || 'the cluster map';
    const what = m.source === 'carplay' ? 'CarPlay map' : 'Stream from the phone';
    if (m.state === 'playing') {
        return { chip: 'Playing · ' + clock(m.seconds), tone: 'live', title: what,
            sub: 'On ' + where + (m.audio ? ', with sound through the speakers' : m.output === 'none' ? '' : ', without sound') };
    }
    if (m.state === 'paused') return { chip: 'Paused', tone: 'warn', title: what, sub: 'On ' + where + ': ' + (m.note || 'paused') };
    if (m.state === 'waiting') return { chip: 'Waiting', tone: 'warn', title: what, sub: m.note || 'waiting for the phone' };
    if (m.state === 'error') return { chip: 'Failed', tone: 'warn', title: what, sub: m.error || 'the stream failed' };
    if (m.state === 'ended') return { chip: 'Ended', tone: '', title: what, sub: 'Ended on ' + where };
    if (m.url) return { chip: 'Stopped', tone: '', title: what, sub: m.note ? 'Stopped: ' + m.note : 'Stopped' };
    return { chip: 'Nothing playing', tone: '', title: 'Nothing playing yet', sub: 'Scan the QR code, then cast a video or the CarPlay map from the phone page' };
}

function castTab(m, chipW) {
    const b = [], on = m.enabled !== false, Q = QR_CARD;
    b.push({ id: 'qrCard', kind: 'panel', x: Q.x, y: Q.y, w: Q.w, h: Q.h });
    b.push({ id: 'qrLabel', kind: 'text', x: 24, y: 14, w: 352, h: 30, font: 'f20', colour: 'dim', text: 'Phone page' });
    if (on && m.link && m.qrMatrix) {
        b.push({ id: 'qrCode', kind: 'qr', x: 50, y: 50, w: 300, h: 300, matrix: m.qrMatrix });
        b.push({ id: 'qrLink', kind: 'text', x: 24, y: 360, w: 352, h: 30, font: 'f20', text: shortLink(m.link) });
        b.push({ id: 'qrHint1', kind: 'text', x: 24, y: 394, w: 352, h: 28, font: 'f20', colour: 'dim', text: "Scan it with the phone on the car's hotspot," });
        b.push({ id: 'qrHint2', kind: 'text', x: 24, y: 422, w: 352, h: 28, font: 'f20', colour: 'dim', text: 'then cast from its page' });
    } else {
        b.push({ id: 'qrNone', kind: 'text', x: 24, y: 180, w: 352, h: 44, font: 'f32', align: 'center', text: on ? 'No link yet' : 'Cast is off' });
        b.push({ id: 'qrHint1', kind: 'text', x: 24, y: 232, w: 352, h: 28, font: 'f20', colour: 'dim', align: 'center',
            text: on ? "Waiting for the phone's hotspot" : 'Turn Cast to cluster on' });
    }

    const R = RIGHT, c = card(m);
    b.push({ id: 'card', kind: 'panel', x: R.x, y: 0, w: R.w, h: 160 });
    b.push({ id: 'chip', kind: 'chip', x: R.x + 28, y: 20, w: chipW(c.chip), h: 36, text: c.chip, tone: c.tone });
    b.push({ id: 'what', kind: 'text', x: R.x + 28, y: 62, w: R.w - 28 - 248, h: 54, font: 'f44', text: c.title });
    b.push({ id: 'whatSub', kind: 'text', x: R.x + 28, y: 116, w: R.w - 28 - 248, h: 30, font: 'f20', colour: 'dim', text: c.sub });
    b.push({ id: 'stop', kind: 'button', x: R.x + R.w - 24 - 200, y: 40, w: 200, h: 80, icon: 'stop', label: 'Stop', style: 'raised', act: true, on: on && active(m) });

    b.push({ id: 'replayLabel', kind: 'text', x: R.x, y: 172, w: R.w, h: 34, font: 'f20', colour: 'dim', text: 'Play the last stream again on' });
    const outs = (m.outputs || []).map((o) => o.id).filter((k) => SHORT[k]);
    b.push({ id: 'replay', kind: 'seg', x: R.x, y: 210, w: R.w, h: 80, act: true, on: on && !!m.canReplay,
        options: outs.map((k) => ({ v: k, l: SHORT[k] })), value: m.state === 'playing' || m.state === 'paused' ? m.output : null });

    const half = (R.w - 24) / 2;
    b.push({ id: 'enabled', kind: 'toggle', x: R.x, y: 382, w: half, h: 80, act: true, value: on,
        label: 'Cast to cluster', sub: on ? 'on: the phone page is open' : 'off: nothing plays, the page is closed' });
    b.push({ id: 'qr', kind: 'toggle', x: R.x + half + 24, y: 382, w: half, h: 80, act: true, on: on, value: !!m.qr,
        label: 'QR code on the cluster', sub: 'while nothing plays there' });
    return b;
}

function carplayTab(m, chipW, now) {
    const b = [], on = m.enabled !== false, c = cp(m), s = sw(m), P = PREVIEW, out = carplayOut(m);
    const pv = m.preview, live = !!(out && pv && pv.img && now - pv.at < PREVIEW_STALE_MS);
    if (live) {
        b.push({ id: 'preview', kind: 'image', x: P.x, y: P.y, w: P.w, h: P.h, r: 14, img: pv.img, imgKey: pv.key });
        const t = 'Live preview · ' + (out === 'hud' ? 'HUD' : 'cluster map');
        b.push({ id: 'previewChip', kind: 'chip', x: P.x + 16, y: P.y + 16, w: chipW(t), h: 36, text: t, tone: 'live' });
    } else {
        b.push({ id: 'preview', kind: 'panel', x: P.x, y: P.y, w: P.w, h: P.h, r: 14 });
        const why = !on ? 'Turn Cast to cluster on to play it'
            : out ? 'Waiting for the phone\'s picture'
                : !s.installed ? 'Needs hook111 (CarPlay cluster map, in the Store)'
                    : !c.ready ? (c.why ? 'Not ready: ' + c.why : 'Not ready')
                        : 'Play the map on the cluster or the HUD to see it here';
        b.push({ id: 'previewNone', kind: 'text', x: P.x + 24, y: 136, w: P.w - 48, h: 52, font: 'f44', align: 'center', text: 'Not playing' });
        b.push({ id: 'previewWhy', kind: 'text', x: P.x + 24, y: 196, w: P.w - 48, h: 30, font: 'f20', colour: 'dim', align: 'center', text: why });
    }
    b.push({ id: 'cpOut', kind: 'seg', x: 0, y: 382, w: P.w - 2 * 92, h: 80, act: true, on: on && !!c.ready,
        options: [{ v: 'map', l: 'Map on Cluster' }, { v: 'hud', l: 'Map on HUD' }], value: out });
    const zoom = on && !!out;
    b.push({ id: 'zoomOut', kind: 'button', x: P.w - 172, y: 382, w: 80, h: 80, icon: 'minus', act: true, on: zoom });
    b.push({ id: 'zoomIn', kind: 'button', x: P.w - 80, y: 382, w: 80, h: 80, icon: 'plus', act: true, on: zoom });

    const T = TOGGLES, has = !!s.installed, cards = c.cards || {}, centre = c.centre || { on: true };
    const rows = [
        ['cp2', 'CarPlay second screen', !!s.on, !has ? 'needs hook111 (in the Store)' : (s.on ? 'on' : 'off') + (s.pending ? ': ' + s.pending : s.on ? ': the phone draws the cluster map' : '')],
        ['dir', 'Directions card', !!cards.directions, 'on the cluster, at once'],
        ['eta', 'Time and distance card', !!cards.eta, 'arrival time, time and miles left'],
        ['centre', 'Centre the map', !!centre.on, centre.on ? 'the car between the two cards' + (centre.pending ? ' (' + centre.pending + ')' : '') : "Maps' own layout"],
        ['hudalt', 'HUD alternate mode', !!c.hudAlt, c.hudAlt ? 'the wide picture fills the HUD' : "the cluster's picture, fitted"],
    ];
    rows.forEach((r, i) => b.push({ id: r[0], kind: 'toggle', x: T.x, y: i * 92, w: T.w, h: 80, act: true, on: has, value: r[2], label: r[1], sub: r[3] }));
    return b;
}

function infoTab(m) {
    const c = cp(m), s = sw(m);
    const hook = !s.installed ? 'not installed' : c.streaming ? 'streaming · ' + (c.size || c.display || 'the phone\'s size') + ' · ' + (c.frames || 0) + ' frames'
        : c.ready ? 'armed · the second screen is ready' : c.why || 'not ready';
    const speed = m.speed === null || m.speed === undefined ? 'unknown' : Math.round(m.speed * MPH) + ' mph' + (m.moving ? ' (moving)' : '');
    const rows = [
        ['Uplink', (m.uplink || 'unknown') + (m.link ? ' · ' + hostOf(m.link) : '')],
        ['Phone page', m.link ? shortLink(m.link) : 'no link yet'],
        ['Cluster renderer', m.render || 'unknown'],
        ['CarPlay (hook111)', hook],
        ['Last stream', m.url ? m.url + (m.output ? ' · ' + (WHERE[m.output] || m.output) : '') : 'none yet'],
        ['Speed', speed],
    ];
    return [{ id: 'info', kind: 'info', x: 0, y: 0, w: 1300, h: 8 + rows.length * 56, rows: rows }];
}

/* the kit's view for a model: { tabs, status, body }. now: Date.now() (the preview's age) */
function view(m, ui, chipW, now) {
    const tab = ui.tab || 'cast';
    return plainAll({
        tabs: TABS,
        status: line(m),
        body: tab === 'carplay' ? carplayTab(m, chipW, now || Date.now()) : tab === 'info' ? infoTab(m) : castTab(m, chipW),
    });
}

module.exports = { TABS, PREVIEW, PREVIEW_STALE_MS, view, line, card, shortLink, carplayOut, plain };
