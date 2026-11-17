'use strict';
/**
 * nav_tracker.js - Read-only navigation & HUD mini-map state tracker.
 *
 * Adapted from cauliflowermossgrape/idrive7-apps (apps/redline/nav.js, MIT) with
 * G30 HUD Mini-Map (Junction View) detection:
 *   1. Reads next maneuver (arrow, highway branch/fork/exit, roundabout, U-turn,
 *      destination flag), formatted distance, street name, and lane guidance from
 *      GuidanceEventList.queryContent, Guidance.conclusiveDart, and
 *      Guidance / ProjectedModeGuiding.currentLaneGuiding.
 *   2. Detects when HUD guidance switches to an intersection Mini-Map WITHOUT
 *      relying on arbitrary distance thresholds:
 *        a) Live DCSM2 slot table (/run/cluster-render/status.txt): BMW HmiMain3D
 *           maps HUD map/junction scene 0x01000200 or 0x01000201 on slot 0x3xx.
 *        b) Lane-guidance-to-minimap swap: on BMW built-in Navigation, when
 *           currentLaneGuiding was active for the current maneuver (turnKey) and
 *           clears to empty while that exact same maneuver is still active (BMW
 *           replaced the lane box with the zoomed intersection mini-map).
 *        c) Waze-on-Cluster HUD projection (/run/waze-on-cluster/status.json):
 *           auto-hides when Waze-on-Cluster's own HUD map is enabled.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const fs = require('fs');

const STALE_MS = 3500;
const QUERY_MS = 1000;
const PROXY_RETRY_MS = 30000;
const CALL_BACKOFF_MS = 2000;
const FAILS_RECONNECT = 5;
const THEN_M = 150;
const STRAIGHT_DEG = 30;

const DEFAULT_CR_STATUS = '/run/cluster-render/status.txt';
const DEFAULT_WAZE_STATUS = '/run/waze-on-cluster/status.json';

const UNITS = { KM: 'km', METER: 'm', MILE_UK: 'mi', MILE_US: 'mi', YARD: 'yd', FEET: 'ft' };
const UNIT_M = { km: 1000, m: 1, mi: 1609.344, yd: 0.9144, ft: 0.3048 };
const FRACTIONS = { '\u00bd': '.5', '\u00bc': '.25', '\u00be': '.75' };

const isObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const str = (v) => (typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v) ? String(v) : null));
function mono() { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

const ENUMS = {
    TurnDirection: ['NONE', 'STRAIGHT_ON', 'LEFT', 'SLIGHT_LEFT', 'HARD_LEFT', 'RIGHT', 'SLIGHT_RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'UTURN_LEFT'],
    BranchType: [null, 'BRANCH_LEFT', 'BRANCH_RIGHT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_IN_RIGHT', 'HIGHWAY_IN_STRAIGHT', 'HIGHWAY_OUT_LEFT', 'HIGHWAY_OUT_RIGHT',
        'HIGHWAY_OUT_STRAIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'TRIPLE_FORK_LEFT', 'TRIPLE_FORK_RIGHT', 'TRIPLE_FORK_STRAIGHT', 'OVERPASS', 'UNDERPASS'],
    Side: [null, 'LEFT', 'RIGHT'],
    DestinationPosition: [null, 'LEFT', 'CENTER', 'RIGHT', 'NOT_DIGITIZED'],
    MainRoadDirection: ['LEFT', 'RIGHT'],
    VehicleTransportationType: ['FERRY', 'CAR_TRAIN'],
    AdditionalLaneInfo: ['NONE', 'ELLIPSIS', 'BUS', 'HOV', 'SCOOTER', 'BIKE', 'TOLL_ETC', 'TOLL_CASH', 'TOLL_ETC_CASH', 'BLOCKED'],
    LaneMarker: [null, 'SOLID', 'DASHED'],
    DistanceUnit: ['NONE', 'KM', 'MILE_UK', 'MILE_US', 'METER', 'YARD', 'FEET'],
    ProjectedModeGuidingProvider: ['NONE', 'CAR_PLAY', 'ANDROID_AUTO', 'CAR_LIFE', 'OTHER'],
    RenderedContentType: ['NONE', 'HIGH_GUIDING', 'JUNCTION_VIEW', 'CITY_HIGHWAY_MAP', 'SIGN_POST_INFO', 'SAPA', 'TUNNEL', 'SCREENSHOT', 'NOTIFY'],
    DisplayType: ['NONE', 'CID', 'IC', 'HUD'],
    ManeuverGeometry: [null, 'TWO_WAY_FORK_TAKE_LEFT', 'TWO_WAY_FORK_TAKE_RIGHT', 'THREE_WAY_FORK_TAKE_LEFT', 'THREE_WAY_FORK_TAKE_CENTER',
        'THREE_WAY_FORK_TAKE_RIGHT', 'EXIT_LEFT_TAKE_LEFT', 'EXIT_LEFT_TAKE_RIGHT', 'EXIT_RIGHT_TAKE_LEFT', 'EXIT_RIGHT_TAKE_RIGHT',
        'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_LEFT', 'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_RIGHT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT',
        'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_RIGHT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_RIGHT',
        'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_LEFT',
        'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_RIGHT',
        'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_RIGHT',
        'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_RIGHT',
        'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_RIGHT',
        'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_RIGHT'],
};

function enumOf(type, v) {
    const names = ENUMS[type];
    if (typeof v === 'string') return names.indexOf(v) >= 0 ? v : null;
    if (typeof v === 'number' && v >= 0 && v < names.length && v === Math.floor(v)) return names[v];
    return null;
}

function unionOf(e) {
    if (!isObj(e)) return null;
    const keys = Object.keys(e).filter((k) => isObj(e[k]));
    if (keys.length !== 1) return null;
    return { kind: keys[0], body: e[keys[0]] };
}

function safeStr(t) {
    return String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ').trim();
}

/**
 * Extract street/route text AND highway exit badge (`DescriptionElement.icon.text` or leading "Exit 14B")
 * from `GuidancePanel.description.elements`.
 */
