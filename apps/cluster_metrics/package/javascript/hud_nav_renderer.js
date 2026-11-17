'use strict';
/**
 * hud_nav_renderer.js - Full-height vector turn-by-turn directions & lane guidance on the HUD.
 *
 * Adapted from cauliflowermossgrape/idrive7-apps (apps/redline/hud-nav.js, MIT) and scaled to
 * span the full vertical height of BMW's stock right-side HUD navigation slot:
 *   264x264 Canvas on the 800x480 HUD (x=412..676, y=108..372, clear of left-side ACC y=202..380):
 *   - Straight, slight / 90-deg / sharp turns, U-turns
 *   - Highway exits, entries, 2-way and 3-way forks (with un-taken branches dimmed)
 *   - Roundabouts with ring, travel arc, exit arrow, and exit number inside
 *   - Lane change arrows, destination checkered flag, stopover pin
 *   - Top street/exit banner (1-2 lines, always preserved), giant hero maneuver glyph,
 *     large distance + unit, "then" secondary maneuver, and full-width 6-lane guidance strip.
 *
 * Strict Node 8.16.2 (ES2017) & ASCII-only font glyphs.
 */

const { withAlpha, mix, rgba } = require('./kit/canvas');

const NW = 264;
const NH = 232;
const ROAD_W = 544;
const ROAD_H = 38;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const TURN_DIRECTIONS = [
    'STRAIGHT_ON', 'SLIGHT_LEFT', 'LEFT', 'HARD_LEFT', 'UTURN_LEFT',
    'SLIGHT_RIGHT', 'RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'NONE',
];

const SIDE = (d) => (/LEFT/.test(d) ? -1 : 1);
function turnDeg(d) { return /SLIGHT/.test(d) ? 45 : (/HARD|SHARP/.test(d) ? 135 : (/LEFT|RIGHT/.test(d) ? 90 : 0)); }

function turnPath(deg) {
    const a = deg * Math.PI / 180;
    if (deg === 0) return [[0, 36], [0, -36]];
    if (deg >= 135) return [[-15, 36], [-15, -22], [-15 + Math.sin(a) * 48, -22 - Math.cos(a) * 48]];
    if (deg === 90) return [[-13, 36], [-13, -4], [35, -4]];
    return [[0, 36], [0, 6], [Math.sin(a) * 38, 6 - Math.cos(a) * 38]];
}

function turnShape(dir) {
    const d = String(dir || '');
    if (d === 'NONE' || d === '') return { path: null, mir: 1 };
    const mir = SIDE(d);
    if (/UTURN|U_TURN/.test(d)) {
        const p = [[13, 36], [13, -8]];
        for (let i = 1; i <= 10; i++) {
            const a = i * Math.PI / 10;
            p.push([13 * Math.cos(a), -8 - 13 * Math.sin(a)]);
        }
        p.push([-13, 24]);
        return { path: p, mir: -mir };
    }
    return { path: turnPath(turnDeg(d)), mir: mir, round: 12 };
}

const HEAD_RUN = 28;
const DIM_END = -24;
const STEM = [[0, 36], [0, 10]];
const LEG = { left: [[0, 10], [-22, -8], [-22, -38]], right: [[0, 10], [22, -8], [22, -38]], center: [[0, 10], [0, -38]] };
const shortLeg = (leg, y) => leg.slice(0, -1).concat([[leg[leg.length - 1][0], y]]);

function forkOf(legs, take) {
    return {
        path: STEM.concat(LEG[take].slice(1)),
        dim: legs.filter((l) => l !== take).map((l) => shortLeg(LEG[l], DIM_END)),
        mir: 1,
    };
}

const EXIT_LEG = { right: [[0, 18], [8, 10], [22, -6], [22, -38]], left: [[0, 18], [-8, 10], [-22, -6], [-22, -38]] };
function exitOf(side, take) {
    const leg = EXIT_LEG[side];
    return take === 'exit'
        ? { path: [[0, 36]].concat(leg), dim: [[[0, 18], [0, DIM_END]]], mir: 1 }
        : { path: [[0, 36], [0, -38]], dim: [shortLeg(leg, DIM_END)], mir: 1 };
}

