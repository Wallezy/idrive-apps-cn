'use strict';
/**
 * engine.js - True Time's measuring core, with no screen and no car in it (test/run.js drives it).
 *
 * Recorder: one run, armed by the driver (Arm), fed the car's speed (km/h, already corrected by the
 * speedometer setting), the DSC's longitudinal acceleration (g) and the height the barometer gives (m).
 *
 *   Acceleration ('accel')
 *     armed at a standstill   -> 'ready'; the launch (the speed leaves 0.5 km/h) starts the run, the clock
 *                                after the first foot when the rollout is on
 *     armed while moving      -> the run starts at the lowest speed of the last 2 s once the speed has risen
 *                                3 km/h above it (a rolling start: 80 km/h, then full throttle). Stopping
 *                                first makes it a standing start.
 *     the run ends            when the speed hasn't gained 1 km/h within 1 s (it has settled), or is 2 km/h
 *                                under its top (slowing down): it is timed up to the top speed.
 *   Braking ('brake')
 *     armed while moving      -> the run starts when the car brakes hard (2.5 km/h less within 0.3 s, about
 *                                0.24 g; coasting doesn't), from the moment the speed began to fall
 *     the run ends            at a standstill, when the speed hasn't fallen 1 km/h within 1 s (brake
 *                                released) or rises again
 *
 * analyze(run, tests, opts): every test the run covers, measured and corrected for the slope:
 *
 *   The grade p (dh/ds, + uphill) along the road comes from the barometer's heights against the distance
 *   driven: a straight line through them within 60 m either side of each point (gradeProfile; the
 *   standstill before a standing start anchors it). On a slope gravity takes g*p off the acceleration, and
 *   the car's own drive goes with its speed (gear, engine, air), so the level run is worked out over
 *   speed: at each speed step a_level(v) = a_measured(v) + g*p(s), and the corrected time is the sum of the
 *   steps' level times (distances: their level distances). Mass doesn't enter it. A distance the level car
 *   would reach a little past the recorded run is reached by carrying on the last 5 km/h's acceleration
 *   (at most 5 s). The grade shown for a test is a straight line through its whole length.
 *
 * Node 8: plain ES2017.
 */
const G0 = 9.80665;
const ROLLOUT_M = 0.3048;
const STOP_KMH = 0.5;
const START_RISE_KMH = 3, START_WINDOW_MS = 2000;
const GAIN_KMH = 1, GAIN_MS = 1000;
const DROP_KMH = 2;
const BRAKE_START_KMH = 2.5, BRAKE_WINDOW_MS = 300;   // 2.5 km/h in 0.3 s: about 0.24 g
const BRAKE_ONSET_KMHS = 4;                           // where the fall began: the last step under 4 km/h/s (0.11 g)
const MAX_RUN_MS = 120000;
const PRE_KEEP_MS = 20000;            // before a run starts, the last 20 s are kept (the standstill's heights)
const MIN_SPAN_M = 40;                // the grade is fitted over at least this much road
const MAX_GRADE = 0.2;
const EXTRA_MS = 5000;                // how far a corrected run may be carried on past the recording

const isNum = (x) => typeof x === 'number' && isFinite(x);
const lerp = (a, b, f) => a + (b - a) * f;

/** Height (m) from air pressure (hPa): the standard atmosphere; only differences are used. */
function heightOf(hPa) { return 44330.77 * (1 - Math.pow(hPa / 1013.25, 0.190263)); }

class Recorder {
    /** kind 'accel' | 'brake'; opts { rollout } */
    constructor(kind, opts) {
        this.kind = kind;
        this.rollout = !!(opts && opts.rollout);
        this.onDone = (opts && opts.onDone) || (() => {});
        this.state = 'idle';
        this.last = null;              // the last sample fed (also while idle: the live speed)
        this.clear();
    }

