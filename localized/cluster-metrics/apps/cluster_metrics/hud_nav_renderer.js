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
const isNum = (x) => typeof x === 'number' && isFinite(x);
const laneW = (n, maxW) => Math.min(LANE_W, maxW / Math.max(1, n));

const LANE_TURN_DIRECTIONS = [
    'STRAIGHT_ON', 'SLIGHT_LEFT', 'SLIGHT_RIGHT', 'LEFT', 'RIGHT',
    'HARD_LEFT', 'HARD_RIGHT', 'SHARP_LEFT', 'SHARP_RIGHT',
    'UTURN_LEFT', 'UTURN_RIGHT', 'U_TURN_LEFT', 'U_TURN_RIGHT',
];

function laneDirSide(d) {
    return /LEFT/.test(d) ? -1 : 1;
}

function laneTurnDeg(d) {
    if (/SLIGHT/.test(d)) return 45;
    if (/HARD|SHARP/.test(d)) return 135;
    if (/LEFT|RIGHT/.test(d)) return 90;
    return 0;
}

function roundLanePath(path, r, headRun) {
    if (!r || path.length < 3) return path;
    const len = (a, b) => Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const A = path[i - 1], B = path[i], C = path[i + 1];
        const la = len(A, B), lc = len(B, C);
        const maxEnd = i === path.length - 2 ? Math.max(0, lc - (headRun || 16)) : lc / 2;
        const rr = Math.max(0, Math.min(r, la / 2, maxEnd));
        if (rr < 1) { out.push(B); continue; }
        const P = [B[0] + (A[0] - B[0]) * rr / la, B[1] + (A[1] - B[1]) * rr / la];
        const Q = [B[0] + (C[0] - B[0]) * rr / lc, B[1] + (C[1] - B[1]) * rr / lc];
        for (let k = 0; k <= 6; k++) {
            const t = k / 6, u = 1 - t;
            out.push([
                u * u * P[0] + 2 * u * t * B[0] + t * t * Q[0],
                u * u * P[1] + 2 * u * t * B[1] + t * t * Q[1],
            ]);
        }
    }
    out.push(path[path.length - 1]);
    return out;
}

function laneGlyphSpec(dir, hasStraight, stemX) {
    const d = String(dir || '');
    const mir = laneDirSide(d);
    const sx = typeof stemX === 'number' ? stemX : 0;
    if (/UTURN|U_TURN/.test(d)) {
        if (!hasStraight) {
            // Full-height standalone U-turn with wide open hairpin channel
            const p = [[12, 35], [12, -14]];
            for (let i = 1; i <= 8; i++) {
                const a = i * Math.PI / 8;
                p.push([12 * Math.cos(a), -14 - 12 * Math.sin(a)]);
            }
            p.push([-12, 16]);
            return { path: p, mir: -mir, head: 0.80, round: 0, widthScale: 0.84 };
        }
        const localSx = sx * mir;
        const p = [[localSx, 35], [localSx, -10]];
        for (let i = 1; i <= 8; i++) {
            const a = Math.PI - i * Math.PI / 8;
            p.push([localSx + 10 + 10 * Math.cos(a), -10 - 10 * Math.sin(a)]);
        }
        p.push([localSx + 20, 15]);
        return { path: p, mir, head: 0.74, round: 0, widthScale: 0.84 };
    }
    const deg = laneTurnDeg(d);
    if (deg === 0) return { path: [[sx, 35], [sx, -37]], mir: 1, head: 1.0, round: 0 };
    if (!hasStraight) {
        // Standalone turning lane: full-height stem + rounded bend so turning lanes match straight height
        if (deg === 90) return { path: [[-8, 35], [-8, -15], [25, -15]], mir, head: 0.96, round: 9 };
        if (deg === 45) return { path: [[-4, 35], [-4, -1], [24, -31]], mir, head: 0.96, round: 9 };
        return { path: [[-10, 35], [-10, -16], [23, 17]], mir, head: 0.92, round: 9 };
    }
    // Combo lane (straight + turn): stem shifted slightly opposite the turn so the arm has clear horizontal neck
    const localSx = sx * mir;
    if (deg === 90) return { path: [[localSx, 35], [localSx, 3], [27, 3]], mir, head: 0.80, round: 7 };
    if (deg === 45) return { path: [[localSx, 35], [localSx, 7], [26, -18]], mir, head: 0.82, round: 7 };
    return { path: [[localSx, 35], [localSx, -2], [24, 21]], mir, head: 0.80, round: 7 };
}

