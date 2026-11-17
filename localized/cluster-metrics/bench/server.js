'use strict';
/**
 * bench/server.js - local Mac/Linux simulator for idrive7-cluster-metrics.
 * Implements a cluster-render protocol v1 Unix socket server + HTTP/SSE browser UI + JSON /state endpoint.
 *
 *   node bench/server.js
 *   PORT=18078 node bench/server.js
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, fork } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const visible = require(path.join(ROOT, 'shared', 'visible'));

const APP_ID = 'cluster_metrics';
const PORT = Number(process.env.PORT || 8078);
const SOCK = process.env.BENCH_SOCK || path.join(os.tmpdir(), 'cluster-metrics-bench-' + process.pid + '.sock');
const LAYER_CAP = Number(process.env.BENCH_LAYER_CAP || 8);
const PIXEL_BYTES = 16 * 1024 * 1024;
const TARGETS = { hud: { w: 800, h: 480 }, panel: { w: 1920, h: 720 }, map: { w: 1088, h: 480 } };

const layers = new Map(); // key = conn + ':' + ref
const sseClients = new Set();
const logs = [];
let nextConn = 1;
let child = null;
let lastStatus = '';
let lastSettings = null;
let protocolErrors = 0;

function log(level, text) {
    const entry = { t: 'log', level, ts: Date.now(), text };
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    console.log('[bench] ' + (level !== 'info' ? level.toUpperCase() + ' ' : '') + text);
    sseBroadcast(entry);
}

function sseBroadcast(obj, onlyRes) {
    const payload = 'data: ' + JSON.stringify(obj) + '\n\n';
    if (onlyRes) { try { onlyRes.write(payload); } catch (e) { /* ignore */ } return; }
    sseClients.forEach((res) => { try { res.write(payload); } catch (e) { /* ignore */ } });
}

function totalPixelBytes() {
    let sum = 0;
    layers.forEach((l) => { if (l.image) sum += l.image.length * 2; });
    return sum;
}

function sceneMeta() {
    const out = [];
    layers.forEach((l, key) => {
        out.push({
            key, conn: l.conn, ref: l.ref, target: l.target, klass: l.klass, z: l.z,
            x: l.x, y: l.y, w: l.w, h: l.h, iw: l.iw, ih: l.ih,
            visible: l.visible, contend: l.contend,
        });
    });
    return out;
}

function writeEv(sock, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = 0x4a;
    body.copy(m, 5);
    try { sock.write(m); } catch (e) { /* closed */ }
}