function exitForkOf(side, sub) {
    const sx = side === 'left' ? -1 : 1;
    const split = [sx * 15, 2];
    const leg = (t) => [split, [split[0] + (t === 'left' ? -11 : 11), -10], [split[0] + (t === 'left' ? -11 : 11), -38]];
    return {
        path: [[0, 36], [0, 22], [sx * 6, 16], split].concat(leg(sub).slice(1)),
        dim: [[[0, 22], [0, -6]], shortLeg(leg(sub === 'left' ? 'right' : 'left'), DIM_END)],
        mir: 1,
    };
}

function crossingOf(under) {
    return { path: [[0, 36], [0, -36]], dim: [[[-34, 0], [34, 0]]], mir: 1, cut: under ? [-9, -8, 18, 16] : null };
}

function geometryShape(g) {
    const s = String(g || '');
    let r = /^EXIT_(LEFT|RIGHT)_TAKE_(LEFT|RIGHT)$/.exec(s);
    if (r) return exitOf(r[1].toLowerCase(), r[1] === r[2] ? 'exit' : 'main');
    r = /^EXIT_(LEFT|RIGHT)_TWO_WAY_FORK_TAKE_(?:LEFT|RIGHT)_(LEFT|RIGHT)$/.exec(s);
    if (r) return exitForkOf(r[1].toLowerCase(), r[2].toLowerCase());
    r = /^THREE_WAY_FORK_.*TAKE_(LEFT|CENTER|RIGHT)$/.exec(s);
    if (r) return forkOf(['left', 'center', 'right'], r[1].toLowerCase());
    r = /^TWO_WAY_FORK_.*TAKE_(LEFT|RIGHT)$/.exec(s);
    if (r) return forkOf(['left', 'right'], r[1].toLowerCase());
    return null;
}

function branchOf(side) { return { path: STEM.concat(LEG[side].slice(1)), dim: [shortLeg(LEG.center, DIM_END)], mir: 1 }; }

function branchShape(d) {
    const side = /LEFT/.test(d) ? 'left' : 'right';
    if (/^HIGHWAY_IN/.test(d)) {
        if (/STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [[[-24, 36], [-6, 6]], [[24, 36], [6, 6]]], mir: 1 };
        return { path: [[-18, 36], [-18, 16], [2, -4], [2, -38]], dim: [[[22, 36], [22, -22]]], mir: SIDE(d) };
    }
    if (/^HIGHWAY_OUT/.test(d)) {
        if (/STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [shortLeg(LEG.left, DIM_END), shortLeg(LEG.right, DIM_END)], mir: 1 };
        return exitOf(side, 'exit');
    }
    if (/^TRIPLE_FORK/.test(d)) return forkOf(['left', 'center', 'right'], /STRAIGHT/.test(d) ? 'center' : side);
    if (/^FORK/.test(d)) return forkOf(['left', 'right'], side);
    if (d === 'OVERPASS' || d === 'UNDERPASS') return crossingOf(d === 'UNDERPASS');
    if (/^BRANCH_(LEFT|RIGHT)$/.test(d)) return branchOf(side);
    return { path: null, mir: 1 };
}

function agrees(sh, d) {
    const side = /LEFT/.test(d) ? -1 : (/RIGHT/.test(d) ? 1 : 0);
    if (!side) return true;
    const dx = (sh.path[sh.path.length - 1][0] - sh.path[0][0]) * sh.mir;
    return dx * side > 3;
}

function shapeOf(m) {
    if (!m) return { path: null, mir: 1 };
    const d = String(m.dir || '');
    const g = (m.kind === 'turn' || m.kind === 'branch') && m.geom ? geometryShape(m.geom) : null;
    if (g && agrees(g, d)) return g;
    switch (m.kind) {
    case 'turn': return turnShape(d);
    case 'keep': return d === 'LEFT' || d === 'RIGHT' ? branchOf(d === 'LEFT' ? 'left' : 'right') : { path: null, mir: 1 };
    case 'lanechange': return d === 'LEFT' || d === 'RIGHT' ? { path: [[-12, 36], [-12, 14], [12, -8], [12, -36]], dim: [[[-12, 14], [-12, -32]]], mir: SIDE(d) } : { path: null, mir: 1 };
    case 'branch': return branchShape(d);
    default: return { path: null, mir: 1 };
    }
}