    clear() {
        this.samples = [];             // { t, v, a, h, ls, s }
        this.baro = [];                // { t, h }: each new barometer reading
        this.mode = null;              // 'standing' | 'rolling' (accel), 'brake'
        this.t0 = null;                // the clock's start (ms)
        this.tLaunch = null;
        this.s0 = null;                // distance at the clock's start
        this.tEnd = null;
        this.vmin = Infinity; this.tmin = null;
        this.vmax = -Infinity; this.tmax = null;
        this.anchor = null;
        this.tRun = null;              // when the run was found (its samples before it are the lead-in)
        this.still = { n: 0, a: 0, ls: 0, nls: 0 };
    }

    get armed() { return this.state === 'armed' || this.state === 'ready' || this.state === 'run'; }

    arm(opts) {
        if (opts && 'rollout' in opts) this.rollout = !!opts.rollout;
        this.clear();
        this.state = 'armed';
        if (this.last && isNum(this.last.v)) this.feed(this.last.t, this.last.v, this.last.a, this.last.h, this.last.ls);
    }

    disarm() { this.clear(); this.state = 'idle'; }

    /** A new barometer reading (height, m). */
    baroReading(t, h) {
        if (!isNum(h) || !this.armed) return;
        this.baro.push({ t, h });
    }

    feed(t, v, a, h, ls) {
        const p = this.last;
        this.last = { t, v, a, h, ls };
        if (!isNum(v) || !this.armed) return;
        if (p && t <= p.t && this.samples.length) return;
        const prev = this.samples[this.samples.length - 1];
        const s = prev ? prev.s + ((prev.v + v) / 2 / 3.6) * ((t - prev.t) / 1000) : 0;
        const cur = { t, v, a: isNum(a) ? a : null, h: isNum(h) ? h : null, ls: isNum(ls) ? ls : null, s };
        this.samples.push(cur);
        if (this.state !== 'run') this.trimLeadIn(t);
        if (this.kind === 'accel') this.stepAccel(prev, cur);
        else this.stepBrake(prev, cur);
    }

    /** The car sends a speed only when it changes: hold the last one on (call every 50 ms). */
    tick(now) {
        const l = this.last;
        if (!this.armed || !l || !isNum(l.v) || now - l.t < 150) return;
        this.feed(now, l.v, l.a, l.h, l.ls);
    }

    trimLeadIn(t) {
        const cut = t - PRE_KEEP_MS;
        if (this.samples.length > 50 && this.samples[0].t < cut) this.samples = this.samples.filter((x) => x.t >= cut);
        if (this.baro.length > 10 && this.baro[0].t < cut) this.baro = this.baro.filter((x) => x.t >= cut);
    }

