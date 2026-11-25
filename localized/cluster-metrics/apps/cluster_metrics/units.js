'use strict';
/**
 * units.js - decodes BMW iDrive 7 system unit settings (Vehicle & EnvironmentalInformation)
 * and resolves user unit overrides + clean numeric formatting.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const KM_PER_MI = 1.609344;
const MI_PER_KM = 0.6213711922;
const PSI_PER_BAR = 14.5037738;
const US_MPG_FACTOR = 235.214583;
const UK_MPG_FACTOR = 282.480936;

const US_PRESET = {
    system: 'us',
    tempUnit: 'F',
    speedUnit: 'mph',
    distUnit: 'mi',
    fuelEffUnit: 'mpg_us',
    evEffUnit: 'mi_kwh',
    pressUnit: 'psi',
};

const METRIC_PRESET = {
    system: 'metric',
    tempUnit: 'C',
    speedUnit: 'kmh',
    distUnit: 'km',
    fuelEffUnit: 'l_100km',
    evEffUnit: 'kwh_100km',
    pressUnit: 'bar',
};

const UK_PRESET = {
    system: 'uk',
    tempUnit: 'C',
    speedUnit: 'mph',
    distUnit: 'mi',
    fuelEffUnit: 'mpg_uk',
    evEffUnit: 'mi_kwh',
    pressUnit: 'psi',
};

function normStr(v) {
    return v === undefined || v === null ? '' : String(v).trim().toUpperCase();
}

/**
 * Decode BMW Vehicle.statusNewCurrentUnitsStatusExt + EnvironmentalInformation.UnitBN2020
 * + KombiIF.statusBordcomputerAverage into partial detected unit preferences.
 */
function decodeCarUnits(rawExt, rawBn, rawBc) {
    const out = {};
    const apply = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        const t = obj.unitOfMeasurementTemperature !== undefined ? obj.unitOfMeasurementTemperature : obj.temperature;
        const ts = normStr(t);
        if (t === 1 || ts === '1' || /CELSIUS|DEG_C|^C$/.test(ts)) out.tempUnit = 'C';
        else if (t === 2 || ts === '2' || /FAHRENHEIT|DEG_F|^F$/.test(ts)) out.tempUnit = 'F';

        const p = obj.unitOfMeasurementAirPressure !== undefined ? obj.unitOfMeasurementAirPressure : obj.pressure;
        const ps = normStr(p);
        if (p === 1 || ps === '1' || /^BAR$/.test(ps)) out.pressUnit = 'bar';
        else if (p === 2 || ps === '2' || /^KPA$/.test(ps)) out.pressUnit = 'bar';
        else if (p === 3 || ps === '3' || /^PSI$/.test(ps)) out.pressUnit = 'psi';

        const d = obj.unitOfMeasurementDistance !== undefined ? obj.unitOfMeasurementDistance : obj.distance;
        const ds = normStr(d);
        if (d === 1 || ds === '1' || /^KM$|KILOMETER/.test(ds)) { out.distUnit = 'km'; out.speedUnit = 'kmh'; }
        else if (d === 2 || ds === '2' || /^MI$|MILE/.test(ds)) { out.distUnit = 'mi'; out.speedUnit = 'mph'; }

        const fc = obj.unitOfMeasurementConsumptionFuel !== undefined
            ? obj.unitOfMeasurementConsumptionFuel
            : (obj.unitOfMeasurementConsumption !== undefined ? obj.unitOfMeasurementConsumption : obj.statusUnitOfMeasurementConsumptionBC);
        const fcs = normStr(fc);
        if (fc === 1 || fcs === '1' || /L_?100|L\/100/.test(fcs)) out.fuelEffUnit = 'l_100km';
        else if (fc === 2 || fcs === '2' || /MPG_?UK/.test(fcs)) out.fuelEffUnit = 'mpg_uk';
        else if (fc === 3 || fcs === '3' || /MPG_?US|^MPG$/.test(fcs)) out.fuelEffUnit = 'mpg_us';
        else if (fc === 4 || fcs === '4' || /KM_?L|KM\/L/.test(fcs)) out.fuelEffUnit = 'km_l';

        const ec = obj.unitOfMeasurementConsumptionElectric !== undefined
            ? obj.unitOfMeasurementConsumptionElectric
            : obj.unitOfMeasurementConsumptionElectricEnergy;
        const ecs = normStr(ec);
        if (/MI_?KWH|MI\/KWH/.test(ecs) || ec === 3) out.evEffUnit = 'mi_kwh';
        else if (/KWH_?100|KWH\/100/.test(ecs) || ec === 1) out.evEffUnit = 'kwh_100km';
        else if (/KM_?KWH|KM\/KWH/.test(ecs) || ec === 2) out.evEffUnit = 'kwh_100km';
        else if (/WH_?MI|WH\/MI/.test(ecs)) out.evEffUnit = 'wh_mi';
    };

    apply(rawBn);
    apply(rawExt);
    apply(rawBc);

    // Derive sensible linked defaults if car only reported partial fields (e.g. only temp/distance)
    if (!out.speedUnit && out.distUnit) out.speedUnit = out.distUnit === 'mi' ? 'mph' : 'kmh';
    if (!out.fuelEffUnit && out.distUnit) {
        out.fuelEffUnit = out.distUnit === 'mi' ? (out.tempUnit === 'C' ? 'mpg_uk' : 'mpg_us') : 'l_100km';
    }
    if (!out.evEffUnit && out.distUnit) {
        out.evEffUnit = out.distUnit === 'mi' ? 'mi_kwh' : 'kwh_100km';
    }
    if (!out.pressUnit && out.distUnit) {
        out.pressUnit = out.distUnit === 'mi' ? 'psi' : 'bar';
    }
    if (!out.tempUnit && out.distUnit) {
        out.tempUnit = (out.fuelEffUnit === 'mpg_uk') ? 'C' : (out.distUnit === 'mi' ? 'F' : 'C');
    }
    return out;
}

