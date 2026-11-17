'use strict';
/**
 * files.js - the Files page's data: what the app saved under its data folder (CSV captures in
 * Logs, dyno runs in Dyno, drag runs in Drag), to list, look at and delete on the head unit.
 *
 *   const files = require('./files');
 *   files.FOLDERS                          [{ key: 'Logs' | 'Dyno' | 'Drag', label }]
 *   files.list(dataDir, key)               [{ name, file, bytes, mtime, title, sub, runId }], newest first
 *   files.usage(dataDir)                   { Logs: { count, bytes }, Dyno: ..., Drag: ..., bytes }
 *   files.remove(file)                     deletes one file (true when it went)
 *   files.removeAll(dataDir, key, keep)    deletes a folder's files but `keep` (a path); returns how many
 *   files.csvSummary(file, ids, done)      reads a capture as a stream (they can be tens of MB: the
 *                                          head unit must not stall), done(err, summary)
 *
 * Runs on the head unit's Node 8: plain ES2017.
 */
const fs = require('fs');
const path = require('path');

const FOLDERS = [
    { key: 'Logs', label: 'Captures (CSV logs)', ext: '.csv' },
    { key: 'Dyno', label: 'Dyno runs', ext: '.json' },
    { key: 'Drag', label: 'Drag runs', ext: '.json' },
];
/** Series kept for the capture's chart: at most this many points (every k-th sample, k doubling). */
const SERIES_POINTS = 1200;

const folderOf = (key) => FOLDERS.find((f) => f.key === key);
const pad = (n) => (n < 10 ? '0' : '') + n;
const when = (ms) => {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};
const size = (bytes) => (!bytes ? '0 KB' : bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');

/** A run file's name and id, read once per file version (the JSON of a dyno run holds its samples). */
const runCache = new Map();
function runInfo(file, mtime) {
    const c = runCache.get(file);
    if (c && c.mtime === mtime) return c.info;
    let info = null;
    try {
        const run = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (run && run.id && run.result) info = { id: String(run.id), name: String(run.name || run.id), createdAt: run.createdAt };
    } catch (e) { /* not a run */ }
    runCache.set(file, { mtime, info });
    return info;
}

/** "Boostline_2026-11-12_19-13-05.csv" -> "2026-11-12 19:13:05" (else the name). */
function captureTitle(name) {
    const m = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
    return m ? m[1] + ' ' + m[2] + ':' + m[3] + ':' + m[4] : name;
}

function list(dataDir, key) {
    const f = folderOf(key);
    if (!f) return [];
    const dir = path.join(dataDir, key);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(f.ext)); } catch (e) { return []; }
    const out = [];
    names.forEach((name) => {
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch (e) { return; }
        if (!st.isFile()) return;
        const item = { name, file, bytes: st.size, mtime: st.mtimeMs || st.mtime.getTime(), title: name, sub: '', runId: null };
        if (key === 'Logs') {
            item.title = 'Capture ' + captureTitle(name);
            item.sub = size(st.size);
        } else {
            const info = runInfo(file, item.mtime);
            if (!info) return;
            item.title = info.name;
            item.runId = info.id;
            item.sub = when(item.mtime);
        }
        out.push(item);
    });
    return out.sort((a, b) => b.mtime - a.mtime);
}

function usage(dataDir) {
    const out = { bytes: 0 };
    FOLDERS.forEach((f) => {
        const items = list(dataDir, f.key);
        const bytes = items.reduce((n, i) => n + i.bytes, 0);
        out[f.key] = { count: items.length, bytes };
        out.bytes += bytes;
    });
    return out;
}

function remove(file) {
    try { fs.unlinkSync(file); runCache.delete(file); return true; } catch (e) { return false; }
}

function removeAll(dataDir, key, keep) {
    let n = 0;
    list(dataDir, key).forEach((i) => { if (i.file !== keep && remove(i.file)) n++; });
    return n;
}

/** One CSV cell as a number (empty / not a number: NaN). */
const cellNum = (s) => (s === '' || s === undefined ? NaN : Number(s));

