'use strict';
/**
 * Torque and power from the car's own vehicle signals (what M Vitals shows), as channels of
 * DDE Live's Session (session.setExternalChannels): shown in tiles, picked, captured to CSV.
 *
 *   FES.statusActualValueTorque2.actualValueTorqueCrankshaft  the crankshaft torque the DDE sends
 *       on the car's bus (to the gearbox, DSC and the displays): 12 bit, 0.5 Nm a bit, 0 Nm at
 *       2047, 4095 = no value. No diagnostic request: it costs the DDE's sample rate nothing.
 *   FES.statusVehicleDynamicEngine.displaySportEngineTorque / displaySportEnginePower
 *       the sport displays: % of the car's maximum (255 = no value); in Nm / kW with the maximum
 *       the settings give (100 % = the car's rated torque / power).
 *
 *   CDS.statusEngineTemperature.temperatureEngineOilDrive  the engine oil temperature the car shows
 *       (as M Vitals): °C = raw - 48, 255 = no value.
 *
 *   BasicDataSet.basicDataSet.valueTemperatureTransmissionOil  the gearbox oil temperature (as M Vitals):
 *       °C = raw - 48, 255 = no value. Some cars never fill it (it sits at one number): it counts only once
 *       it has moved.
 *
 *   CDS.statusEngineSpeed2, Vehicle2.statusCarSpeed2, CDS2.statusLongitudinalAccelerationMassCenter
 *       engine speed, speed and the DSC's longitudinal acceleration, many times a second: the dyno's
 *       inputs (onSample), as BMW's own apps and Virtual Dyno read them.
 *
 * And power worked out as torque × rpm / 9549: from the car's bus torque, and from the DDE's own
 * torque channel (load.torque.actual) when that is read. And whether a DPF regeneration is running:
 * the DDE asks for one (dpf.regen_request above 0) and the exhaust before the DPF is at burning heat.
 *
 *   const bus = new BusValues(ctx.signals, log, () => ({ maxNm, maxKw }));
 *   bus.start();  session.setExternalChannels(bus.channels());
 *   bus.needs(ids)  the adapter channels the wanted bus channels are worked out from
 */

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const CDS = 'de.bmw.infotainment.vehicle.CDS';
const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
const VEHICLE2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const BASIC = 'de.bmw.infrastructure.analytics.BasicDataSet';
/** Exhaust before the DPF (°C) from which a requested regeneration counts as running. */
const REGEN_HOT_C = 500;
/**
 * The car sends these signals only when they change (the oil temperature takes minutes, the torque
 * stands still at idle), so the last value stays the value: none goes stale. (They go with the app:
 * a new start, or the car switched off and the app with it, begins again from nothing.)
 */
const STALE_MS = Infinity;

const IDS = {
    torque: 'bus.torque',
    torqueSport: 'bus.torque_sport',
    powerSport: 'bus.power_sport',
    powerBus: 'power.bus',
    powerDde: 'power.dde',
    oil: 'bus.oil',
    gearboxOil: 'bus.gearbox_oil',
    regenActive: 'dpf.regen_active',
    rpm: 'bus.rpm',
    speed: 'bus.speed',
    accel: 'bus.accel',
};

