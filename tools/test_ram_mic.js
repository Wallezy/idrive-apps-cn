'use strict';
// Exercise actual diagnostic and UI code with a fake ECU; never opens a vehicle connection.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');
const root = path.join(__dirname, '../apps/ram_mic_calibration/package');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function load(file, imports, extra) {
    const sandbox = Object.assign({ module: { exports: {} }, Buffer, Promise, Date,
        setTimeout: (fn) => setTimeout(fn, 25), clearTimeout,
        require: (name) => {
            if (!(name in imports)) throw Error('Unexpected import: ' + name);
            return imports[name];
        } }, extra);
    vm.runInNewContext(fs.readFileSync(path.join(root, 'javascript', file), 'utf8'), sandbox, { filename: file });
    return sandbox.module.exports;
}
const ram = load('ram.js', {});
function ecu(responses) {
    const d = new EventEmitter();
    d.available = true; d.p = {}; d.calls = [];
    d.signals = { call(proxy, method, request) {
        assert.strictEqual(method, 'sendTasuRequest');
        assert.strictEqual(request.targetAddress, 0x37);
        assert.strictEqual(request.sourceAddress, 0xF2);
        d.calls.push([request.serviceID, ...request.udsData]);
        const item = responses.shift();
        if (item instanceof Error) return Promise.reject(item);
        if (item) setImmediate(() => {
            const frames = item.frames || [item];
            frames.forEach((frame) => d.emit('frame', { ecu: frame.ecu || 0x37, uds: Buffer.from(frame.uds || frame) }));
        });
        return Promise.resolve(item && item.ack !== undefined ? item.ack : 'NO_ERROR');
    } };
    return d;
}
const ident = [0x62, 0xF1, 0x50, 0x0F, 0x25, 0x90];
const status = (value) => [0x71, 3, 0xA0, 0x91, 0, value];
const accepted = [0x71, 1, 0xA0, 0x91];
const countStarts = (d) => d.calls.filter((x) => x.join(',') === '49,1,160,145').length;
async function rejected(fn, text) {
    let error;
    try { await fn(); } catch (e) { error = e; }
    assert(error && error.message.includes(text), 'Expected rejection: ' + text);
}
async function ui(onTick, beforeStart) {
    const callbacks = {}, logs = [], flags = { visible: true, focus: true };
    let clock = 10000, hooks, speed, unavailable, starts = 0, reads = 0, tick = 0;
    const zero = () => speed({ speedVehicleCentreOfGravity: 0 });
    const controls = { zero, move: () => speed({ speedVehicleCentreOfGravity: 64 }),
        disconnect: () => unavailable(), click: () => callbacks.BTN_START(),
        leave: () => callbacks.focus('MAIN', false), skip: (ms) => { clock += ms; } };
    class FakeDate extends Date { static now() { return clock; } }
    class Diag { constructor() { this.available = true; } init() {} }
    const fakeRam = {
        identify: async () => {},
        readStatus: async () => { reads++; return { text: '完成，无错误' }; },
        calibrate: async (d, assertParked) => { if (beforeStart) beforeStart(controls); assertParked(); starts++; return '校准成功'; },
    };
    load('localized-entry.js', {
        './app.js': {}, './kit/mgu': { run: (h) => { hooks = h; } },
        './kit/diag': { Diag }, './ram': fakeRam,
    }, { Date: FakeDate, setTimeout: (fn, ms) => {
        assert.strictEqual(ms, 1000);
        return setImmediate(() => { clock += ms; tick++; if (onTick) onTick(tick, controls); else zero(); fn(); });
    } });
    await hooks.start({
        log: { info: (s) => logs.push(s), warn: (s) => logs.push(s) },
        signals: { watch: (s, v, handlers, log, opts) => { speed = handlers.statusCarSpeed2; unavailable = opts.onUnavailable; return Promise.resolve(); } },
        ui: { text: async () => {}, isVisible: () => flags.visible, hasFocus: () => flags.focus,
            onClick: (name, cb) => { callbacks[name] = cb; },
            onVisible: (cb) => { callbacks.visible = cb; }, onFocus: (cb) => { callbacks.focus = cb; } },
    });
    return {
        click: () => callbacks.BTN_START(), read: () => callbacks.BTN_READ(),
        advance: (ms) => { clock += ms; }, speed: (v) => speed(v), flags, callbacks, logs,
        starts: () => starts, reads: () => reads, ticks: () => tick,
    };
}
(async () => {
    await test('RAM identity and status decoding', async () => {
        const d = ecu([ident, status(2)]);
        await ram.identify(d);
        assert.strictEqual((await ram.readStatus(d)).text, '完成，无错误');
        assert.strictEqual(d.listenerCount('frame'), 0);
    });
    await test('wrong ECU identity cannot start calibration', async () => {
        const d = ecu([[0x62, 0xF1, 0x50, 1, 2, 3]]);
        await rejected(() => ram.calibrate(d, () => {}, () => {}, async () => {}), '未识别');
        assert.strictEqual(countStarts(d), 0);
    });
    await test('malformed routine reply rejected', async () => {
        await rejected(() => ram.readStatus(ecu([[0x71, 3, 0xA0, 0x91]])), '长度');
    });
    await test('pending reply is awaited, unrelated ECU ignored', async () => {
        const d = ecu([{ frames: [{ ecu: 0x12, uds: status(3) }, [0x7F, 0x31, 0x78], status(2)] }]);
        assert.strictEqual((await ram.readStatus(d)).code, 2);
    });
    await test('calibration starts once and polls until complete', async () => {
        const d = ecu([ident, status(0), accepted, status(1), status(2)]);
        let checks = 0;
        assert((await ram.calibrate(d, () => { checks++; }, () => {}, async () => {})).includes('校准成功'));
        assert.strictEqual(countStarts(d), 1); assert.strictEqual(checks, 1);
    });
    await test('already-running routine is not started again', async () => {
        const d = ecu([ident, status(1)]);
        await rejected(() => ram.calibrate(d, () => {}, () => {}, async () => {}), '已在校准');
        assert.strictEqual(countStarts(d), 0);
    });
    await test('NRC 24 permits first run without a previous result', async () => {
        const d = ecu([ident, [0x7F, 0x31, 0x24], accepted, status(2)]);
        await ram.calibrate(d, () => {}, () => {}, async () => {});
        assert.strictEqual(countStarts(d), 1);
    });
    await test('other negative responses prevent a start', async () => {
        const d = ecu([ident, [0x7F, 0x31, 0x22]]);
        await rejected(() => ram.calibrate(d, () => {}, () => {}, async () => {}), 'NRC');
        assert.strictEqual(countStarts(d), 0);
    });
    await test('movement during identification prevents the final write', async () => {
        const d = ecu([ident, status(0)]);
        await rejected(() => ram.calibrate(d, () => { throw Error('moving'); }, () => {}, async () => {}), 'moving');
        assert.strictEqual(countStarts(d), 0);
    });
    await test('ambiguous timeout never retries the start', async () => {
        const d = ecu([ident, status(0), null]);
        await rejected(() => ram.calibrate(d, () => {}, () => {}, async () => {}), '请先读取 RAM 状态');
        assert.strictEqual(countStarts(d), 1); assert.strictEqual(d.listenerCount('frame'), 0);
    });
    await test('transport failure never retries the start', async () => {
        const d = ecu([ident, status(0), new Error('transport failed')]);
        await rejected(() => ram.calibrate(d, () => {}, () => {}, async () => {}), '请先读取 RAM 状态');
        assert.strictEqual(countStarts(d), 1); assert.strictEqual(d.listenerCount('frame'), 0);
    });
    await test('ECU-reported failure is not reported as success', async () => {
        const d = ecu([ident, status(0), accepted, status(3)]);
        assert((await ram.calibrate(d, () => {}, () => {}, async () => {})).includes('有错误'));
    });
    await test('disconnected diagnostics do not send requests', async () => {
        const d = ecu([]); d.available = false;
        await rejected(() => ram.identify(d), '不可用'); assert.strictEqual(d.calls.length, 0);
    });
    await test('no speed and invalid speed cannot authorize a calibration', async () => {
        const u = await ui(); await u.click(); u.advance(1500); await u.click();
        u.speed({ speedVehicleCentreOfGravity: 65535 }); await u.click();
        assert.strictEqual(u.starts(), 0);
    });
    await test('zero speed and two deliberate clicks authorize one calibration', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); assert.strictEqual(u.starts(), 0);
        u.advance(1500); await u.click(); assert.strictEqual(u.starts(), 1);
        assert.strictEqual(u.ticks(), 20);
    });
    for (const [name, interrupt] of [
        ['movement then rest', c => { c.move(); c.zero(); }],
        ['lost signal then recovery', c => { c.disconnect(); c.zero(); }],
        ['stale signal then recovery', c => { c.skip(6000); c.zero(); }],
        ['page blur', c => c.leave()], ['cancel button', c => c.click()],
    ]) await test(name + ' cancels the countdown and requires new confirmation', async () => {
        const u = await ui((n, c) => { c.zero(); if (n === 20) interrupt(c); });
        u.speed({ speedVehicleCentreOfGravity: 0 }); await u.click(); u.advance(1500); await u.click();
        assert.strictEqual(u.starts(), 0); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('silence cancels the countdown', async () => {
        const u = await ui(() => {}); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(1500); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('movement during final module check also blocks start', async () => {
        const u = await ui(null, c => { c.move(); c.zero(); }); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(1500); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('rapid double click is insufficient', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(100); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('stale stationary signal is rejected', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(6000); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('movement invalidates confirmation', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(1500); u.speed({ speedVehicleCentreOfGravity: 64 });
        await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('leaving and reopening page requires a fresh confirmation', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.callbacks.visible('MAIN', false);
        u.advance(1500); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('unfocused page cannot start', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(1500); u.flags.focus = false;
        await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('confirmation expires after fifteen seconds', async () => {
        const u = await ui(); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); u.advance(16000); u.speed({ speedVehicleCentreOfGravity: 0 });
        await u.click(); assert.strictEqual(u.starts(), 0);
    });
    await test('reading status is available without a speed signal and resets confirmation', async () => {
        const u = await ui(); await u.read(); assert.strictEqual(u.reads(), 1);
        u.speed({ speedVehicleCentreOfGravity: 0 }); await u.click();
        u.advance(1500); await u.read(); await u.click(); assert.strictEqual(u.starts(), 0);
    });
    console.log(`RAM microphone: ${passed} offline behavioural tests passed; no vehicle calibration executed`);
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