/**
 * Resolve effective units from settings + decoded car units.
 */
function resolveUnits(settingsObj, detectedCarUnits) {
    const s = settingsObj || {};
    const sys = s.unitSystem || 'auto';
    let base;
    if (sys === 'us') base = Object.assign({}, US_PRESET);
    else if (sys === 'metric') base = Object.assign({}, METRIC_PRESET);
    else if (sys === 'uk') base = Object.assign({}, UK_PRESET);
    else {
        const car = detectedCarUnits && typeof detectedCarUnits === 'object' ? detectedCarUnits : {};
        base = Object.assign({}, US_PRESET, car);
        base.system = 'auto';
        if (base.distUnit === 'mi') {
            base.speedUnit = 'mph';
        } else if (base.distUnit === 'km') {
            base.speedUnit = 'kmh';
        }
    }

    if (s.tempUnit && s.tempUnit !== 'auto') base.tempUnit = s.tempUnit;
    if (s.evEffUnit && s.evEffUnit !== 'auto') base.evEffUnit = s.evEffUnit;
    if (s.fuelEffUnit && s.fuelEffUnit !== 'auto') base.fuelEffUnit = s.fuelEffUnit;
    if (s.pressUnit && s.pressUnit !== 'auto') base.pressUnit = s.pressUnit;
    return base;
}

function cToDisplay(degC, units) {
    if (typeof degC !== 'number' || !isFinite(degC)) return null;
    return (units && units.tempUnit === 'F') ? (degC * 9 / 5 + 32) : degC;
}

function formatTemp(degC, units) {
    const u = (units && units.tempUnit === 'F') ? 'F' : 'C';
    const val = cToDisplay(degC, units);
    if (val === null) return { value: '--', unit: '\u00B0' + u, text: '--' };
    const rounded = String(Math.round(val));
    return { value: rounded, unit: '\u00B0' + u, text: rounded + '\u00B0' + u };
}