    stepAccel(prev, cur) {
        const { t, v } = cur;
        if (this.state === 'armed') {
            if (v < STOP_KMH) { this.state = 'ready'; this.still = { n: 0, a: 0, ls: 0, nls: 0 }; return; }
            // the lowest speed of the last START_WINDOW_MS: full throttle lifts the speed 3 km/h above it
            // quickly; a cruise drifting up over half a minute doesn't
            let lo = cur;
            for (let j = this.samples.length - 1; j >= 0 && t - this.samples[j].t <= START_WINDOW_MS; j--) if (this.samples[j].v <= lo.v) lo = this.samples[j];
            if (v - lo.v >= START_RISE_KMH) this.startRun('rolling', lo.t, cur);
            return;
        }
        if (this.state === 'ready') {
            if (v < STOP_KMH) {
                // the standstill: the DSC's reading and the car's road gradient signal (for calibrating)
                if (isNum(cur.a)) { this.still.n++; this.still.a += cur.a; }
                if (isNum(cur.ls)) { this.still.nls++; this.still.ls += cur.ls; }
                return;
            }
            const f = prev && v > prev.v ? (STOP_KMH - prev.v) / (v - prev.v) : 0;
            const tl = prev ? prev.t + Math.max(0, Math.min(1, f)) * (t - prev.t) : t;
            this.tLaunch = tl;
            this.startRun('standing', this.rollout ? null : tl, cur);
            return;
        }
        if (this.state !== 'run') return;
        // the rollout: the clock starts after the first foot
        if (this.t0 === null) {
            const sl = this.at(this.tLaunch).s;
            if (cur.s - sl >= ROLLOUT_M) {
                const ps = prev.s, f = (sl + ROLLOUT_M - ps) / (cur.s - ps);
                this.t0 = lerp(prev.t, t, Math.max(0, Math.min(1, f)));
                this.s0 = sl + ROLLOUT_M;
            }
        }
        // a creep from the standstill: never got going, stopped again
        if (this.mode === 'standing' && v < STOP_KMH && this.vmax < 5) {
            this.state = 'ready'; this.t0 = null; this.tLaunch = null; this.vmax = -Infinity; this.anchor = null;
            return;
        }
        if (v > this.vmax) { this.vmax = v; this.tmax = t; }
        if (v >= this.anchor.v + GAIN_KMH) this.anchor = { t, v };
        const from = this.t0 === null ? this.tLaunch : this.t0;
        if (this.mode === 'standing' && this.vmax < 5) return;             // still creeping: wait
        if (t - this.anchor.t >= GAIN_MS || v < this.vmax - DROP_KMH || t - from > MAX_RUN_MS) this.finish(this.tmax);
    }

    stepBrake(prev, cur) {
        const { t, v } = cur;
        if (this.state === 'armed') {
            // hard braking: the speed falls BRAKE_START_KMH within BRAKE_WINDOW_MS (coasting or the engine's
            // drag don't do that); the run starts where that fall began
            const back = this.at(t - BRAKE_WINDOW_MS);
            if (v >= 5 && this.samples.length > 2 && back.t <= t - BRAKE_WINDOW_MS + 30 && back.v - v >= BRAKE_START_KMH) {
                let j = this.samples.length - 1;
                while (j > 0) {
                    const a = this.samples[j - 1], b = this.samples[j];
                    if (b.t - a.t > 0 && (a.v - b.v) / ((b.t - a.t) / 1000) < BRAKE_ONSET_KMHS) break;
                    j--;
                }
                const top = this.samples[Math.max(0, j - 1)];
                this.vmax = top.v; this.tmax = top.t;
                this.mode = 'brake';
                this.t0 = this.tmax;
                this.s0 = this.at(this.tmax).s;
                this.state = 'run';
                this.tRun = t;
                this.anchor = { t, v };
                this.vmin = v; this.tmin = t;
            }
            return;
        }
        if (this.state !== 'run') return;
        if (v < this.vmin) { this.vmin = v; this.tmin = t; }
        if (v <= this.anchor.v - GAIN_KMH) this.anchor = { t, v };
        if (v < STOP_KMH) {
            const f = prev && prev.v > v ? (prev.v - STOP_KMH) / (prev.v - v) : 1;
            return this.finish(prev ? lerp(prev.t, t, Math.max(0, Math.min(1, f))) : t);
        }
        if (v > this.vmin + 3 || t - this.anchor.t >= GAIN_MS || t - this.t0 > MAX_RUN_MS) this.finish(this.tmin);
    }

    startRun(mode, t0, cur) {
        this.mode = mode;
        this.t0 = t0;
        this.s0 = t0 === null ? null : this.at(t0).s;
        this.state = 'run';
        this.tRun = cur.t;
        this.anchor = { t: cur.t, v: cur.v };
        this.vmax = cur.v; this.tmax = cur.t;
    }

    finish(tEnd) {
        this.tEnd = tEnd;
        this.state = 'done';
        if (this.t0 === null) return;          // never got past the rollout
        const end = this.at(tEnd);
        this.samples = this.samples.filter((x) => x.t <= tEnd + 1e-6);
        if (!this.samples.length || this.samples[this.samples.length - 1].t < tEnd) this.samples.push(Object.assign({ t: tEnd }, end));
        this.onDone(this.snapshot());
    }

