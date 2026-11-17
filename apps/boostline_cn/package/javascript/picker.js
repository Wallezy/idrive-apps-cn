'use strict';
/**
 * Which of the car's channels Boostline streams, and so what a capture logs.
 *
 *   defaultIds(entries, offered)   the pages' channels on this car: an entry is an id, or a list of
 *                                  alternatives of which the first the car offers counts (the DME's
 *                                  value, else the standard OBD-II one)
 *   loggedIds(wanted, offered)     what Session actually streams: the dyno's and drag timer's channels
 *                                  first, then the wanted ones the car offers, at most MAX of them
 *   channelSheet(opts)             the picker: a sheet (kit/sheet.js) the kit draws over the page,
 *                                  driven by touch and the iDrive controller. The car's channel
 *                                  groups, then a group's channels to tick; Defaults puts the pages'
 *                                  set back. What changed is handed over when the sheet closes.
 *   tileSheet(opts)                Setup page: the same groups, to choose the tiles of one page
 *                                  (at most opts.max, in the order ticked); Defaults puts the page's
 *                                  own tiles back
 *   choiceSheet(opts)              one value from a list (the drag timer's run)
 *   fileSheet(opts)                the Files page's browser: folders, their files, a file's View /
 *                                  Delete, a folder's Delete all (deleting takes a second press)
 *   channelGroups(all, order)      the groups both list: the DME's long list of its own values cut
 *                                  into alphabetical parts ("Other DDE values: A-C")
 *
 * Runs on the head unit's Node 8: plain ES2017.
 */
const { list, pill, TOP } = require('./kit/sheet');

/** Session streams these whatever is chosen (the dyno and the drag timer need them). */
const REQUIRED = ['engine.rpm', 'vehicle.speed', 'throttle.pedal', 'vehicle.gear'];
const W = 1600;
/** Group names that need saying what they are. */
/** The engine ECU's name (DDE, DME, DDE/DME): the app sets it (picker.ECU.name = ...). */
const ECU = { name: () => 'DDE/DME' };
const groupLabel = (g) => (g === 'DME' ? 'Other ' + ECU.name() + ' values (BMW data)' : g === 'Custom' ? 'Your definition files' : g);

/** The DME's own values (hundreds, thousands on a diesel) are listed in alphabetical parts of about this many. */
const PART = 120;

const byName = (a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);

/**
 * [{ key, group, label, defs }] of the groups the car has channels in, in Boostline's order. The DME's
 * own values are sorted by name and, when there are many, cut into parts at a change of first letter:
 * "Other DDE values: A-C (118)".
 */
