'use strict';
/**
 * signals.js - multi-tier live telemetry source:
 *   1. Passive SOME/IP broadcasts (CDS, CDS2, Vehicle, Vehicle2, FES, Efficiencytainment2,
 *      VehicleInformation, MDrive, BasicDataSet, EnvironmentalInformation, KombiIF, TPMS)
 *   2. Shared RAM-disk IPC (/dev/shm/cluster-info) when eDrive / Cluster Info is active
 *   3. Read-only UDS DIDs strictly via ./kit/readonly-diag (SME 0x07, DME 0x12, EGS 0x18)
 *   4. Rich demo mode (Auto off-car, Demo PHEV, Demo ICE) + bench signal injection helpers
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const fs = require('fs');
const path = require('path');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { decodeCarUnits, resolveUnits } = require('./units');
const { NavTracker } = require('./nav_tracker');
const { MediaTracker } = require('./media_tracker');

const IPC_STALE_MS = 3000;
const IPC_DIR_DEFAULT = '/dev/shm/cluster-info';
const EDRIVE_WANTED_DEFAULT = '/tmp/mgu-edrive-wanted.json';
const PROBE_LOG_DEFAULT = '/tmp/cluster-metrics-probe.log';
const PROBE_MAX_BYTES = 64 * 1024;
const UDS_KW_KEEP_MS = 15000;
const DSC_ECU = 0x29; // 41: G30 Brake ECU (DSC_G30N / DSC_G11 / IB_G05)

function hexBytes(arr) {
    if (!Array.isArray(arr)) return '';
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const b = arr[i] & 0xFF;
        out.push((b < 16 ? '0' : '') + b.toString(16).toUpperCase());
    }
    return out.join('');
}

function isPositiveDid(uds, did) {
    return Boolean(Array.isArray(uds) && uds.length >= 4 &&
        uds[0] === 0x62 && uds[1] === ((did >> 8) & 0xFF) && uds[2] === (did & 0xFF));
}

function s16At(uds, byteOffset) {
    const idx = 3 + byteOffset;
    if (!Array.isArray(uds) || uds.length < idx + 2) return null;
    const u = ((uds[idx] & 0xFF) << 8) | (uds[idx + 1] & 0xFF);
    if (u === 0x7FFF || u === 0x8000) return null;
    return u >= 0x8000 ? u - 0x10000 : u;
}

function decodeDscPressure(did, uds) {
    if (!isPositiveDid(uds, did)) return null;
    const clampBar = (raw) => {
        if (raw === null) return null;
        const b = raw * 0.1;
        return (b >= -5 && b <= 250) ? Math.max(0, b) : null;
    };
    if (did === 0xDBE5) {
        const k1 = clampBar(s16At(uds, 0));
        const k2 = clampBar(s16At(uds, 2));
        const ch4 = clampBar(s16At(uds, 4));
        const ch6 = clampBar(s16At(uds, 6));
        const ch8 = clampBar(s16At(uds, 8));
        const ch10 = clampBar(s16At(uds, 10));
        const wheelMax = Math.max(0, ch4 || 0, ch6 || 0, ch8 || 0, ch10 || 0);
        const masterMax = Math.max(0, k1 || 0, k2 || 0);
        return { did: 'DBE5', k1, k2, ch4, ch6, ch8, ch10, wheelMax, masterMax, rawHex: hexBytes(uds) };
    }
    if (did === 0xDB29) {
        const tmc = clampBar(s16At(uds, 0));
        const sys = clampBar(s16At(uds, 2));
        const wheelMax = sys !== null ? sys : 0;
        const masterMax = tmc !== null ? tmc : 0;
        return { did: 'DB29', k1: tmc, k2: sys, ch4: sys, ch6: null, ch8: null, ch10: null, wheelMax, masterMax, rawHex: hexBytes(uds) };
    }
    return null;
}

function decodeDscPedal(uds) {
    if (!isPositiveDid(uds, 0xDBF5)) return null;
    const ist = s16At(uds, 0);
    const nul = s16At(uds, 4);
    const leer = s16At(uds, 6);
    return {
        wegIstMm: ist !== null ? ist * 0.01 : null,
        wegNullMm: nul !== null ? nul * 0.01 : null,
        wegLeerMm: leer !== null ? leer * 0.01 : null,
        rawHex: hexBytes(uds),
    };
}

function decodeDscRegen(uds) {
    if (!isPositiveDid(uds, 0xDBF6)) return null;
    const soll = s16At(uds, 0);
    const ist = s16At(uds, 2);
    return {
        regenSollNm: soll,
        regenIstNm: ist,
        rawHex: hexBytes(uds),
    };
}

/**
 * Real-time HV battery kW interpolator learned from SME UDS readings against
 * Efficiencytainment2.statusPowerRelativHybrid (10-20 Hz eDRIVE / CHARGE needle).
 * Keeps kW responsive at needle speed and bridges transient UDS gateway gaps.
 */
class FastKw {
    constructor() {
        this.hist = []; // [tMs, drivePct, recupPct]
        this.theta = [0.85, 0.55, 0.6]; // [kW/% drive, kW/% recup, aux kW]
        this.P = [[4, 0, 0], [0, 4, 0], [0, 0, 4]];
        this.n = 0;
    }

    needle(drive, recup, tMs) {
        if (typeof drive !== 'number' && typeof recup !== 'number') return;
        const d = (typeof drive === 'number' && isFinite(drive) && drive >= 0 && drive <= 250) ? drive : 0;
        const r = (typeof recup === 'number' && isFinite(recup) && recup >= 0 && recup <= 250) ? recup : 0;
        this.hist.push([tMs, d, r]);
        while (this.hist.length > 2 && tMs - this.hist[0][0] > 4500) this.hist.shift();
    }

    at(tMs) {
        let best = null;
        for (let i = 0; i < this.hist.length; i++) {
            if (this.hist[i][0] <= tMs) best = this.hist[i];
            else break;
        }
        return (best && tMs - best[0] < 2000) ? best : null;
    }

    reading(kw, tMs) {
        if (typeof kw !== 'number' || !isFinite(kw)) return;
        const h = this.at(tMs - 220);
        if (!h) return;
        const x = [h[1], -h[2], 1];
        const Px = [
            this.P[0][0] * x[0] + this.P[0][1] * x[1] + this.P[0][2] * x[2],
            this.P[1][0] * x[0] + this.P[1][1] * x[1] + this.P[1][2] * x[2],
            this.P[2][0] * x[0] + this.P[2][1] * x[1] + this.P[2][2] * x[2],
        ];
        const forget = 0.97;
        const den = forget + x[0] * Px[0] + x[1] * Px[1] + x[2] * Px[2];
        const k = [Px[0] / den, Px[1] / den, Px[2] / den];
        const err = kw - (this.theta[0] * x[0] + this.theta[1] * x[1] + this.theta[2] * x[2]);
        this.theta = [this.theta[0] + k[0] * err, this.theta[1] + k[1] * err, this.theta[2] + k[2] * err];
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                this.P[r][c] = (this.P[r][c] - k[r] * Px[c]) / forget;
            }
        }
        this.theta[0] = Math.max(0.05, this.theta[0]);
        this.theta[1] = Math.max(0.05, this.theta[1]);
        this.n++;
    }

    now(tMs) {
        if (this.n < 3 || !this.hist.length) return null;
        const h = this.hist[this.hist.length - 1];
        if (tMs - h[0] > 2000) return null;
        return this.theta[0] * h[1] - this.theta[1] * h[2] + this.theta[2];
    }
}

const GEARS = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, G6: 6, G7: 7, G8: 8, G9: 9, G10: 10, R: -1, N_OR_P: 0 };
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const PROGRAMS = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };

function gearOf(x) {
    if (typeof x === 'number') {
        if (x >= 3 && x <= 12) return x - 2;
        if (x === 1) return -1;
        if (x === 2) return 0;
        return undefined;
    }
    return GEARS[x];
}

function stageOf(x) { return STAGES[x]; }

function programOf(o) {
    const keys = Object.keys(o || {});
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === 'statusActualGearDrive' || /StageDrive/.test(k) || !/select|lever|position|program|mode|range|manual|sport|tip/i.test(k)) continue;
        const v = o[k];
        if (v === true || v === 1) {
            if (/manual|tip/i.test(k)) return 'M';
            if (/sport/i.test(k)) return 'S';
            continue;
        }
        const x = String(v).toUpperCase();
        if (/NOT|INACTIVE|INVALID|SIGNAL|UNKNOWN|OFF|NO_/.test(x)) continue;
        if (/MANU|TIPP|^M$|^M_|_M$|^M\d/.test(x)) return 'M';
        if (/SPORT|^S$|_S$|^DS$/.test(x)) return 'S';
    }
    return undefined;
}

function selectionOf(x) {
    let n = typeof x === 'number' ? x : { N: 1, R: 2, P: 3, NP: 4 }[x];
    if (n === undefined && /^_\d$/.test(String(x))) n = 4 + Number(String(x).slice(1));
    if (n === 1) return { stage: 'N', gear: 0 };
    if (n === 2) return { stage: 'R', gear: -1 };
    if (n === 3) return { stage: 'P', gear: 0 };
    if (n === 4) return { stage: undefined, gear: 0 };
    if (n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return undefined;
}

function driveModeOf(raw) {
    let v = raw;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
    if (typeof v === 'number') {
        if (v >= 1 && v <= 3) return 'sport';
        if (v >= 7 && v <= 9) return 'eco';
        if ((v >= 4 && v <= 6) || v === 10) return 'comfort';
        return null;
    }
    if (typeof v !== 'string') return null;
    const u = v.trim().toUpperCase();
    if (u.indexOf('SPORT') === 0) return 'sport';
    if (u.indexOf('ECO') === 0) return 'eco';
    if (u.indexOf('COMFORT') === 0 || u.indexOf('ADAPTIVE') === 0) return 'comfort';
    return null;
}

function pad2(n) {
    const v = Math.max(0, Math.min(99, Math.round(n)));
    return v < 10 ? ('0' + v) : String(v);
}

function formatRemainDuration(mins) {
    if (typeof mins !== 'number' || !isFinite(mins) || mins <= 0) return '';
    const m = Math.round(mins);
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h > 0 && rem > 0) return h + 'h ' + rem + 'm';
    if (h > 0) return h + 'h';
    return rem + 'm';
}

function closeSub(s) {
    if (!s) return;
    try {
        if (typeof s.shutdown === 'function') s.shutdown();
    } catch (e) { /* ignore */ }
    try {
        if (typeof s.stop === 'function') s.stop();
    } catch (e) { /* ignore */ }
}

/**
 * Decode 12V auxiliary battery State of Charge (%) from `CDS.statusBattery2`.
 * `conditionBatteryChargingCondition` is UInt8 (0..100 %, 255 = invalid).
 */
function decodeStatusBattery2(v) {
    const raw = (v && typeof v === 'object') ? v.conditionBatteryChargingCondition : v;
    if (typeof raw !== 'number' || !isFinite(raw) || raw < 0 || raw > 100) return null;
    return raw;
}

/**
 * Decode interior cabin temperature from `Climate2.statusTemperatureInside`.
 * `temperatureInside` is UInt8 (0..250 -> raw * 0.5 - 40 degC, 255 = invalid).
 */
function decodeCabinTemp(v) {
    const raw = (v && typeof v === 'object') ? v.temperatureInside : v;
    if (typeof raw !== 'number' || !isFinite(raw) || raw < 0 || raw >= 251) return null;
    const tempC = raw * 0.5 - 40;
    return (tempC >= -40 && tempC <= 85) ? tempC : null;
}

const LEAD_STALE_MS = 2500;

/**
 * Tracks radar/camera lead vehicle distance, time-headway, and closing/opening speed
 * from `de.bmw.dass.GapVehicleAhead` (`GapVehicleDrivingAhead`, `DataFrontVehicle`, `DataFrontVehicleExtended`).
 */
class LeadVehicleTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.objId = null;
        this.gapM = null;
        this.relSpeedKmh = null;
        this.vehType = null;
        this.status = 'idle';
        this.rawGap8 = null;
        this.rawGapX = null;
        this.rawSpeedX = null;
        this.lastValidMs = 0;
        this._refGapM = null;
        this._refMs = 0;
    }

    _clearTarget(reason) {
        this.gapM = null;
        this.relSpeedKmh = null;
        this.lastValidMs = 0;
        this._refGapM = null;
        this._refMs = 0;
        this.status = reason || 'none';
    }

    _updateDistance(gapM, objId, nowMs) {
        if (typeof gapM !== 'number' || !isFinite(gapM) || gapM < 0.4 || gapM > 260) return;
        const sameObj = (objId === null || this.objId === null || objId === this.objId);
        if (!sameObj) {
            this.relSpeedKmh = null;
            this._refGapM = gapM;
            this._refMs = nowMs;
        } else if (this._refGapM !== null && this._refMs > 0) {
            const dtMs = nowMs - this._refMs;
            if (dtMs >= 240 && dtMs <= 2200) {
                const instKmh = ((gapM - this._refGapM) / (dtMs / 1000)) * 3.6;
                if (isFinite(instKmh) && Math.abs(instKmh) <= 140) {
                    this.relSpeedKmh = this.relSpeedKmh === null
                        ? instKmh
                        : (this.relSpeedKmh * 0.62 + instKmh * 0.38);
                }
                this._refGapM = gapM;
                this._refMs = nowMs;
            } else if (dtMs > 2200 || dtMs < 0) {
                this._refGapM = gapM;
                this._refMs = nowMs;
            }
        } else {
            this._refGapM = gapM;
            this._refMs = nowMs;
        }
        if (objId !== null) this.objId = objId;
        this.gapM = gapM;
        this.lastValidMs = nowMs;
    }

    feedGapAhead(v, nowMs) {
        if (!v || typeof v !== 'object') return;
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const st = v.statusMeasurementVehicleDrivingAhead;
        const g8 = v.gapVehicleDrivingAhead;
        if (typeof g8 === 'number') this.rawGap8 = g8;
        const vt = v.vehicleTypeVehicleDrivingAhead;
        if (vt !== undefined && vt !== null) this.vehType = String(vt);

        const isNoTarget = st === 0 || st === 'KEIN_ELEMENT_GEMESSEN' ||
            (typeof st === 'string' && /KEIN_ELEMENT|UNGUELTIG|FEHLER/.test(st)) ||
            (typeof st === 'number' && st >= 5);
        if (isNoTarget) {
            // Only clear if high-rate DataFrontVehicle hasn't reported a fresh valid object in the last 600ms
            if (now - this.lastValidMs > 600 || this.rawGapX === null || this.rawGapX >= 4090) {
                this._clearTarget(String(st));
            }
            return;
        }

        const isMeasured = st === 1 || st === 2 || st === 3 || st === 4 ||
            (typeof st === 'string' && /ELEMENT.*GEMESSEN|ELEMENT_PRAEDIZIERT/.test(st));
        if (isMeasured) {
            this.status = String(st);
            // Prefer high-resolution DataFrontVehicle.frontVehicleGapX when fresh; otherwise use gapVehicleDrivingAhead (m)
            const hasFreshFrontX = this.rawGapX !== null && this.rawGapX > 0 && this.rawGapX < 4090 && (now - this.lastValidMs < 900);
            if (!hasFreshFrontX && typeof g8 === 'number' && g8 > 0 && g8 < 250) {
                this._updateDistance(g8, this.objId, now);
            }
        }
    }

    feedDataFront(v, nowMs) {
        if (!v || typeof v !== 'object') return;
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const q = v.qualifierEventDataFunctionFrontVehicle;
        const oid = typeof v.frontVehicleObjectID === 'number' ? v.frontVehicleObjectID : null;
        const gx = typeof v.frontVehicleGapX === 'number' ? v.frontVehicleGapX : null;
        const sx = typeof v.frontVehicleSpeedX === 'number' ? v.frontVehicleSpeedX : null;

        if (gx !== null) this.rawGapX = gx;
        if (sx !== null) this.rawSpeedX = sx;

        const qInvalid = q === 2 || q === 15 ||
            (typeof q === 'string' && /NOT_AVAILABLE|UNBEFUELLT|INVALID/.test(q));
        if (qInvalid || (oid !== null && oid >= 250) || (gx !== null && (gx <= 0 || gx >= 4090))) {
            this._clearTarget(qInvalid ? String(q) : 'no_obj');
            return;
        }

        if (gx !== null && gx > 0 && gx < 4090) {
            this.status = q !== undefined ? String(q) : 'front_ok';
            this._updateDistance(gx * 0.0625, oid, now);
        }
    }

    feedDataFrontExt(v) {
        if (!v || typeof v !== 'object') return;
        const ot = v.frontVehicleExtendedObjectType;
        if (ot !== undefined && ot !== null && ot !== 0 && ot !== 'KEIN_OBJEKT' && ot !== 'SIGNAL_UNBEFUELLT') {
            this.vehType = String(ot);
        }
    }

    snapshot(egoSpeedKmh, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const active = this.gapM !== null && this.lastValidMs > 0 && (now - this.lastValidMs <= LEAD_STALE_MS);
        if (!active) {
            return {
                active: false,
                gapM: null,
                headwaySec: null,
                relSpeedKmh: null,
                objId: this.objId,
                vehType: this.vehType,
                rawGap8: this.rawGap8,
                rawGapX: this.rawGapX,
                rawSpeedX: this.rawSpeedX,
                status: this.status,
            };
        }
        const spd = (typeof egoSpeedKmh === 'number' && isFinite(egoSpeedKmh)) ? egoSpeedKmh : 0;
        let headwaySec = null;
        if (spd >= 12) {
            const rawHw = this.gapM / (spd / 3.6);
            if (isFinite(rawHw) && rawHw > 0) {
                headwaySec = Math.max(0.1, Math.min(9.9, rawHw));
            }
        }
        return {
            active: true,
            gapM: this.gapM,
            headwaySec,
            relSpeedKmh: this.relSpeedKmh,
            objId: this.objId,
            vehType: this.vehType,
            rawGap8: this.rawGap8,
            rawGapX: this.rawGapX,
            rawSpeedX: this.rawSpeedX,
            status: this.status,
        };
    }
}

/**
 * Derive PHEV/BEV plug-in charging session state, charging speed (kW / A), and estimated finish time
 * from BMW `Vehicle` + `Charging` SOME/IP signals with stationary shore-power (-kW at P, 0 mph) fallback.
 */
function computeChargingState(raw, ctx, nowMs) {
    const r = raw || {};
    const c = ctx || {};
    const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    const speedKmh = typeof c.speedKmh === 'number' && isFinite(c.speedKmh) ? c.speedKmh : null;
    const rpm = typeof c.rpm === 'number' && isFinite(c.rpm) ? c.rpm : 0;
    const hvKw = typeof c.hvKw === 'number' && isFinite(c.hvKw) ? c.hvKw : null;
    const soc = typeof c.soc === 'number' && isFinite(c.soc) ? c.soc : null;
    const stage = c.stage || null;

    const notStationary = (speedKmh !== null && speedKmh >= 1.5) || stage === 'D' || stage === 'R';
    if (notStationary) {
        r._shorePowerSince = 0;
        return {
            active: false,
            plugConnected: false,
            source: 'driving',
            chargeKw: null,
            maxAmps: null,
            targetSoc: typeof r.targetSoc === 'number' ? r.targetSoc : 100,
            remainMin: null,
            remainText: '',
            finishTimeText: '--:--',
        };
    }

    let plugConnected = null;
    if (r.wirePlugged === true || r.dcPlugged === true || r.plugLocked === true ||
        (typeof r.chargeMethod === 'number' && r.chargeMethod > 0 && r.chargeMethod < 200)) {
        plugConnected = true;
    } else if (r.wirePlugged === false && r.dcPlugged !== true) {
        plugConnected = false;
    }

    const stationaryShoreCandidate = (stage === 'P' || !stage) && rpm < 100 && hvKw !== null && hvKw <= -0.65 && plugConnected !== false;
    let shorePowerActive = false;
    if (stationaryShoreCandidate) {
        if (!r._shorePowerSince) r._shorePowerSince = now;
        if (plugConnected === true || (now - r._shorePowerSince >= 1500)) {
            shorePowerActive = true;
        }
    } else {
        r._shorePowerSince = 0;
    }

    const lsc = r.lscStatus || null; // 'active' | 'init' | 'paused' | 'done' | 'error' | 'none'
    const isLscActive = lsc === 'active' || lsc === 'init';
    const isLscStopped = lsc === 'done' || lsc === 'none' || lsc === 'error';

    let remainMin = (typeof r.residualMin === 'number' && isFinite(r.residualMin) && r.residualMin > 0 && r.residualMin <= 2880)
        ? Math.round(r.residualMin)
        : ((typeof r.predDurMin === 'number' && isFinite(r.predDurMin) && r.predDurMin > 0 && r.predDurMin <= 2880)
            ? Math.round(r.predDurMin) : null);

    const hasClock = typeof r.endHour === 'number' && r.endHour >= 0 && r.endHour <= 23 &&
        typeof r.endMin === 'number' && r.endMin >= 0 && r.endMin <= 59;

    const active = Boolean(
        isLscActive ||
        shorePowerActive ||
        (plugConnected === true && !isLscStopped && ((hvKw !== null && hvKw <= -0.3) || remainMin > 0 || hasClock))
    );

    const targetSoc = (typeof r.targetSoc === 'number' && isFinite(r.targetSoc) && r.targetSoc >= 10 && r.targetSoc <= 100)
        ? Math.round(r.targetSoc) : 100;
    const chargeKw = (active && hvKw !== null && hvKw < -0.05) ? Math.abs(hvKw) : null;

    if (active && remainMin === null && hasClock) {
        const dNow = new Date(now);
        const nowMin = dNow.getHours() * 60 + dNow.getMinutes();
        let tgtMin = r.endHour * 60 + r.endMin;
        if (tgtMin + 10 < nowMin) tgtMin += 1440;
        const diff = tgtMin - nowMin;
        if (diff > 0 && diff <= 2880) remainMin = diff;
    }

    if (active && remainMin === null && chargeKw !== null && chargeKw >= 0.4 && soc !== null && soc < targetSoc) {
        // Fallback estimate using G30 530e net HV pack energy (~10.8 kWh) & 96% charger-to-pack efficiency
        const estMin = Math.round(((targetSoc - soc) / 100) * 10.8 / (chargeKw * 0.96) * 60);
        if (estMin >= 1 && estMin <= 2880) remainMin = estMin;
    }

    let finishTimeText = '--:--';
    if (active) {
        if (hasClock) {
            finishTimeText = pad2(r.endHour) + ':' + pad2(r.endMin);
        } else if (remainMin !== null && remainMin > 0) {
            const finDate = new Date(now + remainMin * 60000);
            finishTimeText = pad2(finDate.getHours()) + ':' + pad2(finDate.getMinutes());
        } else if (soc !== null && soc >= targetSoc - 0.5) {
            finishTimeText = 'FULL';
        }
    }

    let source = 'idle';
    if (active) {
        source = isLscActive ? 'bmw_lsc' : (plugConnected === true ? 'bmw_plug' : 'shore_kw');
    } else if (plugConnected === true) {
        source = lsc === 'done' ? 'complete' : (lsc === 'paused' ? 'paused' : 'plugged_idle');
    }

    return {
        active,
        plugConnected: plugConnected === true || shorePowerActive,
        source,
        chargeKw,
        maxAmps: (typeof r.maxAmps === 'number' && isFinite(r.maxAmps) && r.maxAmps > 0 && r.maxAmps <= 80) ? Math.round(r.maxAmps) : null,
        targetSoc,
        remainMin,
        remainText: active ? formatRemainDuration(remainMin) : '',
        finishTimeText,
    };
}

function bcToL100(rawVal, unitStr) {
    if (typeof rawVal !== 'number' || !isFinite(rawVal) || rawVal <= 0 || rawVal >= 6553) return null;
    const u = String(unitStr || '').toUpperCase();
    if (/MPG_?US/.test(u)) return 235.214583 / rawVal;
    if (/MPG_?UK/.test(u)) return 282.480936 / rawVal;
    if (/KM_?S?_?L/.test(u)) return 100 / rawVal;
    return rawVal; // VERBRAUCH_IN_L_S_100KM
}

/**
 * Fallback speed/RPM gear classifier for cars whose statusGearboxDrive is absent while ICE is running.
 */
class GearGuess {
    constructor() { this.cl = []; }
    feed(rpm, kmh) {
        if (!(rpm > 1100 && kmh > 8)) return null;
        const k = rpm / kmh;
        let c = null;
        for (let i = 0; i < this.cl.length; i++) {
            if (Math.abs(this.cl[i].k - k) / this.cl[i].k < 0.05) { c = this.cl[i]; break; }
        }
        if (!c) {
            if (this.cl.length > 24) {
                this.cl.sort((a, b) => b.n - a.n);
                this.cl.pop();
            }
            c = { k, n: 0 };
            this.cl.push(c);
        }
        c.n++;
        c.k += (k - c.k) / Math.min(c.n, 50);
        const gears = this.cl.filter((x) => x.n > 30).sort((a, b) => b.k - a.k);
        for (let i = 0; i < gears.length; i++) {
            if (Math.abs(gears[i].k - k) / gears[i].k < 0.05) return i + 1;
        }
        return null;
    }
}

const ZF8_RATIOS = [4.714, 3.143, 2.106, 1.667, 1.285, 1.000, 0.839, 0.667];

function flagActive(v, restVal) {
    if (v === undefined || v === null) return null;
    if (restVal !== undefined && restVal !== null && v === restVal) return false;
    if (v === true) return true;
    if (v === false || v === 0) return false;
    if (typeof v === 'number') {
        if (v >= 3 || !isFinite(v)) return null; // 3 = SIGNAL_UNGUELTIG on 2-bit BN2020 flags
        if (restVal === 1) return v === 2;
        return v === 1 || v === 2;
    }
    if (typeof v !== 'string') return null;
    const u = v.trim().toUpperCase();
    if (!u || /INVALID|UNGUELTIG|UNKNOWN|SIGNAL_UN/.test(u)) return null;
    if (/NICHT|KEINE|NO_|NOT_|INACTIVE|PASSIVE|RELEASED|GELOEST|OFF|^0$/.test(u)) return false;
    if (/BRAK|BREMST|BREMSUNG|ACTIVE|AKTIV|TRUE|APPLIED|ANGEZOGEN|ON|YES|^1$|^2$/.test(u)) return true;
    return null;
}

/**
 * Computes longitudinal hydraulic friction brake actuation (g) and rotor thermal
 * dissipation power (kW) from optional direct pressure or longitudinal force balance.
 * Strictly gated on brake actuation so lift-throttle EV regen never lights up the bar.
 */