    /** The run as analyze() and the store take it. */
    snapshot() {
        return {
            kind: this.kind, mode: this.mode, rollout: this.rollout, t0: this.t0, tLaunch: this.tLaunch, s0: this.s0, tEnd: this.tEnd,
            samples: this.samples.slice(), baro: this.baro.slice(),
            still: this.still.n ? { dscG: this.still.a / this.still.n, laneRaw: this.still.nls ? this.still.ls / this.still.nls : null } : null,
        };
    }

    /** Interpolated { v, s, h, a } at time t (ms). */
    at(t) { return atTime(this.samples, t); }

    /** Seconds since the clock started (the finished run's time once it's done). */
    elapsed(now) {
        if (this.t0 === null) return 0;
        if (this.state === 'done') return (this.tEnd - this.t0) / 1000;
        if (this.state !== 'run') return 0;
        return Math.max(0, (now - this.t0) / 1000);
    }

    /** Distance (m) and height change (m) since the clock started, live. */
    progress() {
        const last = this.samples[this.samples.length - 1];
        if (this.t0 === null || !last) return { dist: 0, dh: null };
        const h0 = this.at(this.t0).h;
        return { dist: Math.max(0, last.s - this.s0), dh: isNum(last.h) && isNum(h0) ? last.h - h0 : null };
    }

    /** [[seconds from the clock's start, km/h, height change m]] for the chart. */
    trace() {
        if (this.t0 === null) return [];
        const h0 = this.at(this.t0).h, out = [];
        for (const x of this.samples) {
            if (x.t < this.t0) continue;
            out.push([(x.t - this.t0) / 1000, x.v, isNum(x.h) && isNum(h0) ? x.h - h0 : null]);
        }
        return out;
    }
}

/* ---------------- analysis ---------------- */

function atTime(samples, t) {
    const n = samples.length;
    if (!n) return { v: null, s: 0, h: null, a: null };
    if (t <= samples[0].t) return samples[0];
    if (t >= samples[n - 1].t) return samples[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (samples[m].t <= t) lo = m; else hi = m; }
    const a = samples[lo], b = samples[hi], f = (t - a.t) / (b.t - a.t || 1);
    const mix = (k) => (isNum(a[k]) && isNum(b[k]) ? lerp(a[k], b[k], f) : isNum(a[k]) ? a[k] : b[k]);
    return { t, v: mix('v'), s: mix('s'), h: mix('h'), a: mix('a') };
}

/** First time after tFrom the speed goes up through (dir +1) or down through (dir -1) target: { t, s } or null. */
function crossing(samples, tFrom, target, dir) {
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        if (b.t <= tFrom) continue;
        const hit = dir > 0 ? a.v < target && b.v >= target - 1e-6 : a.v > target && b.v <= target + 1e-6;
        if (!hit) continue;
        const f = (target - a.v) / (b.v - a.v);
        const t = lerp(a.t, b.t, f);
        if (t < tFrom) continue;
        return { t, s: lerp(a.s, b.s, f) };
    }
    return null;
}

/** First time after tFrom the distance reaches s: { t, v } or null. */
function distanceAt(samples, tFrom, s) {
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        if (b.t <= tFrom || b.s < s) continue;
        if (a.s >= s) return { t: Math.max(a.t, tFrom), v: a.v };
        const f = (s - a.s) / (b.s - a.s);
        return { t: lerp(a.t, b.t, f), v: lerp(a.v, b.v, f) };
    }
    return null;
}

/**
 * The grade (dh/ds) between distances sa and sb: a straight line through the barometer's heights
 * against the distance, over at least MIN_SPAN_M of road. null when there's too little to fit.
 */
