'use strict';
/**
 * vehicle_profile.js - Auto PHEV vs ICE detection, EV/Regen/Gas-Cold/Gas-Warm powertrain
 * state machine with engine-off hysteresis, cold-oil RPM ceiling, and quiet smart anomaly alerts.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function coldRevCeilingRpm(oilTempC, coldOilThresholdC) {
    if (typeof oilTempC !== 'number' || !isFinite(oilTempC)) return null;
    const thresh = typeof coldOilThresholdC === 'number' && isFinite(coldOilThresholdC) ? coldOilThresholdC : 75;
    if (oilTempC >= thresh) return null;
    if (oilTempC <= 20) return 3000;
    if (oilTempC <= 40) return Math.round((3000 + (oilTempC - 20) / 20 * 500) / 100) * 100;
    if (oilTempC <= 60) return Math.round((3500 + (oilTempC - 40) / 20 * 1000) / 100) * 100;
    return Math.round((4500 + (oilTempC - 60) / Math.max(1, thresh - 60) * 1000) / 100) * 100;
}

function detectAnomaly(telemetry, units, state, nowMs) {
    const t = telemetry || {};
    const fmtTemp = (c) => {
        if (typeof c !== 'number' || !isFinite(c)) return '--';
        return (units && units.tempUnit === 'F') ? (Math.round(c * 9 / 5 + 32) + '\u00B0F') : (Math.round(c) + '\u00B0C');
    };
    const fmtPress = (bar) => {
        if (typeof bar !== 'number' || !isFinite(bar)) return '--';
        return (units && units.pressUnit === 'bar') ? (bar.toFixed(1) + 'b') : (Math.round(bar * 14.5038) + 'psi');
    };

    const fmtPressSpaced = (bar) => {
        if (typeof bar !== 'number' || !isFinite(bar)) return '--';
        return (units && units.pressUnit === 'bar') ? (bar.toFixed(1) + ' bar') : (Math.round(bar * 14.5038) + ' psi');
    };
    const cornerName = { FL: 'Front Left', FR: 'Front Right', RL: 'Rear Left', RR: 'Rear Right' };

    // 1. TPMS corner under-pressure (>= 0.28 bar / ~4.1 psi below target, or < 1.72 bar) or hot tire (>= 85°C)
    if (t.tpms && typeof t.tpms === 'object') {
        const corners = ['FL', 'FR', 'RL', 'RR'];
        let worstTpms = null;
        for (let i = 0; i < corners.length; i++) {
            const c = corners[i];
            const item = t.tpms[c];
            if (!item) continue;
            const p = item.pressureBar;
            const target = item.targetBar;
            const tempC = item.tempC;
            if (typeof p === 'number' && isFinite(p) && p > 0.2 && p <= 6.5) {
                const hasTarget = typeof target === 'number' && isFinite(target) && target > 0.5 && target <= 6.5;
                const deficit = hasTarget ? (target - p) : (p < 1.72 ? 1.72 - p : 0);
                if (deficit >= 0.28) {
                    const sev = (deficit >= 0.50 || p < 1.50) ? 'red' : 'amber';
                    if (!worstTpms || (sev === 'red' && worstTpms.severity !== 'red')) {
                        const tgtTxt = hasTarget ? (' (Target ' + fmtPressSpaced(target) + ')') : '';
                        worstTpms = {
                            id: 'tpms',
                            severity: sev,
                            corner: c,
                            label: c + ' ' + fmtPress(p),
                            hudText: sev === 'red' ? 'Tire Pressure Critical' : 'Tire Pressure Low',
                            title: sev === 'red' ? 'TIRE FLAT - CRITICAL' : 'TIRE PRESSURE LOW',
                            heroVal: fmtPressSpaced(p),
                            detail: cornerName[c] + ': ' + fmtPressSpaced(p) + tgtTxt,
                            advice: sev === 'red' ? 'Stop safely & inspect tire' : 'Inflate tire when safe',
                        };
                    }
                }
            }
            if (!worstTpms && typeof tempC === 'number' && isFinite(tempC) && tempC >= 85) {
                const hotCrit = tempC >= 98;
                const maxTxt = (units && units.tempUnit === 'F') ? '185\u00B0F' : '85\u00B0C';
                worstTpms = {
                    id: 'tpms_temp',
                    severity: hotCrit ? 'red' : 'amber',
                    corner: c,
                    label: c + ' ' + fmtTemp(tempC),
                    hudText: hotCrit ? 'Tire Temp Critical' : 'Tire Temp High',
                    title: hotCrit ? 'TIRE TEMP CRITICAL' : 'TIRE TEMP HIGH',
                    heroVal: fmtTemp(tempC),
                    detail: cornerName[c] + ': ' + fmtTemp(tempC) + ' (Limit ' + maxTxt + ')',
                    advice: 'Reduce speed & let tire cool',
                };
            }
        }
        if (worstTpms) return worstTpms;
    }

    // 2. ZF 8HP Gearbox over-temperature (> 105°C / 221°F)
    if (typeof t.gearboxOilC === 'number' && isFinite(t.gearboxOilC) && t.gearboxOilC >= 105) {
        const gCrit = t.gearboxOilC >= 115;
        const limTxt = (units && units.tempUnit === 'F') ? (gCrit ? '239\u00B0F' : '221\u00B0F') : (gCrit ? '115\u00B0C' : '105\u00B0C');
        return {
            id: 'gbox',
            severity: gCrit ? 'red' : 'amber',
            label: 'GBX ' + fmtTemp(t.gearboxOilC),
            hudText: gCrit ? 'Gearbox Critical' : 'Gearbox Hot',
            title: gCrit ? 'GEARBOX TEMP CRITICAL' : 'GEARBOX OIL HOT',
            heroVal: fmtTemp(t.gearboxOilC),
            detail: 'Transmission oil > ' + limTxt,
            advice: gCrit ? 'Pull over safely & cool down' : 'Reduce load & allow cooling',
        };
    }

    // 3. 12V Auxiliary battery low State of Charge (< 55% sustained >= 5s)
    if (typeof t.soc12 === 'number' && isFinite(t.soc12) && t.soc12 >= 0 && t.soc12 < 55) {
        if (!state._soc12LowSince) state._soc12LowSince = nowMs;
        if (nowMs - state._soc12LowSince >= 5000) {
            const sCrit = t.soc12 < 40;
            return {
                id: 'soc12',
                severity: sCrit ? 'red' : 'amber',
                label: '12V ' + Math.round(t.soc12) + '%',
                hudText: sCrit ? '12V Battery Critical' : '12V Battery Low',
                title: sCrit ? '12V BATTERY CRITICAL' : '12V BATTERY LOW',
                heroVal: Math.round(t.soc12) + '%',
                detail: '12V Aux State of Charge < ' + (sCrit ? '40%' : '55%'),
                advice: 'Drive or charge to replenish 12V',
            };
        }
    } else {
        state._soc12LowSince = 0;
    }

    // 4. 12V Auxiliary battery low voltage (< 12.1 V sustained >= 5s)
    if (typeof t.v12 === 'number' && isFinite(t.v12) && t.v12 > 5 && t.v12 < 12.1) {
        if (!state._v12LowSince) state._v12LowSince = nowMs;
        if (nowMs - state._v12LowSince >= 5000) {
            const vCrit = t.v12 < 11.7;
            return {
                id: 'v12',
                severity: vCrit ? 'red' : 'amber',
                label: '12V ' + t.v12.toFixed(1) + 'V',
                hudText: vCrit ? '12V Battery Critical' : '12V Battery Low',
                title: vCrit ? '12V VOLTAGE CRITICAL' : '12V BATTERY LOW',
                heroVal: t.v12.toFixed(1) + ' V',
                detail: '12V Aux Voltage < ' + (vCrit ? '11.7 V' : '12.1 V'),
                advice: vCrit ? 'Check charging system / battery' : 'Drive or charge to replenish 12V',
            };
        }
    } else {
        state._v12LowSince = 0;
    }

    return null;
}

class VehicleProfile {
    constructor() {
        this.reset();
    }

    reset() {
        this.detectedType = null; // null until clear evidence ('phev' | 'ice')
        this.iceOnlySince = 0;
        this.engineOn = false;
        this.engineOffSince = 0;
        this._alertState = { _v12LowSince: 0, _soc12LowSince: 0 };
    }

    evaluate(telemetry, settings, units, nowMs) {
        const t = telemetry || {};
        const s = settings || {};
        const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();

        // 1. Vehicle type ('auto' | 'phev' | 'ice')
        const hasHv = (t.soc !== null && t.soc !== undefined) ||
            (t.hvKw !== null && t.hvKw !== undefined) ||
            (t.battTempC !== null && t.battTempC !== undefined) ||
            (t.erangeKm !== null && t.erangeKm !== undefined) ||
            Boolean(t.smeAnswered);

        if (s.vehicle === 'phev' || s.vehicle === 'ice') {
            this.detectedType = s.vehicle;
        } else if (hasHv) {
            this.detectedType = 'phev';
            this.iceOnlySince = 0;
        } else if ((t.rpm || 0) > 400 && !t.smeAnswered) {
            if (!this.iceOnlySince) this.iceOnlySince = now;
            if (now - this.iceOnlySince >= 5000) this.detectedType = 'ice';
        }
        const vehicleType = this.detectedType || 'phev';

        // 2. Engine running hysteresis (prevent flicker on quick PHEV starts/stops)
        const rpm = typeof t.rpm === 'number' && isFinite(t.rpm) ? t.rpm : 0;
        if (vehicleType === 'ice') {
            // On pure ICE cars, start/stop at lights still keeps ICE powertrain view active
            this.engineOn = true;
            this.engineOffSince = 0;
        } else {
            if (rpm >= 450) {
                this.engineOn = true;
                this.engineOffSince = 0;
            } else if (rpm < 250) {
                if (this.engineOn) {
                    if (!this.engineOffSince) this.engineOffSince = now;
                    if (now - this.engineOffSince >= 1500) {
                        this.engineOn = false;
                    }
                }
            } else {
                // 250..449 rpm cranking/spool-down band resets off timer
                this.engineOffSince = 0;
            }
        }

        // 3. Operating mode: 'ev_drive' | 'ev_regen' | 'gas_cold' | 'gas_warm'
        const coldOilC = typeof s.coldOilC === 'number' && isFinite(s.coldOilC) ? s.coldOilC : 75;
        const oilTempC = typeof t.oilTempC === 'number' && isFinite(t.oilTempC) ? t.oilTempC : null;
        const coolantTempC = typeof t.coolantTempC === 'number' && isFinite(t.coolantTempC) ? t.coolantTempC : null;
        const hvKw = typeof t.hvKw === 'number' && isFinite(t.hvKw) ? t.hvKw : null;
        const speedKmh = typeof t.speedKmh === 'number' && isFinite(t.speedKmh) ? t.speedKmh : 0;

        let mode;
        if (vehicleType === 'phev' && !this.engineOn) {
            mode = (hvKw !== null && hvKw <= -1.5 && speedKmh > 2) ? 'ev_regen' : 'ev_drive';
        } else {
            const refTempC = oilTempC !== null ? oilTempC : (coolantTempC !== null ? coolantTempC + 5 : null);
            const isCold = refTempC !== null && refTempC < coldOilC;
            mode = isCold ? 'gas_cold' : 'gas_warm';
        }

        const coldCeilingRpm = (mode === 'gas_cold' && oilTempC !== null)
            ? coldRevCeilingRpm(oilTempC, coldOilC) : null;

        const alert = s.smartAlerts !== false ? detectAnomaly(t, units, this._alertState, now) : null;

        return {
            vehicleType,
            engineOn: this.engineOn,
            mode,
            isEv: mode === 'ev_drive' || mode === 'ev_regen',
            isCold: mode === 'gas_cold',
            coldCeilingRpm,
            alert,
        };
    }
}

module.exports = { VehicleProfile, coldRevCeilingRpm, detectAnomaly };