function exitAngleOf(m) {
    if (isNum(m.exitAngle)) return ((360 - m.exitAngle) % 360 + 360) % 360;
    const n = isNum(m.exit) && m.exit > 0 ? m.exit : 2;
    if (n > 4) return 0;
    return m.side === 'left' ? ((90 - 90 * (n - 1)) % 360 + 360) % 360 : (270 + 90 * (n - 1)) % 360;
}

function strokePath(cv, pts, width, c) {
    if (!pts || pts.length < 2) return;
    const col = rgba(c);
    const hw = width / 2;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i++) {
        if (pts[i][0] < x0) x0 = pts[i][0];
        if (pts[i][0] > x1) x1 = pts[i][0];
        if (pts[i][1] < y0) y0 = pts[i][1];
        if (pts[i][1] > y1) y1 = pts[i][1];
    }
    x0 = Math.max(0, Math.floor(x0 - hw - 1));
    x1 = Math.min(cv.w, Math.ceil(x1 + hw + 1));
    y0 = Math.max(0, Math.floor(y0 - hw - 1));
    y1 = Math.min(cv.h, Math.ceil(y1 + hw + 1));
    for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
            let d2 = Infinity;
            for (let i = 1; i < pts.length; i++) {
                const xa = pts[i - 1][0], ya = pts[i - 1][1];
                const vx = pts[i][0] - xa, vy = pts[i][1] - ya;
                const qx = px + 0.5 - xa, qy = py + 0.5 - ya;
                const t = clamp01((qx * vx + qy * vy) / (vx * vx + vy * vy || 1));
                const ex = qx - vx * t, ey = qy - vy * t;
                const distSq = ex * ex + ey * ey;
                if (distSq < d2) d2 = distSq;
            }
            const cov = clamp01(hw - Math.sqrt(d2) + 0.5);
            if (cov > 0) cv._blend(px, py, col, cov);
        }
    }
}

function stroke(cv, pts, X, Y, w, c) {
    const P = pts.map((p) => [X(p), Y(p)]);
    if (cv.stroke) { cv.stroke(P, w, c); return; }
    if (cv._blend) { strokePath(cv, P, w, c); return; }
    for (let i = 1; i < P.length; i++) cv.line(P[i - 1][0], P[i - 1][1], P[i][0], P[i][1], w, c);
}

function rounded(path, r) {
    if (!r || path.length < 3) return path;
    const len = (a, b) => Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const A = path[i - 1], B = path[i], C = path[i + 1];
        const la = len(A, B), lc = len(B, C);
        const rr = Math.max(0, Math.min(r, la / 2, i === path.length - 2 ? lc - HEAD_RUN : lc / 2));
        if (rr < 1) { out.push(B); continue; }
        const P = [B[0] + (A[0] - B[0]) * rr / la, B[1] + (A[1] - B[1]) * rr / la];
        const Q = [B[0] + (C[0] - B[0]) * rr / lc, B[1] + (C[1] - B[1]) * rr / lc];
        for (let k = 0; k <= 8; k++) {
            const t = k / 8, u = 1 - t;
            out.push([u * u * P[0] + 2 * u * t * B[0] + t * t * Q[0], u * u * P[1] + 2 * u * t * B[1] + t * t * Q[1]]);
        }
    }
    out.push(path[path.length - 1]);
    return out;
}

function arrowPath(cv, path, X, Y, s, W, col) {
    const p = path.slice();
    const a = p[p.length - 2], b = p[p.length - 1];
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
    const l = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1;
    const ux = (bx - ax) / l, uy = (by - ay) / l;
    const L = 20 * s, HW = 15 * s;
    const back = Math.min(L * 0.7, l * 0.9) / l;
    p[p.length - 1] = [b[0] + (a[0] - b[0]) * back, b[1] + (a[1] - b[1]) * back];
    stroke(cv, p, X, Y, W, col);
    const qx = bx - ux * L, qy = by - uy * L;
    cv.triangle([[bx, by], [qx - uy * HW, qy + ux * HW], [qx + uy * HW, qy - ux * HW]], col);
}

