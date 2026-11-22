'use strict';
/**
 * test/run_tests.js - Automated verification suite for idrive7-cluster-metrics.
 */

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'apps', 'cluster_metrics');
const VENDOR = path.join(ROOT, 'vendor', 'cauliflowermossgrape-idrive7-apps');
const KIT_RT = path.join(ROOT, 'kit', 'runtime');
const VENDOR_FILES = {
    './cluster_render_client': path.join(APP_DIR, 'cluster_render_client.js'),
    './redline_hud_nav': path.join(APP_DIR, 'redline_hud_nav.js'),
    './redline_nav': path.join(APP_DIR, 'redline_nav.js'),
    './jpeg_decoder': path.join(APP_DIR, 'jpeg_decoder.js'),
};

// Map ./kit/* and build-time vendor/npm modules just as kit/tools/build.py packages them
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) {
        return origLoad.call(this, path.join(KIT_RT, req.slice(6)), parent, isMain);
    }
    if (Object.prototype.hasOwnProperty.call(VENDOR_FILES, req)) {
        return origLoad.call(this, VENDOR_FILES[req], parent, isMain);
    }
    return origLoad.call(this, req, parent, isMain);
};

const visible = require(path.join(ROOT, 'shared', 'visible'));
const unitsMod = require(path.join(APP_DIR, 'units'));
const { EfficiencyTracker } = require(path.join(APP_DIR, 'efficiency'));
const { VehicleProfile, coldRevCeilingRpm, detectAnomaly } = require(path.join(APP_DIR, 'vehicle_profile'));
const {
    OverlayRenderer, inspectClusterSlotConfig, resolveCornerRightMode, formatLeadHeadwayParts, cabinHvacPalette, CLUSTER_LAYER_NAMES,
} = require(path.join(APP_DIR, 'overlay_renderer'));
const { ClusterRender } = require(VENDOR_FILES['./cluster_render_client']);
const {
    SignalHub, FastKw, LeadVehicleTracker, decodeStatusBattery2, decodeCabinTemp,
    createHvacState, feedHvacClimate2, feedHvacClimateMaster, resolveHvacMode,
    calcCarClockOffsetMin,
    computeFrictionBrake, computeChargingState, decodeDscPressure, decodeDscPedal, decodeDscRegen, flagActive,
} = require(path.join(APP_DIR, 'signals'));
const { NavTracker, parseHudStatusText, parseWazeHudShowing } = require(path.join(APP_DIR, 'nav_tracker'));
const {
    NW: HUD_NAV_W, NH: HUD_NAV_H, ROAD_W: HUD_ROAD_W, ROAD_H: HUD_ROAD_H,
    drawHudNav, drawHudRoadBanner, hudNavKey, hudRoadKey,
} = require(path.join(APP_DIR, 'hud_nav_renderer'));
const { MediaTracker, parseHmiPlayerMetadata, paginateTitle } = require(path.join(APP_DIR, 'media_tracker'));
const { decodeCoverThumb, buildStockBackdrop } = require(path.join(APP_DIR, 'image_decode'));
const { Canvas } = require(path.join(KIT_RT, 'canvas'));
const { check: diagCheck } = require(path.join(KIT_RT, 'readonly-diag'));
const { headUnit } = require(path.join(ROOT, 'kit', 'tools', 'hu-stub.js'));

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log('PASS ' + name);
}

function stripCommentsAndStrings(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/'([^'\\]|\\.)*'/g, "''")
        .replace(/"([^"\\]|\\.)*"/g, '""');
}

function inBox(x, y, box) {
    return x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
}

