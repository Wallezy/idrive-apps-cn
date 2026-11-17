require('./app.js');
// Translation by: 抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430
// https://github.com/JackieZ123430/idrive7-apps-cn
'use strict';
/**
 * Boostline on the iDrive 7 head unit: live engine data, CSV logs, road dyno and drag timer from the
 * DME, read-only.
 *
 * Boostline's own Session (boostline-core.js, bundled from vendor/boostline by tools/bundle.js)
 * talks UDS to the DME over the head unit's diagnostic transport (tasu-link.js): the same channel
 * set, batching, dynamically defined DIDs, OBD-II fallback and CSV format as the desktop app. The
 * dyno and the drag timer are Boostline's too (runs.js on its detectors and analysis).
 *
 * Fast mode: on Drag and Dyno only engine speed, vehicle speed, pedal and gear are read, so the
 * samples come several times faster; the other pages get their channels back when shown (not while
 * a capture runs: a CSV keeps its columns).
 *
 * Pages (header tabs, Next page):
 *   Boost & fuel, Timing, Engine   value tiles; an actual / target pair shares a tile with a bar for
 *                                  how far apart they are; a trace of the last 12 s under the value
 *   Channels                       every channel streamed (and so captured) with its value, and Choose
 *                                  channels: the picker (picker.js) for what to stream, saved in
 *                                  <data>/boostline-app.json; by default what the tiles show
 *   Dyno                          Arm run, then a full-throttle pull in one gear: engine power, wheel
 *                                  power and torque against rpm, the peaks, the previous run dashed
 *   Drag                           Arm run, then a standing start (or through the start speed): the
 *                                  time, trap speed, splits and the speed trace with the shifts
 *   Status                         the connection (VIN, DME, its data), sample rate, the transport's
 *                                  numbers, the capture and Boostline's log
 * The first button is the page's action: Start / Stop capture on the live pages (every streamed
 * channel to <data>/Logs/Boostline_<date>.csv, as on the desktop), Arm run / Disarm on Dyno and Drag
 * (runs saved to <data>/Dyno and <data>/Drag in the desktop app's format). Setup page: the tiles of
 * a live page (picker.js tileSheet, saved in <data>/boostline-app.json and streamed with the rest),
 * the run on Drag, the channels to stream on Channels.
 *
 * Runs on the head unit's Node 8: plain ES2017, no ?. / ?? / optional catch binding.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const core = require('./boostline-core');
const { TasuLink } = require('./tasu-link');
const { DynoRuns, DragRuns, modeName } = require('./runs');
const picker = require('./picker');
const files = require('./files');
const { BusValues } = require('./bus');
const { Awake } = require('./awake');
const vdyno = require('./vdyno');
/** The channels a capture's view charts and sums up, in this order (those the capture has). */
const CAPTURE_STATS = ['engine.rpm', 'vehicle.speed', 'throttle.pedal', 'boost.actual', 'load.torque.actual', 'bus.torque', 'power.bus', 'fuel.inj_qty', 'fuel.rail.actual',
    'turbo.vnt.actual', 'exhaust.egt_manifold', 'exhaust.egt_pre_dpf', 'fuel.lambda.actual', 'temp.coolant', 'bus.oil', 'temp.oil', 'dpf.soot_measured'];
const { pill } = require('./kit/sheet');

/** A tile is an id, or alternatives of which the first streamed one shows (the DME's, else OBD-II's). */
/**
 * `engine` limits a page to petrol ('petrol') or diesel ('diesel') engine ECUs; the diesel pages
 * appear once a DDE's channels are known (see isDiesel), the petrol-only ones then go away.
 */
const PAGES = [
    // petrol (DME): the original Boostline pages
    { name: 'Boost & fuel', engine: 'petrol', ids: ['engine.rpm', 'throttle.pedal', 'boost.actual', 'boost.target', 'fuel.lambda.actual', 'fuel.lambda.target',
        'fuel.rail.actual', 'fuel.rail.target', 'boost.wg_actual', 'boost.wg_target', 'temp.intake', 'load.torque.actual'] },
    // diesel (DDE)
    { name: 'Boost & fuel', engine: 'diesel', ids: ['engine.rpm', 'throttle.pedal', 'boost.actual', 'boost.target', 'fuel.rail.actual', 'fuel.rail.target',
        'fuel.lambda.actual', 'fuel.lambda.target', 'fuel.inj_qty', 'fuel.inj_qty_target', 'temp.intake', 'exhaust.egt_pre_cat'] },
    // torque and power from the sport displays, with what goes with them
    { name: 'Power', ids: ['engine.rpm', 'throttle.pedal', 'boost.actual', 'boost.target', 'bus.torque_sport', 'bus.power_sport', 'temp.intake'] },
    { name: 'Turbo', engine: 'diesel', ids: ['engine.rpm', 'boost.actual', 'boost.target', 'turbo.hp_bypass.actual', 'turbo.hp_bypass.target',
        'turbo.lp_vnt.actual', 'turbo.lp_vnt.target', 'exhaust.pre_turbine_abs', 'exhaust.egt_pre_cat', 'temp.intake', 'egr.hp.actual', 'egr.hp.target'] },
    { name: 'DPF', engine: 'diesel', ids: ['dpf.soot_measured', 'dpf.soot_simulated', 'dpf.diff_pressure', 'dpf.dist_since_regen',
        'exhaust.egt_pre_dpf', 'dpf.regen_request', 'dpf.regen_active', ['scr.adblue_range', 'scr.adblue_level']] },
    { name: 'Timing', engine: 'petrol', ids: [['ign.avg', 'obd.timing_advance'], 'ign.cyl1', 'ign.cyl2', 'ign.cyl3', 'ign.cyl4', 'ign.cyl5', 'ign.cyl6', 'engine.rpm'] },
    { name: 'Engine', engine: 'petrol', ids: ['vehicle.speed', 'vehicle.gear', 'temp.coolant', ['bus.oil', 'temp.oil'], 'throttle.position', 'throttle.target',
        'vanos.intake.actual', 'vanos.intake.target', ['load.maf', 'obd.maf'], 'elec.battery'] },
    { name: 'Engine', engine: 'diesel', ids: ['engine.rpm', 'vehicle.speed', 'vehicle.gear', 'temp.coolant', ['bus.oil', 'temp.oil'],
        ['bus.gearbox_oil', 'temp.trans'], 'elec.battery'] },
    { name: 'Channels', kind: 'channels', ids: [] },
    { name: 'Dyno', kind: 'dyno', ids: [] },
    { name: 'Drag', kind: 'drag', ids: [] },
    { name: 'Files', kind: 'files', ids: [] },
    { name: 'Status', kind: 'status', ids: [] },
];
/** The weather the dyno corrects for, read from the car when a run is armed. */
const ENV_IDS = ['boost.ambient', 'temp.ambient'];
/**
 * Unless the channel picker says otherwise, what the tiles show is streamed (and captured) at once:
 * switching pages doesn't restart the stream. (Session adds rpm, speed, pedal and gear, which the
 * dyno and drag timer need, by itself.)
 */
/** The most tiles a page shows. */
const TILES = 8;
/** The pages that read only what they need (fast mode). */
const FAST_KINDS = ['drag', 'dyno'];
/** Channels only a diesel ECU (DDE) has: their presence switches the pages to the diesel set. */
const DIESEL_MARKERS = ['turbo.vnt.actual', 'fuel.inj_qty', 'dpf.soot_measured', 'egr.hp.actual'];
const isDiesel = (channels) => DIESEL_MARKERS.some((id) => channels.has(id));

/**
 * Actual -> target pairs that share a tile, with the distance (native units) that fills the bar.
 * (as PAIRS in Boostline's src/renderer/src/live/LiveTiles.tsx)
 */
const PAIRS = {
    'boost.actual': { target: 'boost.target', span: 0.2 },
    'fuel.lambda.actual': { target: 'fuel.lambda.target', span: 0.05 },
    'fuel.rail.actual': { target: 'fuel.rail.target', span: 20 },
    'throttle.position': { target: 'throttle.target', span: 10 },
    'boost.wg_actual': { target: 'boost.wg_target', span: 10 },
    'load.engine': { target: 'load.engine_target', span: 20 },
    'load.maf': { target: 'load.maf_target', span: 50 },
    'load.torque.actual': { target: 'load.torque.target', span: 50 },
    'vanos.intake.actual': { target: 'vanos.intake.target', span: 5 },
    'vanos.exhaust.actual': { target: 'vanos.exhaust.target', span: 5 },
    'turbo.vnt.actual': { target: 'turbo.vnt.target', span: 10 },
    'turbo.hp_bypass.actual': { target: 'turbo.hp_bypass.target', span: 10 },
    'turbo.lp_vnt.actual': { target: 'turbo.lp_vnt.target', span: 10 },
    'egr.hp.actual': { target: 'egr.hp.target', span: 10 },
    'egr.lp.actual': { target: 'egr.lp.target', span: 10 },
    'fuel.inj_qty': { target: 'fuel.inj_qty_target', span: 5 },
    'load.air_per_stroke': { target: 'load.air_per_stroke_target', span: 50 },
};

const COLS = 4, ROWS = 2, GAP = 14, SIDE = 16;
const TRACE_S = 12, TRACE_STEP_S = 0.1;
const RETRY_MS = 5000;
const LOG_LINES = 200;
/** Captures stop being started above this much in Logs/ (the app's disk quota is maxDiskUsage in app.json). */
const LOGS_LIMIT = 96 * 1024 * 1024;
/** How long the closed-course notice waits for the second press of Arm run. */
const CONFIRM_MS = 15000;
const DYNO_KEYS = ['dynoMass', 'dynoLoss', 'dynoBody', 'dynoCorrection'];

