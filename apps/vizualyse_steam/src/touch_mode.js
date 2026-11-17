// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * An iDrive app's touch screen and its list (the touch kit's app side; the
 * tool draws the touch screen: platform tool/touch_ui). Grown from
 * vizualyse_cluster's picker handling.
 *
 * The app has two RHMI states: its page (the iDrive list, all of it usable
 * with the controller) and an empty screen state (a title and a label,
 * nothing to press: the HMI still gets every touch on the tool's picture
 * and would press whatever lies under it). The tool's picture goes up over
 * the screen state.
 *
 * - The touch screen first: entered (the tile, or a start in front), the
 *   app opens the screen state as soon as its page shows and the tool is
 *   there, then asks the tool to show (show()). Not while the car moves:
 *   the list stays.
 * - The list: the touch screen's List corner (the tool says so: list()),
 *   or the car starting to move (moving(): the tool hides its picture by
 *   itself) closes the screen state, and the page shows. BACK does the same
 *   (the HMI's). The list's first row opens the touch screen again (open()).
 * - The picture stays up only while the state it was shown on is visible and
 *   focused: BACK, HOME, another app or an HMI pop-up taking the focus (a
 *   call, a warning) hide it (hide()). When a pop-up gives the focus back
 *   to the still visible state, the picture comes back (show()).
 * - Without a screen state, or should the HMI not open it within OPEN_MS,
 *   the picture goes over the page; covered() is then true and the app
 *   disables its rows.
 *
 *   const tm = new TouchMode({ rhmi, page, screen, log,
 *       tool: { connected(), moving(), shown(), show(), hide() },
 *       visible: (v) => ...   the app is on screen or not (either state) });
 *   tm.entered(); tm.open(); tm.list(); tm.sync(); tm.covered(); tm.stop();
 */
'use strict';

const OPEN_MS = 3000;
/* the HMI moves visibility and focus one event at a time: wait this long
 * before acting on them (a pop-up takes the focus while the state stays
 * visible; leaving a state takes it just before 'visible' goes) */
const SETTLE_MS = 300;
/* how long after being entered the touch screen may still open by itself
 * (the page showing, the tool connecting) */
const AUTO_MS = 8000;

function isTrue(raw) { return raw === true || raw === 'true' || raw === 1 || raw === '1'; }

class TouchMode {
    constructor(o) {
        this.o = o;
        this.log = o.log || console;
        this.st = { page: { visible: false, focused: false }, screen: { visible: false, focused: false } };
        this.want = false;
        this.on = 'screen';
        this.auto = 0;
        this.wasMoving = false;
        this.popped = null;
        this.openTimer = null;
        this.settleTimer = null;
        if (o.page) this._watch(o.page, 'page');
        if (o.screen) this._watch(o.screen, 'screen');
    }

    /* the picture covers the page itself (no screen state): its rows are disabled */
    covered() { return this.on === 'page' && this.o.tool.shown(); }

    /* the page (the iDrive list) is in front: visible and focused */
    pageFront() { return this.st.page.visible && this.st.page.focused; }

    /* the screen state is open (the touch screen, or waiting for it) */
    screenOpen() { return this.st.screen.visible || this.want; }

    /* the app was entered: the touch screen as soon as it can */
    entered() {
        this.auto = Date.now();
        this.sync();
    }

    /* the tool's state changed (call on every status): the touch screen
     * that waits to open; the list once the car moves */
    sync() {
        const t = this.o.tool, moving = t.moving() === true;
        if (moving && !this.wasMoving && this.st.screen.visible) { this.log.info('touch: the car moves: the list'); this._close(); }
        this.wasMoving = moving;
        if (this.auto && Date.now() - this.auto > AUTO_MS) this.auto = 0;
        if (this.auto && this.st.page.visible && t.connected() && !moving) {
            this.auto = 0;
            this.log.info('touch: entered: the touch screen');
            this.open();
        }
    }

    /* the list's Touch screen row, or entered: the screen state, then the picture */
    open() {
        const rhmi = this.o.rhmi, screen = this.o.screen, t = this.o.tool;
        if (!screen) return this._show('page');
        if (this.st.screen.visible) return this._show('screen');
        if (!t.connected()) return false;
        if (t.moving() === true) return t.show();   /* the tool refuses, and says why */
        this.want = true;
        const fallback = (why) => {
            if (!this.want) return;
            this.want = false;
            this.log.warn('touch: screen state: ' + why + '; the picture goes over the page');
            this._show('page');
        };
        clearTimeout(this.openTimer);
        this.openTimer = setTimeout(() => fallback('not visible ' + OPEN_MS + ' ms after openState'), OPEN_MS);
        if (typeof rhmi.openState !== 'function') { fallback('this SDK has no openState'); return true; }
        const call = (arg) => Promise.resolve().then(() => rhmi.openState(arg));
        call(screen).catch((err) => {
            this.log.info('touch: openState(state) failed (' + (err && err.message) + '), trying its id');
            return call(screen.getId());
        }).catch((err) => fallback('openState failed: ' + (err && err.message)));
        return true;
    }

    /* the List corner (the tool hid its picture): back to the page */
    list() {
        this.auto = 0;
        this.want = false;
        clearTimeout(this.openTimer);
        this.o.tool.hide();
        if (this.st.screen.visible) this._close();
    }

    stop() {
        clearTimeout(this.openTimer);
        clearTimeout(this.settleTimer);
        this.o.tool.hide();
    }

    _show(key) {
        this.on = key;
        return this.o.tool.show();
    }

    /* the screen state closed, the page shows: closeState, or the page opened */
    _close() {
        const rhmi = this.o.rhmi, screen = this.o.screen, page = this.o.page;
        const viaPage = () => (typeof rhmi.openState === 'function' ? Promise.resolve().then(() => rhmi.openState(page)) : Promise.reject(new Error('no openState')));
        const close = typeof rhmi.closeState === 'function' ? Promise.resolve().then(() => rhmi.closeState(screen)) : Promise.reject(new Error('no closeState'));
        close.catch((err) => {
            this.log.info('touch: closeState failed (' + (err && err.message) + '), opening the page');
            return viaPage();
        }).catch((err) => this.log.warn('touch: the list did not come back (' + (err && err.message) + '): BACK shows it'));
    }

    _watch(state, key) {
        state.on('visible', (event) => {
            const v = isTrue(event && event.visible);
            this.st[key].visible = v;
            this.st[key].focused = v;
            this.log.info('touch: ' + key + ' state ' + (v ? 'visible' : 'hidden'));
            if (key === 'screen' && v && this.want) {
                this.want = false;
                clearTimeout(this.openTimer);
                this._show('screen');
            }
            if (key === 'page' && v) this.sync();
            this._settle();
        });
        state.on('focus', (event) => {
            this.st[key].focused = isTrue(event && event.focus);
            this._settle();
        });
    }

    /* after SETTLE_MS: the app is visible while either state is, and the
     * picture stays up only while the state it was shown on is visible and
     * focused (BACK from the screen state brings the page back: that hides
     * it too) */
    _settle() {
        clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            const p = this.st.page, s = this.st.screen;
            if (this.o.visible) this.o.visible(p.visible || s.visible);
            const on = this.st[this.on];
            if (!(on.visible && on.focused) && !this.want && this.o.tool.hide()) {
                this.log.info('touch: our state left or covered (a pop-up?): picture hidden');
                /* covered while still visible: a pop-up; it comes back after */
                this.popped = on.visible ? this.on : null;
            } else if (this.popped && on.visible && on.focused && this.popped === this.on) {
                this.popped = null;
                if (this.o.tool.connected() && this.o.tool.moving() !== true) { this.log.info('touch: the pop-up went: picture back'); this._show(this.on); }
            }
            if (!on.visible) this.popped = null;
        }, SETTLE_MS);
    }
}

module.exports = { TouchMode, OPEN_MS, SETTLE_MS };
