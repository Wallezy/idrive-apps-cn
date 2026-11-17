// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse_cluster - the iDrive page of the vizualyse-cluster tool:
 * whole-cluster themes drawn over the instrument cluster.
 *
 * The touch screen first: entered, the app opens its empty screen state and
 * the tool's touch screen (the theme picker) goes over it; its List corner,
 * BACK or the car moving bring this page back (platform app/touch_mode).
 *
 * One LT_State_Wide page, all of it usable with the iDrive controller: the
 * status; Touch screen (the picker again); one row per theme family
 * (pressing one puts it on the cluster and turns themes on); Sport or
 * Comfort (by the drive mode, always Sport, always Comfort); the car's strip
 * under the theme (shown or covered); themes on or off.
 *
 * The picker is the tool's: a preview of every theme drawn in the app area
 * (not the HMI's top bar or left strip), read by touch. The HMI still gets
 * every touch on it, so it goes over the screen state
 * (ST_..._VizualyseClusterScreen: a title and a label, nothing to press);
 * should that state not open, over the page, every button disabled. It
 * shows only while the state under it is visible and focused: BACK, HOME,
 * another app, or an HMI pop-up taking the focus (a call, a warning) hide it.
 *
 * Only while parked: the app reads the car's speed once a second
 * (vehicle_speed.js) and hands it to the tool, which hides the picker above
 * 3 km/h and won't show it, and tries a theme on the cluster only at a
 * standstill. So the app holds the tool's control socket while it runs, not
 * only while its page shows.
 *
 * The theme's readings: the app reads the car over SOME/IP
 * (vehicle_signals.js: speed, rpm, gear, drive mode, temperatures, tyres,
 * fuel, range, trip...) and sends them to the tool as they change; the
 * drive mode also picks Sport or Comfort. The structure follows
 * vizualyse_steam.
 */
'use strict';
const { translate } = require('./i18n.js');

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { ClusterControl } = require('./cluster_control.js');
const { watchSpeed } = require('./vehicle_speed.js');
const { TouchMode } = require('./touch_mode.js');
const vehicleSignals = require('./vehicle_signals.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_VizualyseCluster';
const SCREEN_NAME = 'ST_OnlineApps_VizualyseClusterScreen';
const N = {
    status: 'clusterStatus', pick: 'clusterPick',
    theme1: 'clusterTheme1', theme2: 'clusterTheme2', theme3: 'clusterTheme3', theme4: 'clusterTheme4',
    theme5: 'clusterTheme5', theme6: 'clusterTheme6', theme7: 'clusterTheme7', theme8: 'clusterTheme8',
    mode: 'clusterMode', cover: 'clusterCover', enable: 'clusterEnable',
};
const THEMES = [N.theme1, N.theme2, N.theme3, N.theme4, N.theme5, N.theme6, N.theme7, N.theme8];
const PRESS_DEDUPE_MS = 400;
const ROW_CHARS = 90;

function oneRow(line) {
    const flat = String(line || '').replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? flat.slice(0, ROW_CHARS - 3) + '...' : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class ClusterApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._screen = null;
        this._touch = null;
        this._themeIds = THEMES.map(() => null);
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._control = new ClusterControl({ log: logger });
        this._control.on('change', () => { if (this._touch) this._touch.sync(); this._render(); });
        this._control.on('list', () => { if (this._touch) this._touch.list(); });
        this._stopSpeed = null;
        this._stopSignals = null;

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error('vizualyse_cluster init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
    }

    _appInitialized() {
        logger.info('vizualyse_cluster ' + this.getAppId() + ' v' + this._packageJson.version + ' starting');
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        /* the tool hears from the app while it runs: the speed and the readings, whatever the page */
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
        this._stopSignals = vehicleSignals.watch(builders, logger, (values) => this._control.signals(values));
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
        if (!this._screen) logger.warn('uiDescription has no ' + SCREEN_NAME + ': the picker goes over the main page');
        const c = this._control;
        this._touch = new TouchMode({ rhmi: rhmi, page: this._state, screen: this._screen, log: logger,
            tool: { connected: () => c.connected(), moving: () => c.moving(), shown: () => c.shown(), show: () => c.showPicker(), hide: () => c.hide() },
            visible: (v) => this._setVisible(v) });
        this._bind(N.pick, () => this._touch.open());
        THEMES.forEach((name, i) => this._bind(name, () => (this._themeIds[i] ? this._control.use(this._themeIds[i]) : true)));
        this._bind(N.mode, () => this._control.nextMode());
        this._bind(N.cover, () => this._control.cover(!this._control.covered()));
        this._bind(N.enable, () => (this._control.enabled() ? this._control.disable() : this._control.enable()));
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
            if (handler() === false) logger.warn(name + ': the cluster themes tool is not connected');
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
        /* off our pages the picker must not cover whatever the HMI shows */
        if (!visible && this._control.hide()) logger.info('app left: picker hidden');
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
        const c = this._control, up = c.connected(), on = c.enabled();
        /* while the picker covers the page, nothing under it can be pressed */
        const covered = this._touch ? this._touch.covered() : c.shown();
        this._write(N.status, c.statusText());
        this._write(N.pick, c.moving() ? 'Touch screen (only while parked)' : 'Touch screen');
        this._write(N.mode, up ? c.modeText() : 'Sport or Comfort');
        this._write(N.cover, "The car's strip under the theme: " + (c.covered() ? 'covered (black)' : 'shown'));
        this._write(N.enable, 'Cluster themes: ' + (up ? (on ? 'on' : "off (the car's own cluster)") : 'not running'));
        this._setEnabled(N.pick, up && !covered && !c.moving());
        this._setEnabled(N.mode, up && !covered);
        this._setEnabled(N.cover, up && !covered);
        this._setEnabled(N.enable, up && !covered);
        const fams = up ? c.families().slice(0, THEMES.length) : [];
        THEMES.forEach((name, i) => {
            const f = fams[i];
            this._themeIds[i] = f ? f.family : null;
            this._show(name, !!f);
            if (!f) return;
            this._write(name, (on && c.theme() === f.family ? 'In use: ' : '') + f.title);
            this._setEnabled(name, !covered);
        });
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) return this._shutdownPromise;
        logger.info('vizualyse_cluster shutdown: ' + JSON.stringify(reason));
        if (this._stopSpeed) this._stopSpeed();
        if (this._stopSignals) this._stopSignals();
        if (this._touch) this._touch.stop(); else this._control.hide();
        this._control.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new ClusterApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error('vizualyse_cluster failed to start: ' + (err && err.message));
});