/** The kit's fonts have no λ, and λ is a ratio: the value stands alone. */
const unitText = (label) => (label === 'λ' ? '' : label === '°CRK' ? '°' : label);
/**
 * The engine ECU's name as BMW calls it: DDE (diesel) or DME (petrol), DDE/DME until the car's ECU is
 * known (its channels, or the BMW data picked for it).
 */
let ecuKind = null;
const E = () => (ecuKind === 'diesel' ? 'DDE' : ecuKind === 'petrol' ? 'DME' : 'DDE/DME');
/** The core's messages say DME (petrol and diesel alike): in the connected ECU's name. */
const ddeText = (s) => String(s).replace(/\bDDE\/DME\b|\bDME\b/g, E());
picker.ECU.name = E;
const isNum = (v) => typeof v === 'number' && isFinite(v);
/** A channel whose values are states (0 / 1 ...): the state's word, else null (shown as a number). */
const stateText = (def, v) => (def && def.states && isNum(v) && def.states[Math.round(v)] !== undefined ? def.states[Math.round(v)] : null);
const clock = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
/** s cut to fit w px at this size (an ellipsis where it was cut). */
function fit(cv, s, size, w, opt) {
    if (cv.textWidth(s, size, opt) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '…', size, opt) > w) n--;
    return s.slice(0, n) + '…';
}
/** A round axis step so that n steps reach at least max. */
/**
 * A value axis from 0 that the data fills: the nice step (1, 2, 2.5, 5 x 10^k) and count of divisions
 * (minDiv..maxDiv) that leave the least room over max (at least 3 %). Returns { step, n }.
 */
function fillAxis(max, minDiv, maxDiv) {
    const top = Math.max(max, 1e-9) * 1.03;
    let best = null;
    for (let n = minDiv; n <= maxDiv; n++) {
        const raw = top / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
        const m = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10].find((x) => x * p * n >= top - 1e-9);
        const step = m * p, over = step * n - top;
        if (!best || over < best.over - 1e-9) best = { step, n, over };
    }
    return { step: best.step, n: best.n };
}

/**
 * A curve through the points [x, y] (sorted by x) for drawing: monotone cubic (Fritsch-Carlson), so it
 * rounds the corners without overshooting a point; `sub` pieces between two points.
 */
function curve(pts, sub) {
    sub = sub || 6;
    const p = pts.filter((q) => isNum(q[0]) && isNum(q[1]));
    const n = p.length;
    if (n < 3) return p;
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / ((p[i + 1][0] - p[i][0]) || 1));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
        const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
        if (h > 9) { const s = 3 / Math.sqrt(h); m[i] = s * a * d[i]; m[i + 1] = s * b * d[i]; }
    }
    const out = [];
    for (let i = 0; i < n - 1; i++) {
        const x0 = p[i][0], y0 = p[i][1], x1 = p[i + 1][0], y1 = p[i + 1][1], h = x1 - x0;
        for (let k = 0; k < sub; k++) {
            const u = k / sub, u2 = u * u, u3 = u2 * u;
            out.push([x0 + u * h, (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * h * m[i + 1]]);
        }
    }
    out.push(p[n - 1]);
    return out;
}