function channelGroups(all, order) {
    const by = new Map();
    all.forEach((def) => {
        const g = def.group || 'Custom';
        if (!by.has(g)) by.set(g, []);
        by.get(g).push(def);
    });
    const groups = order.filter((g) => by.has(g)).concat(Array.from(by.keys()).filter((g) => order.indexOf(g) < 0));
    const out = [];
    groups.forEach((g) => {
        const defs = by.get(g);
        if (g !== 'DME') { out.push({ key: g, group: g, label: groupLabel(g), defs }); return; }
        defs.sort(byName);
        if (defs.length <= PART * 1.5) { out.push({ key: g, group: g, label: groupLabel(g), defs }); return; }
        const first = (d) => { const c = d.name.charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
        let part = [];
        const flush = () => {
            if (!part.length) return;
            const a = first(part[0]), b = first(part[part.length - 1]);
            out.push({ key: 'DME:' + a + b + out.length, group: g, label: 'Other ' + ECU.name() + ' values: ' + (a === b ? a : a + '-' + b) + ' (' + part.length + ')', defs: part });
            part = [];
        };
        defs.forEach((d, i) => {
            // a new part where the first letter changes, once this one is big enough
            if (part.length >= PART && first(d) !== first(defs[i - 1])) flush();
            // a single letter with very many values: cut it too
            if (part.length >= PART * 2) flush();
            part.push(d);
        });
        flush();
    });
    return out;
}

/**
 * The groups as the sheets list them, worked out once per channel list (the DDE's thousands of values
 * sorted and cut into parts at every frame made the sheets slow): { main, adv } - the named groups,
 * and the DDE's own values (the "Advanced PIDs" submenu, in alphabetical parts).
 */
function menuOf(all, order) {
    if (menuOf.cache && menuOf.cache.all === all && menuOf.cache.size === all.size && menuOf.cache.order === order) return menuOf.cache.menu;
    const groups = channelGroups(all, order);
    const menu = { main: groups.filter((g) => g.group !== 'DME'), adv: groups.filter((g) => g.group === 'DME') };
    menu.advCount = menu.adv.reduce((n, g) => n + g.defs.length, 0);
    menuOf.cache = { all, size: all.size, order, menu };
    return menu;
}
/** The "Advanced PIDs" entry: opening it lists the DDE's own values in parts. */
const advGroup = (menu) => ({ key: 'adv', label: 'Advanced PIDs: the ' + ECU.name() + '\'s own values', parts: menu.adv });
const countOn = (defs, isOn) => defs.reduce((n, d) => n + (isOn(d.id) ? 1 : 0), 0);

const has = (offered, id) => (offered && typeof offered.has === 'function' ? offered.has(id) : false);

function defaultIds(entries, offered) {
    const out = [];
    entries.forEach((e) => {
        const alts = Array.isArray(e) ? e : [e];
        const id = alts.find((a) => has(offered, a)) || alts[0];
        if (out.indexOf(id) < 0) out.push(id);
    });
    return out;
}

/** As Session's resolveIds: the required ones, then the wanted, those offered, the first max. */
function loggedIds(wanted, offered, max) {
    const out = [];
    REQUIRED.concat(wanted).forEach((id) => { if (has(offered, id) && out.indexOf(id) < 0) out.push(id); });
    return out.slice(0, max);
}

/**
 * opts: {
 *   channels()      the car's channels: Map id -> ChannelDef (registry order)
 *   groups          group order (Boostline's GROUP_ORDER)
 *   wanted          the ids streamed now (a custom list keeps ids this car doesn't offer)
 *   isDefault       wanted is the pages' set (not the user's own)
 *   defaults()      the pages' set on this car
 *   max             the most Session streams
 *   unit(def)       the unit shown beside a channel (display units)
 *   done({ ids, isDefault })   on close, when the choice changed
 * }
 */
function channelSheet(opts) {
    const chosen = new Set(opts.wanted);
    let isDefault = !!opts.isDefault, changed = false;
    let note = '', noteUntil = 0;
    const say = (s) => { note = s; noteUntil = Date.now() + 4000; };
    const all = () => opts.channels();
    const logged = () => loggedIds(Array.from(chosen), all(), Infinity);

    const menu = () => menuOf(all(), opts.groups);
    const isOn = (id) => REQUIRED.indexOf(id) >= 0 || chosen.has(id);

    function toggle(def) {
        if (REQUIRED.indexOf(def.id) >= 0) { say('Always logged: the dyno and the drag timer need it'); return; }
        if (chosen.has(def.id)) chosen.delete(def.id);
        else if (logged().length >= opts.max) { say('At most ' + opts.max + ' channels: untick one first'); return; }
        else chosen.add(def.id);
        isDefault = false;
        changed = true;
    }
    function reset() {
        chosen.clear();
        opts.defaults().forEach((id) => chosen.add(id));
        isDefault = true;
        changed = true;
        say('Back to the channels the pages show');
    }

    const sh = {
        title: 'Channels',
        focus: 0, open: null, sub: 0,       // open: the group whose channels are listed
        parent: null, parentSub: 0,         // open came from Advanced PIDs (its parts list)
        controller: false,                  // the controller was used: show where it is
        rows() {
            if (this.open && this.open.parts) {
                return this.open.parts.map((g) => ({ label: g.label, kind: 'more', value: countOn(g.defs, isOn) + ' of ' + g.defs.length }));
            }
            if (this.open) {
                return this.open.defs.map((d) => ({
                    label: d.name, kind: 'toggle', on: isOn(d.id),
                    value: REQUIRED.indexOf(d.id) >= 0 ? 'always' : opts.unit(d) || null,
                }));
            }
            const head = { label: 'Defaults: the channels the pages show', value: opts.defaults().filter((id) => all().has(id)).length + ' channels' };
            const m = menu();
            const rows = [head].concat(m.main.map((g) => ({ label: g.label, kind: 'more', value: countOn(g.defs, isOn) + ' of ' + g.defs.length })));
            if (m.adv.length) rows.push({ label: 'Advanced PIDs (' + m.advCount + ' ' + ECU.name() + ' values)', kind: 'more', value: m.adv.reduce((n, g) => n + countOn(g.defs, isOn), 0) + ' chosen' });
            return rows;
        },
        draw(r, t) {
            r.clear(t.bg);
            const rows = this.rows(), n = logged().length;
            const msg = Date.now() < noteUntil ? note : '';
            if (this.open) {
                r.text(this.open.label, 44, TOP + 40, 32, t.text, { font: 'bold' });
                const tw = r.textWidth(this.open.label, 32, { font: 'bold' });
                r.text(msg || n + ' of at most ' + opts.max + ' logged', 44 + tw + 24, TOP + 38, 22, msg ? t.warn : t.dim);
            } else {
                r.text(msg || 'Logging ' + n + ' of at most ' + opts.max + ' channels. Fewer channels, more samples per second.', 44, TOP + 38, 24, msg ? t.warn : t.dim);
            }
            const targets = [];
            // Back (a group) / Done: top right; the controller reaches it turning up from the first row
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Done', this.controller && (this.open ? this.sub : this.focus) === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            const rects = list(r, t, this.key(), rows, this.open ? this.sub : this.focus, TOP + 74, this.controller);
            rects.forEach((q) => targets.push(Object.assign(q, { act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.choose(); } })));
            return targets;
        },
        key() { return this.open ? 'ch_' + this.open.key : 'ch_groups'; },
        /** (tests) the list open: 'groups', 'adv' or a group's key */
        level() { return this.open ? this.open.key : 'groups'; },
        top() { return (this.open ? this.sub : this.focus) === -1; },
        scroll(dy) {
            const st = list.scroll[this.key()];
            if (st) { st.y += dy; st.drag = true; }
        },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            if ((this.open ? this.sub : this.focus) === -1) {
                const res = this.back();
                if (this.open === null) this.focus = Math.max(0, this.focus);
                return res;
            }
            return this.choose();
        },
        choose() {
            if (this.open && this.open.parts) {
                const g = this.open.parts[this.sub];
                if (g) { this.parent = this.open; this.parentSub = this.sub; this.open = g; this.sub = 0; }
                return null;
            }
            if (this.open) {
                const d = this.open.defs[this.sub];
                if (d) toggle(d);
                return null;
            }
            if (this.focus === 0) { reset(); return null; }
            const m = menu(), g = m.main[this.focus - 1];
            if (g) { this.open = g; this.sub = 0; }
            else if (this.focus - 1 === m.main.length && m.adv.length) { this.open = advGroup(m); this.sub = 0; }
            return null;
        },
        back() {
            if (this.open && this.parent) { this.open = this.parent; this.sub = this.parentSub; this.parent = null; return null; }
            if (this.open) { this.open = null; return null; }
            return 'close';
        },
        onClose() { if (changed) opts.done({ ids: Array.from(chosen), isDefault }); },
        /** (tests) what is chosen now */
        chosen() { return Array.from(chosen); },
    };
    return sh;
}

