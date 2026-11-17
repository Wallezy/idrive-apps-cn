// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Moonlight's touch screen, in the touch kit (ui_kit.js): what it shows for
 * a model. Pure (no I/O): touch.js feeds it the tool's state (server.js,
 * from memory) and puts it on the central screen; test/touch_test.js draws
 * it to a PNG.
 *
 * Two tabs, in the kit's frame (tabs top left, List top right, the status
 * line at the bottom):
 *
 *   Stream  +----------+  +---------------------------------------------+
 *           | Phone    |  | [Streaming · 0:20] [60 fps] [GPU decoding]  |
 *           | page     |  | Forza Horizon 5                             |
 *           |  (QR)    |  | from GAMING-PC (192.168.43.20) · 1 controller|
 *           |          |  | [ Stop ]   [ Quit game ]   [ Resume last ]  |
 *           | link     |  +---------------------------------------------+
 *           | hint     |  [ Picture on: Centre console v] [ Moonlight on/off ]
 *           +----------+
 *
 *   Info    host, game, pictures, controllers, the uplink, the renderer
 *
 * The model (server.js touchState()): enabled, link, uplink, qr (the link's
 * QR matrix, or null), state ('idle' | 'starting' | 'streaming' | 'ended' |
 * 'error'), host { name, address }, app { name }, fps, size, decoder,
 * seconds, pads [names], output, outputs [{ id, title, ready }], canResume,
 * last { host, app }, error, note, moving, kmh, render, via.
 */
'use strict';

/* the body's places (body pixels: 1742 x 462) */
const QR_CARD = { x: 0, y: 0, w: 400, h: 462 };
const QR_BOX = { x: 40, y: 54, w: 320, h: 320 };
const CARD = { x: 424, y: 0, w: 1318, h: 358 };
const BTN = { y: 242, w: 412, h: 92, gap: 17 };
const ROW = { y: 382, h: 80, w: 651, gap: 16 };
const TABS = [['stream', 'Stream'], ['info', 'Info']];