const RB_IN = 42, RB_SHARP = 67, RB_MIN = 30, RB_BACK = 30, RB_R = 17, RB_SEEN = 10, RB_HEAD_S = 0.6, RB_FIT = 38;
function roundaboutPlan(m) {
    const dir = m.side === 'left' ? -1 : 1;
    const a = exitAngleOf(m);
    const d = ((dir > 0 ? a - 180 : 180 - a) % 360 + 360) % 360;
    if (d >= 360 - RB_BACK || d <= 10) return { dir: dir, tIn: RB_IN, tOut: 360 - RB_IN, back: true };
    if (d < RB_SHARP) return { dir: dir, tIn: -15, tOut: Math.max(d, RB_MIN - 15), back: false };
    return { dir: dir, tIn: RB_IN, tOut: Math.max(d, RB_IN + RB_MIN), back: false };
}

function roundaboutGeom(m) {
    const R = RB_R, OUT = R + 4, CAP = 4.5, HEAD = 20 * RB_HEAD_S;
    const P = roundaboutPlan(m);
    const ang = (t) => 180 + P.dir * t;
    const dirOf = (deg) => { const t = deg * Math.PI / 180; return [-Math.sin(t), -Math.cos(t)]; };
    const reach = OUT + RB_SEEN + HEAD;
    let c = [0, 3];
    if (!P.back) {
        const d = dirOf(ang(P.tOut));
        const over = Math.max(0, (c[0] * d[0] + c[1] * d[1]) + reach - RB_FIT);
        c = [c[0] - d[0] * over, c[1] - d[1] * over];
    }
    const pt = (deg, r) => { const d = dirOf(deg); return [c[0] + d[0] * r, c[1] + d[1] * r]; };
    const IN = pt(ang(P.tIn), R);
    const dx = IN[0] - c[0];
    const edgeY = c[1] + Math.sqrt(Math.max(0, OUT * OUT - dx * dx));
    const inEnd = edgeY + RB_SEEN - CAP;
    const path = [[IN[0], inEnd], IN];
    const n = Math.max(2, Math.ceil((P.tOut - P.tIn) / 12));
    for (let i = 1; i <= n; i++) path.push(pt(ang(P.tIn + (P.tOut - P.tIn) * i / n), R));
    const end = pt(ang(P.tOut), R);
    if (P.back) path.push([end[0], end[1] + 4], [end[0], inEnd]);
    else path.push(pt(ang(P.tOut), R + 5), pt(ang(P.tOut), reach));
    return { c: c, R: R, path: path };
}

function drawRoundabout(cv, m, cx, cy, s, col, dim) {
    const G = roundaboutGeom(m);
    const W = 9 * s;
    const X = (p) => cx + p[0] * s, Y = (p) => cy + p[1] * s;
    cv.arc(X(G.c), Y(G.c), (G.R - 4) * s, (G.R + 4) * s, 0, 360, dim);
    arrowPath(cv, G.path, X, Y, s * RB_HEAD_S, W, col);
    if (isNum(m.exit) && s >= 0.5) {
        cv.text(String(m.exit), Math.round(X(G.c)), Math.round(Y(G.c) + 6.5 * s), Math.round(18 * s), col, { align: 'center', font: 'bold', literal: true });
    }
}

function drawFlag(cv, m, cx, cy, s, col, dim) {
    const d = String(m.dir || '');
    const mir = /LEFT/.test(d) ? -1 : (/RIGHT/.test(d) ? 1 : 0);
    const px = cx - (mir || 1) * 10 * s;
    cv.line(px, cy + 26 * s, px, cy - 32 * s, 6 * s, col);
    const fw = 32 * s, fh = 24 * s, cw = fw / 4, ch = fh / 2;
    const x0 = mir < 0 ? px - fw : px, y0 = cy - 32 * s;
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 2; j++) {
            cv.fillRect(x0 + i * cw, y0 + j * ch, cw, ch, (i + j) % 2 ? dim : col);
        }
    }
    if (mir) cv.triangle([[cx + mir * 32 * s, cy + 30 * s], [cx + mir * 16 * s, cy + 20 * s], [cx + mir * 16 * s, cy + 40 * s]], col);
}

function drawStop(cv, m, cx, cy, s, col) {
    const r = 18 * s, py = cy - 10 * s;
    cv.circle(cx, py, r, col);
    cv.triangle([[cx - r * 0.75, py + r * 0.65], [cx + r * 0.75, py + r * 0.65], [cx, cy + 34 * s]], col);
    cv.circle(cx, py, r - 5 * s, [0, 0, 0, 255]);
    if (isNum(m.stop) && m.stop > 0) cv.text(String(m.stop), Math.round(cx), Math.round(py + 7 * s), Math.round(20 * s), col, { align: 'center', font: 'bold', literal: true });
}

