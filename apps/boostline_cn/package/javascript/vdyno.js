'use strict';
/**
 * vdyno.js - the road dyno, worked out as Virtual Dyno (the kit's apps/dyno) does it, from the car's own
 * signals: engine speed, speed and the DSC's longitudinal acceleration, many times a second (bus.js).
 *
 *   wheel power = m*a*v  +  air drag (1/2 rho CdA v^3)  +  rolling resistance (Crr m g v)
 *   crank power = wheel power / (1 - drivetrain loss)
 *   torque      = crank power / engine angular speed
 *   binned by 100 rpm, smoothed over 5 bins; then (Boostline's) SAE / DIN weather correction, if chosen
 *
 * A pull: accelerating hard (> 0.12 g) above 15 km/h and 1200 rpm, in one gear (the rpm / speed ratio
 * steady within 4 %), across at least 1500 rpm. It ends
 *   - when the acceleration falls sharply (0.1 g within 0.5 s, on a 3-sample mean: off the pedal, the limiter, a shift
 *     starting): the pull is kept up to the acceleration's last high point before the fall, so that
 *     the samples the car's (filtered, a little late) acceleration still shows high don't count;
 *   - at a gear change (the rpm / speed ratio moves): the gear before is the run;
 *   - or when there's no hard acceleration for 0.5 s.
 * A gear's part shorter than 1500 rpm (the launch, a kickdown) is dropped and the next gear's taken.
 *
 *   const det = new PullDetector();
 *   det.push(sample, tMs)  -> null | { state: 'pull' } | { state: 'short' } | { state: 'done', input }
 *   analyze(input, setup)  -> the result the Dyno page draws (Boostline's DynoResult shape)
 *
 * input = { t: [s], rpm: [], speedKmh: [], gLong: [g], ecuNm: [] } (raw, so a run can be worked out
 * again with another weight, loss, body or correction). Node 8: plain ES2017.
 */
const BIN = 100;
const MIN_SPAN = 1500;
const MIN_POINTS = 15;
const HARD_G = 0.12;
const SAMPLE_MS = 40;                 // at most 25 samples a second, as Virtual Dyno
const END_MS = 500;
/** A sharp fall: this much below the highest acceleration of the last DROP_MS. */
const DROP_G = 0.1, DROP_MS = 500;
/** Where a fall starts: the last sample within this much of the high point before it. */
const KNEE_G = 0.03;
/** Samples in a row off the gear's rpm / speed ratio that make a gear change (not noise). */
const SHIFT_SAMPLES = 2;
const CDA = { coupe: 0.62, wagon: 0.72, suv: 0.95 };
const RHO = 1.2, CRR = 0.013, G = 9.80665;

const isNum = (v) => typeof v === 'number' && isFinite(v);

class PullDetector {
    constructor() {
        this.pull = null;           // { segs: [{ k, pts: [] }], start, lastHard }
        this.lastT = 0;
        this.t0 = null;
        this.gs = [];               // the last accelerations (their mean shows a fall)
    }

    /** The pull being recorded: its samples so far (the tallest gear's), or null. */
    get recording() { return !!this.pull; }

    push(d, t) {
        if (t - this.lastT < SAMPLE_MS) return this.pull ? { state: 'pull' } : null;
        this.lastT = t;
        if (!isNum(d.rpm) || !isNum(d.speed) || !isNum(d.gLong)) return this.pull ? { state: 'pull' } : null;
        const hard = d.gLong > HARD_G && d.speed > 15 && d.rpm > 1200;
        // a sharp fall of the acceleration ends the pull (hard or not any more); on its mean over the last
        // three samples (the signal's noise isn't a fall)
        const seg = this.pull && this.pull.seg;
        this.gs.push(d.gLong);
        if (this.gs.length > 3) this.gs.shift();
        const gMean = this.gs.reduce((a, x) => a + x, 0) / this.gs.length;
        if (seg && seg.pts.length) {
            const since = (t - this.t0) / 1000 - DROP_MS / 1000;
            let top = -1;
            for (let i = seg.pts.length - 1; i >= 0 && seg.pts[i].t >= since; i--) if (top < 0 || seg.pts[i].gm >= seg.pts[top].gm) top = i;
            if (top >= 0 && seg.pts[top].gm - gMean >= DROP_G) {
                // kept up to where the fall starts: the last sample still near the high point
                let cut = seg.pts.length - 1;
                while (cut > top && seg.pts[cut].gm < seg.pts[top].gm - KNEE_G) cut--;
                if (cut > top) cut--;                   // (the 3-sample mean is a sample late)
                seg.pts = seg.pts.slice(0, cut + 1);
                return this.finish();
            }
        }
        if (hard) {
            if (!this.pull) { this.pull = { seg: null, start: Date.now() }; this.t0 = t; }
            const k = d.rpm / d.speed;
            const p = { t: (t - this.t0) / 1000, rpm: d.rpm, v: d.speed, g: d.gLong, gm: gMean, ecu: isNum(d.torque) ? d.torque : null };
            let s = this.pull.seg;
            if (s && Math.abs(k - s.k) / s.k > 0.04) {
                // off the gear's ratio: a gear change once it lasts, else noise (the sample's dropped)
                s.off.push(p);
                if (s.off.length < SHIFT_SAMPLES) { this.pull.lastHard = t; return { state: 'pull' }; }
                if (long(s)) return this.finish();
                s = null;                       // the gear before was too short: the next one counts
            }
            if (!s) { s = this.pull.seg = { k, pts: [], off: [] }; }
            s.off = [];
            s.k += (k - s.k) * 0.1;
            s.pts.push(p);
            this.pull.lastHard = t;
            return { state: 'pull' };
        }
        if (this.pull && t - this.pull.lastHard > END_MS) return this.finish();
        return this.pull ? { state: 'pull' } : null;
    }