const renderServer = net.createServer((sock) => {
    const conn = nextConn++;
    const st = { conn, app: '?', buf: Buffer.alloc(0) };

    const refuse = (op, ref, reason) => {
        protocolErrors++;
        log('error', 'refused ' + op + ' ref=' + ref + ': ' + reason);
        writeEv(sock, { ev: 'error', op, ref, reason });
    };

    sock.on('data', (chunk) => {
        st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
        while (st.buf.length >= 5) {
            const len = st.buf.readUInt32LE(0);
            if (len < 1 || len > 16 * 1024 * 1024) { sock.destroy(); return; }
            if (st.buf.length < 4 + len) break;
            const type = st.buf[4];
            const body = st.buf.slice(5, 4 + len);
            st.buf = st.buf.slice(4 + len);
            if (type === 0x4a) onJson(body);
            else if (type === 0x46) onFrame(body);
        }
    });

    sock.on('close', () => {
        let removed = false;
        Array.from(layers.keys()).forEach((k) => {
            if (layers.get(k).conn === conn) { layers.delete(k); removed = true; }
        });
        if (removed) sseBroadcast({ t: 'scene', layers: sceneMeta(), pixels: totalPixelBytes() });
    });

    function onJson(body) {
        let m;
        try { m = JSON.parse(body.toString('utf8')); } catch (e) { protocolErrors++; return; }
        if (m.op === 'hello') {
            st.app = m.app || '?';
            writeEv(sock, { ev: 'hello', backend: 'bench', targets: 'hud panel map', proto: 1 });
            return;
        }
        if (m.op === 'layer') {
            const perConn = Array.from(layers.values()).filter((l) => l.conn === conn).length;
            if (perConn >= LAYER_CAP) return refuse('layer', m.ref, 'too many layers (cap ' + LAYER_CAP + ')');
            const iw = m.iw || m.w || 1;
            const ih = m.ih || m.h || 1;
            if (totalPixelBytes() + iw * ih * 8 > PIXEL_BYTES) {
                return refuse('layer', m.ref, 'the service\'s pixel memory is full');
            }
            const key = conn + ':' + m.ref;
            const l = {
                key, conn, ref: m.ref, target: m.target || 'hud', klass: m.class || 'overlay',
                z: m.z || 0, x: m.x || 0, y: m.y || 0, w: m.w || iw, h: m.h || ih, iw, ih,
                visible: m.visible !== 0, contend: m.contend !== 0,
                image: Buffer.alloc(iw * ih * 4), sentWhole: false,
            };
            layers.set(key, l);
            writeEv(sock, { ev: 'layer', ref: m.ref, state: l.visible ? 'shown' : 'hidden' });
            sseBroadcast({ t: 'scene', layers: sceneMeta(), pixels: totalPixelBytes() });
            return;
        }
        if (m.op === 'set') {
            const l = layers.get(conn + ':' + m.ref);
            if (!l) return refuse('set', m.ref, 'unknown layer');
            ['x', 'y', 'w', 'h', 'z'].forEach((k) => { if (m[k] !== undefined) l[k] = m[k]; });
            if (m.visible !== undefined) l.visible = Boolean(m.visible);
            if (m.contend !== undefined) l.contend = Boolean(m.contend);
            sseBroadcast({ t: 'scene', layers: sceneMeta(), pixels: totalPixelBytes() });
            return;
        }
        if (m.op === 'drop') {
            layers.delete(conn + ':' + m.ref);
            sseBroadcast({ t: 'scene', layers: sceneMeta(), pixels: totalPixelBytes() });
            return;
        }
        if (m.op === 'status') {
            writeEv(sock, { ev: 'status', text: 'bench: ' + layers.size + ' layers, ' + totalPixelBytes() + ' bytes' });
        }
    }

    function onFrame(body) {
        if (body.length < 14) return;
        const ref = body.readUInt32LE(0);
        const n = body.readUInt16LE(12);
        const l = layers.get(conn + ':' + ref);
        if (!l) return refuse('frame', ref, 'unknown ref');
        const head = 14 + n * 8;
        const px = body.slice(head);
        if (n === 0) {
            if (px.length !== l.image.length) return refuse('frame', ref, 'wrong whole size');
            px.copy(l.image);
            l.sentWhole = true;
            sseBroadcast({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, x: 0, y: 0, w: l.iw, h: l.ih });
        } else {
            let off = 0;
            const rects = [];
            for (let i = 0; i < n; i++) {
                const x = body.readUInt16LE(14 + i * 8);
                const y = body.readUInt16LE(16 + i * 8);
                const w = body.readUInt16LE(18 + i * 8);
                const h = body.readUInt16LE(20 + i * 8);
                if (x + w > l.iw || y + h > l.ih) return refuse('frame', ref, 'rect out of bounds');
                for (let r = 0; r < h; r++) {
                    px.copy(l.image, ((y + r) * l.iw + x) * 4, off, off + w * 4);
                    off += w * 4;
                }
                rects.push([x, y, w, h]);
            }
            if (l.sentWhole) {
                rects.forEach((r) => sseBroadcast({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, x: r[0], y: r[1], w: r[2], h: r[3] }));
            } else {
                l.sentWhole = true;
                sseBroadcast({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, x: 0, y: 0, w: l.iw, h: l.ih });
            }
        }
    }
});

function buildApp() {
    const out = execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), '--stub-sdk', APP_ID], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { OAP_STUB_SDK: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    String(out).split('\n').filter(Boolean).forEach((ln) => log('info', 'build: ' + ln.trim()));
}

let lastTelemetry = null;