function decodeDescription(b, isHighwayExit) {
    const els = b && b.description && Array.isArray(b.description.elements) ? b.description.elements : [];
    let exitBadge = null;
    const parts = [];

    for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (!isObj(el)) continue;
        if (isObj(el.icon) && typeof el.icon.text === 'string') {
            const ic = safeStr(el.icon.text);
            if (!ic) continue;
            const exMatch = /^(?:EXIT|AUSFAHRT|SORTIE)\s+([0-9]{1,4}[A-Z]?)$/i.exec(ic);
            if (!exitBadge && exMatch) {
                exitBadge = exMatch[1].toUpperCase();
            } else if (!exitBadge && i === 0 && (
                (isHighwayExit && /^[0-9]{1,4}[A-Z]?$/i.test(ic)) ||
                /^[0-9]{1,4}[A-Z]$/i.test(ic)
            )) {
                exitBadge = ic.toUpperCase();
            } else if (parts[parts.length - 1] !== ic) {
                parts.push(ic);
            }
        } else if (typeof el.text === 'string') {
            const tx = safeStr(el.text);
            if (tx && parts[parts.length - 1] !== tx) parts.push(tx);
        }
    }

    let road = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!exitBadge && road) {
        const leadExit = /^(?:EXIT|AUSFAHRT|SORTIE)\s+([0-9]{1,4}[A-Z]?)\b[\s:,\-\/]*(.*)$/i.exec(road);
        if (leadExit) {
            exitBadge = leadExit[1].toUpperCase();
            road = leadExit[2].trim();
        }
    }
    return { road, exitBadge };
}

function distOf(b) {
    const f = b && b.formattedDistance;
    const unitName = f ? enumOf('DistanceUnit', f.unit) : null;
    let d = f ? str(f.distance) : null;
    const u = unitName ? UNITS[unitName] : null;
    if (d !== null) {
        d = safeStr(d).replace(/^(\d*)([\u00bd\u00bc\u00be])/, (x, n, fr) => (n || '0') + FRACTIONS[fr]);
        if (u) d = d.replace(new RegExp('\\s*' + u + '$', 'i'), '').trim();
    }
    if (!d || !u || !/\d/.test(d)) return { dist: null, unit: null, uk: false };
    return { dist: d, unit: u, uk: unitName === 'MILE_UK' || unitName === 'YARD' };
}

function metres(m) {
    if (!m || !m.dist || !m.unit) return null;
    const t = String(m.dist).trim();
    const v = parseFloat(/^\d{1,3}([, ]\d{3})+$/.test(t) ? t.replace(/[, ]/g, '') : t.replace(',', '.'));
    return isFinite(v) ? v * UNIT_M[m.unit] : null;
}

const SKIP = {
    pointOfInterest: 1, laneGuiding: 1, trafficEvent: 1, trafficFlowItem: 1,
    routeSegmentItem: 1, placeholderElement: 1, tunnel: 1, border: 1, tollgate: 1,
    passiveManeuver: 1, speedLimitAssist: 1, speedLimit: 1, speedCamera: 1,
    speedSectionCamera: 1, dangerousCurve: 1, schoolZone: 1,
};