function grade(run, sa, sb) {
    const pts = run.baro.map((b) => ({ s: atTime(run.samples, b.t).s, h: b.h })).filter((p) => isNum(p.s) && isNum(p.h));
    const fit = (lo, hi) => {
        const sel = pts.filter((p) => p.s >= lo - 1e-6 && p.s <= hi + 1e-6);
        if (sel.length < 3) return null;
        let ms = 0, mh = 0;
        sel.forEach((p) => { ms += p.s; mh += p.h; });
        ms /= sel.length; mh /= sel.length;
        let num = 0, den = 0, smin = Infinity, smax = -Infinity;
        sel.forEach((p) => { num += (p.s - ms) * (p.h - mh); den += (p.s - ms) * (p.s - ms); smin = Math.min(smin, p.s); smax = Math.max(smax, p.s); });
        if (smax - smin < 5 || den <= 0) return null;
        return Math.max(-MAX_GRADE, Math.min(MAX_GRADE, num / den));
    };
    const pad = Math.max(0, (MIN_SPAN_M - (sb - sa)) / 2);
    const g = fit(sa - pad, sb + pad);
    if (g !== null) return g;
    return fit(-Infinity, Infinity);          // the whole run
}

/**
 * The grade along the road, p(s): at each distance a straight line through the barometer's heights within
 * PROFILE_M either side (wider where there are too few), so a run over a hill and into a rise is
 * corrected for each part. Returns s -> grade, or null when there are no heights.
 */
const PROFILE_M = 60;
function gradeProfile(run) {
    const pts = run.baro.map((b) => ({ s: atTime(run.samples, b.t).s, h: b.h })).filter((p) => isNum(p.s) && isNum(p.h));
    if (pts.length < 3) return null;
    pts.sort((a, b) => a.s - b.s);
    const fit = (lo, hi) => {
        let n = 0, ms = 0, mh = 0, smin = Infinity, smax = -Infinity;
        for (const p of pts) if (p.s >= lo && p.s <= hi) { n++; ms += p.s; mh += p.h; smin = Math.min(smin, p.s); smax = Math.max(smax, p.s); }
        if (n < 3 || smax - smin < 10) return null;
        ms /= n; mh /= n;
        let num = 0, den = 0;
        for (const p of pts) if (p.s >= lo && p.s <= hi) { num += (p.s - ms) * (p.h - mh); den += (p.s - ms) * (p.s - ms); }
        return den > 0 ? Math.max(-MAX_GRADE, Math.min(MAX_GRADE, num / den)) : null;
    };
    const all = fit(-Infinity, Infinity);
    if (all === null) return null;
    const cache = new Map();
    return (s) => {
        const key = Math.round(s / 5);
        if (cache.has(key)) return cache.get(key);
        const c = key * 5;
        let g = null;
        for (let w = PROFILE_M; g === null && w <= 4 * PROFILE_M; w *= 2) g = fit(c - w, c + w);
        if (g === null) g = all;
        cache.set(key, g);
        return g;
    };
}

/**
 * The level run, worked out over speed: the car's drive (engine, tyres, air, brakes) goes with its speed,
 * so the acceleration it had at each speed is kept and gravity's share on the slope taken off:
 *   a_level(v) = a_measured(v) + g*p          (braking: the deceleration - g*p)
 * Speeds are stepped through STEP_KMH at a time from vA to vB (dir +1 up, -1 down) from time tA on, each
 * step's time the first time the speed passes it. Returns the steps as [{ v, t, s }] (level time and
 * distance from tA, s and m), or null when the level car wouldn't get there (it would need to brake
 * where the car accelerated). Past the recording (distance tests) see extend().
 */
