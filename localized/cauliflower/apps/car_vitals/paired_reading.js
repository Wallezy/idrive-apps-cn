'use strict';
// CN integration: keep missing/invalid samples out of paired gauges and history.
const PAIRS = {
    boostCtl: ['boostTarget', 'boostActual'],
    load: ['loadTarget', 'loadActual'],
};
const finite = (v) => typeof v === 'number' && isFinite(v);

async function readPair(reader, config, key, getBarometer) {
    if (!Object.prototype.hasOwnProperty.call(PAIRS, key)) throw new Error('Unknown paired reading');
    const keys = PAIRS[key];
    let target = await reader.value(keys[0], config[keys[0]]);
    if (!finite(target)) return null;
    let actual = await reader.value(keys[1], config[keys[1]]);
    if (!finite(actual)) actual = null;
    if (key === 'boostCtl') {
        // Both pressures share the same ambient sample and conversion.
        const ambient = await getBarometer();
        if (!finite(ambient)) return null;
        target = (target - ambient) / 100;
        actual = actual === null ? null : (actual - ambient) / 100;
    }
    return { target, actual };
}

module.exports = { PAIRS, readPair };