function axisStep(max, n) {
    const raw = Math.max(max, 1e-9) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p * n >= max) return m * p;
    return 10 * p;
}

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        let page = 0;
        let channels = new Map();          // id -> ChannelDef of the connected car
        /** The pages for the connected engine (petrol until a DDE's channels say otherwise). */
        const pages = () => {
            const engine = isDiesel(channels) ? 'diesel' : 'petrol';
            return PAGES.filter((p) => !p.engine || p.engine === engine);
        };
        const curPage = () => { const list = pages(); if (page >= list.length) page = 0; return list[page]; };
        const latest = new Map();          // id -> last value (native units)
        const traces = new Map();          // id -> [values], one per TRACE_STEP_S, oldest first
        let traceT = -Infinity;
        let status = { state: 'disconnected' };
        let note = '';                     // a short message on the page (capture refused, run saved, ...)
        let noteUntil = 0;
        const say = (s, ms) => { note = s; noteUntil = Date.now() + (ms || 6000); };
        const lines = [];
        const addLine = (s) => { lines.push(s); if (lines.length > LOG_LINES) lines.shift(); };

        // what the app remembers between starts (the closed-course notice was acknowledged)
        const stateFile = path.join(ctx.dataDir, 'boostline-app.json');
        let appState = {};
        try { appState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { appState = {}; }
        const saveState = () => { try { fs.writeFileSync(stateFile, JSON.stringify(appState)); } catch (e) { log.warn('state: ' + e.message); } };
        let confirmUntil = 0;              // the closed-course notice is up, waiting for the second press
        // the channels to stream: the user's list from the picker, or (null) what the pages show on this car
        let logChoice = Array.isArray(appState.logChannels) ? appState.logChannels.map(String) : null;
        // the tiles chosen with Setup page: { page name: [ids] } (a page without one shows its own)
        if (!appState.pageTiles || typeof appState.pageTiles !== 'object') appState.pageTiles = {};
        // 0.8.0 has new default tiles on every page: the earlier choices go, once
        if (appState.tileDefaults !== 2) { appState.pageTiles = {}; appState.tileDefaults = 2; saveState(); }
        const customTiles = (p) => (Array.isArray(appState.pageTiles[p.name]) ? appState.pageTiles[p.name].map(String) : null);
        /** an actual's target too, so that the pair shares its tile */
        const withTargets = (ids) => {
            const out = [];
            ids.forEach((id) => {
                if (out.indexOf(id) < 0) out.push(id);
                const pair = PAIRS[id];
                if (pair && out.indexOf(pair.target) < 0) out.push(pair.target);
            });
            return out;
        };
        /** what a page shows: the tiles chosen for it, else its own entries */
        const pageEntries = (p) => { const c = customTiles(p); return c ? withTargets(c) : p.ids; };
        const allEntries = () => pages().reduce((all, p) => all.concat(pageEntries(p)), []).concat(ENV_IDS);
        const chosenTiles = () => pages().reduce((all, p) => { const c = customTiles(p); return c ? all.concat(withTargets(c)) : all; }, []);
        // the channels the user chose stream; with them, first, the tiles of the page shown (what's on screen is
        // always read, chosen or not) and the tiles chosen with Setup page
        const wanted = () => {
            if (!logChoice) return picker.defaultIds(allEntries(), channels);
            const out = curPage() ? picker.defaultIds(pageEntries(curPage()), channels) : [];
            chosenTiles().concat(logChoice).forEach((id) => { if (out.indexOf(id) < 0) out.push(id); });
            return out;
        };
        let streamed = new Set();          // what Session streams now (the last batch's channels)
        // Fast mode: on Drag and Dyno only what they time and measure is read (rpm, speed, pedal,
        // gear), so the samples come several times faster; the other pages get their channels back
        // when shown. A capture keeps its channels: no fast mode while one runs.
        const fastMode = () => FAST_KINDS.indexOf(kind()) >= 0 && !status.recording;
        const streamIds = () => (fastMode() ? picker.REQUIRED.slice() : BusValues.withNeeds(wanted()));
        /** Session reads streamIds() (it switches only on a real change, after a capture when one runs) */
        const applyStream = () => { session.setStreamChannels(streamIds()).catch((e) => log.error('stream', e)); };
        let streamedFrom = null;
        let listY = 0, listMax = 0;        // the Channels page's list: scrolled by, how far it can
        let captureView = null;            // the Files page's capture: { item, loading, summary, error }

        const units = () => Object.assign({}, core.DEFAULT_UNITS, {
            pressure: settings.get('pressure'), temperature: settings.get('temperature'), speed: settings.get('speed'),
            lambda: settings.get('lambda'), power: settings.get('power'), torque: settings.get('torque'),
        });

        const dyno = new DynoRuns(core, path.join(ctx.dataDir, 'Dyno'));
        const drag = new DragRuns(core, path.join(ctx.dataDir, 'Drag'));
        // the weather of the last dyno run (baro, outside temperature): read from the car at every arm
        let dynoEnv = dyno.current ? { baroHpa: dyno.current.result.setup.baroHpa, ambientTempC: dyno.current.result.setup.ambientTempC } : {};
        // the pinned baseline run, drawn behind the run shown (Setup page on Dyno)
        dyno.baselineId = appState.dynoBaseline || null;
        // Virtual Dyno's setup (weight, losses, body shape) and Boostline's weather correction
        const dynoSetup = () => ({
            massKg: Number(settings.get('dynoMass')) || 1950, drivetrainLossPct: Number(settings.get('dynoLoss')) || 0,
            body: settings.get('dynoBody') || 'wagon', correction: settings.get('dynoCorrection') || 'none',
            baroHpa: isNum(dynoEnv.baroHpa) ? dynoEnv.baroHpa : 1013, ambientTempC: isNum(dynoEnv.ambientTempC) ? dynoEnv.ambientTempC : 20, humidityPct: 50,
        });
        dyno.setSetup(dynoSetup());
        const dragOpts = () => {
            const pct = Number(settings.get('dragSpeedo')) || 0, amb = latest.get('temp.ambient');
            return {
                // one point: the true speed is pct % above (below) the car's at every speed
                calibration: pct ? [{ ecu: 100, gps: 100 * (1 + pct / 100) }] : [],
                environment: { altitudeM: 0, ambientTempC: isNum(amb) ? Math.round(amb * 10) / 10 : 20, humidityPct: 50 },
            };
        };

        const link = new TasuLink(ctx.signals, log);
        await link.init();
        const session = core.createHeadUnitSession({
            dataDir: ctx.dataDir,
            link,
            settings: () => ({ units: units(), autoRecordWot: !!settings.get('autoRecordWot'), bmwDme: settings.get('bmwDme') }),
        });
        // torque and power from the car's own signals (no diagnostic requests), as channels of the session
        const bus = new BusValues(ctx.signals, log, () => ({ nm: Number(settings.get('sportMaxTorque')), kw: Number(settings.get('sportMaxPower')) }));
        bus.start();
        // the dyno runs on the car's own signals (as Virtual Dyno): engine speed, speed, the DSC's acceleration
        let busLost = null;
        bus.onSample((d, t) => {
            if (!dyno.armed) return;
            clearTimeout(busLost);
            busLost = setTimeout(() => dyno.lost(), 1500);
            const run = dyno.feed(d, t, { vin: status.vin, gear: latest.get('vehicle.gear') });
            if (run) dynoDone(run);
        });
        session.setExternalChannels(bus.channels());
        session.on('log', (m) => { log.info('boostline: ' + m); addLine(m); });
        session.on('channels', (list) => {
            // (a worked-out channel for one kind of engine only: not on the other)
            const engine = isDiesel(new Map(list.map((c) => [c.id, c]))) ? 'diesel' : 'petrol';
            if (engine === 'diesel' || list.some((c) => c.id === 'engine.rpm')) ecuKind = engine;
            channels = new Map(list.filter((c) => !c.engine || c.engine === engine).map((c) => [c.id, c])); latest.clear(); traces.clear(); streamed = new Set(); streamedFrom = null; });
        session.on('status', (s) => {
            const was = status.recording;
            status = s;
            // the BMW data the ECU was matched with: a diesel's SGBD is d70.., d75.., d83..
            const data = s.ecu && s.ecu.dmeData;
            if (data) ecuKind = /^d\d/i.test(data) ? 'diesel' : ecuKind || 'petrol';
            if (was && !s.recording) {
                addLine('Capture saved: ' + path.basename(was.file) + ' (' + was.samples + ' samples)');
                if (fastMode()) applyStream();       // on Drag or Dyno: fast mode now
            }
        });
        session.on('batch', (b) => {
            if (b.channelIds !== streamedFrom) { streamedFrom = b.channelIds; streamed = new Set(b.channelIds); }
            const at = (id) => b.channelIds.indexOf(id);
            const iRpm = at('engine.rpm'), iSpeed = at('vehicle.speed'), iGear = at('vehicle.gear');
            const v = (row, i) => (i >= 0 ? row[i] : NaN);
            for (let r = 0; r < b.rows.length; r++) {
                const row = b.rows[r], t = b.t[r];
                for (let i = 0; i < b.channelIds.length; i++) if (isNum(row[i])) latest.set(b.channelIds[i], row[i]);
                if (drag.armed) {
                    const run = drag.push(t, v(row, iSpeed), v(row, iGear), v(row, iRpm), status.vin);
                    if (run) dragDone(run);
                }
                if (t - traceT < TRACE_STEP_S) continue;
                traceT = t;
                for (let i = 0; i < b.channelIds.length; i++) {
                    const id = b.channelIds[i];
                    const tr = traces.get(id) || [];
                    tr.push(row[i]);
                    if (tr.length > TRACE_S / TRACE_STEP_S) tr.shift();
                    traces.set(id, tr);
                }
            }
        });

        function dynoDone(run) {
            const p = core.powerFromKw(run.result.peakEngine.kw, units().power);
            addLine('Dyno: ' + run.name + ', ' + p.toFixed(0) + ' ' + units().power + ' at ' + Math.round(run.result.peakEngine.rpm) + ' rpm');
            say('Pull captured and saved');
            dyno.setSetup(dynoSetup());
        }
        function dragDone(run) {
            const r = run.result;
            addLine('Drag: ' + run.name + (r.warnings.length ? ' (' + r.warnings[0] + ')' : ''));
            say(r.finished ? modeName(r.mode) + ': ' + r.finalTime.toFixed(2) + ' s, saved' : 'Run aborted: the speed dropped before the finish');
        }

        // connect, and again every few seconds while the DME doesn't answer (ignition off, transport down)
        // ...but only while the car is switched on: after it's switched off no request goes to the DDE, so the
        // car's bus can go to sleep (otherwise: "Energy management: a service could not be switched off")
        const awake = new Awake(ctx.signals, log);
        // ...and only once Power on is pressed (the app opens switched off, and switches off by itself when
        // it's left): no request goes to the DDE while nobody looks at it
        let powered = false, leaveTimer = null;
        const reading = () => awake.on && powered;
        let retry = null;
        const connect = async () => {
            clearTimeout(retry); retry = null;
            if (!reading()) return;
            if (!link.ready) { status = { state: 'error', error: 'No diagnostic link: ' + (link.error || 'TASU unavailable') }; return; }
            const s = await session.connect(core.HEAD_UNIT_CONNECTION);
            if (s.state === 'error') { addLine('Connect: ' + s.error); if (reading()) retry = setTimeout(connect, RETRY_MS); return; }
            if (!reading()) { await session.disconnect(); return; }
            await session.setStreamChannels(streamIds());
        };
        addLine('ECU Live Data on Boostline ' + core.BOOSTLINE_VERSION + ' core, ' + (logChoice ? logChoice.length + ' channels chosen' : 'the pages\' channels'));
        awake.onChange((on) => {
            if (!on) {
                clearTimeout(retry); retry = null;
                addLine('Car switched off: no more requests to the ' + E() + ' until the ignition is on');
                session.disconnect().catch((e) => log.warn('disconnect: ' + e));
            } else if (powered && status.state !== 'live' && status.state !== 'connecting') {
                addLine('Ignition on: reading the ' + E());
                connect().catch((e) => log.error('connect', e));
            }
        });
        /** Power on / off: reading the DDE (the dyno reads the car's own signals either way). */
        function setPower(on, why) {
            clearTimeout(leaveTimer); leaveTimer = null;
            if (on === powered) return;
            powered = on;
            Promise.resolve(ui.text('BTN_POWER', on ? 'Power off' : 'Power on')).catch(() => {});
            if (on) {
                addLine('Power on: reading the ' + E());
                if (!awake.on) say('The car is switched off: reading starts with the ignition', 5000);
                connect().catch((e) => log.error('connect', e));
            } else {
                clearTimeout(retry); retry = null;
                if (drag.armed) drag.disarm();
                addLine('Power off' + (why ? ' (' + why + ')' : '') + ': no requests to the ' + E());
                session.disconnect().catch((e) => log.warn('disconnect: ' + e));
            }
        }
        // left the app (its screen and its settings hidden for a few seconds): power off by itself
        const shownNow = () => ui.isVisible('MAIN') || ui.isVisible('SETTINGS');
        ui.onVisible(() => {
            if (shownNow()) { clearTimeout(leaveTimer); leaveTimer = null; return; }
            if (!powered || leaveTimer) return;
            leaveTimer = setTimeout(() => { leaveTimer = null; if (!shownNow()) setPower(false, 'app left'); }, 3000);
        });
        awake.start();
        connect().catch((e) => log.error('connect', e));

        /** The first button follows the page: capture on the live pages, Arm run on Dyno and Drag. */
        const kind = () => curPage().kind || 'live';
        function actionLabel() {
            if (kind() === 'dyno') return dyno.armed ? 'Disarm' : 'Arm run';
            if (kind() === 'drag') return drag.armed ? 'Disarm' : 'Arm run';
            if (kind() === 'files') return 'Browse files';
            return status.recording ? 'Stop capture' : 'Start capture';
        }
        let shownLabel = 'Start capture';
        function syncLabel() {
            const l = actionLabel();
            if (l === shownLabel) return;
            shownLabel = l;
            Promise.resolve(ui.text('BTN_REC', l)).catch(() => {});
        }

        async function capture() {
            if (status.recording) { await session.stopRecording(); return; }
            if (!powered) { setPower(true); say('Power on: connecting to the ' + E() + ' - press Start capture again once live', 6000); return; }
            if (status.state !== 'live') { say('Not connected to the engine ECU (' + E() + ')'); return; }
            if (core.folderBytes(path.join(ctx.dataDir, 'Logs')) > LOGS_LIMIT) { say('Logs folder full: copy the logs off and delete them', 10000); return; }
            const r = await session.startRecording();
            addLine('Capture: ' + path.basename(r.file));
        }

        function armOrDisarm(runs) {
            if (runs.armed) { runs.disarm(); say('Disarmed', 2500); return; }
            // (the dyno reads the car's own signals: it needs no DDE)
            if (runs === drag && !powered) { setPower(true); say('Power on: connecting to the ' + E() + ' - press Arm run again once live', 6000); return; }
            if (runs === drag && status.state !== 'live') { say('Not connected to the engine ECU (' + E() + ')'); return; }
            // once: pulls and drag runs belong on a closed course (the desktop app asks the same)
            if (!appState.closedCourseNotice) {
                if (Date.now() > confirmUntil) { confirmUntil = Date.now() + CONFIRM_MS; return; }
                appState.closedCourseNotice = true;
                saveState();
            }
            confirmUntil = 0;
            if (runs === dyno) {
                // the weather for the correction: from the DDE when it's read, else the last run's
                const baro = latest.get('boost.ambient'), amb = latest.get('temp.ambient');
                if (isNum(baro)) dynoEnv.baroHpa = Math.round(baro * 1000);
                if (isNum(amb)) dynoEnv.ambientTempC = Math.round(amb * 10) / 10;
                dyno.arm(dynoSetup());
            } else {
                drag.arm(settings.get('dragMode'), dragOpts());
            }
        }

        /** The channel picker, over the page (the kit draws it: GPU renderer, full-screen layout). */
        function choose() {
            if (!channels.size) { say(powered ? 'Not connected to the engine ECU (' + E() + '): its channels aren\'t known yet' : 'Press Power on first: the ' + E() + '\'s channels come with it', 6000); return; }
            const sh = picker.channelSheet({
                channels: () => channels,
                groups: core.GROUP_ORDER,
                wanted: wanted(),
                isDefault: !logChoice,
                defaults: () => picker.defaultIds(allEntries(), channels),
                max: core.MAX_STREAMED,
                unit: (def) => unitText(core.displayUnitFor(def, units()).label),
                done: (c) => {
                    logChoice = c.isDefault ? null : c.ids;
                    if (logChoice) appState.logChannels = logChoice; else delete appState.logChannels;
                    saveState();
                    addLine('Channels: ' + (logChoice ? logChoice.length + ' chosen' : 'the pages\' channels'));
                    // a capture keeps its columns: Session switches when it stops
                    if (status.recording) say('The new channels apply when the capture stops', 8000);
                    applyStream();
                },
            });
            if (!ctx.sheet(sh)) say('The picker needs Screen layout: Full screen and Renderer: GPU (Settings)', 10000);
        }
        /** Setup page on Dyno: pin the run shown as the baseline drawn behind the others, or clear it. */
        function dynoSheet() {
            const cur = dyno.current, pinned = dyno.runs.find((r) => r.id === dyno.baselineId) || null;
            const options = [['none', 'No baseline']];
            if (pinned) options.push([pinned.id, 'Baseline: ' + pinned.name]);
            if (cur && (!pinned || cur.id !== pinned.id)) options.push([cur.id, 'Pin the run shown: ' + cur.name]);
            const sh = picker.choiceSheet({
                title: 'Setup page', head: 'Setup page: Dyno - the baseline drawn behind every run (weight, losses: Settings)',
                options, current: pinned ? pinned.id : 'none',
                done: (id) => {
                    dyno.baselineId = id === 'none' ? null : id;
                    if (dyno.baselineId) appState.dynoBaseline = dyno.baselineId; else delete appState.dynoBaseline;
                    saveState();
                    say(dyno.baselineId ? 'Baseline pinned' : 'Baseline cleared', 3000);
                },
            });
            if (!ctx.sheet(sh)) say('Setup needs Screen layout: Full screen and Renderer: GPU (Settings)', 10000);
        }
        /** Setup page: the tiles of a live page, the run on Drag, the streamed channels on Channels. */
        function setupPage() {
            const p = curPage(), k = kind();
            if (k === 'channels') { choose(); return; }
            if (k === 'drag') {
                if (drag.armed) { say('Disarm first to change the run'); return; }
                const spec = (ctx.spec.settings || []).find((x) => x.key === 'dragMode');
                const sh = picker.choiceSheet({
                    title: 'Setup page', head: 'Setup page: Drag - the run to time', options: spec.options, current: settings.get('dragMode'),
                    done: (m) => { settings.set('dragMode', m); say(modeName(m) + ': press Arm run', 4000); },
                });
                if (!ctx.sheet(sh)) say('Setup needs Screen layout: Full screen and Renderer: GPU (Settings)', 10000);
                return;
            }
            if (k === 'dyno') { dynoSheet(); return; }
            if (k === 'status') { say('Nothing to set up on this page', 3000); return; }
            if (k === 'files') { browseFiles(); return; }
            if (!channels.size) { say(powered ? 'Not connected to the engine ECU (' + E() + '): its channels aren\'t known yet' : 'Press Power on first: the ' + E() + '\'s channels come with it', 6000); return; }
            const own = () => picker.defaultIds(p.ids, channels).filter((id) => channels.has(id));
            const c = customTiles(p);
            const sh = picker.tileSheet({
                page: p.name,
                channels: () => channels,
                groups: core.GROUP_ORDER,
                chosen: c || own(),
                isDefault: !c,
                defaults: own,
                max: TILES,
                folded: (id, ids) => Object.keys(PAIRS).some((a) => PAIRS[a].target === id && ids.indexOf(a) >= 0),
                pairOf: (id) => (PAIRS[id] ? PAIRS[id].target : undefined),
                unit: (def) => unitText(core.displayUnitFor(def, units()).label),
                done: (res) => {
                    if (res.isDefault) delete appState.pageTiles[p.name];
                    else appState.pageTiles[p.name] = res.ids;
                    saveState();
                    addLine('Setup page ' + p.name + ': ' + (res.isDefault ? 'its own tiles' : res.ids.length + ' channels'));
                    if (status.recording) say('The new tiles stream when the capture stops', 8000);
                    applyStream();
                },
            });
            if (!ctx.sheet(sh)) say('Setup needs Screen layout: Full screen and Renderer: GPU (Settings)', 10000);
        }
        ctx.onScroll((dy) => {
            if (kind() !== 'channels') return false;
            const y = Math.max(0, Math.min(listMax, listY + dy));
            if (y === listY) return false;
            listY = y;
            return true;
        });

        ui.onClick('BTN_POWER', () => { setPower(!powered); return render(); });
        ui.onClick('BTN_REC', async () => {
            if (kind() === 'dyno') armOrDisarm(dyno);
            else if (kind() === 'drag') armOrDisarm(drag);
            else if (kind() === 'files') browseFiles();
            else await capture();
            return render();
        });
        ui.onClick('BTN_SETUP', () => { setupPage(); return render(); });
        /** A page change: fast mode on Drag and Dyno, the full set elsewhere. */
        function pageChanged() {
            confirmUntil = 0;
            if (FAST_KINDS.indexOf(kind()) >= 0 && status.recording) say('Capture running: all channels stay on. Stop it for fast mode', 6000);
            applyStream();
        }
        ui.onClick('BTN_PAGE', () => { page = (page + 1) % pages().length; pageChanged(); return render(); });
        ctx.onTab((i) => { page = i; pageChanged(); return render(); });
        settings.onChange((k) => {
            // Session reads these when it connects
            if ((k === 'autoRecordWot' || k === 'bmwDme') && !status.recording) connect().catch((e) => log.error('reconnect', e));
            // the run shown is analysed again with the new setup, as on the desktop
            if (DYNO_KEYS.indexOf(k) >= 0) dyno.setSetup(dynoSetup());
        });

        function render() {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            syncLabel();
            G.frame(cv, t, pages().map((p) => p.name), page, badges());
            const k = kind();
            if (k === 'status') statusPage(cv, t);
            else if (k === 'dyno') dynoPage(cv, t);
            else if (k === 'drag') dragPage(cv, t);
            else if (k === 'channels') channelsPage(cv, t);
            else if (k === 'files') filesPage(cv, t);
            else tilesPage(cv, t, pageEntries(curPage()));
            if (Date.now() < confirmUntil) closedCourse(cv, t);
            return ui.image('MAIN_GFX', cv);
        }

        function badges() {
            const out = [];
            if (status.recording) out.push({ text: 'REC ' + clock(Date.now() - status.recording.startedAt), color: 'crit' });
            if (dyno.armed) out.push({ text: dyno.state === 'recording' ? 'PULL' : 'DYNO ARMED', color: dyno.state === 'recording' ? 'crit' : 'warn' });
            if (drag.armed) out.push({ text: drag.state === 'running' ? 'RUN' : 'DRAG ARMED', color: drag.state === 'running' ? 'crit' : 'warn' });
            if (status.state === 'live' && fastMode()) out.push({ text: 'FAST ' + streamed.size + ' CH', color: 'dim' });
            if (status.state === 'live' && isNum(status.sampleRateHz)) out.push({ text: Math.round(status.sampleRateHz) + ' HZ', color: 'dim' });
            else if (!powered) out.push({ text: 'POWER OFF', color: 'dim' });
            else if (status.state !== 'live') out.push({ text: status.state === 'connecting' ? 'CONNECTING' : 'NO ' + E(), color: 'warn' });
            return out;
        }

        const pageTop = () => G.TOP + 10;
        const pageBottom = (cv) => G.pageBottom(cv) - 4;
        function noteLine(cv, t) {
            if (note && Date.now() < noteUntil) cv.text(note, cv.w - SIDE, pageBottom(cv), 20, t.warn, { align: 'right' });
        }

        /* ---------------- live tiles ---------------- */

        /** The page's tiles: channels streamed (the first of alternatives), a target folded into its actual's tile. */
        function tilesOf(entries) {
            const shown = [];
            entries.forEach((e) => {
                // the one read, else the first the car offers (its tile shows -- until it's read)
                const alts = Array.isArray(e) ? e : [e];
                const id = alts.find((x) => streamed.has(x) && channels.has(x)) || alts.find((x) => channels.has(x));
                if (id && shown.indexOf(id) < 0) shown.push(id);
            });
            const folded = new Set(shown.filter((id) => Object.keys(PAIRS).some((a) => PAIRS[a].target === id && shown.indexOf(a) >= 0)));
            return shown.filter((id) => !folded.has(id)).map((id) => {
                const pair = PAIRS[id];
                return { a: channels.get(id), t: pair && shown.indexOf(pair.target) >= 0 ? channels.get(pair.target) : null, span: pair && pair.span };
            }).slice(0, TILES);
        }

        function tilesPage(cv, t, ids) {
            const tiles = tilesOf(ids);
            const top = pageTop(), bottom = pageBottom(cv);
            if (!tiles.length) {
                const msg = status.state !== 'live' ? connectionLine() : !streamed.size ? 'Starting...'
                    : 'None of this page\'s channels are logged: press Setup page';
                cv.text(msg, cv.w / 2, (top + bottom) / 2, 30, t.dim, { align: 'center' });
                return;
            }
            const w = (cv.w - 2 * SIDE - (COLS - 1) * GAP) / COLS, h = (bottom - top - (ROWS - 1) * GAP) / ROWS;
            tiles.forEach((tile, i) => tileAt(cv, t, SIDE + (i % COLS) * (w + GAP), top + Math.floor(i / COLS) * (h + GAP), w, h, tile));
            noteLine(cv, t);
        }

        function tileAt(cv, t, x, y, w, h, tile) {
            G.panel(cv, t, x, y, w, h, tile.a.name);
            const u = units();
            const da = core.displayUnitFor(tile.a, u);
            const v = latest.get(tile.a.id);
            const shown = isNum(v) ? da.toDisplay(v) : null;
            const unit = unitText(da.label);
            const size = Math.min(84, h * 0.38), vy = y + 58 + size * 0.8;
            const decimals = da.decimals(tile.a.decimals);
            const vs = stateText(tile.a, v) || G.fmt(shown, decimals);
            const vw = cv.textWidth(vs, size, { font: 'num' });
            cv.text(vs, x + 20, vy, size, isNum(shown) ? t.text : t.dim, { font: 'num' });
            if (unit) cv.text(unit, x + 28 + vw, vy, 26, t.dim);
            let traceTop = vy + 14;
            if (tile.t) {
                // under the value: the target (in the actual's unit and decimals), then how far apart they are
                const dt = core.displayUnitFor(tile.t, u), tv = latest.get(tile.t.id);
                const ts = 'TARGET ' + G.fmt(isNum(tv) ? dt.toDisplay(tv) : null, decimals) + (unit ? ' ' + unit : '');
                const ry = vy + 34;
                const tw = cv.text(ts, x + 20, ry, 20, t.dim, { font: 'bold', spacing: 1 });
                deviation(cv, t, x + 36 + tw, ry - 13, w - 56 - tw, 10, isNum(v) && isNum(tv) ? (v - tv) / tile.span : null);
                traceTop = ry + 14;
            }
            trace(cv, t, x + 20, traceTop, w - 40, y + h - 18 - traceTop, tile);
        }

        /** How far actual is from target: from the middle, a full side at one span. */
        function deviation(cv, t, x, y, w, h, f) {
            cv.roundRect(x, y, w, h, h / 2, t.track);
            cv.fillRect(x + w / 2 - 1, y - 3, 2, h + 6, t.tick);
            if (!isNum(f)) return;
            const c = Math.max(-1, Math.min(1, f)), a = Math.abs(c);
            const col = a < 0.34 ? t.accent2 || t.accent : a < 0.67 ? t.warn : t.crit;
            const fx = c >= 0 ? x + w / 2 : x + w / 2 + c * (w / 2);
            cv.roundRect(fx, y, Math.max(3, a * (w / 2)), h, h / 2, col);
        }

        /** The last TRACE_S seconds: actual in the accent colour, target dimmed, on one scale. */
        function trace(cv, t, x, y, w, h, tile) {
            if (h < 24) return;
            const a = traces.get(tile.a.id) || [], b = tile.t ? traces.get(tile.t.id) || [] : [];
            const vals = a.concat(b).filter(isNum);
            if (vals.length < 3) return;
            let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
            if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
            const n = TRACE_S / TRACE_STEP_S;
            const pts = (tr) => tr.map((p, i) => [x + ((n - tr.length + i) / (n - 1)) * w, isNum(p) ? y + h - ((p - lo) / (hi - lo)) * h : y + h]);
            if (b.length > 1) cv.polyline(pts(b), 2, withAlpha(t.dim, 0.8));
            if (a.length > 1) {
                cv.fillUnder(pts(a), y + h, withAlpha(t.accent, 0.12));
                cv.polyline(pts(a), 2.5, withAlpha(t.accent, 0.9));
            }
        }

        /* ---------------- channels ---------------- */

        /** Every channel streamed, by group, with its value; Choose channels opens the picker. */
        function channelsPage(cv, t) {
            const top = pageTop(), bottom = pageBottom(cv);
            const bw = 300, bh = 50, bx = cv.w - SIDE - bw, by = top + 2;
            pill(cv, t, bx, by, bw, bh, 'Choose channels', false);
            cv.target(bx - 6, by - 6, bw + 12, bh + 12, choose, 'choose', bh / 2 + 6);
            const n = streamed.size;
            const head = status.state !== 'live' ? connectionLine()
                : 'Logging ' + n + ' channel' + (n === 1 ? '' : 's') + (isNum(status.sampleRateHz) ? ' at ' + status.sampleRateHz.toFixed(0) + ' samples per second' : '')
                    + (logChoice ? ' (your choice)' : ' (what the pages show)');
            cv.text(fit(cv, head, 24, bx - SIDE - 30), SIDE + 4, by + 34, 24, t.text, { font: 'bold' });
            noteLine(cv, t);
            if (status.state !== 'live' || !n) return;

            // one grid in Boostline's group order; a group's name over the cell it starts at
            // (in the car's order, as the picker lists them; the DME's own values by name)
            const byGroup = new Map();
            channels.forEach((def) => {
                if (!streamed.has(def.id)) return;
                const g = def.group || 'Custom';
                if (!byGroup.has(g)) byGroup.set(g, []);
                byGroup.get(g).push(def);
            });
            if (byGroup.has('DME')) byGroup.get('DME').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            const order = core.GROUP_ORDER.filter((g) => byGroup.has(g)).concat(Array.from(byGroup.keys()).filter((g) => core.GROUP_ORDER.indexOf(g) < 0));
            const cells = [];
            order.forEach((g) => byGroup.get(g).forEach((def, i) => cells.push({ def, head: i ? '' : g })));
            const C = 5, HEAD = 26, CELL = 68, ROW = HEAD + CELL + 8, x0 = SIDE, w = cv.w - 2 * SIDE - 24, cw = (w - (C - 1) * 10) / C;
            const y0 = top + 66, view = bottom - 4 - y0, total = Math.ceil(cells.length / C) * ROW;
            listMax = Math.max(0, total - view);
            listY = Math.min(listY, listMax);
            const u = units();
            cv.clip(x0, y0, w, view);
            cells.forEach((c, i) => {
                const cx = x0 + (i % C) * (cw + 10), ry = y0 - listY + Math.floor(i / C) * ROW, cy = ry + HEAD;
                if (cy + CELL < y0 || ry > y0 + view) return;
                if (c.head) cv.text(fit(cv, (c.head === 'DME' ? 'Other ' + E() + ' values' : c.head).toUpperCase(), 15, cw - 8, { font: 'bold' }), cx + 4, ry + 18, 15, t.accent, { font: 'bold', spacing: 1.5 });
                cv.roundRect(cx, cy, cw, CELL, 10, withAlpha('#ffffff', 0.05));
                cv.text(fit(cv, c.def.name, 17, cw - 28), cx + 14, cy + 23, 17, t.dim);
                const d = core.displayUnitFor(c.def, u), v = latest.get(c.def.id);
                const vs = stateText(c.def, v) || G.fmt(isNum(v) ? d.toDisplay(v) : null, d.decimals(c.def.decimals));
                const vw = cv.text(vs, cx + 14, cy + 58, 30, isNum(v) ? t.text : t.dim, { font: 'num' });
                const unit = unitText(d.label);
                if (unit) cv.text(fit(cv, unit, 18, cw - 40 - vw), cx + 22 + vw, cy + 58, 18, t.dim);
            });
            cv.noclip();
            if (listMax > 0) {
                // the list scrolls (a finger, or the controller on it): where it is
                const barX = cv.w - SIDE - 8, barH = Math.max(40, view * view / total), barY = y0 + (view - barH) * (listY / listMax);
                cv.roundRect(barX, barY, 6, barH, 3, withAlpha('#ffffff', 0.3));
                cv.scroll = { y: y0, bar: { x: barX, y: barY, w: 6, h: barH } };
            }
        }

        /* ---------------- dyno and drag ---------------- */

        /** Left: the chart panel; right: the results column. */
        function runLayout(cv) {
            const top = pageTop(), bottom = pageBottom(cv), rw = 470;
            return { top, bottom, h: bottom - top, lw: cv.w - 2 * SIDE - GAP - rw, rx: cv.w - SIDE - rw, rw };
        }

        /** A labelled big number in the results column; returns the y under it. */
        function figure(cv, t, x, y, w, label, value, unit, sub, color, size) {
            size = size || 64;
            cv.text(label.toUpperCase(), x, y + 18, 18, t.dim, { font: 'bold', spacing: 1.5 });
            const vw = cv.text(value, x, y + 26 + size * 0.78, size, value === '--' ? t.dim : color || t.text, { font: 'num' });
            if (unit) cv.text(unit, x + vw + 8, y + 26 + size * 0.78, 24, t.dim);
            if (sub) cv.text(fit(cv, sub, 20, w), x, y + 26 + size * 0.78 + 30, 20, t.dim);
            return y + 26 + size * 0.78 + (sub ? 46 : 18);
        }

        /** Coloured legend entries from x, right to left; returns the x left of them. */
        function legend(cv, t, xr, y, items) {
            let x = xr;
            items.slice().reverse().forEach((it) => {
                const w = cv.textWidth(it.label, 18);
                x -= w;
                cv.text(it.label, x, y, 18, t.dim);
                x -= 34;
                if (it.dash) for (let k = 0; k < 3; k++) cv.fillRect(x + k * 9, y - 7, 6, 3, it.color);
                else cv.fillRect(x, y - 7, 24, 3, it.color);
                x -= 22;
            });
            return x;
        }

        /** The axes' units over the plot (the chart's own sits on its top number). */
        function axisUnits(cv, t, ch, left, right, rightColor) {
            cv.text(left, ch.px - 8, ch.py - 14, 14, t.dim, { align: 'right', font: 'bold' });
            if (right) cv.text(right, ch.px + ch.pw + 8, ch.py - 14, 14, rightColor || t.dim, { font: 'bold' });
        }

        function stateLine(cv, t, x, y, w, text, live) {
            if (!text) return;
            if (live) { cv.circle(x + 7, y - 7, 6, t.crit); x += 22; w -= 22; }
            cv.text(fit(cv, text, 22, w, { font: 'bold' }), x, y, 22, live ? t.text : t.warn, { font: 'bold' });
        }

        function dynoPage(cv, t) {
            const L = runLayout(cv), u = units(), r = dyno.result, base = dyno.baselineResult();
            const ENGINE = t.warn, WHEEL = withAlpha(t.warn, 0.55), TORQUE = t.cold || t.accent2, ECU = withAlpha(t.text, 0.55);
            const showEcu = settings.get('dynoEcuTorque') !== false;
            G.panel(cv, t, SIDE, L.top, L.lw, L.h, dyno.current ? dyno.current.name : 'Power and torque');
            if (!r || !r.points.length) {
                const cx = SIDE + L.lw / 2, cy = L.top + L.h / 2;
                cv.text('Arm the run, then floor it in one gear (3rd or 4th)', cx, cy - 20, 28, t.text, { align: 'center' });
                cv.text('from low rpm to near the limiter: the pull is recorded by itself.', cx, cy + 20, 28, t.text, { align: 'center' });
                cv.text('Power from the car\'s acceleration sensor and speed, as Virtual Dyno. Closed course only.', cx, cy + 70, 20, t.dim, { align: 'center' });
            } else {
                const pw = (p) => core.powerFromKw(p.engineKw, u.power), ww = (p) => core.powerFromKw(p.wheelKw, u.power);
                const tq = (nm) => core.torqueFromNm(nm, u.torque);
                const pts = r.points.concat(base ? base.points : []);
                // both scales filled by the data with a small margin, on the same grid lines
                const tAll = pts.map((p) => tq(p.torqueNm)).concat(showEcu ? pts.filter((p) => isNum(p.ecuNm)).map((p) => tq(p.ecuNm)) : []);
                const pMax = Math.max.apply(null, pts.map(pw)), tMax = Math.max.apply(null, tAll);
                const pa = fillAxis(pMax, 4, 9), N = pa.n, pStep = pa.step;
                const ta = fillAxis(tMax, 4, 9), tStep = ta.step;
                const k = (pStep * N) / (tStep * ta.n);     // torque drawn on the power scale (its own top), labelled on the right
                const rpms = pts.map((p) => p.rpm);
                const x0 = Math.min(1000, Math.floor(Math.min.apply(null, rpms) / 500) * 500);
                const x1 = Math.ceil(Math.max.apply(null, rpms) / 500) * 500;
                // the curves drawn through the points with a light, shape-keeping smoothing
                const line = (list, f) => curve(list.map((p) => [p.rpm, f(p)]));
                const series = [];
                if (base) {
                    series.push({ pts: line(base.points, (p) => tq(p.torqueNm) * k), color: withAlpha(t.dim, 0.6), width: 2, dash: true });
                    series.push({ pts: line(base.points, pw), color: withAlpha(t.dim, 0.9), width: 2.5, dash: true });
                }
                if (showEcu && r.points.some((p) => isNum(p.ecuNm))) series.push({ pts: line(r.points.filter((p) => isNum(p.ecuNm)), (p) => tq(p.ecuNm) * k), color: ECU, width: 2 });
                series.push({ pts: line(r.points, (p) => tq(p.torqueNm) * k), color: TORQUE, width: 3 });
                series.push({ pts: line(r.points, ww), color: WHEEL, width: 2, dash: true });
                series.push({ pts: line(r.points, pw), color: ENGINE, width: 3.5, fill: 0.1 });
                const cx = SIDE + 14, cy = L.top + 64, cw = L.lw - 28, chh = L.h - 78, xStep = x1 - x0 > 4000 ? 1000 : 500;
                // thin vertical grid lines at the rpm marks, under the curves (where the kit's chart puts its plot)
                const gx = cx + 56, gw = cw - 56 - 64, gy = cy + 24, gh = chh - 24 - 26;
                for (let v = x0 + xStep; v < x1 - 1e-9; v += xStep) cv.fillRect(Math.round(gx + (v - x0) / (x1 - x0) * gw), gy, 1, gh, withAlpha(t.tick, 0.25));
                const ch = G.chart(cv, t, cx, cy, cw, chh, {
                    xMin: x0, xMax: x1, yMin: 0, yMax: pStep * N, yStep: pStep, xStep,
                    padLeft: 56, padRight: 64, padTop: 24, xUnit: 'rpm', series,
                });
                for (let i = 0; i <= ta.n; i++) cv.text(G.fmt(tStep * i, tStep % 1 ? 1 : 0), ch.px + ch.pw + 8, ch.Y(tStep * i * k) + 6, 16, TORQUE);
                axisUnits(cv, t, ch, u.power, u.torque, TORQUE);
                const items = [{ label: 'Engine', color: ENGINE }, { label: 'Wheel', color: WHEEL, dash: true }, { label: 'Torque', color: TORQUE }];
                if (showEcu && r.points.some((p) => isNum(p.ecuNm))) items.push({ label: 'ECU torque', color: ECU });
                if (base) items.push({ label: 'Baseline', color: t.dim, dash: true });
                legend(cv, t, SIDE + L.lw - 20, L.top + 42, items);
            }
            const now = dyno.state === 'recording' ? vdyno.powerNow(bus.dynoSample(), dynoSetup()) : null;
            G.panel(cv, t, L.rx, L.top, L.rw, L.h, dyno.state === 'recording' ? 'Recording' : 'Peaks');
            const x = L.rx + 20, w = L.rw - 40;
            let y = L.top + 56;
            const half = (w - 20) / 2;
            if (dyno.state === 'recording') {
                const d = bus.dynoSample();
                y = figure(cv, t, x, y, w, 'Power now', isNum(now) ? core.powerFromKw(now, u.power).toFixed(0) : '--', u.power, 'keep it pinned...', ENGINE, 76);
                cv.text(G.fmt(d.rpm, 0) + ' rpm  ·  ' + G.fmt(d.speed, 0) + ' km/h  ·  ' + G.fmt(d.gLong, 2) + ' g', x, y + 10, 22, t.text, { font: 'bold' });
            } else {
                const peak = (kw) => (r ? core.powerFromKw(kw, u.power).toFixed(0) : '--');
                const dP = r && base ? core.powerFromKw(r.peakEngine.kw, u.power) - core.powerFromKw(base.peakEngine.kw, u.power) : null;
                const dT = r && base ? core.torqueFromNm(r.peakTorque.nm, u.torque) - core.torqueFromNm(base.peakTorque.nm, u.torque) : null;
                const delta = (v) => (isNum(v) && Math.abs(v) >= 0.5 ? '  ' + (v > 0 ? '+' : '') + v.toFixed(0) + ' vs baseline' : '');
                y = figure(cv, t, x, y, w, 'Engine power', peak(r && r.peakEngine.kw), u.power, r ? 'at ' + Math.round(r.peakEngine.rpm) + ' rpm' + delta(dP) : '', ENGINE, 76);
                figure(cv, t, x, y, half, 'Torque', r ? core.torqueFromNm(r.peakTorque.nm, u.torque).toFixed(0) : '--', u.torque, r ? 'at ' + Math.round(r.peakTorque.rpm) + ' rpm' + (dT !== null && Math.abs(dT) >= 0.5 ? ' (' + (dT > 0 ? '+' : '') + dT.toFixed(0) + ')' : '') : '', TORQUE, 48);
                y = figure(cv, t, x + half + 20, y, half, 'Wheel power', peak(r && r.peakWheel.kw), u.power, r ? 'at ' + Math.round(r.peakWheel.rpm) + ' rpm' : '', null, 48);
                if (r) {
                    const s = r.setup || {};
                    const body = { coupe: 'sedan', wagon: 'Touring', suv: 'SUV' }[s.body] || '';
                    const info = (r.gear ? 'Gear ' + r.gear + '  ·  ' : '') + (s.massKg || '--') + ' kg  ·  ' + (isNum(s.drivetrainLossPct) ? s.drivetrainLossPct : '--') + ' % loss' + (body ? '  ·  ' + body : '');
                    cv.text(fit(cv, info, 20, w), x, y + 10, 20, t.dim);
                    if (s.correction && s.correction !== 'none') cv.text(fit(cv, s.correction + ' ' + r.correctionFactor.toFixed(3) + '  ·  ' + (s.baroHpa / 1000).toFixed(2) + ' bar  ·  ' + Number(s.ambientTempC).toFixed(0) + ' °C', 20, w), x, y + 38, 20, t.dim);
                    else if (r.method !== 'bus') cv.text('Older run (worked out from the ' + E() + '\'s speed)', x, y + 38, 20, t.warn);
                }
            }
            const note = dyno.note && Date.now() < dyno.note.until ? dyno.note.text : '';
            const st = dyno.state === 'armed' ? (note || 'Armed: floor it in one gear - recorded by itself')
                : dyno.state === 'recording' ? 'Recording the pull...' : note;
            stateLine(cv, t, x, L.bottom - 18, w, st, dyno.state === 'recording');
            noteLine(cv, t);
        }

        function dragPage(cv, t) {
            const L = runLayout(cv), u = units(), r = drag.result, mode = drag.armed ? drag.mode : settings.get('dragMode');
            const SPEED = t.warn;
            const sp = (kmh) => core.speedFromKmh(kmh, u.speed);
            G.panel(cv, t, SIDE, L.top, L.lw, L.h, drag.current ? drag.current.name : modeName(mode));
            const spec = core.DRAG_MODES[mode];
            if (!r || !r.curve.t.length) {
                const cx = SIDE + L.lw / 2, cy = L.top + L.h / 2;
                const how = spec.standing ? 'Arm the run and come to a stop. Timing starts at the first movement.'
                    : 'Arm the run below ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed + ', then accelerate through it.';
                cv.text(modeName(mode), cx, cy - 30, 36, t.text, { align: 'center', font: 'bold' });
                cv.text(how, cx, cy + 16, 24, t.text, { align: 'center' });
                cv.text('Closed course only.', cx, cy + 64, 20, t.dim, { align: 'center' });
            } else {
                const c = r.curve, xEnd = (r.finalTime !== null ? r.finalTime : c.t[c.t.length - 1]) + 0.4;
                const cal = [], raw = [];
                for (let i = 0; i < c.t.length; i++) {
                    if (c.t[i] < -0.2 || c.t[i] > xEnd) continue;
                    cal.push([c.t[i], sp(c.calibrated[i])]);
                    raw.push([c.t[i], sp(c.raw[i])]);
                }
                const vMax = Math.max.apply(null, cal.map((p) => p[1]).concat([1])), N = 5, vStep = axisStep(vMax * 1.05, N);
                const tStep = axisStep(xEnd, 6);
                // the car's own speed too, when this run was corrected (the speedometer setting)
                const calibrated = c.raw.some((v, i) => Math.abs(v - c.calibrated[i]) > 0.05);
                const series = [];
                if (calibrated) series.push({ pts: raw, color: withAlpha(t.dim, 0.9), width: 2 });
                series.push({ pts: cal, color: SPEED, width: 3.5, fill: 0.1 });
                const ch = G.chart(cv, t, SIDE + 14, L.top + 64, L.lw - 28, L.h - 78, {
                    xMin: 0, xMax: Math.ceil(xEnd / tStep) * tStep, xStep: tStep, yMin: 0, yMax: vStep * N, yStep: vStep,
                    padLeft: 56, padTop: 24, xUnit: 's', xFmt: (v) => G.fmt(v, tStep % 1 ? 1 : 0), series,
                });
                axisUnits(cv, t, ch, u.speed);
                // the shifts: a thin line and the gear it went into
                r.gearChanges.forEach((g) => {
                    if (g.time < 0 || g.time > xEnd) return;
                    const gx = ch.X(g.time);
                    cv.fillRect(gx - 1, ch.py, 2, ch.ph, withAlpha(t.text, 0.25));
                    cv.text(String(g.to), gx + 6, ch.py + 18, 16, t.dim, { font: 'bold' });
                });
                const items = [{ label: calibrated ? 'True speed' : 'Speed', color: SPEED }];
                if (calibrated) items.unshift({ label: 'Car\'s speed', color: t.dim });
                legend(cv, t, SIDE + L.lw - 20, L.top + 42, items);
            }
            // right: the time, then speed and distance - live while the run is on (the speed from the
            // car as soon as the run is armed), the finished run's exit (trap) speed and distance after
            const live = drag.live, armedIdle = drag.armed && !live;
            G.panel(cv, t, L.rx, L.top, L.rw, L.h, live ? 'Running' : armedIdle ? 'Armed' : 'Time');
            const x = L.rx + 20, w = L.rw - 40, half = (w - 20) / 2;
            let y = L.top + 56;
            const best = drag.best(live || armedIdle ? mode : r ? r.mode : mode);
            const bestSub = best !== null ? 'best ' + best.toFixed(2) + ' s' : '';
            const nowKmh = latest.get('vehicle.speed');
            let time = '--', speed = '--', dist = '--', speedLabel = 'Exit speed';
            if (live) {
                time = Math.max(0, live.elapsed).toFixed(2);
                speed = sp(live.speedKmh).toFixed(0);
                dist = Math.max(0, live.distanceM).toFixed(0);
                speedLabel = 'Speed';
            } else if (armedIdle) {
                time = '0.00';
                speed = isNum(nowKmh) ? sp(nowKmh).toFixed(0) : '--';
                dist = '0';
                speedLabel = 'Speed';
            } else if (r) {
                if (r.finalTime !== null) time = r.finalTime.toFixed(2);
                if (r.trapSpeedKmh !== null) speed = sp(r.trapSpeedKmh).toFixed(1);
                if (r.finished || r.distanceM > 0) dist = r.distanceM.toFixed(0);
            }
            const title = live || armedIdle ? modeName(mode) : r ? modeName(r.mode) : modeName(mode);
            y = figure(cv, t, x, y, w, title, time, 's', bestSub, live ? t.text : SPEED, 76);
            figure(cv, t, x, y, half, speedLabel, speed, u.speed, '', null, 48);
            y = figure(cv, t, x + half + 20, y, half, 'Distance', dist, 'm', '', null, 48);
            if (live || armedIdle) {
                // splits come with the result; until then the live numbers have the column
                const st0 = drag.state === 'waiting-stop' ? (spec.standing ? 'Armed: come to a complete stop' : 'Armed: slow down below ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed)
                    : drag.state === 'ready' ? (spec.standing ? 'Ready: launch when you are' : 'Ready: accelerate through ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed)
                        : 'Running...';
                stateLine(cv, t, x, L.bottom - 18, w, st0, drag.state === 'running');
                noteLine(cv, t);
                return;
            }
            if (r && r.splits.length) {
                // the splits: every one if they fit, else evenly spaced ones and the last. A speed run
                // (0-100, 60-160 ...) puts them in two columns when one doesn't hold them all.
                const step = /mph/.test(r.mode) ? 'mph' : 'km/h';
                const bySpeed = core.DRAG_MODES[r.mode].distanceM === undefined;
                const rowH = bySpeed ? 26 : 30, size = bySpeed ? 19 : 20;
                y += bySpeed ? 10 : 16;
                // (down to the bottom when no warning and no state line sits there)
                const busy = (r.warnings.length && !drag.armed) || drag.state === 'waiting-stop' || drag.state === 'ready' || drag.state === 'running';
                const rows = Math.max(1, Math.floor((L.bottom - (busy ? 44 : 4) - y) / rowH));
                const cols = bySpeed && r.splits.length > rows ? 2 : 1, room = rows * cols;
                let splits = r.splits;
                if (splits.length > room) {
                    const every = Math.ceil(splits.length / room);
                    splits = splits.filter((s, i) => (i + 1) % every === 0 || i === splits.length - 1).slice(-room);
                }
                const from = Math.round(core.speedFromKmh(core.DRAG_MODES[r.mode].fromKmh, step));
                const per = Math.ceil(splits.length / cols), colW = (w - (cols - 1) * 24) / cols;
                splits.forEach((s, i) => {
                    const cx = x + Math.floor(i / per) * (colW + 24), yy = y + 8 + (i % per) * rowH;
                    cv.text(from + '-' + Math.round(core.speedFromKmh(s.speedKmh, step)) + (cols > 1 ? '' : ' ' + step), cx, yy, size, t.dim);
                    cv.text(s.time.toFixed(2) + ' s', cx + colW, yy, size, t.text, { align: 'right', font: 'bold' });
                });
            }
            if (r && r.warnings.length && !drag.armed) cv.text(fit(cv, r.warnings[0], 18, w), x, L.bottom - 46, 18, t.warn);
            const st = drag.state === 'waiting-stop' ? (spec.standing ? 'Armed: come to a complete stop' : 'Armed: slow down below ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed)
                : drag.state === 'ready' ? (spec.standing ? 'Ready: launch when you are' : 'Ready: accelerate through ' + Math.round(sp(spec.fromKmh)) + ' ' + u.speed)
                    : drag.state === 'running' ? 'Running...' : '';
            stateLine(cv, t, x, L.bottom - 18, w, st, drag.state === 'running');
            noteLine(cv, t);
        }

        /** The first Arm run asks once: full-throttle runs belong on a closed course. */
        function closedCourse(cv, t) {
            const w = 900, h = 250, x = (cv.w - w) / 2, y = pageTop() + 90;
            cv.roundRect(x - 6, y - 6, w + 12, h + 12, 10, withAlpha(t.bg, 0.92));
            G.panel(cv, t, x, y, w, h, 'Closed courses only');
            cv.text('Full-throttle pulls and drag runs belong on a closed course or a track,', x + 24, y + 90, 24, t.text);
            cv.text('never on public roads. Power and times are estimates from the car\'s data.', x + 24, y + 124, 24, t.text);
            cv.text('Press Arm run again to confirm.', x + 24, y + 190, 26, t.warn, { font: 'bold' });
        }

        /* ---------------- status ---------------- */

        /* ---------------- files ---------------- */

        const recordingFile = () => (status.recording ? status.recording.file : null);
        /** Opens a page by its kind (a run from Files shows on Dyno / Drag). */
        function goTo(k) {
            const i = pages().findIndex((p) => p.kind === k);
            if (i >= 0 && i !== page) { page = i; pageChanged(); }
        }
        /** The browser over the page: folders, files, View, Delete (kit sheet, as the pickers). */
        function browseFiles() {
            const sh = picker.fileSheet({
                folders: () => {
                    const use = files.usage(ctx.dataDir);
                    return files.FOLDERS.map((f) => ({ key: f.key, label: f.label, count: use[f.key].count, bytes: use[f.key].bytes }));
                },
                list: (key) => files.list(ctx.dataDir, key),
                busy: (it) => it.file === recordingFile(),
                viewLabel: (key) => (key === 'Logs' ? 'View: summary and chart' : 'Show on the ' + key + ' page'),
                view: (key, it) => {
                    if (key === 'Logs') { viewCapture(it); return; }
                    const runs = key === 'Dyno' ? dyno : drag;
                    if (runs.armed) { say('Disarm first to look at a saved run'); return; }
                    const run = runs.store.load(it.file);
                    if (!run) { say('That run can\'t be read'); return; }
                    runs.show(run);
                    goTo(key === 'Dyno' ? 'dyno' : 'drag');
                },
                remove: (key, it) => {
                    const ok = files.remove(it.file);
                    if (ok) {
                        addLine('Deleted ' + key + '/' + it.name);
                        afterDelete(key, it.file);
                    }
                    return ok;
                },
                removeAll: (key) => {
                    const n = files.removeAll(ctx.dataDir, key, recordingFile());
                    addLine('Deleted ' + n + ' file' + (n === 1 ? '' : 's') + ' in ' + key);
                    afterDelete(key, null);
                    return n;
                },
                size: files.size,
            });
            if (!ctx.sheet(sh)) say('Files needs Screen layout: Full screen and Renderer: GPU (Settings)', 10000);
        }
        /** After a delete: the runs on Dyno / Drag, the capture shown here. */
        function afterDelete(key, file) {
            if (key === 'Dyno') dyno.reload();
            if (key === 'Drag') drag.reload();
            if (key === 'Logs' && captureView && (!file || captureView.item.file === file)) captureView = null;
        }
        /** Reads a capture in the background (it can be large), then shows it on the Files page. */
        function viewCapture(it) {
            const view = { item: it, loading: true, summary: null, error: null };
            captureView = view;
            files.csvSummary(it.file, CAPTURE_STATS, (err, sum) => {
                view.loading = false;
                if (err) view.error = err.message; else view.summary = sum;
                if (captureView === view) render();
            });
        }

        function filesPage(cv, t) {
            const top = pageTop(), bottom = pageBottom(cv), rw = 470, lw = cv.w - 2 * SIDE - GAP - rw, rx = cv.w - SIDE - rw, h = bottom - top;
            const v = captureView;
            if (v) {
                G.panel(cv, t, SIDE, top, lw, h, v.item.title);
                const sum = v.summary;
                if (v.loading || v.error || !sum || !sum.rows) {
                    cv.text(v.loading ? 'Reading the capture...' : v.error ? 'Can\'t read it: ' + v.error : 'The capture has no samples',
                        SIDE + lw / 2, top + h / 2, 26, v.error ? t.warn : t.text, { align: 'center' });
                } else {
                    // rpm (left scale) and speed (right scale) over the capture
                    const se = sum.series, ts = se.t;
                    const pts = (id, k) => { const out = []; for (let i = 0; i < ts.length; i++) if (isNum(se[id][i])) out.push([ts[i], se[id][i] * k]); return out; };
                    const rpmMax = sum.stats['engine.rpm'] ? sum.stats['engine.rpm'].max : 0, spMax = sum.stats['vehicle.speed'] ? sum.stats['vehicle.speed'].max : 0;
                    const rStep = axisStep(Math.max(1000, rpmMax) * 1.05, 5), N = Math.max(2, Math.ceil(Math.max(1000, rpmMax) * 1.05 / rStep));
                    const sStep = axisStep(Math.max(10, spMax) * 1.05, N), k = rStep / sStep;
                    const series = [];
                    if (sum.stats['vehicle.speed']) series.push({ pts: pts('vehicle.speed', k), color: t.cold || t.accent2, width: 2.5 });
                    if (sum.stats['engine.rpm']) series.push({ pts: pts('engine.rpm', 1), color: t.warn, width: 2.5, fill: 0.08 });
                    const xEnd = Math.max(1, sum.duration);
                    const ch = G.chart(cv, t, SIDE + 14, top + 64, lw - 28, h - 78, {
                        xMin: 0, xMax: xEnd, yMin: 0, yMax: rStep * N, yStep: rStep, xStep: axisStep(xEnd, 6),
                        padLeft: 56, padRight: 64, padTop: 24, xUnit: 's', series,
                    });
                    const SP = t.cold || t.accent2;
                    for (let i = 0; i <= N; i++) cv.text(G.fmt(sStep * i, sStep % 1 ? 1 : 0), ch.px + ch.pw + 8, ch.Y(rStep * i) + 6, 16, SP);
                    const spUnit = unitText(unitOf(sum, 'vehicle.speed'));
                    axisUnits(cv, t, ch, 'rpm', spUnit, SP);
                    legend(cv, t, SIDE + lw - 20, top + 42, [{ label: 'Engine speed', color: t.warn }, { label: 'Speed', color: SP }]);
                }
                G.panel(cv, t, rx, top, rw, h, 'Capture');
                const x = rx + 20, w = rw - 40;
                let y = top + 84;
                if (sum && sum.rows) {
                    const mm = Math.floor(sum.duration / 60), ss = Math.round(sum.duration % 60);
                    const line1 = mm + ' min ' + (ss < 10 ? '0' : '') + ss + ' s  ·  ' + sum.rows + ' samples  ·  ' + sum.ids.length + ' channels';
                    cv.text(fit(cv, line1, 20, w), x, y, 20, t.dim);
                    y += 42;
                    CAPTURE_STATS.forEach((id) => {
                        const st = sum.stats[id];
                        if (!st || y > bottom - 90) return;
                        const i = sum.ids.indexOf(id), name = i >= 0 ? sum.names[i] : id, unit = unitText(unitOf(sum, id));
                        const dec = Math.abs(st.max) < 10 ? 2 : Math.abs(st.max) < 100 ? 1 : 0;
                        cv.text(fit(cv, name, 19, w - 170), x, y, 19, t.text);
                        cv.text(G.fmt(st.max, dec) + (unit ? ' ' + unit : ''), x + w, y, 19, t.text, { align: 'right', font: 'num' });
                        cv.text('max', x + w - 150, y, 15, t.dim, { align: 'right' });
                        y += 30;
                    });
                } else {
                    cv.text(files.size(v.item.bytes), x, y, 20, t.dim);
                }
                const cy = bottom - 70;
                pill(cv, t, x, cy, w, 52, 'Close', false);
                cv.target(x - 6, cy - 6, w + 12, 64, () => { captureView = null; render(); }, 'close_capture', 32);
                noteLine(cv, t);
                return;
            }
            // no capture open: what's saved, and where to go
            G.panel(cv, t, SIDE, top, lw, h, 'Saved on the head unit');
            const use = files.usage(ctx.dataDir);
            const x = SIDE + 24, w = lw - 48;
            let y = top + 70;
            files.FOLDERS.forEach((f) => {
                const u = use[f.key];
                cv.roundRect(x, y, w, 76, 12, withAlpha('#ffffff', 0.05));
                cv.text(f.label, x + 20, y + 32, 24, t.text, { font: 'bold' });
                cv.text(u.count + ' file' + (u.count === 1 ? '' : 's') + '  ·  ' + files.size(u.bytes), x + 20, y + 60, 19, t.dim);
                y += 90;
            });
            // the captures' room: the app stops starting captures near its disk quota
            const frac = Math.min(1, use.Logs.bytes / LOGS_LIMIT);
            cv.text('Room for captures: ' + files.size(use.Logs.bytes) + ' of ' + files.size(LOGS_LIMIT), x, y + 18, 19, frac > 0.85 ? t.warn : t.dim);
            cv.roundRect(x, y + 32, w, 10, 5, withAlpha('#ffffff', 0.1));
            if (frac > 0) cv.roundRect(x, y + 32, Math.max(10, w * frac), 10, 5, frac > 0.85 ? t.warn : t.accent);
            G.panel(cv, t, rx, top, rw, h, 'Files');
            const bx = rx + 20, bw2 = rw - 40, by = top + 70, bh = 56;
            pill(cv, t, bx, by, bw2, bh, 'Browse files', false);
            cv.target(bx - 6, by - 6, bw2 + 12, bh + 12, browseFiles, 'browse', bh / 2 + 6);
            const help = ['Look at a capture: a summary and its', 'rpm and speed over time.', 'Show a saved dyno or drag run on its page.',
                'Delete one file or a whole folder', '(press Delete twice).'];
            help.forEach((l, i) => cv.text(l, bx, by + bh + 50 + i * 30, 20, t.dim));
            noteLine(cv, t);
        }
        /** A capture's unit for a channel, as written in its header. */
        function unitOf(sum, id) {
            const i = sum.ids.indexOf(id);
            return i >= 0 ? sum.units[i] : '';
        }

        function connectionLine() {
            if (!powered) return 'Power off: press Power on to read the ' + E();
            if (!awake.on) return 'Car switched off: reading paused';
            if (status.state === 'live') return 'Live from the ' + E();
            if (status.state === 'connecting') return 'Connecting to the ' + E() + '...';
            if (status.state === 'error') return status.error ? ddeText(status.error) : 'No answer from the ' + E();
            return 'Not connected';
        }

        function statusPage(cv, t) {
            const top = pageTop(), bottom = pageBottom(cv), half = (cv.w - 2 * SIDE - GAP) / 2;
            const lx = SIDE, rx = SIDE + half + GAP;
            G.panel(cv, t, lx, top, half, bottom - top, 'Connection');
            const ecu = status.ecu || {};
            const rows = [
                ['State', connectionLine()],
                ['Car bus', bus.ages()],
                ['VIN', status.vin || '--'],
                [E() + ' software', ecu.softwareVersion || '--'],
                ['Diagnostic index', ecu.sgbdIndex || '--'],
                ['BMW ' + E() + ' data', (ecu.dmeData || 'none (OBD-II channels)') + (ecuKind ? ' (' + ecuKind + ')' : '')],
                ['Channels', channels.size ? channels.size + ' offered, ' + streamed.size + ' streamed' + (logChoice ? ' (your choice)' : '') : '--'],
                ['Sample rate', isNum(status.sampleRateHz) ? status.sampleRateHz.toFixed(1) + ' per second' : '--'],
                ['Requests', link.stats.sent + ' sent, ' + link.stats.missed + ' unanswered, busy ' + link.busy],
                ['Capture', status.recording ? path.basename(status.recording.file) + ', ' + status.recording.samples + ' samples' : 'off'],
            ];
            rows.forEach((r, i) => {
                const yy = top + 84 + i * 38;
                cv.text(r[0], lx + 20, yy, 22, t.dim);
                cv.text(fit(cv, String(r[1]), 22, half - 270), lx + 250, yy, 22, t.text);
            });
            G.panel(cv, t, rx, top, half, bottom - top, 'Log');
            const room = Math.floor((bottom - top - 70) / 30);
            lines.slice(-room).forEach((s, i) => cv.text(fit(cv, ddeText(s), 18, half - 40), rx + 20, top + 80 + i * 30, 18, t.dim));
            noteLine(cv, t);
        }

        // every screen refresh with the GPU renderer, 10 a second in software (PNG frames)
        ctx.loop('MAIN', 10, render);
    },
});