/**
 * Setup page: which channels one page shows as tiles.
 * opts: {
 *   page            the page's name (the sheet's title)
 *   channels()      the car's channels: Map id -> ChannelDef
 *   groups          group order (Boostline's GROUP_ORDER)
 *   chosen          the page's tiles now (ids, in order)
 *   isDefault       chosen is the page's own set
 *   defaults()      the page's own tiles on this car
 *   max             the most tiles a page has
 *   folded(id, ids) true when id shares the tile of another of ids (a target beside its actual)
 *   pairOf(id)      the target that shares id's tile (or undefined): taken off with it
 *   unit(def)       the unit beside a channel
 *   done({ ids, isDefault })   on close, when the choice changed
 * }
 */
function tileSheet(opts) {
    let chosen = opts.chosen.slice();
    let isDefault = !!opts.isDefault, changed = false;
    let note = '', noteUntil = 0;
    const say = (s) => { note = s; noteUntil = Date.now() + 4000; };
    const all = () => opts.channels();
    const menu = () => menuOf(all(), opts.groups);
    const tiles = (ids) => ids.filter((id) => !opts.folded(id, ids)).length;
    /** the first list: what the page shows now, ticked, to take off */
    // (a target that shares its actual's tile isn't a tile of its own: it goes with the actual)
    const shownGroup = () => ({
        key: 'tiles', label: 'On this page',
        defs: chosen.filter((id) => !opts.folded(id, chosen)).map((id) => all().get(id) || { id, name: id + ' (not on this car)' }),
    });

    function toggle(def) {
        const i = chosen.indexOf(def.id);
        if (i >= 0) {
            chosen.splice(i, 1);
            const pair = opts.pairOf && opts.pairOf(def.id);
            if (pair && chosen.indexOf(pair) >= 0 && !opts.folded(pair, chosen)) chosen.splice(chosen.indexOf(pair), 1);
        }
        else if (tiles(chosen.concat([def.id])) > opts.max) { say('At most ' + opts.max + ' tiles on a page: take one off first'); return; }
        else chosen.push(def.id);
        isDefault = false;
        changed = true;
    }
    function reset() {
        chosen = opts.defaults().slice();
        isDefault = true;
        changed = true;
        say('Back to this page\'s own tiles');
    }

    const sh = {
        title: 'Setup page',
        focus: 0, open: null, sub: 0, controller: false,
        parent: null, parentSub: 0,
        rows() {
            const on = new Set(chosen.filter((id) => !opts.folded(id, chosen)));
            const isOn = (id) => on.has(id);
            if (this.open && this.open.parts) {
                return this.open.parts.map((g) => ({ label: g.label, kind: 'more', value: countOn(g.defs, isOn) + ' of ' + g.defs.length }));
            }
            if (this.open) {
                return this.open.defs.map((d) => ({ label: d.name, kind: 'toggle', on: chosen.indexOf(d.id) >= 0, value: (d.unit !== undefined && opts.unit(d)) || null }));
            }
            const n = tiles(chosen), m = menu();
            const rows = [
                { label: 'Defaults: this page\'s own tiles', value: isDefault ? 'in use' : null },
                { label: 'On this page (tap one to take it off)', kind: 'more', value: n + ' of ' + opts.max + ' tiles' },
            ].concat(m.main.map((g) => ({ label: g.label, kind: 'more', value: countOn(g.defs, isOn) + ' of ' + g.defs.length })));
            if (m.adv.length) rows.push({ label: 'Advanced PIDs (' + m.advCount + ' ' + ECU.name() + ' values)', kind: 'more', value: m.adv.reduce((k, g) => k + countOn(g.defs, isOn), 0) + ' on this page' });
            return rows;
        },
        draw(r, t) {
            r.clear(t.bg);
            const rows = this.rows();
            const msg = Date.now() < noteUntil ? note : '';
            const head = this.open ? this.open.label : 'Setup page: ' + opts.page;
            r.text(head, 44, TOP + 40, 32, t.text, { font: 'bold' });
            const tw = r.textWidth(head, 32, { font: 'bold' });
            r.text(msg || tiles(chosen) + ' of ' + opts.max + ' tiles, in the order ticked', 44 + tw + 24, TOP + 38, 22, msg ? t.warn : t.dim);
            const targets = [];
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Done', this.controller && (this.open ? this.sub : this.focus) === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            const rects = list(r, t, this.key(), rows, this.open ? this.sub : this.focus, TOP + 74, this.controller);
            rects.forEach((q) => targets.push(Object.assign(q, { act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.choose(); } })));
            return targets;
        },
        key() { return this.open ? 'tile_' + this.open.key : 'tile_groups'; },
        level() { return this.open ? this.open.key : 'groups'; },
        top() { return (this.open ? this.sub : this.focus) === -1; },
        scroll(dy) { const st = list.scroll[this.key()]; if (st) { st.y += dy; st.drag = true; } },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            if ((this.open ? this.sub : this.focus) === -1) {
                const res = this.back();
                if (this.open === null) this.focus = Math.max(0, this.focus);
                return res;
            }
            return this.choose();
        },
        choose() {
            if (this.open && this.open.parts) {
                const g = this.open.parts[this.sub];
                if (g) { this.parent = this.open; this.parentSub = this.sub; this.open = g; this.sub = 0; }
                return null;
            }
            if (this.open) {
                const d = this.open.defs[this.sub];
                if (d) toggle(d);
                // the page's own list: a channel taken off leaves it
                if (this.open.key === 'tiles') { this.open = shownGroup(); this.sub = Math.min(this.sub, Math.max(0, this.open.defs.length - 1)); }
                return null;
            }
            if (this.focus === 0) { reset(); return null; }
            if (this.focus === 1) { this.open = shownGroup(); this.sub = 0; return null; }
            const m = menu(), g = m.main[this.focus - 2];
            if (g) { this.open = g; this.sub = 0; }
            else if (this.focus - 2 === m.main.length && m.adv.length) { this.open = advGroup(m); this.sub = 0; }
            return null;
        },
        back() {
            if (this.open && this.parent) { this.open = this.parent; this.sub = this.parentSub; this.parent = null; return null; }
            if (this.open) { this.open = null; return null; }
            return 'close';
        },
        onClose() { if (changed) opts.done({ ids: chosen.slice(), isDefault }); },
        chosen() { return chosen.slice(); },
    };
    return sh;
}

