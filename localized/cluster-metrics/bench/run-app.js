'use strict';
/**
 * bench/run-app.js - runs the built dist/cluster_metrics inside hu-stub.js,
 * connected to the bench's fake cluster-render Unix domain socket.
 */

const fs = require('fs');
const path = require('path');

const stage = process.argv[2];
const dataDir = process.argv[3];
if (!stage || !dataDir) {
    console.error('usage: run-app.js <dist/cluster_metrics> <dataDir>');
    process.exit(2);
}

const send = (m) => { if (process.connected) process.send(m); };
const fmt = (a) => a.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
const log = {
    info: (...a) => { const s = fmt(a); console.log('[cluster_metrics] ' + s); send({ t: 'log', level: 'info', s }); },
    warn: (...a) => { const s = fmt(a); console.warn('[cluster_metrics] WARN ' + s); send({ t: 'log', level: 'warn', s }); },
    error: (...a) => { const s = fmt(a); console.warn('[cluster_metrics] ERROR ' + s); send({ t: 'log', level: 'error', s }); },
    debug: () => {},
};

process.on('uncaughtException', (e) => {
    log.error('uncaught (would exit app on car): ' + ((e && e.stack) || e));
    process.exit(1);
});

fs.mkdirSync(dataDir, { recursive: true });
const ipcDir = path.join(dataDir, 'ipc');
fs.mkdirSync(ipcDir, { recursive: true });
process.env.CLUSTER_INFO_DIR = ipcDir;
process.env.CLUSTER_METRICS_BENCH = '1';

const { headUnit } = require(path.join(__dirname, '..', 'kit', 'tools', 'hu-stub.js'));
const hu = headUnit(stage, { live: true, dataDir, log, image: () => Promise.resolve() });
const { spec, settings, ui } = hu;

const realText = ui.text;
ui.text = (n, t, row, cell) => {
    if (n === 'STATUS' && !row) send({ t: 'status', s: String(t) });
    return realText(n, t, row, cell);
};

const sendSettings = () => send({ t: 'settings', schema: spec.settings, values: Object.assign({}, settings.values) });
settings.onChange(sendSettings);

function press(key, value) {
    const s = settings.item(key);
    if (!s) return log.warn('bench: unknown setting ' + key);
    const comp = ui.comp('SET_' + key.toUpperCase());
    if (s.type === 'bool') {
        if (Boolean(settings.get(key)) !== Boolean(value)) comp.emit('action', {});
        return;
    }
    const rows = s.type === 'choice' ? s.options.map((o) => o[0]) : s.steps;
    const row = rows.indexOf(value);
    if (row < 0) return log.warn('bench: setting ' + key + ' has no option ' + JSON.stringify(value));
    comp.emit('action', { row });
}

const { DemoGenerator, computeFrictionBrake } = require(path.join(stage, 'source', 'javascript', 'signals.js'));
const benchDemo = new DemoGenerator();

const SCALE = {
    rpm: [0.25, 0],
    speed: [0.015625, 0],
    accel: [0.002, -65],
    temp: [1, -48],
    boost: [0.01, 0],
    battTemp: [1, -50],
    pedal: [0.025, 0],
    torque: [0.5, -1023.5],
};
const raw = (k, v) => Math.round((v - SCALE[k][1]) / SCALE[k][0]);
let mode = 'demo';
let manual = {
    speed: 68, rpm: 0, gear: 5, stage: 'D', program: 'D',
    hvKw: 14.2, soc: 68, battTemp: 23.5, oil: 48, coolant: 73,
    boost: 0, gLong: 0.02, pedalPct: 18, driverBraking: false, absActive: false,
    torqueNm: 0, massKg: 2100, brakeBar: null, tyreFlBar: 2.4,
};
let injRaw = 10000;
let tickCount = 0;

