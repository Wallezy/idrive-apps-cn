// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse_cast - the iDrive page of the vizualyse-cast tool, which plays a
 * stream URL from the phone on the instrument cluster, the HUD or this
 * screen (the media console), with its sound through the speakers.
 *
 * The touch screen first: entered, the app opens its empty screen state and
 * the tool's touch screen goes over it (the same controls by touch: Cast,
 * CarPlay and Info tabs); its List corner, BACK or the car moving bring
 * this page back (platform app/touch_mode). Only where the tool can draw it
 * (mgu-render installed: the tool's touchAvailable) and only while parked:
 * the app reads the car's speed once a second (vehicle_speed.js) and hands
 * it to the tool, which hides the touch screen above 3 km/h. Cast is used
 * while driving: this page keeps every control.
 *
 * One LT_State_Wide page: the status; Touch screen (the touch screen
 * again); the phone page's link as a QR code
 * (LT_Label_1Graphic_Scalable, a PNG in /dev/shm the HMI can read) and as
 * text; Cast to cluster on or off; Stop; the CarPlay second screen on or
 * off (hook111's mode, now and for later starts); its cluster view (map and
 * directions, map only, directions only); the CarPlay map (CarPlay's own
 * second screen, through hook111) on the cluster or on the HUD;
 * Play last on the cluster map / the HUD / this screen, which replay the
 * last stream the phone started (its URL stays in the tool); and the QR code
 * on the cluster on or off. The app holds the tool's control
 * socket while it runs (cast_control.js: the speed goes on with the page
 * hidden); the tool keeps running without it. The structure follows
 * robertn_waze_cluster and vizualyse_cluster.
 */
'use strict';
const { translate } = require('./i18n.js');

const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { CastControl } = require('./cast_control.js');
const { qrPng } = require('./qr_png.js');
const { TouchMode } = require('./touch_mode.js');
const { watchSpeed } = require('./vehicle_speed.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_VizualyseCast';
const SCREEN_NAME = 'ST_OnlineApps_VizualyseCastScreen';
const N = {
    status: 'castStatus', touch: 'castTouch', qr: 'castQr', link: 'castLink', hint: 'castHint', stop: 'castStop',
    map: 'castMap', hud: 'castHud', console: 'castConsole', qrToggle: 'castQrToggle', info: 'castInfo',
    enable: 'castEnable', carplayOn: 'castCarplayOn', carplayDirections: 'castCarplayDirections', carplayEta: 'castCarplayEta', carplayZoomIn: 'castCarplayZoomIn', carplayZoomOut: 'castCarplayZoomOut', carplayCentre: 'castCarplayCentre', carplayHudAlt: 'castCarplayHudAlt', carplayMap: 'castCarplayMap', carplayHud: 'castCarplayHud',
};
const PRESS_DEDUPE_MS = 400;
const ROW_CHARS = 90;
const QR_PX = 360;
const QR_PREFIX = 'qr_';

/* The QR folder: world-readable, so the HMI (another uid) can load the PNG. */
function qrDir() {
    if (process.env.CAST_QR_DIR) return process.env.CAST_QR_DIR;
    const uid = process.getuid ? process.getuid() : 0;
    return '/dev/shm/vizualyse_cast_qr_' + uid;
}

function oneRow(line) {
    const flat = String(line || '').replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? flat.slice(0, ROW_CHARS - 3) + '...' : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class CastApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._screen = null;
        this._touch = null;
        this._stopSpeed = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._qr = { key: null, file: null, chain: Promise.resolve() };
        this._control = new CastControl({ log: logger });
        this._control.on('change', () => { if (this._touch) this._touch.sync(); this._render(); });
        this._control.on('list', () => { if (this._touch) this._touch.list(); });

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error('vizualyse_cast init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
    }

    _appInitialized() {
        logger.info('vizualyse_cast ' + this.getAppId() + ' v' + this._packageJson.version + ' starting');
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
        if (!this._screen) logger.warn('uiDescription has no ' + SCREEN_NAME + ': the touch screen goes over the main page');
        const c = this._control;
        /* the touch screen only where the tool can draw it (mgu-render) */
        this._touch = new TouchMode({ rhmi: rhmi, page: this._state, screen: this._screen, log: logger,
            tool: { connected: () => c.connected() && c.touchAvailable(), moving: () => c.moving(), shown: () => c.touchShown(),
                show: () => c.showTouch(), hide: () => c.hideTouch() },
            visible: (v) => this._setVisible(v) });
        this._bind(N.touch, () => this._touch.open());
        this._bind(N.stop, () => this._control.stop());
        this._bind(N.enable, () => (this._control.enabled() ? this._control.disable() : this._control.enable()));
        this._bind(N.carplayOn, () => this._control.setCarplayOn(!this._control.carplaySwitch().on));
        this._bind(N.carplayDirections, () => { const k = this._control.carplayCards(); this._control.setCarplayCards({ directions: !(k && k.directions) }); });
        this._bind(N.carplayEta, () => { const k = this._control.carplayCards(); this._control.setCarplayCards({ eta: !(k && k.eta) }); });
        this._bind(N.carplayZoomIn, () => this._control.zoom('in'));
        this._bind(N.carplayZoomOut, () => this._control.zoom('out'));
        this._bind(N.carplayCentre, () => this._control.setCarplayCentre(!this._control.carplayCentre().on));
        this._bind(N.carplayHudAlt, () => this._control.setCarplayHudAlt(!this._control.carplayHudAlt()));
        this._bind(N.carplayMap, () => this._control.carplay('map'));
        this._bind(N.carplayHud, () => this._control.carplay('hud'));
        this._bind(N.map, () => this._control.replay('map'));
        this._bind(N.hud, () => this._control.replay('hud'));
        this._bind(N.console, () => this._control.replay('console'));
        this._bind(N.qrToggle, () => this._control.setQr(!this._control.qrOnCluster()));
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
            if (handler() === false) logger.warn(name + ': the cast service is not connected');
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
        /* off our pages the touch screen must not cover whatever the HMI shows */
        if (!visible && this._control.hideTouch()) logger.info('app left: touch screen hidden');
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
            Promise.resolve(this._components[name].setEnabled(enabled))
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
        const c = this._control, up = c.connected(), on = up && c.enabled(), link = on ? c.link() : '';
        /* while the touch screen covers this page itself, nothing under it can be pressed */
        const covered = this._touch ? this._touch.covered() : c.touchShown();
        const en = (name, v) => this._setEnabled(name, v && !covered);
        this._write(N.status, c.statusText());
        this._write(N.touch, !up || c.touchAvailable() ? (c.moving() ? 'Touch screen (only while parked)' : 'Touch screen') : 'Touch screen (needs mgu-render)');
        this._setEnabled(N.touch, up && c.touchAvailable() && !c.moving() && !covered);
        this._write(N.link, link ? link : '');
        this._write(N.hint, link ? 'Scan with the phone whose hotspot the car is on, or open the link' : '');
        this._write(N.info, c.infoText());
        this._write(N.qrToggle, 'QR code on the cluster: ' + (c.qrOnCluster() ? 'on' : 'off'));
        this._write(N.enable, 'Cast to cluster: ' + (up ? (c.enabled() ? 'on' : 'off') : 'not running'));
        en(N.enable, up);
        en(N.stop, on && c.playing());
        this._write(N.carplayOn, c.switchText());
        en(N.carplayOn, up && c.carplaySwitch().installed);
        this._write(N.carplayDirections, c.cardText('directions'));
        this._write(N.carplayEta, c.cardText('eta'));
        ['carplayDirections', 'carplayEta'].forEach((k) => en(N[k], up && c.carplaySwitch().installed));
        ['carplayZoomIn', 'carplayZoomOut'].forEach((k) => en(N[k], on && c.canCarplay() && c.playing()));
        this._write(N.carplayCentre, c.centreText());
        en(N.carplayCentre, up && c.carplaySwitch().installed);
        this._write(N.carplayHudAlt, c.hudAltText());
        en(N.carplayHudAlt, up && c.carplaySwitch().installed);
        en(N.carplayMap, on && c.canCarplay());
        en(N.carplayHud, on && c.canCarplay());
        ['map', 'hud', 'console'].forEach((k) => {
            this._show(N[k], k !== 'console' || !up || c.hasOutput('console'));
            en(N[k], on && c.canReplay());
        });
        en(N.qrToggle, on);
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
        logger.info('vizualyse_cast shutdown: ' + JSON.stringify(reason));
        if (this._stopSpeed) this._stopSpeed();
        if (this._touch) this._touch.stop(); else this._control.hideTouch();
        this._control.close();
        const bundle = this.rhmiApplication && this.rhmiApplication.getResourceBundle();
        this._shutdownPromise = Promise.resolve()
            .then(() => (this._qr.file && bundle ? this._retireQr(bundle, this._qr.file) : undefined))
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new CastApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error('vizualyse_cast failed to start: ' + (err && err.message));
});