/**
 * Reads a capture: the meta lines ("# key=value", ids= the channel ids), the header (names and
 * units), then every row, keeping per channel min / max / mean and, for `ids`, a thinned series
 * for a chart. done(err, { meta, ids, names, units, rows, duration, stats: { id: { min, max, mean } },
 * series: { t: [], <id>: [] } }).
 */
function csvSummary(file, chartIds, done) {
    const meta = {};
    let ids = null, names = null, unitsOf = null, rows = 0, lastT = NaN;
    let mins = [], maxs = [], sums = [], counts = [];
    const series = { t: [] };
    let cols = [], stride = 1, kept = 0;
    let rest = '', header = false, failed = false;
    const finish = (err) => {
        if (failed) return;
        failed = true;
        if (err) { done(err); return; }
        const stats = {};
        (ids || []).forEach((id, k) => {
            if (counts[k]) stats[id] = { min: mins[k], max: maxs[k], mean: sums[k] / counts[k] };
        });
        done(null, { meta, ids: ids || [], names: names || [], units: unitsOf || [], rows, duration: isFinite(lastT) ? lastT : 0, stats, series });
    };
    const line = (l) => {
        if (!l) return;
        if (!header) {
            if (l.charCodeAt(0) === 0xfeff) l = l.slice(1);
            if (l.charAt(0) === '#') {
                const body = l.slice(1).trim(), eq = body.indexOf('=');
                if (eq > 0) meta[body.slice(0, eq).trim()] = body.slice(eq + 1).trim();
                return;
            }
            // the header: "Time [s],Name [unit],...": names and units in the ids' order
            header = true;
            const cells = splitCsv(l).slice(1);
            names = cells.map((c) => c.replace(/\s*\[[^\]]*\]$/, ''));
            unitsOf = cells.map((c) => { const m = /\[([^\]]*)\]$/.exec(c); return m ? m[1] : ''; });
            ids = meta.ids ? meta.ids.split(',') : names.map((n, i) => 'col' + i);
            mins = ids.map(() => Infinity); maxs = ids.map(() => -Infinity); sums = ids.map(() => 0); counts = ids.map(() => 0);
            cols = chartIds.map((id) => ids.indexOf(id));
            chartIds.forEach((id) => { series[id] = []; });
            return;
        }
        const cells = l.split(',');
        const t = cellNum(cells[0]);
        if (!isFinite(t)) return;
        rows++;
        lastT = t;
        for (let k = 0; k < ids.length; k++) {
            const v = cellNum(cells[k + 1]);
            if (!isFinite(v)) continue;
            if (v < mins[k]) mins[k] = v;
            if (v > maxs[k]) maxs[k] = v;
            sums[k] += v;
            counts[k]++;
        }
        if (rows % stride === 0) {
            series.t.push(t);
            chartIds.forEach((id, j) => series[id].push(cols[j] >= 0 ? cellNum(cells[cols[j] + 1]) : NaN));
            kept++;
            if (kept >= SERIES_POINTS) {
                // thin: every other point, and from now on every 2k-th row
                const half = (a) => a.filter((v, i) => i % 2 === 0);
                series.t = half(series.t);
                chartIds.forEach((id) => { series[id] = half(series[id]); });
                kept = series.t.length;
                stride *= 2;
            }
        }
    };
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 }); } catch (e) { finish(e); return; }
    stream.on('data', (chunk) => {
        const parts = (rest + chunk).split(/\r\n|\n|\r/);
        rest = parts.pop();
        try { parts.forEach(line); } catch (e) { stream.destroy(); finish(e); }
    });
    stream.on('error', (e) => finish(e));
    stream.on('end', () => { try { line(rest); } catch (e) { finish(e); return; } finish(null); });
}

/** A CSV line's cells ("" quoting). */
function splitCsv(l) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
        const c = l.charAt(i);
        if (q) {
            if (c === '"' && l.charAt(i + 1) === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
}

module.exports = { FOLDERS, list, usage, remove, removeAll, csvSummary, size, when, captureTitle };
