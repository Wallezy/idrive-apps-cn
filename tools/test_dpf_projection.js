'use strict';
const assert = require('assert');
const D = require('../apps/dpf_monitor/package/javascript/dpf');
const i18n = require('../apps/dpf_monitor/package/javascript/kit/i18n');
const normal = { averageIntervalKm: 462, distanceSinceKm: 284.7, operatingSeconds: 12640, successfulRegens: 347 };
const e = D.nextRegenEstimate(normal);
assert.strictEqual(e.ready, true);
assert(Math.abs(e.remainingDistance - 177.3) < 0.001);
assert(Math.abs(e.etaMinutes - 131.19) < 0.1);
assert.strictEqual(e.confidence, 'HIGH');
assert.strictEqual(D.nextRegenEstimate({ ...normal, active: true }).ready, false);
for (const bad of [null, NaN, 65535, -1]) {
    assert.strictEqual(D.nextRegenEstimate({ ...normal, averageIntervalKm: bad }).ready, false);
}
const due = D.nextRegenEstimate({ ...normal, distanceSinceKm: 480 });
assert.strictEqual(due.remainingDistance, 0);
assert.strictEqual(due.etaMinutes, 0);
const speed = D.nextRegenEstimate({ ...normal, operatingSeconds: 0, currentSpeed: 60 });
assert.strictEqual(speed.timeBasis, 'current speed fallback');
assert.strictEqual(D.nextRegenEstimate({ ...normal, operatingSeconds: 0 }).etaMinutes, null);
assert.strictEqual(i18n.t('Next regen'), '下次再生');
assert.strictEqual(i18n.t('HIGH CONFIDENCE'), '较高可信度');
console.log('DPF projection: measured, missing, invalid, active and speed-fallback cases passed');
