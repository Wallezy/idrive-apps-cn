'use strict';
/**
 * runs.js - Boostline's road dyno and drag timer on the head unit: arming, the live detectors and the
 * saved runs, on Boostline's own analysis (boostline-core.js: DynoDetector / analyzeDyno, DragDetector /
 * analyzeDrag), driven the way the desktop app's Dyno and Drag pages drive them.
 *
 *   const dyno = new DynoRuns(core, path.join(dataDir, 'Dyno'));
 *   dyno.arm(setup);                         // then for every sample of the car's signals (bus.js):
 *   dyno.feed({ rpm, speed, gLong, torque }, tMs, { vin, gear });
 *   dyno.state                               // 'idle' | 'armed' | 'recording' | 'done'
 *   dyno.current, dyno.result                // the run shown, and its analysis with the current setup
 *   dyno.show(run), dyno.reload()            // a saved run from the Files page; the folder changed
 *
 * Runs are saved as the desktop app saves them (<data>/Dyno/<id>.json, <data>/Drag/<id>.json:
 * SavedDynoRun / SavedDragRun), so these folders can be copied into the desktop app's data folder.
 * Runs on the head unit's Node 8: plain ES2017.
 */
const fs = require('fs');
const path = require('path');
const vdyno = require('./vdyno');
const { PullDetector } = vdyno;

/** Saved runs kept in memory for the pages (newest first); the files stay. */
const LISTED = 30;