setInterval(() => {
    tickCount++;
    const num = (k, d) => (typeof manual[k] === 'number' && isFinite(manual[k]) ? manual[k] : d);

    if (mode === 'manual') {
        const g = Math.round(num('gear', 5));
        const rpm = num('rpm', 0);
        const speed = num('speed', 0);
        if (rpm > 350) injRaw += Math.round(rpm * 0.12);

        hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', { actualValueRPMEngineCrankshaft: raw('rpm', rpm) });
        hu.feed('de.bmw.infotainment.vehicle.CDS', 'statusEngineTemperature', {
            temperatureEngineDrive: raw('temp', num('coolant', 75)),
            temperatureEngineOilDrive: raw('temp', num('oil', 55)),
        });
        hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusInjectionVolume', {
            injectionVolumeFuelEngine: injRaw,
            oilTemperature: raw('temp', num('oil', 55)),
        });
        hu.feed('de.bmw.infotainment.vehicle.CDS2', 'statusLongitudinalAccelerationMassCenter', {
            longitudinalAccelerationCentreOfGravity: raw('accel', num('gLong', 0.02) * 9.80665),
        });
        hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusCarSpeed2', { speedVehicleCentreOfGravity: raw('speed', speed) });
        hu.feed('de.bmw.infotainment.vehicle.Vehicle2', 'statusVehicleMass', { massVehicle: Math.round(num('massKg', 2100)) });
        hu.feed('de.bmw.infrastructure.VehicleInformation', 'statusGearboxDrive', {
            statusActualGearDrive: g > 0 ? 'G' + g : 'N_OR_P',
            statusActualStageDrive: manual.stage || 'D',
        });
        hu.feed('de.bmw.infotainment.misc.MDrive', 'dataDisplayGearbox', {
            displayProgramGearbox: manual.program === 'S' ? 'S_MINUS_PROGRAMM' : manual.program === 'M' ? 'M_MINUS_PROGRAMM' : 'D_PROGRAMM',
        });
        hu.feed('de.bmw.infotainment.drivingexcitement.Efficiencytainment2', 'statusBatteryTemperature', {
            actualValueTemperatureHighVoltageStorage: raw('battTemp', num('battTemp', 23.5)),
        });
        hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2', {
            displayBoostPressure: raw('boost', Math.max(0, num('boost', 0))),
        });
        hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusFESVehicleDynamicSwitchHMI', {
            actualValueModeDrivingExperience: manual.program === 'S' ? 1 : 4,
        });
        hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusActualValueTorque2', {
            actualValueTorqueCrankshaft: raw('torque', num('torqueNm', rpm > 350 ? 120 : 0)),
        });
        hu.feed('de.bmw.chassis.VehicleStabilizationManagement', 'StabilizationManagement', {
            statusBrakingDriver: manual.driverBraking ? 1 : 0,
            qualifierFunctionABS: manual.absActive ? 1 : 0,
        });
        hu.feed('de.bmw.powertrain.AcceleratorPedal', 'AngleAcceleratorPedal', {
            actualValueAngleAcceleratorPedal: raw('pedal', num('pedalPct', 18)),
        });
        const flBar = num('tyreFlBar', 2.4);
        hu.feed('de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', {
            actualValuePressureTyreFLH: Math.round(flBar * 10),
            actualValuePressureTyreFRH: 24,
            actualValuePressureTyreRLH: 26,
            actualValuePressureTyreRRH: 26,
        });
        hu.feed('de.bmw.infotainment.vehicle.TPMS', 'statusTargetTyrePressure', {
            targetPressureTyreFLH: 24, targetPressureTyreFRH: 24, targetPressureTyreRLH: 26, targetPressureTyreRRH: 26,
        });
        // Share PHEV HV power, SoC & optional brake pressure via cluster-info IPC
        const ipcPayload = {
            t: Date.now(),
            app: 'edrive_bench',
            power: { kw: num('hvKw', 12), old: false },
            values: { soc: { pct: num('soc', 68) }, battery: { c: num('battTemp', 23.5) } },
        };
        if (typeof manual.brakeBar === 'number' && isFinite(manual.brakeBar)) {
            ipcPayload.brake = { bar: manual.brakeBar };
        }
        fs.writeFileSync(path.join(ipcDir, 'edrive.json'), JSON.stringify(ipcPayload));
    }

    if (tickCount % 2 === 0) {
        if (mode === 'manual') {
            const g = Math.round(num('gear', 5));
            const rpm = num('rpm', 0);
            const speedKmh = num('speed', 0);
            const hvKw = num('hvKw', 14.2);
            const fb = computeFrictionBrake({
                speedKmh,
                rpm,
                gear: g,
                hvKw,
                gLong: num('gLong', 0.02),
                pedalPct: num('pedalPct', 18),
                driverBraking: Boolean(manual.driverBraking),
                absActive: Boolean(manual.absActive),
                torqueNm: num('torqueNm', rpm > 350 ? 120 : 0),
                massKg: num('massKg', 2100),
                brakeBar: typeof manual.brakeBar === 'number' ? manual.brakeBar : null,
            });
            const vehPref = settings.get('vehicle') || 'auto';
            const isEv = vehPref === 'ice' ? false : (vehPref === 'phev' ? rpm < 450 : rpm < 450);
            send({
                t: 'telemetry',
                v: {
                    mode: 'manual',
                    speedKmh,
                    rpm,
                    gear: g,
                    stage: manual.stage || 'D',
                    program: manual.program || 'D',
                    hvKw,
                    soc: num('soc', 68),
                    battTempC: num('battTemp', 23.5),
                    oilTempC: num('oil', 48),
                    coolantTempC: num('coolant', 73),
                    boostBar: num('boost', 0),
                    gLong: num('gLong', 0.02),
                    pedalPct: num('pedalPct', 18),
                    driverBraking: Boolean(manual.driverBraking),
                    absActive: Boolean(manual.absActive),
                    frictionG: fb.frictionG,
                    frictionKw: fb.frictionKw,
                    pureRegen: fb.pureRegen,
                    erangeKm: 31,
                    frangeKm: 410,
                    ambientC: 21.5,
                    driveMode: manual.program === 'S' ? 'sport' : 'comfort',
                    isEv,
                },
            });
        } else {
            const simPref = settings.get('demo') || 'auto';
            const vehPref = settings.get('vehicle') || 'auto';
            const simKind = simPref === 'ice' ? 'ice' : (simPref === 'phev' ? 'phev' : (vehPref === 'ice' ? 'ice' : 'phev'));
            const d = benchDemo.sample(simKind, Date.now());
            send({
                t: 'telemetry',
                v: Object.assign({ mode: 'demo', simKind, isEv: simKind === 'phev' && (d.rpm || 0) < 450 }, d),
            });
        }
    }
}, 100);

process.on('message', (m) => {
    if (!m) return;
    if (m.t === 'signals') {
        mode = m.mode === 'manual' ? 'manual' : 'demo';
        manual = Object.assign({}, manual, m.values || {});
        if (settings.get('demo') !== (mode === 'manual' ? 'off' : 'auto')) {
            press('demo', mode === 'manual' ? 'off' : 'auto');
        }
    } else if (m.t === 'set') {
        press(m.key, m.value);
    }
});

process.on('disconnect', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

hu.start();
sendSettings();
log.info('bench runner started (' + path.relative(process.cwd(), stage) + ')');
