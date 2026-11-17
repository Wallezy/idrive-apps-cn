// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse_chromium - the iDrive page of the vizualyse-chromium tool, a web
 * browser on the car's own GPU (WebGL 2, WebGPU, WebAssembly JSPI) shown on
 * this screen while parked. Addresses are typed on the phone page the tool
 * serves.
 *
 * The touch screen first: entered, the app opens its empty screen state and
 * the tool's touch screen goes over it; its List corner, BACK or the car
 * moving bring this page back (platform app/touch_mode).
 *
 * One LT_State_Wide page, all of it usable with the iDrive controller: the
 * status; Touch screen (it again); the phone page's link as a QR code
 * (LT_Label_1Graphic_Scalable, a PNG in /dev/shm the HMI can read) and as
 * text; Show on the screen; the browser on or off; Home page, Reload, Back;
 * the page shown (title, address); what the GPU offers (the tool's probe:
 * WebGPU's adapter, WebGL 2's renderer, JSPI).
 *
 * The tool's two pictures, the touch screen and the browser, cover the app
 * area (not the HMI's top bar or left strip), one at a time, over the same
 * screen state (ST_..._VizualyseChromiumScreen: a title and a label, nothing
 * to press: the HMI still gets every touch, the tool reads them passively).
 * The touch screen's Show on the screen swaps it for the browser, and the
 * touch screen comes back when the browser goes while that state is open;
 * the page's Show opens the state with the browser at once. Should the
 * screen state not open, the picture goes over the page, every button
 * disabled. Either shows only while the state under it is visible and
 * focused: BACK, HOME, another app, or an HMI pop-up taking the focus (a
 * call, a warning) hide it, so nothing of the HMI is ever covered.
 *
 * Only while parked: the app reads the car's speed once a second
 * (vehicle_speed.js) and hands it to the tool, which hides the browser above
 * 3 km/h and won't show it. So the app holds the tool's control socket while
 * it runs, not only while its page shows. The structure follows
 * vizualyse_moonlight.
 */
'use strict';
const { translate } = require('./i18n.js');

const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { BrowserControl } = require('./chromium_control.js');
const { watchSpeed } = require('./vehicle_speed.js');
const { qrPng } = require('./qr_png.js');
const { TouchMode } = require('./touch_mode.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_VizualyseChromium';
const SCREEN_NAME = 'ST_OnlineApps_VizualyseChromiumScreen';
const N = {
    status: 'browserStatus', touch: 'browserTouch', qr: 'browserQr', link: 'browserLink', hint: 'browserHint', page: 'browserPage', gpu: 'browserGpu',
    show: 'browserShow', enable: 'browserEnable', home: 'browserHome', reload: 'browserReload', back: 'browserBack',
    gpuMode: 'browserGpuMode', resolution: 'browserResolution', game: 'browserGame',
};
const PRESS_DEDUPE_MS = 400;
const ROW_CHARS = 90;
const QR_PX = 360;
const QR_PREFIX = 'qr_';

/* The QR folder: world-readable, so the HMI (another uid) can load the PNG. */
function qrDir() {
    if (process.env.CHROMIUM_QR_DIR) return process.env.CHROMIUM_QR_DIR;
    const uid = process.getuid ? process.getuid() : 0;
    return '/dev/shm/vizualyse_chromium_qr_' + uid;
}

function oneRow(line) {
    const flat = String(line || '').replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? flat.slice(0, ROW_CHARS - 3) + '...' : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class BrowserApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._screen = null;
        this._touch = null;
        /* the page's Show: the next opening of the screen state is for the browser */
        this._browserNext = false;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._qr = { key: null, file: null, chain: Promise.resolve() };
        this._control = new BrowserControl({ log: logger });
        this._control.on('change', () => { if (this._touch) this._touch.sync(); this._render(); });
        this._control.on('list', () => { this._browserNext = false; if (this._touch) this._touch.list(); });
        this._stopSpeed = null;

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error('vizualyse_chromium init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
    }

    _appInitialized() {
        logger.info('vizualyse_chromium ' + this.getAppId() + ' v' + this._packageJson.version + ' starting');
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        /* the tool hears from the app while it runs: the speed, whatever the page */
        this._control.open();
        this._startSpeed();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                if (foregroundStart) this.registerActive();
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                    this._touch.entered();
                }
                const lastUuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startSpeed() {
        let builders = null;
        try { builders = require('oap-sdk/src/someip/someipBuilders'); } catch (err) {
            logger.warn('speed: no SOME/IP in this SDK (' + (err && err.message) + '): the tool cannot tell parked from driving');
            return;
        }
        this._stopSpeed = watchSpeed(builders, logger, (kmh) => this._control.speed(kmh));
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.indexOf(reason) >= 0;
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        if (!this._state) return Promise.reject(new Error('uiDescription has no ' + STATE_NAME));
        const names = Object.keys(N).map((k) => N[k]);
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) return Promise.reject(new Error('uiDescription lacks ' + missing.join(', ')));

        this._screen = rhmi.getByName(SCREEN_NAME);
        if (!this._screen) logger.warn('uiDescription has no ' + SCREEN_NAME + ': the touch screen and the browser go over the main page');
        const c = this._control;
        this._touch = new TouchMode({ rhmi: rhmi, page: this._state, screen: this._screen, log: logger,
            tool: { connected: () => c.connected(), moving: () => c.moving(), shown: () => c.pictureUp(), hide: () => c.hideAll(),
                /* the touch screen, or after the page's Show the browser at once */
                show: () => { const b = this._browserNext; this._browserNext = false; return c.ui(b); } },
            visible: (v) => this._setVisible(v) });
        this._bind(N.touch, () => this._touch.open());
        this._bind(N.show, () => this._showBrowser());
        this._bind(N.enable, () => (this._control.enabled() ? this._control.disable() : this._control.enable()));
        this._bind(N.home, () => this._control.home());
        this._bind(N.reload, () => this._control.reload());
        this._bind(N.back, () => this._control.back());
        this._bind(N.gpuMode, () => this._control.gpu(!this._control.gpuMode()));
        this._bind(N.resolution, () => this._control.scale(this._control.nextScale()));
        this._bind(N.game, () => this._control.game(!this._control.gameMode()));
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) this._press(entry.name, entry.handler);
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) return;
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._qr.key = null;
            this._render();
        });
        this._state.on('visible', (event) => { if (isTrue(event && event.visible)) this._sawForeground = true; });
        return Promise.resolve(this._state.updateResources()).then(() => {
            logger.info('page ready: ' + names.length + ' components found');
            this._render();
        });
    }

    /* The page's Show: the screen state with the browser at once (the touch
     * screen comes back when the browser goes, while that state is open);
     * without it (no such state, or the HMI won't open it) the browser goes
     * over the main page, whose buttons are disabled meanwhile (_render). */
    _showBrowser() {
        if (!this._control.running()) return this._control.show();   /* the tool says why */
        this._browserNext = true;
        const r = this._touch.open();
        /* not sent: not for the next opening either */
        if (r === false) this._browserNext = false;
        return r;
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try { id = comp.getId(); } catch (e) { id = null; }
        if (id !== null) this._actionById[Number(id)] = { name: name, handler: handler };
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) return;
        this._lastPress[name] = now;
        logger.info('BUTTON ACTION ' + name);
        try {
            if (handler() === false) logger.warn(name + ': the Browser tool is not connected');
        } catch (err) {
            logger.warn(name + ' failed: ' + (err && err.message));
        }
    }

    /* The app manager inserts the tile from application.json and hands it to
     * the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point handed over by the manager'));
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn('entry point text/icon: ' + (err && err.message))))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info('entry point ' + description.name + ' ENABLED'));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._sawForeground = true;
        this._setVisible(true);
        if (this._touch) this._touch.entered();
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn('openEntryState failed: ' + (err && err.message)));
    }

    /* ---- visibility ---- */
    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) return;
        this._visible = visible;
        logger.info('app ' + (visible ? 'visible' : 'hidden'));
        /* off our pages neither picture may cover whatever the HMI shows */
        if (!visible && this._control.hideAll()) logger.info('app left: the touch screen or the browser hidden');
        this._reportVisibilityStatus(visible);
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) return;
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()]
            : [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn('app status report failed: ' + (err && err.message))));
    }

    /* ---- rendering ---- */
    _write(name, text) {
        const t = oneRow(translate(text));
        if (this._written[name] !== t) {
            this._written[name] = t;
            Promise.resolve(this._components[name].setValue(0, 'Text', t, 'Text'))
                .catch((err) => logger.warn(name + ' render failed: ' + (err && err.message)));
        }
    }

    _setEnabled(name, enabled) {
        const key = 'enabled:' + name;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            /* a drop-down has no setEnabled, only the property (upstream's Waze) */
            const comp = this._components[name];
            Promise.resolve(comp.setEnabled ? comp.setEnabled(enabled) : comp.setProperty('Enabled', enabled ? 1 : 0, 'UInt'))
                .catch((err) => logger.warn(name + ' enable failed: ' + (err && err.message)));
        }
    }

    _show(name, visible) {
        const key = 'visible:' + name;
        if (this._written[key] !== visible) {
            this._written[key] = visible;
            Promise.resolve(this._components[name].setVisible(visible))
                .catch((err) => logger.warn(name + ' visibility failed: ' + (err && err.message)));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) return;
        const c = this._control, up = c.connected(), on = up && c.enabled(), run = on && c.running(), link = on ? c.link() : '';
        this._write(N.status, c.statusText());
        this._write(N.touch, c.moving() ? 'Touch screen (only while parked)' : 'Touch screen');
        this._write(N.link, link ? link : '');
        this._write(N.hint, link ? 'Scan with the phone whose hotspot the car is on to type addresses and text' : '');
        this._write(N.page, c.pageText());
        this._write(N.gpu, c.gpuText());
        this._write(N.enable, 'Browser: ' + (up ? (c.enabled() ? 'on' : 'off') : 'not running'));
        this._write(N.resolution, up ? c.resolutionText() : 'Resolution');
        this._write(N.gpuMode, 'GPU mode: ' + (on && c.gpuMode() ? 'on (experimental)' : 'off (WebGL on the CPU)'));
        this._write(N.game, 'Game mode: ' + (on && c.gameMode() ? 'on (trusted games only)' : 'off'));
        /* while a picture covers the page itself (no screen state under it: the
         * fallback, or the phone's Show), nothing under it can be pressed */
        const covered = this._touch ? this._touch.covered() || (c.pictureUp() && !this._touch.screenOpen()) : c.pictureUp();
        this._setEnabled(N.touch, up && !covered && !c.moving());
        this._setEnabled(N.enable, up && !covered);
        this._setEnabled(N.show, run && !covered && !c.moving());
        this._setEnabled(N.home, run && !covered);
        this._setEnabled(N.reload, run && !covered);
        this._setEnabled(N.back, run && !covered);
        /* on once the browser runs; off at any time (also while it restarts) */
        this._setEnabled(N.gpuMode, on && !covered && (run || c.gpuMode()));
        this._setEnabled(N.resolution, on && !covered);
        this._setEnabled(N.game, on && !covered && (run || c.gameMode() || c.paused()));
        this._showQr(link);
    }

    /* The link as a QR code: a new PNG file for each new link (the HMI does
     * not load a path again), the old one released once the new one shows. */
    _showQr(text) {
        const q = this._qr, comp = this._components[N.qr], rhmi = this.rhmiApplication;
        this._show(N.qr, !!text);
        if (q.key === (text || '') || !comp || !rhmi) return;
        q.key = text || '';
        q.chain = q.chain.then(() => {
            const bundle = rhmi.getResourceBundle();
            const old = q.file;
            if (!text) {
                q.file = null;
                return old ? this._retireQr(bundle, old) : undefined;
            }
            const dir = qrDir();
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            fs.chmodSync(dir, 0o755);
            const r = qrPng(text, QR_PX);
            const file = path.join(dir, QR_PREFIX + Date.now() + '.png');
            fs.writeFileSync(file, r.png);
            fs.chmodSync(file, 0o644);
            return Promise.resolve(bundle.createResourceHandles([file]))
                .then(() => comp.setValue(0, 'Graphic', file, 'ResourceId'))
                .then(() => rhmi.flush())
                .then(() => {
                    q.file = file;
                    logger.info('QR code ' + r.width + 'x' + r.width + ' px (' + r.modules + ' modules)');
                    return old ? this._retireQr(bundle, old) : undefined;
                }, (err) => this._retireQr(bundle, file).then(() => { throw err; }));
        }).catch((err) => {
            q.key = null;
            logger.warn('QR code failed: ' + (err && err.message));
        });
    }

    _retireQr(bundle, file) {
        return Promise.resolve()
            .then(() => bundle.destroyResourceHandles([file]))
            .catch((err) => logger.warn('QR handle ' + path.basename(file) + ': ' + (err && err.message)))
            .then(() => { try { fs.unlinkSync(file); } catch (e) { /* gone already */ } });
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) return this._shutdownPromise;
        logger.info('vizualyse_chromium shutdown: ' + JSON.stringify(reason));
        if (this._stopSpeed) this._stopSpeed();
        if (this._touch) this._touch.stop(); else this._control.hideAll();
        this._control.close();
        const bundle = this.rhmiApplication && this.rhmiApplication.getResourceBundle();
        this._shutdownPromise = Promise.resolve()
            .then(() => (this._qr.file && bundle ? this._retireQr(bundle, this._qr.file) : undefined))
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new BrowserApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error('vizualyse_chromium failed to start: ' + (err && err.message));
});