const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-02 11:36", as the desktop names runs */
function stamp(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const safeId = (id) => String(id).replace(/[^\w.-]+/g, '_');

/** One folder of saved runs (JSON files named by run id). */
class RunStore {
    constructor(dir) { this.dir = dir; }

    /** A run from its file (the Files page opens old ones), or null. */
    load(file) {
        try {
            const run = JSON.parse(fs.readFileSync(file, 'utf8'));
            return run && run.id && run.result ? run : null;
        } catch (e) { return null; }
    }

    save(run) {
        mkdirs(this.dir);
        const file = path.join(this.dir, safeId(run.id) + '.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(run));
        fs.renameSync(file + '.tmp', file);
        return file;
    }

    /** Saved runs, newest first (files that aren't runs are skipped). */
    list() {
        let names = [];
        try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch (e) { return []; }
        const runs = [];
        names.forEach((n) => {
            try {
                const run = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
                if (run && run.id && run.result) runs.push(run);
            } catch (e) { /* not a run */ }
        });
        return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, LISTED);
    }
}

function mkdirs(dir) {
    if (fs.existsSync(dir)) return;
    mkdirs(path.dirname(dir));
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

const fromArrays = (a) => ({
    t: Float64Array.from(a.t), rpm: Float64Array.from(a.rpm), speedKmh: Float64Array.from(a.speedKmh),
    pedalPct: a.pedalPct ? Float64Array.from(a.pedalPct) : undefined, gear: a.gear ? Float64Array.from(a.gear) : undefined,
});
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);

/**
 * The road dyno, as Virtual Dyno: armed, the next pull in one gear (hard acceleration across at least
 * 1500 rpm) is recorded by itself from the car's signals (vdyno.js), worked out, saved, and the dyno
 * disarms. A pull too short says so and stays armed.
 */
class DynoRuns {
    constructor(core, dir) {
        this.core = core;
        this.store = new RunStore(dir);
        this.runs = this.store.list();
        this.state = 'idle';             // 'idle' | 'armed' | 'recording' | 'done'
        this.detector = null;
        this.note = null;                // { text, until }: 'pull too short'
        this.baselineId = null;          // the pinned run drawn behind the one shown
        this.setup = Object.assign({}, core.DEFAULT_DYNO_SETUP);
        this.current = this.runs[0] || null;
        this.result = this.current ? this.current.result : null;
    }

    get armed() { return this.state === 'armed' || this.state === 'recording'; }

    arm(setup) {
        this.setup = setup;
        this.detector = new PullDetector();
        this.state = 'armed';
        this.note = null;
    }

    disarm() { this.detector = null; this.state = this.current ? 'done' : 'idle'; }

    /** A run worked out with a setup: Virtual Dyno's way for the car-signal runs, Boostline's for older ones. */
    analyse(run, setup) {
        try {
            if (run.input && run.input.gLong) {
                const s = Object.assign({}, setup, { gear: run.result && run.result.gear });
                return vdyno.analyze(run.input, s, this.core.correctionFactor);
            }
            return this.core.analyzeDyno(fromArrays(run.input), setup);
        } catch (e) { return run.result; }
    }

    /** The setup changed (weight, loss, body, correction): the run shown is worked out again with it. */
    setSetup(setup) {
        this.setup = setup;
        if (this.current) this.result = this.analyse(this.current, setup);
    }

    /**
     * One sample of the car's signals ({ rpm, speed, gLong, torque }, ms); extra = { vin, gear }.
     * Returns the run when this sample finished one.
     */
    feed(d, t, extra) {
        if (!this.detector) return null;
        const r = this.detector.push(d, t);
        if (!r) { if (this.state === 'recording') this.state = 'armed'; return null; }
        extra = extra || {};
        if (r.state === 'pull') {
            // the gear during the pull, counted (after it the gearbox may shift up)
            if (this.state !== 'recording') this.pullGear = {};
            if (isFinite(extra.gear) && extra.gear > 0) this.pullGear[extra.gear] = (this.pullGear[extra.gear] || 0) + 1;
            this.state = 'recording';
            return null;
        }
        if (r.state === 'short') { this.state = 'armed'; this.note = { text: 'Pull too short: at least 1500 rpm in one gear', until: Date.now() + 6000 }; return null; }
        // the gear seen most during the pull
        const pg = this.pullGear || {};
        const gear = Object.keys(pg).sort((a, b) => pg[b] - pg[a])[0];
        this.pullGear = null;
        const setup = Object.assign({}, this.setup, { gear: gear ? Number(gear) : null });
        const result = vdyno.analyze(r.input, setup, this.core.correctionFactor);
        this.detector = null;
        const run = {
            id: uid(), name: 'Run ' + stamp() + (result.gear ? ' · gear ' + result.gear : ''), createdAt: new Date().toISOString(),
            vin: extra.vin || undefined, result, input: r.input,
        };
        this.store.save(run);
        this.runs.unshift(run);
        this.runs = this.runs.slice(0, LISTED);
        this.current = run;
        this.result = result;
        this.state = 'done';
        return run;
    }

    /** The car stopped sending: a pull in progress is dropped. */
    lost() { if (this.detector) this.detector.reset(); if (this.state === 'recording') this.state = 'armed'; }

    /** Shows a saved run (from the Files page), worked out with the current setup. */
    show(run) {
        this.current = run;
        this.setSetup(this.setup);
        if (!this.armed) this.state = 'done';
    }

    /** Runs were deleted (Files page): list them again; the run shown stays if it's still saved. */
    reload() {
        const id = this.current && this.current.id;
        this.runs = this.store.list();
        const still = this.runs.find((r) => r.id === id) || (this.current && fs.existsSync(path.join(this.store.dir, safeId(id) + '.json')) ? this.current : null);
        this.current = still || this.runs[0] || null;
        this.result = this.current ? this.current.result : null;
        if (this.current) this.setSetup(this.setup);
        if (!this.armed) this.state = this.current ? 'done' : 'idle';
    }

    /** The pinned baseline run (not the one shown), or null. */
    baseline() {
        if (!this.baselineId || (this.current && this.current.id === this.baselineId)) return null;
        return this.runs.find((r) => r.id === this.baselineId) || null;
    }
    /** The baseline's result with the current setup (as the run shown), or null. */
    baselineResult() {
        const b = this.baseline();
        return b ? this.analyse(b, this.setup) : null;
    }
}

/**
 * The drag timer: armed, a standing mode waits for the car to stop, then times from the first
 * movement; a rolling mode starts when the start speed is crossed. Finished runs are saved; an
 * aborted one is shown, not saved (as on the desktop).
 */
class DragRuns {
    constructor(core, dir) {
        this.core = core;
        this.store = new RunStore(dir);
        this.runs = this.store.list();
        this.state = 'idle';
        this.detector = null;
        this.mode = null;
        this.opts = {};
        this.lastWall = 0;
        this.current = this.runs[0] || null;
    }

    get armed() { return this.state === 'waiting-stop' || this.state === 'ready' || this.state === 'running'; }
    get result() { return this.current ? this.current.result : null; }
    /**
     * The run in progress: { elapsed s, distanceM, speedKmh, maxKmh }, or null (not running). Between
     * samples (a few a second over the head unit's link) the clock and the distance run on from the
     * last one at its speed, so the numbers move smoothly; the next sample puts them right.
     */
    get live() {
        const l = this.detector && this.state === 'running' ? this.detector.live : null;
        if (!l) return null;
        const dt = Math.min(1, Math.max(0, (Date.now() - this.lastWall) / 1000));
        return { elapsed: l.elapsed + dt, distanceM: l.distanceM + (l.speedKmh / 3.6) * dt, speedKmh: l.speedKmh, maxKmh: l.maxKmh };
    }

    arm(mode, opts) {
        this.mode = mode;
        this.opts = opts || {};
        this.detector = new this.core.DragDetector(mode, this.opts);
        this.state = this.detector.state;
    }

    disarm() { this.detector = null; this.state = 'idle'; }

    /** One sample of the stream; returns the run when this sample ended one (finished or aborted). */
    push(t, speedKmh, gear, rpm, vin) {
        if (!this.detector || !isFinite(speedKmh)) return null;
        this.lastWall = Date.now();
        const s = this.detector.push(t, speedKmh, num(gear), num(rpm));
        this.state = s;
        if (s !== 'finished' && s !== 'aborted') return null;
        const result = this.core.analyzeDrag(this.detector.input(), this.mode, this.opts);
        this.detector = null;
        const run = {
            id: uid(),
            name: modeName(this.mode) + ' · ' + (result.finalTime !== null ? result.finalTime.toFixed(3) + ' s' : 'unfinished') + ' · ' + stamp(),
            createdAt: new Date().toISOString(), vin: vin || undefined, result,
        };
        if (result.finished) {
            this.store.save(run);
            this.runs.unshift(run);
            this.runs = this.runs.slice(0, LISTED);
        }
        this.current = run;
        return run;
    }

    /** Shows a saved run (from the Files page). */
    show(run) { this.current = run; }

    /** Runs were deleted (Files page): list them again; the run shown stays if it's still saved. */
    reload() {
        const id = this.current && this.current.id;
        this.runs = this.store.list();
        const saved = this.current && fs.existsSync(path.join(this.store.dir, safeId(id) + '.json'));
        // an unfinished run is shown, not saved: it stays
        const unsaved = this.current && !this.current.result.finished;
        this.current = this.runs.find((r) => r.id === id) || (saved || unsaved ? this.current : null) || this.runs[0] || null;
    }

    /** The best finished time saved for a mode, or null. */
    best(mode) {
        return this.runs.reduce((b, r) => (r.result.mode === mode && r.result.finished && (b === null || r.result.finalTime < b) ? r.result.finalTime : b), null);
    }
}

/** Drag modes as the desktop app labels them. */
const MODE_NAMES = {
    '0-100': '0-100 km/h', '0-200': '0-200 km/h', '100-200': '100-200 km/h', '200-300': '200-300 km/h',
    '40-100': '40-100 km/h', '60-160': '60-160 km/h', '70-120': '70-120 km/h', '80-120': '80-120 km/h',
    '0-60mph': '0-60 mph', '60-130mph': '60-130 mph', '200m': '0-200 m', '400m': '0-400 m', '201m': '1/8 mile', '402m': '1/4 mile',
};
const modeName = (m) => MODE_NAMES[m] || m;

module.exports = { DynoRuns, DragRuns, RunStore, modeName, MODE_NAMES, stamp };