(async () => {
    /* 1. ES2017 / Node 8.16.2 Syntax & Font Charset Check */
    await test('Node 8.16.2 (ES2017) syntax & baked font ASCII+degree check', () => {
        const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
        assert(files.length >= 6);
        assert(!files.includes('shoulder_graphs.js'), 'shoulder_graphs.js must be retired');
        for (let i = 0; i < files.length; i++) {
            const p = path.join(APP_DIR, files[i]);
            const code = fs.readFileSync(p, 'utf8');
            new vm.Script(code, { filename: files[i] });
            const stripped = stripCommentsAndStrings(code);
            assert(!/\?\./.test(stripped), files[i] + ': forbidden optional chaining ?.');
            assert(!/\?\?/.test(stripped), files[i] + ': forbidden nullish coalescing ??');
            assert(!/Object\.fromEntries/.test(stripped), files[i] + ': forbidden Object.fromEntries');
            assert(!/\.flat\s*\(/.test(stripped), files[i] + ': forbidden Array.prototype.flat');
            const reText = /\.text\([^;\n]+\)/g;
            let m;
            while ((m = reText.exec(code)) !== null) {
                for (let j = 0; j < m[0].length; j++) {
                    const cp = m[0].codePointAt(j);
                    assert(cp <= 0x7e || cp === 0x00b0, files[i] + ' unsupported glyph codepoint in: ' + m[0]);
                }
            }
        }
    });

    /* 2. ReadOnlyDiag Enforcement */
    await test('ReadOnlyDiag security audit (no raw diag import, write UDS blocked)', () => {
        const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
        for (let i = 0; i < files.length; i++) {
            const code = fs.readFileSync(path.join(APP_DIR, files[i]), 'utf8');
            assert(!/require\(['"]\.\/kit\/diag['"]\)/.test(code), files[i] + ' must not require raw ./kit/diag');
        }
        diagCheck(0x12, 0x22, [0xF4, 0x0C], false);
        diagCheck(0x12, 0x01, [0x5E], false);
        diagCheck(0x12, 0x09, [0x02], false);
        diagCheck(0xDF, 0x22, [0xF1, 0x50], true);
        [0x10, 0x11, 0x14, 0x27, 0x28, 0x2C, 0x2E, 0x2F, 0x31, 0x34, 0x3E, 0x85].forEach((sid) => {
            assert.throws(() => diagCheck(0x12, sid, [0x01], false), /not allowed/);
        });
        assert.throws(() => diagCheck(0xDF, 0x22, [0x56, 0x56], true), /22 F1 50/);
    });

    /* 3. Units Decoding, Auto Sync & Overrides */
    await test('Units decode BMW signals + support Auto/US/Metric/UK overrides', () => {
        const metricDet = unitsMod.decodeCarUnits({
            unitOfMeasurementTemperature: 1,
            unitOfMeasurementAirPressure: 1,
            unitOfMeasurementDistance: 1,
            unitOfMeasurementConsumptionFuel: 1,
            unitOfMeasurementConsumptionElectric: 'KWH_100KM',
        });
        const autoMetric = unitsMod.resolveUnits({ unitSystem: 'auto' }, metricDet);
        assert.strictEqual(autoMetric.tempUnit, 'C');
        assert.strictEqual(autoMetric.pressUnit, 'bar');
        assert.strictEqual(autoMetric.fuelEffUnit, 'l_100km');
        assert.strictEqual(autoMetric.evEffUnit, 'kwh_100km');

        const usOverride = unitsMod.resolveUnits({ unitSystem: 'us' }, metricDet);
        assert.strictEqual(usOverride.tempUnit, 'F');
        assert.strictEqual(usOverride.fuelEffUnit, 'mpg_us');
        assert.strictEqual(usOverride.evEffUnit, 'mi_kwh');
        assert.strictEqual(usOverride.pressUnit, 'psi');

        assert.strictEqual(unitsMod.formatEvEff(6.11, unitsMod.US_PRESET).value, '3.8');
        assert.strictEqual(unitsMod.formatEvEff(6.11, unitsMod.METRIC_PRESET).value, '16.4');
        assert.strictEqual(unitsMod.formatFuelEff(7.0, false, unitsMod.US_PRESET).value, '33.6');
        assert.strictEqual(unitsMod.formatFuelEff(7.0, true, unitsMod.US_PRESET).value, '99+');
        assert.strictEqual(unitsMod.formatFuelEff(7.0, true, unitsMod.METRIC_PRESET).value, '0.0');
        assert.strictEqual(unitsMod.formatTemp(23.5, unitsMod.US_PRESET).text, '74\u00B0F');
    });

    /* 4. Efficiency Integration (No IDLE Hijack at 0 mph) */
    await test('Efficiency holds rolling mi/kWh at 0 mph (never IDLE hijack) & handles DFCO', () => {
        const eff = new EfficiencyTracker();
        let t = 100000;
        for (let i = 0; i <= 30; i++) {
            t += 1000;
            eff.update({ speedKmh: 72, rpm: 0, engineOn: false, hvKw: 12.0 }, t);
        }
        const cruising = eff.update({ speedKmh: 72, rpm: 0, engineOn: false, hvKw: 12.0 }, t + 1000);
        assert(Math.abs(cruising.evKmPerKwh - 6.0) < 0.2, 'expected ~6.0 km/kWh, got ' + cruising.evKmPerKwh);

        let stopped;
        for (let i = 0; i < 20; i++) {
            t += 1000;
            stopped = eff.update({ speedKmh: 0, rpm: 0, engineOn: false, hvKw: 1.6 }, t);
        }
        assert(Math.abs(stopped.evKmPerKwh - cruising.evKmPerKwh) < 0.01, 'must hold EV efficiency at 0 mph');

        const renderer = new OverlayRenderer({ allowPanel: true });
        const profile = { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null };
        renderer.render({
            telemetry: { speedKmh: 0, rpm: 0, hvKw: 1.6, soc: 68, battTempC: 23.5, stage: 'D', program: 'D', gear: 1 },
            units: unitsMod.US_PRESET,
            profile,
            efficiency: stopped,
        }, { enabled: true, gearDisplay: 'next_to_d' }, t);
        assert.strictEqual(renderer.lastSummary.hero.value, '3.7');
        assert.strictEqual(renderer.lastSummary.hero.unit, 'mi/kWh');
        assert.strictEqual(renderer.lastSummary.subText, '+1.6 kW');

        const gasRes = eff.update({ speedKmh: 95, rpm: 1800, engineOn: true, dmeFuelLh: 0.0 }, t + 1000);
        assert.strictEqual(gasRes.isDfco, true);
    });

    /* 5. VehicleProfile Hysteresis, Cold Ceiling & Smart Alerts */
    await test('VehicleProfile auto PHEV/ICE detection, 1.5s hysteresis, cold ceiling & alerts', () => {
        const vp = new VehicleProfile();
        let t = 50000;
        let p = vp.evaluate({ speedKmh: 60, rpm: 0, hvKw: 14, soc: 70, oilTempC: 45 }, { vehicle: 'auto', coldOilC: 75 }, unitsMod.US_PRESET, t);
        assert.strictEqual(p.isEv, true);
        assert.strictEqual(p.mode, 'ev_drive');
        p = vp.evaluate({ speedKmh: 85, rpm: 2200, hvKw: 2, soc: 70, oilTempC: 48 }, { vehicle: 'auto', coldOilC: 75 }, unitsMod.US_PRESET, t + 500);
        assert.strictEqual(p.engineOn, true);
        assert.strictEqual(p.mode, 'gas_cold');
        assert.strictEqual(coldRevCeilingRpm(48, 75), 3900);
        p = vp.evaluate({ speedKmh: 80, rpm: 0, hvKw: 10, soc: 70, oilTempC: 48 }, { vehicle: 'auto', coldOilC: 75 }, unitsMod.US_PRESET, t + 1000);
        assert.strictEqual(p.engineOn, true);
        p = vp.evaluate({ speedKmh: 80, rpm: 0, hvKw: 10, soc: 70, oilTempC: 48 }, { vehicle: 'auto', coldOilC: 75 }, unitsMod.US_PRESET, t + 2600);
        assert.strictEqual(p.engineOn, false);
        assert.strictEqual(p.mode, 'ev_drive');

        const ast = { _v12LowSince: 0, _soc12LowSince: 0 };
        assert.strictEqual(detectAnomaly({ tpms: { FL: { pressureBar: 2.4, targetBar: 2.4 } }, gearboxOilC: 85, v12: 14.1, soc12: 84 }, unitsMod.US_PRESET, ast, 1000), null);
        const lowTire = detectAnomaly({ tpms: { FL: { pressureBar: 1.9, targetBar: 2.4 } } }, unitsMod.US_PRESET, ast, 2000);
        assert(lowTire && lowTire.id === 'tpms' && lowTire.label.indexOf('FL') === 0);
        const hotGbx = detectAnomaly({ gearboxOilC: 110 }, unitsMod.US_PRESET, ast, 3000);
        assert(hotGbx && hotGbx.id === 'gbox');
        assert.strictEqual(detectAnomaly({ soc12: 48 }, unitsMod.US_PRESET, ast, 3200), null);
        const lowSoc12 = detectAnomaly({ soc12: 48 }, unitsMod.US_PRESET, ast, 8500);
        assert(lowSoc12 && lowSoc12.id === 'soc12' && lowSoc12.severity === 'amber' && lowSoc12.label === '12V 48%');
        const critSoc12 = detectAnomaly({ soc12: 35 }, unitsMod.US_PRESET, ast, 9000);
        assert(critSoc12 && critSoc12.id === 'soc12' && critSoc12.severity === 'red');
        assert.strictEqual(detectAnomaly({ soc12: 82, v12: 11.9 }, unitsMod.US_PRESET, ast, 10000), null);
        const lowV12 = detectAnomaly({ soc12: 82, v12: 11.9 }, unitsMod.US_PRESET, ast, 16000);
        assert(lowV12 && lowV12.id === 'v12');
    });

    /* 6. Gear Digit Strictly Clear of KOMBI4 GEAR_WIN (1380..1460) & Baseline Aligned (664..698) */
    await test('Gear digit stays strictly clear of GEAR_WIN (x >= 1461), left of cabin_temp (1488..1539), and hides in S/M/P/R/N', () => {
        const r = new OverlayRenderer({ allowPanel: true });
        const modelBase = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: { speedKmh: 72, rpm: 0, hvKw: 14.2, soc: 68, soc12: 86, cabinTempC: 22.0, battTempC: 23.5, oilTempC: 48, coolantTempC: 73, stage: 'D', program: 'D', gear: 2 },
        };

        [-12, 0, 12].forEach((nudgeX) => {
            r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d', clusterNudgeX: nudgeX }, 1000);
            assert.strictEqual(r.layers.gear_d.visible, true);
            const gd = r.layers.gear_d;
            assert(gd.rect.x >= 1461 && gd.rect.x <= 1464, 'gear_d layer rect must stay strictly clear of GEAR_WIN (1461..1464), got x=' + gd.rect.x);
            assert(r.layers.cabin_temp.rect.x >= gd.rect.x + gd.rect.w - 3 && r.layers.cabin_temp.rect.x + r.layers.cabin_temp.rect.w <= 1540,
                'cabin_temp must sit cleanly between gear_d and AMBIENT_TEMP (1540), got ' + JSON.stringify(r.layers.cabin_temp.rect));
            const gdd = gd.cv.d;
            let maxR = 0, maxG = 0, maxB = 0, minWy = 999, maxWy = 0;
            for (let py = 0; py < gd.rect.h; py++) {
                for (let px = 0; px < gd.rect.w; px++) {
                    const off = (py * gd.rect.w + px) * 4;
                    const a = gdd[off + 3];
                    if (a === 0) continue;
                    const rr = gdd[off], gg = gdd[off + 1], bb = gdd[off + 2];
                    if (a >= 80) assert(bb - rr <= 30, 'gear_d must stay white in EV mode');
                    if (rr > maxR) maxR = rr;
                    if (gg > maxG) maxG = gg;
                    if (bb > maxB) maxB = bb;
                    const wx = gd.rect.x + px, wy = gd.rect.y + py;
                    assert(wx >= 1461 && wx < 1490, 'gear_d pixel must stay clear of GEAR_WIN (<=1460) at wx=' + wx);
                    if (wy < minWy) minWy = wy;
                    if (wy > maxWy) maxWy = wy;
                }
            }
            assert(maxR > 200 && maxG > 200 && maxB > 200, 'gear_d expected bright white text pixels');
            assert(minWy >= 660 && minWy <= 674, 'gear_d top should align with BMW D (~666), got minWy=' + minWy);
            assert(maxWy >= 690 && maxWy <= 700, 'gear_d bottom should align with BMW D (~696), got maxWy=' + maxWy);
        });

        modelBase.telemetry.program = 'S';
        r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d' }, 1200);
        assert.strictEqual(r.layers.gear_d.visible, false);

        modelBase.telemetry.program = 'M';
        r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d' }, 1400);
        assert.strictEqual(r.layers.gear_d.visible, false);

        modelBase.telemetry.program = 'D';
        ['P', 'R', 'N'].forEach((st) => {
            modelBase.telemetry.stage = st;
            r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d' }, 1600);
            assert.strictEqual(r.layers.gear_d.visible, false);
            assert.strictEqual(r.layers.brake_rail.visible, st !== 'P', 'brake_rail must hide in Park (P) and stay visible in ' + st);
        });

        // Stationary / charging state before EGS emits stage (stage=null, speed=0, gear=null) must also hide brake_rail
        modelBase.telemetry.stage = null;
        modelBase.telemetry.gear = null;
        modelBase.telemetry.speedKmh = 0;
        r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d' }, 1800);
        assert.strictEqual(r.layers.brake_rail.visible, false, 'brake_rail must hide when parked/charging with stage=null');

        // Stopped at traffic light in D (stage='D', speed=0) must keep brake_rail visible
        modelBase.telemetry.stage = 'D';
        modelBase.telemetry.gear = 1;
        modelBase.telemetry.speedKmh = 0;
        r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d' }, 1900);
        assert.strictEqual(r.layers.brake_rail.visible, true, 'brake_rail must remain visible when stopped in D');
    });

    /* 7. Pixel-Level Hardware Clearance Audit (5 Cluster Zones + 800x480 HUD) */
    await test('Pixel-level hardware clearance check against HOOD, GEAR_WIN, BLACK_BOX, telltales, sub-gauges & full album art', () => {
        const scenarios = [
            {
                name: 'EV drive D5 (idle dim brake rail + large OIL/CL + HV gauge SoC + 12V % + Cabin Temp)',
                profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
                telemetry: { speedKmh: 108, rpm: 0, hvKw: 14.2, soc: 72, soc12: 86, cabinTempC: 22.0, battTempC: 24, oilTempC: 48, coolantTempC: 73, stage: 'D', program: 'D', gear: 5, frictionG: 0, pureRegen: false },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            },
            {
                name: 'EV pure regen D4 (100% SoC width check + dim brake rail)',
                profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_regen', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
                telemetry: { speedKmh: 54, rpm: 0, hvKw: -26, soc: 100, soc12: 100, cabinTempC: 20.0, battTempC: 3, oilTempC: 46, coolantTempC: 70, stage: 'D', program: 'D', gear: 4, frictionG: 0, pureRegen: true },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            },
            {
                name: 'EV blended brake D3 + ABS (low SoC amber + active friction brake segments + g)',
                profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
                telemetry: { speedKmh: 36, rpm: 0, hvKw: -22, soc: 15, soc12: 49, cabinTempC: 24.5, battTempC: 42, oilTempC: 54, coolantTempC: 76, stage: 'D', program: 'D', gear: 3, frictionG: 0.42, pureRegen: false, absActive: true },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            },
            {
                name: 'Gas cold D6 + TPMS alert (triple-digit °F OIL/CL + 12V %)',
                profile: { vehicleType: 'phev', engineOn: true, mode: 'gas_cold', isEv: false, isCold: true, coldCeilingRpm: 3800, alert: { id: 'tpms', severity: 'amber', label: 'FL 28psi' } },
                telemetry: { speedKmh: 98, rpm: 2400, soc: 8, soc12: 78, cabinTempC: -8.0, oilTempC: 98, coolantTempC: 96, battTempC: 25, boostBar: 0.4, stage: 'D', program: 'D', gear: 6, frictionG: 0.18, pureRegen: false },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: 7.2, isDfco: false },
            },
        ];

        const keepoutBoxes = [
            ['LANE_CENTERING', visible.LANE_CENTERING],
            ['BRAKE_ABS_DSC', visible.BRAKE_ABS_DSC],
            ['AUTO_HOLD_PARK', visible.AUTO_HOLD_PARK],
            ['STEERING_FAULT', visible.STEERING_FAULT],
            ['MIDDLE_RIGHT_ICONS', visible.MIDDLE_RIGHT_ICONS],
            ['SPEED_NEEDLE_FAN', visible.SPEED_NEEDLE_FAN],
            ['MAIN_SPEED_DIGITS', visible.MAIN_SPEED_DIGITS],
            ['TRAFFIC_LIGHT_SIGN', visible.TRAFFIC_LIGHT_SIGN],
            ['CENTER_MAP', visible.CENTER_MAP],
            ['MEDIA_WIDGET', visible.MEDIA_WIDGET],
            ['BLACK_BOX', visible.BLACK_BOX],
            ['MASTER_WARN_TRIANGLE', visible.MASTER_WARN_TRIANGLE],
            ['POWER_PCT_LABEL', visible.POWER_PCT_LABEL],
            ['BOTTOM_BRACKET_LINE', visible.BOTTOM_BRACKET_LINE],
            ['FUEL_GAUGE_LOWER_LEFT', visible.FUEL_GAUGE_LOWER_LEFT],
            ['FUEL_RANGE_CLOCK', visible.FUEL_RANGE_CLOCK],
            ['BELT', visible.BELT],
            ['REAR_BELTS_AIRBAG', visible.REAR_BELTS_AIRBAG],
            ['DRIVE_MODE_STOCK_D', visible.DRIVE_MODE_STOCK_D],
            ['GEAR_WIN', visible.GEAR_WIN],
            ['AMBIENT_TEMP', visible.AMBIENT_TEMP],
            ['SOC_GAUGE_LOWER_RIGHT', visible.SOC_GAUGE_LOWER_RIGHT],
            ['EV_RANGE', visible.EV_RANGE],
        ];

        for (let si = 0; si < scenarios.length; si++) {
            const r = new OverlayRenderer({ allowPanel: true });
            r.render({
                units: unitsMod.US_PRESET,
                profile: scenarios[si].profile,
                telemetry: scenarios[si].telemetry,
                efficiency: scenarios[si].efficiency,
            }, { enabled: true, gearDisplay: 'next_to_d' }, 3000);

            assert.strictEqual(r.lastSummary.cornerRightMode, 'soc12', 'corner_right must auto-select 12V % now that PHEV HV SoC overlays the HV battery gauge');
            assert.strictEqual(r.layers.hv_soc_gauge.visible, true, 'PHEV must display hv_soc_gauge over the bottom-right HV battery gauge');
            assert.strictEqual(r.layers.cabin_temp.visible, true, 'cabin_temp car-box badge must render left of ambient temp');
            // Verify cabin_temp clears every keepout box (GEAR_WIN, AMBIENT_TEMP, BOTTOM_BRACKET_LINE)
            const ctL = r.layers.cabin_temp;
            let ctPainted = 0;
            for (let py = 0; py < ctL.rect.h; py++) {
                const wy = ctL.rect.y + py;
                for (let px = 0; px < ctL.rect.w; px++) {
                    if (ctL.cv.d[(py * ctL.rect.w + px) * 4 + 3] === 0) continue;
                    ctPainted++;
                    const wx = ctL.rect.x + px;
                    for (let ki = 0; ki < keepoutBoxes.length; ki++) {
                        assert(!inBox(wx, wy, keepoutBoxes[ki][1]),
                            scenarios[si].name + ' cabin_temp hits ' + keepoutBoxes[ki][0] + ' at (' + wx + ',' + wy + ')');
                    }
                }
            }
            assert(ctPainted > 250, 'cabin_temp car-silhouette badge must paint frame + digits');
            assert.strictEqual(r.layers.below_speed.rect.x, 392, 'below_speed must sit shifted left at x=392 under main speed digits');
            assert.strictEqual(r.layers.below_speed.rect.y, 445, 'below_speed must sit shifted down at y=445 for balanced clearance under speed & above traffic light sign');
            assert.strictEqual(r.layers.corner_right.rect.y, 646, 'corner_right must sit shifted 3px down at y=646 away from battery icon');
            assert.strictEqual(CLUSTER_LAYER_NAMES.length, 5);
            CLUSTER_LAYER_NAMES.forEach((name) => {
                const l = r.layers[name];
                assert(l && l.visible, scenarios[si].name + ' missing ' + name);
                const { x: ox, y: oy, w, h } = l.rect;
                const d = l.cv.d;
                let paintedCount = 0;
                let topHalfPixels = 0;
                let bottomHalfPixels = 0;
                let maxTagBlueness = -1;
                for (let py = 0; py < h; py++) {
                    const wy = oy + py;
                    for (let px = 0; px < w; px++) {
                        const off = (py * w + px) * 4;
                        const a = d[off + 3];
                        if (a === 0) continue;
                        paintedCount++;
                        if (py < h / 2) topHalfPixels++; else bottomHalfPixels++;
                        if (name === 'corner_right' && py < 26 && a > 180) {
                            const blueness = d[off + 2] - d[off];
                            if (blueness > maxTagBlueness) maxTagBlueness = blueness;
                        }
                        const wx = ox + px;
                        assert(wy > visible.hoodY(wx) + 4, scenarios[si].name + ' ' + name + ' pixel under HOOD at (' + wx + ',' + wy + ')');
                        for (let ki = 0; ki < keepoutBoxes.length; ki++) {
                            assert(!inBox(wx, wy, keepoutBoxes[ki][1]),
                                scenarios[si].name + ' ' + name + ' hits ' + keepoutBoxes[ki][0] + ' at (' + wx + ',' + wy + ')');
                        }
                    }
                }
                if (name === 'corner_right') {
                    assert(maxTagBlueness <= 22, 'corner_right SOC label must stay neutral gray matching battery icon (not blue), got B-R=' + maxTagBlueness);
                }
                assert(paintedCount > 30, scenarios[si].name + ' ' + name + ' expected painted pixels');
                if (name === 'corner_left' || name === 'corner_right') {
                    assert(topHalfPixels > 25 && bottomHalfPixels > 40,
                        scenarios[si].name + ' ' + name + ' must render large two-line readout');
                }
                if (name === 'brake_rail' && scenarios[si].telemetry.frictionG === 0) {
                    assert.strictEqual(topHalfPixels, 0, scenarios[si].name + ' idle brake_rail must omit text above segments');
                    assert(bottomHalfPixels >= 1000, scenarios[si].name + ' idle brake_rail must keep 20 dim segments visible');
                }
            });

            // Also verify right_widget stays inside KOMBI4's right-wing pocket, clear of HOOD, CENTER_MAP, telltales & gauges
            const rwL = r.layers.right_widget;
            assert(rwL && rwL.visible, scenarios[si].name + ' expected right_widget visible');
            const rwKeepouts = keepoutBoxes.filter((kb) => kb[0] !== 'MEDIA_WIDGET' && kb[0] !== 'BLACK_BOX');
            let rwPainted = 0;
            for (let py = 0; py < rwL.rect.h; py++) {
                const wy = rwL.rect.y + py;
                for (let px = 0; px < rwL.rect.w; px++) {
                    if (rwL.cv.d[(py * rwL.rect.w + px) * 4 + 3] === 0) continue;
                    rwPainted++;
                    const wx = rwL.rect.x + px;
                    assert(wy > visible.hoodY(wx) + 4, 'right_widget pixel under HOOD at (' + wx + ',' + wy + ')');
                    for (let ki = 0; ki < rwKeepouts.length; ki++) {
                        assert(!inBox(wx, wy, rwKeepouts[ki][1]),
                            'right_widget hits ' + rwKeepouts[ki][0] + ' at (' + wx + ',' + wy + ')');
                    }
                }
            }
            assert(rwPainted > 500, 'right_widget must paint rich content');

            const hudL = r.layers.hud_main;
            const win = visible.HUD_WINDOW;
            assert(hudL.rect.x >= win.x && hudL.rect.y >= win.y &&
                hudL.rect.x + hudL.rect.w <= win.x + win.w &&
                hudL.rect.y + hudL.rect.h <= win.y + win.h, 'hud_main outside HUD_WINDOW');
            assert(hudL.rect.x + hudL.rect.w <= visible.HUD_STOCK_NAV[0], 'hud_main hits HUD nav');
            assert(hudL.rect.y + hudL.rect.h <= visible.HUD_ACC_ASSIST[1], 'hud_main hits Assisted Driving / ACC display (y>=202)');
            assert(hudL.rect.y + hudL.rect.h <= visible.HUD_BMW[1], 'hud_main hits HUD_BMW speed/Sport rev band');
        }
    });

    /* 8. Friction Brake Physics, Lift-Throttle Regen Gate, Brake Hold & Corner-Right Mode */
    await test('Friction brake longitudinal force balance, lift-throttle regen gate, stationary hold & corner_right SoC %', () => {
        // BN2020 brake flag variants (German enum strings + resting numeric code)
        assert.strictEqual(flagActive('FAHRER_BREMST_NICHT'), false);
        assert.strictEqual(flagActive('FAHRER_BREMST'), true);
        assert.strictEqual(flagActive(1, 1), false, 'learned resting value 1 must map to false');
        assert.strictEqual(flagActive(2, 1), true, 'active value 2 must map to true');
        assert.strictEqual(flagActive(3, 1), null, '2-bit BN2020 invalid 3 must map to null');

        // Pure lift-off throttle regen (foot OFF brake pedal, even if UDS hvKw is temporarily null!) must NEVER light friction bar
        const liftOffNoUds = computeFrictionBrake({ speedKmh: 58, rpm: 0, gear: 5, hvKw: null, recupPct: 28, gLong: -0.14, pedalPct: 0, driverBraking: false, massKg: 2100 });
        assert.strictEqual(liftOffNoUds.frictionG, 0, 'lift-off throttle regen must never show friction brake');
        assert.strictEqual(liftOffNoUds.pureRegen, true);

        const pure = computeFrictionBrake({ speedKmh: 54, rpm: 0, gear: 4, hvKw: -26.0, gLong: -0.11, pedalPct: 0, driverBraking: true, massKg: 2100 });
        assert.strictEqual(pure.frictionG, 0);
        assert.strictEqual(pure.pureRegen, true);

        const blend = computeFrictionBrake({ speedKmh: 36, rpm: 0, gear: 3, hvKw: -22.0, gLong: -0.34, pedalPct: 0, driverBraking: true, massKg: 2100 });
        assert(blend.frictionG > 0.14 && blend.frictionG < 0.28, 'expected ~0.20g friction, got ' + blend.frictionG);
        assert(blend.frictionKw > 30);

        // Stationary brake hold (stopped at 0 mph in D with foot on brake): brakeHold=true, frictionG=0
        const holdStop = computeFrictionBrake({ speedKmh: 0, rpm: 0, gear: 1, hvKw: 0.8, gLong: 0.0, pedalPct: 0, driverBraking: true, massKg: 2100 });
        assert.strictEqual(holdStop.frictionG, 0);
        assert.strictEqual(holdStop.brakeHold, true);

        const r = new OverlayRenderer({ allowPanel: true });
        const model = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPerKwh: null, fuelLPer100km: null, isDfco: false },
            telemetry: { speedKmh: 45, rpm: 0, hvKw: -20, soc: 65, battTempC: 24, oilTempC: 50, coolantTempC: 75, stage: 'D', program: 'D', gear: 4, frictionG: 0.22 },
        };
        r.render(model, { enabled: true, brakeIndicator: 'bar_num' }, 4000);
        const br = r.layers.brake_rail;
        assert.strictEqual(br.visible, true);
        assert.strictEqual(br.rect.y + 21, 630, 'brake_rail segments must sit lowered at world y=630..637');
        assert(br.rect.x + 294 <= 1576, 'brake_rail right edge must clear CHARGE needle arc');
        const rightOff = (24 * br.rect.w + (br.rect.w - 8)) * 4;
        const leftOff = (24 * br.rect.w + 10) * 4;
        assert(br.cv.d[rightOff] > 200 && br.cv.d[rightOff + 3] === 255, 'rightmost segment must light up first');
        assert(br.cv.d[leftOff] < 80 && br.cv.d[leftOff + 3] === 125, 'leftmost unlit segment must stay dim visible');

        r.render(model, { enabled: true, brakeIndicator: 'bar_only' }, 4100);
        let topPx = 0;
        for (let py = 0; py < 18; py++) {
            for (let px = 0; px < br.rect.w; px++) {
                if (br.cv.d[(py * br.rect.w + px) * 4 + 3] > 0) topPx++;
            }
        }
        assert.strictEqual(topPx, 0, 'bar_only must omit numeric g text');

        // Stationary brakeHold renders 1 lit segment and zero fake g text even in bar_num mode
        model.telemetry.speedKmh = 0;
        model.telemetry.frictionG = 0;
        model.telemetry.brakeHold = true;
        r.render(model, { enabled: true, brakeIndicator: 'bar_num' }, 4200);
        assert.strictEqual(r.lastSummary.brakeLit, 1);
        let holdTopPx = 0;
        for (let py = 0; py < 18; py++) {
            for (let px = 0; px < br.rect.w; px++) {
                if (br.cv.d[(py * br.rect.w + px) * 4 + 3] > 0) holdTopPx++;
            }
        }
        assert.strictEqual(holdTopPx, 0, 'stationary brakeHold must not show fake g text');

        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'phev' }, { soc12: 86, soc: 68 }, true), 'soc12');
        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'phev' }, { v12: 14.1, soc: 68 }, true), 'v12');
        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'phev' }, { soc: 68 }, false), 'soc');
        assert.strictEqual(resolveCornerRightMode('soc12', { vehicleType: 'ice' }, {}), 'soc12');
        assert.strictEqual(resolveCornerRightMode('soc', { vehicleType: 'phev' }, {}), 'soc');
        assert.strictEqual(resolveCornerRightMode('batt', { vehicleType: 'phev' }, {}), 'batt');
        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'ice' }, { iatC: 28 }), 'iat');
        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'ice' }, { soc12: 82, iatC: 28 }), 'soc12');
    });

    /* 9. Real DidReader + SignalHub UDS Byte-Frame + FastKw + Self-Healing SME Wake Test */
    await test('SignalHub + DidReader + FastKw decode UDS bytes, write eDrive wanted IPC & auto-recover from silent SME', async () => {
        // Verify FastKw RLS needle-to-kW interpolation bridges UDS gaps smoothly
        const fkw = new FastKw();
        fkw.needle(20, 0, 1000);
        fkw.reading(15.6, 1250);
        fkw.needle(0, 40, 1500);
        fkw.reading(-21.4, 1750);
        fkw.needle(10, 0, 2000);
        fkw.reading(8.1, 2250);
        fkw.needle(20, 0, 2600);
        const estKw = fkw.now(2700);
        assert(typeof estKw === 'number' && estKw > 12 && estKw < 19, 'FastKw expected ~15.6 kW, got ' + estKw);

        const tmpWanted = path.join(os.tmpdir(), 'edrive-wanted-' + process.pid + '.json');
        const appSpec = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
        let smeSilent = false;
        let wokeCount = 0;
        const fakeDiag = {
            available: true,
            busy: 0,
            stats: { sent: 0, replies: 0, missed: 0, blocked: 0 },
            silent: (ecu) => (ecu === 7 ? smeSilent : false),
            wake: (ecu) => { if (ecu === undefined || ecu === 7) { smeSilent = false; wokeCount++; } },
            cancel: () => {},
            async physical(ecu, sid, payload) {
                if (ecu === 7 && smeSilent) return null;
                fakeDiag.stats.sent++;
                fakeDiag.stats.replies++;
                if (sid === 0x22) {
                    const did = ((payload[0] << 8) | payload[1]).toString(16).toUpperCase().padStart(4, '0');
                    // SME 0x07: DDBC = 73.5% (735 = 0x02DF), DDB4 = 355.00V (35500 = 0x8AAC), DD69 = -40.00A (-4000 = 0xFFFFF060) => +14.20 kW
                    if (ecu === 7 && did === 'DDBC') return [0x62, 0xDD, 0xBC, 0x02, 0xDF];
                    if (ecu === 7 && did === 'DDB4') return [0x62, 0xDD, 0xB4, 0x8A, 0xAC];
                    if (ecu === 7 && did === 'DD69') return [0x62, 0xDD, 0x69, 0xFF, 0xFF, 0xF0, 0x60];
                    if (ecu === 7 && did === 'DDC0') return [0x62, 0xDD, 0xC0, 0x09, 0x60, 0x09, 0xC4, 0x09, 0x92]; // avg = 24.50C
                    if (ecu === 18 && did === 'F442') return [0x62, 0xF4, 0x42, 0x37, 0x14]; // 14.100V
                    if (ecu === 24 && did === '6000') return [0x62, 0x60, 0x00, 122]; // 82C
                    if (ecu === 18 && did === 'F40F') return [0x62, 0xF4, 0x0F, 68]; // 28C
                }
                return null;
            },
        };

        const ctxStub = {
            log: { info: () => {}, warn: () => {}, error: () => {} },
            spec: appSpec,
            settings: { values: { demo: 'off', vehicle: 'auto' }, get: (k) => (k === 'demo' ? 'off' : (k === 'enabled' ? true : 'auto')) },
            signals: null,
        };
        const hub = new SignalHub(ctxStub, {
            diagLink: fakeDiag,
            ipcDir: path.join(os.tmpdir(), 'nonexistent-ipc-' + process.pid),
            edriveWantedPath: tmpWanted,
        });
        hub.start();
        await hub.pollNow();
        const snap = hub.snapshot(Date.now());

        // Simulate transient gateway contention muting SME, then verify pollNow() / wakeUds() un-silences SME
        smeSilent = true;
        await hub.pollNow();
        assert.strictEqual(smeSilent, false, 'pollNow/wakeUds must clear silent SME state');
        assert(wokeCount >= 2);
        const wantedJson = JSON.parse(fs.readFileSync(tmpWanted, 'utf8'));
        assert.strictEqual(wantedJson.power, true);
        assert.strictEqual(wantedJson.soc, true);

        hub.stop();
        try { fs.unlinkSync(tmpWanted); } catch (e) { /* ignore */ }

        assert.strictEqual(snap.demo, false);
        assert.strictEqual(snap.smeAnswered, true);
        assert(Math.abs(snap.soc - 73.5) < 0.05, 'expected UDS SoC 73.5%, got ' + snap.soc);
        assert(Math.abs(snap.hvKw - 14.2) < 0.05, 'expected UDS HV power +14.2 kW, got ' + snap.hvKw);
        assert(Math.abs(snap.battTempC - 24.5) < 0.05, 'expected UDS cellT avg 24.5C, got ' + snap.battTempC);
        assert(Math.abs(snap.v12 - 14.1) < 0.05, 'expected UDS 12V 14.1V, got ' + snap.v12);
        assert.strictEqual(snap.gearboxOilC, 82);
        assert.strictEqual(snap.iatC, 28);
    });

    /* 10. Live Binary Socket Protocol: Default 0x203 Active + Legacy 0x202 Power-Gauge Conflict Guard */
    await test('Live cluster-render socket protocol: default 0x203 works out-of-the-box & legacy 0x202 is blocked', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-ov-test-'));
        const confDir = path.join(tmpDir, 'conf');
        fs.mkdirSync(confDir);
        const wazeFile = path.join(tmpDir, 'waze-status.json');
        const sockPath = path.join(tmpDir, 'cr.sock');

        const recorded = { layers: [], frames: [], ops: [] };
        function attachServerWireHandler(sock) {
            let buf = Buffer.alloc(0);
            sock.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                while (buf.length >= 5) {
                    const len = buf.readUInt32LE(0);
                    if (buf.length < 4 + len) break;
                    const type = buf[4];
                    const body = buf.slice(5, 4 + len);
                    buf = buf.slice(4 + len);
                    if (type === 0x4a) {
                        const m = JSON.parse(body.toString('utf8'));
                        recorded.ops.push(m);
                        if (m.op === 'hello') {
                            const ev = Buffer.from(JSON.stringify({ ev: 'hello', backend: 'test', targets: 'hud panel map', proto: 1 }), 'utf8');
                            const msg = Buffer.alloc(5 + ev.length);
                            msg.writeUInt32LE(ev.length + 1, 0);
                            msg[4] = 0x4a;
                            ev.copy(msg, 5);
                            sock.write(msg);
                        } else if (m.op === 'layer') {
                            recorded.layers.push(m);
                        }
                    } else if (type === 0x46) {
                        recorded.frames.push({ ref: body.readUInt32LE(0), rects: body.readUInt16LE(12), bytes: body.length });
                    }
                }
            });
        }

        const server = net.createServer(attachServerWireHandler);
        await new Promise((resolve) => server.listen(sockPath, resolve));
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));

        const canConnectUnix = await new Promise((resolve) => {
            const c = net.connect(sockPath, () => { c.destroy(); resolve(true); });
            c.on('error', () => resolve(false));
        });

        let CustomCR = ClusterRender;
        if (!canConnectUnix) {
            CustomCR = class InMemoryClusterRender extends ClusterRender {
                _open() {
                    if (this.closed || this.sock) return;
                    const clientEnd = new EventEmitter();
                    const serverEnd = new EventEmitter();
                    clientEnd.write = (buf) => { setImmediate(() => serverEnd.emit('data', Buffer.from(buf))); return true; };
                    serverEnd.write = (buf) => { setImmediate(() => clientEnd.emit('data', Buffer.from(buf))); return true; };
                    clientEnd.destroy = () => {
                        setImmediate(() => {
                            clientEnd.emit('close');
                            serverEnd.emit('close');
                        });
                    };
                    serverEnd.destroy = clientEnd.destroy;
                    attachServerWireHandler(serverEnd);
                    this.sock = clientEnd;
                    this.blocked = false;
                    this.connected = false;
                    this.inbuf = Buffer.alloc(0);
                    clientEnd.on('connect', () => {
                        this.connected = true;
                        this._send({ op: 'hello', app: this.app, proto: 1 });
                    });
                    clientEnd.on('data', (d) => { if (this.sock === clientEnd) this._data(d); });
                    clientEnd.on('close', () => { if (this.sock === clientEnd) { this.sock = null; this.ready = false; this.connected = false; } });
                    setImmediate(() => clientEnd.emit('connect'));
                }
            };
        }

        fs.writeFileSync(wazeFile, JSON.stringify({ state: 'idle', target: 'map' }));
        const prevBench = process.env.CLUSTER_METRICS_BENCH;
        delete process.env.CLUSTER_METRICS_BENCH;

        const modelA = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: { speedKmh: 70, rpm: 0, hvKw: 14.2, soc: 68, battTempC: 23, stage: 'D', program: 'D', gear: 5, navRouteActive: false, navHasLanes: false },
        };

        // Phase A1: Default 'panel_only' activates all 5 outer zones + right_widget (6 panel layers) + 3-line HUD!
        assert.strictEqual(inspectClusterSlotConfig(confDir).safe, true);
        assert.strictEqual(inspectClusterSlotConfig(confDir).conflictSlot, false);
        const rDefault = new OverlayRenderer({ ClusterRender: CustomCR, socketPath: sockPath, confDir, wazeStatusPath: wazeFile, allowPanel: false });
        rDefault.connect();
        await wait(60);
        rDefault.render(modelA, { enabled: true, gearDisplay: 'next_to_d' }, 5000);
        await wait(60);

        assert.strictEqual(recorded.layers.filter((l) => l.target === 'panel').length, 7, 'default PHEV panel_only must activate 5 outer zones + hv_soc_gauge + right_widget');
        assert(rDefault.layerCount() <= 16);
        assert(rDefault.pixelBytesTotal() < 3.5 * 1024 * 1024);

        const firstFrames = recorded.frames.length;
        rDefault.render(modelA, { enabled: true, gearDisplay: 'next_to_d' }, 5250);
        await wait(40);
        assert.strictEqual(recorded.frames.length, firstFrames, 'identical render must send zero frames');

        modelA.telemetry.gear = 6;
        rDefault.render(modelA, { enabled: true, gearDisplay: 'next_to_d' }, 5500);
        await wait(40);
        assert.strictEqual(recorded.frames.length, firstFrames + 2);

        // Legacy 'auto' setting gracefully normalizes to consistent 'panel_only' even when waze-on-cluster holds 0x100!
        fs.writeFileSync(wazeFile, JSON.stringify({ state: 'showing', target: 'map' }));
        rDefault.render(modelA, { enabled: true, clusterSlotMode: 'auto', gearDisplay: 'next_to_d' }, 5800);
        await wait(30);
        assert.strictEqual(rDefault.lastSummary.clusterSlotMode, 'panel_only');
        assert.strictEqual(rDefault.lastSummary.panelAllowed, true, 'panel_only must stay consistently on 0x203');

        // Phase A2: Explicit 'map_only' mode unmaps 0x203 and activates borderless side-bottom map layers with zero shifting!
        modelA.telemetry.oilTempC = 78;
        modelA.telemetry.coolantTempC = 86;
        modelA.telemetry.stage = 'P';
        modelA.telemetry.gear = null;
        rDefault.render(modelA, { enabled: true, clusterSlotMode: 'map_only', gearDisplay: 'next_to_d' }, 6100);
        await wait(40);
        assert.strictEqual(rDefault.lastSummary.panelAllowed, false, 'map_only must unmap 0x203');
        assert.strictEqual(rDefault.lastSummary.showMapOverlay, true, 'map_only must activate map_speed + map_left + map_right on 0x100');
        assert.strictEqual(rDefault.layers.below_speed.visible, false);
        assert.strictEqual(rDefault.layers.right_widget.visible, false);
        assert.strictEqual(rDefault.layers.map_speed.visible, true);
        assert.strictEqual(rDefault.layers.map_left.visible, true);
        assert.strictEqual(rDefault.layers.map_right.visible, true);
        assert(rDefault.layers.map_right.rect.x - (rDefault.layers.map_left.rect.x + rDefault.layers.map_left.rect.w) >= 310,
            'center route corridor must remain >= 310px unobstructed');
        assert.strictEqual(rDefault.layers.map_left.cv.d[(2 * rDefault.layers.map_left.rect.w + 2) * 4 + 3], 0,
            'map_left must be borderless (no shaded box)');
        assert.strictEqual(rDefault.layers.map_right.cv.d[(2 * rDefault.layers.map_right.rect.w + 2) * 4 + 3], 0,
            'map_right must be borderless (no shaded box)');

        const parkedLeftBuf = Buffer.from(rDefault.layers.map_left.cv.d);
        const mrW = rDefault.layers.map_right.rect.w;
        const mrH = rDefault.layers.map_right.rect.h;
        const extractSocRegion = (buf) => {
            const sub = [];
            for (let py = 28; py < mrH; py++) {
                const off = (py * mrW + 96) * 4;
                sub.push(Buffer.from(buf.slice(off, (py * mrW + mrW) * 4)));
            }
            return Buffer.concat(sub);
        };
        const parkedSocRegion = extractSocRegion(rDefault.layers.map_right.cv.d);

        modelA.telemetry.stage = 'D';
        modelA.telemetry.gear = 5;
        rDefault.render(modelA, { enabled: true, clusterSlotMode: 'map_only', gearDisplay: 'next_to_d' }, 6200);
        await wait(30);
        assert.strictEqual(Buffer.compare(parkedLeftBuf, Buffer.from(rDefault.layers.map_left.cv.d)), 0,
            'map_left OIL/CL must NOT shift by a single pixel between Park and D5');
        assert.strictEqual(Buffer.compare(parkedSocRegion, extractSocRegion(rDefault.layers.map_right.cv.d)), 0,
            'map_right SOC % must NOT shift by a single pixel when D5 and brake segments appear');

        // Phase A3: HUD navigation auto-yield -> active route unmaps hud_main (0x323) so KOMBI4 restores BMW HUD directions (0x300)
        modelA.telemetry.navRouteActive = true;
        rDefault.render(modelA, { enabled: true, hudNavMode: 'yield_route', gearDisplay: 'next_to_d' }, 6300);
        await wait(30);
        assert.strictEqual(rDefault.lastSummary.hudYieldedToNav, true);
        assert.strictEqual(rDefault.layers.hud_main.visible, false, 'HUD must yield 0x323 during active navigation route');
        rDefault.render(modelA, { enabled: true, hudNavMode: 'keep', hudLine1: 'efficiency', hudLine2: 'soc', hudLine3: 'temps' }, 6400);
        await wait(30);
        assert.strictEqual(rDefault.layers.hud_main.visible, true, 'hudNavMode=keep must keep HUD visible');
        modelA.telemetry.navRouteActive = false;
        rDefault.close();

        // Phase B: Legacy local.conf with panel_slot = 0x202 -> blocked to protect BMW Power Gauge & Media!
        recorded.layers.length = 0;
        recorded.frames.length = 0;
        fs.writeFileSync(path.join(confDir, 'cluster-render.local.conf'), 'panel_slot = 0x202\n');
        const stConflict = inspectClusterSlotConfig(confDir);
        assert.strictEqual(stConflict.safe, false);
        assert.strictEqual(stConflict.conflictSlot, true);

        const rConflict = new OverlayRenderer({ ClusterRender: CustomCR, socketPath: sockPath, confDir, wazeStatusPath: wazeFile, allowPanel: false });
        rConflict.connect();
        await wait(60);
        rConflict.render(modelA, { enabled: true, clusterSlotMode: 'panel_only', gearDisplay: 'next_to_d' }, 7000);
        await wait(60);
        assert.strictEqual(recorded.layers.some((l) => l.target === 'panel'), false, 'must NOT map panel onto slot 0x202');
        assert.strictEqual(recorded.layers.some((l) => l.target === 'hud'), true);
        const mapLayer = recorded.layers.find((l) => l.target === 'map');
        assert(mapLayer && mapLayer.contend === 0);
        rConflict.close();

        if (prevBench !== undefined) process.env.CLUSTER_METRICS_BENCH = prevBench;
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /* 11. End-to-End Built App Runtime in hu-stub.js (3-Tab Native Settings + Widget Checkboxes + DIAG) */
    await test('End-to-end built app runtime in hu-stub.js (3-tab General/Cluster/HUD + DIAG screen)', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-metrics-hu-'));
        const dataDir = path.join(tmpDir, 'data');
        const ipcDir = path.join(tmpDir, 'ipc');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(ipcDir, { recursive: true });

        // Verify built uiDescription.json uses BMW's native full-width LT_State_Wide across all 5 screens
        const uiXml = fs.readFileSync(path.join(ROOT, 'dist', 'cluster_metrics', 'rhmiData', 'uiDescription', 'application.xml'), 'utf8');
        const wideMatches = uiXml.match(/widget="LT_State_Wide"/g) || [];
        assert(wideMatches.length >= 5, 'MAIN, GENERAL, CLUSTER, HUD, and DIAG must all use native LT_State_Wide');
        assert(uiXml.indexOf('widget="LT_CheckBox_1Row"') >= 0, 'CLUSTER/GENERAL must include native BMW checkbox switches');
        const uiDesc = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'cluster_metrics', 'rhmiData', 'uiDescription', 'uiDescription.json'), 'utf8'));
        assert(uiDesc.containers && Object.values(uiDesc.containers).some((c) => c.name === 'GENERAL'));
        assert(uiDesc.containers && Object.values(uiDesc.containers).some((c) => c.name === 'CLUSTER'));
        assert(uiDesc.containers && Object.values(uiDesc.containers).some((c) => c.name === 'HUD'));
        const clusterCont = Object.values(uiDesc.containers).find((c) => c.name === 'CLUSTER');
        const chgComp = Object.values(clusterCont.components).find((c) => c.name === 'WIDGET_CHARGING');
        assert(chgComp && chgComp.type === 'checkBox', 'CLUSTER must include WIDGET_CHARGING checkbox');

        const enStrings = fs.readFileSync(path.join(ROOT, 'dist', 'cluster_metrics', 'rhmiData', 'strings', 'en_GB.json'), 'utf8');
        assert(enStrings.indexOf('github.com/chyiz/mgu-apps') >= 0, 'Settings footer must link to github.com/chyiz/mgu-apps');
        assert.strictEqual(enStrings.toLowerCase().indexOf('cauliflowermossgrape'), -1, 'No cauliflowermossgrape link in UI strings');

        const prevIpc = process.env.CLUSTER_INFO_DIR;
        const prevSock = process.env.CLUSTER_METRICS_SOCKET;
        const prevBench = process.env.CLUSTER_METRICS_BENCH;
        process.env.CLUSTER_INFO_DIR = ipcDir;
        process.env.CLUSTER_METRICS_SOCKET = path.join(tmpDir, 'unused.sock');
        process.env.CLUSTER_METRICS_BENCH = '1';

        const errors = [];
        const cellsUpdated = {};
        const log = { info: () => {}, warn: () => {}, error: (...a) => errors.push(a.join(' ')), debug: () => {} };
        const hu = headUnit(path.join(ROOT, 'dist', 'cluster_metrics'), { live: true, dataDir, log });
        const origCells = hu.ui.cells;
        hu.ui.cells = (name, row, obj) => {
            cellsUpdated[name] = obj;
            return origCells(name, row, obj);
        };

        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
            hu.start();
            await wait(120);
            assert.strictEqual(errors.length, 0, 'startup must produce zero errors: ' + errors.join('; '));
            assert(cellsUpdated.STATUS_SUMMARY, 'STATUS_SUMMARY native row must populate on MAIN');
            assert(cellsUpdated.TAB_GENERAL && cellsUpdated.TAB_CLUSTER && cellsUpdated.TAB_HUD, 'MAIN 3 setting category tabs must populate');

            // Navigate across General, Cluster, and HUD screens and exercise switches/checkboxes/dropdowns
            hu.ui.comp('TAB_GENERAL').emit('action', {});
            await wait(20);
            assert(hu.stack.includes('GENERAL'), 'TAB_GENERAL must open GENERAL page');
            assert.strictEqual(hu.settings.get('enabled'), false);
            hu.ui.comp('SET_ENABLED').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('enabled'), true);
            hu.ui.comp('SET_ENABLED').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('enabled'), false);

            hu.ui.comp('TAB_CLUSTER').emit('action', {});
            await wait(20);
            assert(hu.stack.includes('CLUSTER'), 'TAB_CLUSTER must open CLUSTER page');
            hu.ui.comp('SET_CORNERRIGHTDISPLAY').emit('action', { row: 2 }); // 'batt'
            await wait(15);
            assert.strictEqual(hu.settings.get('cornerRightDisplay'), 'batt');
            hu.ui.comp('SET_CORNERRIGHTDISPLAY').emit('action', { row: 0 }); // 'auto' -> soc
            await wait(15);
            assert.strictEqual(hu.settings.get('cornerRightDisplay'), 'auto');
            hu.ui.comp('SET_CLUSTERSLOTMODE').emit('action', { row: 1 }); // 'map_only'
            await wait(15);
            assert.strictEqual(hu.settings.get('clusterSlotMode'), 'map_only');
            hu.ui.comp('SET_CLUSTERSLOTMODE').emit('action', { row: 0 }); // 'panel_only'
            await wait(15);
            assert.strictEqual(hu.settings.get('clusterSlotMode'), 'panel_only');
            hu.ui.comp('SET_WIDGETTRIP').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('widgetTrip'), false);
            hu.ui.comp('SET_WIDGETTRIP').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('widgetTrip'), true);
            hu.ui.comp('SET_WIDGETMEDIA').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('widgetMedia'), false);
            hu.ui.comp('SET_WIDGETMEDIA').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('widgetMedia'), true);

            hu.ui.comp('TAB_HUD').emit('action', {});
            await wait(20);
            assert(hu.stack.includes('HUD'), 'TAB_HUD must open HUD page');
            hu.ui.comp('SET_HUDNAVMODE').emit('action', { row: 1 }); // 'own_nav_keep'
            await wait(15);
            assert.strictEqual(hu.settings.get('hudNavMode'), 'own_nav_keep');
            hu.ui.comp('SET_HUDNAVMODE').emit('action', { row: 2 }); // 'yield_lanes'
            await wait(15);
            assert.strictEqual(hu.settings.get('hudNavMode'), 'yield_lanes');
            hu.ui.comp('SET_HUDNAVMODE').emit('action', { row: 0 }); // 'own_nav_minimap'
            await wait(15);
            assert.strictEqual(hu.settings.get('hudNavMode'), 'own_nav_minimap');
            hu.ui.comp('SET_HUDLINE3').emit('action', { row: 1 }); // 'soc'
            await wait(15);
            assert.strictEqual(hu.settings.get('hudLine3'), 'soc');

            // Open native DIAG screen via BTN_DIAG and verify all diagnostic rows populate including DIAG_HEADWAY & DIAG_CHARGING
            hu.ui.comp('BTN_DIAG').emit('action', {});
            await wait(80);
            assert(hu.stack.includes('DIAG'), 'BTN_DIAG must open native DIAG screen');
            ['DIAG_RENDER', 'DIAG_NAV', 'DIAG_HEADWAY', 'DIAG_MEDIA', 'DIAG_CHARGING', 'DIAG_BRAKE_ECU', 'DIAG_POWERTRAIN', 'DIAG_BATTERY', 'DIAG_TEMPS', 'DIAG_CHASSIS', 'DIAG_UDS'].forEach((k) => {
                assert(cellsUpdated[k] && cellsUpdated[k].Text2ndRow, 'DIAG must populate ' + k);
            });

            // Trigger on-demand UDS read button & 30s brake+nav probe button
            const prevProbeLog = process.env.CLUSTER_METRICS_PROBE_LOG;
            process.env.CLUSTER_METRICS_PROBE_LOG = path.join(tmpDir, 'ui-probe.log');
            hu.ui.comp('BTN_READ_NOW').emit('action', {});
            await wait(60);
            hu.ui.comp('BTN_PROBE_BRAKE').emit('action', {});
            await wait(80);
            if (prevProbeLog !== undefined) process.env.CLUSTER_METRICS_PROBE_LOG = prevProbeLog;
            else delete process.env.CLUSTER_METRICS_PROBE_LOG;

            // Feed live SOME/IP + IPC data
            fs.writeFileSync(path.join(ipcDir, 'edrive.json'), JSON.stringify({
                t: Date.now(), app: 'edrive_test', power: { kw: 15.5, old: false }, values: { soc: { pct: 74 } },
            }));
            hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: Math.round(72 / 0.015625) });
            hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: 0 });
            hu.feed('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', { statusActualGearDrive: 'G5', statusActualStageDrive: 'D' });
            hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', { temperatureEngineDrive: 74 + 48, temperatureEngineOilDrive: 52 + 48 });
            // IPC sampling runs every 500 ms; the UI has its own 250 ms tick.
            // Wait for the observed value across both clocks, with a hard deadline.
            const batteryDeadline = Date.now() + 3000;
            while (cellsUpdated.DIAG_BATTERY.Text2ndRow.indexOf('74.0%') < 0 &&
                    Date.now() < batteryDeadline) {
                await wait(25);
            }
            assert(cellsUpdated.DIAG_BATTERY.Text2ndRow.indexOf('74.0%') >= 0, 'DIAG_BATTERY must show live 74.0% SoC');
            assert.strictEqual(errors.length, 0, 'runtime interactions must produce zero errors: ' + errors.join('; '));
        } finally {
            if (hu.ctx && typeof hu.ctx.stop === 'function') hu.ctx.stop();
            if (prevIpc !== undefined) process.env.CLUSTER_INFO_DIR = prevIpc; else delete process.env.CLUSTER_INFO_DIR;
            if (prevSock !== undefined) process.env.CLUSTER_METRICS_SOCKET = prevSock; else delete process.env.CLUSTER_METRICS_SOCKET;
            if (prevBench !== undefined) process.env.CLUSTER_METRICS_BENCH = prevBench; else delete process.env.CLUSTER_METRICS_BENCH;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    /* 12. SOME/IP Signal Flag Compatibility Audit */
    await test('SOME/IP signal flags match MGU /etc/oap/someip/someip-interfaces.json (no getter requested on event-only fields)', () => {
        const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'cluster_metrics', 'app.json'), 'utf8'));
        const sigs = appJson.signals || {};
        const EVENT_ONLY = {
            'de.bmw.chassis.VehicleStabilizationManagement': ['StabilizationManagement'],
            'de.bmw.powertrain.AcceleratorPedal': ['AngleAcceleratorPedal'],
            'de.bmw.infotainment.vehicle.Vehicle2': ['highVoltageStorageInfoToExternal'],
            'de.bmw.infrastructure.VehicleInformation': ['statusGearboxDrive', 'DataPowerTrain2'],
            'de.bmw.infotainment.misc.MDrive': ['dataDisplayGearbox'],
            'de.bmw.infrastructure.analytics.BasicDataSet': ['basicDataSet'],
            'de.bmw.infrastructure.EnvironmentalInformation': ['ExteriorTemperature'],
            'de.bmw.infotainment.lsc.LSCDataSink': ['statusHighVoltageStorage'],
            'de.bmw.infrastructure.VehicleCondition': ['VehicleCondition'],
            'de.bmw.body.Light': ['IndicatorSteeringColumn', 'IndicatorSteeringColumnComplete', 'StatusFunctionsIndicators'],
            'de.bmw.dass.GapVehicleAhead': ['GapVehicleDrivingAhead', 'DataFrontVehicle', 'DataFrontVehicleExtended'],
        };
        Object.keys(EVENT_ONLY).forEach((iface) => {
            const group = sigs[iface] || {};
            EVENT_ONLY[iface].forEach((field) => {
                if (field in group) {
                    assert.strictEqual(group[field], 's', iface + '.' + field + ' has no getter on MGU and must be "s"');
                }
            });
        });

        // When the local G30 master SOME/IP catalog dump is present (gitignored), audit every single
        // interface, instance, attribute (r/w/s), method, and broadcast in app.json against it!
        const g30CatPath = path.join(ROOT, 'design', 'resources', 'g30-someip-interfaces.json');
        if (fs.existsSync(g30CatPath)) {
            const rawLines = fs.readFileSync(g30CatPath, 'utf8').split(/\r?\n/);
            const jsonLine = rawLines.find((l) => l.trim().indexOf('{') === 0);
            const cat = JSON.parse(jsonLine);
            const ifaces = cat.interfaces || {};
            const instMap = cat.instanceIDs || {};
            Object.keys(sigs).forEach((iname) => {
                const inf = ifaces[iname];
                assert(inf, 'G30 catalog missing interface ' + iname);
                const spec = sigs[iname];
                const wantInst = spec._instances || '1';
                const availInsts = instMap[iname] || {};
                assert(wantInst in availInsts, iname + ' instance "' + wantInst + '" missing in G30 catalog: ' + JSON.stringify(availInsts));
                const catFields = inf.fields || {};
                const catMethods = inf.methods || {};
                const catEvents = inf.events || {};
                Object.keys(spec).forEach((k) => {
                    if (k === '_optional' || k === '_instances') return;
                    if (k === '_methods') {
                        spec._methods.forEach((m) => {
                            const md = catMethods[m];
                            assert(md && (md.id || md.methodId), iname + ' missing or zero-ID method ' + m);
                        });
                        return;
                    }
                    if (k === '_broadcasts') {
                        spec._broadcasts.forEach((b) => {
                            const ev = catEvents[b];
                            assert(ev && (ev.id || ev.eventId), iname + ' missing or zero-ID broadcast ' + b);
                        });
                        return;
                    }
                    const cf = catFields[k];
                    assert(cf, iname + ' missing field ' + k);
                    const flags = String(spec[k]);
                    // CRITICAL: MainApp's generateSomeipInterfaces treats { id: 0 } as NO getter/notifier/setter!
                    if (flags.indexOf('r') >= 0) {
                        assert(cf.getter && cf.getter.id, iname + '.' + k + ' requested "r" but getter.id is 0/missing on G30: ' + JSON.stringify(cf));
                    }
                    if (flags.indexOf('s') >= 0) {
                        assert(cf.notifier && cf.notifier.id, iname + '.' + k + ' requested "s" but notifier.id is 0/missing on G30: ' + JSON.stringify(cf));
                    }
                    if (flags.indexOf('w') >= 0) {
                        assert(cf.setter && cf.setter.id, iname + '.' + k + ' requested "w" but setter.id is 0/missing on G30: ' + JSON.stringify(cf));
                    }
                });
            });

            // Also audit the built source/manifest.json (with ${userId} -> 12252) exactly as MainApp's generateSomeipInterfaces does
            const builtManPath = path.join(ROOT, 'dist', 'cluster_metrics', 'source', 'manifest.json');
            if (fs.existsSync(builtManPath)) {
                const rawMan = fs.readFileSync(builtManPath, 'utf8').split('${userId}').join('12252');
                const builtMan = JSON.parse(rawMan);
                ['proxies', 'services'].forEach((sec) => {
                    const map = builtMan[sec] || {};
                    Object.keys(map).forEach((iname) => {
                        const inf = ifaces[iname];
                        assert(inf, 'built manifest ' + sec + ' missing interface in G30 catalog: ' + iname);
                        const spec = map[iname];
                        if (spec === '*') return;
                        const insts = Array.isArray(spec.instances) ? spec.instances : (spec.instances ? [spec.instances] : []);
                        insts.forEach((inst) => {
                            if (inst === '*') return;
                            assert(instMap[iname] && (inst in instMap[iname]), 'built manifest bad instance ' + iname + '[' + inst + ']');
                        });
                        Object.keys(spec.attributes || {}).forEach((attr) => {
                            const f = inf.fields && inf.fields[attr];
                            assert(f, 'built manifest missing field ' + iname + '.' + attr);
                            const fl = String(spec.attributes[attr]);
                            if (fl.indexOf('r') >= 0) assert(f.getter && f.getter.id, 'built manifest zero/missing getter.id on ' + iname + '.' + attr);
                            if (fl.indexOf('s') >= 0) assert(f.notifier && f.notifier.id, 'built manifest zero/missing notifier.id on ' + iname + '.' + attr);
                            if (fl.indexOf('w') >= 0) assert(f.setter && f.setter.id, 'built manifest zero/missing setter.id on ' + iname + '.' + attr);
                        });
                    });
                });
            }
        }
    });

    /* 13. HUD Navigation Re-Renderer + Non-Distance Intersection Mini-Map Auto-Yield */
    await test('HUD navigation re-renderer draws maneuvers/lanes in HUD_WINDOW and yields ONLY on mini-map (never distance)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-nav-test-'));
        const crFile = path.join(tmpDir, 'status.txt');
        const wazeFile = path.join(tmpDir, 'waze.json');
        fs.writeFileSync(crFile, 'slot 0x300 status 2: 0x1000210 class 0 map 1\n'); // standard arrow scene, NOT mini-map
        fs.writeFileSync(wazeFile, JSON.stringify({ state: 'idle', target: 'map' }));

        assert.strictEqual(parseHudStatusText('slot 0x300 status 2: 0x1000210 class 0 map 1\n').miniMapScene, false);
        // Critical real-car fix #1: cached unmapped `0x1000200 ... map 0` beside active arrow `0x1000210 ... map 1` must NEVER trigger yield!
        assert.strictEqual(parseHudStatusText('slot 0x300 status 2: 0x1000210 class 1024 map 1, 0x1000200 class 1024 map 0\n').miniMapScene, false,
            'unmapped map 0 0x1000200 row alongside active arrow must NOT false-trigger dcsm_0x1000200');
        assert.strictEqual(parseHudStatusText('slot 0x300 status 0: 0x1000211 class 1024 map 0, 0x1000200 class 1024 map 0\n').miniMapScene, false);
        assert.strictEqual(parseHudStatusText('slot 0x300 status 2: 0x1000200 class 0 map 1\n').miniMapScene, true);
        // While 0x323 is shown on KOMBI4, parked mini-map scene with `map 3` (parked/invisible) DOES trigger yield!
        assert.strictEqual(parseHudStatusText('slot 0x300 status 1: 0x01000200 class 0 map 3\nslot 0x323 status 2: 0x010004f9 class 1 map 1\n').miniMapScene, true,
            'parked map 3 mini-map scene behind 0x323 must yield immediately');
        assert.strictEqual(parseHudStatusText('slot 0x330 status 2: 0x01000201 class 0 map 3\n').miniMapScene, true);

        // Verify startup order where conclusiveDart arrives before guidingProvider settles into 'BMW' preserves dart (no "waiting for turn")
        // AND passiveManeuver/nextIntersection decode cleanly, plus 5s noTurnFallback triggers if a BMW route truly lacks maneuver data!
        const ntBmw = new NavTracker({ crStatusPath: crFile, wazeStatusPath: wazeFile });
        ntBmw.feedField('guidance', 'guidanceState', 'ACTIVE', 1000);
        ntBmw.feedField('guidance', 'conclusiveDart', { maneuver: { intersection: { direction: 'SLIGHT_RIGHT', formattedDistance: { distance: '500', unit: 'FEET' } } } }, 1050);
        ntBmw.feedField('guidance', 'guidingProvider', 'CAR_PLAY', 1100);
        ntBmw.feedField('guidance', 'guidingProvider', 'NONE', 1150);
        const snapPreserved = ntBmw.snapshot(20000, 1200);
        assert(snapPreserved.show && snapPreserved.show.dir === 'SLIGHT_RIGHT', 'conclusiveDart must survive guidingProvider settling to BMW');

        const ntFallback = new NavTracker({ crStatusPath: crFile, wazeStatusPath: wazeFile });
        ntFallback.feedField('guidance', 'guidanceState', 'ACTIVE', 1000);
        ntFallback.feedField('guidance', 'guidingProvider', 'NONE', 1050);
        ntFallback.feedEvents({
            GuidanceEventListError: 'NO_ERROR',
            viewContent: [{ eventsInView: [{ passiveManeuver: { passiveManeuverType: 'JUNCTION', formattedDistance: { distance: '1.4', unit: 'MILE_US' }, description: { elements: [{ text: 'I-280 South' }] } } }] }],
        }, 1200, 1180);
        const snapPassive = ntFallback.snapshot(20000, 1250);
        assert(snapPassive.show && snapPassive.show.dir === 'STRAIGHT_ON' && snapPassive.show.road === 'South' &&
            Array.isArray(snapPassive.show.shields) && snapPassive.show.shields[0] &&
            snapPassive.show.shields[0].kind === 'interstate' && snapPassive.show.shields[0].num === '280',
            'passiveManeuver on highway must extract Interstate shield and draw straight guidance instead of waiting');

        // Empty route on BMW for >=5s triggers bmw_nav_fallback so stock HUD arrow takes over cleanly
        ntFallback.feedEvents({ GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [] }] }, 1500, 1480);
        assert.strictEqual(ntFallback.snapshot(25000, 7000).noTurnFallback, true, 'empty BMW turn list after 5s must trigger bmw_nav_fallback');
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'showing', target: 'hud' })), true);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'showing', target: 'map', hud: 1, hud_state: 'showing' })), true);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'idle', target: 'map', hud: 1, hud_state: 'idle' })), false);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'showing', target: 'map' })), false);
        assert.strictEqual(HUD_NAV_W, 264);
        assert.strictEqual(HUD_NAV_H, 232);
        assert.strictEqual(HUD_ROAD_W, 544);
        assert.strictEqual(HUD_ROAD_H, 38);

        // Verify 544x38 full-width top road banner + Highway Green [14B] exit square + 264x232 maneuver/lane card
        const roadCv = new Canvas(HUD_ROAD_W, HUD_ROAD_H);
        assert.strictEqual(drawHudRoadBanner(roadCv, { exitBadge: '14B', road: 'San Tomas Expressway Northbound toward US-101' }), true);
        let greenExitPixels = 0, rightHalfRoadPixels = 0;
        for (let py = 0; py < HUD_ROAD_H; py++) {
            for (let px = 0; px < HUD_ROAD_W; px++) {
                const o = (py * HUD_ROAD_W + px) * 4;
                if (roadCv.d[o + 3] === 0) continue;
                if (px < 80 && roadCv.d[o + 1] > 110 && roadCv.d[o + 1] > roadCv.d[o] + 50 && roadCv.d[o + 1] > roadCv.d[o + 2] + 35) {
                    greenExitPixels++;
                }
                if (px > 300) rightHalfRoadPixels++;
            }
        }
        assert(greenExitPixels > 250, 'highway exit badge must paint authentic green square (#15803d), got ' + greenExitPixels);
        assert(rightHalfRoadPixels > 200, 'long road name must span across full 544px top row');

        const navCv = new Canvas(HUD_NAV_W, HUD_NAV_H);
        const samples = [
            { kind: 'turn', dir: 'LEFT', dist: '350', unit: 'ft', road: 'El Camino Real', lanes: { lanes: [{ follow: 'LEFT', follows: ['LEFT'], others: [], hi: true, info: 'NONE' }, { follow: 'NONE', follows: [], others: ['STRAIGHT_ON'], hi: false, info: 'NONE' }], rec: 0, markers: ['SOLID', 'DASHED', 'SOLID'] } },
            { kind: 'branch', dir: 'HIGHWAY_OUT_RIGHT', exitBadge: '14B', geom: 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT', dist: '0.4', unit: 'mi', road: 'CA-85 North', then: { kind: 'turn', dir: 'RIGHT', gap: 90 } },
            { kind: 'roundabout', exit: 3, exitAngle: 270, side: 'right', dist: '120', unit: 'm', road: 'Civic Ring' },
            { kind: 'destination', dir: 'RIGHT', flag: true, dist: '50', unit: 'ft', road: 'Destination' },
        ];
        samples.forEach((m) => {
            assert.strictEqual(drawHudNav(navCv, m, { hideRoad: true }), true);
            assert(hudNavKey(m).length > 5 && hudRoadKey(m).length >= 3);
            let midBand = 0, botBand = 0;
            for (let py = 0; py < HUD_NAV_H; py++) {
                for (let px = 0; px < HUD_NAV_W; px++) {
                    if (navCv.d[(py * HUD_NAV_W + px) * 4 + 3] > 0) {
                        if (py < 145) midBand++;
                        else botBand++;
                    }
                }
            }
            assert(midBand > 400 && botBand > 200,
                'HUD nav card must paint hero glyph and bottom distance/lanes for ' + m.kind);
        });

        // Trace NavTracker lifecycle (including DescriptionIcon highway exit extraction):
        const nt = new NavTracker({ crStatusPath: crFile, wazeStatusPath: wazeFile });
        let mNow = 10000, wNow = 50000;
        nt.feedField('guidance', 'guidanceState', 'ACTIVE', mNow);
        nt.feedField('guidance', 'guidingProvider', 'NONE', mNow);
        nt.feedEvents({
            GuidanceEventListError: 'NO_ERROR',
            viewContent: [{
                eventsInView: [{
                    branch: {
                        uid: '10',
                        distanceToDestination: 1200,
                        branchType: 'HIGHWAY_OUT_RIGHT',
                        formattedDistance: { distance: '40', unit: 'FEET' }, // Very close distance alone must NOT trigger hide!
                        description: { elements: [{ icon: { text: '14B', iconHandle: 1 } }, { text: 'De Anza Blvd / Sunnyvale Saratoga Rd' }] },
                    },
                }],
            }],
        }, mNow, mNow - 20);

        const r = new OverlayRenderer({ allowPanel: true, wazeStatusPath: wazeFile });
        const baseModel = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: { speedKmh: 45, rpm: 0, hvKw: 10.2, soc: 70, stage: 'D', program: 'D', gear: 4, hudNav: nt.snapshot(wNow, mNow) },
        };
        assert.strictEqual(baseModel.telemetry.hudNav.show.exitBadge, '14B', 'DescriptionElement.icon.text must extract highway exit number 14B');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.lastSummary.hudYieldedToNav, false, '40 ft turn without mini-map must NOT hide HUD');
        assert.strictEqual(r.lastSummary.showHudRoad, true, 'active road + exitBadge must enable full-width top hud_road banner');
        assert.strictEqual(r.layers.hud_road.visible, true);
        assert.strictEqual(r.layers.hud_main.visible, true);
        assert.strictEqual(r.layers.hud_nav.visible, true);
        assert.strictEqual(r.layers.hud_road.rect.w, 544);
        // Verify hud_main shifts compact metrics strictly into Row 2 (py >= 38) below hud_road AND strictly <= 202 ACC!
        let hudMainRow1Pixels = 0, hudMainRow2Pixels = 0;
        for (let py = 0; py < r.layers.hud_main.rect.h; py++) {
            for (let px = 0; px < r.layers.hud_main.rect.w; px++) {
                if (r.layers.hud_main.cv.d[(py * r.layers.hud_main.rect.w + px) * 4 + 3] > 0) {
                    if (py < 38) hudMainRow1Pixels++;
                    else hudMainRow2Pixels++;
                }
            }
        }
        assert.strictEqual(hudMainRow1Pixels, 0, 'hud_main top 38px must stay clear for full-width hud_road banner');
        assert(hudMainRow2Pixels > 250, 'hud_main Row 2 must render compact telemetry metrics');
        assert(r.layers.hud_main.rect.y + r.layers.hud_main.rect.h <= visible.HUD_ACC_ASSIST[1], 'hud_main must stay above Assisted Driving / ACC');
        assert(r.layers.hud_nav.rect.y > r.layers.hud_road.rect.y + r.layers.hud_road.rect.h - 1, 'hud_nav sits cleanly below hud_road');
        assert(r.layers.hud_nav.rect.x >= visible.HUD_WINDOW.x &&
            r.layers.hud_nav.rect.y >= visible.HUD_WINDOW.y &&
            r.layers.hud_nav.rect.x + r.layers.hud_nav.rect.w <= visible.HUD_WINDOW.x + visible.HUD_WINDOW.w &&
            r.layers.hud_nav.rect.y + r.layers.hud_nav.rect.h <= visible.HUD_WINDOW.y + visible.HUD_WINDOW.h,
            'hud_nav inside HUD_WINDOW');
        assert.strictEqual(visible.overlaps(r.layers.hud_nav.rect, visible.HUD_ACC_ASSIST), false, 'hud_nav clear of left-side ACC');
        assert.strictEqual(visible.overlaps(r.layers.hud_nav.rect, visible.HUD_BMW), false, 'hud_nav clear of left-side HUD_BMW');
        assert(r.layers.hud_main.rect.x + r.layers.hud_main.rect.w < r.layers.hud_nav.rect.x, 'hud_main and hud_nav must not overlap');

        // Feed active BMW lane guidance for this intersection (dtd=1210 ~ 1200) -> still draws our HUD + 6-lane box!
        mNow += 500; wNow += 600;
        nt.feedField('guidance', 'currentLaneGuiding', {
            rows: [{
                distanceToDestination: 1210,
                lanes: [
                    { directionToFollow: 'NONE', otherDirections: ['STRAIGHT_ON'], isHighlighted: false },
                    { directionToFollow: 'RIGHT', directionsToFollow: ['RIGHT'], otherDirections: [], isHighlighted: true },
                ],
                laneMarkers: ['SOLID', 'DASHED', 'SOLID'],
                recommendedCarPositionLaneIndex: 1,
            }],
        }, mNow);
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.hasLanes, true);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, false);
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.layers.hud_main.visible, true);
        assert.strictEqual(r.layers.hud_nav.visible, true);

        // Now BMW swaps lane guidance to empty while the exact same RIGHT turn is active -> mini-map detected!
        mNow += 500; wNow += 600;
        nt.feedField('guidance', 'currentLaneGuiding', { rows: [] }, mNow);
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, true);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapReason, 'lanes_to_minimap');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.lastSummary.hudYieldedToNav, true);
        assert.strictEqual(r.layers.hud_main.visible, false, 'HUD metrics must yield for intersection mini-map');
        assert.strictEqual(r.layers.hud_nav.visible, false, 'HUD nav must yield for intersection mini-map');

        // Turn completes (next maneuver arrives) -> HUD metrics + own HUD nav immediately return!
        mNow += 500; wNow += 600;
        nt.feedEvents({
            GuidanceEventListError: 'NO_ERROR',
            viewContent: [{
                eventsInView: [{
                    intersection: {
                        uid: '11',
                        distanceToDestination: 400,
                        direction: 'LEFT',
                        formattedDistance: { distance: '0.8', unit: 'MILE_US' },
                        description: { elements: [{ text: 'Homestead Rd' }] },
                    },
                }],
            }],
        }, mNow, mNow - 20);
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, false, 'mini-map state must clear after turn completes');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.layers.hud_main.visible, true);
        assert.strictEqual(r.layers.hud_nav.visible, true);

        // Live DCSM2 HUD mini-map scene 0x1000200 in status.txt -> yields immediately even without prior lane guidance!
        wNow += 600;
        fs.writeFileSync(crFile, 'slot 0x300 status 2: 0x1000200 class 0 map 1\n');
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, true);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapReason, 'dcsm_0x1000200');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.layers.hud_main.visible, false);

        // First-party BMW GuidanceRenderedContent (service 64284):
        //   - IC/Cluster mini-map (targetUI: 'IC' / 2) must NOT hide HUD!
        //   - HUD HIGH_GUIDING / JUNCTION_VIEW (targetUI: 'HUD' / 3) MUST yield HUD immediately!
        //   - HUD NONE (0) restores HUD immediately and suppresses false lane-drop triggers!
        wNow += 600;
        fs.writeFileSync(crFile, 'slot 0x300 status 2: 0x1000210 class 0 map 1\n');
        nt.feedRenderedConfig('view_ic', { viewConfig: { targetUI: 'IC' } });
        nt.feedRenderedConfig('view_hud', { viewConfig: { targetUI: 3 } }); // 3 = HUD
        nt.feedRenderedContent('view_ic', { ramsesSceneId: 0x01000300, type: { contentType: 'HIGH_GUIDING' } });
        nt.feedRenderedContent('view_hud', { ramsesSceneId: 0x01000210, type: { contentType: 'NONE' } });
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, false, 'IC mini-map must not hide HUD when HUD contentType=NONE');

        nt.feedRenderedContent('view_hud', { ramsesSceneId: 0x01000200, type: { contentType: 1 } }); // 1 = HIGH_GUIDING
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, true);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapReason, 'bmw_high_guiding');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.layers.hud_main.visible, false, 'GuidanceRenderedContent HIGH_GUIDING must yield HUD');

        nt.feedRenderedContent('view_hud', { ramsesSceneId: 0x01000201, type: { contentType: 'JUNCTION_VIEW' } });
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, true);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapReason, 'bmw_junction_view');

        nt.feedRenderedContent('view_hud', { ramsesSceneId: 0, type: { contentType: 'NONE' } });
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, false, 'contentType=NONE must immediately restore HUD');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.layers.hud_main.visible, true);

        // Waze-on-Cluster HUD projection active -> overlays hud_main on top of Waze's 0x323 HUD map and hides only hud_nav!
        wNow += 600;
        fs.writeFileSync(crFile, 'slot 0x300 status 2: 0x1000210 class 0 map 1\n');
        fs.writeFileSync(wazeFile, JSON.stringify({ state: 'showing', target: 'map', hud: 1, hud_state: 'showing' }));
        baseModel.telemetry.hudNav = nt.snapshot(wNow, mNow);
        assert.strictEqual(baseModel.telemetry.hudNav.wocHudShowing, true);
        assert.strictEqual(baseModel.telemetry.hudNav.miniMapActive, false, 'Waze HUD shares 0x323 and must not trigger 0x300 mini-map yield');
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.lastSummary.hudYieldedToNav, false);
        assert.strictEqual(r.lastSummary.wocHudOverlay, true);
        assert.strictEqual(r.layers.hud_main.visible, true, 'hud_main must stay visible overlaid on Waze HUD projection');
        assert.strictEqual(r.layers.hud_nav.visible, false, 'hud_nav must hide when Waze HUD map already shows turns');

        // Explicit yield_route mode still hides HUD metrics during Waze HUD if user asked to hide during route
        r.render(baseModel, { enabled: true, hudNavMode: 'yield_route' }, wNow);
        assert.strictEqual(r.layers.hud_main.visible, false);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /* 14. DSC 0x29 Hydraulic Brake Pressure UDS (DBE5 / DB29 / DBF5 / DBF6), 0 mph Floor Pedal & 30s Probe Log */
    await test('DSC 0x29 hydraulic brake UDS separates pedal EV regen from caliper friction, fills 20/20 at 0 mph & writes probe log', async () => {
        // Unit-check SGBD DSC_G30N 0xDBE5 (6x s16 * 0.1 bar), 0xDBF5 (pedal mm), and 0xDBF6 (regen Nm)
        // K1 = 12.0 bar (120 = 0x0078), K2 = 11.8 bar (0x0076), VA(@4) = 0.0 bar (0xFFFF = -0.1 noise -> 0), HA(@8) = 0.0 bar
        const regenOnlyFrame = [0x62, 0xDB, 0xE5, 0x00, 0x78, 0x00, 0x76, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        const decRegen = decodeDscPressure(0xDBE5, regenOnlyFrame);
        assert.strictEqual(decRegen.k1, 12.0);
        assert.strictEqual(decRegen.wheelMax, 0, 'negative zero-offset noise 0xFFFF (-0.1 bar) must clamp to 0 bar');

        // Hard stop / floor pedal: K1 = 52.0 bar (520 = 0x0208), VA(@4) = 50.0 bar (500 = 0x01F4), HA(@8) = 38.0 bar (380 = 0x017C)
        const hardClampFrame = [0x62, 0xDB, 0xE5, 0x02, 0x08, 0x02, 0x08, 0x01, 0xF4, 0x00, 0x00, 0x01, 0x7C, 0x00, 0x00];
        const decClamp = decodeDscPressure(0xDBE5, hardClampFrame);
        assert.strictEqual(decClamp.wheelMax, 50.0);

        const pedDec = decodeDscPedal([0x62, 0xDB, 0xF5, 0x09, 0xC4, 0x00, 0x00, 0x00, 0x32, 0x03, 0xE8]); // 25.00mm, null=0.50mm, leer=10.00mm
        assert(Math.abs(pedDec.wegIstMm - 25.0) < 0.01 && Math.abs(pedDec.wegLeerMm - 10.0) < 0.01);
        const regDec = decodeDscRegen([0x62, 0xDB, 0xF6, 0xFE, 0x70, 0xFE, 0x7A]); // -400 Nm, -390 Nm
        assert.strictEqual(regDec.regenSollNm, -400);
        assert.strictEqual(regDec.regenIstNm, -390);

        // Live SignalHub + OverlayRenderer test:
        //   Step 1: Stopped at 0 mph pressing brake to floor (50 bar) -> fills 20/20 segments and renders "50 bar"
        //   Step 2: Moving at 55 km/h pressing brake lightly in Eco Pro (K1=12 bar simulator, VA=0 bar, EV regen -18 kW) -> 0/20 segments!
        //   Step 3: Pressing deeper past regen limit (VA=18 bar) -> lights 8/20 segments + "18 bar"!
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-probe-test-'));
        const probeFile = path.join(tmpDir, 'probe.log');
        const appSpec = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
        let currentDbe5 = hardClampFrame;

        const fakeDiag = {
            available: true,
            busy: 0,
            stats: { sent: 0, replies: 0, missed: 0, blocked: 0 },
            silent: () => false,
            wake: () => {},
            cancel: () => {},
            async physical(ecu, sid, payload) {
                fakeDiag.stats.sent++;
                fakeDiag.stats.replies++;
                if (sid !== 0x22) return null;
                const did = ((payload[0] << 8) | payload[1]);
                if (ecu === 0x29 && did === 0xF150) return [0x62, 0xF1, 0x50, 0x0F, 0x28, 0x50]; // DSC_G30N = 0F2850
                if (ecu === 0x29 && did === 0xDBE5) return currentDbe5;
                if (ecu === 0x29 && did === 0xDBF5) return [0x62, 0xDB, 0xF5, 0x09, 0xC4, 0x00, 0x00, 0x00, 0x00, 0x03, 0xE8];
                if (ecu === 0x29 && did === 0xDBF6) return [0x62, 0xDB, 0xF6, 0xFE, 0x70, 0xFE, 0x7A];
                if (ecu === 0x07 && did === 0xDDBC) return [0x62, 0xDD, 0xBC, 0x02, 0xBC]; // 70.0%
                if (ecu === 0x07 && did === 0xDDB4) return [0x62, 0xDD, 0xB4, 0x8C, 0xA0]; // 360.0V
                if (ecu === 0x07 && did === 0xDD69) return [0x62, 0xDD, 0x69, 0x00, 0x00, 0x13, 0x88]; // +50.0A => -18.0 kW regen
                return null;
            },
        };

        const ctxStub = {
            dataDir: tmpDir,
            log: { info: () => {}, warn: () => {}, error: () => {} },
            spec: appSpec,
            settings: { values: { demo: 'off', vehicle: 'phev' }, get: (k) => (k === 'demo' ? 'off' : (k === 'enabled' ? true : 'phev')) },
            signals: null,
        };
        const hub = new SignalHub(ctxStub, {
            diagLink: fakeDiag,
            ipcDir: path.join(tmpDir, 'no-ipc'),
            edriveWantedPath: path.join(tmpDir, 'wanted.json'),
            probeLogPath: probeFile,
        });
        hub.live.stage = 'D';
        hub.live.gear = 1;
        hub.live.speedKmh = 0;
        hub.live.driverBraking = true;
        hub.start();
        await hub.pollNow();

        const r = new OverlayRenderer({ allowPanel: true });
        const prof = { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null };
        const eff = { evKmPerKwh: 6.0, fuelLPer100km: null, isDfco: false };

        // Step 1: 0 mph stopped in D, pedal to floor (50 bar) -> 20/20 segments lit!
        const snapFloor = hub.snapshot(Date.now());
        assert.strictEqual(snapFloor.dscBrake.sgbd, '0F2850');
        assert.strictEqual(snapFloor.brakeBar, 50.0);
        assert.strictEqual(snapFloor.brakeHold, false, '50 bar floor press must show full hydraulic bar, not 1-seg hold');
        r.render({ units: unitsMod.US_PRESET, profile: prof, efficiency: eff, telemetry: snapFloor }, { enabled: true, brakeIndicator: 'bar_num' }, Date.now());
        assert.strictEqual(r.lastSummary.brakeLit, 20, 'depressing brake to floor at 0 mph (50 bar) must fill all 20/20 segments');

        // Step 2: Moving at 55 km/h, pure brake-pedal EV regen (K1=12 bar simulator, wheel VA=0 bar, -18 kW) -> 0/20 segments!
        hub.live.speedKmh = 55;
        hub.live.gear = 4;
        currentDbe5 = regenOnlyFrame;
        await hub.startProbe(180);
        await new Promise((res) => setTimeout(res, 220));
        const snapPurePedalRegen = hub.snapshot(Date.now());
        assert.strictEqual(snapPurePedalRegen.probeRemainingSec, 0, 'probe must be finished before Step 3');
        assert.strictEqual(snapPurePedalRegen.brakeBar, 0, 'decoupled wheel caliper 0 bar during pedal EV regen must report 0 bar');
        assert.strictEqual(snapPurePedalRegen.frictionG, 0, 'pure brake-pedal EV regen must keep frictionG = 0');
        assert.strictEqual(snapPurePedalRegen.pureRegen, true);
        r.render({ units: unitsMod.US_PRESET, profile: prof, efficiency: eff, telemetry: snapPurePedalRegen }, { enabled: true, brakeIndicator: 'bar_num' }, Date.now());
        assert.strictEqual(r.lastSummary.brakeLit, 0, 'pure brake-pedal EV regen must light 0 friction segments');

        // Step 3: Pressing deeper past regen limit at 55 km/h WITH driverBraking=false & NO probe running ->
        // dedicated 260ms dscTimer reads VA = 18.0 bar = 0x00B4 automatically and lights friction segments!
        hub.live.driverBraking = false;
        hub.live.pedalPct = 0;
        currentDbe5 = [0x62, 0xDB, 0xE5, 0x00, 0xDC, 0x00, 0xDC, 0x00, 0xB4, 0x00, 0x00, 0x00, 0x78, 0x00, 0x00];
        await new Promise((res) => setTimeout(res, 380));
        const snapBlend = hub.snapshot(Date.now());
        assert.strictEqual(snapBlend.brakeBar, 18.0, 'dedicated 260ms dscTimer must update brakeBar at 55 km/h even when driverBraking=false');
        r.render({ units: unitsMod.US_PRESET, profile: prof, efficiency: eff, telemetry: snapBlend }, { enabled: true, brakeIndicator: 'bar_num' }, Date.now());
        assert(r.lastSummary.brakeLit >= 7 && r.lastSummary.brakeLit <= 9, '18 bar blended braking expected ~8/20 segments, got ' + r.lastSummary.brakeLit);

        // Step 4: Stepping back onto accelerator pedal (pedalPct = 12%) immediately clears caliperBar to 0!
        hub.live.pedalPct = 12;
        await new Promise((res) => setTimeout(res, 300));
        assert.strictEqual(hub.snapshot(Date.now()).brakeBar, 0, 'accelerating must zero caliperBar immediately');

        // Verify probe log file was written to both /tmp path and dataDir/brake-probe.log
        const logTxt = fs.readFileSync(probeFile, 'utf8');
        assert(logTxt.indexOf('0F2850') >= 0 && logTxt.indexOf('"regenIstNm":-390') >= 0, 'probe log must contain SGBD + DSC channels');
        assert(fs.existsSync(path.join(tmpDir, 'brake-probe.log')), 'probe log must also mirror to dataDir/brake-probe.log');

        hub.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /* 15. TPMS Display-Unit Scaling (No "FL 479psi"), Pure-JS PNG Cover Art, Right-Wing Media Widget & BC Stalk Cycling */
    await test('TPMS PSI raw 330/360 decodes to ~2.28/2.48 bar (never 479psi), PNG cover art decodes, and BC stalk cycles right_widget', async () => {
        const appSpec = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
        const hub = new SignalHub({
            log: { info: () => {}, warn: () => {}, error: () => {} },
            spec: appSpec,
            settings: { values: { demo: 'off', unitSystem: 'us' }, get: (k) => (k === 'demo' ? 'off' : 'us') },
            signals: null,
        }, { diagLink: { available: false, stats: {} }, ipcDir: path.join(os.tmpdir(), 'no-ipc-' + process.pid) });

        // Simulate G30 US car reporting TPMS raw 330 (33.0 psi) & target 360 (36.0 psi)
        hub._updateTpms('pressure', {
            actualValuePressureTyreFLH: 330, actualValuePressureTyreFRH: 340,
            actualValuePressureTyreRLH: 350, actualValuePressureTyreRRH: 350,
        });
        hub._updateTpms('target', {
            targetPressureTyreFLH: 360, targetPressureTyreFRH: 360,
            targetPressureTyreRLH: 380, targetPressureTyreRRH: 380,
        });
        hub._updateTpms('temp', { actualValueTemperatureTyreFLH: 78 + 40 }); // 78F -> ~25.6C
        const fl = hub.live.tpms.FL;
        assert(fl.pressureBar > 2.20 && fl.pressureBar < 2.35, '330 raw in PSI mode must decode to ~2.28 bar, got ' + fl.pressureBar);
        assert(fl.targetBar > 2.42 && fl.targetBar < 2.55, '360 raw in PSI mode must decode to ~2.48 bar, got ' + fl.targetBar);
        assert(fl.tempC > 22 && fl.tempC < 29, '78F tire temp must convert to ~25.6C, got ' + fl.tempC);
        const ast = { _v12LowSince: 0 };
        assert.strictEqual(detectAnomaly({ tpms: hub.live.tpms }, unitsMod.US_PRESET, ast, 1000), null,
            '33 psi vs 36 psi target (3 psi diff) must NEVER trigger false "FL 479psi" red alert');

        // Verify pure-JS PNG decoder + full-wing gauge-edge backdrop + multi-chunk HmiMediaState.coverArt + 3-row title + pagination
        const iconPng = fs.readFileSync(path.join(APP_DIR, 'icon.png'));
        const thumb = decodeCoverThumb(iconPng, 144);
        assert(thumb && thumb.w === 144 && thumb.h === 144 && thumb.d.length === 144 * 144 * 4, 'PNG cover must decode to 144x144 RGBA');
        const bg = buildStockBackdrop(thumb, 536, 516, { ox: 1252, oy: 88, vx: 186, vy: 224 });
        assert(bg && bg.length === 536 * 516 * 4, 'stock gauge-edge backdrop must render across 536x516 widget canvas');
        assert.strictEqual(buildStockBackdrop(thumb, 536, 516, { ox: 1252, oy: 88, vx: 186, vy: 224 }), bg, 'backdrop must be cached per track');
        // Verify backdrop reaches right-wing outer bezel (world 1700, 355 -> local 448, 267) at uniform translucency without darkened border!
        const wingSampleOff = (267 * 536 + 448) * 4;
        assert(bg[wingSampleOff + 3] >= 65, 'right-wing cover backdrop must extend smoothly to outer gauge edge, got alpha=' + bg[wingSampleOff + 3]);

        // BMW 3-row podcast/song PlayerMetadata: firstLineType=ARTIST, secondLineType=ALBUM, threeRowText=Episode Title
        const parsedPodcast = parseHmiPlayerMetadata({
            firstLineText: 'Freakonomics Radio',
            firstLineType: 1, // ARTIST
            secondLineText: 'October 16',
            secondLineType: 2, // ALBUM
            threeRowText: 'Freakonomics Radio\nOctober 16\n691. Is This What a Healthy Economy Looks Like?',
            uiType: 2,
        });
        assert.strictEqual(parsedPodcast.title, '691. Is This What a Healthy Economy Looks Like?');
        assert.strictEqual(parsedPodcast.artist, 'Freakonomics Radio');
        assert.strictEqual(parsedPodcast.explicitTitle, true);

        const mt = new MediaTracker();
        // When HmiMediaState omits threeRowText (ARTIST + ALBUM only) while CarPlayMedia has TITLE, snapshot must pick CarPlay TITLE!
        mt.feedMediaPlayerState('PLAYER_STATE_PLAY', 9900);
        mt.feedMediaPlayerMetadata([
            { key: 3, value: { stringValue: '691. Is This What a Healthy Economy Looks Like?' } },
            { key: 5, value: { stringValue: 'Freakonomics Radio' } },
        ], 9950);
        mt.feedHmiMetadata({ firstLineText: 'Freakonomics Radio', secondLineText: 'October 16', firstLineType: 1, secondLineType: 2 }, 10000);
        mt.feedHmiProgress({ elapsed: 84000, total: 230000, hasProgress: true }, 10000);
        // Split PNG into 2 chunks to exercise multi-chunk CoverArt reassembly
        const half = Math.floor(iconPng.length / 2);
        assert.strictEqual(mt.feedHmiCoverArt({ coverArtId: 77, totalSize: iconPng.length, offset: 0, coverArt: iconPng.slice(0, half) }, true), false);
        assert.strictEqual(mt.feedHmiCoverArt({ coverArtId: 77, totalSize: iconPng.length, offset: half, coverArt: iconPng.slice(half) }, true), true);

        let mSnap = mt.snapshot(12000, false);
        assert.strictEqual(mSnap.active, true);
        assert.strictEqual(mSnap.title, '691. Is This What a Healthy Economy Looks Like?');
        assert.strictEqual(mSnap.artist, 'Freakonomics Radio');
        assert(mSnap.cover && mSnap.cover.w === 144);
        assert.strictEqual(mSnap.page, 'media');

        // Verify long title shrinks to 22px min and paginates smoothly over time (never truncating permanently)
        const testCv = new Canvas(456, 396);
        const pg0 = paginateTitle(testCv, mSnap.title, 336, [30, 27, 24, 22], 22, 500);
        const pg1 = paginateTitle(testCv, mSnap.title, 336, [30, 27, 24, 22], 22, 4200);
        assert.strictEqual(pg0.size, 22);
        assert(pg0.pages >= 2 && pg0.page === 0 && pg1.page === 1, 'long title must paginate cleanly across segments');
        assert(pg0.text !== pg1.text && pg1.text.indexOf('Looks') >= 0);

        const r = new OverlayRenderer({ allowPanel: true });
        const model = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: { speedKmh: 60, rpm: 0, hvKw: 12.4, soc: 76, erangeKm: 28, frangeKm: 310, tripDistKm: 19.4, gearboxOilC: 84, battTempC: 25, v12: 14.1, stage: 'D', program: 'D', gear: 5, frictionG: 0.24, brakeBar: 20, media: mSnap },
        };
        r.render(model, { enabled: true, rightWidgetMode: 'cycle', hudLine1: 'efficiency_gear', hudLine2: 'power', hudLine3: 'brake' }, 12000);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'media');
        assert.strictEqual(r.layers.right_widget.visible, true);

        // Verify non-shifting HUD Line 1 Efficiency + Gear alignment:
        //   - Changing efficiency value ("3.8" -> "34.6" -> "--") keeps Gear "D5" pixel slice (x=162..220) identical!
        //   - Changing Stage P (no gear) <-> D5 keeps Efficiency pixel slice (x=0..145) identical!
        const grabHudSlice = (cv, x0, x1) => {
            const chunks = [];
            for (let y = 0; y < 44; y++) chunks.push(Buffer.from(cv.d.slice((y * cv.w + x0) * 4, (y * cv.w + x1) * 4)));
            return Buffer.concat(chunks);
        };
        const gearSliceA = grabHudSlice(r.layers.hud_main.cv, 162, 220);
        const effSliceA = grabHudSlice(r.layers.hud_main.cv, 0, 145);

        model.efficiency.evKmPerKwh = 21.5; // "13.4 mi/kWh" (wider digits)
        r.render(model, { enabled: true, hudLine1: 'efficiency_gear', hudLine2: 'power', hudLine3: 'brake' }, 12050);
        assert.strictEqual(Buffer.compare(gearSliceA, grabHudSlice(r.layers.hud_main.cv, 162, 220)), 0,
            'Gear D5 on HUD Row 1 must NOT shift when efficiency changes width');

        model.efficiency.evKmPerKwh = 6.1;
        model.telemetry.stage = 'P';
        model.telemetry.gear = null;
        r.render(model, { enabled: true, hudLine1: 'efficiency_gear', hudLine2: 'power', hudLine3: 'brake' }, 12100);
        assert.strictEqual(Buffer.compare(effSliceA, grabHudSlice(r.layers.hud_main.cv, 0, 145)), 0,
            'Efficiency on HUD Row 1 must NOT shift when Gear disappears in Park');
        model.telemetry.stage = 'D';
        model.telemetry.gear = 5;

        // Cycle 1: KombiIF.statusKombiSelection change -> flips page 'media' -> 'trip'
        mt.feedKombiSelection({ statusActivationInstrumentPackContent: 1, statusActivationInstrumentPackBC: 10 }, 12000); // baseline
        assert.strictEqual(mt.feedKombiSelection({ statusActivationInstrumentPackContent: 2, statusActivationInstrumentPackBC: 11 }, 12500), true);
        mSnap = mt.snapshot(12500, false);
        assert.strictEqual(mSnap.page, 'trip');
        model.telemetry.media = mSnap;
        r.render(model, { enabled: true, rightWidgetMode: 'cycle' }, 12500);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'trip');
        assert.strictEqual(r.layers.right_widget.visible, true);

        // Cycle 2: Left-stalk momentary button pulse (operationColumnStalks 0 -> 4 -> 0) -> flips 'trip' -> 'off' (when widgetTpms not enabled)
        mt.feedStalk({ operationColumnStalks: 0 }, 13000); // baseline rest
        mt.feedStalk({ operationColumnStalks: 4 }, 13100); // press
        assert.strictEqual(mt.feedStalk({ operationColumnStalks: 0 }, 13220), true); // release
        mSnap = mt.snapshot(13220, false);
        assert.strictEqual(mSnap.page, 'tpms');
        model.telemetry.media = mSnap;
        r.render(model, { enabled: true, rightWidgetMode: 'cycle' }, 13220);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'off');
        assert.strictEqual(r.layers.right_widget.visible, false);

        // Cycle 3: Quick double-tap of left-stalk HBA button must NOT cycle right_widget; genuine BC click cycles back to 'media'
        mt.feedStalk({ operationColumnStalks: 0, statusPushButtonMainBeamAssistant: 'TASTER_GEDRUECKT' }, 14000);
        mt.feedStalk({ operationColumnStalks: 0, statusPushButtonMainBeamAssistant: 'KEINE_BETAETIGUNG' }, 14080);
        mt.feedStalk({ operationColumnStalks: 0, statusPushButtonMainBeamAssistant: 'TASTER_GEDRUECKT' }, 14200);
        mt.feedStalk({ operationColumnStalks: 0, statusPushButtonMainBeamAssistant: 'KEINE_BETAETIGUNG' }, 14280);
        await new Promise((res) => setTimeout(res, 700));
        mSnap = mt.snapshot(15100, false);
        assert.strictEqual(mSnap.bcStep, 2, 'double-tap HBA button fallback must be removed');
        assert.strictEqual(mt.feedKombiSelection({ statusActivationInstrumentPackContent: 3, statusActivationInstrumentPackBC: 12 }, 15150), true);
        mSnap = mt.snapshot(15150, false);
        model.telemetry.media = mSnap;
        r.render(model, { enabled: true, rightWidgetMode: 'cycle' }, 15150);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'media', '3rd genuine BC click must cycle right_widget back to media');

        // Fallback rendering when audio source has no cover art or is inactive
        model.telemetry.media = { active: true, title: 'FM 88.5 KQED', artist: 'Live Radio', cover: null, playing: true, page: 'media', bcStep: 0 };
        r.render(model, { enabled: true, rightWidgetMode: 'media' }, 15200);
        assert.strictEqual(r.layers.right_widget.visible, true, 'right_widget visible for no-cover active media');
        model.telemetry.media = { active: false, page: 'media', bcStep: 0 };
        r.render(model, { enabled: true, rightWidgetMode: 'media' }, 15300);
        assert.strictEqual(r.layers.right_widget.visible, true, 'right_widget visible for inactive media standby');
        mt.stop();
    });

    /* 16. v0.7.1: Int64 CoverArt Update (Never Stuck), CJK Title/Artist Rendering, Widget Checkboxes & Charging Finish Time + Power Meter */
    await test('v0.7.1: Int64 coverArt updates across tracks, Chinese/Japanese titles render cleanly, and Charging locks finish-time + kW meter', () => {
        // A. Cover art must NEVER stick when BMW sends Int64 object coverArtId ({ high: 0, low: 1 }) or reuses IDs!
        const mt = new MediaTracker();
        const cvBlue = new Canvas(64, 64);
        cvBlue.clear('#1d4ed8');
        const pngBlue = cvBlue.png();
        const cvRed = new Canvas(64, 64);
        cvRed.clear('#dc2626');
        const pngRed = cvRed.png();

        mt.feedHmiMetadata({ firstLineText: 'Blue Track', firstLineType: 3, secondLineText: 'Artist A', secondLineType: 1 }, 1000);
        assert.strictEqual(mt.feedHmiCoverArt({ coverArtId: { high: 0, low: 1 }, totalSize: pngBlue.length, offset: 0, coverArt: pngBlue }, true), true);
        let snap1 = mt.snapshot(1050, false);
        assert(snap1.cover && snap1.cover.d[2] > snap1.cover.d[0], 'first cover must be blue');

        mt.feedHmiMetadata({ firstLineText: 'Red Track', firstLineType: 3, secondLineText: 'Artist B', secondLineType: 1 }, 2000);
        assert.strictEqual(mt.feedHmiCoverArt({ coverArtId: { high: 0, low: 1 }, totalSize: pngRed.length, offset: 0, coverArt: pngRed }, true), true);
        let snap2 = mt.snapshot(2050, false);
        assert(snap2.coverRev > snap1.coverRev && snap2.cover.id !== snap1.cover.id, 'second track cover must invalidate Int64 collision cache');
        assert(snap2.cover.d[0] > snap2.cover.d[2], 'second cover must update to red artwork');

        // B. Chinese & Japanese title/artist preservation (never "[Track]") + Canvas glyph rendering + CJK pagination
        const jpTitle = '\u591c\u306b\u99c6\u3051\u308b'; // "Yoru ni Kakeru"
        const cnTitle = '\u4e03\u91cc\u9999'; // "Qilixiang"
        const cnArtist = '\u5468\u6770\u502b'; // "Jay Chou" (TC)
        mt.feedHmiMetadata({ firstLineText: jpTitle, firstLineType: 3, secondLineText: 'YOASOBI', secondLineType: 1 }, 3000);
        const jpSnap = mt.snapshot(3050, false);
        assert.strictEqual(jpSnap.title, jpTitle, 'Japanese Hiragana/Kanji title must be preserved');
        assert.strictEqual(jpSnap.artist, 'YOASOBI');

        mt.feedHmiMetadata({ firstLineText: cnTitle + ' - ' + cnArtist, firstLineType: 3, secondLineText: cnArtist, secondLineType: 1 }, 4000);
        const cnSnap = mt.snapshot(4050, false);
        assert(cnSnap.title.indexOf(cnTitle) >= 0 && cnSnap.title.indexOf('[Track]') === -1, 'Chinese SC+TC title must never degrade to [Track]');
        assert.strictEqual(cnSnap.artist, cnArtist);

        const cjkTestCv = new Canvas(536, 516);
        const longJp = '\u3053\u308c\u306f\u3068\u3066\u3082\u9577\u3044\u65e5\u672c\u8a9e\u306e\u66f2\u540d\u30c6\u30b9\u30c8\u3067\u3059\u5168\u90e8\u8868\u793a\u3055\u308c\u307e\u3059';
        const cjkPg0 = paginateTitle(cjkTestCv, longJp, 332, [30, 27, 24, 22], 22, 500);
        const cjkPg1 = paginateTitle(cjkTestCv, longJp, 332, [30, 27, 24, 22], 22, 4200);
        assert(cjkPg0.pages >= 2 && cjkPg0.text !== cjkPg1.text, 'long CJK title must paginate cleanly across character boundaries');

        // Render Chinese/Japanese track onto right_widget and verify non-empty painted glyph pixels in title & artist rows!
        const r = new OverlayRenderer({ allowPanel: true });
        const model = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: {
                speedKmh: 0, rpm: 0, hvKw: 0.4, soc: 68, erangeKm: 26, frangeKm: 390,
                stage: 'P', program: 'D', gear: 0, frictionG: 0, brakeBar: 0,
                media: Object.assign({}, snap2, { title: jpTitle + ' (' + cnTitle + ')', artist: cnArtist + ' / YOASOBI' }),
                charging: { active: false, plugConnected: false },
            },
        };
        r.render(model, { enabled: true, widgetMedia: true, widgetTrip: true }, 4100);
        assert.strictEqual(r.layers.right_widget.rect.x, 1252, 'right_widget shifted right to x=1252 (foreground cx=1438)');
        let titleGlyphPixels = 0;
        let artistGlyphPixels = 0;
        const rwCv = r.layers.right_widget.cv;
        for (let y = 260; y <= 292; y++) {
            for (let x = 90; x <= 282; x++) {
                const o = (y * rwCv.w + x) * 4;
                if (rwCv.d[o] > 210 && rwCv.d[o + 1] > 210 && rwCv.d[o + 2] > 210 && rwCv.d[o + 3] > 200) titleGlyphPixels++;
            }
        }
        for (let y = 298; y <= 328; y++) {
            for (let x = 90; x <= 282; x++) {
                const o = (y * rwCv.w + x) * 4;
                if (rwCv.d[o] > 165 && rwCv.d[o + 1] > 170 && rwCv.d[o + 3] > 200) artistGlyphPixels++;
            }
        }
        assert(titleGlyphPixels > 120 && artistGlyphPixels > 80,
            'Chinese & Japanese glyphs must draw crisp bright pixels (title=' + titleGlyphPixels + ', artist=' + artistGlyphPixels + ')');

        // C. Checkbox cycling + Charge detection + Charging widget lock + Charging speed hero meter
        r.render(model, { enabled: true, widgetMedia: false, widgetTrip: false }, 4200);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'off', 'both checkboxes unchecked -> right_widget off when not charging');
        assert.strictEqual(r.layers.right_widget.visible, false);

        const chgRaw = {
            wirePlugged: true, lscStatus: 'active',
            endHour: 23, endMin: 45, residualMin: 95, maxAmps: 16, targetSoc: 100, _shorePowerSince: 0,
        };
        const chgOn = computeChargingState(chgRaw, { speedKmh: 0, rpm: 0, hvKw: -3.5, soc: 68, stage: 'P' }, 5000);
        assert.strictEqual(chgOn.active, true);
        assert.strictEqual(chgOn.finishTimeText, '23:45');
        assert.strictEqual(chgOn.remainText, '1h 35m');
        assert.strictEqual(chgOn.chargeKw, 3.5);

        model.telemetry.hvKw = -3.5;
        model.telemetry.charging = chgOn;
        // Even with BOTH widgetMedia=false and widgetTrip=false, charging forces rightWidgetPage='charging'!
        r.render(model, { enabled: true, widgetMedia: false, widgetTrip: false }, 5100);
        assert.strictEqual(r.lastSummary.isCharging, true);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'charging', 'charging widget must auto-activate and cannot be turned off while charging');
        assert.strictEqual(r.layers.right_widget.visible, true);
        assert.strictEqual(r.lastSummary.hero.value, '3.5', 'below_speed must replace -- mi/kWh with charging speed kW');
        assert.strictEqual(r.lastSummary.hero.unit, 'kW');
        assert.strictEqual(r.lastSummary.subText, 'CHARGING 16A');

        // When car finishes/unplugs (not charging), charging widget automatically disables
        const chgOff = computeChargingState({ wirePlugged: false, lscStatus: 'done', _shorePowerSince: 0 }, { speedKmh: 0, rpm: 0, hvKw: 0.1, soc: 100, stage: 'P' }, 6000);
        assert.strictEqual(chgOff.active, false);
        model.telemetry.charging = chgOff;
        model.telemetry.hvKw = 0.2;
        r.render(model, { enabled: true, widgetMedia: false, widgetTrip: false }, 6100);
        assert.strictEqual(r.lastSummary.isCharging, false);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'off', 'charging widget must disable automatically when not charging');
        mt.stop();
    });

    /* 17. Lead-Car Headway HUD, 12V Battery SoC %, PHEV-Only HV Gauge SoC, Cabin Temp Car-Box & On-Demand Signal Gating */
    await test('Lead-car headway HUD, 12V SoC %, PHEV-only HV gauge SoC, cabin temp car-box, and dynamic on-demand signal teardown', async () => {
        // A. Pure signal decoders: 12V SoC %, Cabin Temp, and LeadVehicleTracker
        assert.strictEqual(decodeStatusBattery2({ conditionBatteryChargingCondition: 86 }), 86);
        assert.strictEqual(decodeStatusBattery2({ conditionBatteryChargingCondition: 0 }), 0);
        assert.strictEqual(decodeStatusBattery2({ conditionBatteryChargingCondition: 255 }), null, '255 invalid must return null');

        assert.strictEqual(decodeCabinTemp({ temperatureInside: 124 }), 22.0); // 124 * 0.5 - 40 = 22.0C (72F)
        assert.strictEqual(decodeCabinTemp({ temperatureInside: 80 }), 0.0);
        assert.strictEqual(decodeCabinTemp({ temperatureInside: 255 }), null, '255 invalid must return null');

        const lt = new LeadVehicleTracker();
        assert.strictEqual(lt.snapshot(100, 1000).active, false);
        // Feed DataFrontVehicle: 576 * 0.0625 = 36.0m at 72 km/h (20 m/s) -> 1.80s headway
        lt.feedDataFront({ frontVehicleObjectID: 7, frontVehicleGapX: 576, qualifierEventDataFunctionFrontVehicle: 0 }, 1000);
        let lSnap = lt.snapshot(72, 1050);
        assert.strictEqual(lSnap.active, true);
        assert(Math.abs(lSnap.gapM - 36.0) < 0.01);
        assert(Math.abs(lSnap.headwaySec - 1.8) < 0.02);

        // 500ms later, gap closes from 36.0m -> 31.0m (-5.0m in 0.5s = -10 m/s = -36 km/h closing)
        lt.feedDataFront({ frontVehicleObjectID: 7, frontVehicleGapX: 496, qualifierEventDataFunctionFrontVehicle: 0 }, 1500);
        lSnap = lt.snapshot(72, 1520);
        assert(lSnap.relSpeedKmh < -20, 'closing gap must yield negative relSpeedKmh, got ' + lSnap.relSpeedKmh);
        const hwFmt = formatLeadHeadwayParts(lSnap, unitsMod.US_PRESET, 'full');
        assert.strictEqual(hwFmt.primaryStr, '1.6s');
        assert(hwFmt.secDistStr.indexOf('ft') > 0);
        assert(hwFmt.deltaStr.indexOf('-') === 0 && hwFmt.deltaStr.indexOf('mph') > 0, 'closing speed must format in mph');

        // Below 12 km/h creep: headwaySec is null so primary readout shows distance cleanly instead of 9.9s noise
        const creepSnap = lt.snapshot(5, 1600);
        assert.strictEqual(creepSnap.headwaySec, null);
        const creepFmt = formatLeadHeadwayParts(creepSnap, unitsMod.METRIC_PRESET, 'compact');
        assert.strictEqual(creepFmt.primaryStr, '31 m');
        assert.strictEqual(creepFmt.secDistStr, '');
        assert.strictEqual(creepFmt.deltaStr, '');

        // Staleness > 2.5s or explicit EVENT_DATA_NOT_AVAILABLE clears lead vehicle immediately
        assert.strictEqual(lt.snapshot(72, 4200).active, false, 'stale radar data >2.5s must auto-hide');
        lt.feedDataFront({ frontVehicleObjectID: 7, frontVehicleGapX: 400, qualifierEventDataFunctionFrontVehicle: 0 }, 4500);
        assert.strictEqual(lt.snapshot(72, 4550).active, true);
        lt.feedDataFront({ frontVehicleObjectID: 255, frontVehicleGapX: 4095, qualifierEventDataFunctionFrontVehicle: 2 }, 4600);
        assert.strictEqual(lt.snapshot(72, 4620).active, false, 'EVENT_DATA_NOT_AVAILABLE must clear lead vehicle immediately');

        // B. OverlayRenderer: PHEV-only hv_soc_gauge, cabin_temp toggle, and hud_headway geometry across nudges
        const r = new OverlayRenderer({ allowPanel: true });
        const phevModel = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: {
                speedKmh: 96, rpm: 0, hvKw: 14.0, soc: 68, soc12: 86, v12: 14.0, cabinTempC: 22.0,
                stage: 'D', program: 'D', gear: 6,
                leadVehicle: { active: true, gapM: 32.0, headwaySec: 1.2, relSpeedKmh: -11.0, status: 'ok' },
            },
        };

        [-40, 0, 40].forEach((nudge) => {
            r.render(phevModel, { enabled: true, hudHeadway: 'full', hudNudgeX: nudge, hudNudgeY: nudge }, 5000);
            const hwL = r.layers.hud_headway;
            assert(hwL && hwL.visible, 'hud_headway must be visible when leadVehicle.active=true');
            const hudIssues = visible.check([{ id: 'hud_headway', x: hwL.rect.x, y: hwL.rect.y, w: hwL.rect.w, h: hwL.rect.h }], 'hud');
            assert.strictEqual(hudIssues.length, 0, 'hud_headway must pass visible.check at nudge=' + nudge + ': ' + hudIssues.join(', '));
            assert(hwL.rect.y + hwL.rect.h <= visible.HUD_ACC_ASSIST[1], 'hud_headway must stay strictly above ACC y=202');
            assert(hwL.rect.x + hwL.rect.w < visible.HUD_STOCK_NAV[0], 'hud_headway must stay strictly left of HUD nav x=405');
        });

        // Turning off hudHeadway or having no lead car hides hud_headway
        r.render(phevModel, { enabled: true, hudHeadway: 'off' }, 5100);
        assert.strictEqual(r.layers.hud_headway.visible, false, 'hudHeadway=off must hide hud_headway');

        // PHEV vs ICE: hv_soc_gauge MUST be hidden on ICE cars even if soc were present!
        assert.strictEqual(r.layers.hv_soc_gauge.visible, true, 'PHEV must show hv_soc_gauge');
        const iceModel = Object.assign({}, phevModel, {
            profile: { vehicleType: 'ice', engineOn: true, mode: 'gas_warm', isEv: false, isCold: false, coldCeilingRpm: null, alert: null },
        });
        r.render(iceModel, { enabled: true, hvSocGauge: true }, 5200);
        assert.strictEqual(r.layers.hv_soc_gauge.visible, false, 'ICE cars must NEVER render hv_soc_gauge over their oil-temp gauge');

        // Turning off cabinTempDisplay hides cabin_temp
        r.render(phevModel, { enabled: true, cabinTempDisplay: false, hvSocGauge: false }, 5300);
        assert.strictEqual(r.layers.cabin_temp.visible, false, 'cabinTempDisplay=false must hide cabin_temp');
        assert.strictEqual(r.layers.hv_soc_gauge.visible, false, 'hvSocGauge=false must hide hv_soc_gauge');

        // C. Strict On-Demand Subscription Gating (`SignalHub.syncDemand` tears down disabled SOME/IP watchers)
        const watched = {};
        const shutdownCounts = {};
        const appSpec = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
        const fakeSignals = {
            watch(iface) {
                watched[iface] = (watched[iface] || 0) + 1;
                return Promise.resolve({
                    iface,
                    available: true,
                    shutdown() {
                        shutdownCounts[iface] = (shutdownCounts[iface] || 0) + 1;
                        return Promise.resolve();
                    },
                });
            },
        };
        const settingsValues = {
            enabled: true,
            demo: 'off',
            displayTarget: 'both',
            hudHeadway: 'full',
            cabinTempDisplay: true,
            widgetMedia: true,
            widgetTrip: true,
        };
        const demandHub = new SignalHub({
            log: { info: () => {}, warn: () => {}, error: () => {} },
            spec: appSpec,
            settings: { values: settingsValues, get: (k) => settingsValues[k] },
            signals: fakeSignals,
        }, { noDiag: true, ipcDir: path.join(os.tmpdir(), 'no-ipc-demand-' + process.pid) });

        demandHub.start();
        await new Promise((res) => setTimeout(res, 25));
        assert.strictEqual(demandHub.activeWatchers().gapAhead, true);
        assert.strictEqual(demandHub.activeWatchers().climate, true);
        assert.strictEqual(demandHub.activeWatchers().climateMaster, true);
        assert.strictEqual(demandHub.activeWatchers().media, true);
        assert.strictEqual(watched['de.bmw.dass.GapVehicleAhead'], 1);
        assert.strictEqual(watched['de.bmw.infotainment.climate.Climate2'], 1);
        assert.strictEqual(watched['de.bmw.infotainment.climate.climatemaster.ClimateMaster'], 1);

        // Turn OFF hudHeadway, cabinTempDisplay, and right-wing widgets -> proxies MUST shut down!
        settingsValues.hudHeadway = 'off';
        settingsValues.cabinTempDisplay = false;
        settingsValues.widgetMedia = false;
        settingsValues.widgetTrip = false;
        demandHub.syncDemand(settingsValues, { diagVisible: false });
        await new Promise((res) => setTimeout(res, 25));
        assert.strictEqual(demandHub.activeWatchers().gapAhead, false);
        assert.strictEqual(demandHub.activeWatchers().climate, false);
        assert.strictEqual(demandHub.activeWatchers().climateMaster, false);
        assert.strictEqual(demandHub.activeWatchers().media, false);
        assert.strictEqual(shutdownCounts['de.bmw.dass.GapVehicleAhead'], 1, 'GapVehicleAhead proxy must be shut down when hudHeadway=off');
        assert.strictEqual(shutdownCounts['de.bmw.infotainment.climate.Climate2'], 1, 'Climate2 proxy must be shut down when cabinTempDisplay=false');
        assert.strictEqual(shutdownCounts['de.bmw.infotainment.climate.climatemaster.ClimateMaster'], 1, 'ClimateMaster proxy must be shut down when cabinTempDisplay=false');
        assert.strictEqual(shutdownCounts['de.bmw.infotainment.hmi.hmimediastate.HmiMediaState'], 1, 'HmiMediaState proxy must be shut down when right widgets are off');

        // Re-enabling hudHeadway & cabinTempDisplay cleanly re-subscribes
        settingsValues.hudHeadway = 'compact';
        settingsValues.cabinTempDisplay = true;
        demandHub.syncDemand(settingsValues, { diagVisible: false });
        await new Promise((res) => setTimeout(res, 25));
        assert.strictEqual(demandHub.activeWatchers().gapAhead, true);
        assert.strictEqual(demandHub.activeWatchers().climate, true);
        assert.strictEqual(demandHub.activeWatchers().climateMaster, true);
        assert.strictEqual(watched['de.bmw.dass.GapVehicleAhead'], 2);
        assert.strictEqual(watched['de.bmw.infotainment.climate.Climate2'], 2);
        assert.strictEqual(watched['de.bmw.infotainment.climate.climatemaster.ClimateMaster'], 2);

        demandHub.stop();
    });

    /* 18. BMW MainApp & MGU Store OAP Package Manifest + JS Entry Validation */
    await test('OAP package manifest, RHMI XML/JSON parity, and JS entry validation (MainApp installer rules)', () => {
        const srcDir = path.join(ROOT, 'dist', 'cluster_metrics', 'source');
        assert(fs.existsSync(srcDir), 'dist/cluster_metrics/source must exist (run npm run build first)');

        const appSpec = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
        const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'));

        // MainApp package.json manifest schema & JS entry point requirements
        assert.strictEqual(pkg.name, 'cluster_metrics');
        assert.strictEqual(pkg.version, appSpec.version);
        assert(/^\d+\.\d+\.\d+$/.test(pkg.version), 'package.json version must be strict x.y.z semver');
        assert.strictEqual(pkg.main, 'javascript/app.js', 'package.json MUST declare main: "javascript/app.js" for MainApp');
        assert(fs.statSync(path.join(srcDir, pkg.main)).isFile(), 'package.json main entry file must exist in package');
        assert.strictEqual(pkg.private, false, 'package.json must set private: false');
        assert(typeof pkg.author === 'string' && pkg.author.length > 0, 'package.json must carry string author');
        assert(typeof pkg.license === 'string' && pkg.license.length > 0, 'package.json must carry string license');
        assert(pkg.engines && typeof pkg.engines.node === 'string', 'package.json must carry engines.node');
        assert.strictEqual(pkg.mguAppStartType, 'autostart', 'cluster_metrics must declare mguAppStartType: "autostart"');
        assert.deepStrictEqual(pkg.mguHmi, ['ID7']);

        const oap = pkg.oapAppSettings;
        assert(oap && typeof oap === 'object', 'oapAppSettings must be present');
        assert.strictEqual(oap.someipManifest, 'manifest.json');
        assert(/^[A-Z0-9]{4}$/.test(oap.loggingId), 'oapAppSettings.loggingId must be 4 uppercase chars');

        // permissions.json & npm-shrinkwrap.json
        const perms = JSON.parse(fs.readFileSync(path.join(srcDir, 'permissions.json'), 'utf8'));
        assert(Array.isArray(perms.masterAccessTable) && Array.isArray(perms.masterRegistrationTable),
            'permissions.json must define masterAccessTable and masterRegistrationTable');
        const shrink = JSON.parse(fs.readFileSync(path.join(srcDir, 'npm-shrinkwrap.json'), 'utf8'));
        assert.strictEqual(shrink.name, pkg.name);
        assert.strictEqual(shrink.version, pkg.version);

        // SOME/IP manifest.json (+ local G30 interface catalog check when available)
        const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
        assert(manifest.proxies && typeof manifest.proxies === 'object');
        assert(manifest.services && typeof manifest.services === 'object');

        const g30CatalogPath = path.join(ROOT, 'design', 'resources', 'g30-someip-interfaces.json');
        if (fs.existsSync(g30CatalogPath)) {
            const rawCat = fs.readFileSync(g30CatalogPath, 'utf8');
            const db = JSON.parse(rawCat.slice(rawCat.indexOf('{')));
            const problems = [];
            const members = (ifData, key, depth) => {
                const base = ifData.extends && depth < 20 ? db.interfaces[ifData.extends] : null;
                return Object.assign({}, base ? members(base, key, depth + 1) : {}, ifData[key]);
            };
            Object.keys(manifest.proxies).forEach((id) => {
                const ifData = db.interfaces[id];
                if (!ifData) { problems.push(id + ': missing interface'); return; }
                const cfg = manifest.proxies[id];
                if (cfg === '*') return;
                const inst = cfg.instances;
                if (inst && inst !== '*') {
                    (Array.isArray(inst) ? inst : [inst]).forEach((n) => {
                        if (!/\$\{userId\}/.test(n) && !(db.instanceIDs[id] && db.instanceIDs[id][n])) {
                            problems.push(id + ': missing instance ' + n);
                        }
                    });
                }
                const fields = members(ifData, 'fields', 0);
                Object.keys(cfg.attributes || {}).forEach((fn) => {
                    const fd = fields[fn];
                    if (!fd) { problems.push(id + ': missing field ' + fn); return; }
                    const mode = String(cfg.attributes[fn]);
                    [['r', 'getter'], ['w', 'setter'], ['s', 'notifier']].forEach((pair) => {
                        if (mode.indexOf(pair[0]) >= 0 && !fd[pair[1]]) {
                            problems.push(id + '.' + fn + ': missing ' + pair[1]);
                        }
                    });
                });
                const methods = members(ifData, 'methods', 0);
                (cfg.methods || []).forEach((mn) => { if (!methods[mn]) problems.push(id + ': missing method ' + mn); });
                const events = members(ifData, 'events', 0);
                (cfg.broadcasts || []).forEach((bn) => { if (!events[bn]) problems.push(id + ': missing broadcast ' + bn); });
            });
            assert.deepStrictEqual(problems, [], 'SOME/IP manifest problems against G30 catalog: ' + problems.join('; '));
        }

        // RHMI application.xml <-> uiDescription.json parity
        const id7Dir = path.join(srcDir, 'rhmiData', 'uiDescriptions', 'ID7');
        const xml = fs.readFileSync(path.join(id7Dir, 'application.xml'), 'utf8');
        const uiDesc = JSON.parse(fs.readFileSync(path.join(id7Dir, 'uiDescription.json'), 'utf8'));
        assert.strictEqual(uiDesc.schemaVersion, '1.3.0');
        assert(xml.indexOf('<property id="1"') < 0, 'application.xml should not emit custom property id="1" on stock widgets');

        // Compile-check every packaged .js file as a CommonJS module (as oap_link.nodeCheck does)
        const walkJs = (dir, acc) => {
            fs.readdirSync(dir).forEach((n) => {
                const p = path.join(dir, n);
                if (fs.statSync(p).isDirectory()) walkJs(p, acc);
                else if (n.endsWith('.js')) acc.push(p);
            });
            return acc;
        };
        const packagedJs = walkJs(srcDir, []);
        assert(packagedJs.length >= 20);
        packagedJs.forEach((f) => {
            const text = fs.readFileSync(f, 'utf8');
            new vm.Script(Module.wrap(text), { filename: f });
        });
    });

    /* 19. v0.8.2: Cabin Temp Option A + HVAC Mode Color Coding & Non-Redundant Charging Widget */
    await test('v0.8.2: Cabin Temp Option A + HVAC color coding (AC blue, Fan white, Heating orange) & de-duplicated Charging widget', () => {
        // A. HVAC thermal mode classifier (Climate2 + ClimateMaster)
        let hs = createHvacState();
        assert.strictEqual(resolveHvacMode(hs, 22.0), null, 'empty HVAC state must return null (white fallback)');

        // Summer AC cooling: ClimateMaster ON + AC ON + target 20C while cabin is 25C
        feedHvacClimateMaster(hs, 'statusClimateSystemOn', [{ operationZone: 'DRIVER', airConditioningOn: true }]);
        feedHvacClimateMaster(hs, 'statusAirCondAC', [{ operationZone: 'DRIVER', acButton: true }]);
        feedHvacClimateMaster(hs, 'statusTemperature', [{ operationZone: 'DRIVER', targetTemperature: 20.0 }]);
        assert.strictEqual(resolveHvacMode(hs, 25.0), 'cooling');

        // Winter AUTO cabin warming: AC dehumidifier button stays ON, but cabin is 15.5C and target is 21.5C -> MUST be 'heating' (orange)!
        feedHvacClimateMaster(hs, 'statusTemperature', [{ operationZone: 'DRIVER', targetTemperature: 21.5 }]);
        assert.strictEqual(resolveHvacMode(hs, 15.5), 'heating', 'winter AUTO heating with AC dehumidifier on must classify as heating');

        // Fan-only ventilation: AC button OFF, target near cabin temp -> 'fan' (white)
        feedHvacClimateMaster(hs, 'statusAirCondAC', [{ operationZone: 'DRIVER', acButton: false }]);
        feedHvacClimate2(hs, 'statusAirConditionDRStatus', { statusBlowerSettingDR: 4, statusAirInjectionManifoldProgramDR: 'VENT' });
        assert.strictEqual(resolveHvacMode(hs, 21.2), 'fan');

        // Front Defrost / HI override -> 'heating'; MAX AC override -> 'cooling'; System OFF -> 'off'
        feedHvacClimate2(hs, 'statusACFrontFunctions', { statusDefrost: 'DEFROST_EIN' });
        assert.strictEqual(resolveHvacMode(hs, 21.2), 'heating');
        feedHvacClimate2(hs, 'statusACFrontFunctions', { statusDefrost: 'DEFROST_AUS' });
        feedHvacClimateMaster(hs, 'statusAirCondMaxAC', [{ operationZone: 'DRIVER', maxAirConditioning: true }]);
        assert.strictEqual(resolveHvacMode(hs, 21.2), 'cooling');
        feedHvacClimateMaster(hs, 'statusClimateSystemOn', [{ operationZone: 'DRIVER', airConditioningOn: false }]);
        assert.strictEqual(resolveHvacMode(hs, 21.2), 'off');

        // B. Cabin Temp Option A pixel colors (Blue for cooling, White for fan/unknown, Orange for heating)
        assert.strictEqual(cabinHvacPalette('cooling').val, '#5bc8ff');
        assert.strictEqual(cabinHvacPalette('heating').val, '#ff9f43');
        assert.strictEqual(cabinHvacPalette('fan').val, '#f2f5fa');
        assert.strictEqual(cabinHvacPalette(null).val, '#f2f5fa');

        const r = new OverlayRenderer({ allowPanel: true });
        const countValuePixels = (cv) => {
            let blue = 0, orange = 0, white = 0;
            for (let y = 24; y <= 45; y++) {
                for (let x = 4; x < cv.w - 2; x++) {
                    const o = (y * cv.w + x) * 4;
                    const pr = cv.d[o], pg = cv.d[o + 1], pb = cv.d[o + 2], pa = cv.d[o + 3];
                    if (pa < 200) continue;
                    if (pb > pr + 60 && pg > 140) blue++;
                    else if (pr > pb + 90 && pg > 110) orange++;
                    else if (pr > 220 && pg > 220 && pb > 220) white++;
                }
            }
            return { blue, orange, white };
        };

        const baseModel = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: {
                speedKmh: 72, rpm: 0, hvKw: 12.0, hvVolts: 364, soc: 68, soc12: 86, v12: 14.0,
                cabinTempC: 22.0, cabinHvacMode: 'cooling', stage: 'D', program: 'D', gear: 6,
            },
        };

        r.render(baseModel, { enabled: true }, 7000);
        const pxCool = countValuePixels(r.layers.cabin_temp.cv);
        assert(pxCool.blue > 40 && pxCool.orange === 0, 'AC cooling must render blue cabin temp value pixels, got ' + JSON.stringify(pxCool));

        baseModel.telemetry.cabinHvacMode = 'heating';
        r.render(baseModel, { enabled: true }, 7100);
        const pxHeat = countValuePixels(r.layers.cabin_temp.cv);
        assert(pxHeat.orange > 40 && pxHeat.blue === 0, 'Heating must render orange cabin temp value pixels, got ' + JSON.stringify(pxHeat));

        baseModel.telemetry.cabinHvacMode = 'fan';
        r.render(baseModel, { enabled: true }, 7200);
        const pxFan = countValuePixels(r.layers.cabin_temp.cv);
        assert(pxFan.white > 40 && pxFan.blue === 0 && pxFan.orange === 0, 'Fan-only must render white cabin temp value pixels, got ' + JSON.stringify(pxFan));

        // C. Session addedKwh integration & Non-Redundant Charging Widget clearance above world y = 550
        const chgRaw = { wirePlugged: true, plugLocked: true, phases: 1, lscStatus: 'active', endHour: 16, endMin: 35, residualMin: 129, targetSoc: 100 };
        let cState = computeChargingState(chgRaw, { speedKmh: 0, rpm: 0, hvKw: -3.6, soc: 70, stage: 'P' }, 10000);
        assert.strictEqual(cState.active, true);
        assert.strictEqual(cState.plugLocked, true);
        assert.strictEqual(cState.phases, 1);
        // 10 seconds later at 3.6 kW = +0.01 kWh; plus SoC rising 70 -> 80% (~1.08 kWh)
        cState = computeChargingState(chgRaw, { speedKmh: 0, rpm: 0, hvKw: -3.6, soc: 80, stage: 'P' }, 20000);
        assert(cState.addedKwh > 1.0, 'session addedKwh must track charging energy, got ' + cState.addedKwh);

        const chgModel = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: null, fuelLPer100km: null, isDfco: false },
            telemetry: {
                speedKmh: 0, rpm: 0, hvKw: -3.6, hvVolts: 396, battTempC: 24.5, soc: 80, soc12: 91,
                cabinTempC: 21.0, cabinHvacMode: null, stage: 'P', program: 'D', gear: 0,
                charging: cState,
            },
        };
        r.render(chgModel, { enabled: true }, 20100);
        const rwCv = r.layers.right_widget.cv;
        let heroClockPixels = 0;
        let lowerGridPixels = 0;
        let belowSafeZonePixels = 0;
        for (let y = 170; y <= 232; y++) {
            for (let x = 60; x <= 312; x++) {
                if (rwCv.d[(y * rwCv.w + x) * 4 + 3] > 200) heroClockPixels++;
            }
        }
        for (let y = 298; y <= 416; y++) {
            for (let x = 28; x <= 346; x++) {
                if (rwCv.d[(y * rwCv.w + x) * 4 + 3] > 200) lowerGridPixels++;
            }
        }
        // World y = 550 corresponds to ry = 550 - 88 = 462; verify ry >= 428 has ZERO pixels!
        for (let y = 428; y < rwCv.h; y++) {
            for (let x = 0; x < rwCv.w; x++) {
                if (rwCv.d[(y * rwCv.w + x) * 4 + 3] > 0) belowSafeZonePixels++;
            }
        }
        assert(heroClockPixels > 800, 'enlarged 68px finish clock must paint substantial hero pixels, got ' + heroClockPixels);
        assert(lowerGridPixels > 500, 'non-redundant 2x2 charging grid must populate lower deck, got ' + lowerGridPixels);
        assert.strictEqual(belowSafeZonePixels, 0, 'charging widget must leave ry >= 428 (world y >= 516) 100% clear of stock range labels');

        // Unplugging resets session addedKwh cleanly
        chgRaw.wirePlugged = false;
        chgRaw.plugLocked = false;
        chgRaw.lscStatus = 'done';
        const cUnplugged = computeChargingState(chgRaw, { speedKmh: 0, rpm: 0, hvKw: 0, soc: 80, stage: 'P' }, 25000);
        assert.strictEqual(cUnplugged.active, false);
        assert.strictEqual(cUnplugged.addedKwh, null);
    });

    /* 20. v0.8.3: Local Timezone Finish Clock, Smoothed Charging ETA, BC Cycling While Charging, Larger Media & Alert Preview */
    await test('v0.8.3: Local timezone Est. Finish (PST vs UTC), smoothed ETA, BC cycling while charging & alert preview', () => {
        // A. Timezone offset from car clock (13:44 PST when UTC is 21:44 -> -480 min)
        const utc2144 = Date.UTC(2026, 10, 19, 21, 44, 0); // Nov 19, 2026 21:44 UTC = 13:44 PST
        assert.strictEqual(calcCarClockOffsetMin(13, 44, utc2144), -480);
        assert.strictEqual(calcCarClockOffsetMin(22, 44, utc2144), 60);

        // With 85 min remaining at 13:44 PST (21:44 UTC), Est. Finish MUST be 15:09 (NEVER 23:09 UTC!)
        const tzRaw = { wirePlugged: true, plugLocked: true, lscStatus: 'active', residualMin: 85, targetSoc: 100 };
        const tzState = computeChargingState(tzRaw, { speedKmh: 0, rpm: 0, hvKw: -2.8, soc: 63, stage: 'P', localOffsetMin: -480 }, utc2144);
        assert.strictEqual(tzState.remainText, '1h 25m');
        assert.strictEqual(tzState.finishTimeText, '15:09', 'Est. Finish must use car local timezone (15:09 PST, not 23:09 UTC)');

        // B. Fallback ETA smoothing: brief 1-second dip from 2.8 kW -> 1.4 kW must NOT double remainMin!
        const smRaw = { wirePlugged: true, lscStatus: 'active', targetSoc: 100 };
        const s0 = computeChargingState(smRaw, { speedKmh: 0, rpm: 0, hvKw: -2.8, soc: 63, stage: 'P', localOffsetMin: -480 }, utc2144);
        const s1 = computeChargingState(smRaw, { speedKmh: 0, rpm: 0, hvKw: -1.4, soc: 63, stage: 'P', localOffsetMin: -480 }, utc2144 + 1000);
        assert(Math.abs(s1.remainMin - s0.remainMin) <= 4,
            'brief 1s kW dip must be smoothed in ETA (s0=' + s0.remainMin + ', s1=' + s1.remainMin + ')');

        // C. BC button cycles Charging -> Media -> Trip -> Off -> Charging while plugged in!
        const r = new OverlayRenderer({ allowPanel: true });
        const model = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: null, fuelLPer100km: null, isDfco: false },
            telemetry: {
                speedKmh: 0, rpm: 0, hvKw: -2.8, hvVolts: 396, battTempC: 24.0, soc: 72, soc12: 91,
                cabinTempC: 20.0, stage: 'P', program: 'D', gear: 0,
                media: { active: true, playing: true, title: 'Finally, a Vaccine for...', artist: 'The Daily - Subscriber Feed', elapsedSec: 120, totalSec: 723, remainSec: 603, frac: 0.17, bcStep: 5 },
                charging: tzState,
            },
        };
        const opts = { enabled: true, widgetMedia: true, widgetTrip: true };
        r.render(model, opts, 1000);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'charging', 'charging must auto-open on charging widget');
        model.telemetry.media.bcStep = 6;
        r.render(model, opts, 1200);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'media', '1st BC click while charging must switch to media');
        model.telemetry.media.bcStep = 7;
        r.render(model, opts, 1400);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'trip', '2nd BC click while charging must switch to trip');
        model.telemetry.media.bcStep = 8;
        r.render(model, opts, 1600);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'off', '3rd BC click while charging must hide right widget');
        model.telemetry.media.bcStep = 9;
        r.render(model, opts, 1800);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'charging', '4th BC click must cycle back to charging');

        // D. Smart alert preview auto-switches right_widget to 'tpms' & HUD (and NEVER draws tiny text on brake_rail)
        model.previewAlert = {
            id: 'tpms', severity: 'red', corner: 'FL', seq: 1,
            label: 'FL 21psi', hudText: 'Tire Pressure Critical', title: 'TIRE FLAT - CRITICAL',
            detail: 'Front Left: 21 psi (Target 35 psi)',
        };
        r.render(model, opts, 2000);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'tpms', 'previewAlert must auto-switch right_widget to tpms alert view');
        assert.strictEqual(r.layers.brake_rail.visible, false, 'brake_rail must stay hidden in Park without tiny alert text');
    });

    /* 21. v0.8.5: Highway Shields (US-101, I-880, CA-85) in HUD Nav + Calibrated Right-Wing Gauge Backdrop */
    await test('v0.8.5: HUD highway shield extraction (US-101, I-880, CA-85), vector shield rendering & calibrated gauge backdrop', () => {
        const { decodeDescription } = require(path.join(APP_DIR, 'nav_tracker'));
        const { drawHudRoadBanner, ROAD_W, ROAD_H } = require(path.join(APP_DIR, 'hud_nav_renderer'));
        const { buildStockBackdrop } = require(path.join(APP_DIR, 'image_decode'));
        const { Canvas } = require('./kit/canvas');

        // A. Text extraction: Exit + US-101
        const d1 = decodeDescription({ description: { elements: [{ text: 'Exit 399A US-101 N Bayshore Fwy' }] } }, true);
        assert.strictEqual(d1.exitBadge, '399A');
        assert.deepStrictEqual(d1.shields, [{ kind: 'us', num: '101' }]);
        assert.strictEqual(d1.road, 'N Bayshore Fwy');

        // B. Text extraction: Interstate + State Route interchange
        const d2 = decodeDescription({ description: { elements: [{ text: 'I-880 N / CA-237 W' }] } }, false);
        assert.deepStrictEqual(d2.shields, [{ kind: 'interstate', num: '880' }, { kind: 'state', num: '237' }]);

        // C. Native BMW el.icon objects (Exit icon + Interstate icon + street text)
        const d3 = decodeDescription({
            description: {
                elements: [
                    { icon: { text: '12B' } },
                    { icon: { type: 'INTERSTATE', text: '280' } },
                    { text: 'North / Wolfe Rd' },
                ],
            },
        }, true);
        assert.strictEqual(d3.exitBadge, '12B');
        assert.deepStrictEqual(d3.shields, [{ kind: 'interstate', num: '280' }]);
        assert.strictEqual(d3.road, 'North / Wolfe Rd');

        // D. Must NOT false-trigger on plain street addresses
        const d4 = decodeDescription({ description: { elements: [{ text: '101 Main St' }] } }, false);
        assert.deepStrictEqual(d4.shields, []);
        assert.strictEqual(d4.road, '101 Main St');

        // E. Vector shield rendering produces red/blue Interstate pixels + white US shield pixels + green State pixels
        const cv = new Canvas(ROAD_W, ROAD_H);
        const ok = drawHudRoadBanner(cv, {
            exitBadge: '399A',
            shields: [{ kind: 'interstate', num: '880' }, { kind: 'us', num: '101' }],
            road: 'N Bayshore Fwy',
        });
        assert.strictEqual(ok, true);
        let redPx = 0, bluePx = 0, greenPx = 0, whitePx = 0;
        for (let i = 0; i < cv.d.length; i += 4) {
            if (cv.d[i + 3] < 200) continue;
            const r0 = cv.d[i], g0 = cv.d[i + 1], b0 = cv.d[i + 2];
            if (r0 > 180 && g0 < 80 && b0 < 80) redPx++;
            else if (b0 > 180 && r0 < 70 && g0 < 120) bluePx++;
            else if (g0 > 110 && r0 < 60 && b0 < 90) greenPx++;
            else if (r0 > 220 && g0 > 220 && b0 > 220) whitePx++;
        }
        assert(redPx > 40 && bluePx > 120, 'Interstate shield must paint red crown + royal blue body (red=' + redPx + ', blue=' + bluePx + ')');
        assert(greenPx > 120, 'Exit badge must paint green body');
        assert(whitePx > 200, 'US shield + road text must paint bright white pixels');

        // F. Calibrated G30 right-wing backdrop covers top-left eyebrow handle (1265, 104),
        //    stays strictly inside outer bezel at (1765, 355), and clears bottom-left map at (1400, 600).
        const cov = { w: 144, h: 144, d: Buffer.alloc(144 * 144 * 4, 220) };
        const bg = buildStockBackdrop(cov, 536, 536, { ox: 1252, oy: 88, vx: 196, vy: 218 });
        const alphaAt = (wx, wy) => bg[((wy - 88) * 536 + (wx - 1252)) * 4 + 3];
        assert(alphaAt(1275, 105) > 20, 'backdrop must reach top-left extended eyebrow handle at (1275, 105)');
        assert.strictEqual(alphaAt(1765, 355), 0, 'backdrop must NOT spill past outer-right bezel at (1765, 355)');
        assert.strictEqual(alphaAt(1400, 600), 0, 'backdrop must NOT spill onto bottom-left map at (1400, 600)');
        assert(alphaAt(1560, 610) > 20, 'backdrop must reach bottom-right gauge curve at (1560, 610)');
    });

    /* 22. v0.8.6: Two-Level Stacked HUD Lane Guidance & Promotion Slide-Down Animation */
    await test('v0.8.6: Two-level stacked HUD lane guidance (rows[0]+rows[1]), dtd ordering & promotion animation', () => {
        const { NavTracker, decodeLanes } = require(path.join(APP_DIR, 'nav_tracker'));
        const { drawHudNav, hudNavKey, NW, NH } = require(path.join(APP_DIR, 'hud_nav_renderer'));
        const { Canvas } = require('./kit/canvas');

        const rowImmediate = {
            uid: '10',
            distanceToDestination: 5200,
            lanes: [
                { directionToFollow: 'NONE', otherDirections: [], isHighlighted: false, additionalLaneInfo: 'HOV' },
                { directionToFollow: 'STRAIGHT_ON', otherDirections: [], isHighlighted: true, additionalLaneInfo: 'NONE' },
                { directionToFollow: 'STRAIGHT_ON', otherDirections: [], isHighlighted: true, additionalLaneInfo: 'NONE' },
                { directionToFollow: 'STRAIGHT_ON', otherDirections: ['RIGHT'], isHighlighted: true, additionalLaneInfo: 'NONE' },
            ],
            laneMarkers: ['SOLID', 'SOLID', 'DASHED', 'DASHED', 'SOLID'],
            recommendedCarPositionLaneIndex: 2,
        };
        const rowUpcoming = {
            uid: '11',
            distanceToDestination: 4700,
            lanes: [
                { directionToFollow: 'NONE', otherDirections: ['STRAIGHT_ON'], isHighlighted: false, additionalLaneInfo: 'NONE' },
                { directionToFollow: 'NONE', otherDirections: ['STRAIGHT_ON'], isHighlighted: false, additionalLaneInfo: 'NONE' },
                { directionToFollow: 'SLIGHT_RIGHT', otherDirections: [], isHighlighted: true, additionalLaneInfo: 'NONE' },
                { directionToFollow: 'RIGHT', otherDirections: [], isHighlighted: true, additionalLaneInfo: 'NONE' },
            ],
            laneMarkers: ['SOLID', 'DASHED', 'DASHED', 'DASHED', 'SOLID'],
            recommendedCarPositionLaneIndex: 3,
        };

        // A. Multi-row decoding self-orders by distanceToDestination (larger dtd = immediate lower row)
        const decReversed = decodeLanes({ rows: [rowUpcoming, rowImmediate] });
        assert(decReversed && decReversed.uid === '10' && decReversed.next && decReversed.next.uid === '11',
            'decodeLanes must place larger dtd row in primary lower slot and smaller dtd row in upper next slot');

        // B. NavTracker tracks 2 stacked rows and fires promotion animation when upper row promotes into lower row
        const nt = new NavTracker({ crStatusPath: '/nonexistent/cr', wazeStatusPath: '/nonexistent/woc' });
        nt.feedField('guidance', 'guidanceState', 'ACTIVE', 1000);
        nt.feedField('guidance', 'conclusiveDart', {
            maneuver: {
                branch: {
                    branchType: 'HIGHWAY_OUT_RIGHT',
                    formattedDistance: { distance: '0.4', unit: 'MILE_US' },
                    description: { elements: [{ text: 'Exit 399A US-101 N Bayshore Fwy' }] },
                },
            },
        }, 1050);
        nt.feedField('guidance', 'currentLaneGuiding', { rows: [rowImmediate, rowUpcoming] }, 1100);
        const snapStacked = nt.snapshot(20000, 1150);
        assert.strictEqual(snapStacked.hasStackedLanes, true);
        assert.strictEqual(snapStacked.laneAnimating, false);
        assert(snapStacked.summary.indexOf('[4+4 lanes]') >= 0, 'summary should note stacked lane counts, got ' + snapStacked.summary);

        // Drive past first split: rowImmediate disappears, rowUpcoming promotes to rows[0]!
        nt.feedField('guidance', 'currentLaneGuiding', { rows: [rowUpcoming] }, 2000);
        const snapAnimMid = nt.snapshot(20200, 2210);
        assert.strictEqual(snapAnimMid.laneAnimating, true, 'promotion must trigger laneAnimating=true');
        assert(snapAnimMid.show.lanes.anim && snapAnimMid.show.lanes.anim.t > 0.4 && snapAnimMid.show.lanes.anim.t < 0.6);
        assert(snapAnimMid.show.lanes.anim.droppedRow && snapAnimMid.show.lanes.anim.droppedRow.lanes.length === 4);

        // After 420 ms, promotion animation finishes cleanly
        const snapAnimDone = nt.snapshot(20600, 2500);
        assert.strictEqual(snapAnimDone.laneAnimating, false, 'promotion animation must finish cleanly after 420ms');
        assert.strictEqual(snapAnimDone.hasStackedLanes, false);

        // C. Stacked renderer paints both upper tucked tier (y=137..167) and lower primary tier (y=175..225)
        const cvStacked = new Canvas(NW, NH);
        drawHudNav(cvStacked, snapStacked.show, { hideRoad: true });
        let upperLit = 0, lowerLit = 0;
        for (let py = 136; py <= 167; py++) {
            for (let px = 20; px < NW - 20; px++) {
                if (cvStacked.d[(py * NW + px) * 4 + 3] > 80) upperLit++;
            }
        }
        for (let py = 175; py <= 226; py++) {
            for (let px = 20; px < NW - 20; px++) {
                if (cvStacked.d[(py * NW + px) * 4 + 3] > 140) lowerLit++;
            }
        }
        assert(upperLit > 80, 'upper tucked lane row must render visible pixels (got ' + upperLit + ')');
        assert(lowerLit > 200, 'lower primary lane row must render visible pixels (got ' + lowerLit + ')');

        // D. Animation frames produce distinct hudNavKey values & render cleanly
        const kMid = hudNavKey(snapAnimMid.show);
        const kDone = hudNavKey(snapAnimDone.show);
        assert.notStrictEqual(kMid, kDone, 'mid-animation and steady-state must produce distinct hudNavKey');
        const cvAnim = new Canvas(NW, NH);
        drawHudNav(cvAnim, snapAnimMid.show, { hideRoad: true });
        assert(cvAnim.d.some((v, idx) => idx % 4 === 3 && v > 120), 'mid-animation frame must render visible pixels');
    });

    /* 23. Timezone UTC-1.5 Fix (KombiIF/AutoTime/HMIContext), Right-Wing TPMS+Alert Auto-Switch & BC Dismiss, and Stock BMW TTF */
    await test('Timezone UTC-1.5 fix (17:36 PST + 2h 3m = 19:39), Right-Wing TPMS/Alert widget + BC HUD dismiss & BMW TTF rasterizer', () => {
        const {
            calcAutoTimeOffsetMin, calcKombiShowTimeOffsetMin, parseHmiTimeZoneOffsetMin, computeChargingState,
        } = require(path.join(APP_DIR, 'signals'));
        const { detectAnomaly } = require(path.join(APP_DIR, 'vehicle_profile'));
        const { parseTtf, bakeSizeAtlas } = require(path.join(APP_DIR, 'bmw_font'));

        // A. Exact reproduction & fix of user's 17:36 PST (01:36 UTC) + 2h 03m remaining bug:
        //    - Uninitialized AutoTime.current { year: 0, month: 0, day: 0, hour: 0, minute: 0 } MUST return null (NEVER -90 / UTC-1.5!)
        const utc0136 = Date.UTC(2026, 10, 22, 1, 36, 10); // Nov 21, 2026 17:36:10 PST = Nov 22, 2026 01:36:10 UTC
        assert.strictEqual(
            calcAutoTimeOffsetMin({ time: { hour: 0, minute: 0, second: 0 }, date: { year: 0, month: 0, day: 0 } }, utc0136),
            null,
            'uninitialized zero AutoTime.current struct must NEVER produce UTC-1.5 (-90 min)'
        );
        assert.strictEqual(
            calcKombiShowTimeOffsetMin({ displayHour: 255, displayMinute: 255, displayDateYear: 65535, statusDisplayClockTimeDate: 15 }, utc0136),
            null,
            'uninitialized 0xFF KombiIF.statusShowTimeDate struct must return null'
        );

        // Valid KombiIF.statusShowTimeDate (17:36 on 2026-11-21) -> -480 min (UTC-8)
        assert.strictEqual(
            calcKombiShowTimeOffsetMin({
                displayDateYear: 2026, displayDateMonth: 11, displayDateDay: 21,
                displayHour: 17, displayMinute: 36, displaySecond: 10, statusDisplayClockTimeDate: 1,
            }, utc0136),
            -480
        );
        // Valid AutoTime.current (17:36 on 2026-11-21) -> -480 min (UTC-8)
        assert.strictEqual(
            calcAutoTimeOffsetMin({
                date: { year: 2026, month: 11, day: 21 },
                time: { hour: 17, minute: 36, second: 10 },
            }, utc0136),
            -480
        );
        // Valid HMIContext.currentTimeZone (string & numeric enum)
        assert.strictEqual(parseHmiTimeZoneOffsetMin('UTC_MINUS_0800_1'), -480);
        assert.strictEqual(parseHmiTimeZoneOffsetMin(4), -480);
        assert.strictEqual(parseHmiTimeZoneOffsetMin('UTC_PLUS_0530'), 330);
        assert.strictEqual(parseHmiTimeZoneOffsetMin(64), 330);
        assert.strictEqual(parseHmiTimeZoneOffsetMin('UNKNOWN'), null);
        assert.strictEqual(parseHmiTimeZoneOffsetMin(0), null);

        // Verify 17:36 PST + 123 min (2h 3m) = 19:39!
        const chg1736 = computeChargingState(
            { wirePlugged: true, plugLocked: true, lscStatus: 'active', residualMin: 123, targetSoc: 100 },
            { speedKmh: 0, rpm: 0, hvKw: -3.5, soc: 44, stage: 'P', localOffsetMin: -480 },
            utc0136
        );
        assert.strictEqual(chg1736.remainText, '2h 3m');
        assert.strictEqual(chg1736.finishTimeText, '19:39', '17:36 PST + 2h 3m must equal 19:39');

        // B. Readable HUD alert strings & detailed Right-Wing TPMS / Alert auto-switch + BC dismissal
        const aState = { _v12LowSince: 0, _soc12LowSince: 0 };
        const aTpms = detectAnomaly({
            tpms: { FL: { pressureBar: 2.05, targetBar: 2.41, tempC: 24 }, FR: { pressureBar: 2.41, targetBar: 2.41, tempC: 24 } },
        }, unitsMod.US_PRESET, aState, 1000);
        assert.strictEqual(aTpms.hudText, 'Tire Pressure Low');
        assert.strictEqual(aTpms.title, 'TIRE PRESSURE LOW');
        assert(aTpms.detail.indexOf('Front Left') >= 0 && aTpms.detail.indexOf('Target 35 psi') >= 0);

        const aGbx = detectAnomaly({ gearboxOilC: 118 }, unitsMod.US_PRESET, aState, 1000);
        assert.strictEqual(aGbx.hudText, 'Gearbox Critical');
        assert.strictEqual(aGbx.severity, 'red');

        detectAnomaly({ v12: 11.5 }, unitsMod.US_PRESET, aState, 1000);
        const aV12 = detectAnomaly({ v12: 11.5 }, unitsMod.US_PRESET, aState, 6500);
        assert.strictEqual(aV12.hudText, '12V Battery Critical');

        // Verify normal 4-wheel TPMS widget + alert auto-switch + BC dismiss (even when bcStep starts at 1!)
        const r = new OverlayRenderer({ allowPanel: true });
        const settingsObj = { enabled: true, widgetMedia: true, widgetTrip: true, widgetTpms: true };
        const m = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.2, fuelLPer100km: null, isDfco: false },
            telemetry: {
                speedKmh: 72, rpm: 0, hvKw: 12.0, soc: 74, stage: 'D', program: 'D', gear: 5, frictionG: 0,
                oilTempC: 90, coolantTempC: 88, v12: 14.1, soc12: 88,
                tpms: {
                    FL: { pressureBar: 2.41, targetBar: 2.41, tempC: 26 },
                    FR: { pressureBar: 2.41, targetBar: 2.41, tempC: 27 },
                    RL: { pressureBar: 2.62, targetBar: 2.62, tempC: 25 },
                    RR: { pressureBar: 2.62, targetBar: 2.62, tempC: 26 },
                },
                media: { active: true, playing: true, title: 'The Daily', artist: 'NYT', bcStep: 2 },
            },
        };
        // Step 2 in ['media', 'trip', 'tpms', 'off'] -> normal 4-wheel 'tpms' view!
        r.render(m, settingsObj, 3000);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'tpms');
        let belowSafe = 0;
        for (let y = 428; y < r.layers.right_widget.cv.h; y++) {
            for (let x = 0; x < r.layers.right_widget.cv.w; x++) {
                if (r.layers.right_widget.cv.d[(y * r.layers.right_widget.cv.w + x) * 4 + 3] > 0) belowSafe++;
            }
        }
        assert.strictEqual(belowSafe, 0, 'normal 4-wheel TPMS widget must keep ry >= 428 clear');

        // Driver is on 'trip' (bcStep = 1), then TPMS Low Alert fires -> auto-switches to 'tpms' + shows HUD alert!
        m.telemetry.media.bcStep = 1;
        r.render(m, settingsObj, 3200);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'trip');

        m.profile.alert = aTpms;
        r.render(m, settingsObj, 3400);
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'tpms', 'alert must auto-switch right_widget to tpms alert view');
        assert(r.lastSummary.activeAlert && r.lastSummary.activeAlert.hudText === 'Tire Pressure Low');
        let hudRow3Lit = 0;
        for (let y = 74; y < 99; y++) {
            for (let x = 4; x < 240; x++) {
                if (r.layers.hud_main.cv.d[(y * r.layers.hud_main.cv.w + x) * 4 + 3] > 180) hudRow3Lit++;
            }
        }
        assert(hudRow3Lit > 120, 'HUD Row 3 must render readable "Tire Pressure Low" message');

        // Driver presses BC once (bcStep 1 -> 2): HUD alert MUST dismiss AND right_widget MUST switch to 'media' (NOT stay on 'tpms'!)
        m.telemetry.media.bcStep = 2;
        r.render(m, settingsObj, 3600);
        assert.strictEqual(r.lastSummary.alertDismissed, true, 'BC press must dismiss active alert');
        assert.strictEqual(r.lastSummary.activeAlert, null, 'HUD activeAlert must clear on BC press');
        assert.strictEqual(r.lastSummary.rightWidgetPage, 'media', 'BC dismiss must switch right_widget away from tpms to media');
        let hudRow3AfterDismiss = 0;
        for (let y = 74; y < 99; y++) {
            for (let x = 4; x < 240; x++) {
                if (r.layers.hud_main.cv.d[(y * r.layers.hud_main.cv.w + x) * 4 + 3] > 180) hudRow3AfterDismiss++;
            }
        }
        assert.strictEqual(hudRow3AfterDismiss, 0, 'HUD Row 3 alert text must clear immediately after BC dismiss');

        // C. Stock BMW TrueType rasterizer + CJK NFC & 1:1 vector Gothic check (incl. '季節は次々死んでいく', SC/TC/KR)
        const { cleanMediaText } = require(path.join(APP_DIR, 'media_tracker'));
        const jpFixed = cleanMediaText('季節は次々死んでいく');
        assert.strictEqual(jpFixed, '季節は次々死んでいく', 'cleanMediaText must keep voiced kana (で U+3067) NFC-composed');
        assert.strictEqual(jpFixed.indexOf('\u3099'), -1, 'cleanMediaText must never leave dangling NFD combining dakuten U+3099');
        assert.strictEqual(cleanMediaText('밤편지 - 아이유'), '밤편지 - 아이유', 'cleanMediaText must preserve NFC Korean Hangul');
        assert.strictEqual(cleanMediaText('Caf\u00E9 R\u00E9sum\u00E9'), 'Cafe Resume', 'cleanMediaText must still fold Latin accents');

        const fontsMod = require('./kit/fonts');
        const { getFontStatus } = require(path.join(APP_DIR, 'bmw_font'));
        const fSt = getFontStatus();
        assert(fSt.source === 'bmw_stock_ttf' || fSt.source === 'bundled_vector_sans',
            'font engine must activate 1:1 vector Latin (BMW TTF or bundled Vector Sans), got ' + fSt.source);
        const f42 = fontsMod.get('bold', 42, jpFixed);
        assert.strictEqual(f42.size, 42, 'vector font handle must match exact requested pixel size (1:1 scale, zero bilinear blur)');
        for (const ch of '季節は次々死んでいく七里香周杰伦밤편지') {
            const rg = fontsMod.resolveGlyph(f42, ch.codePointAt(0));
            assert(rg && rg.g && rg.g[2] >= 12 && rg.g[3] >= 12 && rg.font.size === 42, 'vector CJK must rasterize exact 1:1 glyph for ' + ch);
        }

        const localFontRg = path.resolve(ROOT, '..', 'mgu-fonts', 'mnt-dataro-dataro2-hmi-common-font', 'BMWTARG.ttf');
        if (fs.existsSync(localFontRg)) {
            const parsedRg = parseTtf(fs.readFileSync(localFontRg));
            assert(parsedRg && parsedRg.numGlyphs > 200, 'BMWTARG.ttf must parse cleanly');
            const atlas = bakeSizeAtlas(parsedRg, 36, '19:39 Tire Pressure Low', 0.016);
            assert(atlas.atlasW > 64 && atlas.glyphs[57] && atlas.glyphs[57][2] > 10, 'BMWTARG.ttf must rasterize crisp glyphs');
        }
    });

    console.log('\nAll ' + passed + ' tests passed.');
    process.exit(0);
})().catch((err) => {
    console.error('\nTEST FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
});
