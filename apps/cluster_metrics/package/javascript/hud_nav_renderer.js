'use strict';
/**
 * hud_nav_renderer.js - Full-height vector turn-by-turn directions & lane guidance on the HUD.
 *
 * Uses Redline's maneuver glyph & lane-arrow primitives (`redline_hud_nav`) inside our G30
 * full-height layout:
 *   - hud_road (544x38 across HUD x=132..676, y=100..138): Full-width road name + green highway exit badge
 *   - hud_nav  (264x232 at x=412..676, y=140..372): Hero maneuver glyph, large distance + unit,
 *     "then" secondary maneuver, and full-width 6-lane guidance strip.
 *
 * Strict Node 8.16.2 (ES2017) & ASCII-only font glyphs.
 */

const { withAlpha } = require('./kit/canvas');
const {
    drawArrow,
    drawLaneArrows,
    laneWindow,
    shapeOf,
    roundaboutGeom,
    gapText,
} = require('./redline_hud_nav');

const NW = 264;
const NH = 232;
const ROAD_W = 544;
const ROAD_H = 38;
const LANE_W = 40;
const LANE_H = 50;
const LANES_MAX = 6;
const LANE_K_SCALE = 0.56 / 0.4; // scale Redline's 0.4 lane glyphs to 0.56 full-height strip
const isNum = (x) => typeof x === 'number' && isFinite(x);
const laneW = (n, maxW) => Math.min(LANE_W, maxW / Math.max(1, n));

function foldAscii(s) {
    let t = String(s || '')
        .replace(/[\u0000-\u001f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\x7f]/g, '')
        .replace(/[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ');
    try { t = t.normalize('NFD'); } catch (e) { /* ignore */ }
    const lig = { '\u00df': 'ss', '\u1e9e': 'SS', '\u00e6': 'ae', '\u00c6': 'AE', '\u00f8': 'o', '\u00d8': 'O', '\u0153': 'oe', '\u0152': 'OE', '\u0142': 'l', '\u0141': 'L', '\u0111': 'd', '\u0110': 'D', '\u0131': 'i' };
    t = t.replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[^\x20-\x7e\u3000-\u9fff\uff00-\uffef]/g, (ch) => lig[ch] || '');
    return t.replace(/\s+/g, ' ').trim();
}

function fitAscii(cv, s, size, w, opts) {
    if (cv.textWidth(s, size, opts) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '...', size, opts) > w) n--;
    return n > 1 ? s.slice(0, n).trim() + '...' : '';
}

function wrapAscii(cv, s, size, w, opts, lines) {
    const words = String(s || '').split(/\s+/).filter(Boolean);
    const out = [];
    let cur = '';
    const width = (t) => cv.textWidth(t, size, opts);
    while (words.length && out.length < lines) {
        const word = words[0];
        const next = cur ? (cur + ' ' + word) : word;
        if (width(next) <= w) { cur = next; words.shift(); continue; }
        if (cur) { out.push(cur); cur = ''; continue; }
        let n = word.length;
        while (n > 1 && width(word.slice(0, n)) > w) n--;
        out.push(word.slice(0, n));
        words[0] = word.slice(n);
    }
    if (cur && out.length < lines) out.push(cur);
    else if (cur) words.unshift(cur);
    if (words.length && out.length) {
        out[out.length - 1] = fitAscii(cv, out[out.length - 1] + ' ' + words.join(' '), size, w, opts);
    }
    return out;
}

function drawLanes(cv, L, x, cy, w, col, dim, accent) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    const win = laneWindow(L);
    const n = Math.min(win.lanes.length, LANES_MAX);
    const k = (w / LANE_W) * LANE_K_SCALE;
    const h = LANE_H;
    const y0 = cy - h / 2;
    for (let i = 0; i <= n; i++) {
        const mk = win.markers && win.markers[i];
        const lx = x + i * w;
        if (mk === 'SOLID') cv.line(lx, y0, lx, y0 + h, 2, dim);
        else {
            for (let j = 0; j < 3; j++) cv.line(lx, y0 + j * h / 3 + 3, lx, y0 + j * h / 3 + h / 6 + 3, 2, dim);
        }
    }
    for (let i = 0; i < n; i++) {
        const ln = win.lanes[i];
        drawLaneArrows(cv, ln, x + (i + 0.5) * w, cy, Math.min(LANE_K_SCALE, k), col, dim);
        if (ln.hi && ln.info !== 'BLOCKED') {
            cv.fillRect(Math.round(x + i * w + 4), Math.round(y0 + h + 3), Math.max(4, Math.round(w - 8)), 3, accent || col);
        }
    }
    if (win.cutL) { cv.circle(x - 5, cy - 5, 2, dim); cv.circle(x - 5, cy + 5, 2, dim); }
    if (win.cutR) { cv.circle(x + n * w + 5, cy - 5, 2, dim); cv.circle(x + n * w + 5, cy + 5, 2, dim); }
    return n * w;
}