function drawLaneArrowPath(cv, path, X, Y, s, W, col, headScale) {
    const p = path.slice();
    const a = p[p.length - 2];
    const b = p[p.length - 1];
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
    const l = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1;
    const ux = (bx - ax) / l;
    const uy = (by - ay) / l;
    const hs = headScale || 1;
    const L = 21 * s * hs;
    const HW = 15.2 * s * hs;
    const back = Math.min(L * 0.72, l * 0.88) / l;
    p[p.length - 1] = [b[0] + (a[0] - b[0]) * back, b[1] + (a[1] - b[1]) * back];
    if (cv.stroke) {
        cv.stroke(p.map((pt) => [X(pt), Y(pt)]), W, col);
    } else {
        for (let i = 1; i < p.length; i++) cv.line(X(p[i - 1]), Y(p[i - 1]), X(p[i]), Y(p[i]), W, col);
    }
    const qx = bx - ux * L;
    const qy = by - uy * L;
    cv.triangle([[bx, by], [qx - uy * HW, qy + ux * HW], [qx + uy * HW, qy - ux * HW]], col);
}

/**
 * Bold, full-height BMW-style HUD lane arrow renderer:
 *   - Thicker strokes (`W = 12.8 * s`) so straight & turning lanes stay crisp on windshield glass
 *   - Full-height turning stems (`y = +35 -> -15`) on standalone turn lanes and elevated branches on combo lanes
 */
function drawBoldLaneArrows(cv, lane, cx, cy, cellW, cellH, col, dim) {
    const s = Math.min(cellH / 78, cellW / 60);
    const W = Math.max(2.6, 12.8 * s);
    if (lane.info === 'ELLIPSIS') {
        const dr = Math.max(1.8, 3.2 * s);
        [-12, 0, 12].forEach((dx) => cv.circle(cx + dx * s, cy, dr, dim));
        return;
    }
    const follows = lane.follows || (lane.follow && lane.follow !== 'NONE' ? [lane.follow] : []);
    const others = Array.isArray(lane.others) ? lane.others : [];
    const blocked = lane.info === 'BLOCKED';
    const allDirs = others.concat(follows);
    const hasStraight = allDirs.some((d) => d === 'STRAIGHT_ON');
    const hasLeft = allDirs.some((d) => /LEFT/.test(String(d || '')));
    const hasRight = allDirs.some((d) => /RIGHT/.test(String(d || '')));
    // Shift shared stem slightly away from a one-sided combo turn so the turn arm is bold & unmistakable
    const stemX = hasStraight ? (hasRight && !hasLeft ? -7 : (hasLeft && !hasRight ? 7 : 0)) : 0;

    const one = (d, c) => {
        if (!d || d === 'NONE' || LANE_TURN_DIRECTIONS.indexOf(d) < 0) return;
        const g = laneGlyphSpec(d, hasStraight, stemX);
        const X = (p) => cx + p[0] * g.mir * s;
        const Y = (p) => cy + p[1] * s;
        const pts = g.round ? roundLanePath(g.path, g.round, 15 * (g.head || 1)) : g.path;
        drawLaneArrowPath(cv, pts, X, Y, s, W * (g.widthScale || 1), c, g.head || 1);
    };

    others.forEach((d) => one(d, dim));
    follows.forEach((d) => one(d, lane.hi && !blocked ? col : dim));
    if (blocked) {
        const r = 13 * s;
        const xw = Math.max(2.4, 4.4 * s);
        cv.line(cx - r, cy - r, cx + r, cy + r, xw, dim);
        cv.line(cx - r, cy + r, cx + r, cy - r, xw, dim);
    }
}

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

function scaleAlpha(rgba, a) {
    const k = Math.max(0, Math.min(1, a));
    return [rgba[0], rgba[1], rgba[2], Math.round((rgba[3] !== undefined ? rgba[3] : 255) * k)];
}

function drawHovDiamond(cv, cx, cy, s, col) {
    const rx = Math.max(3.5, 11 * s);
    const ry = Math.max(5, 16 * s);
    const pts = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]];
    cv.polyline(pts, Math.max(2.0, 4.2 * s), col);
}

/**
 * Flexible single-tier lane row renderer supporting both foreground primary rows,
 * compact tucked upper rows (`isBack`), and continuous promotion animation interpolation.
 */
