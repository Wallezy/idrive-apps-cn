'use strict';
// Old head-unit JavaScript lacks Promise.finally; completed deliveries must release the sending state.
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../apps/osa/package/javascript/oil-notification.js'), 'utf8');
let poll, clock = 0, sends = 0;
const warnings = [], sample = {enabled: true, oil: 60, target: 80}, moduleMock = {exports: {}};
const savedFinally = Promise.prototype.finally;
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
(async () => {
    try {
        Promise.prototype.finally = undefined;
        vm.runInNewContext(source, {
            module: moduleMock, exports: moduleMock.exports, Promise, Number,
            Date: {now: () => clock}, process: {env: {}}, setTimeout,
            setInterval(fn) { poll = fn; return {unref() {}}; },
            require(id) {
                if (id === './kit/notification-tool') return {async show() { sends++; return {ok: true}; }};
                if (id === './cluster-locales') return {warmupLabel: () => '油温已达标'};
                throw new Error(id);
            },
        });
        moduleMock.exports.start({info() {}, warn: value => warnings.push(String(value))},
            () => sample, () => 'zh-CN');
        sample.oil = 80; clock = 1000; poll(); await flush();
        assert.strictEqual(sends, 1, 'first warming delivers one notification');
        clock = 1500; poll(); await flush();
        assert.strictEqual(sends, 1, 'no duplicate while warm');
        sample.oil = 77; clock = 6000; poll(); await flush();
        sample.oil = 80; clock = 7000; poll(); await flush();
        assert.strictEqual(sends, 2, 'completed sending state releases and a new warm-up can notify');
        assert.deepStrictEqual(warnings, [], 'no missing runtime API or polling warning');
        console.log('Oil notifications: Promise.finally-free old-runtime delivery, cleanup and re-arm passed');
    } finally {
        Promise.prototype.finally = savedFinally;
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
