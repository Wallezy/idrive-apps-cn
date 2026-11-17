require('./app.js');
// Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430
// https://github.com/JackieZ123430/idrive7-apps-cn
'use strict';
/**
 * True Time - acceleration and braking times on the iDrive 7 (MGU), measured and corrected for the
 * road's slope.
 *
 *   Acceleration  Arm, then a standing start or full throttle from a steady speed: every test the run
 *                 covers is timed at once (0-100, 100-200, 400 m, ... and the custom ranges). The run
 *                 ends by itself when the speed settles or drops.
 *   Braking       Arm while driving, then brake: 100-0, 200-0 (and custom ranges), from the moment the
 *                 speed passes the test's start speed; time and distance.
 *   Results       the saved runs: a table of each run's tests, measured and corrected, the grade and the
 *                 gap to the record (the best corrected time). Show graph puts a saved run back on its
 *                 page (Acceleration or Braking) with its chart. Delete a run, or all.
 *   Setup         units (metric / imperial), the one-foot rollout, the speedometer's error, slope
 *                 correction on or off, ten custom speed ranges, and what the sensors send.
 *   Settings      (the kit's) colour theme, screen layout, renderer, demo drive.
 *
 * Everything comes from the car's own signals, with no diagnostic request: the speed, and the DSC's
 * longitudinal acceleration, which against the speed's change gives the road's slope (dscslope.js).
 * engine.js does the timing and the correction, tests.js lists the tests, store.js keeps the runs.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Recorder, analyze, overall } = require('./engine');
const T = require('./tests');
const { Store } = require('./store');
const { Demo } = require('./sim');
const { DscSlope } = require('./dscslope');

const W = 1600, H = 520;
const GO = '#2fd27a';
const SPEED_SCALE = 0.015625, ACCEL_SCALE = 0.002, ACCEL_OFFSET = -65, G0 = 9.80665;
const CUSTOM_SLOTS = 10;
const PAGES = ['Acceleration', 'Braking', 'Results', 'Setup'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const store = new Store(ctx.dataDir, log);
        // the Setup page's settings (kept in the app's settings, out of the kit's Settings list)
        const DEFAULTS = { units: 'metric', rollout: true, speedo: 0, slope: 'dsc' };
        const opt = (k) => { const v = settings.get(k); return v === undefined || v === null ? DEFAULTS[k] : v; };
        const corrOn = () => opt('slope') !== 'off';

        /* ---------- custom ranges (Settings page), in customs.json ---------- */
        const CFILE = path.join(ctx.dataDir, 'customs.json');
        let customs = [];
        try { customs = JSON.parse(fs.readFileSync(CFILE, 'utf8')); } catch (e) { /* none yet */ }
        while (customs.length < CUSTOM_SLOTS) customs.push(null);
        const saveCustoms = () => { try { fs.writeFileSync(CFILE, JSON.stringify(customs)); } catch (e) { log.warn('save customs: ' + e); } };

        /* ---------- units ---------- */
        const imperial = () => opt('units') === 'imperial';
        const system = () => (imperial() ? 'imperial' : 'metric');
        const SP = (kmh) => (G.isNum(kmh) ? (imperial() ? kmh / T.MPH : kmh) : null);
        const spU = () => (imperial() ? 'mph' : 'km/h');
        const LEN = (m) => (G.isNum(m) ? (imperial() ? m / T.FT : m) : null);
        const lenU = () => (imperial() ? 'ft' : 'm');
        const secs = (s) => (G.isNum(s) ? s.toFixed(2) : '--.--');
        const pct = (g) => (G.isNum(g) ? (g >= 0 ? '+' : '') + (g * 100).toFixed(1) + ' %' : '--');
        const signed = (x, d) => (G.isNum(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '--');
        const when = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
        const testsFor = (kind) => (kind === 'brake' ? T.brakeTests(system(), customs) : T.accelTests(system(), customs));

        /* ---------- the two recorders ---------- */
        let lastRun = { accel: null, brake: null };          // { results, id, summary, note }
        let page = 0, selected = null, rowsFrom = 0;
        let viewRun = null;                                   // a saved run shown again on its page (Show graph)
        const done = (kind) => (run) => {
            const r = Object.assign({}, run, corrOn() ? {} : { baro: [] });
            r.samples = run.samples;
            const results = analyze(r, testsFor(kind));
            const summary = overall(r);
            if (!results.length) {
                lastRun[kind] = { results: [], note: kind === 'brake' ? 'No braking test covered: brake from above its start speed' : 'No test covered by this run' };
                log.info(kind + ' run: no test covered');
                return;
            }
            const h0 = r.samples.length ? r.samples.find((x) => x.t >= r.t0) : null;
            const trace = [];
            let lastT = -1;
            for (const x of r.samples) {
                if (x.t < r.t0 || x.t - lastT < 100) continue;
                lastT = x.t;
                trace.push([Math.round(x.t - r.t0) / 1000, Math.round(x.v * 100) / 100,
                    h0 && G.isNum(x.h) && G.isNum(h0.h) ? Math.round((x.h - h0.h) * 100) / 100 : null]);
            }
            const id = store.add({
                at: Date.now(), kind, mode: r.mode, rollout: r.rollout, system: system(), speedoPct: Number(opt('speedo')) || 0,
                slope: corrOn() ? 'dsc' : 'off', demo: feedDemo,
                results, summary, still: r.still, trace,
            });
            lastRun[kind] = { results, id, summary };
            selected = id; rowsFrom = 0;
            log.info(kind + ' run saved: ' + results.map((x) => x.label + ' ' + secs(x.time) + '/' + secs(x.timeCorr)).join(', '));
        };
        const recs = {
            accel: new Recorder('accel', { rollout: opt('rollout'), onDone: done('accel') }),
            brake: new Recorder('brake', { onDone: done('brake') }),
        };
        const kindOf = () => (page === 1 ? 'brake' : 'accel');

        /* ---------- live values from the car (or the demo) ---------- */
        const live = { v: null, a: null, hPa: null, h: null, hAt: 0, ls: null, vAt: 0 };
        let feedDemo = false, speedSub = null, lastCar = 0;
        const t0 = Date.now();
        const carPresent = () => lastCar > 0 || !!(speedSub && speedSub.available);
        const usingDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !carPresent() && Date.now() - t0 > 5000);

        const speedo = () => 1 + (Number(opt('speedo')) || 0) / 100;
        const dsc = new DscSlope();
        /**
         * The DSC slope, every 20 ms from the latest speed and acceleration (the car sends a speed only when
         * it changes: standing still or cruising it would get none).
         */
        function dscTick(t) {
            if (!G.isNum(live.v) || !G.isNum(live.a)) return;
            dsc.push(t, live.v, live.a);
            const pts = dsc.take();
            if (!corrOn()) return;
            for (const p of pts) { recs.accel.baroReading(p.t, p.h); recs.brake.baroReading(p.t, p.h); }
            live.h = dsc.grade === null ? null : dsc.height;
        }
        function speedSample(t, kmh) {
            live.v = kmh; live.vAt = t;
            recs.accel.feed(t, kmh, live.a, live.h, live.ls);
            recs.brake.feed(t, kmh, live.a, live.h, live.ls);
        }
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: (v) => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (typeof raw !== 'number' || raw === 65535) return;
                lastCar = Date.now();
                if (!feedDemo) speedSample(lastCar, raw * SPEED_SCALE * speedo());
            },
        }, log).then((s) => { speedSub = s; log.info('speed: ' + (s.error ? 'error ' + s.error : 'subscribed')); });
        ctx.signals.watch('de.bmw.infotainment.vehicle.CDS2', '1', {
            statusLongitudinalAccelerationMassCenter: (v) => {
                const raw = v && v.longitudinalAccelerationCentreOfGravity;
                if (typeof raw !== 'number' || raw === 65535 || feedDemo) return;
                live.a = (raw * ACCEL_SCALE + ACCEL_OFFSET) / G0;
            },
        }, log);
        ctx.signals.watch('de.bmw.chassis.VehicleModel', '1', {
            LaneSlope: (v) => {
                const raw = v && v.actualValueLongitudinalGradientRoadway;
                if (typeof raw === 'number' && !feedDemo) live.ls = raw;
                if (!feedDemo) { try { live.lsAll = JSON.stringify(v); } catch (e) { live.lsAll = String(v); } }
            },
        }, log).then((s) => log.info('road gradient signal: ' + (s.error ? 'not available (' + s.error + ')' : 'subscribed'))).catch(() => {});

        // the demo drive (sim.js): speed and the DSC's acceleration, on a road with hills
        const demo = new Demo();
        let lastTick = Date.now();
        setInterval(() => {
            const d = usingDemo();
            if (d !== feedDemo) {
                feedDemo = d;
                recs.accel.disarm(); recs.brake.disarm();
                live.h = null; live.hAt = 0; dsc.reset();
                log.info(d ? 'demo drive on' : 'the car\'s data');
            }
            const now = Date.now(), dt = Math.min(0.2, Math.max(0, (now - lastTick) / 1000));
            lastTick = now;
            if (feedDemo) {
                demo.advance(dt);
                live.a = demo.car.aG; live.ls = null;
                speedSample(now, demo.car.v);
            }
            dscTick(now);
            recs.accel.tick(now); recs.brake.tick(now);
        }, 20);

        /* ---------- messages ---------- */
        let msg = null;
        const say = (text, ms) => { msg = { text, until: Date.now() + (ms || 4000) }; };

        /* ---------- arming ---------- */
        function armOrDisarm() {
            const kind = kindOf(), rec = recs[kind], other = recs[kind === 'accel' ? 'brake' : 'accel'];
            if (rec.armed) { rec.disarm(); say('Disarmed'); return; }
            other.disarm();
            lastRun[kind] = null;
            viewRun = null;
            rec.arm({ rollout: opt('rollout') });
        }

        /* ---------- button labels ---------- */
        let shownLabel = 'Arm';
        function syncLabel() {
            let l = 'Arm';
            if (page < 2) l = recs[kindOf()].armed ? 'Disarm' : 'Arm';
            else if (page === 2) l = 'Show graph';
            else l = imperial() ? 'Metric units' : 'Imperial units';
            if (l === shownLabel) return;
            shownLabel = l;
            Promise.resolve(ui.text('BTN_ARM', l)).catch(() => {});
        }
        ui.onClick('BTN_ARM', () => {
            if (page < 2) armOrDisarm();
            else if (page === 2) showGraph();
            else settings.set('units', imperial() ? 'metric' : 'imperial');
            return render();
        });
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % PAGES.length; return render(); });
        ctx.onTab((i) => { page = i; return render(); });
        settings.onChange((k) => {
            if (k === 'rollout' && recs.accel.armed) say('The rollout applies from the next Arm', 5000);
            if (k === 'slope' && (recs.accel.armed || recs.brake.armed)) say('Slope correction applies from the next Arm', 5000);
        });

        /* ================= drawing ================= */

        function badges() {
            return [
                feedDemo && { text: 'DEMO' },
                !corrOn() && { text: 'NO CORRECTION', color: 'warn' },
                opt('rollout') && { text: 'ROLLOUT 1 FT', color: 'dim' },
            ];
        }

        /** A big value with its label and unit, in the left panel. */
        function readout(cv, t, x, y, w, label, value, unit, color) {
            cv.text(label, x, y, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text(value, x + w - 70, y + 4, 40, color || t.text, { align: 'right', font: 'num' });
            cv.text(unit, x + w - 62, y + 4, 22, t.dim);
        }

        const STATES = {
            accel: {
                idle: ['PRESS ARM', 'dim'], armed: ['ARMED - FULL THROTTLE', 'accent2'], ready: ['READY - LAUNCH', 'go'],
                run: ['RUNNING', 'accent'], done: ['FINISHED', 'text'],
            },
            brake: {
                idle: ['PRESS ARM', 'dim'], armed: ['ARMED - BRAKE HARD', 'accent2'], ready: ['ARMED', 'accent2'],
                run: ['BRAKING', 'warn'], done: ['FINISHED', 'text'],
            },
        };

        function runPage(cv, t, kind) {
            const rec = recs[kind], now = Date.now();
            const vr = viewRun && viewRun.kind === kind && !rec.armed ? viewRun : null;
            // --- left: speed, state, time, distance, height ---
            const L = G.panel(cv, t, 24, 56, 420, 456, 'Speed');
            const v = SP(G.hold('speed', live.v, 100));
            cv.text(G.fmt(v, 0), 330, 190, 120, G.isNum(v) ? t.text : t.dim, { align: 'right', font: 'num' });
            cv.text(spU(), 342, 190, 26, t.dim);
            const [stTxt, stCol] = vr ? ['SAVED RUN ' + when(vr.meta.at), 'accent2'] : STATES[kind][rec.state];
            const col = stCol === 'go' ? GO : t[stCol];
            cv.roundRect(44, 214, 380, 44, 8, withAlpha(col, 0.18));
            if (rec.state === 'ready') cv.roundRect(44, 214, 380, 44, 8, withAlpha(GO, 0.3 + 0.2 * Math.sin(now / 160)));
            cv.text(stTxt, 234, 244, 22, col, { align: 'center', font: 'bold', spacing: 2 });
            const showing = vr || rec.state === 'run' || rec.state === 'done';
            let pr = rec.progress(), el = rec.elapsed(now);
            if (vr) {
                const last = vr.trace[vr.trace.length - 1] || [0, 0, null], sm = vr.meta.summary || {};
                el = last[0];
                pr = { dist: G.isNum(sm.dist) ? sm.dist : 0, dh: G.isNum(last[2]) ? last[2] : sm.dh };
            }
            const yy = L.y + L.h - 200;
            readout(cv, t, 48, Math.max(300, yy + 44), 372, 'TIME', showing ? secs(el) : '--.--', 's', rec.state === 'run' && !vr ? t.text : t.accent2);
            readout(cv, t, 48, Math.max(360, yy + 104), 372, kind === 'brake' ? 'BRAKING DISTANCE' : 'DISTANCE', showing ? G.fmt(LEN(pr.dist), 0) : '--', lenU());
            readout(cv, t, 48, Math.max(420, yy + 164), 372, 'ELEVATION', showing && G.isNum(pr.dh) ? signed(LEN(pr.dh), 1) : '--', lenU(), t.cold);

            // --- middle: speed (left scale) and elevation (right scale) over time ---
            const C = G.panel(cv, t, 460, 56, 760, 456, 'Speed and elevation');
            dualChart(cv, t, C, vr ? vr.trace : rec.trace(), vr ? 'done' : rec.state, kind);

            // --- right: this run's tests ---
            const R = G.panel(cv, t, 1236, 56, 340, 456, 'This run');
            runList(cv, t, R, kind, rec, vr);
        }

        /** Speed over time (left axis) and the height change (right axis), drawn from [[s, km/h, m]]. */
        function dualChart(cv, t, C, tr, state, kind) {
            const px = C.x + 74, pw = C.w - 148, py = C.y + 92, ph = C.h - 142;
            const SPC = t.accent2, ELC = t.warn;
            cv.text(spU().toUpperCase(), px - 12, py - 16, 16, SPC, { align: 'right', font: 'bold' });
            cv.text('ELEV. ' + lenU(), px + pw + 12, py - 16, 16, ELC, { font: 'bold' });
            const tMax = Math.max(10, Math.ceil((tr.length ? tr[tr.length - 1][0] : 0) / 5) * 5);
            let vTop = 0, eTop = 0;
            tr.forEach((p) => { vTop = Math.max(vTop, SP(p[1])); if (G.isNum(p[2])) eTop = Math.max(eTop, Math.abs(LEN(p[2]))); });
            const nice = (x, list) => list.find((n) => n >= x) || list[list.length - 1];
            const vMax = 4 * nice(vTop / 4, [25, 30, 40, 50, 60, 75, 80, 100]);
            const eMax = nice(eTop * 1.1, [2, 5, 10, 20, 50, 100, 200]);
            const X = (s) => px + (s / tMax) * pw;
            const YV = (v) => py + ph - (v / vMax) * ph;
            const YE = (e) => py + ph / 2 - (e / eMax) * (ph / 2);
            for (let i = 0; i <= 4; i++) {
                const y = py + (i / 4) * ph;
                cv.fillRect(px, Math.round(y), pw, 1, withAlpha(t.tick, i === 4 ? 0.6 : 0.25));
                cv.text(String(Math.round(vMax * (1 - i / 4))), px - 12, y + 6, 17, SPC, { align: 'right' });
                const e = eMax * (1 - i / 2);
                cv.text((e > 0 ? '+' : '') + (Math.abs(e) < 10 ? e.toFixed(1) : e.toFixed(0)), px + pw + 12, y + 6, 17, ELC);
            }
            const step = tMax > 40 ? 10 : tMax > 15 ? 5 : 2;
            for (let s = 0; s <= tMax + 1e-9; s += step) cv.text(s + (s + step > tMax ? ' s' : ''), X(s), py + ph + 26, 17, t.dim, { align: 'center' });
            if (tr.length < 2) {
                const hint = state === 'idle' ? 'Press Arm, then ' + (kind === 'brake' ? 'brake from speed' : 'launch or floor it')
                    : state === 'ready' ? 'Launch when ready' : state === 'armed' ? (kind === 'brake' ? 'Brake hard when ready' : 'Floor it when ready') : '';
                cv.text(hint, px + pw / 2, py + ph / 2 - 30, 24, t.dim, { align: 'center' });
                return;
            }
            // elevation's zero line, dashed
            for (let x = px; x < px + pw; x += 18) cv.fillRect(x, Math.round(YE(0)), 9, 1, withAlpha(ELC, 0.5));
            cv.clip(px, py - 4, pw, ph + 8);
            const sp = tr.map((p) => [X(p[0]), YV(SP(p[1]))]);
            cv.fillUnder(sp, py + ph, withAlpha(SPC, 0.14));
            cv.polyline(sp, 3, SPC);
            const el = tr.filter((p) => G.isNum(p[2])).map((p) => [X(p[0]), YE(Math.max(-eMax, Math.min(eMax, LEN(p[2]))))]);
            if (el.length > 1) cv.polyline(el, 2.5, ELC);
            cv.noclip();
        }

        /** The tests of the run on screen: measured as they come, corrected once it's finished. */
        let liveList = { at: 0, results: [] };
        function runList(cv, t, R, kind, rec, vr) {
            let results = [], note = null;
            const lr = lastRun[kind], finished = !!vr || rec.state === 'done';
            if (vr) results = vr.meta.results || [];
            else if (rec.state === 'run') {
                if (Date.now() - liveList.at > 300 || liveList.kind !== kind) liveList = { at: Date.now(), kind, results: analyze(rec.snapshot(), testsFor(kind), { measuredOnly: true }) };
                results = liveList.results;
            } else if (rec.state === 'done' && lr) { results = lr.results; note = lr.note; }
            const x = R.x + 20, w = R.w - 40, top = R.y + 62, rowH = 58;
            const rows = Math.max(1, Math.floor((R.y + R.h - top - 10) / rowH));
            if (!results.length) {
                cv.text(note || (rec.armed ? 'Times show up here' : 'No run yet'), x, top + 30, 20, note ? t.warn : t.dim);
                return;
            }
            const list = results.length > rows ? results.slice(0, rows - 1) : results;
            list.forEach((r, i) => {
                const y = top + i * rowH;
                cv.text(r.label, x, y + 20, 19, t.dim, { font: 'bold' });
                const main = kind === 'brake' ? G.fmt(LEN(r.dist), 1) + ' ' + lenU() : secs(r.time) + ' s';
                cv.text(main, x + w, y + 20, 24, t.text, { align: 'right', font: 'bold' });
                if (finished) {
                    const corr = kind === 'brake' ? (G.isNum(r.distCorr) ? 'corr. ' + G.fmt(LEN(r.distCorr), 1) + ' ' + lenU() + '  ' + secs(r.timeCorr) + ' s' : 'no correction')
                        : (G.isNum(r.timeCorr) ? 'corr. ' + secs(r.timeCorr) + ' s' : 'no correction');
                    cv.text(corr + '   ' + pct(r.grade), x, y + 46, 17, G.isNum(r.timeCorr) ? t.accent2 : t.dim);
                } else if (kind === 'brake') cv.text(secs(r.time) + ' s', x, y + 46, 17, t.dim);
                if (i < list.length - 1) cv.fillRect(x, y + rowH - 4, w, 1, withAlpha(t.tick, 0.3));
            });
            if (results.length > list.length) cv.text('+' + (results.length - list.length) + ' more on Results', x, top + list.length * rowH + 22, 18, t.dim);
        }

        /* ---------- Results ---------- */
        /** The selected run back on its page (Acceleration or Braking), its chart and its tests. */
        function showGraph() {
            const r = selected ? store.get(selected) : null;
            if (!r) { say('Pick a run first'); return; }
            viewRun = { kind: r.kind === 'brake' ? 'brake' : 'accel', meta: r, trace: r.trace || [] };
            page = viewRun.kind === 'brake' ? 1 : 0;
            if (recs[viewRun.kind].armed) say('Disarm to see the saved run', 5000);
        }
        function resultsPage(cv, t) {
            const runs = store.list();
            if (selected && !runs.some((r) => r.id === selected)) selected = null;
            if (!selected && runs.length) selected = runs[0].id;
            const kb = Math.round(store.bytes() / 1024);
            const L = G.panel(cv, t, 24, 56, 520, 456, 'Saved runs (' + runs.length + ', ' + kb + ' KB)');
            const rowH = 44, top = L.y + 56, bottom = L.y + L.h - 66;
            const rows = Math.max(1, Math.floor((bottom - top) / rowH));
            const si = Math.max(0, runs.findIndex((r) => r.id === selected));
            const first = Math.max(0, Math.min(si - Math.floor(rows / 2), runs.length - rows));
            if (!runs.length) cv.text('No runs saved yet', L.x + 20, top + 30, 22, t.dim);
            runs.slice(first, first + rows).forEach((r, k) => {
                const y = top + k * rowH, on = r.id === selected;
                if (on) cv.roundRect(L.x + 10, y, L.w - 20, rowH - 4, 8, withAlpha(t.sel || t.accent, 0.3));
                const kind = r.kind === 'brake' ? 'BRAKING' : r.mode === 'rolling' ? 'ROLLING' : 'STANDING';
                cv.text(when(r.at), L.x + 22, y + 28, 20, on ? t.text : t.dim);
                cv.text(kind + (r.demo ? ' (demo)' : ''), L.x + 200, y + 28, 18, r.kind === 'brake' ? t.warn : t.accent2, { font: 'bold', spacing: 1 });
                cv.text((r.results || []).length + ' tests', L.x + L.w - 22, y + 28, 18, t.dim, { align: 'right' });
                cv.target(L.x + 10, y, L.w - 20, rowH - 4, () => { selected = r.id; rowsFrom = 0; }, 'run' + r.id);
            });
            if (runs.length > rows) cv.text((first + 1) + '-' + Math.min(runs.length, first + rows) + ' of ' + runs.length, L.x + L.w - 22, L.y + 34, 16, t.dim, { align: 'right' });
            const by = L.y + L.h - 56;
            if (selected) G.button(cv, t, L.x + 20, by, 220, 42, 'Delete run', () => { if (viewRun && viewRun.meta.id === selected) viewRun = null; store.remove(selected); say('Run deleted'); selected = null; }, { key: 'delrun', confirm: true });
            if (runs.length) G.button(cv, t, L.x + L.w - 240, by, 220, 42, 'Delete all', () => { store.clear(); viewRun = null; say('All runs deleted'); selected = null; }, { key: 'delall', confirm: true, color: t.crit });

            const R = G.panel(cv, t, 560, 56, 1016, 456, 'Run');
            const meta = runs.find((r) => r.id === selected);
            if (!meta) { cv.text('No run to show', R.x + 24, R.y + 90, 22, t.dim); return; }
            G.button(cv, t, R.x + R.w - 230, R.y + 12, 210, 40, 'Show graph', showGraph, { key: 'graph', primary: true });
            const sm = meta.summary || {};
            const head = when(meta.at) + '  ·  ' + (meta.kind === 'brake' ? 'braking' : meta.mode + ' start') + (meta.kind === 'accel' && meta.mode === 'standing' ? (meta.rollout ? ', 1 ft rollout' : ', no rollout') : '') +
                '  ·  ' + (G.isNum(sm.grade) ? 'grade ' + pct(sm.grade) + ', ' + signed(LEN(sm.dh), 1) + ' ' + lenU() + ' over ' + G.fmt(LEN(sm.dist), 0) + ' ' + lenU() : meta.slope === 'off' ? 'not corrected' : 'no slope data') + (meta.slope === 'baro' ? '  ·  slope: barometer' : '') +
                (meta.speedoPct ? '  ·  speedo ' + signed(meta.speedoPct, 1) + ' %' : '');
            cv.text(head, R.x + 24, R.y + 70, 18, t.dim);
            const res = meta.results || [];
            const delta = (r) => {
                if (!G.isNum(r.timeCorr)) return { text: '--', color: 'dim' };
                const b = store.record(r, meta.rollout, meta.demo);
                if (!b) return { text: '--', color: 'dim' };
                if (b.id === meta.id && Math.abs(b.time - r.timeCorr) < 1e-9) return { text: 'RECORD', color: GO };
                return { text: signed(r.timeCorr - b.time, 2) + ' s', color: 'text' };
            };
            const cols = meta.kind === 'brake'
                ? [{ label: 'Test', w: 190 }, { label: 'Time', w: 110, align: 'right' }, { label: 'Corrected', w: 130, align: 'right', color: 'accent2' },
                    { label: 'Distance', w: 130, align: 'right' }, { label: 'Corrected', w: 140, align: 'right', color: 'accent2' }, { label: 'Grade', w: 110, align: 'right' }, { label: 'vs record', w: 140, align: 'right' }]
                : [{ label: 'Test', w: 200 }, { label: 'Measured', w: 150, align: 'right' }, { label: 'Corrected', w: 150, align: 'right', color: 'accent2' },
                    { label: 'Grade', w: 120, align: 'right' }, { label: 'Exit speed', w: 170, align: 'right' }, { label: 'vs record', w: 160, align: 'right' }];
            const rowH2 = 33, tTop = R.y + 84;
            const fit = Math.max(1, Math.floor((R.y + R.h - tTop - 44) / rowH2));
            rowsFrom = Math.max(0, Math.min(rowsFrom, Math.max(0, res.length - fit)));
            const rowsData = res.slice(rowsFrom, rowsFrom + fit).map((r) => {
                const d = delta(r);
                if (meta.kind === 'brake') return [r.label, secs(r.time), secs(r.timeCorr), G.fmt(LEN(r.dist), 1) + ' ' + lenU(), G.isNum(r.distCorr) ? G.fmt(LEN(r.distCorr), 1) + ' ' + lenU() : '--', pct(r.grade), d];
                return [r.label, secs(r.time), secs(r.timeCorr), pct(r.grade), G.isNum(r.exit) ? G.fmt(SP(r.exit), 1) + ' ' + spU() : '', d];
            });
            G.table(cv, t, R.x + 24, tTop, R.w - 48, cols, rowsData, { rowH: rowH2, size: 21 });
            if (res.length > fit) {
                cv.text((rowsFrom + 1) + '-' + Math.min(res.length, rowsFrom + fit) + ' of ' + res.length, R.x + 24, R.y + R.h - 16, 16, t.dim);
                G.button(cv, t, R.x + R.w - 250, R.y + R.h - 46, 110, 38, 'Up', () => { rowsFrom = Math.max(0, rowsFrom - fit); }, { key: 'up' });
                G.button(cv, t, R.x + R.w - 130, R.y + R.h - 46, 110, 38, 'Down', () => { rowsFrom += fit; }, { key: 'down' });
            }
        }

        /* ---------- Settings ---------- */
        function choice(cv, t, x, y, label, opts, cur, set) {
            cv.text(label, x, y + 28, 21, t.text, { font: 'bold' });
            if (!cv.own) { const o = opts.find((q) => q[0] === cur); cv.text(o ? o[1] : String(cur), x + 300, y + 28, 21, t.accent2, { font: 'bold' }); return; }
            let bx = x + 300;
            opts.forEach(([val, text]) => {
                const w = Math.max(120, cv.textWidth(text.toUpperCase(), 16, { font: 'bold', spacing: 1.5 }) + 40);
                G.button(cv, t, bx, y + 2, w, 40, text, () => set(val), { key: label + val, primary: cur === val });
                bx += w + 12;
            });
        }
        function settingsPage(cv, t) {
            const L = G.panel(cv, t, 24, 56, 760, 456, 'General');
            let y = L.y + 54;
            choice(cv, t, L.x + 20, y, 'Units', [['metric', 'Metric'], ['imperial', 'Imperial']], opt('units'), (v) => settings.set('units', v)); y += 60;
            choice(cv, t, L.x + 20, y, '1 ft rollout', [[true, 'On'], [false, 'Off']], !!opt('rollout'), (v) => settings.set('rollout', v)); y += 60;
            const sp = Number(opt('speedo')) || 0;
            cv.text('Speedometer error', L.x + 20, y + 28, 21, t.text, { font: 'bold' });
            G.button(cv, t, L.x + 320, y + 2, 60, 40, '-', () => settings.set('speedo', Math.max(-5, Math.round((sp - 0.5) * 10) / 10)), { key: 'sp-' });
            cv.text(signed(sp, 1) + ' %', cv.own ? L.x + 460 : L.x + 320, y + 30, 23, cv.own ? t.text : t.accent2, { align: cv.own ? 'center' : 'left', font: 'bold' });
            G.button(cv, t, L.x + 540, y + 2, 60, 40, '+', () => settings.set('speedo', Math.min(5, Math.round((sp + 0.5) * 10) / 10)), { key: 'sp+' });
            y += 60;
            choice(cv, t, L.x + 20, y, 'Slope correction', [['dsc', 'On'], ['off', 'Off']], corrOn() ? 'dsc' : 'off', (v) => settings.set('slope', v)); y += 68;
            // what the sensors send (for the road tests)
            cv.fillRect(L.x + 20, y - 8, L.w - 40, 1, withAlpha(t.tick, 0.4));
            const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(4, '0');
            const fit = (txt, w) => { let x = txt; while (x.length > 4 && cv.textWidth(x, 17) > w) x = x.slice(0, -2); return x === txt ? x : x + '...'; };
            const lines = [
                'Slope now (DSC): ' + (G.isNum(dsc.grade) ? pct(dsc.grade) : '--') + '  ·  DSC ' + (G.isNum(live.a) ? live.a.toFixed(3) + ' g' : '--') + '  ·  speed ' + G.fmt(SP(live.v), 1) + ' ' + spU(),
                'Road gradient signal: ' + (G.isNum(live.ls) ? live.ls + ' = ' + hex(live.ls) : '--') + (live.lsAll ? '  ' + live.lsAll : ''),
                (feedDemo ? 'Demo drive' : 'The car\'s signals') + '  ·  custom ranges: from < to accelerate, from > to brake',
            ];
            lines.forEach((l, i) => cv.text(fit(l, L.w - 40), L.x + 20, y + 22 + i * 28, 17, i === 2 ? t.dim : t.text));

            const R = G.panel(cv, t, 800, 56, 776, 456, 'Custom speed ranges');
            const rowH = 40, top = R.y + 50;
            const maxV = (u) => (u === 'mph' ? 200 : 320);
            customs.forEach((c, i) => {
                const y = top + i * rowH;
                cv.text(String(i + 1), R.x + 34, y + 27, 20, t.dim, { align: 'right', font: 'bold' });
                if (!cv.own) {
                    if (!c) { cv.text('--', R.x + 60, y + 27, 20, t.dim); return; }
                    const k = c.from < c.to ? 'acceleration' : c.from > c.to ? 'braking' : '--';
                    cv.text(c.from + ' to ' + c.to + ' ' + (c.unit === 'mph' ? 'mph' : 'km/h') + '   ' + k, R.x + 60, y + 27, 20, t.text);
                    return;
                }
                if (!c) {
                    G.button(cv, t, R.x + 60, y + 3, 120, 32, 'Add', () => { customs[i] = { from: imperial() ? 30 : 50, to: imperial() ? 90 : 150, unit: imperial() ? 'mph' : 'kmh' }; saveCustoms(); }, { key: 'add' + i });
                    return;
                }
                const set = (k, d) => () => { c[k] = Math.max(0, Math.min(maxV(c.unit), c[k] + d)); saveCustoms(); };
                G.button(cv, t, R.x + 60, y + 3, 44, 32, '-', set('from', -10), { key: 'f-' + i });
                cv.text(String(c.from), R.x + 146, y + 27, 22, t.text, { align: 'center', font: 'bold' });
                G.button(cv, t, R.x + 188, y + 3, 44, 32, '+', set('from', 10), { key: 'f+' + i });
                cv.text('to', R.x + 262, y + 27, 18, t.dim, { align: 'center' });
                G.button(cv, t, R.x + 292, y + 3, 44, 32, '-', set('to', -10), { key: 't-' + i });
                cv.text(String(c.to), R.x + 378, y + 27, 22, t.text, { align: 'center', font: 'bold' });
                G.button(cv, t, R.x + 420, y + 3, 44, 32, '+', set('to', 10), { key: 't+' + i });
                cv.text(c.unit === 'mph' ? 'mph' : 'km/h', R.x + 480, y + 27, 18, t.dim);
                const kind = c.from < c.to ? ['ACCEL', t.accent2] : c.from > c.to ? ['BRAKE', t.warn] : ['--', t.dim];
                cv.text(kind[0], R.x + 560, y + 27, 18, kind[1], { font: 'bold', spacing: 1 });
                G.button(cv, t, R.x + R.w - 120, y + 3, 100, 32, 'Remove', () => { customs[i] = null; saveCustoms(); }, { key: 'rm' + i });
            });
        }

        async function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            syncLabel();
            if (page === 0) runPage(cv, t, 'accel');
            else if (page === 1) runPage(cv, t, 'brake');
            else if (page === 2) resultsPage(cv, t);
            else settingsPage(cv, t);
            if (msg && Date.now() < msg.until) {
                const w = Math.max(400, cv.textWidth(msg.text, 22) + 60);
                cv.roundRect((W - w) / 2, 452, w, 48, 10, withAlpha('#000000', 0.8));
                cv.text(msg.text, W / 2, 484, 22, t.text, { align: 'center' });
            }
            G.frame(cv, t, PAGES, page, badges());
            await ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 8, render);
        render().then(() => log.info('True Time: first frame')).catch((e) => log.warn('first render: ' + e));
    },
});
