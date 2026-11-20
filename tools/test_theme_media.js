'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const kit = path.join(root, 'apps/cluster_themes/package/javascript/kit');
const iface = 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState';
const manifest = require('../apps/cluster_themes/package/manifest.json');
assert.strictEqual(manifest.proxies[iface].instances, '*');

async function check(instances, expected) {
    const calls = [];
    const proxy = {
        init: async () => {},
        subscribeToAvailability: () => {},
        subscribe: async () => {},
        shutdown: async () => {},
    };
    const module = { exports: {} };
    const context = {
        module, __dirname: kit, setImmediate, setInterval,
        require(name) {
            if (name === 'fs') return {
                readFileSync: () => JSON.stringify({ instances, fields: {} }),
            };
            if (name === 'someip') return {
                buildProxy: async (config, instance) => {
                    calls.push(instance);
                    return proxy;
                },
            };
            return require(name);
        },
    };
    vm.runInNewContext(fs.readFileSync(path.join(kit, 'signals.js'), 'utf8'), context);
    const sub = await module.exports.watch(iface, ['HMI_CID', '1'], { playerMetadata() {} });
    assert.deepStrictEqual(calls, expected ? [expected] : []);
    assert.strictEqual(Boolean(sub.error), !expected);
    await sub.shutdown();
}

function checkCarSubscription() {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(kit, 'car.js'), 'utf8'), {
        module, setInterval() {},
        require: (name) => require(path.join(kit, name)),
    });
    const calls = [];
    const ctx = {
        spec: {}, log: { info() {} },
        signals: { watch: async (...args) => { calls.push(args); return {}; } },
    };
    new module.exports(ctx, ['speed'], {
        [iface]: { $instances: ['HMI_CID', '1'], playerMetadata() {}, trackProgress() {} },
    });
    const media = calls.find((call) => call[0] === iface);
    assert.deepStrictEqual(media[1], ['HMI_CID', '1']);
    assert.deepStrictEqual(Object.keys(media[2]).sort(), ['playerMetadata', 'trackProgress']);
    assert.strictEqual(calls.find((call) => call[0].endsWith('.Vehicle2'))[1], '1');
}

(async () => {
    checkCarSubscription();
    await check({ HMI_CID: 1, HMI_FoMo_Left: 2, HMI_FoMo_Right: 3 }, 'HMI_CID');
    await check({ '1': 1 }, '1');
    await check({ HMI_CID: 1, '1': 4 }, 'HMI_CID');
    await check({ HMI_FoMo_Left: 2, HMI_FoMo_Right: 3 }, null);
    await check({}, null);
    console.log('Theme media: named front instance, numeric instance, priority and unsupported-instance handling passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
