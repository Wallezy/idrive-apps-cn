'use strict';
// Real Unix sockets exercise the shipped client's handshake, selection and retry behavior.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { RenderClient, SOCKETS } = require('../apps/ambient_config/package/javascript/kit/renderd');
const root = fs.mkdtempSync('/tmp/mgu-compat-');
const servers = [], clients = [];
let serial = 0, checks = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function packet(type, values) {
    const b = Buffer.alloc(8 + values.length * 4);
    b.writeUInt32LE(type, 0); b.writeUInt32LE(values.length * 4, 4);
    values.forEach((v, i) => b.writeUInt32LE(v, 8 + i * 4));
    return b;
}
function event(target, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { target.removeListener(name, done); reject(Error('timeout: ' + name)); }, 9000);
        function done(value) { clearTimeout(timer); resolve(value); }
        target.once(name, done);
    });
}
async function service(mode) {
    const f = { path: path.join(root, 's' + serial++), mode, accepted: 0, messages: [], sockets: new Set() };
    f.server = net.createServer((s) => {
        f.accepted++; f.sockets.add(s);
        s.on('error', () => {}); s.on('close', () => f.sockets.delete(s));
        let buf = Buffer.alloc(0);
        s.on('data', (data) => {
            buf = Buffer.concat([buf, data]);
            while (buf.length >= 8 && buf.length >= 8 + buf.readUInt32LE(4)) {
                const type = buf.readUInt32LE(0), n = buf.readUInt32LE(4);
                f.messages.push(type); buf = buf.slice(n + 8);
                if (type !== 1) continue;
                if (f.mode === 'silent') continue;
                if (f.mode === 'eof') { s.end(); continue; }
                if (f.mode === 'short') { s.write(packet(101, [4])); continue; }
                const ready = packet(101, [4, 1920, 720, f.mode === 'no-touch' ? 0 : 1]);
                const native = packet(0x4d520101, [f.mode === 'future' ? 2 : 1,
                    f.mode === 'no-layer' ? 2 : 3, f.mode === 'no-touch' ? 4 : 7]);
                const reply = f.mode === 'legacy' ? ready : Buffer.concat([native, ready]);
                if (f.mode === 'fragmented') {
                    s.write(reply.slice(0, 5));
                    setTimeout(() => { if (!s.destroyed) s.write(reply.slice(5)); }, 15);
                } else s.write(reply);
            }
        });
    });
    servers.push(f);
    await new Promise((resolve, reject) => { f.server.once('error', reject); f.server.listen(f.path, resolve); });
    return f;
}
function client(paths, options) {
    const c = new RenderClient('ambient_config', { info() {}, warn() {} },
        Object.assign({ native: true, interactive: true, sockets: paths }, options));
    clients.push(c); return c;
}
async function start(c) {
    const ready = event(c, 'ready'); c.connect(); await ready;
    assert(c.ready); checks++;
}

(async () => {
    try {
        if (!process.env.MGU_RENDERD_SOCKET) assert.deepStrictEqual(SOCKETS,
            ['/run/mgu-render/render.sock', '/run/mgu-renderd/renderd.sock']);
        const preferred = await service('native'), old = await service('legacy');
        let c = client([preferred.path, old.path]);
        await start(c);
        assert.strictEqual(c.path, preferred.path); assert.strictEqual(old.accepted, 0); c.close();

        const fallback = await service('native');
        c = client([path.join(root, 'absent'), fallback.path]);
        await start(c); assert.strictEqual(c.path, fallback.path); c.close();

        for (const mode of ['legacy', 'no-touch', 'no-layer', 'future', 'short', 'eof', 'silent']) {
            const bad = await service(mode), good = await service('fragmented');
            c = client([bad.path, good.path]);
            c.place({ x: 0, y: 0, w: 1920, h: 720, scale: 1 }); c.show(true);
            await start(c);
            assert.strictEqual(c.path, good.path, mode + ' must fall through');
            assert.deepStrictEqual(bad.messages, [1], 'no display/input commands before capability acceptance');
            assert.strictEqual(c.native, true); assert.strictEqual(c.touch, true);
            c.close();
        }

        const shared = await service('legacy'), alias = path.join(root, 'alias');
        fs.symlinkSync(shared.path, alias);
        c = client([shared.path, alias]);
        const unavailable = event(c, 'unavailable'); c.connect(); await unavailable;
        assert.strictEqual(c.ready, false);
        await pause(100);
        assert.strictEqual(shared.accepted, 1, 'same service through symlink is not retried in a loop');
        shared.mode = 'native';
        await event(c, 'ready');
        assert.strictEqual(c.ready, true, 'an upgraded service is discovered on retry'); checks++; c.close();

        // A successful fallback stays selected if the peer later disconnects.
        const rejected = await service('legacy'), stable = await service('native');
        c = client([rejected.path, stable.path]); await start(c);
        const closed = event(c, 'close');
        stable.sockets.forEach((s) => s.destroy()); await closed;
        await event(c, 'ready');
        assert.strictEqual(c.path, stable.path); assert.strictEqual(rejected.accepted, 1); checks++;
        // Node 8 can report a reset before close when a running renderer restarts.
        // Exercise that error explicitly on runtimes which normally report EOF.
        const resetClosed = event(c, 'close');
        c.sock.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
        await resetClosed; await event(c, 'ready');
        assert.strictEqual(c.path, stable.path); assert.strictEqual(rejected.accepted, 1); checks++; c.close();

        // An explicit endpoint and deliberate legacy mode retain their meanings.
        c = client([preferred.path], { socket: old.path });
        const pinnedUnavailable = event(c, 'unavailable'); c.connect(); await pinnedUnavailable;
        assert.strictEqual(c.ready, false); assert.strictEqual(c.path, old.path); checks++; c.close();
        c = client([old.path], { native: false, interactive: false });
        await start(c); assert.strictEqual(c.native, false); c.close();

        const silent = await service('silent');
        c = client([silent.path]);
        c.connect(); c.close();
        await pause(30);
        assert.strictEqual(c.sock, null); assert.strictEqual(c.closed, true); checks++;
        console.log('Ambient renderer compatibility: ' + checks + ' scenarios passed (real Unix sockets)');
    } finally {
        clients.forEach((c) => c.close());
        await Promise.all(servers.map((f) => new Promise((resolve) => {
            f.sockets.forEach((s) => s.destroy()); f.server.close(resolve);
        })));
        for (const f of fs.readdirSync(root)) fs.unlinkSync(path.join(root, f));
        fs.rmdirSync(root);
    }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
