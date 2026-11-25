'use strict';
/**
 * main.js - Cluster+ entry point for BMW iDrive 7 (MGU OAP).
 *
 * Uses BMW's native full-screen-width RHMI list (`LT_State_Wide`):
 *   - MAIN: native switches, dropdowns, live status summary, and a button to open Diagnostics.
 *   - DIAG: native full-width Live Telemetry & Diagnostics view to inspect live sensors & UDS reads.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const mgu = require('./kit/mgu');
const cnText = require('./cn_text').text;
const fontsMod = require('./kit/fonts');
const { installStockBmwFonts, getFontStatus } = require('./bmw_font');
const { SignalHub } = require('./signals');
const { EfficiencyTracker } = require('./efficiency');
const { VehicleProfile } = require('./vehicle_profile');
const { OverlayRenderer } = require('./overlay_renderer');
const { formatTemp, formatSpeed } = require('./units');

function asciiOnly(str) {
    return cnText(String(str == null ? '' : str));
}

function fmtTempAscii(tempC, units) {
    return asciiOnly(formatTemp(tempC, units).text);
}

function buildPreviewTpms(liveTpms, overrideCorner, overrideVal) {
    const base = {
        FL: { pressureBar: 2.41, targetBar: 2.41, tempC: 24 },
        FR: { pressureBar: 2.41, targetBar: 2.41, tempC: 24 },
        RL: { pressureBar: 2.62, targetBar: 2.62, tempC: 23 },
        RR: { pressureBar: 2.62, targetBar: 2.62, tempC: 23 },
    };
    const src = liveTpms && typeof liveTpms === 'object' ? liveTpms : {};
    ['FL', 'FR', 'RL', 'RR'].forEach((k) => {
        if (src[k] && typeof src[k].pressureBar === 'number') {
            base[k] = Object.assign({}, base[k], src[k]);
        }
    });
    if (overrideCorner && base[overrideCorner]) {
        base[overrideCorner] = Object.assign({}, base[overrideCorner], overrideVal);
    }
    return base;
}

function buildPreviewAlertByKey(key, units, seq, liveTpms) {
    const isBar = units && units.pressUnit === 'bar';
    const isF = units && units.tempUnit === 'F';
    if (key === 'tpms_low') {
        return {
            id: 'tpms', severity: 'amber', corner: 'FL', seq,
            label: isBar ? 'FL 1.9b' : 'FL 28psi',
            hudText: 'Tire Pressure Low',
            title: 'TIRE PRESSURE LOW',
            heroVal: isBar ? '1.9 bar' : '28 psi',
            detail: isBar ? 'Front Left: 1.9 bar (Target 2.4 bar)' : 'Front Left: 28 psi (Target 35 psi)',
            advice: 'Inflate tire when safe',
            previewTpms: buildPreviewTpms(liveTpms, 'FL', { pressureBar: 1.93, targetBar: 2.41 }),
            desc: 'TPMS Low Pressure (Amber)',
        };
    }
    if (key === 'tpms_crit') {
        return {
            id: 'tpms', severity: 'red', corner: 'FL', seq,
            label: isBar ? 'FL 1.4b' : 'FL 21psi',
            hudText: 'Tire Pressure Critical',
            title: 'TIRE FLAT - CRITICAL',
            heroVal: isBar ? '1.4 bar' : '21 psi',
            detail: isBar ? 'Front Left: 1.4 bar (Target 2.4 bar)' : 'Front Left: 21 psi (Target 35 psi)',
            advice: 'Stop safely & inspect tire',
            previewTpms: buildPreviewTpms(liveTpms, 'FL', { pressureBar: 1.44, targetBar: 2.41 }),
            desc: 'TPMS Critical Flat (Red)',
        };
    }
    if (key === 'tpms_hot') {
        return {
            id: 'tpms_temp', severity: 'amber', corner: 'FR', seq,
            label: isF ? 'FR 187\u00B0F' : 'FR 86\u00B0C',
            hudText: 'Tire Temp High',
            title: 'TIRE TEMP HIGH',
            heroVal: isF ? '187\u00B0F' : '86\u00B0C',
            detail: isF ? 'Front Right: 187\u00B0F (Limit 185\u00B0F)' : 'Front Right: 86\u00B0C (Limit 85\u00B0C)',
            advice: 'Reduce speed & let tire cool',
            previewTpms: buildPreviewTpms(liveTpms, 'FR', { tempC: 86 }),
            desc: 'TPMS Hot Tire (Amber)',
        };
    }
    if (key === 'gbx_warn') {
        return {
            id: 'gbox', severity: 'amber', seq,
            label: isF ? 'GBX 226\u00B0F' : 'GBX 108\u00B0C',
            hudText: 'Gearbox Hot',
            title: 'GEARBOX OIL HOT',
            heroVal: isF ? '226\u00B0F' : '108\u00B0C',
            detail: isF ? 'Transmission oil > 221\u00B0F' : 'Transmission oil > 105\u00B0C',
            advice: 'Reduce load & allow cooling',
            desc: 'Gearbox Hot (Amber)',
        };
    }
    if (key === 'gbx_crit') {
        return {
            id: 'gbox', severity: 'red', seq,
            label: isF ? 'GBX 244\u00B0F' : 'GBX 118\u00B0C',
            hudText: 'Gearbox Critical',
            title: 'GEARBOX TEMP CRITICAL',
            heroVal: isF ? '244\u00B0F' : '118\u00B0C',
            detail: isF ? 'Transmission oil > 239\u00B0F' : 'Transmission oil > 115\u00B0C',
            advice: 'Pull over safely & cool down',
            desc: 'Gearbox Critical (Red)',
        };
    }
    if (key === 'soc12') {
        return {
            id: 'soc12', severity: 'amber', seq,
            label: '12V 52%',
            hudText: '12V Battery Low',
            title: '12V BATTERY LOW',
            heroVal: '52%',
            detail: '12V Aux State of Charge < 55%',
            advice: 'Drive or charge to replenish 12V',
            desc: '12V Battery Low % (Amber)',
        };
    }
    if (key === 'v12') {
        return {
            id: 'v12', severity: 'red', seq,
            label: '12V 11.5V',
            hudText: '12V Battery Critical',
            title: '12V VOLTAGE CRITICAL',
            heroVal: '11.5 V',
            detail: '12V Aux Voltage < 11.7 V',
            advice: 'Check charging system / battery',
            desc: '12V Battery Critical V (Red)',
        };
    }
    return null;
}

function createBackgroundRuntime(bg) {
    const { settings, log, dataDir } = bg;
    installStockBmwFonts(fontsMod, { cacheDir: dataDir, log, bundledOnly: true });

    // Migrate legacy v0.6/v0.7.0 rightWidgetMode dropdown into widgetMedia + widgetTrip checkboxes once
    if (settings.values && settings.values.rightWidgetMode !== undefined) {
        const leg = settings.values.rightWidgetMode;
        delete settings.values.rightWidgetMode;
        if (leg === 'media') {
            settings.set('widgetMedia', true);
            settings.set('widgetTrip', false);
        } else if (leg === 'trip') {
            settings.set('widgetMedia', false);
            settings.set('widgetTrip', true);
        } else if (leg === 'off') {
            settings.set('widgetMedia', false);
            settings.set('widgetTrip', false);
        } else {
            settings.set('widgetMedia', true);
            settings.set('widgetTrip', true);
        }
    }

    const hub = new SignalHub(bg);
    const effTracker = new EfficiencyTracker();
    const profileEval = new VehicleProfile();
    const renderer = new OverlayRenderer({ log, dataDir });
    let prevEnabled = settings.get('enabled') !== false;

    const state = {
        hub,
        effTracker,
        profileEval,
        renderer,
        diagVisible: false,
        alertPreviewKey: null,
        alertPreviewSeq: 0,
        alertPreviewUntilMs: 0,
        onUiTick: null,
        setAlertPreview(key, nowMs) {
            const now = typeof nowMs === 'number' ? nowMs : Date.now();
            if (!key) {
                state.alertPreviewKey = null;
                state.alertPreviewUntilMs = 0;
                return false;
            }
            state.alertPreviewKey = key;
            state.alertPreviewSeq = (state.alertPreviewSeq + 1) % 1000000;
            state.alertPreviewUntilMs = now + 30000;
            return true;
        },
        computeModel(nowMs) {
            const now = typeof nowMs === 'number' ? nowMs : Date.now();
            const telemetry = hub.snapshot(now);
            const units = hub.resolvedUnits();
            const profile = profileEval.evaluate(telemetry, settings.values, units, now);
            const efficiency = effTracker.update({
                speedKmh: telemetry.speedKmh,
                rpm: telemetry.rpm,
                engineOn: profile.engineOn,
                hvKw: telemetry.hvKw,
                dmeFuelLh: telemetry.dmeFuelLh,
                injVolumeRaw: telemetry.injVolumeRaw,
                bcFuelLPer100km: telemetry.bcFuelLPer100km,
            }, now);
            let previewAlert = null;
            let alertPreviewRemSec = 0;
            if (state.alertPreviewKey && state.alertPreviewUntilMs > now) {
                previewAlert = buildPreviewAlertByKey(state.alertPreviewKey, units, state.alertPreviewSeq, telemetry.tpms);
                alertPreviewRemSec = Math.ceil((state.alertPreviewUntilMs - now) / 1000);
            } else if (state.alertPreviewUntilMs > 0) {
                state.alertPreviewKey = null;
                state.alertPreviewUntilMs = 0;
            }
            return { telemetry, units, profile, efficiency, previewAlert, alertPreviewRemSec };
        },
        tick(nowMs, forceUi) {
            const now = typeof nowMs === 'number' ? nowMs : Date.now();
            const model = state.computeModel(now);
            renderer.render(model, settings.values, now);
            const animating = Boolean(model.telemetry && model.telemetry.hudNav && model.telemetry.hudNav.laneAnimating);
            syncLaneAnimTimer(animating);
            if (typeof state.onUiTick === 'function') {
                state.onUiTick(model, now, Boolean(forceUi));
            }
            return model;
        },
        cleanup() {
            clearInterval(timer);
            syncLaneAnimTimer(false);
            hub.stop();
            renderer.close();
        },
    };

    let laneAnimTimer = null;
    function syncLaneAnimTimer(active) {
        if (active && !laneAnimTimer) {
            laneAnimTimer = setInterval(() => {
                try { state.tick(Date.now(), false); } catch (e) { log.warn('anim tick: ' + (e.message || e)); }
            }, 50);
            if (laneAnimTimer && typeof laneAnimTimer.unref === 'function') laneAnimTimer.unref();
        } else if (!active && laneAnimTimer) {
            clearInterval(laneAnimTimer);
            laneAnimTimer = null;
        }
    }

    hub.start();
    renderer.connect();
    hub.syncDemand(settings.values, { diagVisible: false });

    settings.onChange(() => {
        hub.syncDemand(settings.values, { diagVisible: state.diagVisible });
        const nowEnabled = settings.get('enabled') !== false;
        if (!prevEnabled && nowEnabled) {
            if (hub.mediaTracker && typeof hub.mediaTracker.refresh === 'function') {
                hub.mediaTracker.refresh();
            }
            hub.pollNow().then(() => state.tick(Date.now(), true)).catch(() => {});
        }
        prevEnabled = nowEnabled;
        state.tick(Date.now(), true);
    });

    const timer = setInterval(() => {
        try { state.tick(Date.now(), false); } catch (e) { log.warn('tick: ' + (e.message || e)); }
    }, 250);
    state.tick(Date.now(), false);

    return state;
}

mgu.run({
    async background(bg) {
        return createBackgroundRuntime(bg);
    },
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // Translate dynamic button labels too; StringBundle handles Unicode.
        const originalText = ui.text.bind(ui);
        ui.text = (name, value, row, cell) => originalText(name, cnText(value), row, cell);
        const runtime = ctx.background || createBackgroundRuntime(ctx);
        const { hub, renderer, computeModel, tick } = runtime;

        let mainVisible = true;
        let clusterVisible = false;
        let alertsVisible = false;
        let diagVisible = false;
        let lastProbeActive = false;
        let lastMainUpdate = 0;
        let lastDiagUpdate = 0;
        let lastChargingActive = null;
        let lastPanelModeVis = null;
        const lastRowCache = Object.create(null);

        function setTwoRow(name, row1, row2) {
            const r1 = asciiOnly(row1);
            const r2 = asciiOnly(row2);
            const key = r1 + '\n' + r2;
            if (lastRowCache[name] === key) return;
            lastRowCache[name] = key;
            ui.cells(name, 0, { Text1stRow: r1, Text2ndRow: r2 });
        }

        function syncClusterModeVisibility(force) {
            const isPanel = (settings.get('clusterSlotMode') || 'panel_only') !== 'map_only';
            if (!force && lastPanelModeVis === isPanel) return;
            lastPanelModeVis = isPanel;
            const panelOnlyComps = [
                'SET_WIDGETMEDIA',
                'SET_WIDGETTRIP',
                'SET_WIDGETTPMS',
                'WIDGET_CHARGING',
                'SET_CABINTEMPDISPLAY',
                'SET_HVSOCGAUGE',
            ];
            for (let i = 0; i < panelOnlyComps.length; i++) {
                ui.visible(panelOnlyComps[i], isPanel);
            }
        }

        function syncChargingWidgetCheckbox(model, force) {
            const active = Boolean(model && model.telemetry && model.telemetry.charging && model.telemetry.charging.active);
            if (!force && lastChargingActive === active) return;
            lastChargingActive = active;
            ui.enabled('WIDGET_CHARGING', false);
            ui.checked('WIDGET_CHARGING', active);
        }

        function syncAlertPreviewStatus(model) {
            const pa = model && model.previewAlert;
            const rem = model && model.alertPreviewRemSec ? model.alertPreviewRemSec : 0;
            const dismissed = Boolean(renderer.lastSummary && renderer.lastSummary.alertDismissed);
            if (pa && rem > 0) {
                setTwoRow(
                    'ALERT_PREVIEW_STATUS',
                    (dismissed ? 'Dismissed via BC: ' : 'Showing: ') + (pa.hudText || pa.label) + ' (' + rem + 's left)',
                    (pa.desc || 'Preview active') + (dismissed ? ' - tap any alert to re-trigger' : ' - press BC to dismiss')
                );
            } else {
                setTwoRow(
                    'ALERT_PREVIEW_STATUS',
                    'No Alert Preview Active',
                    'Tap any alert below to auto-switch Right Widget & HUD for 30s'
                );
            }
        }

        function updateMainSummary(model) {
            const t = model.telemetry;
            const units = model.units;
            const sum = renderer.lastSummary || {};
            const hero = sum.hero || { value: '--', unit: '' };
            const enabled = settings.get('enabled') !== false;

            if (renderer.slotStatus && renderer.slotStatus.conflictSlot) {
                setTwoRow(
                    'STATUS_SUMMARY',
                    'Action Needed: Revert cluster-render.local.conf (' + renderer.slotStatus.panelSlot + ')',
                    'Slot 0x202 hides Power Gauge; run configure-cluster-slot.sh --revert for 0x203'
                );
                return;
            }

            const clusterNote = sum.showMapOverlay ? '  |  Map 0x100 (BC OK)'
                : (sum.isCharging ? '  |  Charging (auto)'
                    : (sum.hudYieldedToNav ? ('  |  HUD yielded (' + (sum.hudYieldReason || 'mini-map') + ')')
                        : (sum.wocHudOverlay ? '  |  HUD over Waze'
                            : (sum.showOwnHudNav ? '  |  HUD + Nav' : ''))));
            const stateTag = !enabled ? 'Metrics Paused'
                : (renderer.ready ? 'Metrics Active' : 'Waiting for cluster-render') +
                  '  |  ' + (t.demo ? 'Demo' : 'Live') + ' ' + model.profile.mode.toUpperCase().replace('_', ' ') +
                  clusterNote;

            const socPart = (typeof t.soc === 'number' && isFinite(t.soc)) ? ('SOC ' + Math.round(t.soc) + '%')
                : ('OIL ' + fmtTempAscii(t.oilTempC, units));
            const gearPart = sum.isCharging ? 'Stage P' : (sum.inNormalD ? ('Gear D' + Math.round(t.gear)) : ('Stage ' + (t.stage || '--')));
            const detailLine = hero.value + ' ' + hero.unit +
                '  |  ' + asciiOnly(sum.subText || '--') +
                '  |  ' + socPart +
                '  |  ' + gearPart;

            setTwoRow('STATUS_SUMMARY', stateTag, detailLine);

            const targetNames = { both: 'Cluster + HUD', cluster: 'Cluster only', hud: 'HUD only' };
            const genLine = (enabled ? 'Enabled' : 'Paused') + '  |  ' +
                (targetNames[settings.get('displayTarget') || 'both'] || 'Cluster + HUD') +
                '  |  Units: ' + units.system.toUpperCase();
            setTwoRow('TAB_GENERAL', 'General', genLine);

            const rwParts = [];
            if (settings.get('widgetMedia') !== false) rwParts.push('Media');
            if (settings.get('widgetTrip') !== false) rwParts.push('Trip');
            if (settings.get('widgetTpms') !== false) rwParts.push('Tires');
            if (sum.isCharging) rwParts.push('Charging');
            const clusExtras = [];
            if (settings.get('cabinTempDisplay') !== false) clusExtras.push('Cabin');
            if (settings.get('hvSocGauge') !== false && model.profile.vehicleType === 'phev') clusExtras.push('HV%');
            const clusLine = (settings.get('clusterSlotMode') === 'map_only' ? 'Map 0x100' : 'Full Panel') +
                '  |  Widgets: ' + (rwParts.length ? rwParts.join('+') : 'Off') +
                (clusExtras.length ? ('  |  +' + clusExtras.join('/')) : '') +
                '  |  Gear: ' + (settings.get('gearDisplay') || 'next_to_d');
            setTwoRow('TAB_CLUSTER', 'Cluster', clusLine);

            const hwMode = settings.get('hudHeadway') || 'full';
            const hudLine = 'Nav: ' + (settings.get('hudNavMode') || 'own_nav_minimap') +
                '  |  Headway: ' + hwMode +
                '  |  ' + (settings.get('hudLine1') || 'efficiency_gear') +
                '/' + (settings.get('hudLine2') || 'power') +
                '/' + (settings.get('hudLine3') || 'brake');
            setTwoRow('TAB_HUD', 'HUD', hudLine);
        }

        function updateDiagRows(model) {
            const t = model.telemetry;
            const units = model.units;
            const profile = model.profile;
            const sum = renderer.lastSummary || {};
            const hero = sum.hero || { value: '--', unit: '' };
            const spd = formatSpeed(t.speedKmh, units);
            const diagStats = (hub.uds && hub.uds.stats) || {};

            const connState = renderer.ready ? 'Connected' : (renderer.connected ? 'Handshake' : 'Disconnected');
            const clusterModeNote = renderer.slotStatus.conflictSlot
                ? (renderer.slotStatus.panelSlot + ' (BLOCKS POWER GAUGE - revert local.conf!)')
                : (sum.showMapOverlay ? 'map 0x100 (BC widget OK)'
                    : (sum.panelAllowed ? ('panel ' + renderer.slotStatus.panelSlot + ' [RW:' + (sum.rightWidgetPage || 'off') + ']') : 'cluster idle'));
            const hudNote = sum.hudYieldedToNav ? ('HUD yielded (' + (sum.hudYieldReason || 'nav') + ')')
                : (sum.wocHudOverlay ? 'HUD 3-line over Waze'
                    : (sum.showOwnHudNav ? ('HUD ' + (sum.showHudRoad ? 'RoadBanner+Nav' : 'FullNav')) : (sum.showHud ? 'HUD 3-line' : 'HUD off')));
            const fSt = getFontStatus();
            const fontTag = fSt.source === 'bmw_stock_ttf'
                ? 'BMW TTF'
                : (fSt.source === 'bundled_vector_sans'
                    ? 'Vector Sans'
                    : ('Ubuntu' + (fSt.error ? ' (' + fSt.error + ')' : '')));
            const refusedNote = renderer.refused.length ? (' | Refused: ' + renderer.refused[renderer.refused.length - 1]) : '';
            setTwoRow(
                'DIAG_RENDER',
                'Cluster & HUD Renderer (' + connState + ' - Font: ' + fontTag + ')',
                clusterModeNote + ' | ' + hudNote + ' | Layers: ' + renderer.layerCount() + '/64 (' +
                    (renderer.pixelBytesTotal() / 1048576).toFixed(2) + ' MiB)' + refusedNote
            );

            const hn = t.hudNav || {};
            const navModeLabel = settings.get('hudNavMode') || 'own_nav_minimap';
            const navDetail = (hn.summary || 'No active route') +
                (hn.hudSlots ? (' | DCSM: ' + hn.hudSlots) : '') +
                ' | Mode: ' + navModeLabel;
            setTwoRow(
                'DIAG_NAV',
                'HUD Navigation & Mini-Map Detector',
                navDetail
            );

            const lv = t.leadVehicle || {};
            const hwSetting = settings.get('hudHeadway') || 'full';
            let lvDetail;
            if (hwSetting === 'off' && !hub.activeWatchers().gapAhead) {
                lvDetail = 'Disabled in HUD settings (GapVehicleAhead unsubscribed)';
            } else if (lv.active && typeof lv.gapM === 'number') {
                const distTxt = units.distUnit === 'mi'
                    ? (Math.round(lv.gapM * 3.28084) + ' ft')
                    : (lv.gapM.toFixed(1) + ' m');
                const hwTxt = typeof lv.headwaySec === 'number' ? (lv.headwaySec.toFixed(2) + 's') : 'low-spd';
                const relTxt = typeof lv.relSpeedKmh === 'number'
                    ? ((lv.relSpeedKmh >= 0 ? '+' : '') + (units.speedUnit === 'mph' ? (lv.relSpeedKmh * 0.621371).toFixed(1) + ' mph' : lv.relSpeedKmh.toFixed(1) + ' km/h'))
                    : '--';
                lvDetail = 'Headway: ' + hwTxt + ' | Dist: ' + distTxt + ' | Rel: ' + relTxt +
                    (lv.rawGapX !== null && lv.rawGapX !== undefined ? (' | gapX=' + lv.rawGapX) : '');
            } else {
                lvDetail = 'No lead vehicle ahead (st=' + (lv.status || 'idle') +
                    (lv.rawGap8 !== null && lv.rawGap8 !== undefined ? ', g8=' + lv.rawGap8 : '') + ')';
            }
            setTwoRow(
                'DIAG_HEADWAY',
                'HUD Lead-Car Headway (' + (lv.active ? 'TRACKING' : 'Clear') + ' - mode: ' + hwSetting + ')',
                lvDetail
            );

            const md = t.media || {};
            const rwPage = sum.rightWidgetPage || 'off';
            const mdTrack = md.active
                ? (md.title + (md.artist ? (' - ' + md.artist) : '') + (md.cover ? ' [Art OK]' : ' [No Art]'))
                : 'No active media';
            const bcInfo = 'Page: ' + rwPage.toUpperCase() + ' (BC clicks: ' + (md.bcClicks || 0) +
                (md.lastBcSource ? ' via ' + md.lastBcSource : '') +
                ', meta=' + (md.rawShape || '--') +
                ', stalk=' + (md.rawStalk !== null && md.rawStalk !== undefined ? md.rawStalk : '--') +
                ', sel=' + (md.rawKombiSel || '--') + ')';
            setTwoRow(
                'DIAG_MEDIA',
                'Right Widget (' + bcInfo + ')',
                mdTrack
            );

            const chg = t.charging || {};
            const chgKw = (typeof chg.chargeKw === 'number' && isFinite(chg.chargeKw)) ? (chg.chargeKw.toFixed(1) + ' kW') : '-- kW';
            const chgAmps = chg.maxAmps ? (' (' + Math.round(chg.maxAmps) + 'A)') : '';
            const chgRem = chg.remainText ? (' (' + chg.remainText + ' left)') : '';
            const chgHvV = (typeof t.hvVolts === 'number' && isFinite(t.hvVolts)) ? (' | Pack: ' + Math.round(t.hvVolts) + 'V') : '';
            const tzOff = typeof t.localClockOffsetMin === 'number'
                ? (' | TZ: UTC' + (t.localClockOffsetMin >= 0 ? '+' : '') + (t.localClockOffsetMin / 60).toFixed(t.localClockOffsetMin % 60 === 0 ? 0 : 1) +
                    (t.carClockSource ? ' (' + t.carClockSource + ')' : ''))
                : '';
            const chgDetail = chg.active
                ? ('Finish: ' + (chg.finishTimeText || '--:--') + chgRem + chgHvV + ' | ' + chgKw + chgAmps + tzOff)
                : ('Plug: ' + (chg.plugConnected ? 'Connected (' + (chg.source || 'idle') + ')' : 'Unplugged') + tzOff);
            setTwoRow(
                'DIAG_CHARGING',
                'Plug-In Charging (' + (chg.active ? 'ACTIVE - ' + (chg.source || 'charging') : 'Inactive') + ')',
                chgDetail
            );

            const dsc = t.dscBrake || {};
            const fmtBar = (v) => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) + 'b' : '--');
            const dscTitle = 'Brake ECU (DSC 0x29' + (dsc.sgbd ? ' SGBD ' + dsc.sgbd : '') + (dsc.did ? ' DID 0x' + dsc.did : '') + ')';
            const pedPart = (typeof dsc.wegIstMm === 'number')
                ? (' | Pedal: ' + dsc.wegIstMm.toFixed(1) + '/' + (typeof dsc.wegLeerMm === 'number' ? dsc.wegLeerMm.toFixed(1) : '--') + 'mm')
                : '';
            const regPart = (typeof dsc.regenIstNm === 'number')
                ? (' | Regen: ' + dsc.regenIstNm + 'Nm')
                : '';
            const dscLine = t.demo
                ? 'Demo mode (connect to car for live DSC 0x29 hydraulic pressure & 30s probe)'
                : ('Caliper: ' + fmtBar(dsc.caliperBar) + ' | K1/K2: ' + fmtBar(dsc.k1Bar) + '/' + fmtBar(dsc.k2Bar) +
                    ' | VA/HA: ' + fmtBar(dsc.ch4Bar) + '/' + fmtBar(dsc.ch8Bar) + pedPart + regPart +
                    (dsc.nrc ? (' | NRC ' + dsc.nrc) : ''));
            setTwoRow('DIAG_BRAKE_ECU', dscTitle, dscLine);

            if (t.probeRemainingSec > 0) {
                ui.text('BTN_PROBE_BRAKE', 'Recording Probe (' + t.probeRemainingSec + 's)...');
            } else if (lastProbeActive) {
                lastProbeActive = false;
                ui.text('BTN_PROBE_BRAKE', 'Saved ' + asciiOnly(t.probeSavedPath || '/tmp/cluster-metrics-probe.log'));
            }

            const tripDiag = (typeof t.tripDistKm === 'number' && isFinite(t.tripDistKm))
                ? (' | Trip: ' + (units.distUnit === 'mi' ? (t.tripDistKm * 0.621371).toFixed(1) + ' mi' : t.tripDistKm.toFixed(1) + ' km') +
                    (typeof t.rawWayPassed === 'number' ? ' (raw=' + t.rawWayPassed + ')' : ''))
                : '';
            setTwoRow(
                'DIAG_POWERTRAIN',
                'Powertrain (' + profile.vehicleType.toUpperCase() + (t.demo ? ' DEMO' : ' LIVE') + ' - ' + profile.mode.toUpperCase() + ')',
                'Efficiency: ' + hero.value + ' ' + hero.unit + ' | Secondary: ' + (sum.subText || '--') +
                    ' | Speed: ' + spd.value + ' ' + spd.unit + ' @ ' + Math.round(t.rpm || 0) + ' rpm' + tripDiag
            );

            const socStr = (typeof t.soc === 'number' && isFinite(t.soc)) ? (t.soc.toFixed(1) + '%') : '--';
            const kwStr = (typeof t.hvKw === 'number' && isFinite(t.hvKw))
                ? (t.hvKw < -0.05 ? ('+' + Math.abs(t.hvKw).toFixed(1) + ' kW CHG') : (Math.abs(t.hvKw).toFixed(1) + ' kW'))
                : '--';
            const erangeStr = (typeof t.erangeKm === 'number' && isFinite(t.erangeKm))
                ? (units.distUnit === 'mi' ? Math.round(t.erangeKm * 0.621371) + ' mi' : Math.round(t.erangeKm) + ' km')
                : '--';
            const hybExtra = (t.opModeHybrid !== null && t.opModeHybrid !== undefined ? ' | Op:' + t.opModeHybrid : '') +
                (t.iceStartReason && t.iceStartReason !== 'NONE' ? ' | ICE:' + t.iceStartReason : '');
            setTwoRow(
                'DIAG_BATTERY',
                'HV Battery (Charge / Power / Temp)',
                'SoC: ' + socStr + ' | Power: ' + kwStr + ' | Temp: ' + fmtTempAscii(t.battTempC, units) + ' | EV Range: ' + erangeStr + hybExtra
            );

            const hvacTag = t.cabinHvacMode === 'cooling' ? ' [AC]'
                : (t.cabinHvacMode === 'heating' ? ' [HEAT]'
                    : (t.cabinHvacMode === 'fan' ? ' [FAN]'
                        : (t.cabinHvacMode === 'off' ? ' [OFF]' : '')));
            const rawCabinTag = typeof t.rawCabinTemp === 'number' ? (' (raw=' + t.rawCabinTemp + ')') : '';
            setTwoRow(
                'DIAG_TEMPS',
                'Engine, Gearbox & Cabin Temperatures',
                'Oil: ' + fmtTempAscii(t.oilTempC, units) +
                    ' | Cool: ' + fmtTempAscii(t.coolantTempC, units) +
                    ' | GBX: ' + fmtTempAscii(t.gearboxOilC, units) +
                    ' | Cabin: ' + fmtTempAscii(t.cabinTempC, units) + rawCabinTag + hvacTag +
                    ' | IAT: ' + fmtTempAscii(t.iatC, units)
            );

            const gearDesc = sum.inNormalD
                ? ('D' + Math.round(t.gear) + ' (white digit shown next to D)')
                : ((t.stage || '--') + ' / prog=' + (t.program || 'D') + ' / gear=' + (t.gear !== null ? t.gear : '--') + ' (hidden)');
            const swTag = t.driverBraking === true ? 'ON' : (t.driverBraking === false ? 'OFF' : '--');
            const barTag = (typeof t.brakeBar === 'number' && isFinite(t.brakeBar)) ? (t.brakeBar.toFixed(1) + ' bar, ') : '';
            const brakeDesc = sum.brakeMode === 'off'
                ? 'Off'
                : (sum.isParked ? 'Hidden in Park'
                    : (sum.brakeHold ? ('Pedal hold 1/20 (' + barTag + 'sw=' + swTag + ')')
                        : (t.frictionG > 0.02
                            ? (barTag + t.frictionG.toFixed(2) + 'g (' + sum.brakeLit + '/20, sw=' + swTag + ')' + (t.absActive ? ' ABS' : ''))
                            : (sum.iceChargeActive
                                ? ('ICE Chg +' + sum.iceChargeKw.toFixed(1) + ' kW (' + sum.iceChargeLit + '/20)')
                                : ('0.00g idle (' + barTag + 'sw=' + swTag + ')')))));
            setTwoRow(
                'DIAG_CHASSIS',
                'Gearbox & Friction Brake',
                'Gear: ' + gearDesc + ' | Brake: ' + brakeDesc
            );

            const v12Parts = [];
            if (typeof t.v12 === 'number' && isFinite(t.v12)) v12Parts.push(t.v12.toFixed(2) + 'V');
            if (typeof t.soc12 === 'number' && isFinite(t.soc12)) v12Parts.push(Math.round(t.soc12) + '%');
            const v12Str = v12Parts.length ? v12Parts.join(' ') : '--';
            const alertStr = profile.alert ? profile.alert.label : 'Nominal';
            const srcTag = t.ipcActive ? 'IPC+UDS' : ((hub.uds && hub.uds.smeSilentSince) ? 'UDS(auto-wake)' : 'UDS');
            setTwoRow(
                'DIAG_UDS',
                'Read-Only UDS & Aux Telemetry (Units: ' + units.system.toUpperCase() + ')',
                srcTag + ' sent=' + (diagStats.sent || 0) + ' ok=' + (diagStats.replies || 0) +
                    ' miss=' + (diagStats.missed || 0) + ' blk=' + (diagStats.blocked || 0) +
                    ' | 12V: ' + v12Str + ' | Alerts: ' + alertStr
            );
        }

        runtime.onUiTick = (model, now, forceUi) => {
            const sum = renderer.lastSummary || {};
            const heroStr = sum.hero ? (sum.hero.value + ' ' + sum.hero.unit) : '--';
            if (process.env.CLUSTER_METRICS_BENCH === '1') {
                const statusLine = (settings.get('enabled') === false ? 'OFF' : model.profile.mode.toUpperCase()) +
                    '  |  ' + heroStr +
                    '  |  ' + (renderer.canUsePanel() ? 'Cluster+HUD' : 'HUD only');
                try { ui.text('STATUS', asciiOnly(statusLine)); } catch (e) { /* optional bench hook */ }
            }

            syncChargingWidgetCheckbox(model, clusterVisible || forceUi);
            syncClusterModeVisibility(clusterVisible || forceUi);
            if (alertsVisible || forceUi) syncAlertPreviewStatus(model);

            if ((mainVisible || forceUi) && (forceUi || now - lastMainUpdate >= 1000)) {
                lastMainUpdate = now;
                try { updateMainSummary(model); } catch (e) { log.warn('main summary: ' + (e.message || e)); }
            }
            if ((diagVisible || forceUi) && (forceUi || now - lastDiagUpdate >= 240)) {
                lastDiagUpdate = now;
                try { updateDiagRows(model); } catch (e) { log.warn('diag update: ' + (e.message || e)); }
            }
        };

        ui.onClick('TAB_GENERAL', () => {
            ui.open('GENERAL');
        });

        ui.onClick('BTN_ALERTS_MENU', () => {
            alertsVisible = true;
            syncAlertPreviewStatus(computeModel(Date.now()));
            ui.open('ALERTS');
        });

        const alertButtons = [
            ['ALERT_TPMS_LOW', 'tpms_low'],
            ['ALERT_TPMS_CRIT', 'tpms_crit'],
            ['ALERT_TPMS_HOT', 'tpms_hot'],
            ['ALERT_GBX_WARN', 'gbx_warn'],
            ['ALERT_GBX_CRIT', 'gbx_crit'],
            ['ALERT_12V_SOC', 'soc12'],
            ['ALERT_12V_VOLT', 'v12'],
            ['ALERT_CLEAR', null],
        ];
        alertButtons.forEach((pair) => {
            ui.onClick(pair[0], () => {
                runtime.setAlertPreview(pair[1], Date.now());
                tick(Date.now(), true);
            });
        });

        ui.onClick('TAB_CLUSTER', () => {
            clusterVisible = true;
            syncClusterModeVisibility(true);
            syncChargingWidgetCheckbox(computeModel(Date.now()), true);
            ui.open('CLUSTER');
        });

        ui.onClick('TAB_HUD', () => {
            ui.open('HUD');
        });

        ui.onClick('WIDGET_CHARGING', () => {
            // Auto-managed read-only status indicator: cannot be turned off while charging or enabled when not charging
            ui.enabled('WIDGET_CHARGING', false);
            ui.checked('WIDGET_CHARGING', Boolean(lastChargingActive));
        });

        ui.onClick('BTN_DIAG', () => {
            diagVisible = true;
            runtime.diagVisible = true;
            hub.syncDemand(settings.values, { diagVisible: true });
            tick(Date.now(), true);
            ui.open('DIAG');
        });

        ui.onClick('BTN_READ_NOW', () => {
            ui.text('BTN_READ_NOW', 'Reading UDS...');
            hub.pollNow().then(() => {
                ui.text('BTN_READ_NOW', 'Read UDS Sensors Now');
                tick(Date.now(), true);
            }).catch(() => {
                ui.text('BTN_READ_NOW', 'Read UDS Sensors Now');
            });
        });

        ui.onClick('BTN_PROBE_BRAKE', () => {
            lastProbeActive = true;
            ui.text('BTN_PROBE_BRAKE', 'Recording Probe (30s)...');
            hub.startProbe(30000).then(() => {
                tick(Date.now(), true);
            }).catch(() => {});
        });

        ui.onVisible((name, shown) => {
            if (name === 'MAIN') {
                mainVisible = shown;
                if (shown) tick(Date.now(), true);
            } else if (name === 'CLUSTER') {
                clusterVisible = shown;
                if (shown) {
                    syncClusterModeVisibility(true);
                    syncChargingWidgetCheckbox(computeModel(Date.now()), true);
                }
            } else if (name === 'ALERTS') {
                alertsVisible = shown;
                if (shown) syncAlertPreviewStatus(computeModel(Date.now()));
            } else if (name === 'DIAG') {
                diagVisible = shown;
                runtime.diagVisible = shown;
                hub.syncDemand(settings.values, { diagVisible: shown });
                if (shown) tick(Date.now(), true);
            }
        });

        tick(Date.now(), true);

        ctx.stop = runtime.cleanup;
        return runtime.cleanup;
    },
});