function formatEvEff(kmPerKwh, units) {
    const mode = (units && units.evEffUnit) || 'mi_kwh';
    const labelMap = {
        mi_kwh: 'mi/kWh',
        kwh_100km: 'kWh/100km',
        wh_mi: 'Wh/mi',
    };
    const unitLabel = labelMap[mode] || 'mi/kWh';
    if (typeof kmPerKwh !== 'number' || !isFinite(kmPerKwh) || kmPerKwh <= 0) {
        return { value: '---', unit: unitLabel };
    }
    if (mode === 'kwh_100km') {
        const kwh100 = Math.min(99.9, Math.max(4.0, 100 / kmPerKwh));
        return { value: kwh100.toFixed(1), unit: unitLabel };
    }
    if (mode === 'wh_mi') {
        const whMi = Math.min(1999, Math.max(80, 1000 / (kmPerKwh * MI_PER_KM)));
        return { value: String(Math.round(whMi)), unit: unitLabel };
    }
    const miKwh = Math.min(12.0, Math.max(0.2, kmPerKwh * MI_PER_KM));
    return { value: miKwh.toFixed(1), unit: unitLabel };
}

function formatFuelEff(lPer100km, isDfco, units) {
    const mode = (units && units.fuelEffUnit) || 'mpg_us';
    const labelMap = {
        mpg_us: 'MPG',
        mpg_uk: 'MPG UK',
        l_100km: 'L/100km',
        km_l: 'km/L',
    };
    const unitLabel = labelMap[mode] || 'MPG';
    if (isDfco) {
        return { value: mode === 'l_100km' ? '0.0' : '99+', unit: unitLabel };
    }
    if (typeof lPer100km !== 'number' || !isFinite(lPer100km) || lPer100km <= 0) {
        return { value: '---', unit: unitLabel };
    }
    if (mode === 'l_100km') {
        return { value: Math.min(99.9, lPer100km).toFixed(1), unit: unitLabel };
    }
    if (mode === 'km_l') {
        const kml = Math.min(99.9, 100 / lPer100km);
        return { value: kml.toFixed(1), unit: unitLabel };
    }
    const factor = mode === 'mpg_uk' ? UK_MPG_FACTOR : US_MPG_FACTOR;
    const mpg = factor / lPer100km;
    if (mpg >= 99.5) return { value: '99+', unit: unitLabel };
    return { value: mpg.toFixed(1), unit: unitLabel };
}

function formatPress(bar, signed, units) {
    const u = (units && units.pressUnit) === 'bar' ? 'bar' : 'psi';
    if (typeof bar !== 'number' || !isFinite(bar)) return { value: '--', unit: u, text: '-- ' + u };
    const prefix = signed && bar > 0.02 ? '+' : '';
    if (u === 'bar') {
        const v = bar.toFixed(2);
        return { value: prefix + v, unit: 'bar', text: prefix + v + ' bar' };
    }
    const psi = (bar * PSI_PER_BAR).toFixed(1);
    return { value: prefix + psi, unit: 'psi', text: prefix + psi + ' psi' };
}

function formatSpeed(kmh, units) {
    const u = (units && units.speedUnit === 'kmh') ? 'km/h' : 'mph';
    if (typeof kmh !== 'number' || !isFinite(kmh)) return { value: '--', unit: u };
    const v = u === 'mph' ? kmh * MI_PER_KM : kmh;
    return { value: String(Math.round(v)), unit: u };
}

function formatPowerKw(kw) {
    if (typeof kw !== 'number' || !isFinite(kw)) return { value: '--', unit: 'kW', text: '-- kW', charging: false };
    const charging = kw < -0.05;
    const abs = Math.abs(kw);
    const num = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    const val = charging ? ('+' + num) : num;
    return { value: val, unit: 'kW', text: val + ' kW', charging };
}

module.exports = {
    KM_PER_MI,
    MI_PER_KM,
    PSI_PER_BAR,
    US_MPG_FACTOR,
    UK_MPG_FACTOR,
    US_PRESET,
    METRIC_PRESET,
    UK_PRESET,
    decodeCarUnits,
    resolveUnits,
    cToDisplay,
    formatTemp,
    formatEvEff,
    formatFuelEff,
    formatPress,
    formatSpeed,
    formatPowerKw,
};