function computeFrictionBrake(raw) {
    const r = raw || {};
    const massKg = (typeof r.massKg === 'number' && isFinite(r.massKg) && r.massKg >= 1200 && r.massKg <= 3200)
        ? r.massKg : 2100;
    const g0 = 9.80665;
    const speedKmh = (typeof r.speedKmh === 'number' && isFinite(r.speedKmh) && r.speedKmh >= 0) ? r.speedKmh : null;
    const v = speedKmh !== null ? speedKmh / 3.6 : 0;
    const recupPct = (typeof r.recupPct === 'number' && isFinite(r.recupPct) && r.recupPct > 0) ? r.recupPct : 0;
    const rawHvKw = (typeof r.hvKw === 'number' && isFinite(r.hvKw)) ? r.hvKw : null;
    const effHvKw = rawHvKw !== null ? rawHvKw : (recupPct > 1 ? -recupPct * 0.45 : null);
    const pedalPct = (typeof r.pedalPct === 'number' && isFinite(r.pedalPct)) ? r.pedalPct : null;
    const absActive = r.absActive === true;
    const driverBraking = typeof r.driverBraking === 'boolean' ? r.driverBraking : null;
    const brakeHold = Boolean(driverBraking === true && speedKmh !== null && speedKmh < 1.5);

    // 1. Direct hydraulic caliper pressure from DSC 0x29 UDS (0xDBE5 / 0xDB29) or /dev/shm/cluster-info (brake.bar)
    if (typeof r.brakeBar === 'number' && isFinite(r.brakeBar) && r.brakeBar >= 0) {
        const fgDirect = r.brakeBar >= 1.5 ? Math.min(1.2, Math.max(0.025, r.brakeBar * 0.012)) : 0;
        const pureRegenDirect = effHvKw !== null && effHvKw <= -1.0 && speedKmh !== null && speedKmh > 3 &&
            fgDirect === 0 && (pedalPct === null || pedalPct <= 2.5);
        return {
            frictionG: fgDirect,
            frictionKw: fgDirect > 0 && v > 0.3 ? (massKg * g0 * fgDirect * v) / 1000 : 0,
            pureRegen: pureRegenDirect,
            brakeHold: brakeHold && fgDirect <= 0.02,
            absActive,
        };
    }

    // 2. Foot explicitly OFF brake pedal (and no ABS): lift-throttle deceleration is 100% regen/coast, never pads!
    if (driverBraking === false && !absActive) {
        const pureLiftRegen = effHvKw !== null && effHvKw <= -1.0 && speedKmh !== null && speedKmh > 3 &&
            (pedalPct === null || pedalPct <= 2.5);
        return { frictionG: 0, frictionKw: 0, pureRegen: pureLiftRegen, brakeHold: false, absActive };
    }

    const gLong = (typeof r.gLong === 'number' && isFinite(r.gLong)) ? r.gLong : null;
    if (gLong === null) {
        const pureOnly = effHvKw !== null && effHvKw <= -1.0 && speedKmh !== null && speedKmh > 3 &&
            (pedalPct === null || pedalPct <= 2.5);
        return { frictionG: 0, frictionKw: 0, pureRegen: pureOnly, brakeHold, absActive };
    }

    // Gate out throttle pushes unless left-foot braking is explicitly reported
    if (pedalPct !== null && pedalPct > 2.5 && driverBraking !== true) {
        return { frictionG: 0, frictionKw: 0, pureRegen: false, brakeHold: false, absActive };
    }

    const aTotalDecelG = Math.max(0, -gLong);
    const fDragN = (v > 0.5 ? massKg * g0 * 0.011 : 0) + 0.345 * v * v;
    const aDragG = fDragN / (massKg * g0);

    // EV regen at wheels (0.88 drivetrain eff + 0.6 kW aux; creep taper below 10 km/h)
    let fRegenN = 0;
    if (effHvKw !== null && effHvKw < 0 && v > 0.5) {
        const vMin = 10 / 3.6;
        const pRegenWheelW = Math.max(0, -effHvKw + 0.6) * 1000 / 0.88;
        const creepTaper = v < vMin ? Math.max(0, (v - 0.5) / (vMin - 0.5)) : 1;
        fRegenN = (pRegenWheelW / Math.max(v, vMin)) * creepTaper;
    }

    // ICE engine overrun / compression braking via ZF 8HP ratio
    let fIceN = 0;
    const rpm = (typeof r.rpm === 'number' && isFinite(r.rpm)) ? r.rpm : 0;
    const torqueNm = (typeof r.torqueNm === 'number' && isFinite(r.torqueNm)) ? r.torqueNm : null;
    const gear = (typeof r.gear === 'number' && r.gear >= 1 && r.gear <= 8) ? Math.round(r.gear) : null;
    if (rpm >= 500 && v > 1.0) {
        const ratio = gear ? ZF8_RATIOS[gear - 1] : 1.285;
        const totalRatio = ratio * 2.93;
        if (torqueNm !== null && torqueNm < 0) {
            fIceN = Math.max(0, -torqueNm) * totalRatio * 0.90 / 0.342;
        } else if (torqueNm === null && rpm >= 900 && (pedalPct === null || pedalPct < 1.5)) {
            fIceN = 30 * totalRatio * 0.90 / 0.342;
        }
    }

    const aNonFrictionG = aDragG + (fRegenN + fIceN) / (massKg * g0);
    const residG = Math.max(0, aTotalDecelG - aNonFrictionG);
    // When driverBraking is unknown (null) and regen is active, use high threshold (0.16g) so lift-off regen never false-positives
    const gate = (driverBraking === true || absActive) ? 0.025 : ((effHvKw !== null && effHvKw < -1.0) ? 0.16 : 0.07);
    const frictionG = residG >= gate ? residG : 0;
    const frictionKw = frictionG > 0 && v > 0.3 ? (massKg * g0 * frictionG * v) / 1000 : 0;
    const pureRegen = effHvKw !== null && effHvKw <= -1.0 && speedKmh !== null && speedKmh > 3 &&
        frictionG === 0 && (pedalPct === null || pedalPct <= 2.5);

    return { frictionG, frictionKw, pureRegen, brakeHold: brakeHold && frictionG <= 0.02, absActive };
}

class DemoGenerator {
    constructor() {
        this.t0 = Date.now();
        this.injAcc = 0;
    }

    demoHudNav(cycle) {
        if (cycle >= 24 && cycle < 38) {
            return {
                routeActive: true,
                guide: 'BMW',
                show: {
                    kind: 'branch', dir: 'HIGHWAY_OUT_RIGHT', geom: 'EXIT_RIGHT_TAKE_RIGHT', exit: null, exitAngle: null, side: null,
                    dist: '0.4', unit: 'mi', uk: false,
                    exitBadge: '14B',
                    road: 'I-280 North - San Francisco / Cupertino Ave',
                    lanes: null, then: null,
                },
                hasLanes: false,
                miniMapActive: false,
                miniMapReason: '',
                wocHudShowing: false,
                hudSlots: '',
                summary: 'BMW: branch HIGHWAY_OUT_RIGHT [Exit 14B] 0.4mi (demo)',
            };
        }
        if (cycle >= 38 && cycle < 44) {
            return {
                routeActive: true,
                guide: 'BMW',
                show: {
                    kind: 'roundabout', dir: null, geom: null, exit: 2, exitAngle: 180, side: 'right',
                    dist: '450', unit: 'ft', uk: false, exitBadge: null, road: 'N First St', lanes: null, then: null,
                },
                hasLanes: false,
                miniMapActive: false,
                miniMapReason: '',
                wocHudShowing: false,
                hudSlots: '',
                summary: 'BMW: roundabout exit 2 450ft (demo)',
            };
        }
        return {
            routeActive: true,
            guide: 'BMW',
            show: {
                kind: 'turn', dir: 'RIGHT', geom: null, exit: null, exitAngle: null, side: null,
                dist: cycle < 18 ? '0.3' : '400', unit: cycle < 18 ? 'mi' : 'ft', uk: false,
                exitBadge: null,
                road: 'Stevens Creek Blvd / Valley Fair',
                lanes: {
                    lanes: [
                        { follow: 'NONE', follows: [], others: ['LEFT'], hi: false, info: 'NONE' },
                        { follow: 'NONE', follows: [], others: ['STRAIGHT_ON'], hi: false, info: 'NONE' },
                        { follow: 'RIGHT', follows: ['RIGHT'], others: ['STRAIGHT_ON'], hi: true, info: 'NONE' },
                        { follow: 'RIGHT', follows: ['RIGHT'], others: [], hi: true, info: 'NONE' },
                    ],
                    rec: 3,
                    markers: ['SOLID', 'DASHED', 'DASHED', 'DASHED', 'SOLID'],
                },
                then: null,
            },
            hasLanes: true,
            miniMapActive: false,
            miniMapReason: '',
            wocHudShowing: false,
            hudSlots: '',
            summary: 'BMW: turn RIGHT (demo)',
        };
    }

    sample(kind, nowMs) {
        const t = ((nowMs - this.t0) / 1000);
        if (kind === 'charging') {
            const soc = Math.min(99, 68 + Math.floor((t % 120) / 15));
            const remainMin = Math.max(12, Math.round((100 - soc) * 3.1));
            const fin = new Date(nowMs + remainMin * 60000);
            const fh = fin.getHours();
            const fm = fin.getMinutes();
            const fStr = (fh < 10 ? '0' : '') + fh + ':' + (fm < 10 ? '0' : '') + fm;
            return {
                speedKmh: 0, rpm: 0, gear: 0, stage: 'P', program: 'D',
                hvKw: -3.5,
                soc,
                battTempC: 24.0,
                oilTempC: 29,
                coolantTempC: 31,
                boostBar: null, dmeFuelLh: 0, injVolumeRaw: 0,
                erangeKm: 26, frangeKm: 390,
                gLong: 0, gLat: 0, pedalPct: 0, driverBraking: false, torqueNm: 0, massKg: 2100,
                frictionG: 0, frictionKw: 0, pureRegen: false, absActive: false,
                driveMode: 'eco', ambientC: 19.0, cabinTempC: 20.5, gearboxOilC: 32, v12: 13.7, soc12: 91, iatC: 22, xdriveFrontPct: 0,
                leadVehicle: { active: false, gapM: null, headwaySec: null, relSpeedKmh: null, status: 'parked' },
                tpms: {
                    FL: { pressureBar: 2.4, targetBar: 2.4, tempC: 24 },
                    FR: { pressureBar: 2.4, targetBar: 2.4, tempC: 24 },
                    RL: { pressureBar: 2.6, targetBar: 2.6, tempC: 24 },
                    RR: { pressureBar: 2.6, targetBar: 2.6, tempC: 24 },
                },
                charging: {
                    active: true,
                    plugConnected: true,
                    source: 'bmw_lsc',
                    chargeKw: 3.5,
                    maxAmps: 16,
                    targetSoc: 100,
                    remainMin,
                    remainText: formatRemainDuration(remainMin),
                    finishTimeText: fStr,
                },
                hudNav: { routeActive: false, guide: null, show: null, hasLanes: false, miniMapActive: false, miniMapReason: '', wocHudShowing: false, hudSlots: '', summary: 'No active route' },
                demo: true,
            };
        }
        const cycle = t % 48; // 48-second driving scenario loop
        if (kind === 'ice') {
            const warm = Math.min(1, Math.max(0, (cycle - 4) / 22));
            const oilTempC = 32 + warm * 64;
            const coolantTempC = 55 + warm * 35;
            let speedKmh = 68, rpm = 1850, gear = 5, boostBar = 0.25, stage = 'D', program = 'D', fuelLh = 6.2;
            let gLong = 0.02, pedalPct = 22, driverBraking = false, torqueNm = 120;
            if (cycle >= 16 && cycle < 26) {
                speedKmh = 96; rpm = 3200; gear = 5; boostBar = 0.58; fuelLh = 12.4;
                gLong = 0.26; pedalPct = 58; torqueNm = 260;
            } else if (cycle >= 26 && cycle < 32) {
                speedKmh = 108; rpm = 1750; gear = 7; boostBar = 0.0; fuelLh = 0.0;
                gLong = -0.05; pedalPct = 0; torqueNm = -32;
            } else if (cycle >= 32 && cycle < 38) {
                speedKmh = 48; rpm = 1400; gear = 4; boostBar = 0.0; fuelLh = 0.0;
                gLong = -0.32; pedalPct = 0; driverBraking = true; torqueNm = -25;
            } else if (cycle >= 38 && cycle < 44) {
                speedKmh = 72; rpm = 2600; gear = 4; stage = 'D'; program = 'S'; boostBar = 0.42; fuelLh = 9.1;
                gLong = 0.10; pedalPct = 36; torqueNm = 185;
            } else if (cycle >= 44) {
                speedKmh = 0; rpm = 720; gear = 1; stage = 'D'; program = 'D'; boostBar = 0.0; fuelLh = 0.9;
                gLong = 0.0; pedalPct = 0; driverBraking = true; torqueNm = 15;
            }
            this.injAcc += fuelLh * 140;
            const fb = computeFrictionBrake({ speedKmh, rpm, gear, gLong, pedalPct, driverBraking, torqueNm, massKg: 1780 });
            const iceLead = (cycle >= 26 && cycle < 32)
                ? { active: false, gapM: null, headwaySec: null, relSpeedKmh: null, status: 'clear' }
                : (cycle >= 32 && cycle < 38)
                    ? { active: true, gapM: 17.5, headwaySec: 17.5 / (Math.max(12, speedKmh) / 3.6), relSpeedKmh: -11.5, status: 'demo' }
                    : (speedKmh < 5
                        ? { active: true, gapM: 4.8, headwaySec: null, relSpeedKmh: 0, status: 'demo' }
                        : { active: true, gapM: 38.0, headwaySec: 38.0 / (speedKmh / 3.6), relSpeedKmh: 0, status: 'demo' });
            return {
                speedKmh, rpm, gear, stage, program,
                oilTempC, coolantTempC,
                boostBar,
                dmeFuelLh: fuelLh,
                injVolumeRaw: Math.round(this.injAcc),
                hvKw: null, soc: null, battTempC: null, erangeKm: null, frangeKm: 418,
                gLong,
                gLat: 0.14 * Math.sin(t * 0.7),
                pedalPct,
                driverBraking,
                torqueNm,
                massKg: 1780,
                frictionG: fb.frictionG,
                frictionKw: fb.frictionKw,
                pureRegen: fb.pureRegen,
                absActive: fb.absActive,
                driveMode: program === 'S' ? 'sport' : 'comfort',
                ambientC: 18.5,
                cabinTempC: 21.5,
                gearboxOilC: 72 + warm * 14,
                v12: 14.1,
                soc12: 84,
                iatC: 34,
                xdriveFrontPct: 22,
                leadVehicle: iceLead,
                tpms: {
                    FL: { pressureBar: 2.4, targetBar: 2.4, tempC: 31 },
                    FR: { pressureBar: 2.4, targetBar: 2.4, tempC: 32 },
                    RL: { pressureBar: 2.6, targetBar: 2.6, tempC: 30 },
                    RR: { pressureBar: 2.6, targetBar: 2.6, tempC: 31 },
                },
                hudNav: this.demoHudNav(cycle),
                demo: true,
            };
        }

        // Default PHEV (530e)
        let speedKmh = 72, rpm = 0, gear = 5, stage = 'D', program = 'D', hvKw = 14.2;
        let oilTempC = 48, coolantTempC = 73, boostBar = 0, fuelLh = 0;
        let driveMode = 'comfort';
        let gLong = 0.02, pedalPct = 18, driverBraking = false, torqueNm = 0;
        if (cycle >= 12 && cycle < 17) {
            speedKmh = 54; rpm = 0; gear = 4; hvKw = -26.0;
            gLong = -0.11; pedalPct = 0; driverBraking = true;
        } else if (cycle >= 17 && cycle < 22) {
            speedKmh = 36; rpm = 0; gear = 3; hvKw = -22.0;
            gLong = -0.34; pedalPct = 0; driverBraking = true;
        } else if (cycle >= 22 && cycle < 26) {
            speedKmh = 0; rpm = 0; gear = 1; hvKw = 1.6;
            gLong = 0.0; pedalPct = 0; driverBraking = true;
        } else if (cycle >= 26 && cycle < 36) {
            speedKmh = 98; rpm = 2350; gear = 6; hvKw = 2.1; oilTempC = 48; coolantTempC = 73; boostBar = 0.24; fuelLh = 7.4;
            gLong = 0.04; pedalPct = 28; torqueNm = 110;
        } else if (cycle >= 36 && cycle < 44) {
            speedKmh = 104; rpm = 2950; gear = 5; hvKw = 4.5; oilTempC = 94; coolantTempC = 92; boostBar = 0.58; fuelLh = 10.6;
            gLong = 0.22; pedalPct = 55; torqueNm = 240;
        } else if (cycle >= 44) {
            speedKmh = 82; rpm = 2650; gear = 4; program = 'S'; driveMode = 'sport'; hvKw = 3.0; oilTempC = 96; coolantTempC = 92; boostBar = 0.36; fuelLh = 8.8;
            gLong = 0.08; pedalPct = 35; torqueNm = 165;
        }
        this.injAcc += fuelLh * 140;
        const fbPhev = computeFrictionBrake({ speedKmh, rpm, gear, hvKw, gLong, pedalPct, driverBraking, torqueNm, massKg: 2100 });
        const phevLead = (cycle >= 38 && cycle < 44)
            ? { active: false, gapM: null, headwaySec: null, relSpeedKmh: null, status: 'clear' }
            : (cycle >= 12 && cycle < 22)
                ? { active: true, gapM: 16.5, headwaySec: 16.5 / (Math.max(12, speedKmh) / 3.6), relSpeedKmh: -10.2, status: 'demo' }
                : (speedKmh < 5
                    ? { active: true, gapM: 4.6, headwaySec: null, relSpeedKmh: 0, status: 'demo' }
                    : { active: true, gapM: 36.0, headwaySec: 36.0 / (speedKmh / 3.6), relSpeedKmh: -1.2, status: 'demo' });
        return {
            speedKmh, rpm, gear, stage, program,
            hvKw,
            soc: 68 - Math.floor((cycle % 48) * 0.12),
            battTempC: 23.5,
            oilTempC,
            coolantTempC,
            boostBar,
            dmeFuelLh: fuelLh,
            injVolumeRaw: Math.round(this.injAcc),
            erangeKm: 31,
            frangeKm: 410,
            gLong,
            gLat: 0.12 * Math.sin(t * 0.6),
            pedalPct,
            driverBraking,
            torqueNm,
            massKg: 2100,
            frictionG: fbPhev.frictionG,
            frictionKw: fbPhev.frictionKw,
            pureRegen: fbPhev.pureRegen,
            absActive: fbPhev.absActive,
            driveMode,
            ambientC: 21.5,
            cabinTempC: 22.0,
            gearboxOilC: 76,
            v12: 13.8,
            soc12: 86,
            iatC: 29,
            xdriveFrontPct: 0,
            leadVehicle: phevLead,
            tpms: {
                FL: { pressureBar: 2.4, targetBar: 2.4, tempC: 28 },
                FR: { pressureBar: 2.4, targetBar: 2.4, tempC: 29 },
                RL: { pressureBar: 2.6, targetBar: 2.6, tempC: 28 },
                RR: { pressureBar: 2.6, targetBar: 2.6, tempC: 28 },
            },
            hudNav: this.demoHudNav(cycle),
            demo: true,
        };
    }
}

