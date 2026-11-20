'use strict';
/**
 * main.js - Cluster Metrics entry point for BMW iDrive 7 (MGU OAP).
 *
 * Uses BMW's native full-screen-width RHMI list (`LT_State_Wide`):
 *   - MAIN: native switches, dropdowns, live status summary, and a button to open Diagnostics.
 *   - DIAG: native full-width Live Telemetry & Diagnostics view to inspect live sensors & UDS reads.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const mgu = require('./kit/mgu');
const cnText = require('./cn_text').text;
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

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        // Translate dynamic button labels too; StringBundle handles Unicode.
        const originalText = ui.text.bind(ui);
        ui.text = (name, value, row, cell) => originalText(name, cnText(value), row, cell);
        const hub = new SignalHub(ctx);
        const effTracker = new EfficiencyTracker();
        const profileEval = new VehicleProfile();
        const renderer = new OverlayRenderer({ log });

        hub.start();
        renderer.connect();

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

        let mainVisible = true;
        let clusterVisible = false;
        let diagVisible = false;
        let lastProbeActive = false;
        let lastMainUpdate = 0;
        let lastDiagUpdate = 0;
        let prevEnabled = settings.get('enabled') !== false;
        let lastChargingActive = null;
        const lastRowCache = Object.create(null);

        function setTwoRow(name, row1, row2) {
            const r1 = asciiOnly(row1);
            const r2 = asciiOnly(row2);
            const key = r1 + '\n' + r2;
            if (lastRowCache[name] === key) return;
            lastRowCache[name] = key;
            ui.cells(name, 0, { Text1stRow: r1, Text2ndRow: r2 });
        }

        function syncChargingWidgetCheckbox(model, force) {
            const active = Boolean(model && model.telemetry && model.telemetry.charging && model.telemetry.charging.active);
            if (!force && lastChargingActive === active) return;
            lastChargingActive = active;
            ui.enabled('WIDGET_CHARGING', false);
            ui.checked('WIDGET_CHARGING', active);
        }

        function computeModel(nowMs) {
            const telemetry = hub.snapshot(nowMs);
            const units = hub.resolvedUnits();
            const profile = profileEval.evaluate(telemetry, settings.values, units, nowMs);
            const efficiency = effTracker.update({
                speedKmh: telemetry.speedKmh,
                rpm: telemetry.rpm,
                engineOn: profile.engineOn,
                hvKw: telemetry.hvKw,
                dmeFuelLh: telemetry.dmeFuelLh,
                injVolumeRaw: telemetry.injVolumeRaw,
                bcFuelLPer100km: telemetry.bcFuelLPer100km,
            }, nowMs);
            return { telemetry, units, profile, efficiency };
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
            const refusedNote = renderer.refused.length ? (' | Refused: ' + renderer.refused[renderer.refused.length - 1]) : '';
            setTwoRow(
                'DIAG_RENDER',
                'Cluster & HUD Renderer (' + connState + ')',
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
            const chgDetail = chg.active
                ? ('Speed: ' + chgKw + chgAmps + ' | Finish: ' + (chg.finishTimeText || '--:--') + chgRem + ' | Target: ' + (chg.targetSoc || 100) + '%')
                : ('Plug: ' + (chg.plugConnected ? 'Connected (' + (chg.source || 'idle') + ')' : 'Unplugged') + ' | Auto widget idle');
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

            setTwoRow(
                'DIAG_POWERTRAIN',
                'Powertrain (' + profile.vehicleType.toUpperCase() + (t.demo ? ' DEMO' : ' LIVE') + ' - ' + profile.mode.toUpperCase() + ')',
                'Efficiency: ' + hero.value + ' ' + hero.unit + ' | Secondary: ' + (sum.subText || '--') +
                    ' | Speed: ' + spd.value + ' ' + spd.unit + ' @ ' + Math.round(t.rpm || 0) + ' rpm'
            );

            const socStr = (typeof t.soc === 'number' && isFinite(t.soc)) ? (t.soc.toFixed(1) + '%') : '--';
            const kwStr = (typeof t.hvKw === 'number' && isFinite(t.hvKw)) ? ((t.hvKw >= 0 ? '+' : '') + t.hvKw.toFixed(1) + ' kW') : '--';
            const erangeStr = (typeof t.erangeKm === 'number' && isFinite(t.erangeKm))
                ? (units.distUnit === 'mi' ? Math.round(t.erangeKm * 0.621371) + ' mi' : Math.round(t.erangeKm) + ' km')
                : '--';
            setTwoRow(
                'DIAG_BATTERY',
                'HV Battery (Charge / Power / Temp)',
                'SoC: ' + socStr + ' | Power: ' + kwStr + ' | Temp: ' + fmtTempAscii(t.battTempC, units) + ' | EV Range: ' + erangeStr
            );

            setTwoRow(
                'DIAG_TEMPS',
                'Engine, Gearbox & Cabin Temperatures',
                'Oil: ' + fmtTempAscii(t.oilTempC, units) +
                    ' | Cool: ' + fmtTempAscii(t.coolantTempC, units) +
                    ' | GBX: ' + fmtTempAscii(t.gearboxOilC, units) +
                    ' | Cabin: ' + fmtTempAscii(t.cabinTempC, units) +
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
                            : ('0.00g idle (' + barTag + 'sw=' + swTag + ')'))));
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

        function tick(nowMs, forceUi) {
            const now = typeof nowMs === 'number' ? nowMs : Date.now();
            const model = computeModel(now);
            renderer.render(model, settings.values, now);

            const sum = renderer.lastSummary || {};
            const heroStr = sum.hero ? (sum.hero.value + ' ' + sum.hero.unit) : '--';
            if (process.env.CLUSTER_METRICS_BENCH === '1') {
                const statusLine = (settings.get('enabled') === false ? 'OFF' : model.profile.mode.toUpperCase()) +
                    '  |  ' + heroStr +
                    '  |  ' + (renderer.canUsePanel() ? 'Cluster+HUD' : 'HUD only');
                try { ui.text('STATUS', asciiOnly(statusLine)); } catch (e) { /* optional bench hook */ }
            }

            syncChargingWidgetCheckbox(model, clusterVisible || forceUi);

            if ((mainVisible || forceUi) && (forceUi || now - lastMainUpdate >= 1000)) {
                lastMainUpdate = now;
                try { updateMainSummary(model); } catch (e) { log.warn('main summary: ' + (e.message || e)); }
            }
            if ((diagVisible || forceUi) && (forceUi || now - lastDiagUpdate >= 240)) {
                lastDiagUpdate = now;
                try { updateDiagRows(model); } catch (e) { log.warn('diag update: ' + (e.message || e)); }
            }
        }

        ui.onClick('TAB_GENERAL', () => {
            ui.open('GENERAL');
        });

        ui.onClick('TAB_CLUSTER', () => {
            clusterVisible = true;
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
                if (shown) syncChargingWidgetCheckbox(computeModel(Date.now()), true);
            } else if (name === 'DIAG') {
                diagVisible = shown;
                hub.syncDemand(settings.values, { diagVisible: shown });
                if (shown) tick(Date.now(), true);
            }
        });

        settings.onChange(() => {
            hub.syncDemand(settings.values, { diagVisible });
            const nowEnabled = settings.get('enabled') !== false;
            if (!prevEnabled && nowEnabled) {
                if (hub.mediaTracker && typeof hub.mediaTracker.refresh === 'function') {
                    hub.mediaTracker.refresh();
                }
                hub.pollNow().then(() => tick(Date.now(), true)).catch(() => {});
            }
            prevEnabled = nowEnabled;
            tick(Date.now(), true);
        });

        hub.syncDemand(settings.values, { diagVisible });

        const timer = setInterval(() => {
            try { tick(Date.now(), false); } catch (e) { log.warn('tick: ' + (e.message || e)); }
        }, 250);
        tick(Date.now(), true);

        const cleanup = () => {
            clearInterval(timer);
            hub.stop();
            renderer.close();
        };
        ctx.stop = cleanup;
        return cleanup;
    },
});