function drawLaneRow(cv, L, cx, cy, col, dim, accent, opts) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    const o = opts || {};
    const win = laneWindow(L);
    const n = Math.min(win.lanes.length, LANES_MAX);
    const maxW = typeof o.maxW === 'number' ? o.maxW : (cv.w - 16);
    const cellMaxW = typeof o.cellMaxW === 'number' ? o.cellMaxW : LANE_W;
    const w = Math.min(cellMaxW, maxW / Math.max(1, n));
    const h = typeof o.h === 'number' ? o.h : LANE_H;
    const alpha = typeof o.alpha === 'number' ? o.alpha : 1;
    if (alpha <= 0.02) return 0;

    const totalW = n * w;
    const x = Math.round(cx - totalW / 2);
    const y0 = cy - h / 2;
    const lineW = o.isBack ? 1.5 : Math.max(1.6, 2 * (h / LANE_H));

    const cCol = scaleAlpha(col, alpha);
    const cDim = scaleAlpha(dim, alpha * (o.isBack ? 0.82 : 1));
    const ulAlpha = typeof o.underlineAlpha === 'number' ? o.underlineAlpha : (o.isBack ? 0 : 1);
    const cAcc = scaleAlpha(accent || col, alpha * ulAlpha);

    // Subtle top framing hairline on tucked upper tier (mirrors BMW's rear stacked lane card)
    if (o.isBack) {
        cv.fillRect(Math.round(x + 2), Math.round(y0 - 2), Math.max(4, Math.round(totalW - 4)), 1, scaleAlpha(dim, alpha * 0.45));
    }

    for (let i = 0; i <= n; i++) {
        const mk = win.markers && win.markers[i];
        const lx = x + i * w;
        if (mk === 'SOLID') {
            cv.line(lx, y0, lx, y0 + h, lineW, cDim);
        } else {
            const segs = h < 34 ? 2 : 3;
            for (let j = 0; j < segs; j++) {
                const segTop = y0 + (j * h) / segs + 2;
                const segBot = Math.min(y0 + h, segTop + h / (segs * 2));
                cv.line(lx, segTop, lx, segBot, lineW, cDim);
            }
        }
    }

    const hovS = Math.min(h / 78, w / 60);
    for (let i = 0; i < n; i++) {
        const ln = win.lanes[i];
        const lcx = x + (i + 0.5) * w;
        const hasArrows = Boolean((ln.follows && ln.follows.length) || (ln.others && ln.others.length));
        if (ln.info === 'HOV' && !hasArrows) {
            drawHovDiamond(cv, lcx, cy, hovS, ln.hi ? cCol : cDim);
        } else {
            drawBoldLaneArrows(cv, ln, lcx, cy, w, h, cCol, cDim);
        }
        if (ulAlpha > 0.05 && ln.hi && ln.info !== 'BLOCKED') {
            cv.fillRect(Math.round(x + i * w + 4), Math.round(y0 + h + 3), Math.max(4, Math.round(w - 8)), 3, cAcc);
        }
    }

    const dotR = o.isBack ? 1.5 : 2;
    if (win.cutL) { cv.circle(x - 5, cy - 4, dotR, cDim); cv.circle(x - 5, cy + 4, dotR, cDim); }
    if (win.cutR) { cv.circle(x + totalW + 5, cy - 4, dotR, cDim); cv.circle(x + totalW + 5, cy + 4, dotR, cDim); }
    return totalW;
}

function drawLanes(cv, L, x, cy, w, col, dim, accent) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    const n = Math.min(laneWindow(L).lanes.length, LANES_MAX);
    return drawLaneRow(cv, L, x + (n * w) / 2, cy, col, dim, accent, {
        maxW: n * w,
        cellMaxW: w,
        h: LANE_H,
        alpha: 1,
        underlineAlpha: 1,
    });
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
const SHIELD_RED = [214, 40, 40, 255];
const SHIELD_BLUE = [29, 78, 216, 255];
const SHIELD_GREEN = [21, 128, 61, 255];
const SHIELD_WHITE = [244, 247, 251, 255];
const SHIELD_INK = [15, 23, 42, 255];

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

function shieldFontSize(num, h) {
    const len = String(num || '').length;
    if (h <= 26) return len >= 3 ? 14 : 16;
    return len >= 3 ? 17 : 19;
}

