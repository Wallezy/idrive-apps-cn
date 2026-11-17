'use strict';
/**
 * awake.js - is the car switched on? The app asks the engine unit nothing while it isn't.
 *
 * After the car is switched off the head unit stays on for a while (doors, lights, until the car
 * sleeps). A diagnostic request in that time goes through the gateway and can keep the car's bus and
 * the engine unit from going to sleep: the car then says "Energy management: a service could not be
 * switched off". So reading pauses as soon as the car leaves the ignition-on states and goes on when
 * the ignition is back.
 *
 * The state is BMW's vehicle condition (de.bmw.infrastructure.VehicleCondition, field
 * statusConditionVehicle), names or wire numbers:
 *   1-5  parked, standing functions, living (no ignition)        -> off: no requests
 *   7    PRUEFEN_ANALYSE_DIAGNOSE (ignition on)                    -> on
 *   8    FAHRBEREITSCHAFT_HERSTELLEN (starting)                    -> on
 *   10   FAHREN (drive-ready)                                      -> on
 *   12   FAHRBEREITSCHAFT_BEENDEN (switching off)                  -> off
 * Until the head unit has told a state (the emulator, a unit without the signal) the app reads as before.
 *
 *   const awake = new Awake(ctx.signals, log);
 *   awake.start();
 *   awake.on            true when reading is allowed
 *   awake.known         a state has come
 *   awake.onChange(fn)  fn(on) when it changes
 */
const IFACE = 'de.bmw.infrastructure.VehicleCondition';
const NAMES = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3, WOHNEN: 5,
    PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const ON = [7, 8, 10];

/** statusConditionVehicle -> 1..12, or undefined (no value). */
function conditionOf(x) {
    const n = typeof x === 'number' ? x : NAMES[x];
    return n >= 1 && n <= 12 ? n : undefined;
}

class Awake {
    constructor(signals, log) {
        this.signals = signals;
        this.log = log;
        this.condition = undefined;
        this.fns = [];
        this.sub = null;
    }

    get known() { return this.condition !== undefined; }
    get on() { return this.condition === undefined || ON.indexOf(this.condition) >= 0; }

    onChange(fn) { this.fns.push(fn); }

    set(cond) {
        if (cond === undefined || cond === this.condition) return;
        const was = this.on, first = this.condition === undefined;
        this.condition = cond;
        this.log.info('vehicle condition ' + cond + (this.on ? ' (ignition on: reading)' : ' (switched off: no requests)'));
        if (this.on !== was || first) this.fns.forEach((fn) => { try { fn(this.on); } catch (e) { this.log.warn('awake: ' + e); } });
    }

    start() {
        return this.signals.watch(IFACE, '1', { VehicleCondition: (v) => this.set(conditionOf(v && v.statusConditionVehicle)) }, this.log)
            .then((s) => { this.sub = s; this.log.info('vehicle condition: ' + (s.error ? 'not available (' + s.error + '), reading as before' : 'subscribed')); return s; })
            .catch((e) => { this.log.warn('vehicle condition: ' + e); return null; });
    }

    stop() { return this.sub ? this.sub.shutdown() : Promise.resolve(); }
}

module.exports = { Awake, conditionOf, ON };