const DEFS = [
    { id: IDS.torque, name: 'Torque (car bus)', group: 'Load', unit: 'Nm', quantity: 'torque', decimals: 0, min: 0, max: 800,
        description: 'The crankshaft torque the DDE sends to the gearbox and the displays (what M Vitals shows)' },
    { id: IDS.torqueSport, name: 'Torque (sport display)', group: 'Load', unit: 'Nm', quantity: 'torque', decimals: 0, min: 0, max: 800,
        description: 'The sport display\'s torque, % of the maximum in the settings' },
    { id: IDS.powerSport, name: 'Power (sport display)', group: 'Load', unit: 'kW', quantity: 'power', decimals: 0, min: 0, max: 300,
        description: 'The sport display\'s power, % of the maximum in the settings' },
    { id: IDS.powerBus, name: 'Power (car bus)', group: 'Load', unit: 'kW', quantity: 'power', decimals: 0, min: 0, max: 300,
        description: 'Engine torque (car bus) × engine speed / 9549' },
    { id: IDS.powerDde, name: 'Power (DDE torque)', group: 'Load', unit: 'kW', quantity: 'power', decimals: 0, min: 0, max: 300,
        description: 'Engine torque (the DDE\'s diagnostic value) × engine speed / 9549' },
    { id: IDS.oil, name: 'Oil temp (car bus)', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: -20, max: 150,
        description: 'The engine oil temperature the car shows (what M Vitals shows)' },
    { id: IDS.gearboxOil, name: 'Gearbox oil temp (car bus)', group: 'Temperatures', unit: '°C', quantity: 'temperature', decimals: 0, min: -20, max: 150,
        description: 'The gearbox oil temperature the car sends (what M Vitals shows); none until it has moved' },
    { id: IDS.regenActive, name: 'DPF regeneration active', group: 'Exhaust', unit: '', quantity: 'none', decimals: 0, min: 0, max: 1,
        states: { 0: 'NO', 1: 'YES' }, engine: 'diesel',
        description: 'The DDE asks for a regeneration and the exhaust before the DPF is above ' + REGEN_HOT_C + ' °C' },
    { id: IDS.rpm, name: 'Engine speed (car bus)', group: 'Engine', unit: 'rpm', quantity: 'rpm', decimals: 0, min: 0, max: 5500,
        description: 'The engine speed the car sends to the displays' },
    { id: IDS.speed, name: 'Speed (car bus)', group: 'Engine', unit: 'km/h', quantity: 'speed', decimals: 0, min: 0, max: 260,
        description: 'The car\'s speed (centre of gravity), as the dyno uses it' },
    { id: IDS.accel, name: 'Acceleration (car bus)', group: 'Engine', unit: 'g', quantity: 'none', decimals: 2, min: -1, max: 1,
        description: 'The DSC\'s longitudinal acceleration, as the dyno uses it' },
];

/** The adapter channels each worked-out channel reads from its sample. */
const NEEDS = { 'power.dde': ['engine.rpm', 'load.torque.actual'], 'dpf.regen_active': ['dpf.regen_request', 'exhaust.egt_pre_dpf'] };

const torqueNm = (raw) => (typeof raw === 'number' && raw >= 0 && raw < 4095 ? raw * 0.5 - 1023.5 : NaN);
// BMW's scalings (the kit's car.js: M Laptimer's TypeConverters)
const scaled = (raw, factor, offset) => (typeof raw === 'number' && raw >= 0 && raw < 65535 ? raw * factor + offset : NaN);
const rpmOf = (raw) => scaled(raw, 0.25, 0);
const speedOf = (raw) => scaled(raw, 0.015625, 0);
const gOf = (raw) => scaled(raw, 0.002, -65) / 9.80665;
const temp = (raw) => (typeof raw === 'number' && raw >= 0 && raw < 255 ? raw - 48 : NaN);
const percent = (raw) => (typeof raw === 'number' && raw >= 0 && raw < 255 ? raw : NaN);
/** 1 while a regeneration runs, 0 when none, NaN without the request; without the temperature, the request alone. */
const regenActive = (req, egt) => (!isFinite(req) ? NaN : req <= 0 ? 0 : !isFinite(egt) || egt >= REGEN_HOT_C ? 1 : 0);
const kw = (nm, rpm) => (isFinite(nm) && isFinite(rpm) ? Math.max(0, nm * rpm / 9549) : NaN);

class BusValues {
    /** maxima() = { nm, kw }: what 100 % on the sport displays is. */
    constructor(signals, log, maxima) {
        this.signals = signals;
        this.log = log;
        this.maxima = maxima;
        this.v = {};            // name -> { value, at }
        this.subs = [];
        this.seen = false;      // logged the first values once
        this.fns = [];
    }

    /** fn({ rpm, speed, gLong, torque }, tMs) at every engine speed, speed or acceleration update. */
    onSample(fn) { this.fns.push(fn); }

    emit() {
        if (!this.fns.length) return;
        const d = { rpm: this.get('rpm'), speed: this.get('speed'), gLong: this.get('gLong'), torque: this.get('torque') };
        const t = Date.now();
        this.fns.forEach((fn) => { try { fn(d, t); } catch (e) { this.log.warn('bus sample: ' + e); } });
    }

