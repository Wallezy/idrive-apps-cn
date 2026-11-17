'use strict';
/**
 * overlay_renderer.js - manages ClusterRender layers across:
 *   - hud (800x480 on 0x323):
 *       * hud_main (136, 100, 260x98): 3-line configurable upper-left telemetry (y=100..198, strictly above ACC y=202),
 *         with crisp black outline so it also overlays cleanly on top of waze-on-cluster's HUD projection!
 *       * hud_nav  (412, 108, 264x264): Full-height right-side vector turn-by-turn & 6-lane guidance
 *         (auto-yielding 0x323 ONLY when BMW HUD switches to an intersection mini-map, or hiding hud_nav over Waze HUD).
 *   - panel (1920x720 on slot 0x203, scene 0x010004f8): 5 real-car calibrated zones
 *       1. below_speed  (392, 429, 214x84) : Aligned under speed digits, clear of center map
 *       2. gear_d       (1463, 650, 74x56) : White shift position 1..8 strictly right of GEAR_WIN (1380..1460)
 *       3. brake_rail   (1280, 609, 296x31): 20-segment right-to-left friction brake force bar (hidden in Park)
 *       4. corner_left  (8, 643, 116x66)   : Large Oil + Coolant temperatures (always visible)
 *       5. corner_right (1816, 643, 98x66) : Large HV Battery % SoC (or Batt Temp / IAT / GBX / 12V)
 *   - map (1088x480 on 0x100, contend: 0): borderless white/blue black-outlined side-bottom readouts
 *       (map_speed + map_left + map_right) over waze-on-cluster with fixed non-shifting anchors and
 *       an unobstructed 312px center route corridor (leaves 0x203 unmapped so KOMBI4's right BC widget works!).
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
const { NW: HUD_NAV_W, NH: HUD_NAV_H, drawHudNav, hudNavKey } = require('./hud_nav_renderer');

const DEFAULT_CONF_DIR = '/var/opt/cluster-render';
const DEFAULT_WAZE_STATUS = '/run/waze-on-cluster/status.json';

const BELOW_SPEED_BASE = { x: 392, y: 429, w: 214, h: 84 };
// Strictly x >= 1461 so we NEVER overlap KOMBI4's GEAR_WIN (1380..1460), which both masks digits
// and triggers BMW's safety black box over Media (1406..1597, 342..419).
const GEAR_D_BASE = { x: 1463, y: 650, w: 74, h: 56 };
const BRAKE_RAIL_BASE = { x: 1280, y: 609, w: 296, h: 31 };
const CORNER_LEFT_BASE = { x: 8, y: 643, w: 116, h: 66 };
const CORNER_RIGHT_BASE = { x: 1816, y: 643, w: 98, h: 66 };
// Strictly y=100..198 (< 202 Assisted Driving / ACC set-speed & green car keep-out)
const HUD_BASE = { x: 136, y: 100, w: 260, h: 98 };
// Full-height right-side HUD turn-by-turn navigation & lane guidance (x=412..676 <= 680, y=108..372 <= 380, right of ACC x<=395)
const HUD_NAV_BASE = { x: 412, y: 108, w: HUD_NAV_W, h: HUD_NAV_H };
// Slot 0x100 (1088x480 at world 416,120): borderless side-bottom readouts leaving center route x=368..680 100% clear
const MAP_SPEED_RECT = { x: 16, y: 309, w: 204, h: 84 };
const MAP_LEFT_RECT = { x: 186, y: 380, w: 182, h: 68 };
const MAP_RIGHT_RECT = { x: 680, y: 374, w: 228, h: 74 };

const CLUSTER_LAYER_NAMES = ['below_speed', 'gear_d', 'brake_rail', 'corner_left', 'corner_right'];
const MAP_LAYER_NAMES = ['map_speed', 'map_left', 'map_right'];

const COL = {
    clear: [0, 0, 0, 0],
    outline: [2, 6, 12, 242],
    shadow: [4, 8, 14, 224],
    white: '#f2f5fa',
    cyan: '#38c7ff',
    icyBlue: '#5bc8ff',
    softBlue: '#9ec5eb',
    tagBlue: '#7fb8f0',
    amber: '#ffb347',
    orange: '#f97316',
    red: '#ef4444',
    dim: '#9ec5eb',
    label: '#7fb8f0',
    railDim: [48, 66, 90, 125],
    mapRailDim: [38, 62, 92, 185],
};

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Inspect /var/opt/cluster-render/cluster-render.conf + cluster-render.local.conf.
 * Real-car KOMBI4 finding:
 *   - Default `panel_slot = 0x203` (scene `0x010004f8`) is transparent over stock gauges,
 *     Power Gauge needle, Media info, stock map, and waze-on-cluster (`0x100`) simultaneously!
 *   - Overriding `panel_slot = 0x202` (or `0x201`) in `cluster-render.local.conf` hijacks KOMBI4's
 *     right-wing Power Gauge + Media widget slot, blanking the Power Gauge needle and Media display!
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

function resolveCornerRightMode(settingVal, profile, t) {
    const mode = settingVal || 'auto';
    if (mode === 'off') return 'off';
    if (mode !== 'auto') return mode;
    if ((profile && profile.vehicleType === 'phev') ||
        typeof (t && t.soc) === 'number' ||
        typeof (t && t.battTempC) === 'number') {
        return 'soc';
    }
    return 'iat';
}

function formatCornerRightMetric(t, units, mode) {
    let tag = 'SOC';
    let valText = '--';
    let col = COL.dim;

    if (mode === 'soc') {
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

        // Cluster target selection:
        //   - 'auto' (default): when waze-on-cluster holds 0x100, render on 'map' (0x100) and unmap 'panel' (0x203)
        //     so KOMBI4's right-side BC widget & stalk BC button work 100% natively! Otherwise use 'panel' (0x203).
        //   - 'map_only': never map 0x203 (always preserves right-side BC widget); render on 'map' whenever wazeOn.
        //   - 'panel_only': always use 'panel' (0x203) if safe, else 'map' fallback when wazeOn.
        const clusterSlotMode = s.clusterSlotMode || 'auto';
        const canPanel = this.canUsePanel();
        let panelAllowed = false;
        let showMapOverlay = false;
        if (wantCluster) {
            if (clusterSlotMode === 'map_only') {
                showMapOverlay = wazeOn;
            } else if (clusterSlotMode === 'panel_only') {
                panelAllowed = canPanel;
                showMapOverlay = !canPanel && s.fallbackMapBar !== false && wazeOn;
            } else {
                // 'auto'
                if (wazeOn) {
                    showMapOverlay = true;
                } else {
                    panelAllowed = canPanel;
                }
            }
        }

        // HUD navigation re-rendering & intersection mini-map auto-yield:
        //   - 'own_nav_minimap' (default): draw full-height turn-by-turn & lane guidance on the HUD ourselves,
        //     and ONLY yield 0x323 when BMW HUD switches to an intersection mini-map.
        //   - When waze-on-cluster projects to the HUD (`wocHudOn`), Waze draws on the SAME `hud` target (0x323)
        //     at class='content', so `hud_main` (class='overlay', z=12) stays ON over Waze's HUD map while
        //     `hud_nav` hides (unless the user explicitly selected 'yield_route').
        //   - 'own_nav_keep': always draw HUD metrics + our HUD nav (never yield).
        //   - 'yield_lanes': draw HUD nav, yield during lane guidance or mini-map.
        //   - 'yield_route': hide HUD metrics during the entire active route.
        const hudNavMode = s.hudNavMode || 'own_nav_minimap';
        const hn = t.hudNav || null;
        const wocHudOn = Boolean(hn && hn.wocHudShowing);
        const miniMapOn = Boolean(hn && hn.miniMapActive);
        const routeOn = Boolean((hn && hn.routeActive) || t.navRouteActive);
        const lanesOn = Boolean((hn && hn.hasLanes) || t.navHasLanes);

        let hudYieldedToNav = false;
        let hudYieldReason = '';
        if (hudNavMode === 'yield_route') {
            hudYieldedToNav = routeOn || wocHudOn;
            hudYieldReason = wocHudOn ? 'waze_hud' : (routeOn ? 'route' : '');
        } else if (!wocHudOn && hudNavMode === 'own_nav_minimap') {
            hudYieldedToNav = miniMapOn;
            hudYieldReason = miniMapOn ? (hn.miniMapReason || 'minimap') : '';
        } else if (!wocHudOn && hudNavMode === 'yield_lanes') {
            hudYieldedToNav = lanesOn || miniMapOn;
            hudYieldReason = miniMapOn ? (hn.miniMapReason || 'minimap') : (lanesOn ? 'lanes' : '');
        }
        const showHud = wantHud && !hudYieldedToNav;
        const showOwnHudNav = showHud && !wocHudOn && hudNavMode !== 'yield_route' && hudNavMode !== 'keep' &&
            Boolean(hn && hn.show);
        const wocHudOverlay = Boolean(showHud && wocHudOn);

        const hx = clamp(Number(s.hudNudgeX) || 0, -40, 40);
        const hy = clamp(Number(s.hudNudgeY) || 0, -40, 40);
        const cx = clamp(Number(s.clusterNudgeX) || 0, -12, 12);
        const cy = clamp(Number(s.clusterNudgeY) || 0, -12, 12);

        const gearDisplay = s.gearDisplay === 'left_of_speed' ? 'below_speed' : (s.gearDisplay || 'next_to_d');
        const brakeMode = s.brakeIndicator || 'bar_num';
        const cornerLeftMode = s.cornerLeftDisplay || 'oil_cool';
        const cornerRightMode = resolveCornerRightMode(s.cornerRightDisplay, profile, t);
        const hudLine1 = s.hudLine1 || 'efficiency';
        const hudLine2 = s.hudLine2 || 'power_gear';
        const hudLine3 = s.hudLine3 || 'brake';

        const hero = profile.isEv
            ? formatEvEff(eff.evKmPerKwh, units)
            : formatFuelEff(eff.fuelLPer100km, eff.isDfco, units);
        const heroCol = profile.mode === 'ev_regen' ? COL.cyan
            : profile.isEv ? COL.white
            : (eff.isDfco ? COL.cyan : (profile.isCold ? COL.icyBlue : COL.white));

        let subText = '';
        let subCol = COL.softBlue;
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

        this.lastSummary = {
            hero, heroCol, subText, subCol, inNormalD, dGearText,
            isParked, showBrakeRail, brakeHold,
            panelAllowed, showHud, showOwnHudNav, wocHudOverlay, hudYieldedToNav, hudYieldReason,
            showFallbackMap: showMapOverlay, showMapOverlay, clusterSlotMode,
            brakeMode, brakeLit, frictionG: fg, brakeBar: t.brakeBar,
            cornerLeftMode, cornerRightMode,
            hudLine1, hudLine2, hudLine3,
        };

        // 1. CLUSTER PANEL LAYERS (slot 0x203; unmapped when using map slot so right-side BC widget works!)
        if (panelAllowed) {
            // 1a. Zone 1: Below Speed Indicator (392..606, 429..513: aligned under speed digits, clear of map)
            const bsRect = {
                x: clamp(BELOW_SPEED_BASE.x + cx, 387, 412),
                y: clamp(BELOW_SPEED_BASE.y + cy, 429, 430),
                w: BELOW_SPEED_BASE.w,
                h: BELOW_SPEED_BASE.h,
            };
            const lBs = this._ensureOrLocal('below_speed', Object.assign({ target: 'panel', visible: true, z: 12 }, bsRect));
            this._paintBelowSpeed(lBs.cv, hero, heroCol, subText, subCol, gearDisplay === 'below_speed' ? dGearText : '', gearDisplay === 'below_speed', 108);
            this._setVisible('below_speed', true);
            this._upload('below_speed');

            // 1b. Zone 2: Shift Position Next to Stock 'D' (1463..1537, 650..706; strictly x >= 1461 clear of GEAR_WIN)
            const gdRect = {
                x: clamp(GEAR_D_BASE.x + cx, 1461, 1466),
                y: clamp(GEAR_D_BASE.y + cy, 648, 654),
                w: GEAR_D_BASE.w,
                h: GEAR_D_BASE.h,
            };
            const lGd = this._ensureOrLocal('gear_d', Object.assign({ target: 'panel', visible: false, z: 14 }, gdRect));
            const showGearDigit = gearDisplay === 'next_to_d' && inNormalD;
            const alertObj = s.smartAlerts !== false ? profile.alert : null;
            if (showGearDigit || alertObj) {
                this._paintGearNextToD(lGd.cv, showGearDigit ? String(Math.round(t.gear)) : '', alertObj);
                this._setVisible('gear_d', true);
                this._upload('gear_d');
            } else {
                this._setVisible('gear_d', false);
            }

            // 1c. Zone 3: Slim Friction Brake Force Rail (1280..1576, 609..640; hidden in Park; clear of Power % & needle)
            const brRect = {
                x: clamp(BRAKE_RAIL_BASE.x + cx, 1276, 1288),
                y: clamp(BRAKE_RAIL_BASE.y + cy, 599, 617),
                w: BRAKE_RAIL_BASE.w,
                h: BRAKE_RAIL_BASE.h,
            };
            const lBr = this._ensureOrLocal('brake_rail', Object.assign({ target: 'panel', visible: showBrakeRail, z: 13 }, brRect));
            if (showBrakeRail) {
                this._paintBrakeRail(lBr.cv, fg, brakeLit, Boolean(t.absActive), brakeMode === 'bar_num' && !brakeHold, t.brakeBar);
                this._setVisible('brake_rail', true);
                this._upload('brake_rail');
            } else {
                this._setVisible('brake_rail', false);
            }

            // 1d. Zone 4: Bottom-Left Oil + Coolant Temperatures (8..124, 643..709; large 22px bold text)
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

            // 1e. Zone 5: Bottom-Right HV Battery % SoC / Vital (1816..1914, 643..709; large 28px number)
            const crRect = {
                x: clamp(CORNER_RIGHT_BASE.x + cx, 1815, 1820),
                y: clamp(CORNER_RIGHT_BASE.y + cy, 643, 648),
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
        } else {
            CLUSTER_LAYER_NAMES.forEach((n) => this._setVisible(n, false));
        }

        // 2. HUD LAYER (3-line configurable upper-left slot, strictly y=100..201 above Assisted Driving / ACC y=202;
        //    also overlays cleanly on top of waze-on-cluster's HUD video when wocHudOn === true!)
        const hudY = clamp(HUD_BASE.y + hy, 100, 103);
        const hudX = clamp(HUD_BASE.x + hx, 120, 144);
        const lHud = this._ensureOrLocal('hud_main', {
            target: 'hud', klass: 'overlay', x: hudX, y: hudY, w: HUD_BASE.w, h: HUD_BASE.h, visible: showHud, z: 12,
        });
        if (showHud) {
            const alertHud = s.smartAlerts !== false ? profile.alert : null;
            this._paintHud(
                lHud.cv,
                [hudLine1, hudLine2, hudLine3],
                hero, heroCol, subText, subCol,
                gearDisplay !== 'off' ? dGearText : '',
                t, profile, units, fg, brakeLit, brakeHold, alertHud
            );
            this._setVisible('hud_main', true);
            this._upload('hud_main');
        } else {
            this._setVisible('hud_main', false);
        }

        // 2b. HUD NAVIGATION LAYER (264x264 full-height right-side slot x=412..676, y=108..372; yields for mini-map)
        if (showOwnHudNav) {
            const navX = clamp(HUD_NAV_BASE.x + hx, 406, 680 - HUD_NAV_W);
            const navY = clamp(HUD_NAV_BASE.y + hy, 100, 380 - HUD_NAV_H);
            const lHudNav = this._ensureOrLocal('hud_nav', {
                target: 'hud', klass: 'overlay', x: navX, y: navY, w: HUD_NAV_W, h: HUD_NAV_H, visible: true, z: 13,
            });
            const nk = hudNavKey(hn.show);
            if (nk !== this.lastHudNavKey || !lHudNav.prevBuf) {
                drawHudNav(lHudNav.cv, hn.show);
                this.lastHudNavKey = nk;
            }
            this._setVisible('hud_nav', true);
            this._upload('hud_nav');
        } else {
            this._setVisible('hud_nav', false);
        }

        // 3. MAP SLOT SIDE-BOTTOM OVERLAYS (0x100, contend: false — borderless white/blue + black outline,
        //    zero shifting between P and D, 312px unobstructed center route corridor, right BC widget intact!)
        if (showMapOverlay) {
            const msRect = {
                x: clamp(MAP_SPEED_RECT.x + cx, 8, 32),
                y: clamp(MAP_SPEED_RECT.y + cy, 297, 321),
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
        // Hero value right-edge aligns directly under BMW's main speed digits, keeping unit under 'mph'.
        const rx = typeof heroRightX === 'number' ? heroRightX : 108;
        drawTextOutline(cv, hero.value, rx, 43, 44, heroCol, { font: 'num', align: 'right' });
        const unitSize = String(hero.unit || '').length > 6 ? 17 : 21;
        drawTextOutline(cv, hero.unit, rx + 7, 39, unitSize, COL.softBlue, { font: 'bold', align: 'left' });
        // Fixed anchors so shifting P <-> D never shifts subText horizontally!
        if (reserveGearSlot) {
            drawTextOutline(cv, subText, rx + 22, 75, 22, subCol, { font: 'bold', align: 'right' });
            if (gearStr) {
                drawTextOutline(cv, gearStr, rx + 32, 75, 22, COL.white, { font: 'bold', align: 'left' });
            }
        } else {
            drawTextOutline(cv, subText, rx - 8, 75, 23, subCol, { font: 'bold', align: 'center' });
        }
    }

    _paintGearNextToD(cv, digitStr, alertObj) {
        cv.clear(COL.clear);
        // Baseline cv y=46 => world y=696, matching real-car BMW 'D' (world y=664..696)
        if (digitStr) {
            drawTextOutline(cv, digitStr, 3, 46, 42, COL.white, { font: 'bold', align: 'left' });
        }
        if (alertObj && alertObj.label) {
            const col = alertObj.severity === 'red' ? COL.red : COL.amber;
            const lbl = alertObj.label.length > 6 ? alertObj.label.slice(0, 6) : alertObj.label;
            drawTextOutline(cv, lbl, 28, 42, 14, col, { font: 'bold', align: 'left' });
        }
    }

    _paintBrakeRail(cv, fg, litCount, absActive, showNum, brakeBar) {
        cv.clear(COL.clear);
        const SEG_N = 20;
        const barX0 = 2;
        const barX1 = 294;
        const segW = (barX1 - barX0) / SEG_N;

        // Sweep right-to-left along shelf right above bottom bracket line (world y=630..637),
        // strictly below 'Power %' (y<=627) and left of CHARGE arc/needle (x<=1574).
        for (let i = 0; i < SEG_N; i++) {
            const sx1 = Math.round(barX1 - i * segW) - 1;
            const sx0 = Math.round(barX1 - (i + 1) * segW) + 2;
            let col = COL.railDim;
            if (litCount > 0 && i < litCount) {
                col = i >= 13 ? COL.red : (i >= 6 ? COL.orange : COL.amber);
            }
            cv.fillRect(sx0, 21, Math.max(2, sx1 - sx0), 7, col);
        }

        // Bold hydraulic bar (or g fallback) readout on far left (strictly x < 140 => world x < 1420, clear of 'Power %')
        if (litCount > 0 && showNum) {
            const hasBar = typeof brakeBar === 'number' && isFinite(brakeBar) && brakeBar >= 1.5;
            const valStr = hasBar ? (Math.round(brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
            const lbl = (absActive ? 'ABS ' : '') + valStr;
            const col = (fg >= 0.36 || absActive) ? COL.red : COL.amber;
            drawTextOutline(cv, lbl, 3, 15, 15, col, { font: 'bold', align: 'left' });
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
        drawTextOutline(cv, m.tag, cv.w - 4, 20, 16, COL.tagBlue, { font: 'bold', align: 'right' });
        drawTextOutline(cv, m.valText, cv.w - 4, 53, 28, m.col, { font: 'num', align: 'right' });
    }

    _paintHud(cv, lineModes, hero, heroCol, subText, subCol, gearStr, t, profile, units, fg, brakeLit, brakeHold, alertObj) {
        cv.clear(COL.clear); // Borderless 3-line black-outlined text (y=100..198, strictly above ACC y=202; crisp over Waze HUD!)
        const modes = Array.isArray(lineModes) ? lineModes.slice(0, 3) : ['efficiency', 'power_gear', 'brake'];
        const baselines = [35, 65, 90];
        const socStr = (typeof t.soc === 'number' && isFinite(t.soc)) ? ('SOC ' + Math.round(t.soc) + '%') : 'SOC --%';
        const socCol = (typeof t.soc === 'number' && t.soc <= 10) ? COL.red : ((typeof t.soc === 'number' && t.soc <= 20) ? COL.amber : COL.white);
        const oilStr = 'OIL ' + formatTemp(t.oilTempC, units).text;
        const coolStr = 'CL ' + formatTemp(t.coolantTempC, units).text;
        const tempCol = profile.isCold ? COL.icyBlue : COL.softBlue;

        for (let idx = 0; idx < 3; idx++) {
            const by = baselines[idx];
            if (idx === 2 && alertObj && alertObj.label) {
                const aCol = alertObj.severity === 'red' ? COL.red : COL.amber;
                drawTextOutline(cv, alertObj.label, 6, by, 19, aCol, { font: 'bold', align: 'left' });
                continue;
            }
            const m = modes[idx] || 'off';
            if (m === 'off') continue;
            if (m === 'efficiency') {
                const nSize = idx === 0 ? 40 : 24;
                const uSize = idx === 0 ? 19 : 16;
                const valW = drawTextOutline(cv, hero.value, 6, by, nSize, heroCol, { font: 'num', align: 'left' });
                drawTextOutline(cv, hero.unit, 12 + valW, by - 1, uSize, COL.softBlue, { font: 'bold', align: 'left' });
            } else if (m === 'power_gear') {
                const sz = idx === 0 ? 26 : (idx === 1 ? 22 : 19);
                const subW = drawTextOutline(cv, subText, 6, by, sz, subCol, { font: 'bold', align: 'left' });
                if (gearStr) {
                    const gx = Math.min(cv.w - 52, Math.max(122, Math.round(18 + subW)));
                    drawTextOutline(cv, gearStr, gx, by, sz, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'power') {
                const sz = idx === 0 ? 26 : (idx === 1 ? 22 : 19);
                drawTextOutline(cv, subText, 6, by, sz, subCol, { font: 'bold', align: 'left' });
            } else if (m === 'gear') {
                if (gearStr) {
                    const sz = idx === 0 ? 34 : (idx === 1 ? 24 : 20);
                    drawTextOutline(cv, gearStr, 6, by, sz, COL.white, { font: 'bold', align: 'left' });
                }
            } else if (m === 'soc') {
                const sz = idx === 0 ? 28 : (idx === 1 ? 22 : 19);
                drawTextOutline(cv, socStr, 6, by, sz, socCol, { font: 'bold', align: 'left' });
            } else if (m === 'soc_oil') {
                const sz = idx === 0 ? 22 : 19;
                drawTextOutline(cv, socStr + '   ' + oilStr, 6, by, sz, COL.softBlue, { font: 'bold', align: 'left' });
            } else if (m === 'temps') {
                const sz = idx === 0 ? 22 : 19;
                drawTextOutline(cv, oilStr + '   ' + coolStr, 6, by, sz, tempCol, { font: 'bold', align: 'left' });
            } else if (m === 'brake') {
                if (brakeLit > 0) {
                    const hSegs = 12;
                    const hLit = brakeHold ? 1 : clamp(Math.round((fg / 0.55) * hSegs), 1, hSegs);
                    const segY = by - 11;
                    for (let i = 0; i < hSegs; i++) {
                        const sx = 6 + i * 14;
                        const sc = i < hLit ? (i >= 8 ? COL.red : (i >= 4 ? COL.orange : COL.amber)) : COL.mapRailDim;
                        cv.fillRect(sx - 1, segY - 1, 13, 8, COL.outline);
                        cv.fillRect(sx, segY, 11, 6, sc);
                    }
                    if (!brakeHold && fg > 0.02) {
                        const hasBar = typeof t.brakeBar === 'number' && isFinite(t.brakeBar) && t.brakeBar >= 1.5;
                        const bStr = hasBar ? (Math.round(t.brakeBar) + ' bar') : (fg.toFixed(2) + 'g');
                        drawTextOutline(cv, bStr, 178, by - 3, 15, fg >= 0.36 ? COL.red : COL.amber, { font: 'bold', align: 'left' });
                    }
                }
            }
        }
    }

    /**
     * Borderless bottom-left map readout (map x=186..368, y=380..448):
     * White/blue text with 2px black outline, fixed column anchors so numbers never shift.
     */
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

    /**
     * Borderless bottom-right map readout (map x=680..908, y=374..448):
     *   - Top row (y=10..18): 14 dark-outlined friction brake segments (hidden in Park without shifting bottom row!)
     *   - Bottom row (y=60): Fixed left slot for D1..D8 (x<=82) + fixed right-anchored SOC % / Vital (x=222).
     *     Appearing/disappearing D1..D8 never shifts SOC % by even a single pixel!
     */
    _paintMapRight(cv, gearStr, t, units, cornerRightMode, showBrakeRail, showBrakeNum, fg, litCount, absActive, alertObj) {
        cv.clear(COL.clear);

        if (alertObj && alertObj.label) {
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
            drawTextOutline(cv, m.tag, valX - valW - 6, 58, 18, COL.tagBlue, { font: 'bold', align: 'right' });
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
        this.layers = {};
    }
}

module.exports = {
    OverlayRenderer,
    inspectClusterSlotConfig,
    changes,
    resolveCornerRightMode,
    BELOW_SPEED_BASE,
    GEAR_D_BASE,
    BRAKE_RAIL_BASE,
    CORNER_LEFT_BASE,
    CORNER_RIGHT_BASE,
    HUD_BASE,
    HUD_NAV_BASE,
    MAP_SPEED_RECT,
    MAP_LEFT_RECT,
    MAP_RIGHT_RECT,
    MAP_FALLBACK_RECT: MAP_RIGHT_RECT,
    CLUSTER_LAYER_NAMES,
    MAP_LAYER_NAMES,
};