class SignalHub {
    constructor(ctx, opts) {
        this.ctx = ctx;
        this.log = ctx.log;
        this.opts = opts || {};
        this.ipcDir = this.opts.ipcDir || process.env.CLUSTER_INFO_DIR || IPC_DIR_DEFAULT;
        this.edriveWantedPath = this.opts.edriveWantedPath || process.env.EDRIVE_WANTED_PATH || EDRIVE_WANTED_DEFAULT;
        this.probeLogPath = this.opts.probeLogPath || process.env.CLUSTER_METRICS_PROBE_LOG || PROBE_LOG_DEFAULT;
        this.demoGen = new DemoGenerator();
        this.guess = new GearGuess();
        this.fastKw = new FastKw();
        this.navTracker = new NavTracker(this.opts);
        this.mediaTracker = new MediaTracker();
        this.leadTracker = new LeadVehicleTracker();
        this.live = { tpms: {}, brakeRestVal: null, rawBraking: null };
        this.chargingRaw = { _shorePowerSince: 0 };
        this.tpmsRaw = { p: {}, target: {}, temp: {}, psiSeen: false };
        this.dsc = {
            sgbd: null, pressDid: null, probed: false, wheelSensorSeen: false,
            caliperBar: null, k1Bar: null, k2Bar: null, ch4Bar: null, ch8Bar: null,
            wegIstMm: null, wegLeerMm: null, regenSollNm: null, regenIstNm: null,
            lastHex: '', nrc: '', t: 0, silentSince: 0,
        };
        this.probe = { untilMs: 0, timer: null, lines: 0, savedPath: '' };
        this.carUnitsRaw = {};
        this.lastRealSignalT = 0;
        this.ipc = { active: false, list: [] };
        this.uds = { available: false, busy: 0, stats: { sent: 0, replies: 0, missed: 0, blocked: 0 }, smeAnswered: false, smeSilentSince: 0 };
        this.subs = [];
        this._dynSubs = Object.create(null);
        this._mediaActive = false;
        this._navActive = false;
        this._demand = {
            gapAhead: true, climate: true, media: true, nav: true,
            brakeUds: true, hvUds: true, v12Uds: true, gbxUds: true, iatUds: true,
        };
        this._demandExtra = {};
        this.timers = [];
        this.diag = null;
        this.readers = {};
        this.stopped = false;
        this._started = false;
        this._pollNowFn = null;
        this._probeStepFn = null;
        this._lastWantedWrite = 0;
    }