function drawArrow(cv, m, cx, cy, s, col, dim) {
    if (!m) return;
    const W = 12 * s;
    if (m.kind === 'roundabout') { drawRoundabout(cv, m, cx, cy, s, col, dim); return; }
    if (m.kind === 'destination') {
        if (m.flag === false) drawStop(cv, m, cx, cy, s, col);
        else drawFlag(cv, m, cx, cy, s, col, dim);
        return;
    }
    const sh = shapeOf(m);
    if (!sh.path) {
        cv.circle(cx, cy, 10 * s, col);
        cv.arc(cx, cy, 17 * s, 21 * s, 0, 360, dim);
        return;
    }
    const X = (p) => cx + p[0] * sh.mir * s, Y = (p) => cy + p[1] * s;
    const dims = () => (sh.dim || []).forEach((p) => stroke(cv, p, X, Y, W * 0.8, dim));
    if (!sh.cut) dims();
    arrowPath(cv, rounded(sh.path, sh.round), X, Y, s, W, col);
    if (sh.cut) {
        cv.fillRect(cx + sh.cut[0] * s, cy + sh.cut[1] * s, sh.cut[2] * s, sh.cut[3] * s, [0, 0, 0, 255]);
        dims();
    }
}

const LANE_W = 40, LANE_H = 50, LANES_MAX = 6, LANE_S = 0.56;
const laneW = (n, maxW) => Math.min(LANE_W, maxW / Math.max(1, n));

function lanePath(dir) {
    const d = String(dir || ''), mir = SIDE(d);
    if (/UTURN|U_TURN/.test(d)) {
        const p = [[0, 36], [0, -12]];
        for (let i = 1; i <= 8; i++) {
            const a = Math.PI - i * Math.PI / 8;
            p.push([8 + 8 * Math.cos(a), -12 - 8 * Math.sin(a)]);
        }
        p.push([16, 6]);
        return { path: p, mir: mir, head: 0.7 };
    }
    const deg = turnDeg(d);
    if (deg === 0) return { path: [[0, 36], [0, -36]], mir: 1 };
    if (deg === 45) return { path: [[0, 36], [0, 4], [22, -22]], mir: mir, round: 6 };
    if (deg === 90) return { path: [[0, 36], [0, -4], [25, -4]], mir: mir, round: 7 };
    return { path: [[0, 36], [0, -12], [22, 10]], mir: mir, round: 5 };
}

function drawLaneArrows(cv, lane, cx, cy, k, col, dim) {
    const s = LANE_S * k, W = 9 * s;
    const one = (d, c) => {
        if (!d || d === 'NONE' || TURN_DIRECTIONS.indexOf(d) < 0) return;
        const g = lanePath(d);
        const X = (p) => cx + p[0] * g.mir * s, Y = (p) => cy + p[1] * s;
        arrowPath(cv, rounded(g.path, g.round), X, Y, s * 0.82 * (g.head || 1), W, c);
    };
    if (lane.info === 'ELLIPSIS') {
        [-7, 0, 7].forEach((dx) => cv.circle(cx + dx * k, cy, 1.8 * k, dim));
        return;
    }
    const follows = lane.follows || (lane.follow && lane.follow !== 'NONE' ? [lane.follow] : []);
    const blocked = lane.info === 'BLOCKED';
    (lane.others || []).forEach((d) => one(d, dim));
    follows.forEach((d) => one(d, lane.hi && !blocked ? col : dim));
    if (blocked) {
        const r = 7 * k;
        cv.line(cx - r, cy - r, cx + r, cy + r, 2.5 * k, dim);
        cv.line(cx - r, cy + r, cx + r, cy - r, 2.5 * k, dim);
    }
}

