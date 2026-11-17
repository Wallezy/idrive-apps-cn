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
const KIT_RT = path.join(ROOT, 'kit', 'runtime');

// Map ./kit/* as build.py copies kit/runtime/* into source/javascript/kit/*
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) {
        return origLoad.call(this, path.join(KIT_RT, req.slice(6)), parent, isMain);
    }
    return origLoad.call(this, req, parent, isMain);
};

const visible = require(path.join(ROOT, 'shared', 'visible'));
const unitsMod = require(path.join(APP_DIR, 'units'));
const { EfficiencyTracker } = require(path.join(APP_DIR, 'efficiency'));
const { VehicleProfile, coldRevCeilingRpm, detectAnomaly } = require(path.join(APP_DIR, 'vehicle_profile'));
const {
    OverlayRenderer, inspectClusterSlotConfig, resolveCornerRightMode, CLUSTER_LAYER_NAMES,
} = require(path.join(APP_DIR, 'overlay_renderer'));
const { ClusterRender } = require(path.join(APP_DIR, 'cluster_render_client'));
const {
    SignalHub, FastKw, computeFrictionBrake, decodeDscPressure, decodeDscPedal, decodeDscRegen, flagActive,
} = require(path.join(APP_DIR, 'signals'));
const { NavTracker, parseHudStatusText, parseWazeHudShowing } = require(path.join(APP_DIR, 'nav_tracker'));
const { NW: HUD_NAV_W, NH: HUD_NAV_H, drawHudNav, hudNavKey } = require(path.join(APP_DIR, 'hud_nav_renderer'));
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

        const ast = { _v12LowSince: 0 };
        assert.strictEqual(detectAnomaly({ tpms: { FL: { pressureBar: 2.4, targetBar: 2.4 } }, gearboxOilC: 85, v12: 14.1 }, unitsMod.US_PRESET, ast, 1000), null);
        const lowTire = detectAnomaly({ tpms: { FL: { pressureBar: 1.9, targetBar: 2.4 } } }, unitsMod.US_PRESET, ast, 2000);
        assert(lowTire && lowTire.id === 'tpms' && lowTire.label.indexOf('FL') === 0);
        const hotGbx = detectAnomaly({ gearboxOilC: 110 }, unitsMod.US_PRESET, ast, 3000);
        assert(hotGbx && hotGbx.id === 'gbox');
        assert.strictEqual(detectAnomaly({ v12: 11.9 }, unitsMod.US_PRESET, ast, 4000), null);
        const lowV12 = detectAnomaly({ v12: 11.9 }, unitsMod.US_PRESET, ast, 10000);
        assert(lowV12 && lowV12.id === 'v12');
    });

    /* 6. Gear Digit Next to D: Clear of KOMBI4 GEAR_WIN (1380..1460) & Baseline Aligned (664..698) */
    await test('Gear digit next to D clears KOMBI4 GEAR_WIN (1380..1460) at all nudges, aligns to D (y=664..698), and hides in S/M/P/R/N', () => {
        const r = new OverlayRenderer({ allowPanel: true });
        const modelBase = {
            units: unitsMod.US_PRESET,
            profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
            efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            telemetry: { speedKmh: 72, rpm: 0, hvKw: 14.2, soc: 68, battTempC: 23.5, oilTempC: 48, coolantTempC: 73, stage: 'D', program: 'D', gear: 2 },
        };

        [-12, 0, 12].forEach((nudgeX) => {
            r.render(modelBase, { enabled: true, gearDisplay: 'next_to_d', clusterNudgeX: nudgeX }, 1000);
            assert.strictEqual(r.layers.gear_d.visible, true);
            const gd = r.layers.gear_d;
            assert(gd.rect.x >= 1461, 'gear_d layer rect must stay strictly right of GEAR_WIN (1380..1460), got x=' + gd.rect.x);
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
                    assert(wx >= 1461 && wx < 1540, 'gear_d pixel outside safe pocket between GEAR_WIN & AMBIENT at wx=' + wx);
                    if (wy < minWy) minWy = wy;
                    if (wy > maxWy) maxWy = wy;
                }
            }
            assert(maxR > 200 && maxG > 200 && maxB > 200, 'gear_d expected bright white text pixels');
            assert(minWy >= 660 && minWy <= 672, 'gear_d top should align with BMW D (~665), got minWy=' + minWy);
            assert(maxWy >= 693 && maxWy <= 700, 'gear_d bottom should align with BMW D (~696), got maxWy=' + maxWy);
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
                name: 'EV drive D5 (idle dim brake rail + large OIL/CL + large SOC %)',
                profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
                telemetry: { speedKmh: 108, rpm: 0, hvKw: 14.2, soc: 72, battTempC: 24, oilTempC: 48, coolantTempC: 73, stage: 'D', program: 'D', gear: 5, frictionG: 0, pureRegen: false },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            },
            {
                name: 'EV pure regen D4 (100% SoC width check + dim brake rail)',
                profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_regen', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
                telemetry: { speedKmh: 54, rpm: 0, hvKw: -26, soc: 100, battTempC: 3, oilTempC: 46, coolantTempC: 70, stage: 'D', program: 'D', gear: 4, frictionG: 0, pureRegen: true },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            },
            {
                name: 'EV blended brake D3 + ABS (low SoC amber + active friction brake segments + g)',
                profile: { vehicleType: 'phev', engineOn: false, mode: 'ev_drive', isEv: true, isCold: false, coldCeilingRpm: null, alert: null },
                telemetry: { speedKmh: 36, rpm: 0, hvKw: -22, soc: 15, battTempC: 42, oilTempC: 54, coolantTempC: 76, stage: 'D', program: 'D', gear: 3, frictionG: 0.42, pureRegen: false, absActive: true },
                efficiency: { evKmPerKwh: 6.1, fuelLPer100km: null, isDfco: false },
            },
            {
                name: 'Gas cold D6 + TPMS alert (triple-digit °F OIL/CL + SOC %)',
                profile: { vehicleType: 'phev', engineOn: true, mode: 'gas_cold', isEv: false, isCold: true, coldCeilingRpm: 3800, alert: { id: 'tpms', severity: 'amber', label: 'FL 28psi' } },
                telemetry: { speedKmh: 98, rpm: 2400, soc: 8, oilTempC: 98, coolantTempC: 96, battTempC: 25, boostBar: 0.4, stage: 'D', program: 'D', gear: 6, frictionG: 0.18, pureRegen: false },
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

            assert.strictEqual(r.lastSummary.cornerRightMode, 'soc', 'PHEV corner_right must default to soc (%)');
            assert.strictEqual(r.layers.below_speed.rect.x, 392, 'below_speed must sit shifted left at x=392 under main speed digits');
            assert.strictEqual(CLUSTER_LAYER_NAMES.length, 5);
            CLUSTER_LAYER_NAMES.forEach((name) => {
                const l = r.layers[name];
                assert(l && l.visible, scenarios[si].name + ' missing ' + name);
                const { x: ox, y: oy, w, h } = l.rect;
                const d = l.cv.d;
                let paintedCount = 0;
                let topHalfPixels = 0;
                let bottomHalfPixels = 0;
                for (let py = 0; py < h; py++) {
                    const wy = oy + py;
                    for (let px = 0; px < w; px++) {
                        const a = d[(py * w + px) * 4 + 3];
                        if (a === 0) continue;
                        paintedCount++;
                        if (py < h / 2) topHalfPixels++; else bottomHalfPixels++;
                        const wx = ox + px;
                        assert(wy > visible.hoodY(wx) + 4, scenarios[si].name + ' ' + name + ' pixel under HOOD at (' + wx + ',' + wy + ')');
                        for (let ki = 0; ki < keepoutBoxes.length; ki++) {
                            assert(!inBox(wx, wy, keepoutBoxes[ki][1]),
                                scenarios[si].name + ' ' + name + ' hits ' + keepoutBoxes[ki][0] + ' at (' + wx + ',' + wy + ')');
                        }
                    }
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

        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'phev' }, {}), 'soc');
        assert.strictEqual(resolveCornerRightMode('soc', { vehicleType: 'phev' }, {}), 'soc');
        assert.strictEqual(resolveCornerRightMode('batt', { vehicleType: 'phev' }, {}), 'batt');
        assert.strictEqual(resolveCornerRightMode('auto', { vehicleType: 'ice' }, { iatC: 28 }), 'iat');
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

        // Phase A1: BMW built-in cluster map (waze idle) -> default 'auto' activates all 5 panel (0x203) zones + 3-line HUD!
        assert.strictEqual(inspectClusterSlotConfig(confDir).safe, true);
        assert.strictEqual(inspectClusterSlotConfig(confDir).conflictSlot, false);
        const rDefault = new OverlayRenderer({ ClusterRender: CustomCR, socketPath: sockPath, confDir, wazeStatusPath: wazeFile, allowPanel: false });
        rDefault.connect();
        await wait(60);
        rDefault.render(modelA, { enabled: true, gearDisplay: 'next_to_d' }, 5000);
        await wait(60);

        assert.strictEqual(recorded.layers.filter((l) => l.target === 'panel').length, 5, 'default 0x203 must activate all 5 transparent panel zones when waze is idle');
        assert(rDefault.layerCount() <= 9);
        assert(rDefault.pixelBytesTotal() < 2 * 1024 * 1024);

        const firstFrames = recorded.frames.length;
        rDefault.render(modelA, { enabled: true, gearDisplay: 'next_to_d' }, 5250);
        await wait(40);
        assert.strictEqual(recorded.frames.length, firstFrames, 'identical render must send zero frames');

        modelA.telemetry.gear = 6;
        rDefault.render(modelA, { enabled: true, gearDisplay: 'next_to_d' }, 5500);
        await wait(40);
        assert.strictEqual(recorded.frames.length, firstFrames + 2);

        // Phase A2: Maps on Cluster active (waze showing on 0x100) -> 'auto' switches from panel (0x203) to
        // borderless side-bottom map layers (map_speed, map_left, map_right) with zero shifting between P and D!
        fs.writeFileSync(wazeFile, JSON.stringify({ state: 'showing', target: 'map' }));
        modelA.telemetry.oilTempC = 78;
        modelA.telemetry.coolantTempC = 86;
        modelA.telemetry.stage = 'P';
        modelA.telemetry.gear = null;
        rDefault.render(modelA, { enabled: true, clusterSlotMode: 'auto', gearDisplay: 'next_to_d' }, 6100);
        await wait(40);
        assert.strictEqual(rDefault.lastSummary.panelAllowed, false, 'auto must unmap 0x203 when waze-on-cluster holds 0x100');
        assert.strictEqual(rDefault.lastSummary.showMapOverlay, true, 'auto must activate map_speed + map_left + map_right on 0x100');
        assert.strictEqual(rDefault.layers.below_speed.visible, false);
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
        rDefault.render(modelA, { enabled: true, clusterSlotMode: 'auto', gearDisplay: 'next_to_d' }, 6200);
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

    /* 11. End-to-End Built App Runtime in hu-stub.js (Native Full-Width Switches + Diagnostics Screen) */
    await test('End-to-end built app runtime in hu-stub.js (Native LT_State_Wide switches + DIAG screen)', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-metrics-hu-'));
        const dataDir = path.join(tmpDir, 'data');
        const ipcDir = path.join(tmpDir, 'ipc');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(ipcDir, { recursive: true });

        // Verify built uiDescription.json uses BMW's native full-width LT_State_Wide for MAIN and DIAG
        const uiXml = fs.readFileSync(path.join(ROOT, 'dist', 'cluster_metrics', 'rhmiData', 'uiDescription', 'application.xml'), 'utf8');
        const wideMatches = uiXml.match(/widget="LT_State_Wide"/g) || [];
        assert(wideMatches.length >= 2, 'MAIN and DIAG must both use native full-width LT_State_Wide');
        assert(uiXml.indexOf('widget="LT_CheckBox_1Row"') >= 0, 'MAIN must include native BMW checkbox switches');

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

            // CN Beta starts paused; first click enables, second pauses.
            assert.strictEqual(hu.settings.get('enabled'), false);
            hu.ui.comp('SET_ENABLED').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('enabled'), true);
            hu.ui.comp('SET_ENABLED').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('enabled'), false);
            hu.ui.comp('SET_ENABLED').emit('action', {});
            await wait(15);
            assert.strictEqual(hu.settings.get('enabled'), true);
            hu.ui.comp('SET_CORNERRIGHTDISPLAY').emit('action', { row: 2 }); // 'batt'
            await wait(15);
            assert.strictEqual(hu.settings.get('cornerRightDisplay'), 'batt');
            hu.ui.comp('SET_CORNERRIGHTDISPLAY').emit('action', { row: 0 }); // 'auto' -> soc
            await wait(15);
            assert.strictEqual(hu.settings.get('cornerRightDisplay'), 'auto');
            hu.ui.comp('SET_CLUSTERSLOTMODE').emit('action', { row: 1 }); // 'map_only'
            await wait(15);
            assert.strictEqual(hu.settings.get('clusterSlotMode'), 'map_only');
            hu.ui.comp('SET_CLUSTERSLOTMODE').emit('action', { row: 0 }); // 'auto'
            await wait(15);
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

            // Open native DIAG screen via BTN_DIAG and verify all diagnostic rows populate
            hu.ui.comp('BTN_DIAG').emit('action', {});
            await wait(80);
            assert(hu.stack.includes('DIAG'), 'BTN_DIAG must open native DIAG screen');
            ['DIAG_RENDER', 'DIAG_NAV', 'DIAG_BRAKE_ECU', 'DIAG_POWERTRAIN', 'DIAG_BATTERY', 'DIAG_TEMPS', 'DIAG_CHASSIS', 'DIAG_UDS'].forEach((k) => {
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
            await wait(620);
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
                        spec._methods.forEach((m) => assert(m in catMethods, iname + ' missing method ' + m));
                        return;
                    }
                    if (k === '_broadcasts') {
                        spec._broadcasts.forEach((b) => assert(b in catEvents, iname + ' missing broadcast ' + b));
                        return;
                    }
                    const cf = catFields[k];
                    assert(cf, iname + ' missing field ' + k);
                    const flags = String(spec[k]);
                    if (flags.indexOf('r') >= 0) assert(cf.getter, iname + '.' + k + ' requested "r" but has no getter on G30');
                    if (flags.indexOf('s') >= 0) assert(cf.notifier, iname + '.' + k + ' requested "s" but has no notifier on G30');
                    if (flags.indexOf('w') >= 0) assert(cf.setter, iname + '.' + k + ' requested "w" but has no setter on G30');
                });
            });
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
        assert.strictEqual(parseHudStatusText('slot 0x300 status 2: 0x1000200 class 0 map 1\n').miniMapScene, true);
        assert.strictEqual(parseHudStatusText('slot 0x330 status 2: 0x01000201 class 0 map 3\n').miniMapScene, true);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'showing', target: 'hud' })), true);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'showing', target: 'map', hud: 1, hud_state: 'showing' })), true);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'idle', target: 'map', hud: 1, hud_state: 'idle' })), false);
        assert.strictEqual(parseWazeHudShowing(JSON.stringify({ state: 'showing', target: 'map' })), false);
        assert.strictEqual(HUD_NAV_W, 264);
        assert.strictEqual(HUD_NAV_H, 264);

        // Verify full-height 264x264 vector rasterization of turn, highway fork, roundabout, and destination flag
        const navCv = new Canvas(HUD_NAV_W, HUD_NAV_H);
        const samples = [
            { kind: 'turn', dir: 'LEFT', dist: '350', unit: 'ft', road: 'El Camino Real', lanes: { lanes: [{ follow: 'LEFT', follows: ['LEFT'], others: [], hi: true, info: 'NONE' }, { follow: 'NONE', follows: [], others: ['STRAIGHT_ON'], hi: false, info: 'NONE' }], rec: 0, markers: ['SOLID', 'DASHED', 'SOLID'] } },
            { kind: 'branch', dir: 'HIGHWAY_OUT_RIGHT', geom: 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT', dist: '0.4', unit: 'mi', road: 'CA-85 North', then: { kind: 'turn', dir: 'RIGHT', gap: 90 } },
            { kind: 'roundabout', exit: 3, exitAngle: 270, side: 'right', dist: '120', unit: 'm', road: 'Civic Ring' },
            { kind: 'destination', dir: 'RIGHT', flag: true, dist: '50', unit: 'ft', road: 'Destination' },
        ];
        samples.forEach((m) => {
            assert.strictEqual(drawHudNav(navCv, m), true);
            assert(hudNavKey(m).length > 5);
            let topBand = 0, midBand = 0, botBand = 0;
            for (let py = 0; py < HUD_NAV_H; py++) {
                for (let px = 0; px < HUD_NAV_W; px++) {
                    if (navCv.d[(py * HUD_NAV_W + px) * 4 + 3] > 0) {
                        if (py < 60) topBand++;
                        else if (py < 190) midBand++;
                        else botBand++;
                    }
                }
            }
            assert(topBand > 80 && midBand > 400 && botBand > 200,
                'full-height HUD nav must paint top street, middle hero glyph, and bottom distance/lanes for ' + m.kind);
        });

        // Trace NavTracker lifecycle: normal turn (even at 30 ft!) keeps HUD & hud_nav ON;
        // lane-guidance-to-minimap transition yields 0x323; completing turn restores HUD immediately!
        const nt = new NavTracker({ crStatusPath: crFile, wazeStatusPath: wazeFile });
        let mNow = 10000, wNow = 50000;
        nt.feedField('guidance', 'guidanceState', 'ACTIVE', mNow);
        nt.feedField('guidance', 'guidingProvider', 'NONE', mNow);
        nt.feedEvents({
            GuidanceEventListError: 'NO_ERROR',
            viewContent: [{
                eventsInView: [{
                    intersection: {
                        uid: '10',
                        distanceToDestination: 1200,
                        direction: 'RIGHT',
                        formattedDistance: { distance: '40', unit: 'FEET' }, // Very close distance alone must NOT trigger hide!
                        description: { elements: [{ text: 'De Anza Blvd' }] },
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
        r.render(baseModel, { enabled: true, hudNavMode: 'own_nav_minimap' }, wNow);
        assert.strictEqual(r.lastSummary.hudYieldedToNav, false, '40 ft turn without mini-map must NOT hide HUD');
        assert.strictEqual(r.layers.hud_main.visible, true);
        assert.strictEqual(r.layers.hud_nav.visible, true);
        assert(r.layers.hud_nav.rect.h >= 250, 'hud_nav must span full vertical HUD height');
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
        await hub.startProbe(1200);
        const snapPurePedalRegen = hub.snapshot(Date.now());
        assert.strictEqual(snapPurePedalRegen.brakeBar, 0, 'decoupled wheel caliper 0 bar during pedal EV regen must report 0 bar');
        assert.strictEqual(snapPurePedalRegen.frictionG, 0, 'pure brake-pedal EV regen must keep frictionG = 0');
        assert.strictEqual(snapPurePedalRegen.pureRegen, true);
        r.render({ units: unitsMod.US_PRESET, profile: prof, efficiency: eff, telemetry: snapPurePedalRegen }, { enabled: true, brakeIndicator: 'bar_num' }, Date.now());
        assert.strictEqual(r.lastSummary.brakeLit, 0, 'pure brake-pedal EV regen must light 0 friction segments');

        // Step 3: Pressing deeper past regen limit (VA = 18.0 bar = 0x00B4) -> lights friction segments immediately!
        currentDbe5 = [0x62, 0xDB, 0xE5, 0x00, 0xDC, 0x00, 0xDC, 0x00, 0xB4, 0x00, 0x00, 0x00, 0x78, 0x00, 0x00];
        await hub.pollNow();
        const snapBlend = hub.snapshot(Date.now());
        assert.strictEqual(snapBlend.brakeBar, 18.0);
        r.render({ units: unitsMod.US_PRESET, profile: prof, efficiency: eff, telemetry: snapBlend }, { enabled: true, brakeIndicator: 'bar_num' }, Date.now());
        assert(r.lastSummary.brakeLit >= 7 && r.lastSummary.brakeLit <= 9, '18 bar blended braking expected ~8/20 segments, got ' + r.lastSummary.brakeLit);

        // Verify probe log file was written to both /tmp path and dataDir/brake-probe.log
        const logTxt = fs.readFileSync(probeFile, 'utf8');
        assert(logTxt.indexOf('0F2850') >= 0 && logTxt.indexOf('"regenIstNm":-390') >= 0, 'probe log must contain SGBD + DSC channels');
        assert(fs.existsSync(path.join(tmpDir, 'brake-probe.log')), 'probe log must also mirror to dataDir/brake-probe.log');

        hub.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    console.log('\nAll ' + passed + ' tests passed.');
    process.exit(0);
})().catch((err) => {
    console.error('\nTEST FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
});