/**
 * One value from a list: opts { title, head, options: [[value, label]], current, done(value) }.
 * Picking one closes the sheet.
 */
function choiceSheet(opts) {
    let current = opts.current;
    const sh = {
        title: opts.title,
        focus: Math.max(0, opts.options.findIndex((o) => o[0] === current)), controller: false,
        rows() { return opts.options.map((o) => ({ label: o[1], kind: 'radio', on: o[0] === current })); },
        draw(r, t) {
            r.clear(t.bg);
            r.text(opts.head || opts.title, 44, TOP + 40, 32, t.text, { font: 'bold' });
            const targets = [];
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, 'Done', this.controller && this.focus === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => 'close' });
            const rects = list(r, t, 'choice_' + opts.title, this.rows(), this.focus, TOP + 74, this.controller);
            rects.forEach((q) => targets.push(Object.assign(q, { act: () => { this.focus = q.i; return this.choose(); } })));
            return targets;
        },
        top() { return this.focus === -1; },
        scroll(dy) { const st = list.scroll['choice_' + opts.title]; if (st) { st.y += dy; st.drag = true; } },
        release() { const st = list.scroll['choice_' + opts.title]; if (st) st.drag = false; },
        move(d) { this.controller = true; this.focus = Math.max(-1, Math.min(opts.options.length - 1, this.focus + d)); },
        press() { this.controller = true; return this.focus === -1 ? 'close' : this.choose(); },
        choose() {
            const o = opts.options[this.focus];
            if (!o) return null;
            current = o[0];
            opts.done(current);
            return 'close';
        },
        back() { return 'close'; },
    };
    return sh;
}