function decodeEvent(e) {
    const u = unionOf(e);
    if (!u || SKIP[u.kind]) return null;
    const b = u.body;
    const d = distOf(b);
    const dtd = Number(b.distanceToDestination);
    const branchDir = u.kind === 'branch' ? (enumOf('BranchType', b.branchType) || 'NONE') : null;
    const geom = (u.kind === 'intersection' || u.kind === 'branch') ? enumOf('ManeuverGeometry', b.detailedGeometry) : null;
    const isHwyExit = u.kind === 'branch' || /^EXIT_/.test(geom || '');
    const desc = decodeDescription(b, isHwyExit);
    const m = {
        kind: null, dir: null, geom: null, exit: null, exitAngle: null, side: null,
        flag: null, stop: null, dist: d.dist, unit: d.unit, uk: d.uk,
        road: desc.road, exitBadge: desc.exitBadge, unreliable: b.unreliable === true,
        dtd: isFinite(dtd) && dtd >= 0 ? dtd : null,
    };
    switch (u.kind) {
    case 'intersection':
        m.kind = 'turn';
        m.dir = enumOf('TurnDirection', b.direction) || 'NONE';
        m.geom = geom;
        break;
    case 'branch':
        m.kind = 'branch';
        m.dir = branchDir;
        m.geom = geom;
        break;
    case 'roundabout': {
        m.kind = 'roundabout';
        const n = Number(b.exitNumber);
        const a = Number(b.exitAngle);
        m.exit = isFinite(n) && n > 0 && n < 100 ? Math.round(n) : null;
        m.exitAngle = isFinite(a) && a >= -360 && a <= 720 ? ((a % 360) + 360) % 360 : null;
        m.side = enumOf('Side', b.driveDirection) === 'LEFT' ? 'left' : 'right';
        break;
    }
    case 'alongMainRoad':
        m.kind = 'keep';
        m.dir = enumOf('MainRoadDirection', b.mainRoadDirection) || 'NONE';
        break;
    case 'laneChange':
        m.kind = 'lanechange';
        m.dir = enumOf('Side', b.changeSide) || 'NONE';
        break;
    case 'destinationManeuver':
        m.kind = 'destination';
        m.dir = enumOf('DestinationPosition', b.position) || 'CENTER';
        m.flag = b.isCheckeredFlag !== false;
        m.stop = isFinite(Number(b.stopOverNumber)) && Number(b.stopOverNumber) > 0 ? Math.round(Number(b.stopOverNumber)) : null;
        break;
    case 'vehicleTransportation':
        m.kind = 'transport';
        m.dir = enumOf('VehicleTransportationType', b.type) || 'FERRY';
        break;
    default:
        if (!b.formattedDistance) return null;
        m.kind = 'follow';
        m.dir = u.kind;
    }
    return m;
}

function decodeEvents(reply) {
    const out = { ok: false, error: null, events: [], raw: 0, uids: [] };
    if (!isObj(reply)) { out.error = 'no reply'; return out; }
    const err = reply.GuidanceEventListError;
    if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { out.error = String(err); return out; }
    const v = Array.isArray(reply.viewContent) ? reply.viewContent[0] : null;
    const evs = v && Array.isArray(v.eventsInView) ? v.eventsInView : null;
    if (!evs) { out.error = 'no view'; return out; }
    out.ok = true;
    out.raw = evs.length;
    for (let i = 0; i < evs.length; i++) {
        const e = evs[i];
        const body = e && isObj(e.maneuver) ? e.maneuver : e;
        const m = decodeEvent(body);
        if (!m) continue;
        const u = unionOf(body);
        const uid = u && u.body ? Number(u.body.uid) : NaN;
        out.events.push(m);
        out.uids.push(isFinite(uid) ? uid : null);
    }
    return out;
}

function decodeDart(v) {
    return isObj(v) && isObj(v.maneuver) ? decodeEvent(v.maneuver) : null;
}

function decodeLanes(v) {
    const row = isObj(v) && Array.isArray(v.rows) ? v.rows[0] : null;
    if (!isObj(row) || !Array.isArray(row.lanes) || !row.lanes.length) return null;
    const list = (a) => (Array.isArray(a) ? a : []).map((x) => enumOf('TurnDirection', x)).filter((s) => s && s !== 'NONE');
    const lanes = row.lanes.slice(0, 16).map((rawLane) => {
        const l = isObj(rawLane) ? rawLane : {};
        let follows = list(l.directionsToFollow);
        const one = enumOf('TurnDirection', l.directionToFollow);
        if (one && one !== 'NONE' && follows.indexOf(one) < 0) follows = [one].concat(follows);
        const others = list(l.otherDirections).filter((d) => follows.indexOf(d) < 0);
        const rawHi = l.isHighlighted !== undefined ? l.isHighlighted : l.highlight;
        return {
            follow: follows[0] || 'NONE',
            follows: follows,
            others: others,
            hi: rawHi === true || Boolean(follows.length && rawHi !== false && rawHi !== 0),
            info: enumOf('AdditionalLaneInfo', l.additionalLaneInfo) || 'NONE',
        };
    });
    const rawRec = row.recommendedCarPositionLaneIndex !== undefined
        ? row.recommendedCarPositionLaneIndex
        : row.recommendedLaneIndex;
    const rec = Number(rawRec);
    const dtd = Number(row.distanceToDestination);
    return {
        lanes: lanes,
        rec: isFinite(rec) && rec >= 0 && rec < lanes.length ? rec : null,
        markers: Array.isArray(row.laneMarkers) ? row.laneMarkers.map((x) => enumOf('LaneMarker', x)) : [],
        dtd: isFinite(dtd) && dtd >= 0 ? dtd : null,
    };
}

function straightOn(m) {
    if (!m) return false;
    if (m.kind === 'turn') return m.dir === 'STRAIGHT_ON';
    if (m.kind === 'roundabout' && typeof m.exitAngle === 'number') {
        return Math.min(m.exitAngle, 360 - m.exitAngle) <= STRAIGHT_DEG;
    }
    return false;
}