const DOPTS = { font: 'bold', literal: true };
const UOPTS = { font: 'bold', literal: true };
const ROPTS = { font: 'bold', literal: true };
const COPTS = { font: 'bold', align: 'center', literal: true };
const OUTLINE = [2, 6, 12, 238];
const ACCENT_BLUE = [56, 199, 255, 255];
const SOFT_BLUE = [158, 197, 235, 255];
const EXIT_GREEN = [21, 128, 61, 255];
const EXIT_BORDER = [220, 252, 231, 245];

function textOutline(cv, str, x, y, size, col, opts) {
    const r = size >= 26 ? 2 : 1;
    cv.text(str, x - r, y, size, OUTLINE, opts);
    cv.text(str, x + r, y, size, OUTLINE, opts);
    cv.text(str, x, y - r, size, OUTLINE, opts);
    cv.text(str, x, y + r, size, OUTLINE, opts);
    cv.text(str, x - 1, y - 1, size, OUTLINE, opts);
    cv.text(str, x + 1, y - 1, size, OUTLINE, opts);
    cv.text(str, x - 1, y + 1, size, OUTLINE, opts);
    cv.text(str, x + 1, y + 1, size, OUTLINE, opts);
    return cv.text(str, x, y, size, col, opts);
}

function measureExitBadge(cv, badge, fontSz) {
    const sz = fontSz || 19;
    return Math.max(32, Math.round(cv.textWidth(badge, sz, ROPTS) + 16));
}

function drawExitBadge(cv, badge, x, y, h, fontSz) {
    const sz = fontSz || 19;
    const bw = measureExitBadge(cv, badge, sz);
    cv.roundRect(x - 1, y - 1, bw + 2, h + 2, 7, OUTLINE);
    cv.roundRect(x, y, bw, h, 6, EXIT_GREEN);
    cv.strokeRoundRect(x + 1, y + 1, bw - 2, h - 2, 5, 1.5, EXIT_BORDER);
    cv.text(badge, Math.round(x + bw / 2), Math.round(y + h - 7), sz, [248, 252, 250, 255], COPTS);
    return bw;
}

function drawHudRoadBanner(cv, m) {
    cv.clear([0, 0, 0, 0]);
    if (!m) return false;
    const badge = m.exitBadge ? foldAscii(m.exitBadge) : '';
    const road = m.road ? foldAscii(m.road) : '';
    if (!badge && !road) return false;

    const col = [242, 245, 250, 255];
    const badgeW = badge ? measureExitBadge(cv, badge, 19) : 0;
    const gap = (badge && road) ? 10 : 0;
    const maxTextW = Math.max(40, cv.w - 12 - badgeW - gap);

    let rSz = 25;
    let rStr = road;
    if (rStr && cv.textWidth(rStr, rSz, ROPTS) > maxTextW) {
        rSz = 22;
        if (cv.textWidth(rStr, rSz, ROPTS) > maxTextW) {
            rSz = 19;
            rStr = fitAscii(cv, rStr, rSz, maxTextW, ROPTS);
        }
    }
    const textW = rStr ? cv.textWidth(rStr, rSz, ROPTS) : 0;
    const totW = badgeW + gap + textW;
    const navColCenter = Math.min(cv.w - 80, 412);
    const idealX = Math.round(navColCenter - totW / 2);
    let curX = Math.max(6, Math.min(cv.w - 6 - Math.round(totW), idealX));

    if (badge) {
        drawExitBadge(cv, badge, curX, 4, 30, 19);
        curX += badgeW + gap;
    }
    if (rStr) {
        const baseY = rSz >= 24 ? 28 : (rSz >= 21 ? 27 : 26);
        textOutline(cv, rStr, curX, baseY, rSz, col, ROPTS);
    }
    return true;
}

