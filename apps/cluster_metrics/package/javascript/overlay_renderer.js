'use strict';
/**
 * overlay_renderer.js - manages ClusterRender layers across:
 *   - hud (800x480 on 0x323):
 *       * hud_road (132, 100, 544x38) : Full-width top-row road name + green highway exit square [14B],
 *         matching stock BMW HUD's full-width top street banner so long road names never clip.
 *       * hud_main (136, 100, 260x100): 3-line configurable upper-left telemetry (y=100..200, strictly above ACC y=202);
 *         automatically shifts into compact Row-2 layout (y=140..198) whenever `hud_road` occupies Row 1,
 *         and overlays cleanly on top of waze-on-cluster's HUD projection.
 *       * hud_nav  (412, 140, 264x232): Right-side vector turn-by-turn & 6-lane guidance
 *         (auto-yielding 0x323 ONLY when BMW HUD switches to an intersection mini-map, or hiding hud_nav over Waze HUD).
 *   - panel (1920x720 on slot 0x203, scene 0x010004f8): 5 outer zones + Right-Wing Media / Trip Widget
 *       1. below_speed  (392, 429, 214x84)  : Aligned under speed digits, clear of center map
 *       2. gear_d       (1463, 650, 74x56)  : White shift position 1..8 strictly right of GEAR_WIN (1380..1460)
 *       3. brake_rail   (1280, 609, 296x31) : 20-segment right-to-left DSC hydraulic brake bar (hidden in Park)
 *       4. corner_left  (8, 643, 116x66)    : Large Oil + Coolant temperatures (always visible)
 *       5. corner_right (1816, 643, 98x66)  : Large HV Battery % SoC (or Batt Temp / IAT / GBX / 12V)
 *       6. right_widget (1244, 214, 312x266): Re-implemented Right-Wing Widget (Full-color Album Art + Song +
 *          Progress Bar & Trip/Powertrain view, cycled with the left-stalk BC button).
 *   - map (1088x480 on 0x100, contend: 0): optional Map-Slot-Only mode over waze-on-cluster when user prefers
 *       KOMBI4's stock right-side BC widget.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const fs = require('fs');
const path = require('path');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client');
const { Canvas } = require('./kit/canvas');
const {
    formatTemp, formatEvEff, formatFuelEff, formatPress, formatPowerKw,
} = require('./units');
const {
    NW: HUD_NAV_W, NH: HUD_NAV_H, ROAD_W: HUD_ROAD_W, ROAD_H: HUD_ROAD_H,
    drawHudNav, drawHudRoadBanner, hudNavKey, hudRoadKey,
} = require('./hud_nav_renderer');
const { buildStockBackdrop } = require('./image_decode');
const { COVER_SIDE, paginateTitle, resolveRightWidgetPage } = require('./media_tracker');

const DEFAULT_CONF_DIR = '/var/opt/cluster-render';
const DEFAULT_WAZE_STATUS = '/run/waze-on-cluster/status.json';

// Shifted +16px down so there is generous breathing room under the main digital speed digits while clearing the traffic light sign (>=536)
const BELOW_SPEED_BASE = { x: 392, y: 445, w: 214, h: 84 };
// Snugly right of KOMBI4's single-letter 'D' (1400..1424; GEAR_WIN 1380..1426). Hidden in S/M where BMW renders S1..S8 natively.
const GEAR_D_BASE = { x: 1429, y: 650, w: 30, h: 56 };
// Sleek car-silhouette cabin temperature badge in the pocket between gear_d (1429..1459) and stock ambient temp (+57°F at 1540+)
const CABIN_TEMP_BASE = { x: 1458, y: 654, w: 74, h: 50 };
const BRAKE_RAIL_BASE = { x: 1280, y: 609, w: 296, h: 31 };
const CORNER_LEFT_BASE = { x: 8, y: 643, w: 116, h: 66 };
// Bottom-right corner readout below battery icon (12V SoC % by default now that PHEV HV SoC overlays the HV battery gauge)
const CORNER_RIGHT_BASE = { x: 1816, y: 646, w: 98, h: 66 };
// PHEV-only HV Battery SoC % overlay centered inside the dark pocket of the bottom-right HV battery sub-gauge (between 100 and 50)
const HV_SOC_GAUGE_BASE = { x: 1794, y: 482, w: 92, h: 58 };
// Right-Wing Gauge & Widget pocket (1252..1788, 88..604): full-wing gauge-edge artwork backdrop (no darkened border)
// with foreground cover & text centered at world x=1438 (cover 1366..1510, y=184..328)
const RIGHT_WIDGET_BASE = { x: 1252, y: 88, w: 536, h: 516 };

// Strictly y=100..200 (<= 202 Assisted Driving / ACC set-speed & green car keep-out)
const HUD_BASE = { x: 136, y: 100, w: 268, h: 100 };
// Dedicated Lead-Car Headway badge right above BMW's green ACC car (x=284..404 < 405 nav, y=139..180 > 138 road & well above Row 3 brake)
const HUD_HEADWAY_BASE = { x: 284, y: 139, w: 120, h: 41 };
// Full-width top-row street & highway exit badge banner (x=132..676 <= 680, y=100..138)
const HUD_ROAD_BASE = { x: 132, y: 100, w: HUD_ROAD_W, h: HUD_ROAD_H };
// Right-side HUD turn-by-turn arrow & lane guidance below road banner (x=412..676 <= 680, y=140..372 <= 380)
const HUD_NAV_BASE = { x: 412, y: 140, w: HUD_NAV_W, h: HUD_NAV_H };

// Slot 0x100 (1088x480 at world 416,120): borderless side-bottom readouts leaving center route x=368..680 100% clear
const MAP_SPEED_RECT = { x: 16, y: 325, w: 204, h: 84 };
const MAP_LEFT_RECT = { x: 186, y: 380, w: 182, h: 68 };
const MAP_RIGHT_RECT = { x: 680, y: 374, w: 228, h: 74 };

const CLUSTER_LAYER_NAMES = ['below_speed', 'gear_d', 'brake_rail', 'corner_left', 'corner_right'];
const PANEL_ALL_LAYERS = ['below_speed', 'gear_d', 'cabin_temp', 'brake_rail', 'corner_left', 'corner_right', 'hv_soc_gauge', 'right_widget'];
const MAP_LAYER_NAMES = ['map_speed', 'map_left', 'map_right'];

const COL = {
    clear: [0, 0, 0, 0],
    outline: [2, 6, 12, 242],
    shadow: [4, 8, 14, 224],
    white: '#f2f5fa',
    cyan: '#38c7ff',
    mediaCyan: '#45d6ff',
    icyBlue: '#5bc8ff',
    softBlue: '#9ec5eb',
    tagBlue: '#7fb8f0',
    tagGray: '#b4bcc6',
    mediaSub: '#cbd2dc',
    mediaTime: '#d4dbe4',
    amber: '#ffb347',
    orange: '#f97316',
    red: '#ef4444',
    dim: '#9ec5eb',
    label: '#7fb8f0',
    railDim: [48, 66, 90, 125],
    mapRailDim: [38, 62, 92, 185],
    progTrack: [36, 56, 78, 175],
    tileBg: [16, 28, 46, 235],
    tileRim: [68, 112, 160, 180],
    divider: [80, 125, 175, 105],
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function formatDuration(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const rs = r < 10 ? '0' + r : String(r);
    if (h > 0) return h + ':' + (m < 10 ? '0' + m : String(m)) + ':' + rs;
    return m + ':' + rs;
}

/**
 * Inspect /var/opt/cluster-render/cluster-render.conf + cluster-render.local.conf.
 */
function inspectClusterSlotConfig(confDir) {
    const dir = confDir || process.env.CLUSTER_RENDER_CONF_DIR || DEFAULT_CONF_DIR;
    const files = ['cluster-render.conf', 'cluster-render.local.conf'];
    let panelSlot = null;
    let sceneId = null;
    let foundLocal = false;

    for (let i = 0; i < files.length; i++) {
        const p = path.join(dir, files[i]);
        let txt = '';
        try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
        if (i === 1) foundLocal = true;
        const lines = txt.split(/\r?\n/);
        for (let k = 0; k < lines.length; k++) {
            const line = lines[k].replace(/#.*/, '').trim();
            if (!line) continue;
            const m = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(\S+)/);
            if (!m) continue;
            if (m[1] === 'panel_slot') panelSlot = m[2].toLowerCase();
            else if (m[1] === 'panel_scene_id') sceneId = m[2].toLowerCase();
        }
    }

    const resolvedSlot = panelSlot || '0x203';
    const conflictSlot = resolvedSlot === '0x202' || resolvedSlot === '0x201';
    const safe = resolvedSlot === '0x203' && !conflictSlot;
    return {
        safe,
        conflictSlot,
        foundLocal,
        panelSlot: panelSlot || '0x203 (default)',
        sceneId: sceneId || '0x010004f8',
    };
}

/**
 * Compute single bounding dirty rectangle between two equal-sized RGBA buffers.
 * Returns null if identical.
 */
function changes(was, now, w, h) {
    if (!was || was.length !== now.length) return { x: 0, y: 0, w, h };
    const row = w * 4;
    let top = 0;
    while (top < h && Buffer.compare(now.subarray(top * row, (top + 1) * row), was.subarray(top * row, (top + 1) * row)) === 0) top++;
    if (top === h) return null;
    let bot = h - 1;
    while (bot > top && Buffer.compare(now.subarray(bot * row, (bot + 1) * row), was.subarray(bot * row, (bot + 1) * row)) === 0) bot--;
    let left = w, right = -1;
    for (let y = top; y <= bot; y++) {
        const rStart = y * row;
        for (let x = 0; x < left; x++) {
            const o = rStart + x * 4;
            if (now[o] !== was[o] || now[o + 1] !== was[o + 1] || now[o + 2] !== was[o + 2] || now[o + 3] !== was[o + 3]) {
                left = x;
                break;
            }
        }
        for (let x = w - 1; x > right && x >= left; x--) {
            const o = rStart + x * 4;
            if (now[o] !== was[o] || now[o + 1] !== was[o + 1] || now[o + 2] !== was[o + 2] || now[o + 3] !== was[o + 3]) {
                right = x;
                break;
            }
        }
        if (left === 0 && right === w - 1) break;
    }
    if (right < left) return null;
    return { x: left, y: top, w: right - left + 1, h: bot - top + 1 };
}

function packRect(buf, iw, r) {
    const out = Buffer.allocUnsafe(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
        const srcOff = ((r.y + y) * iw + r.x) * 4;
        buf.copy(out, y * r.w * 4, srcOff, srcOff + r.w * 4);
    }
    return out;
}

function drawTextOutline(cv, str, x, y, size, color, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    const r = size >= 26 ? 2 : 1;
    cv.text(str, x - r, y, size, COL.outline, o);
    cv.text(str, x + r, y, size, COL.outline, o);
    cv.text(str, x, y - r, size, COL.outline, o);
    cv.text(str, x, y + r, size, COL.outline, o);
    cv.text(str, x - 1, y - 1, size, COL.outline, o);
    cv.text(str, x + 1, y - 1, size, COL.outline, o);
    cv.text(str, x - 1, y + 1, size, COL.outline, o);
    cv.text(str, x + 1, y + 1, size, COL.outline, o);
    return cv.text(str, x, y, size, color, o);
}

