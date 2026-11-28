'use strict';
// Exercise the shipped SOME/IP watcher with a fake native binding, never a car.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const file = path.resolve(__dirname, '../apps/cluster_metrics/package/javascript/kit/signals.js');
let available, receive, finishRead;
let reads = 0, closed = 0, delivered = 0;
const timers = new Map();
const proxy = {
    init: () => Promise.resolve(), isAvailable: () => false,
    subscribeToAvailability: (fn) => { available = fn; },
    subscribe: (o) => { receive = o.onReceive; return Promise.resolve(); },
    getValue: () => { reads++; return new Promise((resolve) => { finishRead = resolve; }); },
    shutdown: () => { closed++; return Promise.resolve(); },
};
const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(file),
    require(name) {
        if (name === 'someip') return { buildProxy: () => Promise.resolve(proxy) };
        if (name === 'fs') return { readFileSync: () => JSON.stringify({ fields: { waypoints: { getter: {} } } }) };
        return require(name);
    },
    setImmediate,
    setInterval: (fn) => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
};
vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
const tick = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
    const watch = await sandbox.module.exports.watch('test.Phone', 'Main_Instance',
        { waypoints() { delivered++; } }, { warn() {} }, { pollMs: 3000 });
    assert.strictEqual(timers.size, 1);
    available(true);
    await tick();
    assert.strictEqual(reads, 1);
    receive({});
    assert.strictEqual(delivered, 1);
    await watch.shutdown();
    assert.strictEqual(timers.size, 0, 'all polling stops on shutdown');
    finishRead({});
    available(true);
    receive({});
    await tick();
    assert.strictEqual(watch.available, false);
    assert.strictEqual(delivered, 1, 'late reads/events cannot resurrect stale navigation');
    assert.strictEqual(reads, 1);
    assert.strictEqual(closed, 1);
    console.log('PASS optional navigation watcher releases polling and ignores late values after shutdown');
})().catch((e) => { console.error(e); process.exitCode = 1; });