function drawHudNav(cv, m, opts) {
    cv.clear([0, 0, 0, 0]);
    if (!m) return null;
    const o = opts || {};
    const col = Array.isArray(o.color) ? [o.color[0], o.color[1], o.color[2], 255] : [242, 245, 250, 255];
    const dim = Array.isArray(o.color)
        ? [Math.round(col[0] * 0.46), Math.round(col[1] * 0.46), Math.round(col[2] * 0.46), 255]
        : [94, 122, 154, 235];
    const unitCol = Array.isArray(o.color) ? withAlpha(col, 0.85) : SOFT_BLUE;

    const midX = Math.round(cv.w / 2);
    const maxRoadW = cv.w - 12;
    const unit = foldAscii(m.unit || '');
    const rawDist = foldAscii(m.dist || '');
    const nL = m.lanes && m.lanes.lanes ? laneWindow(m.lanes).lanes.length : 0;
    const th = m.then || null;
    const thGap = (th && isNum(th.gap)) ? gapText(th.gap, unit, m.uk) : '';

    const hideRoad = Boolean(o.hideRoad);
    const badge = !hideRoad && m.exitBadge ? foldAscii(m.exitBadge) : '';
    const roadS = !hideRoad && m.road ? foldAscii(m.road) : '';
    const roadSingleSz = nL ? 22 : 24;
    const roadWrapSz = 19;
    const badgeW = badge ? measureExitBadge(cv, badge, 17) : 0;
    const line1Avail = maxRoadW - (badge ? badgeW + 8 : 0);
    const singleFits = Boolean(roadS) && cv.textWidth(roadS, roadSingleSz, ROPTS) <= line1Avail;
    const roadLines = !roadS ? [] : (singleFits ? [roadS] : wrapAscii(cv, roadS, roadWrapSz, line1Avail, ROPTS, 2));
    const hasInlineHeader = Boolean(badge || roadLines.length > 0);
    if (hasInlineHeader) {
        if (roadLines.length <= 1) {
            const txt = roadLines[0] || '';
            const tw = txt ? cv.textWidth(txt, roadSingleSz, ROPTS) : 0;
            const tot = badgeW + (badge && txt ? 8 : 0) + tw;
            let sx = Math.max(6, Math.round(midX - tot / 2));
            if (badge) { drawExitBadge(cv, badge, sx, 4, 26, 17); sx += badgeW + 8; }
            if (txt) textOutline(cv, txt, sx, 25, roadSingleSz, col, ROPTS);
        } else {
            let sx = 6;
            if (badge) { drawExitBadge(cv, badge, sx, 4, 26, 17); sx += badgeW + 8; }
            textOutline(cv, roadLines[0], sx, 21, roadWrapSz, col, ROPTS);
            textOutline(cv, roadLines[1], midX, 43, roadWrapSz, withAlpha(col, 0.92), COPTS);
        }
    }

    const botY = cv.h - 14;
    if (nL > 0) {
        const laneCy = cv.h - 38;
        const heroTop = hasInlineHeader ? 50 : 8;
        const heroBot = laneCy - 30;
        const arrowCx = 62;
        const arrowCy = Math.round((heroTop + heroBot) / 2);
        const arrowScale = hasInlineHeader ? 1.28 : 1.48;
        drawArrow(cv, m, arrowCx, arrowCy, arrowScale, col, dim);

        const rx = 126;
        const rMax = cv.w - rx - 6;
        if (rawDist) {
            let dSz = 48, uSz = 24;
            let uW = unit ? cv.textWidth(unit, uSz, UOPTS) : 0;
            let dW = cv.textWidth(rawDist, dSz, DOPTS);
            if (dW + (uW ? 6 + uW : 0) > rMax) {
                dSz = 42; uSz = 22;
                uW = unit ? cv.textWidth(unit, uSz, UOPTS) : 0;
                dW = cv.textWidth(rawDist, dSz, DOPTS);
            }
            const inlineFits = dW + (uW ? 6 + uW : 0) <= rMax;
            if (inlineFits) {
                const dy = th ? (arrowCy - 8) : (arrowCy + 14);
                const drawnW = textOutline(cv, rawDist, rx, dy, dSz, col, DOPTS);
                if (unit) textOutline(cv, unit, rx + drawnW + 6, dy - 2, uSz, unitCol, UOPTS);
            } else {
                const dFit = fitAscii(cv, rawDist, 42, rMax, DOPTS);
                const dyTop = th ? (arrowCy - 18) : (arrowCy - 2);
                textOutline(cv, dFit, rx, dyTop, 42, col, DOPTS);
                if (unit) textOutline(cv, unit, rx, dyTop + 26, 22, unitCol, UOPTS);
            }
        }

        if (th) {
            const ty = arrowCy + 40;
            const thenW = textOutline(cv, 'then', rx, ty, 19, unitCol, ROPTS);
            const ax = rx + thenW + 20;
            drawArrow(cv, th, ax, ty - 7, 0.44, col, dim);
            if (thGap) {
                const gFit = fitAscii(cv, thGap, 19, Math.max(24, cv.w - (ax + 18) - 4), ROPTS);
                if (gFit) textOutline(cv, gFit, ax + 18, ty, 19, col, ROPTS);
            }
        }

        const lw = laneW(nL, cv.w - 16);
        const lx = Math.round((cv.w - nL * lw) / 2);
        drawLanes(cv, m.lanes, lx, laneCy, lw, col, dim, ACCENT_BLUE);
    } else {
        const heroTop = hasInlineHeader ? 50 : 8;
        const heroBot = botY - 46;
        const heroCy = Math.round((heroTop + heroBot) / 2);
        if (th) {
            drawArrow(cv, m, 82, heroCy, hasInlineHeader ? 1.38 : 1.56, col, dim);
            const tCx = 198;
            textOutline(cv, 'then', tCx, heroCy - 34, 20, unitCol, COPTS);
            drawArrow(cv, th, tCx, heroCy + 2, 0.66, col, dim);
            if (thGap) {
                const gFit = fitAscii(cv, thGap, 20, 118, ROPTS);
                if (gFit) textOutline(cv, gFit, tCx, heroCy + 46, 20, col, COPTS);
            }
        } else {
            drawArrow(cv, m, midX, heroCy, hasInlineHeader ? 1.48 : 1.72, col, dim);
        }

        if (rawDist) {
            let dSz = 52, uSz = 26;
            const maxLineW = cv.w - 12;
            let uW = unit ? cv.textWidth(unit, uSz, UOPTS) : 0;
            let dStr = fitAscii(cv, rawDist, dSz, maxLineW - (uW ? 8 + uW : 0), DOPTS);
            let dW = cv.textWidth(dStr, dSz, DOPTS);
            if (dW + (uW ? 8 + uW : 0) > maxLineW) {
                dSz = 44; uSz = 23;
                uW = unit ? cv.textWidth(unit, uSz, UOPTS) : 0;
                dStr = fitAscii(cv, rawDist, dSz, maxLineW - (uW ? 7 + uW : 0), DOPTS);
                dW = cv.textWidth(dStr, dSz, DOPTS);
            }
            const totalW = dW + (uW ? 8 + uW : 0);
            const dx = Math.max(6, Math.round((cv.w - totalW) / 2));
            const drawnW = textOutline(cv, dStr, dx, botY, dSz, col, DOPTS);
            if (unit) textOutline(cv, unit, dx + drawnW + 8, botY - 2, uSz, unitCol, UOPTS);
        }
    }
    return true;
}

function hudRoadKey(m) {
    if (!m) return '';
    return (m.exitBadge || '') + '|' + (m.road || '');
}

function hudNavKey(m) {
    if (!m) return '';
    const L = m.lanes && m.lanes.lanes
        ? m.lanes.lanes.map((l) => (l.hi ? '*' : '') + (l.follows || [l.follow]).join('+') + '/' + (l.others || []).join('+') + '/' + l.info).join(',') +
            '|' + (m.lanes.markers || []).join(',') + '|' + m.lanes.rec
        : '';
    const T = m.then
        ? [m.then.kind, m.then.dir, m.then.geom, m.then.exit, m.then.exitAngle, m.then.side, m.then.flag, m.then.stop, gapText(m.then.gap, m.unit, m.uk)].join('/')
        : '';
    return [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.side, m.flag, m.stop, m.dist, m.unit, m.exitBadge, m.road, L, T].join('|');
}

module.exports = {
    NW,
    NH,
    ROAD_W,
    ROAD_H,
    drawHudRoadBanner,
    drawExitBadge,
    drawHudNav,
    hudRoadKey,
    hudNavKey,
    foldAscii,
    shapeOf,
    roundaboutGeom,
};
