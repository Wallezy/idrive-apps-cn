'use strict';
// Exercise actual height-control guards without opening vehicle services.
const assert = require('assert');
const { ParkGuard, VdpControl } = require('../apps/ride_height/package/javascript/control');
(async () => {
    const callbacks = {};
    const signals = { watch: async (service, instance, handlers) => {
        Object.assign(callbacks, handlers);
        return { available: true, error: null };
    } };
    const guard = await new ParkGuard(signals, {}).init();
    assert.throws(() => guard.check());
    callbacks.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    callbacks.statusGearboxDrive({ statusActualStageDrive: 'P' });
    assert.doesNotThrow(() => guard.check());
    callbacks.statusCarSpeed2({ speedVehicleCentreOfGravity: 65535 });
    assert.throws(() => guard.check(), /fresh|stationary/);
    callbacks.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    callbacks.statusGearboxDrive({ statusActualStageDrive: 'D' });
    assert.throws(() => guard.check(), /stationary/);
    callbacks.statusGearboxDrive({ statusActualStageDrive: 'P' });
    guard.speedAt = Date.now() - 4000;
    assert.throws(() => guard.check(), /fresh/);
    callbacks.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    let writes = 0;
    // Call the production run method with a simulated diagnostic reader.
    const ctx = { guard, busy: false, requireVdpStopped: async () => { throw Error('Vehicle is moving'); } };
    await assert.rejects(VdpControl.prototype.run.call(ctx, () => { writes++; }), /moving/);
    assert.strictEqual(writes, 0);
    assert.strictEqual(ctx.busy, false);
    guard.subs[0].error = Error('disconnected');
    await assert.rejects(VdpControl.prototype.run.call(ctx, () => { writes++; }), /unavailable/);
    assert.strictEqual(writes, 0);
    console.log('Height controls: missing, invalid, stale, moving and disconnected signals block actuation');
})().catch(e => { console.error(e); process.exitCode = 1; });
