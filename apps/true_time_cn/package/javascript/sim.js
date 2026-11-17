'use strict';
/**
 * sim.js - a car on a road with hills, for the demo (no car, the emulator) and the tests.
 *
 *   const car = new SimCar({ grade: (s) => -0.02 });      // dh/ds along the road, + uphill
 *   car.step(dt, 'full' | 'coast' | 'cruise' | 'brake')   // advance dt seconds
 *   car.v (km/h), car.aG (the DSC's reading, g), car.s (m), car.h (m), car.hPa (air pressure)
 *
 * The car is a ~1950 kg diesel estate: traction-limited off the line, then about 140 kW at the wheels,
 * air drag and rolling resistance; braking at `brakeG`. The DSC's sensor is fixed to the body, so on a
 * slope it also reads gravity's share (aG = dv/dt/g + grade).
 *
 * Demo: the drive the app shows in demo mode, a loop of a standing start downhill, a hard stop on a
 * rise, and a rolling 80 km/h start on the level: speed, acceleration and the barometer every 50 ms
 * (the barometer every 125 ms, with the noise and steps of the engine unit's sensor).
 *
 * Node 8: plain ES2017.
 */
const G0 = 9.80665;

class SimCar {
    constructor(opts) {
        const o = opts || {};
        this.grade = o.grade || (() => 0);
        this.mass = o.mass || 1950;
        this.powerW = o.powerW || 140000;
        this.tractionG = o.tractionG || 0.55;
        this.brakeG = o.brakeG || 0.95;
        this.cda = o.cda || 0.72;
        this.h0 = o.h0 || 200;            // height at s = 0 (m)
        this.v = 0; this.s = 0; this.h = this.h0; this.aG = 0; this.dvdt = 0;
        this.cruiseKmh = 80;
    }

    /** Engine and brakes on the level, m/s^2. */
    drive(mode, vms) {
        const drag = 0.5 * 1.2 * this.cda * vms * vms / this.mass + 0.013 * G0 * (vms > 0.05 ? 1 : 0);
        if (mode === 'full') return Math.min(this.tractionG * G0, this.powerW / (this.mass * Math.max(vms, 1))) - drag;
        if (mode === 'brake') return vms > 0 ? -this.brakeG * G0 - drag : 0;
        if (mode === 'cruise') {
            const err = this.cruiseKmh / 3.6 - vms;
            return Math.max(-2, Math.min(2.5, err * 1.5)) ;
        }
        if (mode === 'stop') return vms > 0 ? -3 : 0;
        return -drag;                                     // coast
    }

    step(dt, mode) {
        const n = Math.max(1, Math.round(dt / 0.002)), h = dt / n;
        for (let i = 0; i < n; i++) {
            const vms = this.v / 3.6, p = this.grade(this.s);
            const sin = p / Math.sqrt(1 + p * p);
            let a = this.drive(mode, vms);
            if (mode === 'cruise') a += G0 * sin;             // the cruise holds its speed on a slope
            a -= G0 * sin;
            let nv = vms + a * h;
            if (nv < 0 || ((mode === 'stop' || mode === 'brake') && nv < 0.01)) nv = 0;
            if (vms === 0 && nv === 0) a = 0;
            this.s += (vms + nv) / 2 * h;
            this.h += (vms + nv) / 2 * h * sin;
            this.v = nv * 3.6;
            this.dvdt = a;
            this.aG = a / G0 + sin;
        }
    }

    get hPa() { return 1013.25 * Math.pow(1 - this.h / 44330.77, 1 / 0.190263); }
}

/** The engine unit's barometer: 0.0390625 hPa steps (its scaling), a little noise. */
function baroReading(hPa, rnd) {
    const noise = ((rnd || Math.random)() - 0.5) * 0.08;
    return Math.round((hPa + noise) / 0.0390625) * 0.0390625;
}

/** A road: 1.5 % down for the first kilometre, then a 1 % rise, then level. */
function demoGrade(s) {
    const m = s % 4000;
    if (m < 1000) return -0.015;
    if (m < 1600) return 0.01;
    return 0;
}

/** The demo's drive, as a script: [mode, until(car, secondsInPhase)]. */
const SCRIPT = [
    ['stop', (c, t) => t >= 6],
    ['full', (c, t) => c.v >= 205 || t > 40],
    ['coast', (c, t) => t >= 2],
    ['brake', (c) => c.v <= 0],
    ['stop', (c, t) => t >= 4],
    ['cruise', (c, t) => t >= 14],
    ['full', (c, t) => c.v >= 190 || t > 40],
    ['coast', (c, t) => t >= 2],
    ['brake', (c) => c.v <= 0],
];

class Demo {
    constructor() {
        this.car = new SimCar({ grade: demoGrade });
        this.phase = 0; this.inPhase = 0; this.t = 0;
    }

    /** Advance dt seconds, in 10 ms steps (the rest is kept for the next call). */
    advance(dt) {
        this.acc = (this.acc || 0) + dt;
        for (; this.acc >= 0.01; this.acc -= 0.01) {
            const [mode, until] = SCRIPT[this.phase];
            this.car.step(0.01, mode);
            this.inPhase += 0.01; this.t += 0.01;
            if (until(this.car, this.inPhase)) {
                this.phase = (this.phase + 1) % SCRIPT.length; this.inPhase = 0;
                if (this.phase === 0) this.car.s = Math.ceil(this.car.s / 4000) * 4000;      // the hill again
            }
        }
    }

    get mode() { return SCRIPT[this.phase][0]; }
}

module.exports = { SimCar, Demo, baroReading, demoGrade, G0 };