function gpu(decoder) { return /^msdk \(GPU/.test(decoder || ''); }
function active(m) { return m.state === 'streaming' || m.state === 'starting'; }
function what(m) {
    const game = m.app && m.app.name ? m.app.name : '', host = m.host && m.host.name ? m.host.name : '';
    return game + (game && host ? ' from ' : '') + host;
}
function clock(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
function padText(pads) {
    if (!pads || !pads.length) return 'no controllers';
    return pads.length + (pads.length === 1 ? ' controller' : ' controllers');
}
function outTitle(m, id) { const o = (m.outputs || []).filter((x) => x.id === id)[0]; return o ? o.title : id; }
/* the link as it can be read off the screen (the token is the QR's) */
function shortLink(link) { return String(link || '').replace(/\/\?t=.*$/, ''); }

/* the status line */
function line(m) {
    if (!m.enabled) return { tone: '', text: 'Moonlight is off: the phone page is closed' };
    const w = what(m);
    if (m.state === 'streaming') return { tone: 'live', text: 'Streaming ' + (w || 'a game') + ' on the ' + outTitle(m, m.output) };
    if (m.state === 'starting') return { tone: 'warn', text: 'Starting ' + (w || 'the stream') + '...' };
    if (m.state === 'error') return { tone: 'bad', text: 'Error: ' + (m.error || 'the stream failed') };
    if (m.state === 'ended') return { tone: '', text: 'Ended' + (w ? ': ' + w : '') + (m.note ? ' · ' + m.note : '') };
    if (!m.link) return { tone: 'warn', text: "Waiting for the phone's hotspot (uplink " + (m.uplink || 'unknown') + ')' };
    if (m.note) return { tone: 'ok', text: m.note };
    return { tone: 'ok', text: 'Ready: scan the QR code to pair a PC and pick a game' };
}

/* UK units: the speed in mph */
function right(m) {
    if (m.kmh === null || m.kmh === undefined) return 'Speed unknown';
    const mph = Math.round(m.kmh * 0.621371) + ' mph';
    return m.moving ? mph : 'Parked · ' + mph;
}

function qrCard(m) {
    const b = [];
    b.push({ id: 'qrCard', kind: 'panel', x: QR_CARD.x, y: QR_CARD.y, w: QR_CARD.w, h: QR_CARD.h });
    b.push({ id: 'qrLabel', kind: 'text', x: 24, y: 14, w: 352, h: 32, font: 'f20', colour: 'dim', text: 'Phone page' });
    if (m.enabled && m.link && m.qr) {
        b.push({ id: 'qr', kind: 'qr', x: QR_BOX.x, y: QR_BOX.y, w: QR_BOX.w, h: QR_BOX.h, matrix: m.qr });
        b.push({ id: 'link', kind: 'text', x: 24, y: 384, w: 352, h: 32, font: 'f24', text: shortLink(m.link) });
        b.push({ id: 'linkHint', kind: 'text', x: 24, y: 416, w: 352, h: 30, font: 'f20', colour: 'dim', text: 'Scan it: pair a PC, pick a game' });
    } else {
        b.push({ id: 'qrNone', kind: 'panel', x: QR_BOX.x, y: QR_BOX.y, w: QR_BOX.w, h: QR_BOX.h, r: 10, colour: 'hi' });
        b.push({ id: 'qrWhy', kind: 'text', x: QR_BOX.x, y: QR_BOX.y + 144, w: QR_BOX.w, h: 32, align: 'center', colour: 'dim',
            text: !m.enabled ? 'Moonlight is off' : "Waiting for the hotspot" });
        b.push({ id: 'linkHint', kind: 'text', x: 24, y: 400, w: 352, h: 30, font: 'f20', colour: 'dim',
            text: !m.enabled ? 'The Moonlight switch turns it on' : 'Uplink: ' + (m.uplink || 'unknown') });
    }
    return b;
}

function streamCard(m, chipW) {
    const b = [], on = !!m.enabled, act = active(m), x0 = CARD.x + 24;
    b.push({ id: 'card', kind: 'panel', x: CARD.x, y: CARD.y, w: CARD.w, h: CARD.h });
    /* the chips: the state, then while streaming its rate and the decoder */
    const chips = [];
    if (!on) chips.push({ text: 'Off', tone: '' });
    else if (m.state === 'streaming') chips.push({ text: 'Streaming · ' + clock(m.seconds), tone: 'live' });
    else if (m.state === 'starting') chips.push({ text: 'Starting', tone: 'warn' });
    else if (m.state === 'error') chips.push({ text: 'Error', tone: 'bad' });
    else if (m.state === 'ended') chips.push({ text: 'Ended', tone: '' });
    else chips.push({ text: 'Ready', tone: 'ok' });
    if (on && m.state === 'streaming') {
        chips.push({ text: (m.fps || 0) + ' fps', tone: '' });
        if (m.decoder) chips.push(gpu(m.decoder) ? { text: 'GPU decoding', tone: 'ok' } : { text: 'Software decoding', tone: '' });
    }
    let cx = x0;
    chips.forEach((c, i) => {
        const w = chipW(c.text);
        b.push({ id: 'chip' + i, kind: 'chip', x: cx, y: 28, w: w, h: 36, text: c.text, tone: c.tone });
        cx += w + 12;
    });
    /* the game, and where it comes from */
    const shown = m.host || m.app;
    const title = shown ? (m.app && m.app.name) || 'A game' : 'Nothing streaming';
    const sub = shown ? 'from ' + ((m.host && m.host.name) || '?') + (m.host && m.host.address ? ' (' + m.host.address + ')' : '') + ' · ' + padText(m.pads)
        : m.last ? 'Last played: ' + m.last.app + ' on ' + m.last.host + ' · ' + padText(m.pads)
            : 'Pair a PC and pick a game on the phone page · ' + padText(m.pads);
    b.push({ id: 'game', kind: 'text', x: x0, y: 90, w: CARD.w - 48, h: 58, font: 'f44', text: title });
    b.push({ id: 'from', kind: 'text', x: x0, y: 154, w: CARD.w - 48, h: 30, font: 'f20', colour: 'dim', text: sub });
    /* the buttons, enabled as the list's are */
    const canStop = on && act, canResume = on && !act && !!m.canResume;
    const btn = (id, i, label, sub, enabled, style) => {
        const d = { id: id, kind: 'button', x: x0 + i * (BTN.w + BTN.gap), y: BTN.y, w: BTN.w, h: BTN.h, act: true, on: enabled, label: label, sub: sub, style: enabled ? style : 'secondary' };
        if (!enabled) d.under = 'bg';
        b.push(d);
    };
    btn('stop', 0, 'Stop', 'the game keeps running on the PC', canStop, 'raised');
    btn('quit', 1, 'Quit game', 'closes it on the PC', canStop, 'raised');
    btn('resume', 2, 'Resume last', canResume ? m.last.app + ' on ' + m.last.host : act ? 'while nothing streams' : m.last ? 'when Moonlight is on' : 'nothing played yet',
        canResume, 'primary');
    return b;
}

function stream(m, chipW) {
    const b = qrCard(m).concat(streamCard(m, chipW));
    b.push({ id: 'out', kind: 'dropdown', x: CARD.x, y: ROW.y, w: ROW.w, h: ROW.h, act: true, on: !!m.enabled, label: 'Picture on', value: m.output,
        options: (m.outputs || []).map((o) => ({ v: o.id, l: o.title + (o.ready ? '' : ' (not connected)') })) });
    b.push({ id: 'enabled', kind: 'toggle', x: CARD.x + ROW.w + ROW.gap, y: ROW.y, w: ROW.w, h: ROW.h, act: true, value: !!m.enabled,
        label: 'Moonlight', sub: m.enabled ? 'on: the phone page is open' : 'off: the phone page is closed' });
    return b;
}

function info(m) {
    const streaming = m.state === 'streaming';
    const rows = [
        ['Host', m.host ? (m.host.name || '?') + (m.host.address ? ' · ' + m.host.address : '') : 'none yet'],
        ['Game', m.app ? m.app.name || '?' : m.last ? 'last: ' + m.last.app + ' on ' + m.last.host : 'none yet'],
        ['Pictures', streaming ? (m.fps || 0) + ' fps' + (m.size ? ' of ' + m.size : '') + (m.decoder ? ' · ' + (gpu(m.decoder) ? 'GPU' : 'software') + ' decoding' : '') +
            (m.via ? ' · through ' + m.via : '') : 'nothing streaming'],
        ['Controllers', m.pads && m.pads.length ? m.pads.length + ' · ' + m.pads.join(', ') : 'none'],
        ['Uplink', (m.uplink || 'unknown') + (m.link ? ' · ' + shortLink(m.link).replace(/^http:\/\//, '') : '')],
        ['Renderer', m.render || 'unknown'],
    ];
    return [{ id: 'info', kind: 'info', x: 0, y: 0, w: 1200, h: 8 + rows.length * 56, rows: rows }];
}

/* the kit's view for a model: { tabs, status, body } */
function view(m, ui, chipW) {
    const st = line(m);
    return { tabs: TABS, status: { tone: st.tone, text: st.text, right: right(m) }, body: ui.tab === 'info' ? info(m) : stream(m, chipW) };
}

module.exports = { TABS, QR_BOX, view, line, right };
