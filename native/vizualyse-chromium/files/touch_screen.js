// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The browser's touch screen on the central screen: the tool's controls in
 * the platform's touch kit (ui_host.js, ui_kit.js: tool/touch_ui), while the
 * iDrive app's screen state is open under it (the app asks:
 * {"cmd":"ui","on":true}). The look is touch_view.js's.
 *
 * - Its model comes from the tool's state() once a frame, from memory; the
 *   phone page's QR code is made once per link.
 * - The List corner: 'list' (the server tells the app, which goes back to
 *   its iDrive list).
 * - Show on the screen, Back, Reload, Home, the resolution, the browser on /
 *   off, the GPU mode and game mode are the tool's (the actions server.js
 *   hands in). The touch screen and the browser's picture share the app's
 *   screen state, one at a time: server.js hides this before the browser
 *   goes up and shows it again after.
 */
'use strict';
const EventEmitter = require('events');
const { TouchScreen } = require('./ui_host.js');
const qrcode = require('./qrcode.js');
const view = require('./touch_view.js');

/* mgu-render's client name: not the browser picture's (screen.js), so the
 * two never share one even for the moment one goes and the other comes */
const NAME = 'vizualyse_chromium_ui';
/* white modules around the code (the kit's qr adds a margin of its own) */
const QUIET = 2;

/* text's QR code as rows of booleans (true: dark), with a quiet zone */
function qrMatrix(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), out = [];
    for (let r = -QUIET; r < n + QUIET; r++) {
        const row = [];
        for (let c = -QUIET; c < n + QUIET; c++) row.push(r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c));
        out.push(row);
    }
    return out;
}

class TouchUi extends EventEmitter {
    /* opts: dir (the kit), log, clientPath (mgu-render's client), touch
     * { python, iface, src, file, cmd }, state() (touch_view.js's model but
     * qr), actions { show(), back(), reload(), home(), scale(s), enable(on),
     * gpu(on), game(on) } (each returns an error string or null) */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        this.qr = { link: null, matrix: [] };
        this.ui = new TouchScreen({
            name: NAME, dir: opts.dir, clientPath: opts.clientPath, log: this.log, touch: opts.touch,
            state: () => this.model(),
            view: (m, ui) => view.view(m, ui),
            act: (id, value) => this.act(id, value),
        });
        this.ui.on('list', () => this.emit('list'));
        this.ui.on('change', () => this.emit('change'));
    }

    shown() { return this.ui.shown(); }
    show() { return this.ui.show(); }
    hide(why) { this.ui.hide(why); }
    refresh() { this.ui.invalidate(); }

    /* the link's code, made again only when the link changes */
    matrix(link) {
        if (link !== this.qr.link) {
            let m = [];
            try { m = link ? qrMatrix(link) : []; } catch (e) { this.log('ui: the QR code: ' + e.message); }
            this.qr = { link: link, matrix: m };
        }
        return this.qr.matrix;
    }

    model() {
        const s = this.o.state();
        return Object.assign({}, s, { qr: this.matrix(s.link || null) });
    }

    /* a widget's action: a tap */
    act(id, value) {
        const a = this.o.actions;
        if (id === 'show') return a.show();
        if (id === 'back' || id === 'reload' || id === 'home') return a[id]();
        if (id === 'resolution') return a.scale(value);
        if (id === 'enabled') return a.enable(!!value);
        if (id === 'gpuMode') return a.gpu(!!value);
        if (id === 'game') return a.game(!!value);
        return null;
    }
}

module.exports = { TouchUi, qrMatrix, NAME };