function measureRoadShield(cv, sh, h) {
    const hh = h || 32;
    const num = foldAscii(sh && sh.num ? sh.num : '');
    if (!num) return 0;
    const sz = shieldFontSize(num, hh);
    if (sh && sh.kind === 'state') {
        const minW = hh <= 26 ? 38 : 46;
        return Math.max(minW, Math.round(cv.textWidth(num, sz, ROPTS) + 22));
    }
    const minW = hh <= 26 ? 32 : 38;
    return Math.max(minW, Math.round(cv.textWidth(num, sz, ROPTS) + 16));
}

/**
 * Scanline-filled vector shield shape helper so shields render with crisp anti-aliased silhouettes
 * (Interstate red/blue crest, US Route scalloped white shield, CA/State green spade, EU route plate).
 */
function paintShieldScanlines(cv, x, y, w, h, kind) {
    const cx = x + w / 2;
    const hwMax = w / 2;
    const d = cv.d;
    const cw = cv.w;
    const ch = cv.h;

    function halfWidthAt(t) {
        if (kind === 'interstate') {
            // Classic Interstate shield: wide crown, full sides, graceful pointed bottom
            if (t < 0.14) return hwMax * (0.86 + 0.14 * (t / 0.14));
            if (t < 0.56) return hwMax;
            const u = (t - 0.56) / 0.44;
            return hwMax * Math.max(0.08, Math.pow(1 - u * u, 0.72));
        }
        if (kind === 'us') {
            // Classic US Highway shield: slightly notched upper shoulders, rounded waist, pointed tip
            if (t < 0.14) return hwMax * (0.78 + 0.14 * (t / 0.14));
            if (t < 0.24) return hwMax * (0.92 - 0.05 * Math.sin(((t - 0.14) / 0.10) * Math.PI));
            if (t < 0.62) return hwMax;
            const u = (t - 0.62) / 0.38;
            return hwMax * Math.max(0.08, Math.pow(1 - u * u, 0.75));
        }
        // State / California spade shield: domed top, wide body, flat-rounded bottom
        if (t < 0.22) {
            const u = 1 - t / 0.22;
            return hwMax * (0.48 + 0.52 * Math.sqrt(Math.max(0, 1 - u * u)));
        }
        if (t < 0.76) return hwMax;
        const u = (t - 0.76) / 0.24;
        return hwMax * Math.max(0.45, 1 - 0.55 * u * u);
    }

    function setPx(px, py, rgba) {
        if (px < 0 || px >= cw || py < 0 || py >= ch) return;
        const o = (py * cw + px) * 4;
        d[o] = rgba[0]; d[o + 1] = rgba[1]; d[o + 2] = rgba[2]; d[o + 3] = rgba[3];
    }

    const crownH = Math.max(6, Math.round(h * 0.26));
    for (let row = -1; row <= h; row++) {
        const py = y + row;
        if (py < 0 || py >= ch) continue;
        const t = Math.max(0, Math.min(1, (row + 0.5) / h));
        const hw = halfWidthAt(t);
        const xL = Math.round(cx - hw);
        const xR = Math.round(cx + hw);

        if (row === -1 || row === h) {
            for (let px = xL; px <= xR; px++) setPx(px, py, OUTLINE);
            continue;
        }
        // 1px dark outer outline
        setPx(xL - 1, py, OUTLINE);
        setPx(xR + 1, py, OUTLINE);

        const isTopBotBorder = row <= 1 || row >= h - 2;
        const borderCol = kind === 'us' ? SHIELD_INK : SHIELD_WHITE;

        for (let px = xL; px <= xR; px++) {
            const onEdge = isTopBotBorder || px <= xL + 1 || px >= xR - 1;
            if (onEdge) {
                setPx(px, py, borderCol);
            } else if (kind === 'interstate') {
                if (row === crownH) setPx(px, py, SHIELD_WHITE);
                else setPx(px, py, row < crownH ? SHIELD_RED : SHIELD_BLUE);
            } else if (kind === 'us') {
                setPx(px, py, SHIELD_WHITE);
            } else {
                setPx(px, py, SHIELD_GREEN);
            }
        }
    }
}

