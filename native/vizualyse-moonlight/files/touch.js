// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Moonlight's touch screen on the central screen, in the platform's touch
 * kit (ui_host.js, ui_kit.js: tool/touch_ui), while the iDrive app's screen
 * state is open under it (the app asks: {"cmd":"touch","on":true}). The look
 * is touch_view.js's.
 *
 * - Its model comes from the tool's state() once a frame, from memory; the
 *   phone page's QR code is worked out once per link.
 * - Wanted (the app's screen state is open) is not shown: a stream on the
 *   centre console covers the app area (console_out.js's mgu-render client,
 *   or Winston), so the touch screen hides while it plays (cover()) and comes
 *   back when it ends (uncover()) if the app still wants it. Both are
 *   mgu-render clients of this name: never two at once, the touch screen
 *   comes back GAP_MS after the stream's picture went.
 * - The car moving hides it and forgets it was wanted (the app shows its
 *   list); so does the List corner ('list': the server tells the app).
 * - It only shows: stop, quit, resume, the output and on / off are the
 *   tool's (act).
 */
'use strict';
const EventEmitter = require('events');
const { TouchScreen } = require('./ui_host.js');
const { chipW } = require('./ui_kit.js');
const view = require('./touch_view.js');
const qrcode = require('./qrcode.js');

const NAME = 'vizualyse_moonlight';
const GAP_MS = 300;

/* the QR code of text: rows of booleans (true: dark), no quiet zone (the
 * kit's qr widget draws a white margin round it) */
function qrMatrix(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), m = [];
    for (let r = 0; r < n; r++) {
        const row = [];
        for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
        m.push(row);
    }
    return m;
}

class Touch extends EventEmitter {
    /* opts: dir (the kit), log, clientPath (mgu-render's client), touch
     * { python, iface, src, file, cmd }, state() (the model, from memory),
     * act(id, value) (an error string or null) */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        this.wanted = false;
        this.coveredBy = null;
        this.timer = null;
        this.qr = { text: null, m: null };
        this.ui = new TouchScreen({
            name: NAME, dir: opts.dir, clientPath: opts.clientPath, log: this.log, touch: opts.touch,
            state: () => this.model(),
            view: (m, ui) => view.view(m, ui, (t) => chipW(this.ui.F, t)),
            act: (id, value) => opts.act(id, value),
        });
        this.ui.on('list', () => { this.wanted = false; this._apply('List'); this.emit('list'); });
        this.ui.on('change', () => this.emit('change'));
    }

    shown() { return this.ui.shown(); }
    isWanted() { return this.wanted; }
    covered() { return this.coveredBy; }

    model() {
        const m = this.o.state();
        m.qr = m.link ? this._qr(m.link) : null;
        return m;
    }

    _qr(link) {
        if (this.qr.text !== link) {
            let m = null;
            try { m = qrMatrix(link); } catch (e) { this.log('touch: no QR code: ' + e.message); }
            this.qr = { text: link, m: m };
        }
        return this.qr.m;
    }

    /* the app's screen state opened (true) or closed: shown, unless a stream
     * covers the screen (then once it ends). An error string or null. */
    want(on) {
        this.wanted = !!on;
        return this._apply(on ? null : 'the app hid it');
    }

    /* the car moves: hidden, and not wanted any more (the app shows its list) */
    drop(why) {
        this.wanted = false;
        this._apply(why);
    }

    /* a stream's picture on the centre console (why) or gone (null) */
    cover(why) {
        if ((this.coveredBy || null) === (why || null)) return;
        this.coveredBy = why || null;
        if (this.coveredBy) { this._apply(this.coveredBy); return; }
        /* the stream's client closes first */
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; const err = this._apply(); if (err) this.log('touch: ' + err); }, GAP_MS);
    }

    refresh() { this.ui.invalidate(); }

    _apply(why) {
        clearTimeout(this.timer);
        this.timer = null;
        if (this.wanted && !this.coveredBy) return this.ui.show();
        if (this.ui.shown()) this.ui.hide(why);
        return null;
    }
}

module.exports = { Touch, qrMatrix, GAP_MS };
