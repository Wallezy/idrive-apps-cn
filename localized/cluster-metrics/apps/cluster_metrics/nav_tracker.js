'use strict';
/**
 * nav_tracker.js - Read-only navigation & G30 HUD mini-map state tracker.
 *
 * Uses Redline's GuidanceEventList / Guidance maneuver decoders (`redline_nav`) and layers
 * G30-specific capabilities on top:
 *   1. Highway exit badge extraction from `DescriptionElement.icon.text` ("14B") or leading "Exit ...".
 *   2. Highway `passiveManeuver` promotion when a real maneuver follows within 300 m.
 *   3. Exact intersection Mini-Map (Junction View) auto-yield detection without distance hacks:
 *        a) GuidanceRenderedContent HUD view (`HIGH_GUIDING`, `JUNCTION_VIEW`, `CITY_HIGHWAY_MAP`, `TUNNEL`)
 *        b) Live DCSM2 slot table (/run/cluster-render/status.txt, mapped `0x01000200`/`0x01000201`)
 *        c) Lane-guidance-to-minimap clearing on BMW built-in nav + Waze-on-Cluster HUD status
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const fs = require('fs');
const {
    decodeEvent: baseDecodeEvent,
    decodeLanes,
    metres,
    straightOn,
    staleThen,
    thenOf,
    enumOf,
    unionOf,
    distOf,
} = require('./redline_nav');

const STALE_MS = 6000;
const QUERY_MS = 1000;
const QUERY_TIMEOUT_MS = 1800;
const PROXY_RETRY_MS = 30000;
const CALL_BACKOFF_MS = 2000;
const FAILS_RECONNECT = 5;
const LANES_MINIMAP_MAX_MS = 18000;
const NO_TURN_FALLBACK_MS = 5000;

const DEFAULT_CR_STATUS = '/run/cluster-render/status.txt';
const DEFAULT_WAZE_STATUS = '/run/waze-on-cluster/status.json';

const RENDERED_CONTENT_TYPES = [
    'NONE', 'HIGH_GUIDING', 'JUNCTION_VIEW', 'CITY_HIGHWAY_MAP',
    'SIGN_POST_INFO', 'SAPA', 'TUNNEL', 'SCREENSHOT', 'NOTIFY',
];
const DISPLAY_TYPES = ['NONE', 'CID', 'IC', 'HUD'];

const isObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
function mono() { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

function enumName(list, v) {
    if (typeof v === 'string') return list.indexOf(v) >= 0 ? v : null;
    if (typeof v === 'number' && v >= 0 && v < list.length && v === Math.floor(v)) return list[v];
    return null;
}

function safeStr(t) {
    return String(t || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ').trim();
}

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

function decodeEvent(e) {
    const u = unionOf(e);
    if (!u) return null;
    const b = u.body;

    if (u.kind === 'passiveManeuver') {
        const d = distOf(b);
        if (!d.dist) return null;
        const dtd = Number(b.distanceToDestination);
        const desc = decodeDescription(b, false);
        return {
            kind: 'turn',
            dir: 'STRAIGHT_ON',
            geom: null,
            exit: null,
            exitAngle: null,
            side: null,
            flag: null,
            stop: null,
            passive: true,
            dist: d.dist,
            unit: d.unit,
            uk: d.uk,
            road: desc.road,
            exitBadge: desc.exitBadge,
            unreliable: b.unreliable === true,
            dtd: isFinite(dtd) && dtd >= 0 ? dtd : null,
        };
    }

    const base = baseDecodeEvent(e);
    if (!base) return null;
    const isHwyExit = base.kind === 'branch' || /^EXIT_/.test(base.geom || '');
    const desc = decodeDescription(b, isHwyExit);
    base.passive = false;
    base.road = desc.road;
    base.exitBadge = desc.exitBadge;
    return base;
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
    if (out.events.length >= 2 && out.events[0].passive && !out.events[1].passive) {
        const d1 = metres(out.events[1]);
        if (d1 !== null && d1 <= 300) {
            out.events.shift();
            out.uids.shift();
        }
    }
    return out;
}

function decodeNextIntersection(v) {
    if (!isObj(v)) return null;
    const d = distOf({ formattedDistance: v.distance });
    const desc = decodeDescription({ description: v.intersection }, false);
    if (!d.dist && !desc.road) return null;
    return {
        kind: 'turn',
        dir: 'STRAIGHT_ON',
        geom: null,
        exit: null,
        exitAngle: null,
        side: null,
        flag: null,
        stop: null,
        dist: d.dist,
        unit: d.unit,
        uk: d.uk,
        road: desc.road,
        exitBadge: desc.exitBadge,
        unreliable: false,
        dtd: null,
    };
}

function decodeDart(v) {
    return isObj(v) && isObj(v.maneuver) ? decodeEvent(v.maneuver) : null;
}

function parseHudStatusText(txt) {
    const out = { miniMapScene: false, stockGuidanceScene: false, hudSlots: '' };
    if (!txt || typeof txt !== 'string') return out;
    const lines = txt.split(/\r?\n/);
    const slots = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const hdr = /^slot\s+(0x3[0-9a-f]+)\s+(?:status\s+)?(\d+)\s*:\s*(.*)$/i.exec(line);
        if (!hdr) continue;
        const slotHex = hdr[1].toLowerCase();
        const slotSt = parseInt(hdr[2], 10);
        const entries = hdr[3].split(',');
        const shortEnts = [];
        for (let k = 0; k < entries.length; k++) {
            const em = /0x([0-9a-f]+)\s+class\s+\d+\s+map\s+(\d+)/i.exec(entries[k]);
            if (!em) continue;
            const contentHex = em[1].toLowerCase();
            const contentId = parseInt(contentHex, 16);
            const mapSt = parseInt(em[2], 10);
            const shortContent = contentHex.replace(/^0+/, '') || '0';
            shortEnts.push(shortContent + '@m' + mapSt);
            if (contentId === 0x01000200 || contentId === 0x01000201) {
                out.stockGuidanceScene = true;
                if (mapSt >= 1 && mapSt <= 3 && (slotSt === 1 || slotSt === 2)) {
                    out.miniMapScene = true;
                }
            } else if (contentId === 0x01000210 || contentId === 0x01000211) {
                out.stockGuidanceScene = true;
            }
        }
        slots.push(slotHex + ' s' + slotSt + ':' + (shortEnts.join(',') || 'empty'));
    }
    out.hudSlots = slots.join(' | ');
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
    const ct = enumName(RENDERED_CONTENT_TYPES, rawCt) || (typeof rawCt === 'string' && rawCt ? rawCt : 'NONE');
    const isMapType = ct === 'HIGH_GUIDING' || ct === 'JUNCTION_VIEW' || ct === 'CITY_HIGHWAY_MAP' || ct === 'TUNNEL' ||
        (ct !== 'NONE' && (sceneId === 0x01000200 || sceneId === 0x01000201));
    const assoc = isObj(vc.associatedEvent) ? decodeEvent(vc.associatedEvent) : null;
    return { contentType: ct, ramsesSceneId: sceneId, isMapType, assoc };
}

function eventQuery() {
    return {
        viewConfigs: [{
            viewport: {
                startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] },
                maxElementCount: 10,
                endPoints: [],
                includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_ALONG_MAIN_ROAD', 'INCLUDE_DESTINATIONS', 'INCLUDE_PASSIVE_MANEUVER_JCT'],
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
        this.renderedTurn = null;
        this.renderedTurnAt = -Infinity;
        this.nextInt = null;
        this.nextIntAt = -Infinity;
        this.lanes = null;
        this.lanesAt = -Infinity;
        this.turnKey = '';
        this.lanesSeenForTurn = false;
        this.lanesSwitchedToMiniMap = false;
        this.lanesMiniMapSince = 0;
        this.routeActiveSince = 0;
        this.lastValidShowAt = -Infinity;
        this.viewTargets = Object.create(null);
        this.viewStates = Object.create(null);
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

    _reset(nowMs, keepBmwDart) {
        this.turn = null;
        if (!keepBmwDart) {
            this.dart = null;
            this.renderedTurn = null;
            this.nextInt = null;
        }
        this.lanes = null;
        this.turnKey = '';
        this.lanesSeenForTurn = false;
        this.lanesSwitchedToMiniMap = false;
        this.lanesMiniMapSince = 0;
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
        let tgt = enumName(DISPLAY_TYPES, rawTgt);
        if ((!tgt || tgt === 'NONE') && isObj(vc) && Array.isArray(vc.options)) {
            for (let i = 0; i < vc.options.length && (!tgt || tgt === 'NONE'); i++) {
                const sc = vc.options[i] && vc.options[i].sceneConfig;
                const ids = sc && Array.isArray(sc.possibleSceneIds) ? sc.possibleSceneIds : [];
                for (let j = 0; j < ids.length; j++) {
                    const id = Number(ids[j]);
                    if (id >= 0x01000200 && id <= 0x010002FF) { tgt = 'HUD'; break; }
                    if (id >= 0x01000300 && id <= 0x010003FF) { tgt = 'IC'; break; }
                }
            }
        }
        if (tgt && tgt !== 'NONE') {
            this.viewTargets[String(viewId)] = tgt;
            this._recomputeRenderedHud();
        }
    }

    feedRenderedContent(viewId, rawContent, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : mono();
        const vid = String(viewId || 'default');
        const dec = decodeRenderedContent(rawContent);
        if (!dec) return null;
        this.viewStates[vid] = dec;
        if (this._isHudView(vid, dec) && dec.assoc) {
            this.renderedTurn = dec.assoc;
            this.renderedTurnAt = now;
            this._noteManeuver(this.renderedTurn, now);
        } else if (this._isHudView(vid, dec) && dec.contentType === 'NONE') {
            this.renderedTurn = null;
        }
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
            else if (src === 'guidance') { this.route.state = null; this.route.provider = null; this.dart = null; this.nextInt = null; }
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
            if (this.dart) this._noteManeuver(this.dart, now);
        } else if (name === 'currentLaneGuiding') {
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
                this.lanesMiniMapSince = 0;
            } else {
                if (this.lanes && this.lanesSeenForTurn && this.turnKey !== '' && g === 'BMW' && this.routing()) {
                    const cur = this.currentManeuver(now);
                    const sameSegment = !(typeof this.lanes.dtd === 'number' && cur && typeof cur.dtd === 'number') ||
                        Math.abs(this.lanes.dtd - cur.dtd) <= 350;
                    if (cur && this._keyOf(cur) === this.turnKey && !straightOn(cur) && sameSegment) {
                        this.lanesSwitchedToMiniMap = true;
                        this.lanesMiniMapSince = now;
                    }
                }
                this.lanes = null;
                this.lanesAt = now;
            }
        } else if (name === 'nextIntersection') {
            this.rawNextIntersection = v;
            const ni = decodeNextIntersection(v);
            this.nextInt = ni;
            this.nextIntAt = now;
        }

        if (this.routeSure()) this.route.sureSeen = true;
        if (name === 'projectedGuidanceActive') {
            const act = (isObj(v) && 'projectedGuidanceActive' in v) ? v.projectedGuidanceActive : v;
            if (act === false && this.route.provider === (src === 'carplay' ? 'CAR_PLAY' : 'ANDROID_AUTO')) {
                this.route.sureSeen = true;
            }
        }

        const is = this.routing();
        if (is && !was) this.routeActiveSince = now;
        const keepBmwDart = Boolean(is && this.guideSource() === 'BMW' && (this.route.state === 'ACTIVE' || this.route.state === 2));
        if ((was && !is) || (wasSure && !this.routeSure()) || this.guideSource() !== oldGuide) {
            this._reset(now, keepBmwDart);
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
        const bmwActive = this.route.state === 'ACTIVE' || this.route.state === 2;
        const dartOk = this.dart && (now - this.dartAt <= STALE_MS || bmwActive);
        const renOk = this.renderedTurn && (now - this.renderedTurnAt <= STALE_MS || bmwActive);
        const niOk = this.nextInt && bmwActive && (now - this.nextIntAt <= 30000);
        const m = (this.turn && now - this.turnAt <= STALE_MS) ? this.turn
            : (dartOk ? this.dart
                : (renOk ? this.renderedTurn
                    : (niOk ? this.nextInt : null)));
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
        if (show) this.lastValidShowAt = mNow;
        if (this.lanesSwitchedToMiniMap && this.lanesMiniMapSince > 0 && mNow - this.lanesMiniMapSince > LANES_MINIMAP_MAX_MS) {
            this.lanesSwitchedToMiniMap = false;
            this.lanesMiniMapSince = 0;
        }
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

        const noTurnFallback = Boolean(
            !this.wocHudShowing && routeActive && !show && !miniMapActive &&
            guide === 'BMW' && this.routeActiveSince > 0 &&
            (mNow - Math.max(this.routeActiveSince, this.lastValidShowAt) >= NO_TURN_FALLBACK_MS)
        );

        let summary = 'No active route';
        if (this.wocHudShowing) {
            summary = 'Waze HUD map (overlaying metrics)';
        } else if (routeActive) {
            if (show) {
                summary = guide + ': ' + show.kind + ' ' + (show.dir || (show.exit ? 'exit ' + show.exit : '')) +
                    (show.dist ? ' ' + show.dist + (show.unit || '') : '') +
                    (hasLanes ? ' [' + show.lanes.lanes.length + ' lanes]' : '');
            } else {
                summary = guide + ': route active (' + (this.lastErr ? ('err: ' + this.lastErr) : 'waiting for turn') + ')';
            }
            if (miniMapActive) summary += ' -> MINI-MAP (' + miniMapReason + ')';
            else if (noTurnFallback) summary += ' -> YIELD (bmw_nav_fallback)';
        }

        return {
            routeActive,
            guide,
            show,
            hasLanes,
            miniMapActive,
            miniMapReason,
            noTurnFallback,
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
            const watchOpts = S.name === 'guidance' ? { pollMs: 3000 } : undefined;
            try {
                const p = ctx.signals.watch(S.iface, S.inst, handlers, log, watchOpts);
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

        let rcProxy = null;
        let rcPolling = false;
        const knownViewIds = Object.create(null);
        const queriedConfigs = Object.create(null);
        const pollHudViewContent = (id) => {
            if (!id || !rcProxy || !ctx.signals.call) return Promise.resolve();
            return ctx.signals.call(rcProxy, 'getViewContent', { viewId: id }, 900)
                .then((cntReply) => { this.feedRenderedContent(id, cntReply, mono()); })
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
                            this.feedRenderedContent(vid || 'hud', payload, mono());
                        }, log);
                    }
                }
            }).catch(() => {});
        } catch (e) { /* optional */ }

        let elProxy = null;
        let proxyFailedAt = -Infinity;
        let callFailedAt = -Infinity;
        let callFails = 0;
        let asking = false;
        const want = typeof wantedFn === 'function' ? wantedFn : () => true;

        const ask = () => {
            const now = mono();
            if (this._stopped || !this.routing() || !want()) return;
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
            }).then((px) => ctx.signals.call(px, 'queryContent', eventQuery(), QUERY_TIMEOUT_MS))
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
    decodeNextIntersection,
    decodeRenderedContent,
    parseHudStatusText,
    parseWazeHudShowing,
    metres,
};
