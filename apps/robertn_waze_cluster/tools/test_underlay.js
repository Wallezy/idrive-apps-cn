// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
const assert = require('assert');
const net = require('net');
const fs = require('fs');
const { spawn } = require('child_process');
const { UnderlayControl } = require('../src/underlay_control.js');
const { ClusterRender } = require('../../../native/cluster-render/js/cluster_render_client.js');
const sock = `/tmp/woc-cal-${process.pid}.sock`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, message, timeout) {
    const end = Date.now() + (timeout || 2500);
    while (Date.now() < end) { if (check()) return; await sleep(20); }
    assert(check(), message);
}
function frame(j) {
    const b = Buffer.from(JSON.stringify(j)); const f = Buffer.alloc(b.length + 5);
    f.writeUInt32LE(b.length + 1); f[4] = 0x4a; b.copy(f, 5); return f;
}

async function fakeProtocol() {
    let feature = 0, active = false, owned = false, client;
    const requests = [];
    const server = net.createServer((s) => {
        client = s; let buf = Buffer.alloc(0);
        s.on('error', () => {});
        s.on('data', (b) => {
            buf = Buffer.concat([buf, b]);
            while (buf.length >= 4 && buf.length >= buf.readUInt32LE(0) + 4) {
                const n = buf.readUInt32LE(0); const j = JSON.parse(buf.slice(5, n + 4)); buf = buf.slice(n + 4);
                requests.push(j);
                if (j.op === 'hello') {
                    const f = frame({ ev: 'hello', proto: 1, backend: 'id7', underlay: feature });
                    s.write(f.slice(0, 2)); setTimeout(() => { if (!s.destroyed) s.write(f.slice(2)); }, 10);
                } else {
                    if (j.action === 'expanded' || j.action === 'standard') { active = owned = true; }
                    if (j.action === 'stop') active = owned = false;
                    s.write(frame({ ev: 'underlay', active: active ? 1 : 0, owned: owned ? 1 : 0,
                        w: 1632, h: 720, remaining_ms: 12000, reason: '' }));
                }
            }
        });
    });
    await new Promise((r) => server.listen(sock, r));
    const u = new UnderlayControl(sock);
    try {
        u.open(); await until(() => requests.length, 'hello received'); await sleep(40);
        u.confirm(); u.start('expanded');
        assert(!u.supported && !u.parked && !u.pending);
        assert(!requests.some((r) => r.op === 'underlay'), 'older renderer receives no calibration commands');
        u.close(); feature = 1; u.open(); await until(() => u.supported, 'new renderer available');
        u.start('expanded'); assert(!u.pending, 'parking confirmation required');
        u.confirm(); u.start('expanded'); await until(() => u.active, 'preview acknowledged');
        assert(!u.parked && u.owned && u.width === 1632);
        const starts = requests.filter((r) => r.action === 'expanded').length;
        u.start('expanded'); await sleep(550);
        assert.strictEqual(requests.filter((r) => r.action === 'expanded').length, starts, 'no repeat start');
        assert(requests.some((r) => r.action === 'keep'), 'only the owning UI renews');
        u.stop(); await until(() => !u.active, 'explicit stop');
        assert(!u.canStart(), 'confirmation consumed');
        u.confirm(); u.start('standard'); await until(() => u.active, 'second preview');
        u.close(); await sleep(100); assert(!u.active && !u.parked);
        active = owned = false; u.open(); await until(() => u.supported, 'reopened');
        await sleep(550); assert(!u.active && !u.parked, 'reopening never resumes a preview');
        active = true; owned = false;
        await until(() => u.active && !u.owned, 'other session');
        const count = requests.length; await sleep(550);
        assert(!requests.slice(count).some((r) => r.action === 'keep'), 'cannot extend another session');
        client.write(Buffer.from([0, 0, 2, 0]));
        await until(() => !u.socket, 'oversized frame closes the UI connection');
        console.log('ok calibration client: legacy, fragmented frames, confirmation, ownership, stop and no replay');
    } finally {
        u.close(); if (client) client.destroy(); await new Promise((r) => server.close(r));
    }
}

async function serviceProtocol(bin) {
    const proc = spawn(bin, [sock], { stdio: ['pipe', 'pipe', 'pipe'] });
    let logs = ''; proc.stderr.on('data', (s) => { logs = (logs + s).slice(-16000); });
    const u = new UnderlayControl(sock);
    const waze = new ClusterRender('underlay-test-map', sock);
    let map, state = '', feed;
    waze.on('layer', (ref, s) => { if (ref === map) state = s; });
    try {
        await new Promise((resolve, reject) => { proc.stdout.once('data', resolve); proc.once('error', reject); });
        waze.connect(); map = waze.video({ target: 'map', iw: 64, ih: 32, contend: true, stall_ms: 1000 });
        const atlas = Buffer.alloc(waze.frameBytes(map), 128);
        feed = setInterval(() => waze.frame(map, atlas, Date.now()), 50);
        await until(() => state === 'shown', 'baseline video shown');
        u.open(); await until(() => u.supported, 'real service advertises calibration');
        u.confirm(); u.start('expanded');
        await until(() => u.active && state === 'suspended', 'grid replaces the map video', 5000);
        assert(!u.reason, u.reason); assert.strictEqual(u.width, 1632);
        u.close(); await until(() => state === 'shown', 'closing UI resumes map', 5000);
        u.open(); await until(() => u.supported, 'connection opened again');
        assert(!u.parked && !u.pending, 'no automatic replay');
        u.confirm(); u.start('standard'); await until(() => u.active, 'standard grid');
        clearInterval(feed); feed = null;
        await until(() => !u.active, 'stalled video ends preview', 4000);
        assert(logs.includes('map stream stopped'), logs);
        console.log('ok actual native socket: expanded grid, UI disconnect recovery, standard grid and stream loss');
    } finally {
        clearInterval(feed); u.close(); waze.close(); proc.stdin.end();
        await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
    }
}

(async () => {
    await fakeProtocol();
    if (process.argv[2]) await serviceProtocol(process.argv[2]);
})().then(() => { try { fs.unlinkSync(sock); } catch (e) { /* removed by server */ } })
    .catch((e) => { console.error(e.stack); process.exit(1); });