function staleThen(uids) {
    return Boolean(uids && typeof uids[0] === 'number' && typeof uids[1] === 'number' && uids[1] < uids[0]);
}

function thenOf(a, b) {
    if (!a || !b || b.kind === 'follow') return null;
    const same = [a.kind, a.dir, a.geom, a.exit, a.road].join('|') === [b.kind, b.dir, b.geom, b.exit, b.road].join('|');
    let gap = null;
    let shown = false;
    if (a.dtd !== null && b.dtd !== null && a.dtd - b.dtd > 0) {
        gap = a.dtd - b.dtd;
        shown = true;
    } else if (metres(a) !== null && metres(b) !== null && metres(b) >= metres(a)) {
        gap = metres(b) - metres(a);
    }
    if (same && (gap === null || gap <= 0)) return null;
    if (gap === null) return b.dist === null && !straightOn(a) ? Object.assign({}, b, { gap: null }) : null;
    return gap <= THEN_M ? Object.assign({}, b, { gap: shown ? gap : null }) : null;
}

/**
 * Parse /run/cluster-render/status.txt for HUD slot (0x3xx) mappings.
 * HmiMain3D HUD scenes (verified in cluster-render src/slots.cpp):
 *   0x01000200, 0x01000201 -> BMW HUD Mini-Map / Junction View (NAVI_JV / NAVI_HG)
 *   0x01000210, 0x01000211 -> BMW HUD standard arrow/roadbook guidance
 */
function parseHudStatusText(txt) {
    const out = { miniMapScene: false, hudSlots: '' };
    if (!txt || typeof txt !== 'string') return out;
    const lines = txt.split(/\r?\n/);
    const slots = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.indexOf('slot 0x3') !== 0) continue;
        slots.push(line.replace(/^slot\s+/, ''));
        // Match 0x1000200 or 0x1000201 whenever assigned (status 1, e.g. map 0 parked behind 0x323!) or shown (status 2)
        if (/^slot\s+0x3[0-9a-f]+\s+(?:status\s+)?[12]\b.*?\b0x0?100020[01]\b/i.test(line)) {
            out.miniMapScene = true;
        }
    }
    out.hudSlots = slots.join('; ');
    return out;
}

function parseWazeHudShowing(txt) {
    if (!txt || typeof txt !== 'string') return false;
    try {
        const st = JSON.parse(txt);
        if (!st || typeof st !== 'object') return false;
        if (typeof st.hud_state === 'string') return st.hud_state === 'showing';
        if (typeof st.hudState === 'string') return st.hudState === 'showing';
        if (st.state === 'showing' && (st.target === 'hud' || st.target === 'both')) return true;
    } catch (e) { /* ignore */ }
    return false;
}

function decodeRenderedContent(rawContent) {
    const vc = isObj(rawContent) && isObj(rawContent.viewContent) ? rawContent.viewContent : rawContent;
    if (!isObj(vc)) return null;
    const sceneId = typeof vc.ramsesSceneId === 'number' && isFinite(vc.ramsesSceneId) ? vc.ramsesSceneId : 0;
    const rawCt = isObj(vc.type) ? vc.type.contentType : vc.contentType;
    const ct = enumOf('RenderedContentType', rawCt) || (typeof rawCt === 'string' && rawCt ? rawCt : 'NONE');
    const isMapType = ct === 'HIGH_GUIDING' || ct === 'JUNCTION_VIEW' || ct === 'CITY_HIGHWAY_MAP' || ct === 'TUNNEL' ||
        (ct !== 'NONE' && (sceneId === 0x01000200 || sceneId === 0x01000201));
    return { contentType: ct, ramsesSceneId: sceneId, isMapType };
}

function eventQuery() {
    return {
        viewConfigs: [{
            viewport: {
                startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] },
                maxElementCount: 6,
                endPoints: [],
                includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_LANE_GUIDINGS', 'INCLUDE_ALONG_MAIN_ROAD', 'INCLUDE_DESTINATIONS'],
            },
            options: [],
            minimumUpdateIntervalMs: 1000,
            segmentItemRasterLength: 100,
        }],
    };
}

class NavTracker {
    constructor(opts) {
        const o = opts || {};
        this.crStatusPath = o.crStatusPath || process.env.CLUSTER_RENDER_STATUS_PATH || DEFAULT_CR_STATUS;
        this.wazeStatusPath = o.wazeStatusPath || process.env.WAZE_STATUS_PATH || DEFAULT_WAZE_STATUS;
        this.route = { state: null, provider: null, carplay: false, aa: false, sureSeen: false, resetAt: -Infinity };
        this.turn = null;
        this.turnAt = -Infinity;
        this.dart = null;
        this.dartAt = -Infinity;
        this.lanes = null;
        this.lanesAt = -Infinity;
        this.turnKey = '';
        this.lanesSeenForTurn = false;
        this.lanesSwitchedToMiniMap = false;
        this.viewTargets = Object.create(null); // viewId -> 'HUD' | 'IC' | 'CID' | 'NONE'
        this.viewStates = Object.create(null);  // viewId -> { contentType, ramsesSceneId, isMapType }
        this.hudViewSeen = false;
        this.hudRenderedMiniMap = false;
        this.hudRenderedReason = '';
        this.rawNextIntersection = null;
        this.lastStatusPoll = 0;
        this.dcsmMiniMap = false;
        this.hudSlots = '';
        this.wocHudShowing = false;
        this.lastErr = null;
        this._subs = [];
        this._elTimer = null;
        this._stopped = false;
    }