/** How long a first press on Delete waits for the second. */
const DELETE_ARM_MS = 4000;

/**
 * The Files page's browser.
 * opts: {
 *   folders()             [{ key, label, count, bytes }]
 *   list(key)             the folder's files: [{ file, title, sub, bytes }], newest first
 *   busy(item)            true for a file that can't go now (the capture being written)
 *   viewLabel(key)        the View row's label for the folder ("Show on the Dyno page")
 *   view(key, item)       opens it; the sheet closes
 *   remove(key, item)     deletes one; true when it went
 *   removeAll(key)        deletes the folder's files (but a busy one); returns how many
 *   size(bytes)           "1.2 MB"
 * }
 */
function fileSheet(opts) {
    let note = '', noteUntil = 0;
    const say = (s) => { note = s; noteUntil = Date.now() + 4000; };
    let armed = null, armedUntil = 0;         // the delete row waiting for its second press
    const isArmed = (k) => armed === k && Date.now() < armedUntil;
    const confirm = (k) => {
        if (isArmed(k)) { armed = null; return true; }
        armed = k;
        armedUntil = Date.now() + DELETE_ARM_MS;
        return false;
    };
    let folder = null, item = null, items = [];
    const refresh = () => { items = folder ? opts.list(folder.key) : []; };

    const sh = {
        title: 'Files',
        focus: 0, sub: 0, act: 0, controller: false,
        level() { return item ? 2 : folder ? 1 : 0; },
        rows() {
            if (item) {
                return [
                    { label: opts.viewLabel(folder.key), kind: 'more' },
                    { label: isArmed('one') ? 'Press again to delete' : 'Delete', value: opts.busy(item) ? 'being written' : opts.size(item.bytes) },
                ];
            }
            if (folder) {
                const n = items.length;
                return [{ label: isArmed('all') ? 'Press again to delete ' + n + ' file' + (n === 1 ? '' : 's') : 'Delete all', value: n ? n + ' file' + (n === 1 ? '' : 's') : 'empty' }]
                    .concat(items.map((i) => ({ label: i.title, kind: 'more', value: i.sub })));
            }
            return opts.folders().map((f) => ({ label: f.label, kind: 'more', value: f.count + ' · ' + opts.size(f.bytes) }));
        },
        draw(r, t) {
            r.clear(t.bg);
            const rows = this.rows();
            const msg = Date.now() < noteUntil ? note : '';
            const head = item ? item.title : folder ? folder.label : 'Files';
            r.text(head, 44, TOP + 40, 32, t.text, { font: 'bold' });
            const tw = r.textWidth(head, 32, { font: 'bold' });
            const hint = msg || (item ? item.sub : folder ? 'Newest first' : 'What ECU Live Data saved: look at it or delete it');
            r.text(hint, 44 + tw + 24, TOP + 38, 22, msg ? t.warn : t.dim);
            const targets = [];
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.level() ? 'Back' : 'Done', this.controller && this.cur() === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            const rects = list(r, t, this.key(), rows, this.cur(), TOP + 74, this.controller);
            rects.forEach((q) => targets.push(Object.assign(q, { act: () => { this.setCur(q.i); return this.choose(); } })));
            return targets;
        },
        key() { return item ? 'file_item' : folder ? 'file_' + folder.key : 'file_folders'; },
        cur() { return item ? this.act : folder ? this.sub : this.focus; },
        setCur(i) { if (item) this.act = i; else if (folder) this.sub = i; else this.focus = i; },
        top() { return this.cur() === -1; },
        scroll(dy) { const st = list.scroll[this.key()]; if (st) { st.y += dy; st.drag = true; } },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            this.setCur(Math.max(-1, Math.min(this.rows().length - 1, this.cur() + d)));
        },
        press() {
            this.controller = true;
            if (this.cur() === -1) return this.back();
            return this.choose();
        },
        choose() {
            const i = this.cur();
            if (item) {
                if (i === 0) { opts.view(folder.key, item); return 'close'; }
                if (i === 1) {
                    if (opts.busy(item)) { say('The capture is still being written: stop it first'); return null; }
                    if (!confirm('one')) return null;
                    if (opts.remove(folder.key, item)) say('Deleted ' + item.title); else say('Could not delete it');
                    item = null;
                    refresh();
                    this.sub = Math.min(this.sub, items.length);
                }
                return null;
            }
            if (folder) {
                if (i === 0) {
                    if (!items.length) { say('Nothing to delete'); return null; }
                    if (!confirm('all')) return null;
                    const n = opts.removeAll(folder.key);
                    say('Deleted ' + n + ' file' + (n === 1 ? '' : 's'));
                    refresh();
                    this.sub = 0;
                    return null;
                }
                const it = items[i - 1];
                if (it) { item = it; this.act = 0; armed = null; }
                return null;
            }
            const f = opts.folders()[i];
            if (f) { folder = f; refresh(); this.sub = items.length ? 1 : 0; armed = null; }
            return null;
        },
        back() {
            armed = null;
            if (item) { item = null; return null; }
            if (folder) { folder = null; return null; }
            return 'close';
        },
    };
    return sh;
}

module.exports = { ECU, REQUIRED, defaultIds, loggedIds, channelSheet, tileSheet, choiceSheet, fileSheet, channelGroups };
