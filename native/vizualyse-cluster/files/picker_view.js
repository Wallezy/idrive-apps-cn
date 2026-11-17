// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The theme picker's screen, in the touch kit (ui_kit.js): what it shows
 * for a model. Pure (no I/O): picker.js feeds it the tool's state and puts
 * it on the central screen; test/picker_test.js draws it to a PNG.
 *
 * Two tabs, in the kit's frame (tabs top left, List top right, the status
 * line at the bottom):
 *
 *   Themes    +-------------------------------+  Title (44)
 *             |                               |  what it is now
 *             |  the chosen theme, large      |  Preview [Sport | Comfort]
 *             |  (HERO; a swipe: the next)    |  [ Use this theme        ]
 *             |                               |  [ Try on the cluster    ]
 *             +-------------------------------+
 *             [tile][tile][tile][tile][tile][tile][tile][tile]   the eight families
 *
 *   Settings  Sport or Comfort [Auto | Sport | Comfort]      what shows now (info)
 *             Cluster themes (on / off)
 *             Cover the car's bottom strip (on / off)
 *
 * The model (picker.js): families [{ family, title, sport, comfort }] (theme
 * ids, null where a family lacks that mode), sel (an index), look ('sport' |
 * 'comfort': which of the two the previews show), enabled, inUse (the family
 * on the cluster), mode ('auto' | 'sport' | 'comfort'), cover, trying
 * ({ family, id, left } or null), canTry, line / lineWarn (the status
 * line), right (the status line's right end), info [[name, value]].
 * assets: hero(id), thumb(id): RGBA pictures or null.
 */
'use strict';

/* the body's places (body pixels: 1742 x 462) */
const HERO = { x: 0, y: 0, w: 965, h: 362 };
const COL = { x: 989, w: 753 };
const TILE = { y: 372, w: 207, h: 90, step: 219 };
/* the pictures: the hero, and a tile's (its rect less the 6 px ring margin) */
const THUMB = { w: TILE.w - 12, h: TILE.h - 12 };
const TABS = [['themes', 'Themes'], ['settings', 'Settings']];

function title(f) { return String(f.title || f.family).replace(/\s*·.*$/, ''); }

function lookId(m, fam) { return fam ? (m.look === 'comfort' ? fam.comfort || fam.sport : fam.sport || fam.comfort) : null; }

function themes(m, assets, chipW) {
    const fams = m.families || [], f = fams[m.sel], b = [];
    const inUse = !!(m.enabled && f && m.inUse === f.family && !m.trying);
    const trying = !!(m.trying && f && m.trying.family === f.family);
    const heroId = lookId(m, f);
    b.push({ id: 'hero', kind: 'image', x: HERO.x, y: HERO.y, w: HERO.w, h: HERO.h, r: 14, img: assets.hero(heroId), imgKey: heroId, swipe: fams.length > 1 });
    const badge = trying ? { text: 'On the cluster now (Try) · ' + Math.max(0, Math.ceil(m.trying.left)) + ' s', tone: 'warn' }
        : m.enabled && f && m.inUse === f.family ? { text: 'On the cluster', tone: 'live' } : null;
    if (badge) b.push({ id: 'badge', kind: 'chip', x: 16, y: 16, w: chipW(badge.text), h: 36, text: badge.text, tone: badge.tone });
    if (f) {
        b.push({ id: 'name', kind: 'text', x: COL.x, y: 0, w: COL.w, h: 58, font: 'f44', text: title(f) });
        const sub = inUse ? (m.mode === 'auto' ? 'In use: Sport or Comfort by the drive mode' : 'In use: always ' + (m.mode === 'sport' ? 'Sport' : 'Comfort'))
            : trying ? 'Trying it on the cluster, then back'
                : m.enabled ? 'Previewing: the cluster keeps ' + (fams.filter((x) => x.family === m.inUse).map(title)[0] || 'its theme')
                    : "Previewing: themes are off";
        b.push({ id: 'sub', kind: 'text', x: COL.x, y: 60, w: COL.w, h: 30, font: 'f20', colour: 'dim', text: sub });
        b.push({ id: 'lookLabel', kind: 'text', x: COL.x, y: 112, w: 100, h: 64, font: 'f20', colour: 'dim', text: 'Preview' });
        b.push({ id: 'look', kind: 'seg', x: COL.x + 100, y: 112, w: COL.w - 100, h: 64, act: true,
            options: [{ v: 'sport', l: 'Sport' }, { v: 'comfort', l: 'Comfort' }].filter((o) => f[o.v]), value: f.comfort && (m.look === 'comfort' || !f.sport) ? 'comfort' : 'sport' });
        b.push({ id: 'use', kind: 'button', x: COL.x, y: 190, w: COL.w, h: 80, act: true, on: !inUse,
            style: inUse ? 'secondary' : 'primary', label: inUse ? 'In use' : m.enabled ? 'Use this theme' : 'Turn on with this theme', sub: inUse ? 'on the cluster' : null });
        b.push({ id: 'try', kind: 'button', x: COL.x, y: 282, w: COL.w, h: 80, act: true, on: !!m.canTry && !m.trying,
            label: m.trying ? 'Trying: ' + Math.max(0, Math.ceil(m.trying.left)) + ' s' : 'Try on the cluster',
            sub: m.trying ? 'then back' : m.canTry ? 'for 10 s, then back' : 'only while parked' });
    }
    fams.forEach((fam, i) => {
        const id = lookId(m, fam);
        b.push({ id: 'tile:' + i, kind: 'tile', x: i * TILE.step, y: TILE.y, w: TILE.w, h: TILE.h, act: true, img: assets.thumb(id), imgKey: id,
            caption: title(fam), current: i === m.sel, badge: m.enabled && m.inUse === fam.family ? 'In use' : null });
    });
    return b;
}

function settings(m) {
    const b = [];
    b.push({ id: 'modeLabel', kind: 'text', x: 0, y: 0, w: 600, h: 30, font: 'f20', colour: 'dim', text: 'Sport or Comfort' });
    b.push({ id: 'mode', kind: 'seg', x: 0, y: 36, w: 1098, h: 80, act: true, value: m.mode,
        options: [{ v: 'auto', l: 'Auto', s: 'by the drive mode' }, { v: 'sport', l: 'Sport', s: 'always' }, { v: 'comfort', l: 'Comfort', s: 'always' }] });
    b.push({ id: 'onLabel', kind: 'text', x: 0, y: 140, w: 600, h: 30, font: 'f20', colour: 'dim', text: 'On the cluster' });
    b.push({ id: 'enabled', kind: 'toggle', x: 0, y: 176, w: 1098, h: 80, act: true, value: !!m.enabled,
        label: 'Cluster themes', sub: m.enabled ? 'on: the chosen theme shows' : "off: the car's own cluster shows" });
    b.push({ id: 'cover', kind: 'toggle', x: 0, y: 268, w: 1098, h: 80, act: true, value: !!m.cover,
        label: "Cover the car's bottom strip", sub: m.cover ? 'black under the theme' : 'the strip shows under the theme' });
    const rows = m.info || [];
    b.push({ id: 'info', kind: 'info', x: 1122, y: 0, w: 620, h: 8 + rows.length * 56, rows: rows });
    return b;
}

/* the kit's view for a model: { tabs, status, body } */
function view(m, ui, assets, chipW) {
    const tone = m.lineWarn ? 'warn' : m.trying ? 'warn' : m.enabled ? 'ok' : '';
    return {
        tabs: TABS,
        status: { tone: tone, text: m.line || '', right: m.right || '' },
        body: ui.tab === 'settings' ? settings(m) : themes(m, assets, chipW),
    };
}

module.exports = { HERO, THUMB, TILE, TABS, view, title, lookId };