    start() {
        const put = (k, value) => {
            this.v[k] = { value, at: Date.now() };
            if (!this.seen && isFinite(value)) { this.seen = true; this.log.info('car bus: ' + k + ' = ' + value); }
        };
        const handlers = {
            statusActualValueTorque2: (x) => put('torque', torqueNm(x && x.actualValueTorqueCrankshaft)),
            statusVehicleDynamicEngine: (x) => {
                put('torquePct', percent(x && x.displaySportEngineTorque));
                put('powerPct', percent(x && x.displaySportEnginePower));
            },
        };
        const tick = (k, v) => { put(k, v); if (isFinite(v)) this.emit(); };
        let gearbox0 = null;      // the first gearbox reading: the value counts once it differs
        const basic = {
            basicDataSet: (x) => {
                const v = temp(x && x.valueTemperatureTransmissionOil);
                if (!isFinite(v)) return;
                if (gearbox0 === null) gearbox0 = v;
                if (v !== gearbox0) gearbox0 = true;
                put('gearbox', gearbox0 === true ? v : NaN);
            },
        };
        const temps = {
            statusEngineTemperature: (x) => put('oil', temp(x && x.temperatureEngineOilDrive)),
            statusEngineSpeed2: (x) => tick('rpm', rpmOf(x && x.actualValueRPMEngineCrankshaft)),
        };
        const speed = { statusCarSpeed2: (x) => tick('speed', speedOf(x && x.speedVehicleCentreOfGravity)) };
        const accel = { statusLongitudinalAccelerationMassCenter: (x) => tick('gLong', gOf(x && x.longitudinalAccelerationCentreOfGravity)) };
        const watch = (iface, h) => this.signals.watch(iface, '1', h, this.log)
            .then((s) => { this.subs.push(s); this.log.info('car bus ' + iface.split('.').pop() + ': ' + (s.error ? 'not available (' + s.error + ')' : 'subscribed')); return s; })
            .catch((e) => { this.log.warn('car bus ' + iface + ': ' + e); return null; });
        return Promise.all([watch(FES, handlers), watch(CDS, temps), watch(VEHICLE2, speed), watch(CDS2, accel), watch(BASIC, basic)]);
    }

    stop() { return Promise.all(this.subs.map((s) => s && s.shutdown())); }

    /** The last value of a signal, NaN when there's none or it's stale. */
    get(k) {
        const e = this.v[k];
        return e && Date.now() - e.at < STALE_MS ? e.value : NaN;
    }

    /** (Status page) how long ago each signal came: "torque 0.2 s · rpm 0.0 s · ..." or "nothing yet". */
    ages() {
        const names = { torque: 'torque', torquePct: 'sport', rpm: 'rpm', speed: 'speed', gLong: 'accel', oil: 'oil', gearbox: 'gearbox' };
        const now = Date.now(), out = [];
        Object.keys(names).forEach((k) => {
            const e = this.v[k];
            if (!e) return;
            const s = (now - e.at) / 1000;
            out.push(names[k] + ' ' + (isFinite(e.value) ? (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s' : 'no value'));
        });
        return out.length ? out.join(' · ') : 'nothing yet';
    }

    /** For Session.setExternalChannels. */
    channels() {
        return { defs: DEFS.map((d) => Object.assign({}, d)), read: (id, sample) => this.read(id, sample) };
    }

    read(id, sample) {
        const m = this.maxima() || {};
        switch (id) {
            case IDS.torque: return this.get('torque');
            case IDS.torqueSport: return this.get('torquePct') / 100 * (m.nm || NaN);
            case IDS.powerSport: return this.get('powerPct') / 100 * (m.kw || NaN);
            case IDS.powerBus: return kw(this.get('torque'), this.rpm(sample));
            case IDS.oil: return this.get('oil');
            case IDS.gearboxOil: return this.get('gearbox');
            case IDS.regenActive: return regenActive(sample('dpf.regen_request'), sample('exhaust.egt_pre_dpf'));
            case IDS.rpm: return this.get('rpm');
            case IDS.speed: return this.get('speed');
            case IDS.accel: return this.get('gLong');
            case IDS.powerDde: return kw(sample('load.torque.actual'), sample('engine.rpm'));
            default: return NaN;
        }
    }

    /** The dyno's inputs now. */
    dynoSample() { return { rpm: this.get('rpm'), speed: this.get('speed'), gLong: this.get('gLong'), torque: this.get('torque') }; }

    /** The car bus's engine speed, else the DDE's. */
    rpm(sample) {
        const r = this.get('rpm');
        return isFinite(r) ? r : sample('engine.rpm');
    }

    /** ids plus what the worked-out ones among them need streamed. */
    static withNeeds(ids) {
        const out = ids.slice();
        ids.forEach((id) => (NEEDS[id] || []).forEach((n) => { if (out.indexOf(n) < 0) out.push(n); }));
        return out;
    }
}

module.exports = { BusValues, IDS, DEFS, NEEDS, regenActive, REGEN_HOT_C, torqueNm, percent, temp, kw, rpmOf, speedOf, gOf };