const STEP_KMH = 0.5;
function levelSteps(samples, tA, vA, vB, p, dir) {
    const kAt = typeof p === 'function' ? (s) => 3.6 * G0 * p(s) : () => 3.6 * G0 * p;   // gravity's share, km/h per second
    const out = [{ v: vA, t: 0, s: 0, tm: tA }];
    let i = 1;
    while (i < samples.length && samples[i].t <= tA) i++;
    let prevT = tA, prevV = vA, lt = 0, ls = 0;
    const n = Math.floor(Math.abs(vB - vA) / STEP_KMH + 1e-9);
    const targets = [];
    for (let j = 1; j <= n; j++) targets.push(vA + dir * j * STEP_KMH);
    if (!targets.length || Math.abs(targets[targets.length - 1] - vB) > 1e-9) targets.push(vB);
    for (const target of targets) {
        // the first time the speed passes target
        let tc = null;
        for (; i < samples.length; i++) {
            const a = samples[i - 1], b = samples[i];
            const pass = dir > 0 ? b.v >= target - 1e-6 : b.v <= target + 1e-6;
            if (!pass) continue;
            const from = Math.max(a.t, prevT);
            const av = a.t >= prevT ? a.v : prevV;
            const f = (b.v - av) !== 0 ? (target - av) / (b.v - av) : 1;
            tc = from + Math.max(0, Math.min(1, f)) * (b.t - from);
            break;
        }
        if (tc === null) return { steps: out, done: false };
        const dt = (tc - prevT) / 1000, dv = Math.abs(target - prevV);
        let ldt;
        if (dv < 1e-9) ldt = 0;
        else {
            const a = dt > 0 ? dv / dt : Infinity;           // km/h per second, measured (decel for braking)
            const k = kAt(atTime(samples, (tc + prevT) / 2).s);
            const al = dir > 0 ? a + k : a - k;
            if (!(al > 0.05)) return null;
            ldt = dv / al;
        }
        lt += ldt;
        ls += ((prevV + target) / 2 / 3.6) * ldt;
        out.push({ v: target, t: lt, s: ls, tm: tc });
        prevT = tc; prevV = target;
    }
    return { steps: out, done: true };
}

/** Carry level steps on past the recording at the last 5 km/h's mean level acceleration, until dist (m): { t, v } or null. */
function extend(steps, dist) {
    const last = steps[steps.length - 1];
    let ref = steps[0];
    for (let j = steps.length - 1; j >= 0; j--) if (last.v - steps[j].v >= 5) { ref = steps[j]; break; }
    if (last.t - ref.t <= 0) return null;
    const a = (last.v - ref.v) / 3.6 / (last.t - ref.t);  // m/s^2
    const v0 = last.v / 3.6, need = dist - last.s;
    if (need <= 0) return null;
    let dt;
    if (Math.abs(a) < 1e-6) dt = need / v0;
    else { const disc = v0 * v0 + 2 * a * need; if (disc < 0) return null; dt = (-v0 + Math.sqrt(disc)) / a; }
    if (!(dt >= 0) || dt > EXTRA_MS / 1000) return null;
    return { t: last.t + dt, v: (v0 + a * dt) * 3.6 };
}

/** The level time to a distance (m) from the steps (interpolated), carried on past them if needed. */
function levelToDistance(res, dist) {
    const st = res.steps;
    for (let j = 1; j < st.length; j++) {
        if (st[j].s >= dist) {
            const a = st[j - 1], b = st[j], f = (dist - a.s) / (b.s - a.s || 1);
            return { t: lerp(a.t, b.t, f), v: lerp(a.v, b.v, f) };
        }
    }
    return extend(st, dist);
}

/**
 * Every test the run covers: [{ key, label, kind, time, timeCorr, grade, exit, exitCorr, dist, distCorr }]
 * (s, km/h, m; grade as a fraction, + uphill). Corrected values are null without barometer heights, and
 * with opts.measuredOnly (the live list while the run is on).
 */
