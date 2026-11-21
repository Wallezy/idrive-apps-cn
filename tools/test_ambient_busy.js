'use strict';
// The shipped discovery path retries only explicit busy reads and stops at a fixed bound.
const assert = require('assert');
const { Lights } = require('../apps/ambient_config/package/javascript/lights');
const log = { info() {}, warn() {} };
function reply(did) {
    const bytes = [0x62].concat(did, [0x0f, 254, 60, 120, 100, 0, 0, 0, 0, 0]);
    for (let i = 1; i < 26; i++) bytes.push(0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7);
    return bytes.concat([2]);
}
async function scenario(answer, stop) {
    const calls = [], waits = [];
    let lights;
    lights = new Lights({ log, diag: { async physical(ecu, service, data) {
        assert.strictEqual(service, 0x22, 'discovery must never write');
        if (ecu === 0x40) calls.push(data.join(','));
        return answer(data, calls);
    } }, sleep: async (ms) => { waits.push(ms); if (stop) lights.stop(); } });
    try {
        const found = await lights.find();
        return { found, calls, waits };
    } finally { lights.stop(); }
}
(async () => {
    let result = await scenario((did, calls) => calls.filter((x) => x === did.join(',')).length < 3
        ? [0x7f, 0x22, 0x21] : reply(did));
    assert.strictEqual(result.found.length, 2);
    assert.deepStrictEqual(result.waits, [400, 800, 400, 800]);
    result = await scenario(() => [0x7f, 0x22, 0x21]);
    assert.strictEqual(result.calls.filter((x) => x !== '241,134').length, 14, 'seven attempts per bus, then stop');
    assert.strictEqual(result.found.length, 0);
    for (const answer of [null, [0x7f, 0x22, 0x31], [0x7f, 0x2e, 0x21]]) {
        result = await scenario(() => answer);
        assert.strictEqual(result.calls.filter((x) => x !== '241,134').length, 2);
        assert.strictEqual(result.waits.length, 0, 'no retry on silence, refusal or another service');
    }
    result = await scenario(() => { throw new Error('transport unavailable'); });
    assert.strictEqual(result.calls.filter((x) => x !== '241,134').length, 2);
    assert.strictEqual(result.waits.length, 0);
    result = await scenario(() => [0x7f, 0x22, 0x21], true);
    assert.strictEqual(result.calls.length, 1, 'stop prevents retries and the second bus read');
    console.log('Ambient busy-read recovery: passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