    routeSure() {
        const r = this.route;
        return r.state === 'ACTIVE' || r.state === 2 || r.carplay === true || r.aa === true;
    }

    routing() {
        const r = this.route;
        if (r.sureSeen) return this.routeSure();
        return this.routeSure() || (r.provider !== null && r.provider !== undefined && r.provider !== 'NONE' && r.provider !== 0);
    }

    guideSource() {
        const r = this.route;
        if (r.carplay) return 'CAR_PLAY';
        if (r.aa) return 'ANDROID_AUTO';
        const p = r.provider && r.provider !== 'NONE' && r.provider !== 0 ? String(r.provider) : 'BMW';
        if (r.sureSeen && ((p === 'CAR_PLAY' && !r.carplay) || (p === 'ANDROID_AUTO' && !r.aa))) return 'BMW';
        return p;
    }

    phonesMismatch() {
        const r = this.route;
        if (r.carplay === true && r.aa === true) return true;
        return (r.provider === 'CAR_PLAY' && r.aa === true && r.carplay !== true) ||
            (r.provider === 'ANDROID_AUTO' && r.carplay === true && r.aa !== true);
    }

    _keyOf(m) {
        return m ? [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.road].join('|') : '';
    }

    _noteManeuver(m, nowMs) {
        if (!m) return;
        const k = this._keyOf(m);
        if (k !== this.turnKey) {
            if (this.turnKey !== '' && this.lanesAt <= nowMs - 200) {
                this.lanes = null;
            }
            this.turnKey = k;
            this.lanesSeenForTurn = Boolean(this.lanes);
            this.lanesSwitchedToMiniMap = false;
        }
    }

    _reset(nowMs) {
        this.turn = null;
        this.dart = null;
        this.lanes = null;
        this.turnKey = '';
        this.lanesSeenForTurn = false;
        this.lanesSwitchedToMiniMap = false;
        this.hudRenderedMiniMap = false;
        this.hudRenderedReason = '';
        const vkeys = Object.keys(this.viewStates);
        for (let i = 0; i < vkeys.length; i++) {
            this.viewStates[vkeys[i]] = { contentType: 'NONE', ramsesSceneId: 0, isMapType: false };
        }
        this.route.resetAt = nowMs;
    }

    _isHudView(viewId, st) {
        const tgt = this.viewTargets[viewId];
        if (tgt === 'HUD') return true;
        if (tgt && tgt !== 'HUD') return false;
        if (st && st.ramsesSceneId >= 0x01000200 && st.ramsesSceneId <= 0x010002FF) return true;
        if (st && st.ramsesSceneId >= 0x01000300 && st.ramsesSceneId <= 0x010003FF) return false;
        const vid = String(viewId || '');
        if (/cid|kombi|\bic\b|cluster/i.test(vid)) return false;
        return /hud/i.test(vid);
    }

    _recomputeRenderedHud() {
        let seenHud = false;
        let mapOn = false;
        let reason = '';
        const tKeys = Object.keys(this.viewTargets);
        for (let i = 0; i < tKeys.length; i++) {
            if (this.viewTargets[tKeys[i]] === 'HUD') seenHud = true;
        }
        const sKeys = Object.keys(this.viewStates);
        for (let i = 0; i < sKeys.length; i++) {
            const vid = sKeys[i];
            const st = this.viewStates[vid];
            if (!this._isHudView(vid, st)) continue;
            seenHud = true;
            if (st && st.isMapType) {
                mapOn = true;
                reason = 'bmw_' + String(st.contentType || 'minimap').toLowerCase();
            }
        }
        this.hudViewSeen = seenHud;
        this.hudRenderedMiniMap = mapOn;
        this.hudRenderedReason = reason;
    }

    feedRenderedConfig(viewId, reply) {
        if (!viewId) return;
        const vc = isObj(reply) && isObj(reply.viewConfig) ? reply.viewConfig : reply;
        const rawTgt = isObj(vc) ? vc.targetUI : null;
        const tgt = enumOf('DisplayType', rawTgt);
        if (tgt) {
            this.viewTargets[String(viewId)] = tgt;
            this._recomputeRenderedHud();
        }
    }

    feedRenderedContent(viewId, rawContent) {
        const vid = String(viewId || 'default');
        const dec = decodeRenderedContent(rawContent);
        if (!dec) return null;
        this.viewStates[vid] = dec;
        this._recomputeRenderedHud();
        return dec;
    }