    /** The car stopped sending (or the run was disarmed): the pull so far is dropped. */
    reset() { this.pull = null; }

    finish() {
        const p = this.pull;
        this.pull = null;
        if (!p) return null;
        if (!p.seg || !long(p.seg)) return { state: 'short' };
        const pts = p.seg.pts;
        return {
            state: 'done', start: p.start,
            input: { t: pts.map((x) => x.t), rpm: pts.map((x) => x.rpm), speedKmh: pts.map((x) => x.v), gLong: pts.map((x) => x.g), ecuNm: pts.map((x) => x.ecu) },
        };
    }
}

/** A gear's part long enough to be a run: 1500 rpm and more than 15 samples. */
function long(seg) {
    if (seg.pts.length <= MIN_POINTS) return false;
    const r = seg.pts.map((x) => x.rpm);
    return Math.max.apply(null, r) - Math.min.apply(null, r) >= MIN_SPAN;
}

/** Crank power (W) of one sample: Virtual Dyno's formula. */
function crankW(v, gLong, setup) {
    const m = setup.massKg, ms = v / 3.6, a = gLong * G, cda = CDA[setup.body] || 0.65;
    const wheel = m * a * ms + 0.5 * RHO * cda * ms * ms * ms + CRR * m * G * ms;
    return wheel / (1 - (setup.drivetrainLossPct || 0) / 100);
}

/**
 * setup = { massKg, drivetrainLossPct, body, correction ('none' | 'SAE' | 'DIN'), baroHpa, ambientTempC,
 * humidityPct }; correctionFactor(standard, tempC, hPa, humidity) is Boostline's (boostline-core.js).
 */
function analyze(input, setup, correctionFactor) {
    const n = input.rpm.length, bins = {};
    for (let i = 0; i < n; i++) {
        const b = Math.round(input.rpm[i] / BIN) * BIN;
        (bins[b] = bins[b] || []).push({ p: crankW(input.speedKmh[i], input.gLong[i], setup), ecu: input.ecuNm[i] });
    }
    const keys = Object.keys(bins).map(Number).sort((a, b) => a - b);
    const avg = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
    const raw = keys.map((k) => {
        const e = bins[k].map((x) => x.ecu).filter(isNum);
        return { rpm: k, p: avg(bins[k].map((x) => x.p)), ecu: e.length ? avg(e) : null };
    });
    const cf = setup.correction && setup.correction !== 'none' && correctionFactor
        ? correctionFactor(setup.correction, setup.ambientTempC, setup.baroHpa, setup.humidityPct) : 1;
    const loss = (setup.drivetrainLossPct || 0) / 100;
    const smooth = smoothed(raw.map((c) => c.rpm), raw.map((c) => c.p));
    const points = raw.map((c, i) => {
        const p = Math.max(0, smooth[i]) * cf;
        return { rpm: c.rpm, engineKw: p / 1000, wheelKw: p * (1 - loss) / 1000, torqueNm: p / (c.rpm * Math.PI / 30), ecuNm: c.ecu };
    });
    const top = (key) => points.reduce((a, c) => (c[key] > a[key] ? c : a), points[0]);
    const pk = points.length ? top('engineKw') : null, tk = points.length ? top('torqueNm') : null;
    const warnings = [];
    if (!points.length) warnings.push('No samples in the pull');
    return {
        method: 'bus',
        points,
        peakEngine: { kw: pk ? pk.engineKw : 0, rpm: pk ? pk.rpm : 0 },
        peakWheel: { kw: pk ? pk.wheelKw : 0, rpm: pk ? pk.rpm : 0 },
        peakTorque: { nm: tk ? tk.torqueNm : 0, rpm: tk ? tk.rpm : 0 },
        gear: setup.gear || null,
        setup: Object.assign({}, setup),
        correctionFactor: cf,
        warnings,
        v0: input.speedKmh[0], v1: input.speedKmh[n - 1],
    };
}

/**
 * Smoothed over the 5 nearest bins: a straight line fitted through them, taken at the bin. In the middle
 * that's their mean; at the ends the line follows the curve's slope instead of pulling the end bins
 * towards the middle (as a plain mean of the fewer bins there would).
 */
function smoothed(xs, ys, n) {
    n = n || 5;
    return xs.map((x, i) => {
        if (xs.length < 3) return ys[i];
        let a = Math.max(0, Math.min(i - Math.floor(n / 2), xs.length - n));
        const b = Math.min(xs.length, a + n);
        a = Math.max(0, b - n);
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        const m = b - a;
        for (let j = a; j < b; j++) { sx += xs[j]; sy += ys[j]; sxx += xs[j] * xs[j]; sxy += xs[j] * ys[j]; }
        const den = m * sxx - sx * sx;
        if (!den) return sy / m;
        const slope = (m * sxy - sx * sy) / den;
        return sy / m + slope * (x - sx / m);
    });
}

/** Power right now (kW at the crank) for the live readout, or null. */
function powerNow(d, setup) {
    if (!isNum(d.speed) || !isNum(d.gLong) || d.gLong <= HARD_G) return null;
    return crankW(d.speed, d.gLong, setup) / 1000;
}

module.exports = { PullDetector, analyze, powerNow, crankW, smoothed, CDA, BIN, MIN_SPAN, DROP_G };
