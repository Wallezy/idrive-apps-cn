'use strict';
// Actual application code and drawing runtime with unavailable vehicle/network providers.
// This does not execute a diagnostic write, a service command or an Internet request.
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const EventEmitter = require('events');
const id = process.argv[2], app = path.join(__dirname, '../apps', id, 'package');
const out = process.argv[3] && path.resolve(process.argv[3]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'community-startup-'));
const source = path.join(tmp, 'source'), errors = [], frames = [], drawnText = [];
fs.cpSync(app, source, { recursive: true });
fs.writeFileSync(path.join(source, 'javascript/app.js'),
    fs.readFileSync(path.join(source, 'javascript/localized-entry.js'), 'utf8').replace("require('./app.js');", ''));
fs.mkdirSync(path.join(tmp, 'data'));
const original = Module._load;
class NoSocket extends EventEmitter {
    constructor() { super(); this.destroyed = false; }
    connect() { setImmediate(() => this.emit('error', Error('Offline test: no service'))); return this; }
    setEncoding() { return this; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    write() { return false; }
    end() { this.destroy(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
const offlineNet = { Socket: NoSocket, createConnection: () => new NoSocket().connect(),
    connect: () => new NoSocket().connect(), isIP: () => 0 };
const offlineHttp = { Agent: class Agent extends EventEmitter {},
    request() { const r = new NoSocket(); r.end = () => setImmediate(() => r.emit('error', Error('Offline test'))); return r; },
    get() { const r = this.request(); r.end(); return r; } };
Module._load = function (name) {
    if (name === 'net') return offlineNet;
    if (name === 'http' || name === 'https') return offlineHttp;
    if (name === 'child_process') return {
        execFile: (file, args, options, callback) => { const cb = typeof options === 'function' ? options : callback; if (cb) cb(Error('Offline test')); },
        execSync: () => { throw Error('Offline test'); }, spawnSync: () => ({ status: 1, stdout: '', stderr: 'Offline test' }),
    };
    return original.apply(this, arguments);
};
process.on('unhandledRejection', e => errors.push(e.stack || String(e)));
process.on('uncaughtException', e => errors.push(e.stack || String(e)));
const quiet = { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.map(String).join(' ')) };
try {
    const { headUnit } = require('../localized/cauliflower/kit/tools/hu-stub');
    const hu = headUnit(tmp, {
        dataDir: path.join(tmp, 'data'), fresh: true, sets: { demo: 'off' }, log: quiet,
        image: (name, canvas) => {
            frames.push(name);
            if (out && canvas.png) {
                fs.mkdirSync(out, { recursive: true });
                fs.writeFileSync(path.join(out, id + '-' + name.replace(/[^a-zA-Z0-9_-]/g, '') + '.png'), canvas.png());
            }
        },
    });
    hu.ui.hasFocus = () => true;
    hu.ui.isVisible = () => true;
    hu.ui.onFocus = () => {};
    hu.ctx.onExit = () => {};
    const canvas = hu.ctx.canvas;
    hu.ctx.canvas = (...args) => {
        const cv = canvas(...args), text = cv.text;
        cv.text = function (value, ...rest) { drawnText.push(String(value)); return text.call(this, value, ...rest); };
        return cv;
    };
    hu.start();
    setTimeout(async () => {
        try {
            for (const name of Object.keys(hu.loops)) {
                const result = await hu.loops[name]();
                if (result && typeof result.png === 'function') {
                    frames.push(name);
                    if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, id + '-' + name + '.png'), result.png()); }
                }
            }
        } catch (e) { errors.push(e.stack || String(e)); }
        if (id === 'vehicle_health') {
            if (!drawnText.includes('等待车辆数据') || drawnText.includes('ALL GOOD'))
                errors.push('Missing vehicle data must not be reported as healthy');
        }
        if (id !== 'ram_mic_calibration' && !frames.length)
            errors.push('A graphics app must render an unavailable-data screen');
        console.log(JSON.stringify({ id, screens: Object.keys(hu.loops), frames, errors }));
        Module._load = original;
        fs.rmSync(tmp, { recursive: true, force: true });
        process.exit(errors.length ? 1 : 0);
    }, 500);
} catch (e) {
    console.error(e.stack); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1);
}