function startApp() {
    buildApp();
    const stage = path.join(ROOT, 'dist', APP_ID);
    const dataDir = path.join(ROOT, 'bench', '.data', APP_ID);
    child = fork(path.join(__dirname, 'run-app.js'), [stage, dataDir], {
        env: Object.assign({}, process.env, {
            CLUSTER_METRICS_SOCKET: SOCK,
            HUD_CLUSTER_SOCKET: SOCK,
            CLUSTER_METRICS_BENCH: '1',
        }),
    });
    child.on('message', (m) => {
        if (!m) return;
        if (m.t === 'status') { lastStatus = m.s; sseBroadcast({ t: 'status', s: lastStatus }); }
        else if (m.t === 'settings') { lastSettings = m; sseBroadcast(m); }
        else if (m.t === 'telemetry') { lastTelemetry = m.v; sseBroadcast(m); }
        else if (m.t === 'log') { log(m.level || 'info', m.s); }
    });
    child.on('exit', (code) => {
        log(code ? 'error' : 'info', 'app exited code=' + code);
        child = null;
    });
}

function readReqBody(req) {
    return new Promise((resolve) => {
        let s = '';
        req.on('data', (d) => { s += d; });
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    });
}

const web = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(__dirname, 'ui.html')).pipe(res);
    }
    if (req.method === 'GET' && url.indexOf('/assets/') === 0) {
        const assetName = path.basename(url.slice('/assets/'.length));
        const assetPath = path.join(__dirname, 'assets', assetName);
        if (/^[a-zA-Z0-9_.-]+\.(jpg|jpeg|png)$/.test(assetName) && fs.existsSync(assetPath)) {
            const ctype = /\.png$/i.test(assetName) ? 'image/png' : 'image/jpeg';
            res.writeHead(200, { 'content-type': ctype, 'cache-control': 'public, max-age=300' });
            return fs.createReadStream(assetPath).pipe(res);
        }
        res.writeHead(404);
        return res.end();
    }
    if (req.method === 'GET' && url === '/state') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({
            running: Boolean(child),
            status: lastStatus,
            telemetry: lastTelemetry,
            protocolErrors,
            layerCount: layers.size,
            pixelBytes: totalPixelBytes(),
            layers: sceneMeta(),
            geometry: visible,
        }));
    }
    if (req.method === 'GET' && url === '/px') {
        const q = {};
        (req.url.split('?')[1] || '').split('&').forEach((kv) => {
            const i = kv.indexOf('=');
            if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        });
        const l = layers.get(q.key);
        const x = Number(q.x), y = Number(q.y), w = Number(q.w), h = Number(q.h);
        if (!l || !l.image || !(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= l.iw && y + h <= l.ih)) {
            res.writeHead(404);
            return res.end();
        }
        const out = Buffer.alloc(w * h * 4);
        for (let r = 0; r < h; r++) l.image.copy(out, r * w * 4, ((y + r) * l.iw + x) * 4, ((y + r) * l.iw + x + w) * 4);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(out);
    }
    if (req.method === 'GET' && url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        sseBroadcast({ t: 'hello', targets: TARGETS, geometry: visible }, res);
        sseBroadcast({ t: 'scene', layers: sceneMeta(), pixels: totalPixelBytes() }, res);
        layers.forEach((l) => sseBroadcast({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, x: 0, y: 0, w: l.iw, h: l.ih }, res));
        if (lastSettings) sseBroadcast(lastSettings, res);
        if (lastStatus) sseBroadcast({ t: 'status', s: lastStatus }, res);
        if (lastTelemetry) sseBroadcast({ t: 'telemetry', v: lastTelemetry }, res);
        return;
    }
    if (req.method === 'POST' && url === '/signals') {
        const b = await readReqBody(req);
        if (child) child.send({ t: 'signals', mode: b.mode, values: b.values || {} });
        res.writeHead(204);
        return res.end();
    }
    if (req.method === 'POST' && url === '/setting') {
        const b = await readReqBody(req);
        if (child) child.send({ t: 'set', key: b.key, value: b.value });
        res.writeHead(204);
        return res.end();
    }
    res.writeHead(404);
    res.end();
});

try { fs.unlinkSync(SOCK); } catch (e) { /* ignore */ }
renderServer.listen(SOCK, () => {
    web.listen(PORT, '127.0.0.1', () => {
        log('info', 'bench listening at http://127.0.0.1:' + PORT + ' (sock ' + SOCK + ')');
        startApp();
    });
});

function shutdown() {
    if (child) child.kill('SIGTERM');
    try { fs.unlinkSync(SOCK); } catch (e) { /* ignore */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
