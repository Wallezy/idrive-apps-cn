// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The theme picker on the central screen: the tool's touch screen, in the
 * platform's touch kit (ui_host.js, ui_kit.js: tool/touch_ui), while the
 * iDrive app's screen state is open under it (the app asks:
 * {"cmd":"picker","on":true}). The look is picker_view.js's.
 *
 * - The previews (picker.<id>.png, picker.<id>.thumb.png, built off the car
 *   by tools/picker_build.js at the sizes they are drawn) are decoded once,
 *   the shown ones first, the rest a picture a turn after the screen shows.
 * - Its model comes from the tool's state() once a frame (from memory).
 * - The List corner: 'list' (the server tells the app, which goes back to
 *   its iDrive list).
 * - It only shows: choosing a theme, Sport or Comfort, trying one, turning
 *   themes off and covering the strip are the tool's (the actions server.js
 *   hands in).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { readPng } = require('./ui_png.js');
const { TouchScreen } = require('./ui_host.js');
const { chipW } = require('./ui_kit.js');
const view = require('./picker_view.js');

const NAME = 'vizualyse_cluster';

/* the previews, decoded once */
function loadAssets(dir) {
    const cache = {};
    const png = (n) => {
        if (!(n in cache)) { try { cache[n] = readPng(fs.readFileSync(path.join(dir, n))); } catch (e) { cache[n] = null; } }
        return cache[n];
    };
    return {
        hero: (id) => (id ? png('picker.' + id + '.png') : null),
        thumb: (id) => (id ? png('picker.' + id + '.thumb.png') : null),
        has: (n) => n in cache,
    };
}

/* the families in theme order, each with its Sport and Comfort theme ids */
function families(themes) {
    const order = [], by = {};
    themes.slice().sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0)).forEach((t) => {
        if (!by[t.family]) { by[t.family] = { family: t.family, title: null, sport: null, comfort: null }; order.push(by[t.family]); }
        const f = by[t.family];
        f[t.mode === 'comfort' ? 'comfort' : 'sport'] = t.id;
        if (!f.title || t.mode !== 'comfort') f.title = t.title;
    });
    return order;
}

class Picker extends EventEmitter {
    /* opts: dir (the kit), log, state() (the tool's side of the model:
     * themes, enabled, theme, look, mode, cover, trying, canTry, line,
     * lineWarn, right, info), actions { use(family), try(id), mode(m),
     * enable(on), cover(on) } (each returns an error string or null),
     * clientPath (mgu-render's client), touch { python, iface, src, file, cmd } */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        this.assets = loadAssets(opts.dir);
        this.sel = -1;
        this.look = null;
        this.warm = null;
        this.ui = new TouchScreen({
            name: NAME, dir: opts.dir, clientPath: opts.clientPath, log: this.log, touch: opts.touch,
            state: () => this.model(),
            view: (m, ui) => view.view(m, ui, this.assets, (t) => chipW(this.ui.F, t)),
            act: (id, value) => this.act(id, value),
        });
        this.ui.on('list', () => this.emit('list'));
        this.ui.on('change', () => this.emit('change'));
    }

    shown() { return this.ui.shown(); }

    model() {
        const s = this.o.state(), fams = families(s.themes || []);
        if (this.sel < 0 || this.sel >= fams.length) {
            /* first show: the family in use, as the cluster shows it */
            this.sel = Math.max(0, fams.map((f) => f.family).indexOf(s.theme));
            this.look = s.look || 'sport';
        }
        return { families: fams, sel: this.sel, look: this.look, enabled: s.enabled, inUse: s.theme, mode: s.mode, cover: s.cover,
            trying: s.trying, canTry: s.canTry, line: s.line, lineWarn: !!s.lineWarn, right: s.right || '', info: s.info || [] };
    }

    show() {
        const err = this.ui.show();
        if (!err) this._warm();
        return err;
    }

    hide(why) {
        clearTimeout(this.warm);
        this.warm = null;
        this.ui.hide(why);
        this.sel = -1;
    }

    refresh() { this.ui.invalidate(); }

    /* every preview decoded ahead, one a turn, so a tap never waits on one */
    _warm() {
        const ids = [];
        families((this.o.state().themes) || []).forEach((f) => [f.sport, f.comfort].forEach((id) => { if (id) ids.push(id); }));
        const next = () => {
            this.warm = null;
            if (!this.shown()) return;
            const id = ids.shift();
            if (!id) return;
            this.assets.thumb(id);
            this.assets.hero(id);
            this.warm = setTimeout(next, 20);
        };
        this.warm = setTimeout(next, 200);
    }

    /* a widget's action: a tap, or the iDrive app's */
    act(id, value) {
        const m = this.model(), n = m.families.length, f = m.families[m.sel];
        if (/^tile:/.test(id)) { this.sel = Number(id.slice(5)); return null; }
        if (id === 'hero') { if (n > 1) this.sel = value === 'prev' ? (m.sel + n - 1) % n : (m.sel + 1) % n; return null; }
        if (id === 'look') { this.look = value; return null; }
        if (id === 'use') return f ? this.o.actions.use(f.family) : null;
        if (id === 'try') return f ? this.o.actions.try(view.lookId(m, f)) : null;
        if (id === 'mode') return this.o.actions.mode(value);
        if (id === 'enabled') return this.o.actions.enable(!!value);
        if (id === 'cover') return this.o.actions.cover(!!value);
        return null;
    }
}

module.exports = { Picker, loadAssets, families };