function drawRoadShield(cv, sh, x, y, h) {
    const hh = h || 32;
    const num = foldAscii(sh && sh.num ? sh.num : '');
    if (!num) return 0;
    const kind = (sh && sh.kind) || 'us';
    const bw = measureRoadShield(cv, sh, hh);
    const sz = shieldFontSize(num, hh);

    if (kind === 'state') {
        // MUTCD M1-5 State Route marker: elongated white circle / stadium pill with crisp dark border & black digits
        const ph = hh - 4;
        const py = y + 2;
        const rad = Math.floor(ph / 2);
        cv.roundRect(x - 1, py - 1, bw + 2, ph + 2, rad + 1, OUTLINE);
        cv.roundRect(x, py, bw, ph, rad, SHIELD_WHITE);
        cv.strokeRoundRect(x + 1, py + 1, bw - 2, ph - 2, Math.max(2, rad - 1), 1.5, SHIELD_INK);
        cv.text(num, Math.round(x + bw / 2), Math.round(py + ph - (hh <= 26 ? 5 : 7)), sz, SHIELD_INK, COPTS);
        return bw;
    }

    if (kind === 'eu_blue' || kind === 'eu_green') {
        const fill = kind === 'eu_green' ? SHIELD_GREEN : SHIELD_BLUE;
        cv.roundRect(x - 1, y - 1, bw + 2, hh + 2, 7, OUTLINE);
        cv.roundRect(x, y, bw, hh, 6, fill);
        cv.strokeRoundRect(x + 1, y + 1, bw - 2, hh - 2, 5, 1.5, SHIELD_WHITE);
        cv.text(num, Math.round(x + bw / 2), Math.round(y + hh - (hh <= 26 ? 6 : 7)), sz, SHIELD_WHITE, COPTS);
        return bw;
    }

    paintShieldScanlines(cv, x, y, bw, hh, kind);
    const textCol = kind === 'us' ? SHIELD_INK : SHIELD_WHITE;
    const textY = kind === 'interstate'
        ? Math.round(y + hh - (hh <= 26 ? 5 : 6))
        : Math.round(y + hh - (hh <= 26 ? 6 : 8));
    cv.text(num, Math.round(x + bw / 2), textY, sz, textCol, COPTS);
    return bw;
}

