'use strict';
const assert = require('assert');
const { openMappedEntry } = require('../runtime/open-entry');

async function main() {
    let mapped = true;
    const clearMapping = () => { mapped = false; };
    const rhmi = {
        openEntryState: () => Promise.resolve('entry'),
        openState: (state) => {
            assert.strictEqual(state, 'MAIN');
            assert.strictEqual(mapped, false);
            return Promise.resolve('fallback');
        },
    };
    assert.strictEqual(await openMappedEntry(rhmi, 'uuid', 'MAIN', clearMapping), 'entry');
    assert.strictEqual(mapped, true);

    const stale = { code: 'INVALID_UUID' };
    stale.self = stale;
    rhmi.openEntryState = () => Promise.reject(stale);
    assert.strictEqual(await openMappedEntry(rhmi, 'uuid', 'MAIN', clearMapping), 'fallback');
    assert.strictEqual(mapped, false);

    mapped = true;
    const failure = new Error('service unavailable');
    failure.self = failure;
    rhmi.openEntryState = () => Promise.reject(failure);
    let rejected;
    try {
        await openMappedEntry(rhmi, 'uuid', 'MAIN', clearMapping);
    } catch (error) {
        rejected = error;
    }
    assert.strictEqual(rejected, failure);
    assert.strictEqual(mapped, true);
    console.log('monitor entry: mapped open, stale UUID recovery and original errors passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