function fitTextLine(cv, str, maxW, sizes) {
    const clean = String(str || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return { text: '', size: sizes[0] };
    for (let i = 0; i < sizes.length; i++) {
        const sz = sizes[i];
        if (cv.textWidth(clean, sz, { font: 'bold', literal: true }) <= maxW) {
            return { text: clean, size: sz };
        }
    }
    const minSz = sizes[sizes.length - 1];
    const cps = Array.from(clean);
    while (cps.length > 3 && cv.textWidth(cps.join('').trim() + '...', minSz, { font: 'bold', literal: true }) > maxW) {
        cps.pop();
    }
    return { text: cps.join('').trim() + '...', size: minSz };
}

function paintRadialGlow(cv, cx, cy, radius, rgb, peakAlpha) {
    const r0 = rgb && typeof rgb[0] === 'number' ? rgb[0] : 56;
    const g0 = rgb && typeof rgb[1] === 'number' ? rgb[1] : 178;
    const b0 = rgb && typeof rgb[2] === 'number' ? rgb[2] : 246;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(cv.w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(cv.h - 1, Math.ceil(cy + radius));
    const invR = 1 / Math.max(1, radius);
    const d = cv.d;
    for (let y = y0; y <= y1; y++) {
        const dy = (y - cy) * invR;
        const dy2 = dy * dy;
        if (dy2 >= 1) continue;
        const rowOff = y * cv.w;
        for (let x = x0; x <= x1; x++) {
            const dx = (x - cx) * invR;
            const d2 = dx * dx + dy2;
            if (d2 >= 1) continue;
            const fall = 1 - d2;
            const a = Math.round(peakAlpha * fall * fall);
            if (a <= 0) continue;
            const o = (rowOff + x) * 4;
            d[o] = r0;
            d[o + 1] = g0;
            d[o + 2] = b0;
            d[o + 3] = a;
        }
    }
}

function fillSlantBar(cv, x0, y, w, h, fillW, col) {
    if (fillW <= 0) return;
    const rgba = Array.isArray(col) ? col : [69, 214, 255, 255];
    const [r, g, b, a] = [rgba[0], rgba[1], rgba[2], rgba[3] !== undefined ? rgba[3] : 255];
    const maxW = Math.min(w, Math.max(1, fillW));
    const d = cv.d;
    for (let row = 0; row < h; row++) {
        const py = y + row;
        if (py < 0 || py >= cv.h) continue;
        // BMW 45-degree slant on right end: upper rows extend slightly further right than lower rows
        const slant = Math.min(Math.max(0, h - 1 - row), w - 1);
        const rowEnd = Math.min(x0 + w, Math.max(x0 + 1, x0 + maxW - (h - 1 - row)));
        for (let px = x0; px < rowEnd; px++) {
            if (px < 0 || px >= cv.w) continue;
            const o = (py * cv.w + px) * 4;
            d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
        }
        // Subtle 1px dark outline at slant edge
        if (slant >= 0 && rowEnd >= x0 && rowEnd < cv.w) {
            const o = (py * cv.w + rowEnd) * 4;
            if (d[o + 3] < 220) {
                d[o] = 2; d[o + 1] = 6; d[o + 2] = 12; d[o + 3] = 220;
            }
        }
    }
}

function blitCoverArt(cv, ox, oy, cover, radius) {
    const side = cover.w;
    const src = cover.d;
    const dst = cv.d;
    const rad = radius || 10;
    for (let y = 0; y < side; y++) {
        const dy = y < rad ? (rad - 0.5 - y) : (y >= side - rad ? (y - (side - rad - 0.5)) : 0);
        const py = oy + y;
        if (py < 0 || py >= cv.h) continue;
        for (let x = 0; x < side; x++) {
            const dx = x < rad ? (rad - 0.5 - x) : (x >= side - rad ? (x - (side - rad - 0.5)) : 0);
            let cov = 1;
            if (dx > 0 && dy > 0) {
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist >= rad + 0.5) continue;
                if (dist > rad - 0.5) cov = rad + 0.5 - dist;
            }
            const px = ox + x;
            if (px < 0 || px >= cv.w) continue;
            const so = (y * side + x) * 4;
            const sa = Math.round(src[so + 3] * cov);
            if (sa <= 0) continue;
            const doff = (py * cv.w + px) * 4;
            if (sa >= 254) {
                dst[doff] = src[so];
                dst[doff + 1] = src[so + 1];
                dst[doff + 2] = src[so + 2];
                dst[doff + 3] = 255;
            } else {
                const inv = 255 - sa;
                const da = dst[doff + 3];
                const outA = sa + Math.round((da * inv) / 255);
                if (outA > 0) {
                    dst[doff] = Math.round((src[so] * sa + ((dst[doff] * da * inv) / 255)) / outA);
                    dst[doff + 1] = Math.round((src[so + 1] * sa + ((dst[doff + 1] * da * inv) / 255)) / outA);
                    dst[doff + 2] = Math.round((src[so + 2] * sa + ((dst[doff + 2] * da * inv) / 255)) / outA);
                    dst[doff + 3] = outA;
                }
            }
        }
    }
    cv.strokeRoundRect(ox, oy, side, side, rad, 1, [255, 255, 255, 52]);
}

function resolveCornerRightMode(settingVal, profile, t, hvSocGaugeOn) {
    const mode = settingVal || 'auto';
    if (mode === 'off') return 'off';
    if (mode !== 'auto') return mode;
    const isPhev = Boolean((profile && profile.vehicleType === 'phev') ||
        typeof (t && t.soc) === 'number' ||
        typeof (t && t.battTempC) === 'number');
    // Now that PHEV HV Battery % overlays the HV battery gauge by default, bottom-right auto-selects 12V % (or 12V V)
    if (t && typeof t.soc12 === 'number' && isFinite(t.soc12)) return 'soc12';
    if (t && typeof t.v12 === 'number' && isFinite(t.v12)) return 'v12';
    if (isPhev) {
        if (hvSocGaugeOn === false) return 'soc';
        if (t && typeof t.battTempC === 'number' && isFinite(t.battTempC)) return 'batt';
        return 'soc12';
    }
    return 'iat';
}

function formatCornerRightMetric(t, units, mode) {
    let tag = '12V';
    let valText = '--';
    let col = COL.dim;

    if (mode === 'soc12') {
        tag = '12V';
        if (typeof t.soc12 === 'number' && isFinite(t.soc12)) {
            const pct12 = clamp(Math.round(t.soc12), 0, 100);
            valText = pct12 + '%';
            col = pct12 < 40 ? COL.red : (pct12 < 55 ? COL.amber : COL.white);
        } else {
            valText = '--%';
        }
    } else if (mode === 'soc') {
        tag = 'SOC';
        if (typeof t.soc === 'number' && isFinite(t.soc)) {
            const pct = clamp(Math.round(t.soc), 0, 100);
            valText = pct + '%';
            col = pct <= 10 ? COL.red : (pct <= 20 ? COL.amber : COL.white);
        } else {
            valText = '--%';
        }
    } else if (mode === 'batt') {
        tag = 'BAT';
        valText = formatTemp(t.battTempC, units).text;
        if (typeof t.battTempC === 'number') {
            col = t.battTempC < 18 ? COL.icyBlue
                : t.battTempC > 32 ? (t.battTempC >= 40 ? COL.red : COL.amber)
                : COL.white;
        }
    } else if (mode === 'gbx') {
        tag = 'GBX';
        valText = formatTemp(t.gearboxOilC, units).text;
        col = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.white;
    } else if (mode === 'v12') {
        tag = '12V';
        valText = (typeof t.v12 === 'number' && isFinite(t.v12)) ? (t.v12.toFixed(1) + 'V') : '--';
        col = (typeof t.v12 === 'number' && t.v12 < 12.1) ? COL.amber : COL.white;
    } else {
        tag = 'IAT';
        valText = formatTemp(t.iatC, units).text;
        col = COL.white;
    }
    return { tag, valText, col };
}

function formatLeadHeadwayParts(lead, units, mode) {
    if (!lead || !lead.active || typeof lead.gapM !== 'number' || !isFinite(lead.gapM)) return null;
    const isMi = units && units.distUnit === 'mi';
    const isMph = units && units.speedUnit === 'mph';
    let distStr;
    if (isMi) {
        const ft = Math.round(lead.gapM * 3.28084);
        distStr = ft >= 528 ? ((lead.gapM * 0.000621371).toFixed(1) + ' mi') : (ft + ' ft');
    } else {
        distStr = lead.gapM < 10 ? (lead.gapM.toFixed(1) + ' m') : (Math.round(lead.gapM) + ' m');
    }

    const hasHw = typeof lead.headwaySec === 'number' && isFinite(lead.headwaySec);
    const primaryStr = hasHw ? (lead.headwaySec.toFixed(1) + 's') : distStr;
    const primaryCol = hasHw
        ? (lead.headwaySec < 1.0 ? COL.red : (lead.headwaySec < 1.5 ? COL.amber : COL.cyan))
        : (lead.gapM < 3.0 ? COL.amber : COL.cyan);
    const secDistStr = hasHw ? distStr : '';

    let deltaStr = '';
    let deltaCol = COL.softBlue;
    if (mode === 'full' && typeof lead.relSpeedKmh === 'number' && isFinite(lead.relSpeedKmh)) {
        const rv = Math.round(isMph ? lead.relSpeedKmh * 0.621371 : lead.relSpeedKmh);
        const dead = isMph ? 2 : 3;
        if (Math.abs(rv) >= dead) {
            deltaStr = (rv > 0 ? '+' : '') + rv + (isMph ? ' mph' : ' km/h');
            deltaCol = rv <= (isMph ? -10 : -16) ? COL.red : (rv < 0 ? COL.amber : COL.softBlue);
        }
    }
    return { primaryStr, primaryCol, secDistStr, deltaStr, deltaCol, distStr };
}

class OverlayRenderer {
    constructor(opts) {
        const o = opts || {};
        this.log = o.log || { info: () => {}, warn: () => {}, error: () => {} };
        this.socketPath = o.socketPath || process.env.CLUSTER_METRICS_SOCKET || process.env.HUD_CLUSTER_SOCKET || DEFAULT_PATH;
        this.confDir = o.confDir || process.env.CLUSTER_RENDER_CONF_DIR || DEFAULT_CONF_DIR;
        this.wazeStatusPath = o.wazeStatusPath || process.env.WAZE_STATUS_PATH || DEFAULT_WAZE_STATUS;
        this.ClusterRenderCtor = o.ClusterRender || ClusterRender;
        this.isBench = Boolean(o.allowPanel || process.env.CLUSTER_METRICS_BENCH === '1');
        this.cr = null;
        this.connected = false;
        this.ready = false;
        this.targets = '';
        this.layers = {}; // name -> { ref, target, rect, cv, prevBuf, visible }
        this.refused = [];
        this.wazeShowing = false;
        this.lastWazeCheck = 0;
        this.slotStatus = inspectClusterSlotConfig(this.confDir);
        this.bytesSent = 0;
        this.lastHudNavKey = '';
        this.lastHudRoadKey = '';
        this.lastRightWidgetKey = '';
        this.lastSummary = {};
    }

    canUsePanel() {
        return this.isBench || this.slotStatus.safe;
    }

    pixelBytesTotal() {
        let sum = 0;
        const keys = Object.keys(this.layers);
        for (let i = 0; i < keys.length; i++) {
            const r = this.layers[keys[i]].rect;
            sum += r.w * r.h * 8; // Compositor counts image layers 2x RGBA
        }
        return sum;
    }

    layerCount() {
        return Object.keys(this.layers).length;
    }

    _readWazeStatus(nowMs) {
        if (nowMs - this.lastWazeCheck < 500) return this.wazeShowing;
        this.lastWazeCheck = nowMs;
        try {
            const st = JSON.parse(fs.readFileSync(this.wazeStatusPath, 'utf8'));
            this.wazeShowing = Boolean(st && st.state === 'showing' && st.target === 'map');
        } catch (e) {
            this.wazeShowing = false;
        }
        return this.wazeShowing;
    }

    _ensureLayer(name, opts) {
        const existing = this.layers[name];
        if (existing) {
            if (existing.rect.x !== opts.x || existing.rect.y !== opts.y) {
                existing.rect.x = opts.x;
                existing.rect.y = opts.y;
                if (this.cr) this.cr.set(existing.ref, { x: opts.x, y: opts.y });
            }
            return existing;
        }
        if (!this.cr) return null;
        const ref = this.cr.image({
            target: opts.target,
            klass: opts.klass || 'overlay',
            z: opts.z || 10,
            x: opts.x,
            y: opts.y,
            w: opts.w,
            h: opts.h,
            iw: opts.w,
            ih: opts.h,
            visible: opts.visible !== false,
            contend: opts.contend !== undefined ? opts.contend : true,
        });
        if (!ref) return null;
        const entry = {
            ref,
            target: opts.target,
            rect: { x: opts.x, y: opts.y, w: opts.w, h: opts.h },
            cv: new Canvas(opts.w, opts.h),
            prevBuf: null,
            visible: opts.visible !== false,
        };
        this.layers[name] = entry;
        return entry;
    }

    _setVisible(name, vis) {
        const l = this.layers[name];
        if (!l) return;
        if (l.visible !== vis) {
            l.visible = vis;
            if (this.cr) this.cr.set(l.ref, { visible: vis });
        }
    }

    _upload(name, forceWhole) {
        const l = this.layers[name];
        if (!l || !this.cr) return;
        const nowBuf = Buffer.from(l.cv.d.buffer, l.cv.d.byteOffset, l.cv.d.length);
        if (forceWhole || !l.prevBuf) {
            this.cr.pixels(l.ref, null, nowBuf);
            l.prevBuf = Buffer.from(nowBuf);
            this.bytesSent += nowBuf.length;
            return;
        }
        const rect = changes(l.prevBuf, nowBuf, l.rect.w, l.rect.h);
        if (!rect) return;
        const areaFrac = (rect.w * rect.h) / (l.rect.w * l.rect.h);
        if (areaFrac > 0.72) {
            this.cr.pixels(l.ref, null, nowBuf);
            this.bytesSent += nowBuf.length;
        } else {
            const packed = packRect(nowBuf, l.rect.w, rect);
            this.cr.pixels(l.ref, [rect], packed);
            this.bytesSent += packed.length;
        }
        nowBuf.copy(l.prevBuf);
    }

    connect() {
        if (this.cr) return;
        const cr = new this.ClusterRenderCtor('cluster_metrics', this.socketPath);
        this.cr = cr;
        cr.on('ready', () => {
            this.ready = true;
            this.connected = true;
            this.targets = cr.targets || '';
            const keys = Object.keys(this.layers);
            for (let i = 0; i < keys.length; i++) {
                this.layers[keys[i]].prevBuf = null;
            }
            this.log.info('cluster-render ready (panelSlot=' + this.slotStatus.panelSlot + ', canPanel=' + this.canUsePanel() + ')');
        });
        cr.on('disconnected', () => {
            this.ready = false;
            this.connected = false;
        });
        cr.on('refused', (op, ref, reason) => {
            const msg = op + ' ref=' + ref + ': ' + reason;
            if (this.refused.length < 16) this.refused.push(msg);
            this.log.warn('cluster-render refused ' + msg);
        });
        cr.connect();
    }

    /**
     * Draw all enabled zones offscreen into Canvases and upload changed regions to cluster-render.
     * Safe to invoke headlessly in unit tests (when connect() hasn't been called).
     */
    render(model, settingsObj, nowMs) {
        const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
        const s = settingsObj || {};
        this.slotStatus = inspectClusterSlotConfig(this.confDir);
        const enabled = s.enabled !== false;
        const targetPref = s.displayTarget || 'both';
        const wantHud = enabled && (targetPref === 'both' || targetPref === 'hud');
        const wantCluster = enabled && (targetPref === 'both' || targetPref === 'cluster');
        const wazeOn = this._readWazeStatus(now);

        const units = model.units;
        const profile = model.profile;
        const t = model.telemetry || {};
        const eff = model.efficiency || {};

        // Consistent Cluster Display Mode ('auto' removed):
        //   - 'panel_only' (default): always render all 5 outer zones + re-implemented Right-Wing Widget on 0x203
        //     whether CarPlay/Waze or BMW Map is active (falls back to 'map' only if 0x202 conflict is present).
        //   - 'map_only': never map 0x203 (leaves KOMBI4's native BC widget active); render on 'map' when wazeOn.
        const rawSlotMode = s.clusterSlotMode || 'panel_only';
        const clusterSlotMode = rawSlotMode === 'map_only' ? 'map_only' : 'panel_only';
        const canPanel = this.canUsePanel();
        let panelAllowed = false;
        let showMapOverlay = false;
        if (wantCluster) {
            if (clusterSlotMode === 'map_only') {
                showMapOverlay = wazeOn;
            } else {
                panelAllowed = canPanel;
                showMapOverlay = !canPanel && s.fallbackMapBar !== false && wazeOn;
            }
        }

        // HUD navigation re-rendering & intersection mini-map auto-yield:
        const hudNavMode = s.hudNavMode || 'own_nav_minimap';
        const hn = t.hudNav || null;
        const wocHudOn = Boolean(hn && hn.wocHudShowing);
        const miniMapOn = Boolean(hn && hn.miniMapActive);
        const fallbackNavOn = Boolean(hn && hn.noTurnFallback);
        const routeOn = Boolean((hn && hn.routeActive) || t.navRouteActive);
        const lanesOn = Boolean((hn && hn.hasLanes) || t.navHasLanes);

        let hudYieldedToNav = false;
        let hudYieldReason = '';
        if (hudNavMode === 'yield_route') {
            hudYieldedToNav = routeOn || wocHudOn;
            hudYieldReason = wocHudOn ? 'waze_hud' : (routeOn ? 'route' : '');
        } else if (!wocHudOn && hudNavMode === 'own_nav_minimap') {
            hudYieldedToNav = miniMapOn || fallbackNavOn;
            hudYieldReason = miniMapOn ? (hn.miniMapReason || 'minimap') : (fallbackNavOn ? 'bmw_nav_fallback' : '');
        } else if (!wocHudOn && hudNavMode === 'yield_lanes') {
            hudYieldedToNav = lanesOn || miniMapOn || fallbackNavOn;
            hudYieldReason = miniMapOn ? (hn.miniMapReason || 'minimap') : (lanesOn ? 'lanes' : (fallbackNavOn ? 'bmw_nav_fallback' : ''));
        }
        const showHud = wantHud && !hudYieldedToNav;
        const showOwnHudNav = showHud && !wocHudOn && hudNavMode !== 'yield_route' && hudNavMode !== 'keep' &&
            Boolean(hn && hn.show);
        // Full-width top-row street & highway exit badge banner when active maneuver has a street or exit number
        const showHudRoad = Boolean(showOwnHudNav && hn && hn.show &&
            ((hn.show.road && hn.show.road.length > 0) || (hn.show.exitBadge && hn.show.exitBadge.length > 0)));
        const wocHudOverlay = Boolean(showHud && wocHudOn);

        const hx = clamp(Number(s.hudNudgeX) || 0, -40, 40);
        const hy = clamp(Number(s.hudNudgeY) || 0, -40, 40);
        const cx = clamp(Number(s.clusterNudgeX) || 0, -12, 12);
        const cy = clamp(Number(s.clusterNudgeY) || 0, -12, 12);

        const gearDisplay = s.gearDisplay === 'left_of_speed' ? 'below_speed' : (s.gearDisplay || 'next_to_d');
        const brakeMode = s.brakeIndicator || 'bar_num';
        const cornerLeftMode = s.cornerLeftDisplay || 'oil_cool';
        const hvSocGaugeEnabled = s.hvSocGauge !== false;
        const cabinTempEnabled = s.cabinTempDisplay !== false;
        const cornerRightMode = resolveCornerRightMode(s.cornerRightDisplay, profile, t, hvSocGaugeEnabled);
        const rightWidgetMode = s.rightWidgetMode || (((s.widgetMedia !== false ? 'M' : '') + (s.widgetTrip !== false ? 'T' : '')) || 'off');
        const hudHeadwayMode = s.hudHeadway || 'full';
        const hudLine1 = s.hudLine1 || 'efficiency_gear';
        const hudLine2 = s.hudLine2 || 'power';
        const hudLine3 = s.hudLine3 || 'brake';

        const chg = t.charging || null;
        const isCharging = Boolean(chg && chg.active);

        // Resolve active Right-Wing Widget page ('charging' locked on charge | 'media' | 'trip' | 'off')
        const media = t.media || null;
        const rightWidgetPage = panelAllowed ? resolveRightWidgetPage(s, media, isCharging) : 'off';

        let hero;
        let heroCol;
        let subText = '';
        let subCol = COL.softBlue;

        if (isCharging) {
            hero = {
                value: (typeof chg.chargeKw === 'number' && isFinite(chg.chargeKw)) ? chg.chargeKw.toFixed(1) : '--',
                unit: 'kW',
            };
            heroCol = COL.cyan;
            subText = chg.maxAmps ? ('CHARGING ' + Math.round(chg.maxAmps) + 'A') : 'CHARGING';
            subCol = COL.softBlue;
        } else {
            hero = profile.isEv
                ? formatEvEff(eff.evKmPerKwh, units)
                : formatFuelEff(eff.fuelLPer100km, eff.isDfco, units);
            heroCol = profile.mode === 'ev_regen' ? COL.cyan
                : profile.isEv ? COL.white
                : (eff.isDfco ? COL.cyan : (profile.isCold ? COL.icyBlue : COL.white));

            if (profile.isEv) {
                const pFmt = formatPowerKw(t.hvKw);
                subText = pFmt.text;
                subCol = (t.hvKw !== null && t.hvKw > 55) ? COL.amber : COL.cyan;
            } else if (profile.isCold && profile.coldCeilingRpm) {
                subText = '<' + (profile.coldCeilingRpm / 1000).toFixed(1) + 'k RPM';
                subCol = COL.icyBlue;
            } else if (typeof t.boostBar === 'number' && isFinite(t.boostBar)) {
                const bFmt = formatPress(t.boostBar, true, units);
                subText = bFmt.text;
                subCol = t.boostBar > 0.8 ? COL.amber : COL.cyan;
            } else {
                subText = (t.rpm ? Math.round(t.rpm) + ' rpm' : '--');
            }
        }

        const inNormalD = t.stage === 'D' && t.program !== 'S' && t.program !== 'M' &&
            typeof t.gear === 'number' && t.gear >= 1 && t.gear <= 8;
        const dGearText = inNormalD ? ('D' + Math.round(t.gear)) : '';
        const isParked = t.stage === 'P' || (
            !t.stage &&
            (t.speedKmh === null || t.speedKmh === undefined || t.speedKmh < 0.5) &&
            !(typeof t.gear === 'number' && t.gear !== 0)
        );
        const fg = typeof t.frictionG === 'number' && isFinite(t.frictionG) ? Math.max(0, t.frictionG) : 0;
        const brakeHold = !isParked && Boolean(t.brakeHold) && fg <= 0.02;
        const brakeLit = (!isParked && fg > 0.02) ? clamp(Math.round((fg / 0.55) * 20), 1, 20) : (brakeHold ? 1 : 0);
        const showBrakeRail = brakeMode !== 'off' && !isParked;

        const showHvSocGauge = Boolean(
            panelAllowed &&
            hvSocGaugeEnabled &&
            profile && profile.vehicleType === 'phev' &&
            typeof t.soc === 'number' && isFinite(t.soc)
        );
        const showCabinTemp = Boolean(
            panelAllowed &&
            cabinTempEnabled &&
            typeof t.cabinTempC === 'number' && isFinite(t.cabinTempC)
        );
        const showHudHeadway = Boolean(
            showHud &&
            hudHeadwayMode !== 'off' &&
            t.leadVehicle && t.leadVehicle.active
        );

        this.lastSummary = {
            hero, heroCol, subText, subCol, inNormalD, dGearText,
            isParked, isCharging, showBrakeRail, brakeHold,
            panelAllowed, showHud, showOwnHudNav, showHudRoad, showHudHeadway, hudHeadwayMode,
            showHvSocGauge, showCabinTemp,
            wocHudOverlay, hudYieldedToNav, hudYieldReason,
            showFallbackMap: showMapOverlay, showMapOverlay, clusterSlotMode,
            rightWidgetMode, rightWidgetPage,
            brakeMode, brakeLit, frictionG: fg, brakeBar: t.brakeBar,
            cornerLeftMode, cornerRightMode,
            hudLine1, hudLine2, hudLine3,
        };

        // 1. CLUSTER PANEL LAYERS (slot 0x203)
        if (panelAllowed) {
            // 1a. Zone 1: Below Speed Indicator (392..606, 445..529; clear gap under speed & above traffic light sign)
            const bsRect = {
                x: clamp(BELOW_SPEED_BASE.x + cx, 387, 412),
                y: clamp(BELOW_SPEED_BASE.y + cy, 433, 452),
                w: BELOW_SPEED_BASE.w,
                h: BELOW_SPEED_BASE.h,
            };
            const lBs = this._ensureOrLocal('below_speed', Object.assign({ target: 'panel', visible: true, z: 12 }, bsRect));
            this._paintBelowSpeed(lBs.cv, hero, heroCol, subText, subCol, gearDisplay === 'below_speed' ? dGearText : '', gearDisplay === 'below_speed', 108);
            this._setVisible('below_speed', true);
            this._upload('below_speed');

            // 1b. Zone 2: Shift Position Snugly Next to Stock 'D' (1429..1459, 650..706; strictly x >= 1427 clear of GEAR_WIN)
            const gdRect = {
                x: clamp(GEAR_D_BASE.x + cx, 1427, 1435),
                y: clamp(GEAR_D_BASE.y + cy, 648, 654),
                w: GEAR_D_BASE.w,
                h: GEAR_D_BASE.h,
            };
            const lGd = this._ensureOrLocal('gear_d', Object.assign({ target: 'panel', visible: false, z: 14 }, gdRect));
            const showGearDigit = gearDisplay === 'next_to_d' && inNormalD;
            const alertObj = s.smartAlerts !== false ? profile.alert : null;
            if (showGearDigit) {
                this._paintGearNextToD(lGd.cv, String(Math.round(t.gear)));
                this._setVisible('gear_d', true);
                this._upload('gear_d');
            } else {
                this._setVisible('gear_d', false);
            }

            // 1b2. Cabin Temperature Badge Left of Ambient Temp (1458..1532, 654..704; car-silhouette enclosure)
            if (showCabinTemp) {
                const ctRect = {
                    x: clamp(CABIN_TEMP_BASE.x + cx, 1457, 1463),
                    y: clamp(CABIN_TEMP_BASE.y + cy, 650, 658),
                    w: CABIN_TEMP_BASE.w,
                    h: CABIN_TEMP_BASE.h,
                };
                const lCt = this._ensureOrLocal('cabin_temp', Object.assign({ target: 'panel', visible: true, z: 14 }, ctRect));
                this._paintCabinTemp(lCt.cv, t.cabinTempC, units);
                this._setVisible('cabin_temp', true);
                this._upload('cabin_temp');
            } else {
                this._setVisible('cabin_temp', false);
            }

            // 1c. Zone 3: Slim Friction Brake Force Rail + Passive Anomaly Alert (1280..1576, 609..640; hidden in Park unless alert)
            const brRect = {
                x: clamp(BRAKE_RAIL_BASE.x + cx, 1276, 1288),
                y: clamp(BRAKE_RAIL_BASE.y + cy, 599, 617),
                w: BRAKE_RAIL_BASE.w,
                h: BRAKE_RAIL_BASE.h,
            };
            const showBrakeOrAlert = Boolean(showBrakeRail || (alertObj && alertObj.label));
            const lBr = this._ensureOrLocal('brake_rail', Object.assign({ target: 'panel', visible: showBrakeOrAlert, z: 13 }, brRect));
            if (showBrakeOrAlert) {
                this._paintBrakeRail(lBr.cv, fg, brakeLit, Boolean(t.absActive), brakeMode === 'bar_num' && !brakeHold, t.brakeBar, alertObj, showBrakeRail);
                this._setVisible('brake_rail', true);
                this._upload('brake_rail');
            } else {
                this._setVisible('brake_rail', false);
            }

            // 1d. Zone 4: Bottom-Left Oil + Coolant Temperatures (8..124, 643..709)
            const clRect = {
                x: clamp(CORNER_LEFT_BASE.x + cx, 6, 9),
                y: clamp(CORNER_LEFT_BASE.y + cy, 643, 648),
                w: CORNER_LEFT_BASE.w,
                h: CORNER_LEFT_BASE.h,
            };
            const lCl = this._ensureOrLocal('corner_left', Object.assign({ target: 'panel', visible: cornerLeftMode !== 'off', z: 12 }, clRect));
            if (cornerLeftMode !== 'off') {
                this._paintCornerLeft(lCl.cv, t, units, cornerLeftMode, Number(s.coldOilC) || 75);
                this._setVisible('corner_left', true);
                this._upload('corner_left');
            } else {
                this._setVisible('corner_left', false);
            }

            // 1e. Zone 5: Bottom-Right 12V Battery % / Vital (1816..1914, 646..712; separated from battery icon)
            const crRect = {
                x: clamp(CORNER_RIGHT_BASE.x + cx, 1815, 1820),
                y: clamp(CORNER_RIGHT_BASE.y + cy, 644, 651),
                w: CORNER_RIGHT_BASE.w,
                h: CORNER_RIGHT_BASE.h,
            };
            const lCr = this._ensureOrLocal('corner_right', Object.assign({ target: 'panel', visible: cornerRightMode !== 'off', z: 12 }, crRect));
            if (cornerRightMode !== 'off') {
                this._paintCornerRight(lCr.cv, t, units, cornerRightMode);
                this._setVisible('corner_right', true);
                this._upload('corner_right');
            } else {
                this._setVisible('corner_right', false);
            }

            // 1e2. PHEV HV Battery SoC % Overlay Inside HV Battery Sub-Gauge (1794..1886, 482..540; PHEV only)
            if (showHvSocGauge) {
                const hgRect = {
                    x: clamp(HV_SOC_GAUGE_BASE.x + cx, 1786, 1802),
                    y: clamp(HV_SOC_GAUGE_BASE.y + cy, 476, 488),
                    w: HV_SOC_GAUGE_BASE.w,
                    h: HV_SOC_GAUGE_BASE.h,
                };
                const lHg = this._ensureOrLocal('hv_soc_gauge', Object.assign({ target: 'panel', visible: true, z: 15 }, hgRect));
                this._paintHvSocGauge(lHg.cv, t.soc);
                this._setVisible('hv_soc_gauge', true);
                this._upload('hv_soc_gauge');
            } else {
                this._setVisible('hv_soc_gauge', false);
            }

            // 1f. Zone 6: Right-Wing Charging / Media / Trip Widget (1252..1788, 88..604)
            if (rightWidgetPage !== 'off') {
                const rwRect = {
                    x: clamp(RIGHT_WIDGET_BASE.x + cx, 1244, 1260),
                    y: clamp(RIGHT_WIDGET_BASE.y + cy, 86, 96),
                    w: RIGHT_WIDGET_BASE.w,
                    h: RIGHT_WIDGET_BASE.h,
                };
                const lRw = this._ensureOrLocal('right_widget', Object.assign({ target: 'panel', visible: true, z: 11 }, rwRect));
                if (rightWidgetPage === 'charging') {
                    const kwKey = (chg && typeof chg.chargeKw === 'number' && isFinite(chg.chargeKw)) ? chg.chargeKw.toFixed(1) : '--';
                    const rwKey = 'C|' + [
                        chg ? chg.finishTimeText : '--:--',
                        chg ? chg.remainText : '',
                        kwKey,
                        chg && chg.maxAmps ? chg.maxAmps : '',
                        typeof t.soc === 'number' ? Math.round(t.soc) : -1,
                        chg ? chg.targetSoc : 100,
                        typeof t.erangeKm === 'number' ? Math.round(t.erangeKm) : -1,
                        units.distUnit,
                    ].join('|');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightCharging(lRw.cv, chg, t, units);
                        this.lastRightWidgetKey = rwKey;
                    }
                } else if (rightWidgetPage === 'media') {
                    const remKey = media && typeof media.remainSec === 'number' ? Math.ceil(media.remainSec) : -1;
                    const totKey = media && typeof media.totalSec === 'number' ? Math.floor(media.totalSec) : -1;
                    const tElapsed = media ? Math.max(0, now - (media.trackSinceMs || 0)) : 0;
                    const titleInfo = (media && media.active && media.title)
                        ? paginateTitle(lRw.cv, media.title, 332, [30, 27, 24, 22], 22, tElapsed)
                        : null;
                    const rwKey = 'M|' + rwRect.x + ',' + rwRect.y + '|' + (media
                        ? [media.active ? 1 : 0, media.playing ? 1 : 0, media.title, media.artist, media.coverRev,
                            titleInfo ? titleInfo.page : 0, remKey, totKey].join('|')
                        : 'none');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightMedia(lRw.cv, media, titleInfo, rwRect.x, rwRect.y);
                        this.lastRightWidgetKey = rwKey;
                    }
                } else {
                    const rwKey = 'T|' + [
                        units.system, units.tempUnit, units.distUnit,
                        Math.round(t.erangeKm || -1), Math.round(t.frangeKm || -1),
                        Math.round((t.tripDistKm || -1) * 10), t.tripMinutes || -1,
                        Math.round(t.gearboxOilC || -99), Math.round(t.battTempC || -99),
                        Math.round(t.iatC || -99), typeof t.v12 === 'number' ? t.v12.toFixed(1) : '--',
                        typeof t.soc12 === 'number' ? Math.round(t.soc12) : -1,
                        hero.value, hero.unit,
                    ].join('|');
                    if (rwKey !== this.lastRightWidgetKey || !lRw.prevBuf) {
                        this._paintRightTrip(lRw.cv, t, hero, profile, units);
                        this.lastRightWidgetKey = rwKey;
                    }
                }
                this._setVisible('right_widget', true);
                this._upload('right_widget');
            } else {
                this._setVisible('right_widget', false);
            }
        } else {
            PANEL_ALL_LAYERS.forEach((n) => this._setVisible(n, false));
        }

        // 2a. HUD FULL-WIDTH TOP-ROW ROAD + HIGHWAY EXIT BADGE BANNER (544x38 at x=132..676, y=100..138)
        const hudTopY = clamp(HUD_BASE.y + hy, 100, 102);
        if (showHudRoad) {
            const roadX = clamp(HUD_ROAD_BASE.x + hx, 120, 680 - HUD_ROAD_W);
            const lHudRoad = this._ensureOrLocal('hud_road', {
                target: 'hud', klass: 'overlay', x: roadX, y: hudTopY, w: HUD_ROAD_W, h: HUD_ROAD_H, visible: true, z: 14,
            });
            const rk = hudRoadKey(hn.show);
            if (rk !== this.lastHudRoadKey || !lHudRoad.prevBuf) {
                drawHudRoadBanner(lHudRoad.cv, hn.show);
                this.lastHudRoadKey = rk;
            }
            this._setVisible('hud_road', true);
            this._upload('hud_road');
        } else {
            this._setVisible('hud_road', false);
        }

        // 2b. HUD TELEMETRY LAYER (260x100 at y=100..200 <= 202 ACC; shifts metrics cleanly into Row 2 when showHudRoad is true!)
        const hudX = clamp(HUD_BASE.x + hx, 120, 144);
        const lHud = this._ensureOrLocal('hud_main', {
            target: 'hud', klass: 'overlay', x: hudX, y: hudTopY, w: HUD_BASE.w, h: HUD_BASE.h, visible: showHud, z: 12,
        });
        if (showHud) {
            const alertHud = s.smartAlerts !== false ? profile.alert : null;
            this._paintHud(
                lHud.cv,
                [hudLine1, hudLine2, hudLine3],
                hero, heroCol, subText, subCol,
                gearDisplay !== 'off' ? dGearText : '',
                t, profile, units, fg, brakeLit, brakeHold, alertHud,
                showHudRoad
            );
            this._setVisible('hud_main', true);
            this._upload('hud_main');
        } else {
            this._setVisible('hud_main', false);
        }

        // 2b2. HUD LEAD-CAR HEADWAY BADGE (124x45 at x=280..404 < 405 nav, y=140..185 > 138 road & < 202 ACC)
        if (showHudHeadway) {
            const hwX = clamp(HUD_HEADWAY_BASE.x + hx, 268, 404 - HUD_HEADWAY_BASE.w);
            const hwMinY = showHudRoad ? (hudTopY + HUD_ROAD_H + 1) : 104;
            const hwY = clamp(HUD_HEADWAY_BASE.y + hy, hwMinY, 201 - HUD_HEADWAY_BASE.h);
            const lHudHw = this._ensureOrLocal('hud_headway', {
                target: 'hud', klass: 'overlay', x: hwX, y: hwY, w: HUD_HEADWAY_BASE.w, h: HUD_HEADWAY_BASE.h, visible: true, z: 13,
            });
            this._paintHudHeadway(lHudHw.cv, t.leadVehicle, units, hudHeadwayMode);
            this._setVisible('hud_headway', true);
            this._upload('hud_headway');
        } else {
            this._setVisible('hud_headway', false);
        }

        // 2c. HUD NAVIGATION LAYER (264x232 right-side slot x=412..676, y=140..372 below road banner; yields for mini-map)
        if (showOwnHudNav) {
            const navX = clamp(HUD_NAV_BASE.x + hx, 406, 680 - HUD_NAV_W);
            const baseNavY = showHudRoad ? HUD_NAV_BASE.y : 116;
            const navY = clamp(baseNavY + hy, showHudRoad ? (hudTopY + HUD_ROAD_H + 1) : 100, 380 - HUD_NAV_H);
            const lHudNav = this._ensureOrLocal('hud_nav', {
                target: 'hud', klass: 'overlay', x: navX, y: navY, w: HUD_NAV_W, h: HUD_NAV_H, visible: true, z: 13,
            });
            const nk = hudNavKey(hn.show) + '|hr=' + (showHudRoad ? 1 : 0);
            if (nk !== this.lastHudNavKey || !lHudNav.prevBuf) {
                drawHudNav(lHudNav.cv, hn.show, { hideRoad: showHudRoad });
                this.lastHudNavKey = nk;
            }
            this._setVisible('hud_nav', true);
            this._upload('hud_nav');
        } else {
            this._setVisible('hud_nav', false);
        }

        // 3. MAP SLOT SIDE-BOTTOM OVERLAYS (0x100, contend: false — optional Map-Slot-Only mode)
        if (showMapOverlay) {
            const msRect = {
                x: clamp(MAP_SPEED_RECT.x + cx, 8, 32),
                y: clamp(MAP_SPEED_RECT.y + cy, 313, 335),
                w: MAP_SPEED_RECT.w,
                h: MAP_SPEED_RECT.h,
            };
            const lMapSpd = this._ensureOrLocal('map_speed', {
                target: 'map', klass: 'overlay', contend: false,
                x: msRect.x, y: msRect.y, w: msRect.w, h: msRect.h,
                visible: true, z: 20,
            });
            this._paintBelowSpeed(lMapSpd.cv, hero, heroCol, subText, subCol, gearDisplay === 'below_speed' ? dGearText : '', gearDisplay === 'below_speed', 84);
            this._setVisible('map_speed', true);
            this._upload('map_speed');

            const mlRect = {
                x: clamp(MAP_LEFT_RECT.x + cx, 176, 204),
                y: clamp(MAP_LEFT_RECT.y + cy, 368, 392),
                w: MAP_LEFT_RECT.w,
                h: MAP_LEFT_RECT.h,
            };
            const lMapLeft = this._ensureOrLocal('map_left', {
                target: 'map', klass: 'overlay', contend: false,
                x: mlRect.x, y: mlRect.y, w: mlRect.w, h: mlRect.h,
                visible: cornerLeftMode !== 'off', z: 20,
            });
            if (cornerLeftMode !== 'off') {
                this._paintMapLeft(lMapLeft.cv, t, units, cornerLeftMode, Number(s.coldOilC) || 75);
                this._setVisible('map_left', true);
                this._upload('map_left');
            } else {
                this._setVisible('map_left', false);
            }

            const mrRect = {
                x: clamp(MAP_RIGHT_RECT.x + cx, 664, 696),
                y: clamp(MAP_RIGHT_RECT.y + cy, 362, 386),
                w: MAP_RIGHT_RECT.w,
                h: MAP_RIGHT_RECT.h,
            };
            const alertMap = s.smartAlerts !== false ? profile.alert : null;
            const gearOnMapRight = gearDisplay === 'next_to_d' ? dGearText : '';
            const showMapRight = Boolean(showBrakeRail || cornerRightMode !== 'off' || gearOnMapRight || alertMap);
            const lMapRight = this._ensureOrLocal('map_right', {
                target: 'map', klass: 'overlay', contend: false,
                x: mrRect.x, y: mrRect.y, w: mrRect.w, h: mrRect.h,
                visible: showMapRight, z: 20,
            });
            if (showMapRight) {
                this._paintMapRight(
                    lMapRight.cv, gearOnMapRight, t, units, cornerRightMode,
                    showBrakeRail, brakeMode === 'bar_num' && !brakeHold, fg, brakeLit, Boolean(t.absActive), alertMap
                );
                this._setVisible('map_right', true);
                this._upload('map_right');
            } else {
                this._setVisible('map_right', false);
            }
        } else {
            MAP_LAYER_NAMES.forEach((n) => this._setVisible(n, false));
        }
    }

    _ensureOrLocal(name, opts) {
        if (this.cr) return this._ensureLayer(name, opts);
        if (!this.layers[name]) {
            this.layers[name] = {
                ref: Object.keys(this.layers).length + 1,
                target: opts.target,
                rect: { x: opts.x, y: opts.y, w: opts.w, h: opts.h },
                cv: new Canvas(opts.w, opts.h),
                prevBuf: null,
                visible: opts.visible !== false,
            };
        } else {
            this.layers[name].rect.x = opts.x;
            this.layers[name].rect.y = opts.y;
        }
        return this.layers[name];
    }

    _paintBelowSpeed(cv, hero, heroCol, subText, subCol, gearStr, reserveGearSlot, heroRightX) {
        cv.clear(COL.clear);
        const rx = typeof heroRightX === 'number' ? heroRightX : 108;
        drawTextOutline(cv, hero.value, rx, 43, 44, heroCol, { font: 'num', align: 'right' });
        const unitSize = String(hero.unit || '').length > 6 ? 17 : 21;
        drawTextOutline(cv, hero.unit, rx + 7, 39, unitSize, COL.softBlue, { font: 'bold', align: 'left' });
        if (reserveGearSlot) {
            drawTextOutline(cv, subText, rx + 22, 75, 22, subCol, { font: 'bold', align: 'right' });
            if (gearStr) {
                drawTextOutline(cv, gearStr, rx + 32, 75, 22, COL.white, { font: 'bold', align: 'left' });
            }
        } else {
            drawTextOutline(cv, subText, rx - 8, 75, 23, subCol, { font: 'bold', align: 'center' });
        }
    }

    _paintGearNextToD(cv, digitStr) {
        cv.clear(COL.clear);
        if (digitStr) {
            drawTextOutline(cv, digitStr, 2, 46, 40, COL.white, { font: 'bold', align: 'left' });
        }
    }

    /**
     * Sleek BMW sedan-silhouette enclosure around interior cabin temperature (`74x50`),
     * placed directly left of stock ambient temperature (`+57°F`) with breathing room before '+'.
     */
    _paintCabinTemp(cv, cabinTempC, units) {
        cv.clear(COL.clear);
        const tf = formatTemp(cabinTempC, units);
        const fillCol = [10, 18, 30, 182];
        const rimCol = '#8eb8e5';

        // Fill upper greenhouse + lower sedan body
        cv.convex([[12, 19], [21, 8], [50, 8], [59, 19]], fillCol);
        cv.roundRect(3, 18, 66, 22, 3, fillCol);

        // Two subtle lower tire treads so the silhouette reads unmistakably as a car at a glance
        cv.roundRect(11, 39, 11, 4, 1.5, COL.outline);
        cv.roundRect(50, 39, 11, 4, 1.5, COL.outline);
        cv.roundRect(12, 39, 9, 3, 1, rimCol);
        cv.roundRect(51, 39, 9, 3, 1, rimCol);

        // Sedan greenhouse + body contour + subtle B-pillar & window sill
        const pts = [
            [4, 20],
            [12, 18],
            [21, 8],
            [50, 8],
            [59, 18],
            [68, 20],
            [68, 39],
            [4, 39],
            [4, 20],
        ];
        cv.polyline(pts, 3.2, COL.outline);
        cv.polyline(pts, 1.6, rimCol);
        cv.line(35, 9, 35, 18, 1.2, [142, 184, 229, 115]);
        cv.line(13, 18, 58, 18, 1.0, [142, 184, 229, 95]);

        const sz = tf.text.length >= 5 ? 16 : 17;
        drawTextOutline(cv, tf.text, 36, 35, sz, COL.white, { font: 'bold', align: 'center' });
    }

    /**
     * PHEV-only HV Battery State of Charge (%) centered inside the dark pocket of the bottom-right HV battery gauge.
     */
    _paintHvSocGauge(cv, soc) {
        cv.clear(COL.clear);
        const pct = clamp(Math.round(soc), 0, 100);
        const col = pct <= 10 ? COL.red : (pct <= 20 ? COL.amber : COL.white);
        drawTextOutline(cv, 'SOC', 46, 16, 13, COL.tagBlue, { font: 'bold', align: 'center' });
        drawTextOutline(cv, pct + '%', 46, 47, 29, col, { font: 'num', align: 'center' });
    }

    _paintBrakeRail(cv, fg, litCount, absActive, showNum, brakeBar, alertObj, showSegments) {
        cv.clear(COL.clear);
        if (showSegments !== false) {
            const SEG_N = 20;
            const barX0 = 2;
            const barX1 = 294;
            const segW = (barX1 - barX0) / SEG_N;

            for (let i = 0; i < SEG_N; i++) {
                const sx1 = Math.round(barX1 - i * segW) - 1;
                const sx0 = Math.round(barX1 - (i + 1) * segW) + 2;
                let col = COL.railDim;
                if (litCount > 0 && i < litCount) {
                    col = i >= 13 ? COL.red : (i >= 6 ? COL.orange : COL.amber);
                }
                cv.fillRect(sx0, 21, Math.max(2, sx1 - sx0), 7, col);
            }
        }

        if (litCount > 0 && showNum) {
            const hasBar = typeof brakeBar === 'number' && isFinite(brakeBar) && brakeBar >= 1.5;
            const valStr = hasBar ? (Math.round(brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
            const lbl = (absActive ? 'ABS ' : '') + valStr;
            const col = (fg >= 0.36 || absActive) ? COL.red : COL.amber;
            drawTextOutline(cv, lbl, 3, 15, 15, col, { font: 'bold', align: 'left' });
        } else if (litCount === 0 && alertObj && alertObj.label) {
            const aCol = alertObj.severity === 'red' ? COL.red : COL.amber;
            drawTextOutline(cv, alertObj.label, 3, 15, 15, aCol, { font: 'bold', align: 'left' });
        }
    }

    _paintCornerLeft(cv, t, units, mode, coldOilC) {
        cv.clear(COL.clear);
        const oil = formatTemp(t.oilTempC, units);
        const isColdOil = typeof t.oilTempC === 'number' && t.oilTempC < coldOilC;
        const isHotOil = typeof t.oilTempC === 'number' && t.oilTempC >= 118;
        const colOil = isColdOil ? COL.icyBlue : (isHotOil ? COL.amber : COL.white);
        drawTextOutline(cv, 'OIL ' + oil.text, 3, 24, 22, colOil, { font: 'bold', align: 'left' });

        if (mode === 'oil_gbx') {
            const gbx = formatTemp(t.gearboxOilC, units);
            const colGbx = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.softBlue;
            drawTextOutline(cv, 'GBX ' + gbx.text, 3, 53, 21, colGbx, { font: 'bold', align: 'left' });
        } else {
            const cool = formatTemp(t.coolantTempC, units);
            const colCool = (typeof t.coolantTempC === 'number' && t.coolantTempC >= 108) ? COL.red : COL.softBlue;
            drawTextOutline(cv, 'CL ' + cool.text, 3, 53, 22, colCool, { font: 'bold', align: 'left' });
        }
    }

    _paintCornerRight(cv, t, units, mode) {
        cv.clear(COL.clear);
        const m = formatCornerRightMetric(t, units, mode);
        drawTextOutline(cv, m.tag, cv.w - 4, 21, 16, COL.tagGray, { font: 'bold', align: 'right' });
        drawTextOutline(cv, m.valText, cv.w - 4, 55, 28, m.col, { font: 'num', align: 'right' });
    }

    /**
     * Re-implemented OEM-scale Right-Wing Media Playback Widget (536x516 at 1252,88):
     *   - Gauge-edge translucent album-art backdrop filling the right-wing face cleanly with zero darkened edge
     *   - Crisp 144x144 album artwork centered at x=186 (world x=1438, y=184..328)
     *   - Track title (Latin + CJK): downscales 30 -> 27 -> 24 -> 22px bold before paginating cleanly across segments
     *   - Artist / Show name in clean light gray (#cbd2dc)
     *   - Slanted BMW cyan progress bar with right-side-only time remaining (zero left timestamp)
     */
    _paintRightMedia(cv, media, titleInfoPre, ox, oy) {
        cv.clear(COL.clear);
        const fgCx = 186; // world x = 1438 (+42px right matching BMW stock Now Playing alignment)
        const coverSide = COVER_SIDE; // 144
        const coverX = fgCx - Math.round(coverSide / 2); // 114 (world x = 1366..1510)
        const coverY = 96; // world y = 184..328

        const hasMedia = Boolean(media && media.active && media.title);
        const cover = hasMedia ? media.cover : null;

        if (cover && cover.d && cover.w === coverSide && cover.h === coverSide) {
            const bgBuf = buildStockBackdrop(cover, cv.w, cv.h, {
                ox: typeof ox === 'number' ? ox : 1252,
                oy: typeof oy === 'number' ? oy : 88,
                vx: fgCx,
                vy: 224,
            });
            if (bgBuf && bgBuf.length === cv.d.length) {
                bgBuf.copy(cv.d);
            }
            blitCoverArt(cv, coverX, coverY, cover, 4);
        } else {
            paintRadialGlow(cv, fgCx, coverY + 72, 118, [56, 178, 246], hasMedia ? 38 : 24);
            cv.roundRect(coverX, coverY, coverSide, coverSide, 4, COL.tileBg);
            cv.strokeRoundRect(coverX, coverY, coverSide, coverSide, 4, 2, COL.tileRim);
            cv.roundRect(fgCx - 27, coverY + 82, 24, 20, 10, COL.icyBlue);
            cv.roundRect(fgCx + 5, coverY + 74, 24, 20, 10, COL.icyBlue);
            cv.fillRect(fgCx - 8, coverY + 42, 5, 50, COL.icyBlue);
            cv.fillRect(fgCx + 24, coverY + 36, 5, 48, COL.icyBlue);
            cv.fillRect(fgCx - 8, coverY + 36, 37, 8, COL.icyBlue);
        }

        if (!hasMedia) {
            drawTextOutline(cv, '暂无媒体播放', fgCx, 286, 24, COL.mediaSub, { font: 'bold', align: 'center' });
            drawTextOutline(cv, '按 BC 键查看行程', fgCx, 316, 17, COL.tagGray, { font: 'bold', align: 'center' });
            return;
        }

        const tInfo = titleInfoPre || paginateTitle(cv, media.title, 332, [30, 27, 24, 22], 22, 0);
        if (tInfo && tInfo.text) {
            drawTextOutline(cv, tInfo.text, fgCx, 286, tInfo.size, COL.white, { font: 'bold', align: 'center' });
        }

        const subRaw = media.artist || media.source || '';
        if (subRaw) {
            const aFit = fitTextLine(cv, subRaw, 328, [23, 21, 19]);
            drawTextOutline(cv, aFit.text, fgCx, 320, aFit.size, COL.mediaSub, { font: 'bold', align: 'center' });
        }

        const barX0 = 32; // world x = 1284
        const barW = 296; // world x1 = 1580
        const barX1 = barX0 + barW;
        const barY = 374; // world y = 462..472
        const barH = 10;

        if (typeof media.totalSec === 'number' && media.totalSec > 0 && typeof media.elapsedSec === 'number') {
            const frac = clamp(media.frac || 0, 0, 1);
            const fillW = Math.max(barH + 2, Math.round(barW * frac));
            const rem = typeof media.remainSec === 'number' ? Math.max(0, media.remainSec) : Math.max(0, media.totalSec - media.elapsedSec);
            const remLabel = media.playing === false ? ('已暂停  -' + formatDuration(rem)) : ('-' + formatDuration(rem));
            drawTextOutline(cv, remLabel, barX1, 362, 20, media.playing === false ? COL.amber : COL.mediaTime, { font: 'bold', align: 'right' });

            fillSlantBar(cv, barX0, barY, barW, barH, barW, COL.progTrack);
            fillSlantBar(cv, barX0, barY, barW, barH, fillW, media.playing === false ? [255, 179, 71, 255] : [69, 214, 255, 255]);
        } else {
            const liveTag = media.playing === false ? '已暂停' : (media.source || '实时音频');
            drawTextOutline(cv, liveTag, barX1, 364, 19, media.playing === false ? COL.amber : COL.mediaTime, { font: 'bold', align: 'right' });
        }
    }

    /**
     * Right-Wing Trip & Powertrain Summary Widget (centered identically at world x=1438, BC-cycled):
     */
    _paintRightTrip(cv, t, hero, profile, units) {
        cv.clear(COL.clear);
        const midX = 186;
        const leftX = 40;
        const rightX = 332;
        const isMi = units.distUnit === 'mi';
        const dUnit = isMi ? ' mi' : ' km';
        const dScale = isMi ? 0.621371 : 1;

        drawTextOutline(cv, '行程与车辆信息', midX, 122, 17, COL.tagGray, { font: 'bold', align: 'center' });
        cv.fillRect(leftX, 134, rightX - leftX, 2, COL.divider);

        if (profile && profile.vehicleType === 'phev') {
            const evStr = (typeof t.erangeKm === 'number' && isFinite(t.erangeKm))
                ? (Math.round(t.erangeKm * dScale) + dUnit) : ('--' + dUnit);
            drawTextOutline(cv, '纯电续航', leftX, 168, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, evStr, leftX, 202, 28, COL.cyan, { font: 'num', align: 'left' });
        } else {
            drawTextOutline(cv, '实时能耗', leftX, 168, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, hero.value + ' ' + hero.unit, leftX, 202, 24, COL.white, { font: 'bold', align: 'left' });
        }

        const fuelStr = (typeof t.frangeKm === 'number' && isFinite(t.frangeKm))
            ? (Math.round(t.frangeKm * dScale) + dUnit) : ('--' + dUnit);
        drawTextOutline(cv, '燃油续航', rightX, 168, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, fuelStr, rightX, 202, 28, COL.white, { font: 'num', align: 'right' });

        let tripStr = '--';
        if (typeof t.tripDistKm === 'number' && isFinite(t.tripDistKm)) {
            tripStr = (t.tripDistKm * dScale).toFixed(1) + dUnit;
        } else if (typeof t.tripMinutes === 'number' && t.tripMinutes >= 0) {
            tripStr = Math.floor(t.tripMinutes / 60) + 'h ' + (t.tripMinutes % 60) + 'm';
        }
        drawTextOutline(cv, '行程距离', leftX, 254, 15, COL.tagBlue, { font: 'bold', align: 'left' });
        drawTextOutline(cv, tripStr, leftX, 288, 28, COL.white, { font: 'num', align: 'left' });

        const gbxStr = formatTemp(t.gearboxOilC, units).text;
        const gbxCol = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.white;
        drawTextOutline(cv, '变速箱', rightX, 254, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, gbxStr, rightX, 288, 28, gbxCol, { font: 'num', align: 'right' });

        if (profile && profile.vehicleType === 'phev') {
            const btStr = formatTemp(t.battTempC, units).text;
            drawTextOutline(cv, 'HV BATT', leftX, 340, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, btStr, leftX, 374, 28, COL.white, { font: 'num', align: 'left' });
        } else {
            const iatStr = formatTemp(t.iatC, units).text;
            drawTextOutline(cv, 'INTAKE', leftX, 340, 15, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, iatStr, leftX, 374, 28, COL.white, { font: 'num', align: 'left' });
        }

        const hasV12 = typeof t.v12 === 'number' && isFinite(t.v12);
        const hasSoc12 = typeof t.soc12 === 'number' && isFinite(t.soc12);
        let v12Str = '--';
        if (hasV12 && hasSoc12) {
            v12Str = t.v12.toFixed(1) + 'V ' + Math.round(t.soc12) + '%';
        } else if (hasSoc12) {
            v12Str = Math.round(t.soc12) + '%';
        } else if (hasV12) {
            v12Str = t.v12.toFixed(1) + 'V';
        }
        const v12Low = (hasV12 && t.v12 < 12.1) || (hasSoc12 && t.soc12 < 55);
        const v12Col = (hasSoc12 && t.soc12 < 40) ? COL.red : (v12Low ? COL.amber : COL.white);
        drawTextOutline(cv, '12V AUX', rightX, 340, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, v12Str, rightX, 374, (hasV12 && hasSoc12) ? 23 : 28, v12Col, { font: (hasV12 && hasSoc12) ? 'bold' : 'num', align: 'right' });
    }

    /**
     * Right-Wing Plug-In Charging Finish Time Widget (auto-locked while car is charging):
     */
    _paintRightCharging(cv, chg, t, units) {
        cv.clear(COL.clear);
        const c = chg || {};
        const midX = 186;
        const leftX = 40;
        const rightX = 332;
        const isMi = units.distUnit === 'mi';
        const dUnit = isMi ? ' mi' : ' km';
        const dScale = isMi ? 0.621371 : 1;

        paintRadialGlow(cv, midX, 210, 148, [56, 178, 246], 34);
        drawTextOutline(cv, 'CHARGING', midX, 122, 18, COL.cyan, { font: 'bold', align: 'center' });
        cv.fillRect(leftX, 134, rightX - leftX, 2, COL.divider);

        drawTextOutline(cv, 'EST. FINISH', midX, 166, 15, COL.tagGray, { font: 'bold', align: 'center' });
        const finStr = c.finishTimeText || '--:--';
        drawTextOutline(cv, finStr, midX, 224, 52, COL.white, { font: 'num', align: 'center' });

        const remLabel = c.remainText ? (c.remainText + ' left') : 'Plugged in';
        drawTextOutline(cv, remLabel, midX, 256, 20, COL.softBlue, { font: 'bold', align: 'center' });

        const kwStr = (typeof c.chargeKw === 'number' && isFinite(c.chargeKw)) ? (c.chargeKw.toFixed(1) + ' kW') : '-- kW';
        const speedTag = c.maxAmps ? ('SPEED (' + Math.round(c.maxAmps) + 'A)') : 'CHARGE SPEED';
        drawTextOutline(cv, speedTag, leftX, 294, 15, COL.tagBlue, { font: 'bold', align: 'left' });
        drawTextOutline(cv, kwStr, leftX, 326, 26, COL.cyan, { font: 'bold', align: 'left' });

        const socPct = (typeof t.soc === 'number' && isFinite(t.soc)) ? Math.round(t.soc) : null;
        const targetPct = c.targetSoc || 100;
        const erStr = (typeof t.erangeKm === 'number' && isFinite(t.erangeKm)) ? (' (' + Math.round(t.erangeKm * dScale) + dUnit + ')') : '';
        const socValStr = (socPct !== null ? (socPct + '%') : '--%') + erStr;
        drawTextOutline(cv, 'TARGET ' + targetPct + '%', rightX, 294, 15, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, socValStr, rightX, 326, 24, COL.white, { font: 'bold', align: 'right' });

        const barX0 = 32;
        const barW = 296;
        const barY = 374;
        const barH = 10;
        const frac = socPct !== null ? clamp(socPct / 100, 0, 1) : 0;
        const fillW = Math.max(barH + 2, Math.round(barW * frac));
        fillSlantBar(cv, barX0, barY, barW, barH, barW, COL.progTrack);
        if (socPct !== null && socPct > 0) {
            fillSlantBar(cv, barX0, barY, barW, barH, fillW, [69, 214, 255, 255]);
        }
    }

    /**
     * Dedicated HUD Lead-Car Headway badge (`120x41`) right above BMW's green ACC car:
     *   - Row 1: crisp rear-car outline + perspective headway bars + headway timer (`1.8s`, or distance below 12 km/h)
     *   - Row 2: physical following distance (`118 ft` / `36 m`) + optional closing/opening delta (`-6 mph`)
     */
    _paintHudHeadway(cv, lead, units, mode) {
        cv.clear(COL.clear);
        const p = formatLeadHeadwayParts(lead, units, mode);
        if (!p) return;

        const rx = cv.w - 3;
        const mainW = drawTextOutline(cv, p.primaryStr, rx, 20, 22, p.primaryCol, { font: 'num', align: 'right' });

        // Crisp rear-car outline (hollow rear window + tires) + 2 tapered perspective headway bars
        const icX = Math.max(2, Math.round(rx - mainW - 24));
        const carRoof = [[icX + 4, 2], [icX + 14, 2], [icX + 17, 7], [icX + 1, 7], [icX + 4, 2]];
        cv.polyline(carRoof, 3.0, COL.outline);
        cv.fillRect(icX, 6, 18, 6, COL.outline);
        cv.polyline(carRoof, 1.5, p.primaryCol);
        cv.fillRect(icX + 1, 7, 16, 4, p.primaryCol);
        // Rear window dark cutout + two tire ticks
        cv.convex([[icX + 5, 3.5], [icX + 13, 3.5], [icX + 14.5, 6.5], [icX + 3.5, 6.5]], COL.outline);
        cv.fillRect(icX + 1, 11, 3, 2, p.primaryCol);
        cv.fillRect(icX + 14, 11, 3, 2, p.primaryCol);
        // Perspective headway range bars below rear bumper
        cv.fillRect(icX + 2, 14, 14, 3, COL.outline);
        cv.fillRect(icX + 3, 15, 12, 1.6, p.primaryCol);
        cv.fillRect(icX, 18, 18, 3, COL.outline);
        cv.fillRect(icX + 1, 19, 16, 1.6, p.primaryCol);

        if (p.deltaStr && p.secDistStr) {
            const dW = drawTextOutline(cv, p.deltaStr, rx, 36, 13, p.deltaCol, { font: 'bold', align: 'right' });
            drawTextOutline(cv, p.secDistStr, rx - dW - 6, 36, 13, COL.softBlue, { font: 'bold', align: 'right' });
        } else if (p.secDistStr) {
            drawTextOutline(cv, p.secDistStr, rx, 36, 13, COL.softBlue, { font: 'bold', align: 'right' });
        } else if (p.deltaStr) {
            drawTextOutline(cv, p.deltaStr, rx, 36, 13, p.deltaCol, { font: 'bold', align: 'right' });
        }
    }

    _paintHud(cv, lineModes, hero, heroCol, subText, subCol, gearStr, t, profile, units, fg, brakeLit, brakeHold, alertObj, compactBelowRoad) {
        cv.clear(COL.clear); // Borderless 3-line black-outlined text (strictly y=100..200 <= 202 ACC)
        const compact = Boolean(compactBelowRoad);
        const modes = Array.isArray(lineModes) ? lineModes.slice(0, 3) : ['efficiency_gear', 'power', 'brake'];
        // When `hud_road` occupies Row 1 (py=0..38), shift compact metrics into Row 2 (py=57, 77, 95) while staying <= py=99!
        const baselines = compact ? [57, 77, 95] : [35, 65, 92];
        const socStr = (typeof t.soc === 'number' && isFinite(t.soc)) ? ('SOC ' + Math.round(t.soc) + '%') : 'SOC --%';
        const socCol = (typeof t.soc === 'number' && t.soc <= 10) ? COL.red : ((typeof t.soc === 'number' && t.soc <= 20) ? COL.amber : COL.white);
        const oilStr = 'OIL ' + formatTemp(t.oilTempC, units).text;
        const coolStr = 'CL ' + formatTemp(t.coolantTempC, units).text;
        const tempCol = profile.isCold ? COL.icyBlue : COL.softBlue;

        for (let idx = 0; idx < 3; idx++) {
            const by = baselines[idx];
            const m = modes[idx] || 'off';
            // Never let a passive alert overwrite Line 3 while the driver is actively pressing the brake!
            if (idx === 2 && alertObj && alertObj.label && !(m === 'brake' && brakeLit > 0)) {
                const aCol = alertObj.severity === 'red' ? COL.red : COL.amber;
                drawTextOutline(cv, alertObj.label, 6, by, compact ? 16 : 19, aCol, { font: 'bold', align: 'left' });
                continue;
            }
            if (m === 'off') continue;
            if (m === 'efficiency_gear' || m === 'efficiency') {
                // Fixed non-shifting horizontal anchors for value (right-aligned), unit (left-aligned), and gear (left-aligned)
                const valRightX = compact ? 44 : 64;
                const unitX = compact ? 49 : 70;
                const gearX = compact ? 132 : 166;
                const nSize = compact ? (idx === 0 ? 24 : 18) : (idx === 0 ? 38 : 24);
                const uLong = String(hero.unit || '').length > 7;
                const uSize = compact ? (uLong ? 13 : 14) : (uLong ? 16 : (idx === 0 ? 18 : 15));
                drawTextOutline(cv, hero.value, valRightX, by, nSize, heroCol, { font: 'num', align: 'right' });
                drawTextOutline(cv, hero.unit, unitX, by - 1, uSize, COL.softBlue, { font: 'bold', align: 'left' });
                if (m === 'efficiency_gear' && gearStr) {
                    const gSize = compact ? (idx === 0 ? 22 : 18) : (idx === 0 ? 30 : 22);
                    drawTextOutline(cv, gearStr, gearX, by, gSize, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'power_gear') {
                const sz = compact ? (idx === 0 ? 19 : 17) : (idx === 0 ? 26 : (idx === 1 ? 22 : 19));
                const gx = compact ? 132 : 166;
                drawTextOutline(cv, subText, 6, by, sz, subCol, { font: 'bold', align: 'left' });
                if (gearStr) {
                    drawTextOutline(cv, gearStr, gx, by, sz, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'power') {
                const sz = compact ? (idx === 0 ? 19 : 17) : (idx === 0 ? 26 : (idx === 1 ? 22 : 19));
                drawTextOutline(cv, subText, 6, by, sz, subCol, { font: 'bold', align: 'left' });
            } else if (m === 'gear') {
                if (gearStr) {
                    const sz = compact ? (idx === 0 ? 22 : 18) : (idx === 0 ? 34 : (idx === 1 ? 24 : 20));
                    drawTextOutline(cv, gearStr, 6, by, sz, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'soc') {
                const sz = compact ? (idx === 0 ? 20 : 17) : (idx === 0 ? 28 : (idx === 1 ? 22 : 19));
                drawTextOutline(cv, socStr, 6, by, sz, socCol, { font: 'bold', align: 'left' });
            } else if (m === 'soc12') {
                const s12Str = (typeof t.soc12 === 'number' && isFinite(t.soc12)) ? ('12V ' + Math.round(t.soc12) + '%') : '12V --%';
                const s12Col = (typeof t.soc12 === 'number' && t.soc12 < 40) ? COL.red : ((typeof t.soc12 === 'number' && t.soc12 < 55) ? COL.amber : COL.white);
                const sz = compact ? (idx === 0 ? 20 : 17) : (idx === 0 ? 26 : (idx === 1 ? 22 : 19));
                drawTextOutline(cv, s12Str, 6, by, sz, s12Col, { font: 'bold', align: 'left' });
            } else if (m === 'headway') {
                const hp = formatLeadHeadwayParts(t.leadVehicle, units, 'full');
                if (hp) {
                    const sz = compact ? 16 : (idx === 0 ? 22 : 19);
                    const hwTxt = hp.primaryStr + (hp.secDistStr ? ('  ' + hp.secDistStr) : '') + (hp.deltaStr ? ('  ' + hp.deltaStr) : '');
                    drawTextOutline(cv, hwTxt, 6, by, sz, hp.primaryCol, { font: 'bold', align: 'left' });
                }
            } else if (m === 'soc_oil') {
                const sz = compact ? 16 : (idx === 0 ? 22 : 19);
                drawTextOutline(cv, socStr + '  ' + oilStr, 6, by, sz, COL.softBlue, { font: 'bold', align: 'left' });
            } else if (m === 'temps') {
                const sz = compact ? 16 : (idx === 0 ? 22 : 19);
                drawTextOutline(cv, oilStr + '  ' + coolStr, 6, by, sz, tempCol, { font: 'bold', align: 'left' });
            } else if (m === 'brake') {
                if (brakeLit > 0) {
                    const hSegs = compact ? 10 : 12;
                    const stepX = compact ? 13 : 14;
                    const hLit = brakeHold ? 1 : clamp(Math.round((fg / 0.55) * hSegs), 1, hSegs);
                    const segH = compact ? 5 : 6;
                    const segY = compact ? (by - 7) : (by - 11);
                    for (let i = 0; i < hSegs; i++) {
                        const sx = 6 + i * stepX;
                        const redIdx = compact ? 7 : 8;
                        const orgIdx = compact ? 3 : 4;
                        const sc = i < hLit ? (i >= redIdx ? COL.red : (i >= orgIdx ? COL.orange : COL.amber)) : COL.mapRailDim;
                        cv.fillRect(sx - 1, segY - 1, stepX - 1, segH + 2, COL.outline);
                        cv.fillRect(sx, segY, stepX - 3, segH, sc);
                    }
                    if (!brakeHold && fg > 0.02) {
                        const hasBar = typeof t.brakeBar === 'number' && isFinite(t.brakeBar) && t.brakeBar >= 1.5;
                        const bStr = hasBar ? (Math.round(t.brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
                        drawTextOutline(cv, bStr, 6 + hSegs * stepX + 6, compact ? by : (by - 3), compact ? 14 : 15, fg >= 0.36 ? COL.red : COL.amber, { font: 'bold', align: 'left' });
                    }
                }
            }
        }
    }

    _paintMapLeft(cv, t, units, mode, coldOilC) {
        cv.clear(COL.clear);
        const oil = formatTemp(t.oilTempC, units);
        const isColdOil = typeof t.oilTempC === 'number' && t.oilTempC < coldOilC;
        const isHotOil = typeof t.oilTempC === 'number' && t.oilTempC >= 118;
        const colOil = isColdOil ? COL.icyBlue : (isHotOil ? COL.amber : COL.white);
        drawTextOutline(cv, 'OIL', 4, 27, 18, COL.tagBlue, { font: 'bold', align: 'left' });
        drawTextOutline(cv, oil.text, 50, 28, 24, colOil, { font: 'bold', align: 'left' });

        if (mode === 'oil_gbx') {
            const gbx = formatTemp(t.gearboxOilC, units);
            const colGbx = (typeof t.gearboxOilC === 'number' && t.gearboxOilC >= 105) ? COL.amber : COL.white;
            drawTextOutline(cv, 'GBX', 4, 58, 18, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, gbx.text, 50, 59, 24, colGbx, { font: 'bold', align: 'left' });
        } else {
            const cool = formatTemp(t.coolantTempC, units);
            const colCool = (typeof t.coolantTempC === 'number' && t.coolantTempC >= 108) ? COL.red : COL.white;
            drawTextOutline(cv, 'CL', 4, 58, 18, COL.tagBlue, { font: 'bold', align: 'left' });
            drawTextOutline(cv, cool.text, 50, 59, 24, colCool, { font: 'bold', align: 'left' });
        }
    }

    _paintMapRight(cv, gearStr, t, units, cornerRightMode, showBrakeRail, showBrakeNum, fg, litCount, absActive, alertObj) {
        cv.clear(COL.clear);

        if (alertObj && alertObj.label && !(showBrakeRail && litCount > 0)) {
            const aCol = alertObj.severity === 'red' ? COL.red : COL.amber;
            drawTextOutline(cv, alertObj.label, cv.w - 6, 21, 18, aCol, { font: 'bold', align: 'right' });
        } else if (showBrakeRail) {
            const segN = 14;
            const mLit = litCount > 0
                ? (litCount === 1 && fg <= 0.02 ? 1 : clamp(Math.round((fg / 0.55) * segN), 1, segN))
                : 0;
            const rightX = cv.w - 6;
            for (let i = 0; i < segN; i++) {
                const sx = rightX - (i + 1) * 10 + 3;
                const sc = i < mLit ? (i >= 9 ? COL.red : (i >= 4 ? COL.orange : COL.amber)) : COL.mapRailDim;
                cv.fillRect(sx - 1, 9, 9, 10, COL.outline);
                cv.fillRect(sx, 10, 7, 8, sc);
            }
            if (litCount > 0 && showBrakeNum) {
                const hasBar = typeof t.brakeBar === 'number' && isFinite(t.brakeBar) && t.brakeBar >= 1.5;
                const valStr = hasBar ? (Math.round(t.brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
                const lbl = (absActive ? 'ABS ' : '') + valStr;
                const bCol = (fg >= 0.36 || absActive) ? COL.red : COL.amber;
                drawTextOutline(cv, lbl, rightX - segN * 10 - 6, 20, 16, bCol, { font: 'bold', align: 'right' });
            }
        }

        if (gearStr) {
            drawTextOutline(cv, gearStr, 84, 60, 28, COL.white, { font: 'bold', align: 'right' });
        }

        if (cornerRightMode !== 'off') {
            const m = formatCornerRightMetric(t, units, cornerRightMode);
            const valX = cv.w - 6;
            const valW = drawTextOutline(cv, m.valText, valX, 60, 28, m.col, { font: 'num', align: 'right' });
            drawTextOutline(cv, m.tag, valX - valW - 6, 58, 18, COL.tagGray, { font: 'bold', align: 'right' });
        }
    }

    close() {
        if (this.cr) {
            this.cr.close();
            this.cr = null;
        }
        this.connected = false;
        this.ready = false;
        this.lastHudNavKey = '';
        this.lastHudRoadKey = '';
        this.lastRightWidgetKey = '';
        this.layers = {};
    }
}

module.exports = {
    OverlayRenderer,
    inspectClusterSlotConfig,
    changes,
    resolveCornerRightMode,
    formatLeadHeadwayParts,
    BELOW_SPEED_BASE,
    GEAR_D_BASE,
    CABIN_TEMP_BASE,
    BRAKE_RAIL_BASE,
    CORNER_LEFT_BASE,
    CORNER_RIGHT_BASE,
    HV_SOC_GAUGE_BASE,
    RIGHT_WIDGET_BASE,
    HUD_BASE,
    HUD_HEADWAY_BASE,
    HUD_ROAD_BASE,
    HUD_NAV_BASE,
    MAP_SPEED_RECT,
    MAP_LEFT_RECT,
    MAP_RIGHT_RECT,
    MAP_FALLBACK_RECT: MAP_RIGHT_RECT,
    CLUSTER_LAYER_NAMES,
    PANEL_ALL_LAYERS,
    MAP_LAYER_NAMES,
};