    feedField(src, name, v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : mono();
        const was = this.routing();
        const wasSure = this.routeSure();
        const oldGuide = this.guideSource();

        if (name === 'available') {
            if (v !== false) return;
            if (src === 'carplay') this.route.carplay = false;
            else if (src === 'androidauto') this.route.aa = false;
            else if (src === 'guidance') { this.route.state = null; this.route.provider = null; this.dart = null; }
        } else if (src === 'guidance' && name === 'guidanceState') {
            this.route.state = v;
        } else if (src === 'guidance' && name === 'guidingProvider') {
            this.route.provider = (v === null || v === undefined) ? null : (enumOf('ProjectedModeGuidingProvider', v) || String(v));
        } else if (name === 'projectedGuidanceActive') {
            const act = (isObj(v) && 'projectedGuidanceActive' in v) ? v.projectedGuidanceActive : v;
            if (typeof act === 'boolean') this.route[src === 'carplay' ? 'carplay' : 'aa'] = act;
        } else if (name === 'conclusiveDart') {
            this.dart = decodeDart(v);
            this.dartAt = now;
            this._noteManeuver(this.dart, now);
        } else if (name === 'currentLaneGuiding') {
            // Ignore empty phone lanes when BMW native nav is guiding (and vice versa)
            const g = this.guideSource();
            if ((src === 'phone' && g === 'BMW') || (src === 'guidance' && (g === 'CAR_PLAY' || g === 'ANDROID_AUTO') && this.lanes && !decodeLanes(v))) {
                return;
            }
            const decoded = decodeLanes(v);
            if (decoded) {
                this.lanes = decoded;
                this.lanesAt = now;
                if (this.turnKey !== '') this.lanesSeenForTurn = true;
                this.lanesSwitchedToMiniMap = false;
            } else {
                // Non-distance mini-map transition detection:
                // On BMW built-in Navigation, when lane guidance was active for the current maneuver
                // and clears to empty while the exact same maneuver & active route continue,
                // BMW has swapped the lane guidance row out for its zoomed intersection mini-map!
                if (this.lanes && this.lanesSeenForTurn && this.turnKey !== '' && g === 'BMW' && this.routing()) {
                    const cur = this.currentManeuver(now);
                    const sameSegment = !(typeof this.lanes.dtd === 'number' && cur && typeof cur.dtd === 'number') ||
                        Math.abs(this.lanes.dtd - cur.dtd) <= 350;
                    if (cur && this._keyOf(cur) === this.turnKey && !straightOn(cur) && sameSegment) {
                        this.lanesSwitchedToMiniMap = true;
                    }
                }
                this.lanes = null;
                this.lanesAt = now;
            }
        } else if (name === 'nextIntersection') {
            this.rawNextIntersection = v;
        }

        if (this.routeSure()) this.route.sureSeen = true;
        if (name === 'projectedGuidanceActive') {
            const act = (isObj(v) && 'projectedGuidanceActive' in v) ? v.projectedGuidanceActive : v;
            if (act === false && this.route.provider === (src === 'carplay' ? 'CAR_PLAY' : 'ANDROID_AUTO')) {
                this.route.sureSeen = true;
            }
        }

        const is = this.routing();
        if ((was && !is) || (wasSure && !this.routeSure()) || this.guideSource() !== oldGuide) {
            this._reset(now);
        }
    }

    feedEvents(reply, nowMs, askedAt) {
        const now = typeof nowMs === 'number' ? nowMs : mono();
        if (typeof askedAt === 'number' && askedAt < this.route.resetAt) return { ok: false, stale: true };
        const r = decodeEvents(reply);
        if (!r.ok) { this.lastErr = r.error; return r; }
        this.lastErr = null;
        if (r.events[0]) {
            this.turn = Object.assign({}, r.events[0], {
                then: staleThen(r.uids) ? null : thenOf(r.events[0], r.events[1]),
            });
            this.turnAt = now;
            this._noteManeuver(this.turn, now);
        } else {
            this.turn = null;
            this.turnAt = now;
        }
        return r;
    }

    currentManeuver(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : mono();
        const dartOk = this.dart && (now - this.dartAt <= STALE_MS || this.route.state === 'ACTIVE' || this.route.state === 2);
        const m = (this.turn && now - this.turnAt <= STALE_MS) ? this.turn : (dartOk ? this.dart : null);
        if (!m) return null;
        return Object.assign({}, m, { lanes: this.lanes });
    }

    _pollStatusFiles(nowWallMs) {
        if (nowWallMs - this.lastStatusPoll < 500) return;
        this.lastStatusPoll = nowWallMs;
        try {
            const crTxt = fs.readFileSync(this.crStatusPath, 'utf8');
            const parsed = parseHudStatusText(crTxt);
            this.dcsmMiniMap = parsed.miniMapScene;
            this.hudSlots = parsed.hudSlots;
        } catch (e) {
            this.dcsmMiniMap = false;
            this.hudSlots = '';
        }
        try {
            const wTxt = fs.readFileSync(this.wazeStatusPath, 'utf8');
            this.wocHudShowing = parseWazeHudShowing(wTxt);
        } catch (e) {
            this.wocHudShowing = false;
        }
    }

