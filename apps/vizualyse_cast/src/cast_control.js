// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The app's side of the vizualyse-cast tool's control socket:
 * /dev/shm/vizualyse-cast/ctl.sock, a Unix stream socket (the app's own
 * group), newline-delimited JSON. The tool sends {"ev":"status", ...} on
 * connect, after every command and once a second, {"ev":"error","error":...}
 * for a command that can't run, and {"ev":"list"} when the touch screen's
 * List corner is tapped (back to the list); the app sends {"cmd":"stop"},
 * {"cmd":"replay","output":"map"|"hud"|"console"|"none"},
 * {"cmd":"carplay","output":"map"|"hud"} (the CarPlay second screen),
 * {"cmd":"hook111","mode":"off"|"alt"} (the second screen's switch),
 * {"cmd":"carplayCards","directions":...,"eta":...} (the cluster cards), {"cmd":"carplayZoom","dir":"in"|"out"},
 * {"cmd":"carplayCentre","on":...} (the phone centres its cluster view), {"cmd":"carplayHudAlt","on":...},
 * {"cmd":"enable"}, {"cmd":"disable"}, {"cmd":"qr","show":true|false},
 * {"cmd":"touch","on":true|false} (the tool's touch screen) and
 * {"cmd":"speed","kmh":...} (the car's speed: the touch screen only while
 * parked). Connected while the app runs, retried once a second; the tool
 * keeps running without it.
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.CAST_CTL_SOCKET || '/dev/shm/vizualyse-cast/ctl.sock';
const RETRY_MS = 1000;
/* a refused command shows in the status row this long */
const ERROR_MS = 8000;

const TITLES = { map: 'the cluster map', hud: 'the HUD', console: 'this screen', none: 'the speakers only' };

/* the iDrive list's rows are plain ASCII */
function ascii(s) {
    return String(s === undefined || s === null ? '' : s).replace(/…/g, '...').replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/·/g, '-').replace(/[^\x20-\x7e]/g, '');
}

class CastControl extends EventEmitter {
    constructor(opts) {
        super();
        this.log = (opts && opts.log) || console;
        this.path = (opts && opts.socket) || SOCKET;
        this.sock = null;
        this.wanted = false;
        this.timer = null;
        this.buf = '';
        this.status = null;
        this.lastError = null;
        this.kmh = null;
    }

    open() {
        this.wanted = true;
        if (!this.sock && !this.timer) this._connect();
    }

    close() {
        this.wanted = false;
        clearTimeout(this.timer);
        this.timer = null;
        if (this.sock) { this.sock.destroy(); this.sock = null; }
    }

    _connect() {
        this.timer = null;
        if (!this.wanted) return;
        const s = net.createConnection(this.path);
        this.sock = s;
        s.setEncoding('utf8');
        s.on('data', (d) => {
            this.buf += d;
            if (this.buf.length > 65536) { s.destroy(); return; }
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i);
                this.buf = this.buf.slice(i + 1);
                let ev = null;
                try { ev = JSON.parse(line); } catch (e) { continue; }
                if (!ev) continue;
                if (ev.ev === 'status') {
                    const first = !this.status;
                    this.status = ev;
                    /* the tool knows the speed at once (the touch screen's parked gate) */
                    if (first && this.kmh !== null) this.speed(this.kmh);
                    this.emit('change');
                } else if (ev.ev === 'list') this.emit('list');
                else if (ev.ev === 'error') {
                    this.lastError = { text: String(ev.error || 'the command failed'), at: Date.now() };
                    this.emit('change');
                }
            }
        });
        s.on('error', () => { /* close follows */ });
        s.on('close', () => {
            if (this.sock === s) this.sock = null;
            this.buf = '';
            if (this.status !== null) { this.status = null; this.emit('change'); }
            if (this.wanted && !this.timer) this.timer = setTimeout(() => this._connect(), RETRY_MS);
        });
    }

    _send(obj) {
        if (!this.sock || !this.status) return false;
        this.lastError = null;
        this.sock.write(JSON.stringify(obj) + '\n');
        return true;
    }

    stop() { return this._send({ cmd: 'stop' }); }
    enable() { return this._send({ cmd: 'enable' }); }
    disable() { return this._send({ cmd: 'disable' }); }
    carplay(output) { return this._send({ cmd: 'carplay', output: output }); }
    setCarplayOn(on) { return this._send({ cmd: 'hook111', mode: on ? 'alt' : 'off' }); }
    /* the cluster cards (each on or off) and zoom */
    setCarplayCards(cards) { return this._send(Object.assign({ cmd: 'carplayCards' }, cards)); }
    zoom(dir) { return this._send({ cmd: 'carplayZoom', dir: dir }); }
    replay(output) { return this._send({ cmd: 'replay', output: output }); }
    setQr(show) { return this._send({ cmd: 'qr', show: !!show }); }

    /* the touch screen (app/touch_mode's tool side) */
    showTouch() { return this._send({ cmd: 'touch', on: true }); }
    /* not a button: leaves a button's error on the status row alone */
    hideTouch() {
        if (!this.sock || !this.status || !(this.status.touch || this.status.touchWanted)) return false;
        this.sock.write(JSON.stringify({ cmd: 'touch', on: false }) + '\n');
        return true;
    }
    /* the car's speed in km/h, about once a second (kept for a reconnect) */
    speed(kmh) {
        this.kmh = kmh;
        if (!this.sock || !this.status) return false;
        this.sock.write(JSON.stringify({ cmd: 'speed', kmh: Math.round(kmh * 10) / 10 }) + '\n');
        return true;
    }
    touchShown() { return !!(this.status && this.status.touch); }
    /* the tool can draw a touch screen here (mgu-render is installed) */
    touchAvailable() { return !!(this.status && this.status.touchAvailable); }
    moving() { return !!(this.status && this.status.moving); }

    connected() { return !!this.status; }
    enabled() { return !(this.status && this.status.enabled === false); }
    /* the tool sees hook111 armed and streaming-ready this start */
    canCarplay() { return !!(this.status && this.status.carplay && this.status.carplay.ready && this.enabled()); }
    /* the second screen's switch: { installed, on, pending } (hook111's mode) */
    carplaySwitch() { return (this.status && this.status.carplay && this.status.carplay.switch) || { installed: false, on: false, pending: null }; }
    switchText() {
        if (!this.status) return 'CarPlay second screen: -';
        const w = this.carplaySwitch();
        if (!w.installed) return 'CarPlay second screen: hook111 not installed';
        return 'CarPlay second screen: ' + (w.on ? 'on' : 'off') + (w.pending ? ' (' + w.pending + ')' : '');
    }
    /* centring: the phone centres the car, the directions card above it */
    setCarplayCentre(on) { return this._send({ cmd: 'carplayCentre', on: !!on }); }
    /* the HUD's alternate mode: the wide picture, not centred */
    setCarplayHudAlt(on) { return this._send({ cmd: 'carplayHudAlt', on: !!on }); }
    carplayHudAlt() { return !!(this.status && this.status.carplay && this.status.carplay.hudAlt); }
    hudAltText() { return 'CarPlay HUD alternate mode: ' + (this.status && this.status.carplay ? (this.carplayHudAlt() ? 'on' : 'off') : '-'); }
    carplayCentre() { return (this.status && this.status.carplay && this.status.carplay.centre) || { on: true, pending: null }; }
    centreText() {
        if (!this.status || !this.status.carplay || !this.status.carplay.centre) return 'CarPlay: centre the map: -';
        const c = this.carplayCentre();
        return 'CarPlay: centre the map: ' + (c.on ? 'on' : 'off') + (c.pending ? ' (' + c.pending + ')' : '');
    }
    /* the cluster cards: { directions, eta, url, pending } */
    carplayCards() { return (this.status && this.status.carplay && this.status.carplay.cards) || null; }
    cardText(which) {
        const c = this.carplayCards(), name = which === 'eta' ? 'time / distance' : 'directions';
        if (!c) return 'CarPlay ' + name + ' card: -';
        return 'CarPlay ' + name + ' card: ' + (c[which] ? 'on' : 'off');
    }
    link() { return (this.status && this.status.link) || ''; }
    canReplay() { return !!(this.status && this.status.canReplay); }
    playing() { return !!(this.status && this.status.state === 'playing'); }
    hasOutput(id) { return !!(this.status && (this.status.outputs || []).some((o) => o.id === id)); }
    qrOnCluster() { return !(this.status && this.status.qr === false); }

    statusText() {
        const s = this.status;
        if (!s) return 'Cast service not running - install Cast to cluster in the Store';
        if (this.lastError && Date.now() - this.lastError.at < ERROR_MS) return ascii('Error: ' + this.lastError.text);
        if (s.touch) return 'The touch screen is up - List (top right) or the back arrow returns here';
        if (s.enabled === false) return 'Off - turn Cast to cluster on to use it';
        const where = TITLES[s.output] || s.output || '';
        if (s.state === 'playing') return ascii('Playing on ' + where + (s.audio ? ', with sound' : '') + ' - ' + (s.seconds || 0) + ' s');
        if (s.state === 'paused') return ascii('Paused on ' + where + (s.note ? ': ' + s.note : ''));
        if (s.state === 'error') return ascii('Error: ' + (s.error || 'the stream failed'));
        if (s.state === 'ended') return ascii('Ended' + (where ? ' on ' + where : ''));
        if (!s.link) return ascii("Waiting for the phone's hotspot (uplink " + (s.uplink || 'unknown') + ')');
        return 'Ready - scan the QR code with your phone';
    }

    infoText() {
        const s = this.status;
        if (!s) return '';
        return ascii('Uplink ' + (s.uplink || 'unknown') + ' - cluster renderer ' + (s.render || 'unknown') +
            (s.url ? ' - last: ' + s.url : ''));
    }
}

module.exports = { CastControl, SOCKET, TITLES, ascii };
