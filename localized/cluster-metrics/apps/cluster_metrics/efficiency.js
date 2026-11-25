'use strict';
/**
 * efficiency.js - raw instantaneous EV (km/kWh) and Fuel (L/100km) trackers,
 * CDS2.statusInjectionVolume delta calibration, and DFCO detection.
 *
 * When stopped (speedKmh <= 1.5), instantaneous efficiency is undefined and returns null
 * so displays render `--- MPG` / `--- mi/kWh` while live kW or RPM stays on Line 2.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

class EfficiencyTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastT = 0;

        // CDS2 16-bit injection volume counter delta + auto-calibrator against DME L/h
        this.lastInjRaw = null;
        this.lastInjChangeT = 0;
        this.injAccCounts = 0;
        this.injAccDtS = 0;
        this.injFlowUlPerSec = null;
        this.injRateT = 0;
        this.ulPerCount = 1.0;
        this.injCalibrated = false;

        this.lastBcL100 = null;
        this.isDfco = false;
    }

    _updateInjectionFlow(injRaw, nowMs, dmeFuelLh, rpm) {
        if (typeof injRaw === 'number' && isFinite(injRaw) && injRaw >= 0 && injRaw < 65535) {
            if (this.lastInjRaw !== null && this.lastInjChangeT > 0) {
                const dtS = (nowMs - this.lastInjChangeT) / 1000;
                if (dtS > 5.0) {
                    this.injAccCounts = 0;
                    this.injAccDtS = 0;
                    this.lastInjRaw = injRaw;
                    this.lastInjChangeT = nowMs;
                } else if (injRaw !== this.lastInjRaw && dtS >= 0.02) {
                    // UInt16 counter wraps modulo 65536; ignore implausible jumps > 40000
                    const delta = (injRaw >= this.lastInjRaw)
                        ? (injRaw - this.lastInjRaw)
                        : ((injRaw - this.lastInjRaw + 65536) % 65536);
                    if (delta > 0 && delta < 40000) {
                        this.injAccCounts += delta;
                        this.injAccDtS += dtS;
                        if (this.injAccDtS >= 0.20) {
                            this.injFlowUlPerSec = this.injAccCounts / this.injAccDtS;
                            this.injRateT = nowMs;
                            this.injAccCounts = 0;
                            this.injAccDtS = 0;
                        }
                    }
                    this.lastInjRaw = injRaw;
                    this.lastInjChangeT = nowMs;
                } else if (dtS >= 0.9 && injRaw === this.lastInjRaw) {
                    // Counter stopped advancing (DFCO coasting or engine off)
                    this.injFlowUlPerSec = 0;
                    this.injRateT = nowMs;
                    this.injAccCounts = 0;
                    this.injAccDtS = 0;
                    this.lastInjChangeT = nowMs;
                }
            } else {
                this.lastInjRaw = injRaw;
                this.lastInjChangeT = nowMs;
            }
        }
        // Calibrate fixed physical uL-per-count scale when DME UDS fuelRate (L/h) is available alongside live counter rate
        if (typeof dmeFuelLh === 'number' && isFinite(dmeFuelLh) && dmeFuelLh > 0.3 &&
            this.injFlowUlPerSec !== null && this.injFlowUlPerSec > 5 &&
            (nowMs - this.injRateT) <= 2000 && rpm > 500) {
            const targetUlPerSec = (dmeFuelLh * 1e6) / 3600;
            const estFactor = clamp(targetUlPerSec / this.injFlowUlPerSec, 0.02, 50.0);
            this.ulPerCount = this.injCalibrated ? (this.ulPerCount * 0.75 + estFactor * 0.25) : estFactor;
            this.injCalibrated = true;
        }
    }

    /**
     * Feed one telemetry sample and return raw instantaneous metrics (held steady at 0 mph):
     * { evKmPerKwh, evInstKmPerKwh, fuelLPer100km, fuelInstLPer100km, lPerHour, isDfco }
     */
    update(sample, nowMs) {
        const s = sample || {};
        const t = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
        this.lastT = t;

        const speedKmh = typeof s.speedKmh === 'number' && isFinite(s.speedKmh) ? Math.max(0, s.speedKmh) : 0;
        const rpm = typeof s.rpm === 'number' && isFinite(s.rpm) ? Math.max(0, s.rpm) : 0;
        const engineOn = typeof s.engineOn === 'boolean' ? s.engineOn : (rpm >= 450);
        const hvKw = typeof s.hvKw === 'number' && isFinite(s.hvKw) ? s.hvKw : null;
        const dmeFuelLh = typeof s.dmeFuelLh === 'number' && isFinite(s.dmeFuelLh) ? s.dmeFuelLh : null;
        const bcL100 = typeof s.bcFuelLPer100km === 'number' && isFinite(s.bcFuelLPer100km) && s.bcFuelLPer100km > 0
            ? s.bcFuelLPer100km : null;
        if (bcL100 !== null) this.lastBcL100 = bcL100;

        this._updateInjectionFlow(s.injVolumeRaw, t, dmeFuelLh, rpm);

        // Determine instantaneous fuel flow (L/h): prefer fast SOME/IP injection counter once calibrated
        // against DME UDS fuelRate so throttle changes and DFCO respond immediately between UDS reads.
        let lPerHour = null;
        const injFresh = this.injFlowUlPerSec !== null && (t - this.injRateT) <= 1800;
        if (!engineOn || rpm < 250) {
            lPerHour = 0;
        } else if (this.injCalibrated && injFresh) {
            lPerHour = Math.max(0, (this.injFlowUlPerSec * this.ulPerCount * 3600) / 1e6);
        } else if (dmeFuelLh !== null) {
            lPerHour = Math.max(0, dmeFuelLh);
        } else if (injFresh) {
            lPerHour = Math.max(0, (this.injFlowUlPerSec * this.ulPerCount * 3600) / 1e6);
        } else if (this.lastBcL100 !== null && speedKmh > 3) {
            lPerHour = (this.lastBcL100 * speedKmh) / 100;
        }

        // 1) Raw instantaneous EV efficiency (returns null when stopped so UI displays '--- mi/kWh')
        let evInstKmPerKwh = null;
        if (!engineOn && hvKw !== null && speedKmh > 1.5) {
            evInstKmPerKwh = hvKw > 0.1 ? clamp(speedKmh / hvKw, 0.8, 19.0) : 19.0;
        }
        const evKmPerKwh = evInstKmPerKwh;

        // 2) Raw instantaneous Fuel efficiency (returns null when stopped so UI displays '--- MPG')
        this.isDfco = Boolean(engineOn && speedKmh > 20 && lPerHour !== null && lPerHour < 0.15);
        let fuelInstLPer100km = null;
        let fuelLPer100km = null;
        if (engineOn && speedKmh > 1.5) {
            if (lPerHour !== null) {
                fuelInstLPer100km = clamp((lPerHour / speedKmh) * 100, 0, 99.9);
                fuelLPer100km = clamp(fuelInstLPer100km, 0.5, 99.9);
            } else if (this.lastBcL100 !== null) {
                fuelLPer100km = clamp(this.lastBcL100, 0.5, 99.9);
            }
        }

        return {
            evKmPerKwh,
            evInstKmPerKwh,
            fuelLPer100km,
            fuelInstLPer100km,
            lPerHour,
            isDfco: this.isDfco,
        };
    }
}

module.exports = { EfficiencyTracker };