function analyze(run, tests, opts) {
    const measuredOnly = !!(opts && opts.measuredOnly);
    const gradeOf = (a, b) => (measuredOnly ? null : grade(run, a, b));
    const prof = measuredOnly ? null : gradeProfile(run);
    const out = [];
    const S = run.samples;
    if (!S.length || run.t0 === null) return out;
    const standing = run.mode === 'standing';
    const vStart = atTime(S, run.t0).v;
    let vTop = 0;
    S.forEach((x) => { if (x.t >= run.t0) vTop = Math.max(vTop, x.v); });
    for (const test of tests) {
        if (run.kind === 'brake') {
            if (test.kind !== 'brake') continue;
            const a = crossing(S, run.t0 - 1, test.from, -1);
            if (!a) continue;
            const stop = Math.max(test.to, STOP_KMH);
            const last = S[S.length - 1];
            const b = test.to <= STOP_KMH ? (last.v <= STOP_KMH + 1e-6 ? { t: last.t, s: last.s } : null) : crossing(S, a.t, stop, -1);
            if (!b) continue;
            const p = gradeOf(a.s, b.s);
            const lv = p === null ? null : levelSteps(S, a.t, test.from, stop, prof || p, -1);
            const end = lv && lv.done ? lv.steps[lv.steps.length - 1] : null;
            out.push({ key: test.key, label: test.label, kind: test.kind, from: test.from, to: test.to,
                time: (b.t - a.t) / 1000, timeCorr: end ? end.t : null,
                dist: b.s - a.s, distCorr: end ? end.s : null, grade: p });
            continue;
        }
        if (test.kind === 'brake') continue;
        if (test.kind === 'dist') {
            if (!standing) continue;
            const b = distanceAt(S, run.t0, run.s0 + test.dist);
            if (!b) continue;
            const p = gradeOf(run.s0, run.s0 + test.dist);
            const lv = p === null ? null : levelSteps(S, run.t0, vStart, vTop, prof || p, +1);
            const hit = lv ? levelToDistance(lv, test.dist) : null;
            out.push({ key: test.key, label: test.label, kind: test.kind, dist: test.dist,
                time: (b.t - run.t0) / 1000, timeCorr: hit ? hit.t : null,
                exit: b.v, exitCorr: hit ? hit.v : null, grade: p });
            continue;
        }
        // speed: from 0 is a standing start (the clock's start); else the speed's way up through `from`
        let tA, sA, vA;
        if (test.from === 0) {
            if (!standing) continue;
            tA = run.t0; sA = run.s0; vA = vStart;
        } else if (!standing && vStart >= test.from && vStart - test.from <= 1) {
            // a rolling start right at `from` (cruising at 80, then full throttle: 80-120)
            tA = run.t0; sA = run.s0; vA = vStart;
        } else {
            const a = crossing(S, standing ? run.tLaunch : run.t0, test.from, +1);
            if (!a) continue;
            tA = a.t; sA = a.s; vA = test.from;
        }
        const b = crossing(S, tA, test.to, +1);
        if (!b) continue;
        const p = gradeOf(sA, b.s);
        const lv = p === null ? null : levelSteps(S, tA, vA, test.to, prof || p, +1);
        const end = lv && lv.done ? lv.steps[lv.steps.length - 1] : null;
        out.push({ key: test.key, label: test.label, kind: test.kind, from: test.from, to: test.to,
            time: (b.t - tA) / 1000, timeCorr: end ? end.t : null,
            dist: b.s - sA, grade: p });
    }
    return out;
}

/** The whole run's height change (m) and mean grade, for the run's summary. */
function overall(run) {
    const S = run.samples;
    if (!S.length || run.t0 === null) return { dh: null, grade: null, dist: 0 };
    const a = atTime(S, run.t0), b = atTime(S, run.tEnd);
    const dist = b.s - a.s;
    const p = dist > 1 ? grade(run, a.s, b.s) : null;
    return { dist, grade: p, dh: p === null ? null : p * dist };
}

module.exports = { Recorder, analyze, overall, grade, gradeProfile, heightOf, atTime, crossing, levelSteps, G0, ROLLOUT_M, STOP_KMH };