    snapshot(nowWallMs, nowMonoMs) {
        const wall = typeof nowWallMs === 'number' ? nowWallMs : Date.now();
        const mNow = typeof nowMonoMs === 'number' ? nowMonoMs : mono();
        this._pollStatusFiles(wall);

        const routeActive = this.routing() && !this.phonesMismatch();
        const show = routeActive ? this.currentManeuver(mNow) : null;
        const hasLanes = Boolean(show && show.lanes && show.lanes.lanes && show.lanes.lanes.length > 0);
        const guide = routeActive ? this.guideSource() : 'NONE';

        let miniMapActive = false;
        let miniMapReason = '';
        if (!this.wocHudShowing && routeActive && this.hudRenderedMiniMap) {
            miniMapActive = true;
            miniMapReason = this.hudRenderedReason || 'bmw_minimap';
        } else if (!this.wocHudShowing && routeActive && this.dcsmMiniMap) {
            miniMapActive = true;
            miniMapReason = 'dcsm_0x1000200';
        } else if (!this.wocHudShowing && routeActive && guide === 'BMW' && !this.hudViewSeen && this.lanesSwitchedToMiniMap) {
            miniMapActive = true;
            miniMapReason = 'lanes_to_minimap';
        }

        let summary = 'No active route';
        if (this.wocHudShowing) {
            summary = 'Waze HUD map (overlaying metrics)';
        } else if (routeActive) {
            if (show) {
                summary = guide + ': ' + show.kind + ' ' + (show.dir || (show.exit ? 'exit ' + show.exit : '')) +
                    (show.dist ? ' ' + show.dist + (show.unit || '') : '') +
                    (hasLanes ? ' [' + show.lanes.lanes.length + ' lanes]' : '');
            } else {
                summary = guide + ': route active (waiting for turn)';
            }
            if (miniMapActive) summary += ' -> MINI-MAP (' + miniMapReason + ')';
        }

            return {
                routeActive,
                guide,
                show,
                hasLanes,
                miniMapActive,
                miniMapReason,
                hudViewSeen: this.hudViewSeen,
                wocHudShowing: this.wocHudShowing,
                hudSlots: this.hudSlots,
                rawNextIntersection: this.rawNextIntersection,
                summary,
            };
    }

