// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Cast's touch screen on the central screen, in the platform's touch kit
 * (ui_host.js, ui_kit.js: tool/touch_ui), while the iDrive app's screen
 * state is open under it (the app asks: {"cmd":"touch","on":true}). The
 * look is touch_view.js's.
 *
 * - Its model is the tool's last status (server.js keeps it, refreshed once
 *   a second and after every action), so a frame never reads a file.
 * - The QR code of the phone page's link: made once per link.
 * - The CarPlay tab's live preview: the CarPlay ffmpeg's second output
 *   (carplay_screen.previewArgs: RGBA pictures on fd 4, a few a second),
 *   handed in by server.js (previewStart, previewData, previewEnd). Kept
 *   only while the touch screen shows with the CarPlay tab open, into two
 *   buffers made once (one filling, one drawn); otherwise only counted, so
 *   the pictures stay aligned.
 * - The List corner: 'list' (server.js tells the app, which goes back to its
 *   iDrive list).
 * - It only shows: every action is the tool's command (server.js), the same
 *   as the iDrive list's.
 */
'use strict';
const EventEmitter = require('events');
const qrcode = require('./qrcode.js');
const { TouchScreen } = require('./ui_host.js');
const { chipW } = require('./ui_kit.js');
const view = require('./touch_view.js');

const NAME = 'vizualyse_cast';
/* blank modules each side of the code, inside the kit's white box */
const QUIET = 2;

/* the QR code of text as rows of booleans (true: dark), with a quiet zone */
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

class CastTouch extends EventEmitter {
    /* opts: dir (the kit), log, clientPath (mgu-render's client), touch
     * { python, iface, src, file, cmd }, state() (the tool's last status,
     * from memory), command(c) (a command as the app sends it: error or null) */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        this.qr = { link: null, matrix: null };
        /* bufs: the two pictures (made the first time one is kept), fill
         * the one filling, shown the one drawn (-1: none) */
        this.pv = { size: view.PREVIEW.w * view.PREVIEW.h * 4, pos: 0, keep: false, bufs: null, fill: 0, shown: -1, n: 0, at: 0 };
        this.ui = new TouchScreen({
            name: NAME, dir: opts.dir, clientPath: opts.clientPath, log: this.log, touch: opts.touch,
            state: () => this.model(),
            view: (m, ui) => view.view(m, ui, (t) => chipW(this.ui.F, t)),
            act: (id, value) => this.act(id, value),
        });
        this.ui.on('list', () => this.emit('list'));
        this.ui.on('change', () => this.emit('change'));
    }

    shown() { return this.ui.shown(); }
    show() { return this.ui.show(); }
    hide(why) { this.ui.hide(why); this.pv.keep = false; }
    refresh() { this.ui.invalidate(); }

    model() {
        const s = this.o.state() || {};
        if (s.link !== this.qr.link) {
            this.qr.link = s.link || null;
            try { this.qr.matrix = s.link ? qrMatrix(s.link) : null; } catch (e) { this.qr.matrix = null; this.log('touch: qr: ' + e.message); }
        }
        const p = this.pv;
        return Object.assign({}, s, { qrMatrix: this.qr.matrix,
            preview: p.shown >= 0 ? { img: p.bufs[p.shown], key: 'pv' + p.n, at: p.at } : null });
    }

    /* ---- the CarPlay preview ---- */
    /* the preview is drawn: the touch screen up on the CarPlay tab */
    wantsPreview() { return this.ui.shown() && this.ui.ui.tab === 'carplay'; }

    /* a new CarPlay ffmpeg: its pictures start at a picture's start */
    previewStart() { this.pv.pos = 0; this.pv.keep = false; }

    /* bytes from ffmpeg's fd 4 */
    previewData(d) {
        const p = this.pv;
        let i = 0;
        while (i < d.length) {
            const n = Math.min(d.length - i, p.size - p.pos);
            if (p.keep) d.copy(p.bufs[p.fill].rgba, p.pos, i, i + n);
            p.pos += n;
            i += n;
            if (p.pos < p.size) continue;
            p.pos = 0;
            if (p.keep) {
                p.shown = p.fill;
                p.fill = 1 - p.fill;
                p.n++;
                p.at = Date.now();
                this.ui.invalidate();
            }
            /* the next picture kept only if it will be drawn */
            p.keep = this.wantsPreview();
            if (p.keep && !p.bufs) {
                const pic = () => ({ w: view.PREVIEW.w, h: view.PREVIEW.h, rgba: Buffer.alloc(p.size), opaque: true });
                p.bufs = [pic(), pic()];
            }
        }
    }

    /* the CarPlay ffmpeg ended: no picture */
    previewEnd() {
        const p = this.pv;
        p.pos = 0; p.keep = false;
        if (p.shown >= 0) { p.shown = -1; this.ui.invalidate(); }
    }

    /* ---- a widget's action: the tool's command ---- */
    act(id, value) {
        const c = this.o.command;
        switch (id) {
        case 'stop': return c({ cmd: 'stop' });
        case 'replay': return c({ cmd: 'replay', output: value });
        case 'enabled': return c({ cmd: value ? 'enable' : 'disable' });
        case 'qr': return c({ cmd: 'qr', show: !!value });
        case 'cpOut': return c({ cmd: 'carplay', output: value });
        case 'zoomIn': return c({ cmd: 'carplayZoom', dir: 'in' });
        case 'zoomOut': return c({ cmd: 'carplayZoom', dir: 'out' });
        case 'cp2': return c({ cmd: 'hook111', mode: value ? 'alt' : 'off' });
        case 'dir': return c({ cmd: 'carplayCards', directions: !!value });
        case 'eta': return c({ cmd: 'carplayCards', eta: !!value });
        case 'centre': return c({ cmd: 'carplayCentre', on: !!value });
        case 'hudalt': return c({ cmd: 'carplayHudAlt', on: !!value });
        default: return null;
        }
    }
}

module.exports = { CastTouch, qrMatrix, NAME };