function drawHudRoadBanner(cv, m) {
    cv.clear([0, 0, 0, 0]);
    if (!m) return false;
    const badge = m.exitBadge ? foldAscii(m.exitBadge) : '';
    const shields = Array.isArray(m.shields) ? m.shields.filter((s) => s && s.num).slice(0, 2) : [];
    const road = m.road ? foldAscii(m.road) : '';
    if (!badge && !shields.length && !road) return false;

    const col = [242, 245, 250, 255];
    const gap = 8;
    const badgeW = badge ? measureExitBadge(cv, badge, 19) : 0;
    const shieldWs = shields.map((s) => measureRoadShield(cv, s, 32));
    let prefixW = 0;
    if (badgeW) prefixW += badgeW;
    for (let i = 0; i < shieldWs.length; i++) {
        if (prefixW > 0) prefixW += gap;
        prefixW += shieldWs[i];
    }
    const textGap = (prefixW > 0 && road) ? 10 : 0;
    const maxTextW = Math.max(40, cv.w - 12 - prefixW - textGap);

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
    const totW = prefixW + (rStr ? textGap + textW : 0);
    const navColCenter = Math.min(cv.w - 80, 412);
    const idealX = Math.round(navColCenter - totW / 2);
    let curX = Math.max(6, Math.min(cv.w - 6 - Math.round(totW), idealX));

    if (badge) {
        drawExitBadge(cv, badge, curX, 4, 30, 19);
        curX += badgeW + (shields.length || rStr ? gap : 0);
    }
    for (let i = 0; i < shields.length; i++) {
        drawRoadShield(cv, shields[i], curX, 3, 32);
        curX += shieldWs[i] + (i < shields.length - 1 ? gap : (rStr ? textGap : 0));
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
        const nextRow = (m.lanes && m.lanes.next && m.lanes.next.lanes && m.lanes.next.lanes.length > 0) ? m.lanes.next : null;
        const anim = (m.lanes && m.lanes.anim && typeof m.lanes.anim.t === 'number' && m.lanes.anim.t >= 0 && m.lanes.anim.t < 1)
            ? m.lanes.anim : null;
        const stackedLayout = Boolean(nextRow || anim);

        const topLaneCy = 152;
        const botLaneCy = stackedLayout ? (cv.h - 34) : (cv.h - 38);
        const animSingleBlend = (anim && !nextRow)
            ? (1 - Math.pow(1 - Math.max(0, Math.min(1, (anim.t - 0.15) / 0.85)), 3))
            : 0;
        const heroTop = hasInlineHeader ? 48 : 6;
        const stackedHeroBot = topLaneCy - 18;
        const singleHeroBot = (cv.h - 38) - 30;
        const heroBot = stackedLayout
            ? Math.round(stackedHeroBot + (singleHeroBot - stackedHeroBot) * animSingleBlend)
            : singleHeroBot;
        const arrowCx = 62;
        const arrowCy = Math.round((heroTop + heroBot) / 2);
        const stackedScale = hasInlineHeader ? 1.06 : 1.22;
        const singleScale = hasInlineHeader ? 1.28 : 1.48;
        const arrowScale = stackedLayout
            ? (stackedScale + (singleScale - stackedScale) * animSingleBlend)
            : singleScale;
        drawArrow(cv, m, arrowCx, arrowCy, arrowScale, col, dim);

        const rx = 126;
        const rMax = cv.w - rx - 6;
        if (rawDist) {
            let dSz = stackedLayout ? 44 : 48;
            let uSz = stackedLayout ? 22 : 24;
            let uW = unit ? cv.textWidth(unit, uSz, UOPTS) : 0;
            let dW = cv.textWidth(rawDist, dSz, DOPTS);
            if (dW + (uW ? 6 + uW : 0) > rMax) {
                dSz = stackedLayout ? 38 : 42;
                uSz = stackedLayout ? 20 : 22;
                uW = unit ? cv.textWidth(unit, uSz, UOPTS) : 0;
                dW = cv.textWidth(rawDist, dSz, DOPTS);
            }
            const inlineFits = dW + (uW ? 6 + uW : 0) <= rMax;
            if (inlineFits) {
                const dy = th ? (arrowCy - 8) : (arrowCy + 14);
                const drawnW = textOutline(cv, rawDist, rx, dy, dSz, col, DOPTS);
                if (unit) textOutline(cv, unit, rx + drawnW + 6, dy - 2, uSz, unitCol, UOPTS);
            } else {
                const dFit = fitAscii(cv, rawDist, 40, rMax, DOPTS);
                const dyTop = th ? (arrowCy - 16) : (arrowCy - 2);
                textOutline(cv, dFit, rx, dyTop, 40, col, DOPTS);
                if (unit) textOutline(cv, unit, rx, dyTop + 24, 21, unitCol, UOPTS);
            }
        }

        if (th) {
            const ty = arrowCy + (stackedLayout ? 34 : 40);
            const thenW = textOutline(cv, 'then', rx, ty, stackedLayout ? 18 : 19, unitCol, ROPTS);
            const ax = rx + thenW + 20;
            drawArrow(cv, th, ax, ty - 7, 0.42, col, dim);
            if (thGap) {
                const gFit = fitAscii(cv, thGap, stackedLayout ? 18 : 19, Math.max(24, cv.w - (ax + 18) - 4), ROPTS);
                if (gFit) textOutline(cv, gFit, ax + 18, ty, stackedLayout ? 18 : 19, col, ROPTS);
            }
        }

        if (anim) {
            const t = Math.max(0, Math.min(1, anim.t));
            const slideT = Math.max(0, Math.min(1, (t - 0.15) / 0.85));
            const ease = 1 - Math.pow(1 - slideT, 3); // smooth cubic ease-out after outgoing row clears

            // 1. Outgoing lower lane row swiftly fades & drops away over first 30% so promoted row never collides
            if (anim.droppedRow && t < 0.30) {
                const dFrac = t / 0.30;
                drawLaneRow(cv, anim.droppedRow, midX, botLaneCy + 16 * dFrac, col, dim, ACCENT_BLUE, {
                    maxW: cv.w - 16,
                    cellMaxW: 38,
                    h: 44,
                    kScale: 1.28,
                    alpha: (1 - dFrac) * 0.90,
                    underlineAlpha: (1 - dFrac),
                });
            }

            // 2. If a brand-new upper tier is queued behind the promoted row, fade & tuck it in smoothly
            if (nextRow && t > 0.44) {
                const nFrac = Math.min(1, (t - 0.44) / 0.52);
                drawLaneRow(cv, nextRow, midX, topLaneCy - 8 * (1 - nFrac), col, dim, ACCENT_BLUE, {
                    maxW: 204,
                    cellMaxW: 30,
                    h: 28,
                    kScale: 0.86,
                    alpha: 0.74 * nFrac,
                    isBack: true,
                    underlineAlpha: 0,
                });
            }

            // 3. Promoted lane row glides down and enlarges from upper tucked tier into primary foreground tier
            const tgtCy = nextRow ? botLaneCy : (cv.h - 38);
            const tgtH = nextRow ? 44 : LANE_H;
            const tgtCellW = nextRow ? 38 : LANE_W;
            drawLaneRow(cv, m.lanes, midX, topLaneCy + (tgtCy - topLaneCy) * ease, col, dim, ACCENT_BLUE, {
                maxW: 204 + ((cv.w - 16) - 204) * ease,
                cellMaxW: 30 + (tgtCellW - 30) * ease,
                h: 28 + (tgtH - 28) * ease,
                alpha: 0.74 + 0.26 * ease,
                isBack: ease < 0.20,
                underlineAlpha: Math.max(0, (ease - 0.20) / 0.80),
            });
        } else if (nextRow) {
            // Two-level stacked BMW lane guidance: compact dimmer upper row tucked behind larger primary lower row
            drawLaneRow(cv, nextRow, midX, topLaneCy, col, dim, ACCENT_BLUE, {
                maxW: 204,
                cellMaxW: 30,
                h: 28,
                kScale: 0.86,
                alpha: 0.74,
                isBack: true,
                underlineAlpha: 0,
            });
            const botW = drawLaneRow(cv, m.lanes, midX, botLaneCy, col, dim, ACCENT_BLUE, {
                maxW: cv.w - 16,
                cellMaxW: 38,
                h: 44,
                kScale: 1.28,
                alpha: 1,
                underlineAlpha: 1,
            });
            // Subtle crisp horizon bar separating foreground primary tier from tucked upper tier
            if (botW > 0) {
                const sepW = Math.min(cv.w - 12, Math.round(botW + 6));
                cv.fillRect(Math.round(midX - sepW / 2), Math.round(botLaneCy - 26), sepW, 2, [110, 148, 186, 130]);
            }
        } else {
            const lw = laneW(nL, cv.w - 16);
            const lx = Math.round((cv.w - nL * lw) / 2);
            drawLanes(cv, m.lanes, lx, botLaneCy, lw, col, dim, ACCENT_BLUE);
        }
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

function shieldsKey(m) {
    if (!m || !Array.isArray(m.shields) || !m.shields.length) return '';
    return m.shields.map((s) => (s.kind || '') + ':' + (s.num || '')).join(',');
}

function hudRoadKey(m) {
    if (!m) return '';
    return (m.exitBadge || '') + '|' + shieldsKey(m) + '|' + (m.road || '');
}

function laneKeyPart(row) {
    if (!row || !Array.isArray(row.lanes) || !row.lanes.length) return '';
    return row.lanes.map((l) => (l.hi ? '*' : '') + (l.follows || [l.follow]).join('+') + '/' + (l.others || []).join('+') + '/' + l.info).join(',') +
        '|' + (row.markers || []).join(',') + '|' + row.rec;
}

function hudNavKey(m) {
    if (!m) return '';
    const L = m.lanes && m.lanes.lanes
        ? laneKeyPart(m.lanes) +
            (m.lanes.next ? ('^' + laneKeyPart(m.lanes.next)) : '') +
            (m.lanes.anim && typeof m.lanes.anim.t === 'number' ? ('@' + Math.round(m.lanes.anim.t * 20)) : '')
        : '';
    const T = m.then
        ? [m.then.kind, m.then.dir, m.then.geom, m.then.exit, m.then.exitAngle, m.then.side, m.then.flag, m.then.stop, gapText(m.then.gap, m.unit, m.uk)].join('/')
        : '';
    return [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.side, m.flag, m.stop, m.dist, m.unit, m.exitBadge, shieldsKey(m), m.road, L, T].join('|');
}

module.exports = {
    NW,
    NH,
    ROAD_W,
    ROAD_H,
    drawHudRoadBanner,
    drawExitBadge,
    drawRoadShield,
    measureRoadShield,
    drawHudNav,
    hudRoadKey,
    hudNavKey,
    foldAscii,
    shapeOf,
    roundaboutGeom,
};
