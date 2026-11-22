'use strict';
const assert = require('assert');
const { Lights } = require('../apps/ambient_config/package/javascript/lights');
const S = require('../apps/ambient_config/package/javascript/scenes');
const log = { info() {}, warn() {} };
function reply(did) { return [0x62, ...did, 6, 0, 0, 0, 100, 0, 0, 0, 0, 0]; }
(async () => {
    const calls = [];
    const l = new Lights({ log, diag: {
        functional: async () => new Map(),
        physical: async (at, sid, did) => { calls.push({ at, sid }); return at === 0x10 ? reply(did) : null; },
    } });
    l._kick = () => {};
    assert.strictEqual((await l.find()).length, 2);
    assert.strictEqual(l.bdc, 0x10);
    assert(calls.every(c => c.sid === 0x22), 'discovery only reads');
    const command = l.command([0xda, 0x5e, 1]);
    await l._run();
    await command;
    assert.strictEqual(calls[calls.length - 1].at, 0x10, 'commands use the validated address');
    l.stop();
    let release;
    const stopped = new Lights({ log, diag: {
        physical: async () => new Promise(resolve => { release = resolve; }),
        functional: async () => { throw Error('scan after stop'); },
    } });
    const finding = stopped.find();
    stopped.stop();
    release(null);
    assert.deepStrictEqual(await finding, []);
    let scans = 0;
    const midScan = new Lights({ log, diag: {
        functional: async () => { scans++; midScan.stop(); return new Map(); },
        physical: async () => { throw Error('physical read after scan stopped'); },
    } });
    assert.strictEqual(await midScan._findBdc(), false);
    assert.strictEqual(scans, 1);
    const writes = [];
    const asleep = new Lights({ log, canProbe: () => false, diag: {
        physical: async (...args) => { writes.push(args); return [0x6e]; },
    } });
    assert.strictEqual(await asleep._tryBlind('fixture'), false);
    assert.strictEqual(writes.length, 0, 'an absent driver prevents blind write probes');
    asleep.stop();
    let answer;
    const leaving = new Lights({ log, diag: {
        physical: async (...args) => {
            writes.push(args);
            return new Promise(resolve => { answer = resolve; });
        },
    } });
    const probing = leaving._tryBlind('fixture');
    leaving.stop();
    answer([0x6e, 0xda, 0x5e]);
    assert.strictEqual(await probing, false);
    assert.strictEqual(writes.length, 1, 'stopping during a probe prevents the next bus write');
    const light = { name: 'Dash decor driver', part: 'upper', x: 0.1, y: 0.1 };
    const scene = { kind: 'solid', upper: { rgb: [255, 0, 0], bright: 100 },
        lower: { rgb: [0, 0, 255], bright: 100 } };
    S.setDecor('upper');
    const upper = S.lightAt(scene, light, 0);
    S.setDecor('lower');
    const lower = S.lightAt(scene, light, 0);
    assert.notDeepStrictEqual(upper.rgb, lower.rgb, 'decor follows its selected group');
    S.setDecor('upper');
    console.log('Ambient discovery: validated fallback address, command routing, stop and decor groups passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