    start() {
        const cfg = (this.ctx.spec && this.ctx.spec.config) || {};
        const S = cfg.scaling || {};
        const sc = (k, raw) => {
            const c = S[k];
            if (!c || raw === undefined || raw === null || raw === c.invalid) return null;
            if (typeof c.invalidFrom === 'number' && raw >= c.invalidFrom) return null;
            const v = raw * (c.factor || 1) + (c.offset || 0);
            return isFinite(v) ? v : null;
        };

        const markReal = () => { this.lastRealSignalT = Date.now(); };
        const watchInst = (iface, inst, handlers, extraOpts) => {
            if (!this.ctx.signals || typeof this.ctx.signals.watch !== 'function') return;
            try {
                const sub = this.ctx.signals.watch(iface, inst, handlers, this.log, extraOpts);
                if (sub && typeof sub.then === 'function') {
                    sub.then((r) => { if (r) this.subs.push(r); }).catch(() => {});
                } else if (sub) {
                    this.subs.push(sub);
                }
            } catch (e) {
                this.log.warn('watch ' + iface + ': ' + (e.message || e));
            }
        };
        const watch = (iface, handlers, extraOpts) => watchInst(iface, '1', handlers, extraOpts);

        watch('de.bmw.infotainment.vehicle.CDS', {
            statusEngineSpeed2: (v) => {
                const val = sc('rpm', v && v.actualValueRPMEngineCrankshaft);
                if (val !== null) {
                    this.live.rpm = val;
                    markReal();
                    const g = this.guess.feed(val, this.live.speedKmh);
                    if (g !== null) this.live.guessedGear = g;
                    else if ((this.live.speedKmh || 0) < 3) this.live.guessedGear = undefined;
                }
            },
            statusEngineTemperature: (v) => {
                const cool = sc('temp', v && v.temperatureEngineDrive);
                const oil = sc('temp', v && v.temperatureEngineOilDrive);
                if (cool !== null) { this.live.coolantTempC = cool; markReal(); }
                if (oil !== null) { this.live.oilTempC = oil; markReal(); }
            },
            statusBattery2: (v) => {
                if (v && typeof v === 'object' && typeof v.conditionBatteryChargingCondition === 'number') {
                    this.live.rawSoc12 = v.conditionBatteryChargingCondition;
                }
                const s12 = decodeStatusBattery2(v);
                if (s12 !== null) {
                    this.live.soc12 = s12;
                    markReal();
                }
            },
        });

        watch('de.bmw.infotainment.vehicle.Vehicle2', {
            statusCarSpeed2: (v) => {
                const val = sc('speed', v && v.speedVehicleCentreOfGravity);
                if (val !== null) {
                    this.live.speedKmh = val;
                    markReal();
                    const g = this.guess.feed(this.live.rpm, val);
                    if (g !== null) this.live.guessedGear = g;
                    else if (val < 3) this.live.guessedGear = undefined;
                }
            },
            highVoltageStorageInfoToExternal: (v) => {
                if (v && typeof v === 'object') {
                    const eRange = v.electricRange !== undefined ? v.electricRange : v.rangeElectric;
                    if (typeof eRange === 'number' && isFinite(eRange) && eRange >= 0 && eRange < 500) {
                        this.live.erangeKm = eRange;
                    }
                    // G30 SOME/IP: HighVoltageStorageInfoToExternalWrapper carries dynamic present / maximal energy
                    const pres = v.energyDischargeHighVoltageStoragePresentDynamic;
                    const maxE = v.energyDischargeHighVoltageStorageMaximalDynamic;
                    if (typeof pres === 'number' && typeof maxE === 'number' &&
                        isFinite(pres) && isFinite(maxE) && maxE > 50 && maxE < 65530 && pres >= 0 && pres <= maxE) {
                        this.live.someipSocPct = (pres / maxE) * 100;
                        this.live.hvEnergyRaw = pres + '/' + maxE;
                    }
                    markReal();
                }
            },
            statusVehicleMass: (v) => {
                const m = v && v.massVehicle;
                if (typeof m === 'number' && isFinite(m) && m >= 1000 && m <= 3500) {
                    this.live.massKg = m;
                }
            },
        });

        watch('de.bmw.infotainment.vehicle.CDS2', {
            statusLongitudinalAccelerationMassCenter: (v) => {
                const a = sc('accel', v && v.longitudinalAccelerationCentreOfGravity);
                if (a !== null) this.live.gLong = a / 9.80665;
            },
            statusLateralAccelerationMassCenter: (v) => {
                const a = sc('accel', v && v.lateralAccelerationCentreOfGravity);
                if (a !== null) this.live.gLat = a / 9.80665;
            },
            statusInjectionVolume: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.injectionVolumeFuelEngine === 'number' && isFinite(v.injectionVolumeFuelEngine)) {
                    this.live.injVolumeRaw = v.injectionVolumeFuelEngine;
                    markReal();
                }
                const oil2 = sc('temp', v.oilTemperature);
                if (oil2 !== null && this.live.oilTempC === undefined) this.live.oilTempC = oil2;
            },
        });

        watch('de.bmw.infrastructure.VehicleInformation', {
            statusGearboxDrive: (v) => {
                if (!v || typeof v !== 'object') return;
                const st = stageOf(v.statusActualStageDrive);
                const gr = gearOf(v.statusActualGearDrive);
                const pg = programOf(v);
                if (st !== undefined) this.live.stage = st;
                if (gr !== undefined) this.live.gear = gr;
                if (pg !== undefined) this.live.program = pg;
                markReal();
            },
            DataPowerTrain2: (v) => {
                const sel = selectionOf(v && v.statusGearSelectionDrive);
                if (!sel) return;
                if (sel.stage !== undefined) this.live.stage = sel.stage;
                if (sel.gear !== undefined) this.live.gear = sel.gear;
                markReal();
            },
        });

        watch('de.bmw.infotainment.misc.MDrive', {
            dataDisplayGearbox: (v) => {
                if (!v || typeof v !== 'object') return;
                const p = PROGRAMS[v.displayProgramGearbox];
                this.live.mdriveProgram = p || 'D';
                markReal();
            },
        });

        watch('de.bmw.infotainment.drivingexcitement.FES', {
            statusFESVehicleDynamicSwitchHMI: (v) => {
                const m = driveModeOf(v && v.actualValueModeDrivingExperience);
                if (m) { this.live.driveMode = m; markReal(); }
            },
            statusSwitchDriveDynamicSport2: (v) => {
                const b = sc('boost', v && v.displayBoostPressure);
                if (b !== null) { this.live.boostBar = b; this.live.boostT = Date.now(); markReal(); }
            },
            statusActualValueTorque2: (v) => {
                if (v && typeof v.actualValueTorqueCrankshaft === 'number' && v.actualValueTorqueCrankshaft < 4095) {
                    this.live.torqueNm = v.actualValueTorqueCrankshaft * 0.5 - 1023.5;
                }
            },
        });

        watch('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', {
            statusBatteryTemperature: (v) => {
                if (!v || typeof v !== 'object') return;
                let rawBt = v.actualValueTemperatureHighVoltageStorage;
                if (rawBt === undefined && Array.isArray(v.list) && v.list[0]) {
                    rawBt = v.list[0].actualValueTemperatureHighVoltageStorage;
                } else if (Array.isArray(rawBt) && rawBt[0]) {
                    rawBt = rawBt[0].actualValueTemperatureHighVoltageStorage;
                }
                const bt = sc('batteryTemp', rawBt);
                if (bt !== null && bt > -40 && bt < 85) {
                    this.live.battTempC = bt;
                    markReal();
                }
            },
            statusPowerRelativHybrid: (v) => {
                if (!v || typeof v !== 'object') return;
                let rec = v;
                if (rec.displayActualValuePowerRelativeDrivingElectric === undefined) {
                    const arr = Array.isArray(v.list) ? v.list : (Array.isArray(v.elements) ? v.elements : null);
                    if (arr && arr[0]) rec = arr[0];
                    else {
                        const keys = Object.keys(v);
                        for (let i = 0; i < keys.length; i++) {
                            const sub = v[keys[i]];
                            if (Array.isArray(sub) && sub[0] && sub[0].displayActualValuePowerRelativeDrivingElectric !== undefined) {
                                rec = sub[0];
                                break;
                            }
                        }
                    }
                }
                const d = rec && rec.displayActualValuePowerRelativeDrivingElectric;
                const r = rec && rec.displayActualValuePowerRelativeRecuperation;
                if (typeof d === 'number' && typeof r === 'number' && d <= 254 && r <= 254) {
                    this.live.driveNeedlePct = d;
                    this.live.recupNeedlePct = r;
                    this.live.needleT = Date.now();
                    this.fastKw.needle(d, r, this.live.needleT);
                    markReal();
                }
            },
            statusChargeOfBatteryHybrid: (v) => {
                const rawCh = v && typeof v === 'object' ? v.displayChargingConditionHighVoltageStorage : v;
                if (typeof rawCh === 'number' && isFinite(rawCh) && rawCh < 254) {
                    this.live.rawChargeHybrid = rawCh;
                    if (rawCh >= 0 && rawCh <= 100 && this.live.someipSocPct === undefined) {
                        this.live.someipSocPct = rawCh;
                    }
                    markReal();
                }
            },
        });

        watch('de.bmw.infotainment.lsc.LSCDataSink', {
            statusHighVoltageStorage: (v) => {
                if (!v || typeof v !== 'object') return;
                let x = v.actualValueVoltageHighVoltageStorage;
                if (x === undefined && Array.isArray(v.list) && v.list[0]) x = v.list[0].actualValueVoltageHighVoltageStorage;
                if (typeof x === 'number' && isFinite(x)) {
                    const volts = x > 1500 ? x / 10 : x;
                    if (volts > 150 && volts < 500) {
                        this.live.lscVolts = volts;
                        this.live.lscVoltsT = Date.now();
                        markReal();
                    }
                }
            },
        });

        watch('de.bmw.infrastructure.VehicleCondition', {
            VehicleCondition: (v) => {
                const rawCond = v && v.statusConditionVehicle;
                if (typeof rawCond === 'number') {
                    const locked = rawCond <= 3;
                    const wasLocked = Boolean(this.live.carLocked);
                    this.live.carLocked = locked;
                    if (wasLocked && !locked) this.wakeUds();
                } else if (typeof rawCond === 'string') {
                    const u = rawCond.toUpperCase();
                    const locked = /PARK|SLEEP|STANDBY|WOHNEN_AUS|PAD_OFF/.test(u) && !/FAHREN|DRIV|PAD_ON/.test(u);
                    const wasLocked = Boolean(this.live.carLocked);
                    this.live.carLocked = locked;
                    if (wasLocked && !locked) this.wakeUds();
                }
            },
        });

        watch('de.bmw.infrastructure.analytics.BasicDataSet', {
            basicDataSet: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.valueTemperatureTransmissionOil === 'number' && isFinite(v.valueTemperatureTransmissionOil) &&
                    v.valueTemperatureTransmissionOil > -40 && v.valueTemperatureTransmissionOil < 180) {
                    this.live.gearboxOilC = v.valueTemperatureTransmissionOil;
                }
                if (typeof v.valueDistributionLongitudinalTorqueRearAxisFrontAxis === 'number' &&
                    isFinite(v.valueDistributionLongitudinalTorqueRearAxisFrontAxis)) {
                    this.live.xdriveFrontPct = v.valueDistributionLongitudinalTorqueRearAxisFrontAxis;
                }
            },
        });

        const feedChargingLimit = (v) => {
            if (!v || typeof v !== 'object') return;
            const c = this.chargingRaw;
            c.restStatus = v.displayRestTimeEndOfChargingStatus;
            c.hrStatus = v.displayChargingTimeHrStatus;
            c.mnStatus = v.displayChargingTimeMnStatus;
            c.effStatus = v.displayChargingCurrentEffStatus;
            const ok = (st) => st === undefined || st === 1 || st === 'ANZEIGE';
            if (ok(c.effStatus) && typeof v.displayChargingCurrentEffect === 'number' && v.displayChargingCurrentEffect > 0 && v.displayChargingCurrentEffect < 250) {
                c.maxAmps = v.displayChargingCurrentEffect;
            } else if (typeof v.displayChargingCurrentLimitMode2 === 'number' && v.displayChargingCurrentLimitMode2 >= 4 && v.displayChargingCurrentLimitMode2 < 250 && c.maxAmps === undefined) {
                c.maxAmps = v.displayChargingCurrentLimitMode2;
            }
            markReal();
        };

        const feedChargingStatus2 = (v) => {
            if (!v || typeof v !== 'object') return;
            const c = this.chargingRaw;
            const ok = (st) => st === undefined || st === 1 || st === 'ANZEIGE';
            const bad = (st) => st === 2 || st === 'KEINE_ANZEIGE' || st === 13 || st === 14 || st === 15 ||
                (typeof st === 'string' && /NICHT_VERFUEGBAR|FEHLER|UNBEFUELLT/.test(st));
            if (typeof v.displayResidualTimeEndOfCharging === 'number') {
                if (!bad(c.restStatus) && v.displayResidualTimeEndOfCharging > 0 && v.displayResidualTimeEndOfCharging < 65000) {
                    c.residualMin = v.displayResidualTimeEndOfCharging;
                } else if (v.displayResidualTimeEndOfCharging === 0 || bad(c.restStatus)) {
                    c.residualMin = null;
                }
            }
            const hrOk = ok(c.hrStatus) || (!bad(c.hrStatus) && typeof v.displayChargingTimeHour === 'number' && v.displayChargingTimeHour <= 23);
            const mnOk = ok(c.mnStatus) || (!bad(c.mnStatus) && typeof v.displayChargingTimeMinute === 'number' && v.displayChargingTimeMinute <= 59);
            if (hrOk && mnOk && typeof v.displayChargingTimeHour === 'number' && v.displayChargingTimeHour <= 23 &&
                typeof v.displayChargingTimeMinute === 'number' && v.displayChargingTimeMinute <= 59) {
                c.endHour = v.displayChargingTimeHour;
                c.endMin = v.displayChargingTimeMinute;
            } else if (bad(c.hrStatus) || v.displayChargingTimeHour >= 24) {
                c.endHour = null;
                c.endMin = null;
            }
            markReal();
        };

        const feedLastStateCharging = (v) => {
            if (!v || typeof v !== 'object') return;
            const c = this.chargingRaw;
            const s = v.chargingStatusLsc;
            if (s === 2 || s === 'LADEN_AKTIV') c.lscStatus = 'active';
            else if (s === 1 || s === 'INITIALISIERUNG') c.lscStatus = 'init';
            else if (s === 3 || s === 'LADEPAUSE') c.lscStatus = 'paused';
            else if (s === 4 || s === 'LADEN_BEENDET' || s === 'LADEBEENDET') c.lscStatus = 'done';
            else if (s === 5 || s === 'LADEFEHLER') c.lscStatus = 'error';
            else if (s === 0 || s === 'KEIN_LADEN') c.lscStatus = 'none';
            if (typeof v.predictionChargingDuration === 'number' && v.predictionChargingDuration > 0 && v.predictionChargingDuration < 65000) {
                c.predDurMin = v.predictionChargingDuration;
            }
            if (typeof v.displayActValueSoc === 'number' && v.displayActValueSoc >= 0 && v.displayActValueSoc <= 100 && this.live.someipSocPct === undefined) {
                this.live.someipSocPct = v.displayActValueSoc;
            }
            markReal();
        };

        watch('de.bmw.infotainment.vehicle.Vehicle', {
            statusNewCurrentUnitsStatusExt: (v) => {
                this.carUnitsRaw.ext = v;
                this._recomputeTpms();
                markReal();
            },
            chargingStatus2: feedChargingStatus2,
            displayChargingCurrentLimit2: feedChargingLimit,
            lastStateCallCharging: feedLastStateCharging,
        });

        watch('de.bmw.infotainment.vehicle.Charging', {
            statusChargingCable: (v) => {
                if (!v || typeof v !== 'object') return;
                const c = this.chargingRaw;
                const w = v.statusChargingWirePlugged;
                if (w === 1 || w === 'KABEL_GESTECKT') c.wirePlugged = true;
                else if (w === 0 || w === 'KEIN_KABEL_GESTECKT') c.wirePlugged = false;
                const dc = v.statusDirectCurrentChargingWirePlugged;
                if (dc === 1 || dc === 'DC_MINUS_LADESTECKER_GESTECKT') c.dcPlugged = true;
                else if (dc === 0 || dc === 'DC_MINUS_LADESTECKER_NICHT_GESTECKT') c.dcPlugged = false;
                const cm = v.chargingTypeImmediate;
                if (typeof cm === 'number') c.chargeMethod = cm;
                else if (typeof cm === 'string') c.chargeMethod = /KEIN|FEHLER|UNBEFUELLT|NICHT/.test(cm) ? 0 : 1;
                markReal();
            },
            displayChargingStatus: (v) => {
                if (!v || typeof v !== 'object') return;
                const c = this.chargingRaw;
                const p = v.statusChargeControlPlug;
                if (p === 2 || p === 'LADESTECKER_VERRIEGELT') c.plugLocked = true;
                else if (p === 1 || p === 'LADESTECKER_ENTRIEGELT') c.plugLocked = false;
                if (typeof v.statusSoeChargingTarget === 'number' && v.statusSoeChargingTarget >= 10 && v.statusSoeChargingTarget <= 100) {
                    c.targetSoc = v.statusSoeChargingTarget;
                }
                markReal();
            },
            lastStateCallCharging: feedLastStateCharging,
        });

        watch('de.bmw.infrastructure.EnvironmentalInformation', {
            ExteriorTemperature: (v) => {
                const a = sc('ambient', v && v.temperatureExterior);
                if (a !== null) this.live.ambientC = a;
            },
            UnitBN2020: (v) => {
                this.carUnitsRaw.bn = v;
                this._recomputeTpms();
                markReal();
            },
        });

        watch('de.bmw.infotainment.KombiIF', {
            statusRangeTankStatus: (v) => {
                if (v && typeof v.range === 'number' && v.range < 4095) this.live.frangeKm = v.range;
            },
            displayRangeElectricVehicle: (v) => {
                const rawEr = v && typeof v === 'object' ? v.displayRangeElectricVehicle : v;
                if (typeof rawEr === 'number' && isFinite(rawEr) && rawEr >= 0 && rawEr < 4095) {
                    const inMiles = this.resolvedUnits().distUnit === 'mi';
                    this.live.erangeKm = inMiles ? rawEr * 1.609344 : rawEr;
                    markReal();
                }
            },
            statusBordcomputerAverage: (v) => {
                if (!v || typeof v !== 'object') return;
                this.carUnitsRaw.bc = v;
                if (typeof v.consumptionAverage1BC1 === 'number' && v.consumptionAverage1BC1 < 4095) {
                    const l100 = bcToL100(v.consumptionAverage1BC1 * 0.1, v.statusUnitOfMeasurementConsumptionBC);
                    if (l100 !== null) this.live.bcFuelLPer100km = l100;
                }
                if (typeof v.speedAverage1BC1 === 'number' && v.speedAverage1BC1 < 4095) {
                    const isMph = /MPH/i.test(String(v.statusUnitOfMeasurementSpeedBC || ''));
                    this.live.bcAvgSpeedKmh = (v.speedAverage1BC1 * 0.1) * (isMph ? 1.609344 : 1);
                }
            },
            statusBordcomputerTravelData: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.wayPassed === 'number' && v.wayPassed < 65535) {
                    const inMiles = this.resolvedUnits().distUnit === 'mi';
                    this.live.tripDistKm = inMiles ? v.wayPassed * 1.609344 : v.wayPassed;
                }
                if (typeof v.rideDurationHours === 'number' && v.rideDurationHours < 4095 &&
                    typeof v.rideDurationMinutes === 'number' && v.rideDurationMinutes < 60) {
                    this.live.tripMinutes = v.rideDurationHours * 60 + v.rideDurationMinutes;
                }
            },
            statusBordcomputerElectricData: (v) => {
                if (!v || typeof v !== 'object') return;
                if (typeof v.consumptionAverageElectricBC1 === 'number' && v.consumptionAverageElectricBC1 < 4095) {
                    this.live.bcEvRaw = v.consumptionAverageElectricBC1;
                }
            },
            statusKombiSelection: (v) => {
                this.mediaTracker.feedKombiSelection(v, Date.now());
            },
        });

        watch('de.bmw.infotainment.vehicle.TPMS', {
            statusTyrePressure: (v) => this._updateTpms('pressure', v),
            statusTyreTemperature: (v) => this._updateTpms('temp', v),
            statusTargetTyrePressure: (v) => this._updateTpms('target', v),
        }, { pollMs: 10000 });

        watch('de.bmw.chassis.VehicleStabilizationManagement', {
            StabilizationManagement: (v) => {
                if (!v || typeof v !== 'object') return;
                const rawBr = v.statusBrakingDriver;
                if (rawBr !== undefined && rawBr !== null) {
                    this.live.rawBraking = rawBr;
                    // Auto-learn resting enum value when cruising on throttle & accelerating
                    if ((this.live.pedalPct || 0) > 8 && (this.live.gLong || 0) >= 0.01 && rawBr !== 3) {
                        this.live.brakeRestVal = rawBr;
                    }
                    const br = flagActive(rawBr, this.live.brakeRestVal);
                    if (br !== null) this.live.driverBraking = br;
                }
                const ab = flagActive(v.qualifierFunctionABS);
                if (ab !== null) this.live.absActive = ab;
                if (v.statusUnitRunDSC !== undefined && v.statusUnitRunDSC !== null) {
                    this.live.dscPumpState = v.statusUnitRunDSC;
                }
            },
        });

        watch('de.bmw.powertrain.AcceleratorPedal', {
            AngleAcceleratorPedal: (v) => {
                const rawPed = v && v.actualValueAngleAcceleratorPedal;
                let p = sc('pedal', rawPed);
                if (p === null && typeof rawPed === 'number' && isFinite(rawPed) && rawPed < 65535) {
                    p = rawPed * 0.025;
                }
                if (p !== null && p >= -2 && p <= 102) {
                    this.live.pedalPct = Math.max(0, Math.min(100, p));
                    if (this.live.pedalPct > 8 && (this.live.gLong || 0) >= 0.01 &&
                        this.live.rawBraking !== null && this.live.rawBraking !== 3) {
                        this.live.brakeRestVal = this.live.rawBraking;
                        this.live.driverBraking = false;
                    }
                }
            },
        });

        this._started = true;
        // Start demand-gated optional SOME/IP watchers (GapVehicleAhead, Climate2, MediaTracker, NavTracker)
        this.syncDemand(this.ctx.settings && this.ctx.settings.values ? this.ctx.settings.values : {}, this._demandExtra);

        // Poll /dev/shm/cluster-info every 500 ms and cooperatively signal /tmp/mgu-edrive-wanted.json
        const ipcTimer = setInterval(() => {
            try { this._scanIpc(); } catch (e) { this.log.warn('ipc: ' + (e.message || e)); }
        }, 500);
        this.timers.push(ipcTimer);
        try { this._scanIpc(); } catch (e) { /* ignore initial */ }

        // Start strict ReadOnlyDiag poller (0x22 / 0x01 / 0x09 only)
        this._startUds().catch((e) => this.log.warn('uds init: ' + (e.message || e)));
    }

    _setDynSub(key, want, iface, inst, handlers, onTeardown) {
        const cur = this._dynSubs[key];
        if (!want) {
            if (cur) {
                cur.cancelled = true;
                if (cur.sub) closeSub(cur.sub);
                delete this._dynSubs[key];
                if (typeof onTeardown === 'function') onTeardown();
            }
            return;
        }
        if (cur || this.stopped) return;
        if (!this.ctx.signals || typeof this.ctx.signals.watch !== 'function') {
            this._dynSubs[key] = { cancelled: false, sub: null };
            return;
        }
        const slot = { cancelled: false, sub: null };
        this._dynSubs[key] = slot;
        try {
            const p = this.ctx.signals.watch(iface, inst, handlers, this.log);
            if (p && typeof p.then === 'function') {
                p.then((r) => {
                    if (!r) return;
                    if (slot.cancelled || this.stopped || this._dynSubs[key] !== slot) {
                        closeSub(r);
                        return;
                    }
                    slot.sub = r;
                }).catch(() => {});
            } else if (p) {
                slot.sub = p;
            }
        } catch (e) {
            delete this._dynSubs[key];
            this.log.warn('watch ' + iface + ': ' + (e.message || e));
        }
    }

    /**
     * Dynamically start/stop optional SOME/IP proxies and gate UDS polling based on active settings
     * so disabled features consume zero bus bandwidth or CPU wakeups.
     */
    syncDemand(settingsValues, extraOpts) {
        const s = settingsValues || (this.ctx.settings && this.ctx.settings.values) || {};
        if (extraOpts) this._demandExtra = extraOpts;
        const ex = this._demandExtra || {};
        const forceAll = Boolean(ex.diagVisible || this.probe.untilMs > Date.now());

        const enabled = s.enabled !== false;
        const target = s.displayTarget || 'both';
        const wantHud = enabled && (target === 'both' || target === 'hud');
        const wantCluster = enabled && (target === 'both' || target === 'cluster');
        const wantPanel = wantCluster && (s.clusterSlotMode || 'panel_only') !== 'map_only';

        const l1 = s.hudLine1 || 'efficiency_gear';
        const l2 = s.hudLine2 || 'power';
        const l3 = s.hudLine3 || 'brake';
        const anyHudHeadway = l1 === 'headway' || l2 === 'headway' || l3 === 'headway';
        const anyHudBrake = l1 === 'brake' || l2 === 'brake' || l3 === 'brake';

        const wantGapAhead = (enabled && wantHud && ((s.hudHeadway || 'full') !== 'off' || anyHudHeadway)) || forceAll;
        const wantClimate = (enabled && wantPanel && s.cabinTempDisplay !== false) || forceAll;
        const wantMedia = (enabled && wantPanel && (s.widgetMedia !== false || s.widgetTrip !== false)) || forceAll;
        const wantNav = (enabled && wantHud && (s.hudNavMode || 'own_nav_minimap') !== 'yield_route') || forceAll;

        const crMode = s.cornerRightDisplay || 'auto';
        const clMode = s.cornerLeftDisplay || 'oil_cool';
        const smartAlerts = s.smartAlerts !== false;
        const veh = s.vehicle || 'auto';

        this._demand = {
            gapAhead: wantGapAhead,
            climate: wantClimate,
            media: wantMedia,
            nav: wantNav,
            brakeUds: (enabled && ((wantCluster && (s.brakeIndicator || 'bar_num') !== 'off') || (wantHud && anyHudBrake))) || forceAll,
            hvUds: (enabled && veh !== 'ice') || forceAll,
            v12Uds: (enabled && (smartAlerts || (wantPanel && s.widgetTrip !== false) || (wantCluster && (crMode === 'auto' || crMode === 'v12')))) || forceAll,
            gbxUds: (enabled && (smartAlerts || (wantPanel && s.widgetTrip !== false) || (wantCluster && (clMode === 'oil_gbx' || crMode === 'gbx')))) || forceAll,
            iatUds: (enabled && ((wantPanel && s.widgetTrip !== false && veh !== 'phev') || (wantCluster && (crMode === 'iat' || crMode === 'auto')))) || forceAll,
        };

        if (!this._started || this.stopped) return this._demand;

        const markReal = () => { this.lastRealSignalT = Date.now(); };

        this._setDynSub('gapAhead', wantGapAhead, 'de.bmw.dass.GapVehicleAhead', '1', {
            GapVehicleDrivingAhead: (v) => {
                this.leadTracker.feedGapAhead(v, Date.now());
                markReal();
            },
            DataFrontVehicle: (v) => {
                this.leadTracker.feedDataFront(v, Date.now());
                markReal();
            },
            DataFrontVehicleExtended: (v) => {
                this.leadTracker.feedDataFrontExt(v);
                markReal();
            },
        }, () => { this.leadTracker.reset(); });

        this._setDynSub('climate', wantClimate, 'de.bmw.infotainment.climate.Climate2', '1', {
            statusTemperatureInside: (v) => {
                if (v && typeof v === 'object' && typeof v.temperatureInside === 'number') {
                    this.live.rawCabinTemp = v.temperatureInside;
                }
                const tc = decodeCabinTemp(v);
                if (tc !== null) {
                    this.live.cabinTempC = tc;
                    markReal();
                }
            },
        }, () => { this.live.cabinTempC = undefined; });

        if (wantNav && !this._navActive) {
            this._navActive = true;
            this.navTracker.start(this.ctx, this.log, () => Boolean(this._demand.nav));
        } else if (!wantNav && this._navActive) {
            this._navActive = false;
            this.navTracker.stop();
        }

        if (wantMedia && !this._mediaActive) {
            this._mediaActive = true;
            this.mediaTracker.start(this.ctx, this.log);
        } else if (!wantMedia && this._mediaActive) {
            this._mediaActive = false;
            this.mediaTracker.stop();
        }

        return this._demand;
    }

    activeWatchers() {
        return {
            gapAhead: Boolean(this._dynSubs.gapAhead),
            climate: Boolean(this._dynSubs.climate),
            media: this._mediaActive,
            nav: this._navActive,
            brakeUds: Boolean(this._demand.brakeUds),
            hvUds: Boolean(this._demand.hvUds),
        };
    }

    wakeUds() {
        if (this.diag && typeof this.diag.wake === 'function') {
            this.diag.wake();
        }
        this.uds.smeSilentSince = 0;
    }

    pollNow() {
        this.wakeUds();
        if (typeof this._pollNowFn === 'function') {
            return this._pollNowFn();
        }
        return Promise.resolve();
    }

    _appendProbeLine(line) {
        const targets = [this.probeLogPath];
        if (this.ctx && this.ctx.dataDir) {
            const alt = path.join(this.ctx.dataDir, 'brake-probe.log');
            if (alt !== this.probeLogPath) targets.push(alt);
        }
        for (let i = 0; i < targets.length; i++) {
            const p = targets[i];
            try {
                let sz = 0;
                try { sz = fs.statSync(p).size; } catch (e) { sz = 0; }
                if (sz < PROBE_MAX_BYTES) {
                    fs.appendFileSync(p, line + '\n');
                    if (i === 0) this.probe.savedPath = p;
                }
            } catch (e) { /* best effort */ }
        }
    }

    startProbe(durationMs) {
        const dur = (typeof durationMs === 'number' && durationMs > 0) ? Math.min(durationMs, 60000) : 30000;
        const now = Date.now();
        this.wakeUds();
        this.dsc.probed = false;
        this.probe.untilMs = now + dur;
        this.probe.lines = 0;
        this.probe.savedPath = this.probeLogPath;
        this.syncDemand(this.ctx.settings && this.ctx.settings.values ? this.ctx.settings.values : {}, this._demandExtra);

        const targets = [this.probeLogPath];
        if (this.ctx && this.ctx.dataDir) {
            const alt = path.join(this.ctx.dataDir, 'brake-probe.log');
            if (alt !== this.probeLogPath) targets.push(alt);
        }
        const header = '# cluster_metrics v0.4.0 brake+nav probe started ' + new Date(now).toISOString() + ' (' + Math.round(dur / 1000) + 's)\n';
        for (let i = 0; i < targets.length; i++) {
            try { fs.writeFileSync(targets[i], header); } catch (e) { /* ignore */ }
        }

        if (this.probe.timer) clearInterval(this.probe.timer);
        let busy = false;
        const step = async () => {
            if (this.stopped || Date.now() >= this.probe.untilMs) {
                if (this.probe.timer) {
                    clearInterval(this.probe.timer);
                    this.probe.timer = null;
                }
                this.probe.untilMs = 0;
                this.syncDemand(this.ctx.settings && this.ctx.settings.values ? this.ctx.settings.values : {}, this._demandExtra);
                this._appendProbeLine('# probe finished lines=' + this.probe.lines);
                return;
            }
            if (busy) return;
            busy = true;
            try {
                if (typeof this._probeStepFn === 'function') {
                    await this._probeStepFn();
                }
                const tNow = Date.now();
                const navSnap = this.navTracker.snapshot(tNow);
                const leadSnap = this.leadTracker.snapshot(this.live.speedKmh, tNow);
                const rec = {
                    t: new Date(tNow).toISOString(),
                    spdKmh: this.live.speedKmh !== undefined ? Number(this.live.speedKmh.toFixed(1)) : null,
                    stage: this.live.stage || null,
                    gear: this.live.gear !== undefined ? this.live.gear : null,
                    gLong: this.live.gLong !== undefined ? Number(this.live.gLong.toFixed(3)) : null,
                    pedalPct: this.live.pedalPct !== undefined ? Number(this.live.pedalPct.toFixed(1)) : null,
                    hvKw: this.live.udsKw !== undefined ? Number(this.live.udsKw.toFixed(1)) : null,
                    recupPct: this.live.recupNeedlePct !== undefined ? this.live.recupNeedlePct : null,
                    brkSw: this.live.driverBraking !== undefined ? this.live.driverBraking : null,
                    rawBrk: this.live.rawBraking,
                    dscPump: this.live.dscPumpState,
                    someipHv: this.live.hvEnergyRaw || this.live.rawChargeHybrid,
                    soc12: this.live.soc12 !== undefined ? this.live.soc12 : this.live.rawSoc12,
                    cabinC: this.live.cabinTempC !== undefined ? this.live.cabinTempC : null,
                    rawCabin: this.live.rawCabinTemp,
                    lead: {
                        active: leadSnap.active,
                        gapM: leadSnap.gapM !== null ? Number(leadSnap.gapM.toFixed(2)) : null,
                        hwSec: leadSnap.headwaySec !== null ? Number(leadSnap.headwaySec.toFixed(2)) : null,
                        relKmh: leadSnap.relSpeedKmh !== null ? Number(leadSnap.relSpeedKmh.toFixed(1)) : null,
                        raw8: leadSnap.rawGap8,
                        rawX: leadSnap.rawGapX,
                        rawVx: leadSnap.rawSpeedX,
                        st: leadSnap.status,
                    },
                    dsc: {
                        sgbd: this.dsc.sgbd,
                        did: this.dsc.pressDid ? this.dsc.pressDid.toString(16).toUpperCase() : null,
                        caliperBar: this.dsc.caliperBar !== null ? Number(this.dsc.caliperBar.toFixed(1)) : null,
                        k1: this.dsc.k1Bar !== null ? Number(this.dsc.k1Bar.toFixed(1)) : null,
                        k2: this.dsc.k2Bar !== null ? Number(this.dsc.k2Bar.toFixed(1)) : null,
                        ch4: this.dsc.ch4Bar !== null ? Number(this.dsc.ch4Bar.toFixed(1)) : null,
                        ch8: this.dsc.ch8Bar !== null ? Number(this.dsc.ch8Bar.toFixed(1)) : null,
                        wegIstMm: this.dsc.wegIstMm !== null ? Number(this.dsc.wegIstMm.toFixed(2)) : null,
                        wegLeerMm: this.dsc.wegLeerMm !== null ? Number(this.dsc.wegLeerMm.toFixed(2)) : null,
                        regenSollNm: this.dsc.regenSollNm,
                        regenIstNm: this.dsc.regenIstNm,
                        nrc: this.dsc.nrc || undefined,
                        hex: this.dsc.lastHex || undefined,
                    },
                    nav: {
                        summary: navSnap.summary,
                        miniMap: navSnap.miniMapActive,
                        reason: navSnap.miniMapReason || undefined,
                        hudSlots: navSnap.hudSlots || undefined,
                    },
                };
                this.probe.lines++;
                this._appendProbeLine(JSON.stringify(rec));
            } catch (e) {
                this._appendProbeLine('# step error: ' + (e.message || e));
            } finally {
                busy = false;
            }
        };
        this.probe.timer = setInterval(step, 350);
        if (this.probe.timer && typeof this.probe.timer.unref === 'function') this.probe.timer.unref();
        return step();
    }

    _tpmsRawToBar(raw) {
        if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0 || raw >= 65532) return null;
        const v = raw * 0.1;
        // BMW TPMS sends raw * 0.1 in the car's configured air-pressure unit (BAR: 0.5..6.5, PSI: 7..65, KPA: 65..600).
        // The physical ranges are strictly disjoint for passenger tires, preventing 33.0 psi (raw=330) from ever reading as 33.0 bar (479 psi)!
        const det = this.detectedUnits();
        if (det && det.pressUnit === 'psi' && v >= 6.5 && v < 80) {
            this.tpmsRaw.psiSeen = true;
            return v / 14.5038;
        }
        if (det && det.pressUnit === 'bar' && v >= 0.4 && v <= 6.5) {
            return v;
        }
        if (v >= 0.5 && v <= 6.5) return v;
        if (v >= 7.0 && v < 65.0) {
            this.tpmsRaw.psiSeen = true;
            return v / 14.5038;
        }
        if (v >= 65.0 && v <= 600.0) return v / 100;
        return null;
    }

    _tpmsRawToTempC(raw) {
        if (typeof raw !== 'number' || !isFinite(raw) || raw >= 65532) return null;
        const v = raw - 40;
        const det = this.detectedUnits();
        const isF = (det && det.tempUnit === 'F') ? true : (det && det.tempUnit === 'C' ? false : this.tpmsRaw.psiSeen);
        const c = isF ? ((v - 32) * 5 / 9) : v;
        return (c >= -45 && c <= 160) ? c : null;
    }

    _recomputeTpms() {
        const corners = ['FL', 'FR', 'RL', 'RR'];
        for (let i = 0; i < corners.length; i++) {
            const c = corners[i];
            const entry = this.live.tpms[c] || (this.live.tpms[c] = {});
            if (this.tpmsRaw.p[c] !== undefined) {
                const pb = this._tpmsRawToBar(this.tpmsRaw.p[c]);
                entry.pressureBar = pb !== null ? pb : undefined;
            }
            if (this.tpmsRaw.target[c] !== undefined) {
                const tb = this._tpmsRawToBar(this.tpmsRaw.target[c]);
                entry.targetBar = tb !== null ? tb : undefined;
            }
            if (this.tpmsRaw.temp[c] !== undefined) {
                const tc = this._tpmsRawToTempC(this.tpmsRaw.temp[c]);
                entry.tempC = tc !== null ? tc : undefined;
            }
        }
    }

    _updateTpms(kind, v) {
        if (!v || typeof v !== 'object') return;
        const map = [
            ['FL', 'actualValuePressureTyreFLH', 'actualValueTemperatureTyreFLH', 'targetPressureTyreFLH'],
            ['FR', 'actualValuePressureTyreFRH', 'actualValueTemperatureTyreFRH', 'targetPressureTyreFRH'],
            ['RL', 'actualValuePressureTyreRLH', 'actualValueTemperatureTyreRLH', 'targetPressureTyreRLH'],
            ['RR', 'actualValuePressureTyreRRH', 'actualValueTemperatureTyreRRH', 'targetPressureTyreRRH'],
        ];
        for (let i = 0; i < map.length; i++) {
            const [corner, pf, tf, tgf] = map[i];
            if (kind === 'pressure' && typeof v[pf] === 'number') this.tpmsRaw.p[corner] = v[pf];
            else if (kind === 'target' && typeof v[tgf] === 'number') this.tpmsRaw.target[corner] = v[tgf];
            else if (kind === 'temp' && typeof v[tf] === 'number') this.tpmsRaw.temp[corner] = v[tf];
        }
        this._recomputeTpms();
    }

    _scanIpc() {
        const now = Date.now();
        // Cooperatively signal eDrive (/tmp/mgu-edrive-wanted.json) so if eDrive is installed & running,
        // it shares live HV kW & SoC into /dev/shm/cluster-info instead of both apps competing over UDS.
        const enabled = !this.ctx.settings || this.ctx.settings.get('enabled') !== false;
        if (enabled && !this.live.carLocked && !this.opts.noDiag && now - this._lastWantedWrite >= 1500) {
            this._lastWantedWrite = now;
            try {
                fs.writeFileSync(this.edriveWantedPath, JSON.stringify({ t: now, power: true, soc: true }));
            } catch (e) { /* optional tmpfs */ }
        }

        let names = [];
        try { names = fs.readdirSync(this.ipcDir); } catch (e) {
            this.ipc.active = false;
            this.ipc.list = [];
            return;
        }
        const found = [];
        let kw, soc, erange, frange, batt, brakeBar;
        for (let i = 0; i < names.length; i++) {
            const n = names[i];
            if (!/\.json$/.test(n) || /^wanted/.test(n)) continue;
            try {
                const j = JSON.parse(fs.readFileSync(path.join(this.ipcDir, n), 'utf8'));
                if (!j || typeof j.t !== 'number' || now - j.t >= IPC_STALE_MS) continue;
                found.push(j.app || n.replace(/\.json$/, ''));
                if (kw === undefined && j.power && !j.power.old && typeof j.power.kw === 'number') kw = j.power.kw;
                if (soc === undefined && j.values && j.values.soc && typeof j.values.soc.pct === 'number') soc = j.values.soc.pct;
                if (erange === undefined && j.values && j.values.erange && typeof j.values.erange.km === 'number') erange = j.values.erange.km;
                if (frange === undefined && j.values && j.values.frange && typeof j.values.frange.km === 'number') frange = j.values.frange.km;
                if (batt === undefined && j.values && j.values.battery && typeof j.values.battery.c === 'number') batt = j.values.battery.c;
                if (brakeBar === undefined && j.brake && typeof j.brake.bar === 'number') brakeBar = j.brake.bar;
            } catch (e) { /* half-written json */ }
        }
        this.ipc.active = found.length > 0;
        this.ipc.list = found;
        this.ipc.kw = kw;
        this.ipc.soc = soc;
        this.ipc.erange = erange;
        this.ipc.frange = frange;
        this.ipc.battery = batt;
        this.ipc.brakeBar = brakeBar;
        this.ipc.t = found.length ? now : 0;
        if (typeof kw === 'number' && isFinite(kw)) this.fastKw.reading(kw, now);
    }

    async _startUds() {
        if (this.opts.noDiag) return;
        const cfg = (this.ctx.spec && this.ctx.spec.config && this.ctx.spec.config.dids) || {};
        const link = this.opts.diagLink || new ReadOnlyDiag(this.ctx.signals, this.log, { gapMs: 25, silentAfter: 10 });
        if (!this.opts.diagLink) await link.init();
        this.diag = link;
        this.uds.available = Boolean(link.available);
        if (!link.available) return;

        const smeCfg = cfg.sme || { ecu: 7 };
        const dmeCfg = cfg.dme || { ecu: 18 };
        const egsCfg = cfg.egs || { ecu: 24 };
        const smeEcu = smeCfg.ecu || 7;
        const fastHvVList = (smeCfg.hvV || []).map((c) => Object.assign({}, c, { timeoutMs: 1200 }));
        const fastHvIList = (smeCfg.hvI || []).map((c) => Object.assign({}, c, { timeoutMs: 1200 }));
        const smeSocList = (smeCfg.soc || []).map((c) => Object.assign({}, c, { timeoutMs: 1200 }));

        this.readers.sme = new DidReader(link, { ecu: smeEcu }, this.log);
        this.readers.dme = new DidReader(link, { ecu: dmeCfg.ecu || 18 }, this.log);
        this.readers.egs = new DidReader(link, { ecu: egsCfg.ecu || 24 }, this.log);

        // Single serialized queue on the diagnostic link so fast HV kW reads jump ahead cleanly
        const queue = [];
        let pumping = false;
        const syncStats = () => {
            this.uds.stats = link.stats;
            this.uds.busy = link.busy;
        };
        const pump = async () => {
            if (pumping || this.stopped) return;
            pumping = true;
            while (queue.length && !this.stopped) {
                const job = queue.shift();
                try {
                    job.res(await job.fn());
                } catch (e) {
                    job.rej(e);
                } finally {
                    syncStats();
                }
            }
            pumping = false;
        };
        const exclusive = (fn, urgent) => new Promise((res, rej) => {
            if (urgent) queue.unshift({ fn, res, rej });
            else queue.push({ fn, res, rej });
            pump();
        });

        // Self-healing wake helper: never let transient gateway contention permanently mute SME for the rest of a drive!
        const checkSmeSilence = () => {
            if (!link.silent(smeEcu)) {
                this.uds.smeSilentSince = 0;
                return false;
            }
            const now = Date.now();
            if (!this.uds.smeSilentSince) this.uds.smeSilentSince = now;
            const cooldownMs = this.uds.smeAnswered ? 5000 : 25000;
            if (!this.live.carLocked && now - this.uds.smeSilentSince >= cooldownMs) {
                if (typeof link.wake === 'function') link.wake(smeEcu);
                this.uds.smeSilentSince = 0;
                return false;
            }
            return true;
        };

        let fastBusy = false;
        let slowBusy = false;
        let slowTick = 0;

        const readSmePower = () => exclusive(async () => {
            const now0 = Date.now();
            // Cache pack voltage for 5 s (or use LSCDataSink pack voltage) so nearly every fast cycle only sends 1 DID (hvI)
            let hvV = (typeof this.live.udsHvV === 'number' && now0 - (this.live.udsHvVT || 0) < 5000)
                ? this.live.udsHvV : null;
            if (hvV === null) {
                const vRead = await this.readers.sme.value('hvV', fastHvVList);
                if (typeof vRead === 'number') {
                    hvV = vRead;
                    this.live.udsHvV = vRead;
                    this.live.udsHvVT = Date.now();
                } else if (typeof this.live.lscVolts === 'number' && Date.now() - (this.live.lscVoltsT || 0) < 60000) {
                    hvV = this.live.lscVolts;
                }
            }
            const hvI = await this.readers.sme.value('hvI', fastHvIList);
            if (typeof hvV === 'number' && typeof hvI === 'number') {
                const sign = typeof cfg.powerSign === 'number' ? cfg.powerSign : -1;
                const kw = (hvV * hvI / 1000) * sign;
                const now = Date.now();
                this.live.udsKw = kw;
                this.live.udsKwT = now;
                this.fastKw.reading(kw, now);
                this.uds.smeAnswered = true;
                if (!this.lastRealSignalT) this.lastRealSignalT = now;
            }
        }, true);

        const readSmeSocAndTemp = () => exclusive(async () => {
            const socVal = await this.readers.sme.value('soc', smeSocList);
            if (typeof socVal === 'number') {
                this.live.udsSoc = socVal;
                this.uds.smeAnswered = true;
                if (!this.lastRealSignalT) this.lastRealSignalT = Date.now();
            }
            if (this.live.battTempC === undefined && !(this.ipc.active && typeof this.ipc.battery === 'number')) {
                const ctVal = await this.readers.sme.value('cellT', smeCfg.cellT || []);
                if (typeof ctVal === 'number') {
                    this.live.udsBattC = ctVal;
                    this.uds.smeAnswered = true;
                }
            }
        }, false);

        const readDscDid = (did, timeoutMs) => link.physical(
            DSC_ECU, 0x22, [(did >> 8) & 0xFF, did & 0xFF], timeoutMs || 650
        );

        const applyDscPressure = (p) => {
            if (!p) return;
            const now = Date.now();
            this.dsc.k1Bar = p.k1;
            this.dsc.k2Bar = p.k2;
            this.dsc.ch4Bar = p.ch4;
            this.dsc.ch8Bar = p.ch8;
            this.dsc.lastHex = p.rawHex;
            this.dsc.t = now;
            if (p.wheelMax > 1.2) this.dsc.wheelSensorSeen = true;

            const spd = this.live.speedKmh !== undefined ? this.live.speedKmh : null;
            const stopped = spd === null || spd < 2.0;
            const recupActive = (this.live.recupNeedlePct || 0) > 1.5 ||
                (typeof this.live.udsKw === 'number' && this.live.udsKw < -1.0);
            if (p.did === 'DB29') {
                this.dsc.caliperBar = p.wheelMax;
            } else if (this.dsc.wheelSensorSeen) {
                this.dsc.caliperBar = p.wheelMax > 1.2 ? p.wheelMax : (stopped ? p.masterMax : p.wheelMax);
            } else if (stopped || !recupActive) {
                this.dsc.caliperBar = Math.max(p.wheelMax, p.masterMax);
            } else {
                this.dsc.caliperBar = null;
            }
            if (!this.lastRealSignalT) this.lastRealSignalT = now;
        };

        const probeDscOnce = async () => {
            if (link.silent(DSC_ECU)) return;
            const f150 = await readDscDid(0xF150, 700);
            if (isPositiveDid(f150, 0xF150) && f150.length >= 6) {
                const sgbdNum = (((f150[3] & 0xFF) << 16) | ((f150[4] & 0xFF) << 8) | (f150[5] & 0xFF)) >>> 0;
                this.dsc.sgbd = sgbdNum.toString(16).toUpperCase().padStart(6, '0');
            }
            const uE5 = await readDscDid(0xDBE5, 700);
            if (isPositiveDid(uE5, 0xDBE5)) {
                this.dsc.pressDid = 0xDBE5;
                this.dsc.nrc = '';
                applyDscPressure(decodeDscPressure(0xDBE5, uE5));
            } else {
                if (Array.isArray(uE5) && uE5[0] === 0x7F) this.dsc.nrc = 'DBE5:' + hexBytes(uE5);
                const u29 = await readDscDid(0xDB29, 700);
                if (isPositiveDid(u29, 0xDB29)) {
                    this.dsc.pressDid = 0xDB29;
                    this.dsc.nrc = '';
                    applyDscPressure(decodeDscPressure(0xDB29, u29));
                } else {
                    if (Array.isArray(u29) && u29[0] === 0x7F) {
                        this.dsc.nrc = (this.dsc.nrc ? this.dsc.nrc + ' ' : '') + 'DB29:' + hexBytes(u29);
                    }
                    if (uE5 !== null || u29 !== null) this.dsc.pressDid = 0; // answered NRC: don't spam unsupported DID
                }
            }
            this.dsc.probed = true;
        };

        const checkDscSilence = () => {
            if (!link.silent(DSC_ECU)) {
                this.dsc.silentSince = 0;
                return false;
            }
            const now = Date.now();
            if (!this.dsc.silentSince) this.dsc.silentSince = now;
            const cooldownMs = this.dsc.pressDid ? 5000 : 25000;
            if (!this.live.carLocked && now - this.dsc.silentSince >= cooldownMs) {
                if (typeof link.wake === 'function') link.wake(DSC_ECU);
                this.dsc.silentSince = 0;
                return false;
            }
            return true;
        };

        const readDscPressureFast = () => exclusive(async () => {
            if (checkDscSilence()) return;
            if (!this.dsc.probed) {
                await probeDscOnce();
                return;
            }
            if (!this.dsc.pressDid) return;
            const u = await readDscDid(this.dsc.pressDid, 480);
            if (isPositiveDid(u, this.dsc.pressDid)) {
                applyDscPressure(decodeDscPressure(this.dsc.pressDid, u));
            }
        }, true);

        this._probeStepFn = () => exclusive(async () => {
            if (link.silent(DSC_ECU) && typeof link.wake === 'function') link.wake(DSC_ECU);
            if (!this.dsc.probed) await probeDscOnce();
            else if (this.dsc.pressDid) {
                const uP = await readDscDid(this.dsc.pressDid, 600);
                if (isPositiveDid(uP, this.dsc.pressDid)) applyDscPressure(decodeDscPressure(this.dsc.pressDid, uP));
            }
            const uPed = await readDscDid(0xDBF5, 600);
            const ped = decodeDscPedal(uPed);
            if (ped) {
                this.dsc.wegIstMm = ped.wegIstMm;
                this.dsc.wegLeerMm = ped.wegLeerMm;
            }
            const uReg = await readDscDid(0xDBF6, 600);
            const reg = decodeDscRegen(uReg);
            if (reg) {
                this.dsc.regenSollNm = reg.regenSollNm;
                this.dsc.regenIstNm = reg.regenIstNm;
            }
        }, false);

        this._pollNowFn = async () => {
            if (this.stopped || !link.available) return;
            try {
                await readSmeSocAndTemp();
                await readSmePower();
                await exclusive(async () => {
                    this.dsc.probed = false;
                    await probeDscOnce();
                    const v12Val = await this.readers.dme.value('v12', dmeCfg.v12 || []);
                    if (typeof v12Val === 'number') this.live.v12 = v12Val;
                    if (!link.silent(egsCfg.ecu || 24)) {
                        const gbVal = await this.readers.egs.value('gearboxOil', egsCfg.gearboxOil || []);
                        if (typeof gbVal === 'number') this.live.gearboxOilC = gbVal;
                    }
                    if (!link.silent(dmeCfg.ecu || 18)) {
                        const iatVal = await this.readers.dme.value('iat', dmeCfg.iat || []);
                        if (typeof iatVal === 'number') this.live.iatC = iatVal;
                    }
                }, false);
            } catch (e) {
                this.log.warn('uds pollNow: ' + (e.message || e));
            }
        };

        // Prime HV SoC %, HV kW, and DSC brake pressure sensor ID immediately upon startup
        if (!this.isDemoActive() && !this.live.carLocked) {
            readSmeSocAndTemp().catch(() => {});
            readSmePower().catch(() => {});
            exclusive(() => probeDscOnce(), false).catch(() => {});
        }

        const isEnabled = () => !this.ctx.settings || this.ctx.settings.get('enabled') !== false;
        let dscBusy = false;

        // Dedicated real-time DSC 0x29 hydraulic caliper pressure loop (260 ms, ~3.8 Hz):
        // Never relies on event-only StabilizationManagement.statusBrakingDriver (which stays false during normal
        // braking on G30!). Polls DSC 0xDBE5/0xDB29 directly whenever not in Park and foot is off throttle (< 4%),
        // matching the exact responsive caliper pressure seen during the 30s Brake Probe, with zero UDS traffic while on gas!
        const dscTimer = setInterval(() => {
            if (this.stopped || !isEnabled() || !this._demand.brakeUds || this.isDemoActive() || this.live.carLocked) return;
            if (this.probe.untilMs > Date.now()) return;
            const stg = this.live.stage || null;
            if (stg === 'P') {
                if (this.dsc.caliperBar !== null && this.dsc.caliperBar !== 0) {
                    this.dsc.caliperBar = 0;
                    this.dsc.t = Date.now();
                }
                return;
            }
            const ped = this.live.pedalPct;
            const onThrottle = typeof ped === 'number' && ped >= 4.0 && !this.live.absActive;
            if (onThrottle) {
                if (this.dsc.caliperBar !== null) {
                    this.dsc.caliperBar = 0;
                    this.dsc.t = Date.now();
                }
                return;
            }
            if (!dscBusy && this.dsc.pressDid !== 0) {
                dscBusy = true;
                readDscPressureFast().catch(() => {}).then(() => { dscBusy = false; });
            }
        }, 260);
        this.timers.push(dscTimer);

        // Fast SME HV voltage/current loop (~420 ms)
        const fastTimer = setInterval(async () => {
            if (this.stopped || !isEnabled() || !this._demand.hvUds || this.isDemoActive() || this.live.carLocked) return;
            if (fastBusy || (this.ipc.active && typeof this.ipc.kw === 'number')) return;
            if (checkSmeSilence()) return;
            fastBusy = true;
            try {
                await readSmePower();
            } catch (e) {
                this.log.warn('uds fast: ' + (e.message || e));
            } finally {
                fastBusy = false;
            }
        }, 420);
        this.timers.push(fastTimer);

        // Slow round-robin UDS loop for SoC %, CellTemp, DME fuelRate, 12V battery, IAT, Gearbox oil
        const slowTimer = setInterval(async () => {
            if (this.stopped || slowBusy || !isEnabled() || this.isDemoActive() || this.live.carLocked) return;
            slowBusy = true;
            slowTick++;
            try {
                if (this._demand.hvUds && !(this.ipc.active && typeof this.ipc.soc === 'number') && !checkSmeSilence()) {
                    await readSmeSocAndTemp();
                }
                if ((this.live.rpm || 0) >= 350 && !link.silent(dmeCfg.ecu || 18)) {
                    await exclusive(async () => {
                        const frVal = await this.readers.dme.value('fuelRate', dmeCfg.fuelRate || []);
                        if (typeof frVal === 'number') this.live.dmeFuelLh = frVal;
                        if (this.live.oilTempC === undefined) {
                            const oilVal = await this.readers.dme.value('oil', dmeCfg.oil || []);
                            if (typeof oilVal === 'number') this.live.oilTempC = oilVal;
                        }
                    }, false);
                }
                if (this._demand.v12Uds && slowTick % 8 === 1) {
                    if (link.silent(dmeCfg.ecu || 18) && slowTick % 24 === 1 && typeof link.wake === 'function') {
                        link.wake(dmeCfg.ecu || 18);
                    }
                    if (!link.silent(dmeCfg.ecu || 18)) {
                        await exclusive(async () => {
                            const v12Val = await this.readers.dme.value('v12', dmeCfg.v12 || []);
                            if (typeof v12Val === 'number') this.live.v12 = v12Val;
                        }, false);
                    }
                }
                if (this._demand.gbxUds && slowTick % 6 === 2 && this.live.gearboxOilC === undefined && !link.silent(egsCfg.ecu || 24)) {
                    await exclusive(async () => {
                        const gbVal = await this.readers.egs.value('gearboxOil', egsCfg.gearboxOil || []);
                        if (typeof gbVal === 'number') this.live.gearboxOilC = gbVal;
                    }, false);
                }
                if (this._demand.iatUds && slowTick % 6 === 4 && !link.silent(dmeCfg.ecu || 18)) {
                    await exclusive(async () => {
                        const iatVal = await this.readers.dme.value('iat', dmeCfg.iat || []);
                        if (typeof iatVal === 'number') this.live.iatC = iatVal;
                    }, false);
                }
            } catch (e) {
                this.log.warn('uds slow: ' + (e.message || e));
            } finally {
                slowBusy = false;
            }
        }, 2500);
        this.timers.push(slowTimer);
    }

    isDemoActive() {
        const mode = (this.ctx.settings && this.ctx.settings.get('demo')) || 'auto';
        if (mode === 'phev' || mode === 'ice') return true;
        if (mode === 'off') return false;
        // 'auto': stay demo until real car SOME/IP or UDS telemetry arrives
        return this.lastRealSignalT === 0 && !this.ipc.active;
    }

    detectedUnits() {
        return decodeCarUnits(this.carUnitsRaw.ext, this.carUnitsRaw.bn, this.carUnitsRaw.bc);
    }

    resolvedUnits() {
        const settingsObj = this.ctx.settings && this.ctx.settings.values ? this.ctx.settings.values : {};
        return resolveUnits(settingsObj, this.detectedUnits());
    }

    isNavRouteActive() {
        return this.navTracker.routing() && !this.navTracker.phonesMismatch();
    }

    snapshot(nowMs) {
        const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
        const demoMode = (this.ctx.settings && this.ctx.settings.get('demo')) || 'auto';
        const probeRemainingSec = this.probe.untilMs > now ? Math.ceil((this.probe.untilMs - now) / 1000) : 0;

        if (this.isDemoActive()) {
            const vehPref = (this.ctx.settings && this.ctx.settings.get('vehicle')) || 'auto';
            const simKind = demoMode === 'charging' ? 'charging' : (demoMode === 'ice' ? 'ice' : (demoMode === 'phev' ? 'phev' : (vehPref === 'ice' ? 'ice' : 'phev')));
            const d = this.demoGen.sample(simKind, now);
            d.smeAnswered = simKind === 'phev' || simKind === 'charging';
            d.ipcActive = false;
            d.navRouteActive = Boolean(d.hudNav && d.hudNav.routeActive);
            d.navHasLanes = Boolean(d.hudNav && d.hudNav.hasLanes);
            d.probeRemainingSec = probeRemainingSec;
            d.probeSavedPath = this.probe.savedPath;
            d.dscBrake = null;
            d.media = this.mediaTracker.snapshot(now, true);
            d.charging = d.charging || { active: false, plugConnected: false, source: 'idle', chargeKw: null, maxAmps: null, targetSoc: 100, remainMin: null, remainText: '', finishTimeText: '--:--' };
            d.tripDistKm = 42.6;
            d.tripMinutes = 54;
            return d;
        }

        const l = this.live;
        const ipcFresh = this.ipc.active;
        const fastKwVal = this.fastKw.now(now);
        const hvKw = (ipcFresh && typeof this.ipc.kw === 'number') ? this.ipc.kw
            : (fastKwVal !== null ? fastKwVal
                : (l.udsKw !== undefined && now - (l.udsKwT || 0) < UDS_KW_KEEP_MS ? l.udsKw : null));
        const soc = (ipcFresh && typeof this.ipc.soc === 'number') ? this.ipc.soc
            : (l.udsSoc !== undefined ? l.udsSoc
                : (l.someipSocPct !== undefined ? l.someipSocPct : null));
        const battTempC = l.battTempC !== undefined ? l.battTempC
            : (ipcFresh && typeof this.ipc.battery === 'number' ? this.ipc.battery : (l.udsBattC !== undefined ? l.udsBattC : null));
        const program = l.mdriveProgram || l.program || 'D';
        const gear = l.gear !== undefined ? l.gear : l.guessedGear;
        const speedKmh = l.speedKmh !== undefined ? l.speedKmh : null;
        const gLong = l.gLong !== undefined ? l.gLong : null;
        const dscFresh = typeof this.dsc.caliperBar === 'number' && (now - (this.dsc.t || 0) < 4000 || this.dsc.caliperBar === 0);
        const onThrottle = typeof l.pedalPct === 'number' && l.pedalPct >= 4.0 && !l.absActive && l.driverBraking !== true;
        const brakeBar = onThrottle ? 0
            : ((ipcFresh && typeof this.ipc.brakeBar === 'number') ? this.ipc.brakeBar
                : (dscFresh ? this.dsc.caliperBar : null));
        const recupPct = (l.recupNeedlePct !== undefined && now - (l.needleT || 0) < 2500) ? l.recupNeedlePct : 0;
        const fb = computeFrictionBrake({
            speedKmh,
            rpm: l.rpm !== undefined ? l.rpm : 0,
            gear: gear !== undefined ? gear : null,
            hvKw,
            recupPct,
            gLong,
            pedalPct: l.pedalPct !== undefined ? l.pedalPct : null,
            driverBraking: l.driverBraking !== undefined ? l.driverBraking : null,
            absActive: l.absActive === true,
            torqueNm: l.torqueNm !== undefined ? l.torqueNm : null,
            massKg: l.massKg !== undefined ? l.massKg : null,
            brakeBar,
        });

        const hudNav = this.navTracker.snapshot(now);
        const navRouteActive = hudNav.routeActive;
        const navHasLanes = hudNav.hasLanes;
        const charging = computeChargingState(this.chargingRaw, {
            speedKmh,
            rpm: l.rpm !== undefined ? l.rpm : 0,
            hvKw,
            soc,
            stage: l.stage || null,
        }, now);

        return {
            speedKmh: l.speedKmh !== undefined ? l.speedKmh : null,
            rpm: l.rpm !== undefined ? l.rpm : 0,
            gear: gear !== undefined ? gear : null,
            stage: l.stage || null,
            program,
            hvKw,
            soc,
            battTempC,
            oilTempC: l.oilTempC !== undefined ? l.oilTempC : null,
            coolantTempC: l.coolantTempC !== undefined ? l.coolantTempC : null,
            boostBar: l.boostBar !== undefined ? l.boostBar : null,
            dmeFuelLh: l.dmeFuelLh !== undefined ? l.dmeFuelLh : null,
            injVolumeRaw: l.injVolumeRaw !== undefined ? l.injVolumeRaw : null,
            bcFuelLPer100km: l.bcFuelLPer100km !== undefined ? l.bcFuelLPer100km : null,
            erangeKm: (ipcFresh && typeof this.ipc.erange === 'number') ? this.ipc.erange : (l.erangeKm !== undefined ? l.erangeKm : null),
            frangeKm: (ipcFresh && typeof this.ipc.frange === 'number') ? this.ipc.frange : (l.frangeKm !== undefined ? l.frangeKm : null),
            gLong,
            gLat: l.gLat !== undefined ? l.gLat : null,
            pedalPct: l.pedalPct !== undefined ? l.pedalPct : null,
            driverBraking: l.driverBraking !== undefined ? l.driverBraking : null,
            rawBraking: l.rawBraking,
            torqueNm: l.torqueNm !== undefined ? l.torqueNm : null,
            massKg: l.massKg !== undefined ? l.massKg : null,
            brakeBar,
            dscBrake: {
                sgbd: this.dsc.sgbd,
                did: this.dsc.pressDid ? this.dsc.pressDid.toString(16).toUpperCase() : null,
                caliperBar: this.dsc.caliperBar,
                k1Bar: this.dsc.k1Bar,
                k2Bar: this.dsc.k2Bar,
                ch4Bar: this.dsc.ch4Bar,
                ch8Bar: this.dsc.ch8Bar,
                wegIstMm: this.dsc.wegIstMm,
                wegLeerMm: this.dsc.wegLeerMm,
                regenSollNm: this.dsc.regenSollNm,
                regenIstNm: this.dsc.regenIstNm,
                nrc: this.dsc.nrc,
            },
            frictionG: fb.frictionG,
            frictionKw: fb.frictionKw,
            pureRegen: fb.pureRegen,
            brakeHold: fb.brakeHold,
            absActive: fb.absActive,
            hudNav,
            navRouteActive,
            navHasLanes,
            media: this.mediaTracker.snapshot(now, false),
            charging,
            tripDistKm: l.tripDistKm !== undefined ? l.tripDistKm : null,
            tripMinutes: l.tripMinutes !== undefined ? l.tripMinutes : null,
            bcAvgSpeedKmh: l.bcAvgSpeedKmh !== undefined ? l.bcAvgSpeedKmh : null,
            probeRemainingSec,
            probeSavedPath: this.probe.savedPath,
            driveMode: l.driveMode || 'comfort',
            ambientC: l.ambientC !== undefined ? l.ambientC : null,
            cabinTempC: l.cabinTempC !== undefined ? l.cabinTempC : null,
            rawCabinTemp: l.rawCabinTemp !== undefined ? l.rawCabinTemp : null,
            gearboxOilC: l.gearboxOilC !== undefined ? l.gearboxOilC : null,
            v12: l.v12 !== undefined ? l.v12 : null,
            soc12: l.soc12 !== undefined ? l.soc12 : null,
            rawSoc12: l.rawSoc12 !== undefined ? l.rawSoc12 : null,
            leadVehicle: this.leadTracker.snapshot(speedKmh, now),
            iatC: l.iatC !== undefined ? l.iatC : null,
            xdriveFrontPct: l.xdriveFrontPct !== undefined ? l.xdriveFrontPct : null,
            tpms: l.tpms || {},
            smeAnswered: this.uds.smeAnswered,
            ipcActive: ipcFresh,
            demo: false,
        };
    }

    stop() {
        this.stopped = true;
        if (this.probe.timer) {
            clearInterval(this.probe.timer);
            this.probe.timer = null;
        }
        this.navTracker.stop();
        this.mediaTracker.stop();
        this._navActive = false;
        this._mediaActive = false;
        const dynKeys = Object.keys(this._dynSubs);
        for (let i = 0; i < dynKeys.length; i++) {
            const slot = this._dynSubs[dynKeys[i]];
            if (slot) {
                slot.cancelled = true;
                if (slot.sub) closeSub(slot.sub);
            }
        }
        this._dynSubs = Object.create(null);
        if (this.diag) this.diag.cancel();
        for (let i = 0; i < this.timers.length; i++) clearInterval(this.timers[i]);
        this.timers = [];
        for (let i = 0; i < this.subs.length; i++) {
            closeSub(this.subs[i]);
        }
        this.subs = [];
    }
}

module.exports = {
    SignalHub, GearGuess, FastKw, DemoGenerator, LeadVehicleTracker,
    decodeStatusBattery2, decodeCabinTemp,
    computeFrictionBrake, computeChargingState, decodeDscPressure, decodeDscPedal, decodeDscRegen,
    flagActive, gearOf, stageOf, selectionOf, programOf, driveModeOf,
};
