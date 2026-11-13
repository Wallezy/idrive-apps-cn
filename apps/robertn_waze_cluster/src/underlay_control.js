// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/* An explicit parking preview, never replayed on reconnect. The renderer
 * owns its 20 s deadline and 2 s lease, so losing this UI ends the preview. */
const net = require('net');
const EventEmitter = require('events');
const { t } = require('./i18n.js');
const UNDERLAY_PATH = '/dev/shm/cluster-render/render.sock';

class UnderlayControl extends EventEmitter {
    constructor(socketPath) {
        super();
        this.path = socketPath || UNDERLAY_PATH;
        this.socket = null;
        this.timer = null;
        this.supported = false;
        this.parked = false;
        this.active = false;
        this.owned = false;
        this.pending = false;
        this.remaining = 0;
        this.width = 0;
        this.reason = '';
    }

    open() {
        if (this.socket) return;
        const s = net.connect(this.path);
        this.socket = s;
        let input = Buffer.alloc(0);
        let lastReply = Date.now();
        s.on('connect', () => this._send({ op: 'hello', app: 'robertn_waze_cluster-calibration' }));
        s.on('data', (chunk) => {
            if (this.socket !== s) return;
            input = Buffer.concat([input, chunk]);
            while (input.length >= 4) {
                const n = input.readUInt32LE(0);
                if (n < 1 || n > 65536) return this.close();
                if (input.length < n + 4) break;
                const frame = input.slice(4, n + 4);
                input = input.slice(n + 4);
                if (frame[0] !== 0x4a) return this.close();
                let msg;
                try { msg = JSON.parse(frame.slice(1).toString('utf8')); } catch (e) { return this.close(); }
                if (msg.ev === 'hello') {
                    this.supported = msg.proto === 1 && msg.underlay === 1 && ['id7', 'host'].includes(msg.backend);
                    lastReply = Date.now();
                    if (this.supported) this._send({ op: 'underlay', action: 'status' });
                } else if (msg.ev === 'underlay') {
                    lastReply = Date.now();
                    this.active = msg.active === 1;
                    this.owned = msg.owned === 1;
                    this.pending = false;
                    this.remaining = Math.ceil(Math.max(0, Number(msg.remaining_ms) || 0) / 1000);
                    this.width = Number(msg.w) || 0;
                } else if (msg.ev === 'error' && msg.op === 'underlay') {
                    if (this.pending) this.reason = String(msg.reason || 'error');
                    this.pending = false;
                }
                this.emit('change');
            }
        });
        const disconnected = () => { if (this.socket === s) this.close(); };
        s.on('error', disconnected);
        s.on('close', disconnected);
        this.timer = setInterval(() => {
            if (Date.now() - lastReply > 3000) return this.close();
            if (this.supported) this._send({ op: 'underlay', action: this.active && this.owned ? 'keep' : 'status' });
        }, 500);
    }

    close() {
        const s = this.socket;
        this.socket = null;
        clearInterval(this.timer);
        this.timer = null;
        this.supported = this.parked = this.active = this.owned = this.pending = false;
        this.reason = '';
        if (s) s.destroy();
        this.emit('change');
    }

    _send(obj) {
        if (!this.socket || this.socket.destroyed) return false;
        if (this.socket.bufferSize > 4096) { this.close(); return false; }
        const body = Buffer.from(JSON.stringify(obj), 'utf8');
        const frame = Buffer.alloc(body.length + 5);
        frame.writeUInt32LE(body.length + 1, 0);
        frame[4] = 0x4a;
        body.copy(frame, 5);
        this.socket.write(frame);
        return true;
    }

    confirm() {
        if (!this.supported || this.active || this.pending) return;
        this.parked = !this.parked;
        this.emit('change');
    }

    canStart() { return this.supported && this.parked && !this.active && !this.pending; }

    start(mode) {
        if (!this.canStart() || !['standard', 'expanded'].includes(mode)) return;
        this.parked = false;
        this.pending = true;
        this.reason = '';
        this._send({ op: 'underlay', action: mode, parked: 1 });
        this.emit('change');
    }

    stop() {
        if (!this.supported || (!this.pending && !(this.active && this.owned))) return;
        this._send({ op: 'underlay', action: 'stop' });
        this.parked = false;
        this.emit('change');
    }

    statusText() {
        if (!this.supported) return t('Calibration: renderer unavailable or update needed');
        if (this.reason) return t('Calibration refused: {0}', this.reason);
        if (this.pending) return t('Calibration: Starting…');
        if (this.active && !this.owned) return t('Calibration: another session is active');
        if (this.active) return t('Calibration: {0} px, {1} s remaining', this.width, this.remaining);
        return t('Calibration: Off');
    }
}

module.exports = { UnderlayControl, UNDERLAY_PATH };
