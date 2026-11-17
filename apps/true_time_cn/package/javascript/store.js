'use strict';
/**
 * store.js - the saved runs, one file each in <data>/runs/ (so a run can go on its own), and the
 * records worked out from them (the best corrected time of each test).
 *
 *   const store = new Store(dataDir, log);
 *   store.add(run)          save a finished run: { at, kind, mode, rollout, system, speedoPct, results, summary, trace, still }
 *   store.list()            the runs, newest first (without their traces)
 *   store.get(id)           one run with its trace
 *   store.remove(id)        delete one;  store.clear(kind)  delete all (of a kind, or every one)
 *   store.record(test, rollout, demo)   the best corrected time { time, id } of a test (record key, tests.js;
 *                           demo runs have records of their own)
 *   store.bytes()           how much room the runs take
 *
 * Node 8: plain ES2017.
 */
const fs = require('fs');
const path = require('path');
const { recordKey } = require('./tests');

class Store {
    constructor(dataDir, log) {
        this.dir = path.join(dataDir, 'runs');
        this.log = log || { warn() {}, info() {} };
        try { fs.mkdirSync(this.dir); } catch (e) { /* there */ }
        this.runs = [];
        this.load();
    }

    load() {
        let files = [];
        try { files = fs.readdirSync(this.dir).filter((f) => /^run-\d+\.json$/.test(f)); } catch (e) { /* none */ }
        this.runs = [];
        for (const f of files) {
            try {
                const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
                const size = fs.statSync(path.join(this.dir, f)).size;
                delete r.trace;
                this.runs.push(Object.assign(r, { id: f.replace(/\.json$/, ''), size }));
            } catch (e) { this.log.warn('run ' + f + ': ' + e); }
        }
        this.runs.sort((a, b) => b.at - a.at);
        this.recompute();
    }

    add(run) {
        let at = run.at || Date.now();
        while (this.runs.some((r) => r.id === 'run-' + at)) at++;
        const id = 'run-' + at, file = path.join(this.dir, id + '.json');
        const body = JSON.stringify(Object.assign({}, run, { at }));
        try { fs.writeFileSync(file, body); } catch (e) { this.log.warn('save run: ' + e); return null; }
        const meta = Object.assign({}, run, { at, id, size: body.length });
        delete meta.trace;
        this.runs.unshift(meta);
        this.recompute();
        return id;
    }

    list(kind) { return kind ? this.runs.filter((r) => r.kind === kind) : this.runs; }

    get(id) {
        try { return Object.assign(JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8')), { id }); } catch (e) { return null; }
    }

    remove(id) {
        try { fs.unlinkSync(path.join(this.dir, id + '.json')); } catch (e) { this.log.warn('delete ' + id + ': ' + e); }
        this.runs = this.runs.filter((r) => r.id !== id);
        this.recompute();
    }

    clear(kind) {
        this.runs.filter((r) => !kind || r.kind === kind).forEach((r) => {
            try { fs.unlinkSync(path.join(this.dir, r.id + '.json')); } catch (e) { /* gone */ }
        });
        this.runs = kind ? this.runs.filter((r) => r.kind !== kind) : [];
        this.recompute();
    }

    bytes() { return this.runs.reduce((n, r) => n + (r.size || 0), 0); }

    /** Records: the best corrected time per record key (rollout or not for standing starts). */
    recompute() {
        const best = {};
        for (const r of this.runs) {
            for (const x of r.results || []) {
                if (typeof x.timeCorr !== 'number') continue;
                const k = (r.demo ? 'demo|' : '') + recordKey(x, r.rollout);
                if (!best[k] || x.timeCorr < best[k].time) best[k] = { time: x.timeCorr, id: r.id };
            }
        }
        this.best = best;
    }

    /** The record for a test; demo runs keep their own (they never count as the car's). */
    record(test, rollout, demo) { return this.best[(demo ? 'demo|' : '') + recordKey(test, rollout)] || null; }
}

module.exports = { Store };
