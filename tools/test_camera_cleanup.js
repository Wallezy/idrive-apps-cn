'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const file = path.join(__dirname, '../native/front-camera-cluster-helper/files/controller.js');
function controller(outputs) {
    const calls = [];
    let now = Date.now();
    const cp = { spawnSync(binary, args) {
        calls.push(args);
        if (args[0] === 'screen' && args.length === 2) return { status: 0, stdout: outputs[args[1]] };
        return { status: 0, stdout: '' };
    } };
    const mod = { exports: {} };
    const requireStub = (name) => {
        if (name === 'child_process') return cp;
        if (name === 'fs') return { appendFileSync() {} };
        if (name === 'net') return {};
        throw Error(name);
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8') +
        '\nmodule.exports.ensureProjectionForTest = ensureProjection;', {
        require: requireStub, module: mod, process: { env: {}, argv: [] },
        Date: class extends Date { static now() { return now; } }, Buffer,
    }, { filename: file });
    assert.strictEqual(calls.length, 0, 'import must not touch the compositor');
    return { api: mod.exports, calls, advance(ms) { now += ms; } };
}
const c = controller({ 5: 'layers: 50331948 50331949 88001 65010 88002\n', 8: 'layers: 67109165 65011 88003\n' });
c.api.removeProjection();
assert.deepStrictEqual(JSON.parse(JSON.stringify(c.calls.filter(x => x[2] === 'renderorder'))), [
    ['screen', '5', 'renderorder', '50331948', '50331949', '88001', '88002'],
    ['screen', '8', 'renderorder', '67109165', '88003'],
], 'preserve other clients and their relative order');
const bad = controller({ 5: 'unrecognized response', 8: 'unrecognized response' });
bad.api.removeProjection();
assert(!bad.calls.some(x => x[2] === 'renderorder'), 'failed query cannot erase the panel layer list');
assert.deepStrictEqual(JSON.parse(JSON.stringify(bad.calls.filter(x => x[0] === 'layer'))), [
    ['layer', '65010', 'destroy'], ['layer', '65011', 'destroy'],
]);
for (const value of [null, undefined, -1, NaN, Infinity, '0', 15.01]) {
    assert.throws(() => c.api.renewLease(value), /Fresh live/);
}
assert.doesNotThrow(() => c.api.renewLease(0));
assert.doesNotThrow(() => c.api.renewLease(15));
const expired = controller({});
expired.api.renewLease(0);
expired.advance(5001);
assert.throws(() => expired.api.ensureProjectionForTest(), /lease expired/);
assert.strictEqual(expired.calls.length, 0, 'slow source discovery cannot attach with an expired speed lease');
console.log('Camera cleanup: unrelated layers preserved; malformed queries fail closed; import has no side effects');