    start(ctx, log, wantedFn) {
        this._stopped = false;
        if (!ctx || !ctx.signals || typeof ctx.signals.watch !== 'function') return;
        const sources = [
            {
                name: 'guidance',
                iface: 'de.bmw.infotainment.navigation.guiding.Guidance',
                inst: 'Main_Instance',
                fields: ['guidanceState', 'guidingProvider', 'conclusiveDart', 'currentLaneGuiding', 'nextIntersection'],
            },
            {
                name: 'phone',
                iface: 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding',
                inst: 'Main_Instance',
                fields: ['currentLaneGuiding'],
            },
            {
                name: 'carplay',
                iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager',
                inst: 'CarPlayManagerInst1',
                fields: ['projectedGuidanceActive'],
            },
            {
                name: 'androidauto',
                iface: 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager',
                inst: 'AndroidAutoProjectedManagerInst1',
                fields: ['projectedGuidanceActive'],
            },
        ];

        for (let i = 0; i < sources.length; i++) {
            const S = sources[i];
            const handlers = {};
            for (let j = 0; j < S.fields.length; j++) {
                const f = S.fields[j];
                handlers[f] = (v) => this.feedField(S.name, f, v, mono());
            }
            try {
                const p = ctx.signals.watch(S.iface, S.inst, handlers, log);
                if (p && typeof p.then === 'function') {
                    p.then((res) => {
                        if (!res) return;
                        if (this._stopped) {
                            try { if (res.shutdown) res.shutdown(); } catch (e) { /* ignore */ }
                            return;
                        }
                        this._subs.push(res);
                    }).catch(() => {});
                } else if (p) {
                    this._subs.push(p);
                }
            } catch (e) { /* optional signal */ }
        }

        // First-party BMW HUD Mini-Map / Junction View state via GuidanceRenderedContent (service 64284)
        let rcProxy = null;
        let rcPolling = false;
        const knownViewIds = Object.create(null);
        const queriedConfigs = Object.create(null);
        const pollHudViewContent = (id) => {
            if (!id || !rcProxy || !ctx.signals.call) return Promise.resolve();
            return ctx.signals.call(rcProxy, 'getViewContent', { viewId: id }, 900)
                .then((cntReply) => { this.feedRenderedContent(id, cntReply); })
                .catch(() => {});
        };
        const inspectViewId = (vid) => {
            const id = typeof vid === 'string' ? vid : '';
            if (!id) return;
            knownViewIds[id] = true;
            if (!rcProxy || !ctx.signals.call || queriedConfigs[id]) return;
            queriedConfigs[id] = true;
            ctx.signals.call(rcProxy, 'getViewConfig', { viewId: id }, 1500)
                .then((cfgReply) => {
                    this.feedRenderedConfig(id, cfgReply);
                    if (this._isHudView(id, this.viewStates[id])) {
                        return pollHudViewContent(id);
                    }
                    return null;
                })
                .catch(() => { queriedConfigs[id] = false; });
        };

        try {
            const rcWatch = ctx.signals.watch(
                'de.bmw.infotainment.navigation.guiding.GuidanceRenderedContent',
                'Main_Instance',
                {
                    registeredViews: (v) => {
                        const list = Array.isArray(v) ? v : (isObj(v) && Array.isArray(v.registeredViews) ? v.registeredViews : []);
                        for (let i = 0; i < list.length; i++) inspectViewId(list[i]);
                    },
                },
                log
            );
            Promise.resolve(rcWatch).then((res) => {
                if (!res) return;
                if (this._stopped) {
                    try { if (res.shutdown) res.shutdown(); } catch (e) { /* ignore */ }
                    return;
                }
                this._subs.push(res);
                if (res.proxy) {
                    rcProxy = res.proxy;
                    // Flush any registeredViews that arrived synchronously before rcWatch resolved!
                    Object.keys(knownViewIds).forEach((id) => inspectViewId(id));
                    if (typeof ctx.signals.on === 'function') {
                        ctx.signals.on(rcProxy, 'viewContentChanged', (arg0, arg1) => {
                            let vid = '';
                            let payload = arg0;
                            if (typeof arg0 === 'string') {
                                vid = arg0;
                                payload = arg1 !== undefined ? arg1 : arg0;
                            } else if (isObj(arg0)) {
                                vid = typeof arg0.viewId === 'string' ? arg0.viewId : '';
                                payload = arg0.viewContent !== undefined ? arg0.viewContent : arg0;
                            }
                            if (vid) inspectViewId(vid);
                            this.feedRenderedContent(vid || 'hud', payload);
                        }, log);
                    }
                }
            }).catch(() => {});
        } catch (e) { /* optional on non-nav units */ }

        let elProxy = null;
        let proxyFailedAt = -Infinity;
        let callFailedAt = -Infinity;
        let callFails = 0;
        let asking = false;
        const want = typeof wantedFn === 'function' ? wantedFn : () => true;

        const ask = () => {
            const now = mono();
            if (this._stopped || !this.routing() || !want()) return;
            // Also actively poll HUD RenderedContent at 1 Hz while routing so missed broadcasts never leave mini-map stuck!
            if (rcProxy && !rcPolling && ctx.signals.call) {
                const vIds = Object.keys(knownViewIds);
                const hudIds = vIds.filter((id) => !queriedConfigs[id] || this._isHudView(id, this.viewStates[id]));
                if (hudIds.length) {
                    rcPolling = true;
                    Promise.all(hudIds.map((id) => {
                        if (!queriedConfigs[id]) { inspectViewId(id); return Promise.resolve(); }
                        return pollHudViewContent(id);
                    })).then(() => { rcPolling = false; }, () => { rcPolling = false; });
                }
            }
            if (asking) return;
            if (!ctx.signals.proxy || !ctx.signals.call) return;
            if (callFails >= 2 && now - callFailedAt < CALL_BACKOFF_MS) return;
            if (!elProxy && now - proxyFailedAt < PROXY_RETRY_MS) return;
            asking = true;
            const askedAt = now;
            Promise.resolve().then(() => {
                if (elProxy) return elProxy;
                return ctx.signals.proxy('de.bmw.infotainment.navigation.guiding.GuidanceEventList', 'Main_Instance')
                    .then((px) => { elProxy = px; return px; }, (err) => { proxyFailedAt = mono(); throw err; });
            }).then((px) => ctx.signals.call(px, 'queryContent', eventQuery(), 900))
                .then((reply) => {
                    callFails = 0;
                    this.feedEvents(reply, mono(), askedAt);
                }).catch((err) => {
                    this.lastErr = String((err && err.message) || err).slice(0, 160);
                    if (elProxy) {
                        callFailedAt = mono();
                        callFails++;
                        if (callFails >= FAILS_RECONNECT) {
                            elProxy = null;
                            callFails = 0;
                            proxyFailedAt = mono();
                        }
                    }
                }).then(() => { asking = false; });
        };

        this._elTimer = setInterval(ask, QUERY_MS);
        if (this._elTimer && typeof this._elTimer.unref === 'function') this._elTimer.unref();
    }

    stop() {
        this._stopped = true;
        if (this._elTimer) {
            clearInterval(this._elTimer);
            this._elTimer = null;
        }
        for (let i = 0; i < this._subs.length; i++) {
            const s = this._subs[i];
            try {
                if (s && typeof s.stop === 'function') s.stop();
                else if (s && typeof s.shutdown === 'function') s.shutdown();
            } catch (e) { /* ignore */ }
        }
        this._subs = [];
    }
}

module.exports = {
    NavTracker,
    decodeEvent,
    decodeEvents,
    decodeLanes,
    decodeDart,
    decodeRenderedContent,
    parseHudStatusText,
    parseWazeHudShowing,
    metres,
};