function laneWindow(L) {
    const n = L.lanes.length;
    if (n <= LANES_MAX) return L;
    const hi = [];
    L.lanes.forEach((l, i) => { if (l.hi) hi.push(i); });
    let mid;
    if (hi.length && hi[hi.length - 1] - hi[0] < LANES_MAX) mid = (hi[0] + hi[hi.length - 1]) / 2;
    else if (isNum(L.rec)) mid = hi.length ? hi.reduce((b, i) => (Math.abs(i - L.rec) < Math.abs(b - L.rec) ? i : b), hi[0]) : L.rec;
    else mid = hi.length ? hi[0] : (n - 1) / 2;
    const from = Math.max(0, Math.min(n - LANES_MAX, Math.round(mid - (LANES_MAX - 1) / 2)));
    return {
        lanes: L.lanes.slice(from, from + LANES_MAX),
        rec: L.rec,
        markers: (L.markers || []).slice(from, from + LANES_MAX + 1),
        cutL: from > 0,
        cutR: from + LANES_MAX < n,
    };
}

function drawLanes(cv, L, x, cy, w, col, dim, accent) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    const win = laneWindow(L);
    const n = Math.min(win.lanes.length, LANES_MAX), k = w / LANE_W, h = LANE_H, y0 = cy - h / 2;
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
        drawLaneArrows(cv, ln, x + (i + 0.5) * w, cy, Math.min(1, k), col, dim);
        if (ln.hi && ln.info !== 'BLOCKED') {
            cv.fillRect(Math.round(x + i * w + 4), Math.round(y0 + h + 3), Math.max(4, Math.round(w - 8)), 3, accent || col);
        }
    }
    if (win.cutL) { cv.circle(x - 5, cy - 5, 2, dim); cv.circle(x - 5, cy + 5, 2, dim); }
    if (win.cutR) { cv.circle(x + n * w + 5, cy - 5, 2, dim); cv.circle(x + n * w + 5, cy + 5, 2, dim); }
    return n * w;
}

const FOLD = {
    '\u00df': 'ss', '\u1e9e': 'SS', '\u00e6': 'ae', '\u00c6': 'AE',
    '\u00f8': 'o', '\u00d8': 'O', '\u0153': 'oe', '\u0152': 'OE',
    '\u0142': 'l', '\u0141': 'L', '\u0111': 'd', '\u0110': 'D', '\u0131': 'i',
};

function foldAscii(s) {
    let t = String(s || '')
        .replace(/[\u0000-\u001f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff\x7f]/g, '')
        .replace(/[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+/g, ' ');
    try { t = t.normalize('NFD'); } catch (e) { /* ignore */ }
    t = t.replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[^\x20-\x7e\u3000-\u9fff\uff00-\uffef]/g, (ch) => FOLD[ch] || '');
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

/**
 * Full-width top-row HUD road & highway exit banner (544x38 across HUD x=132..676, y=100..138).
 * Short street names center naturally over the right-side maneuver column (x=412 in banner => HUD x=544),
 * while long road names & highway exits expand leftward across the entire 544px width without cutting off!
 */
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

function gapText(gap, unit, uk) {
    if (gap === null || gap === undefined || !isFinite(gap)) return '';
    if (uk || unit === 'yd') return Math.max(10, Math.round(gap / 0.9144 / 10) * 10) + ' yd';
    return (unit === 'mi' || unit === 'ft')
        ? (Math.max(50, Math.round(gap / 0.3048 / 50) * 50) + ' ft')
        : (Math.max(10, Math.round(gap / 10) * 10) + ' m');
}

function drawHudNav(cv, m, opts) {
    cv.clear([0, 0, 0, 0]);
    if (!m) return null;
    const o = opts || {};
    const col = Array.isArray(o.color) ? [o.color[0], o.color[1], o.color[2], 255] : [242, 245, 250, 255];
    const dim = Array.isArray(o.color) ? mix('#000000', col, 0.46) : [94, 122, 154, 235];
    const unitCol = Array.isArray(o.color) ? withAlpha(col, 0.85) : SOFT_BLUE;

    const midX = Math.round(cv.w / 2);
    const maxRoadW = cv.w - 12;
    const unit = foldAscii(m.unit || '');
    const rawDist = foldAscii(m.dist || '');
    const nL = m.lanes && m.lanes.lanes ? laneWindow(m.lanes).lanes.length : 0;
    const th = m.then || null;
    const thGap = th ? gapText(th.gap, unit, m.uk) : '';

    // 1. Optional inline road/exit header (used when drawHudNav is rendered standalone without hud_road)
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

    // 2. Layout Branches across cv.h (232px below hud_road, or standalone):
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
