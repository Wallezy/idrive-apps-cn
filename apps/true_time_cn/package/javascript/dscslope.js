'use strict';
/**
 * dscslope.js - the road's grade from the DSC's acceleration sensor, and the height it adds up to.
 *
 * The DSC's longitudinal sensor is fixed to the body: it reads the car's acceleration plus gravity's share
 * along the road, a_DSC = dv/dt + g*sin(grade). The wheels' speed gives dv/dt alone, so
 *
 *     grade ~ (a_DSC - dv/dt) / g
 *
 * dv/dt is a straight line through the last WINDOW_MS of speed, a_DSC the mean over the same time, and
 * the grade is smoothed (TAU_S) and summed over the distance driven into a height (m), which the app uses
 * as it would the barometer's: the chart's elevation and the correction of the times. Standing still,
 * dv/dt is 0 and the sensor reads the grade itself.
 * The body pitches back under acceleration and forward under braking, and the sensor tilts with it: that
 * reads as grade, pitch * dv/dt / g (pitch: fraction of grade per g, about 0.01-0.03 on a car). With the
 * car's pitch known (the Setup page's pitch compensation) it is taken off:
 *
 *     grade ~ (a_DSC - (1 + pitch) * dv/dt / g)

 *
 * The window and the smoothing make the grade late by about WINDOW_MS / 2 + TAU_S: at 200 km/h that is
 * some 50 m of road. So each grade is put where the car was that much earlier, and the heights come as
 * points { t, h } at those moments (ds.take()), which the app gives the recorders as it would the
 * barometer's readings.
 *
 *   const ds = new DscSlope({ pitch: 0.015 });
 *   ds.push(tMs, kmh, gLong)    at every speed sample (the last acceleration with it)
 *   ds.grade                    the smoothed grade (fraction, + uphill), or null
 *   ds.height                   the height summed since the start (m), at the delayed point
 *   ds.take()                   the new { t, h } points since the last call
 *
 * Node 8: plain ES2017.
 */
const G0 = 9.80665;
const WINDOW_MS = 800;
const TAU_S = 0.5;
const MAX_GRADE = 0.25;
const JERK_G_S = 1.0, HOLD_MS = WINDOW_MS;          // the acceleration changing faster than 1 g/s: hold

const isNum = (x) => typeof x === 'number' && isFinite(x);

class DscSlope {
    constructor(opts) {
        const o = opts || {};
        this.windowMs = o.windowMs || WINDOW_MS;
        this.tau = o.tau || TAU_S;
        this.pitch = o.pitch || 0;
        this.buf = [];               // { t, v (m/s), a (g) }
        this.track = [];             // { t, s }: where the car was, for the delayed grade
        this.grade = null;
        this.height = 0;
        this.s = 0;
        this.ref = null;             // the delayed point the height has been summed to: { t, s }
        this.out = [];
        this.last = null;
    }

    reset() { this.prevD = null; this.holdUntil = 0; this.buf = []; this.track = []; this.grade = null; this.height = 0; this.s = 0; this.ref = null; this.out = []; this.last = null; }

    /** The new height points since the last call: [{ t, h }]. */
    take() { const o = this.out; this.out = []; return o; }

    /** Where the car was at time t (m), from the track. */
    sAt(t) {
        const tr = this.track;
        if (!tr.length || t <= tr[0].t) return tr.length ? tr[0].s : 0;
        for (let i = tr.length - 1; i > 0; i--) {
            if (tr[i - 1].t <= t) {
                const a = tr[i - 1], b = tr[i];
                return b.t > a.t ? a.s + (b.s - a.s) * Math.min(1, (t - a.t) / (b.t - a.t)) : b.s;
            }
        }
        return tr[0].s;
    }

    push(t, kmh, aG) {
        if (!isNum(kmh) || !isNum(aG)) return;
        const v = kmh / 3.6;
        if (this.last && t <= this.last.t) return;
        this.buf.push({ t, v, a: aG });
        while (this.buf.length > 2 && t - this.buf[0].t > this.windowMs) this.buf.shift();
        // dv/dt: a straight line through the window's speeds; the sensor's mean over the same time
        let raw = null;
        if (this.buf.length >= 3 && t - this.buf[0].t >= this.windowMs * 0.5) {
            let mt = 0, mv = 0, ma = 0;
            const n = this.buf.length;
            this.buf.forEach((p) => { mt += p.t; mv += p.v; ma += p.a; });
            mt /= n; mv /= n; ma /= n;
            let num = 0, den = 0;
            this.buf.forEach((p) => { num += (p.t - mt) * (p.v - mv); den += (p.t - mt) * (p.t - mt); });
            const dvdt = den > 0 ? (num / den) * 1000 : 0;          // m/s^2
            // while the acceleration changes fast (a launch, a gear change, the brake going on) the sensor
            // and the speed disagree for a moment: the grade is held until it has settled
            const dg = dvdt / G0;
            if (this.prevD && t > this.prevD.t) {
                const jerk = Math.abs(dg - this.prevD.d) / ((t - this.prevD.t) / 1000);
                if (jerk > JERK_G_S) this.holdUntil = t + HOLD_MS;
            }
            this.prevD = { t, d: dg };
            if (!(this.holdUntil > t)) raw = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, ma - (1 + this.pitch) * dg));
        }
        if (raw !== null) {
            const dt = this.last ? (t - this.last.t) / 1000 : 0;
            this.grade = this.grade === null || dt > 3 ? raw : this.grade + (raw - this.grade) * (1 - Math.exp(-dt / this.tau));
        }
        // the distance driven, and the height: the grade over the road it belongs to (DELAY earlier)
        if (this.last) this.s += (this.last.v + v) / 2 * ((t - this.last.t) / 1000);
        this.track.push({ t, s: this.s });
        while (this.track.length > 2 && t - this.track[0].t > 4000) this.track.shift();
        this.last = { t, v };
        if (this.grade === null) return;
        const tr = t - this.windowMs / 2 - this.tau * 1000, sr = this.sAt(tr);
        if (this.ref && tr > this.ref.t) this.height += this.grade * Math.max(0, sr - this.ref.s);
        if (!this.ref || tr > this.ref.t) {
            this.ref = { t: tr, s: sr };
            this.out.push({ t: tr, h: this.height });
        }
    }
}

module.exports = { DscSlope };
