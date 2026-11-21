'use strict';
const assert = require('assert');
const { RearControl, active, blowerStage, rearTemperature } = require('../apps/rear_comfort/package/javascript/control');
(async () => {
    for (const off of ['INAKTIV', 'AUS', 'OFF', 'SIGNAL_UNGUELTIG']) assert.strictEqual(active(off), false);
    assert.strictEqual(active('AKTIV'), true);
    assert.strictEqual(blowerStage('STUFE_9'), 9);
    assert.strictEqual(rearTemperature(44), 22);
    assert.strictEqual(rearTemperature(255), null);
    const handlers = {}, writes = [], proxy = {};
    const signals = {
        watch: async (iface, instance, callbacks) => {
            if (iface === 'de.bmw.infotainment.climate.Climate') Object.assign(handlers, callbacks);
            return { proxy, available: true };
        },
        onAvailable: async () => {},
        set: async (p, field, value) => { writes.push({ field, value }); },
    };
    const rear = await new RearControl(signals, { info() {}, warn() {} }).init();
    handlers.statusACFond2({ statusTemperatureTarget2TierDR: 44, statusTemperatureTarget2TierPS: 46,
        statusOn2Tier: 'EIN', statusModeAirConditioning2Tier: 'INAKTIV', statusManualBlowerLevel2RowOfSeats: 'STUFE_7' });
    assert.strictEqual(rear.state.climate.left, 22);
    assert.strictEqual(rear.state.climate.right, 23);
    assert.strictEqual(rear.state.climate.auto, false);
    assert.strictEqual(rear.state.climate.blower, 7);
    await rear.setBlower(9);
    assert.strictEqual(writes[0].field, 'acFond');
    assert.strictEqual(writes[0].value.operationManualBlowerLevelClimate2SeatRow, 'STUFE_9');
    assert.strictEqual(writes[0].value.operationManualBlowerLevelClimate3SeatRow, 'SIGNAL_UNBEFUELLT');
    assert.strictEqual(writes[0].value.operationTemperatureTarget2TierDR, 255);
    await rear.setClimateMode(true);
    assert.strictEqual(writes[1].value.operationModeAirConditioning2Tier, 'EIN');
    assert(writes.every(w => w.field === 'acFond'), 'climate fixes do not command seats');
    console.log('Rear climate: status decoding, inactive values and isolated blower commands passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
