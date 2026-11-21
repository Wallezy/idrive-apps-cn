'use strict';
// Real controller with virtual time and isolated seat providers; no vehicle access.
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const file = path.join(__dirname, '../apps/rear_comfort/package/javascript/control.js');
function world(handler) {
    let now = 0;
    const timers = [], calls = [], module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, exports: module.exports, Date: { now: () => now },
        setTimeout: (fn, delay) => timers.push({ at: now + delay, fn }),
    }, { filename: file });
    const signals = {
        call: async (provider, method, args) => {
            calls.push({ method, args });
            return handler ? handler(method, args) : method === 'startSeatOperation' ? { requestorID: calls.length } : {};
        },
        set: async (provider, field, value) => {
            calls.push({ field, value });
            if (handler) return handler('set', { field, value });
        },
    };
    const rear = new module.exports.RearControl(signals, { warn() {}, info() {}, error() {} });
    rear.p.seat = {}; rear.p.comfort = {};
    rear.state.available.seat = rear.state.available.comfort = true;
    return {
        rear, calls,
        async settle(promise) {
            let result, error, done = false;
            promise.then(v => { result = v; done = true; }, e => { error = e; done = true; });
            for (let i = 0; !done && i < 3000; i++) {
                for (let j = 0; j < 20; j++) await Promise.resolve();
                if (timers.length) {
                    timers.sort((a, b) => a.at - b.at);
                    const t = timers.shift(); now = t.at; t.fn();
                }
            }
            assert(done, 'controller must finish after provider completion and virtual timers');
            return { result, error };
        },
    };
}
(async () => {
    let w = world((method, args) => {
        if (method === 'startSeatOperation') {
            if (args.seatPosition === 'REAR_LEFT') throw Error('left unavailable');
            return { requestorID: 2 };
        }
    });
    let r = await w.settle(w.rear.visibilityMode());
    assert.match(r.error.message, /left unavailable/);
    assert(w.calls.some(c => c.method === 'stopSeatOperation' && c.args.requestorID === 2));
    assert.strictEqual(w.rear.activeSeatRequests.size, 0);
    assert.strictEqual(w.rear.busy, false);
    assert.strictEqual(w.rear.state.seatMotion.active, false);
    assert(w.calls.filter(c => c.method === 'startSeatOperation').length <= 2, 'no later preset phase after failure');

    let grant;
    w = world(method => method === 'startSeatOperation' ? new Promise(resolve => { grant = resolve; }) : {});
    let moving = w.rear.moveSeat('right', 'SEAT_ADJUSTMENT_HORIZONTAL_FRONT');
    await w.rear.stopSeatMovement();
    grant({ requestorID: 7 });
    r = await w.settle(moving);
    assert.match(r.error.message, /stopped/);
    assert(w.calls.some(c => c.method === 'stopSeatOperation' && c.args.requestorID === 7));
    assert(!w.calls.some(c => c.method === 'aliveSeatOperation'), 'late grant must be stopped without a keepalive');
    const before = w.calls.length;
    await assert.rejects(w.rear.moveSeatRaw('REAR_RIGHT', 'test', 1, 0), /stopped/);
    assert.strictEqual(w.calls.length, before, 'cancelled next phase must not issue a start');

    let cancelled = false;
    w = world((method, args) => {
        if (method === 'startSeatOperation') return { requestorID: 9 };
        if (method === 'stopSeatOperation' && !cancelled) { cancelled = true; w.rear.stopSeatMovement(); }
    });
    r = await w.settle(w.rear.loungeMode(true));
    assert.match(r.error.message, /stopped/);
    assert.strictEqual(w.calls.filter(c => c.method === 'startSeatOperation').length, 1);
    assert(!w.calls.some(c => c.field), 'cancelled lounge must not press the sleep button');

    w = world((method, args) => {
        if (method === 'set' && args.value.operationFunctionResetButtonPSSR === 'TASTE_BETAETIGT')
            throw Error('reply lost');
    });
    r = await w.settle(w.rear.pulseRearSeatButton('right', 'reset', w.rear.seatCancelToken));
    assert.match(r.error.message, /reply lost/);
    assert.strictEqual(w.calls.at(-1).value.operationFunctionResetButtonPSSR, 'KEINE_AKTION');
    assert.strictEqual(w.rear.activeSeatButtons.size, 0);

    w = world();
    const pulse = w.rear.pulseRearSeatButton('right', 'sleep', w.rear.seatCancelToken);
    await Promise.resolve();
    await w.rear.stopSeatMovement();
    assert(w.calls.some(c => c.value && c.value.operationFunctionSleepingPositionButtonPSSR === 'KEINE_AKTION'));
    r = await w.settle(pulse);
    assert.match(r.error.message, /stopped/);

    w = world();
    r = await w.settle(w.rear.visibilityMode());
    assert.ifError(r.error);
    assert.strictEqual(w.calls.filter(c => c.method === 'startSeatOperation').length, 8);
    assert.strictEqual(w.rear.activeSeatRequests.size, 0);
    assert.strictEqual(w.rear.state.seatModes.visibility, true);
    w.rear.seatVisible = false;
    r = await w.settle(w.rear.moveSeat('left', 'test'));
    assert.match(r.error.message, /stopped/);

    const Display = require('../apps/rear_comfort/package/javascript/kit/display');
    const touch = Display.Display ? Display.Display.prototype._touch : Display.prototype._touch;
    const fake = { own: () => true, sheet: null, onTouch: () => true,
        ownDown: 'old', downAt: {}, dragging: true, log: { error(e) { throw e; } } };
    touch.call(fake, 3, 100, 200);
    assert.strictEqual(fake.ownDown, null);
    assert.strictEqual(fake.downAt, null);
    assert.strictEqual(fake.dragging, false);
    const displayPrototype = Display.Display ? Display.Display.prototype : Display.prototype;
    let covered = 0;
    assert(displayPrototype.openSheet.call({
        canSheet: () => true, sheetTimer: 1, _paintSheet() {},
        _layoutChanged() { covered++; },
    }, {}));
    assert.strictEqual(covered, 1, 'an in-app settings sheet must notify the page to cancel its hold');
    const manifest = require('../apps/rear_comfort/package/manifest.json').proxies;
    const climate = manifest['de.bmw.infotainment.climate.Climate'].attributes;
    const comfort = manifest['de.bmw.infotainment.misc.ComfortFunctionIuK'].attributes;
    assert.strictEqual(climate.acSpecialFunction, 'w');
    assert.strictEqual(climate.statusACFront, 'rs');
    assert.strictEqual(comfort.seatAdjustmentDRR, 'w');
    assert.strictEqual(comfort.seatAdjustmentPSR, 'w');
    // The actual page's raw-touch and lifecycle handlers, with isolated motion.
    w = world();
    let starts = 0, stops = 0, render, rawTouch, layout, visible, focus;
    const handlers = {}, app = new (require('events'))();
    const pageRear = w.rear;
    pageRear.init = async () => {};
    pageRear.moveSeat = async () => { starts++; };
    pageRear.stopSeatMovement = async () => { stops++; pageRear.seatCancelToken++; };
    const cv = new Proxy({}, { get: (target, name) => name === 'clear' ? () => cv : () => {} });
    const ctx = {
        signals: {}, log: { warn() {} }, app,
        ui: { isVisible: () => true, hasFocus: () => true, image: async () => {},
            onVisible: fn => { visible = fn; }, onFocus: fn => { focus = fn; },
            onClick: (id, fn) => { handlers[id] = fn; } },
        theme: () => ({ text: '#fff', dim: '#aaa' }), canvas: () => cv,
        onLayout: fn => { layout = fn; }, onTab() {}, onTap() {},
        onTouch: fn => { rawTouch = fn; }, loop: (id, fps, fn) => { render = fn; },
    };
    let start;
    const entry = fs.readFileSync(path.join(path.dirname(file), 'localized-entry.js'), 'utf8');
    vm.runInNewContext(entry, {
        Buffer, console, require: name => {
            if (name === './app.js') return {};
            if (name === './kit/mgu') return { run: impl => { start = impl.start(ctx); } };
            if (name === './kit/gauges') return { frame() {} };
            if (name === './kit/canvas') return { withAlpha: color => color };
            if (name === './kit/record') return { setImage() {} };
            if (name === './control') return { RearControl: function () { return pageRear; } };
            if (name === './kit/pack') throw Error('offline assets');
            return require(name);
        },
    }, { filename: 'rear-page.js' });
    await start;
    handlers.BTN_PAGE(); handlers.BTN_PAGE(); await render();
    rawTouch(1, 1100, 435); rawTouch(3, 1100, 435);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.strictEqual(starts, 0, 'release before the queued start must cancel it');
    rawTouch(1, 1100, 435);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.strictEqual(starts, 1);
    rawTouch(2, 20, 20);
    const stoppedAfterLeave = stops;
    visible('MAIN', false); focus('MAIN', false); layout(); app.emit('shutdown');
    assert.strictEqual(stops, stoppedAfterLeave + 4, 'all lifecycle loss paths stop seat requests');
    assert.strictEqual(pageRear.seatVisible, false);
    console.log('Rear seats: sibling failure, late grant, cancelled phases, button release, hidden-page refusal and raw touch passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
