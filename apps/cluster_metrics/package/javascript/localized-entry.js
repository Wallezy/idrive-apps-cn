require('./app.js');
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

        let mainVisible = true;
        let diagVisible = false;
        let lastProbeActive = false;
        let lastMainUpdate = 0;
        let lastDiagUpdate = 0;
        let prevEnabled = settings.get('enabled') !== false;
        const lastRowCache = Object.create(null);

        function setTwoRow(name, row1, row2) {
            const r1 = asciiOnly(row1);
            const r2 = asciiOnly(row2);
            const key = r1 + '\n' + r2;
            if (lastRowCache[name] === key) return;
            lastRowCache[name] = key;
            ui.cells(name, 0, { Text1stRow: r1, Text2ndRow: r2 });
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
                : (sum.hudYieldedToNav ? ('  |  HUD yielded (' + (sum.hudYieldReason || 'mini-map') + ')')
                    : (sum.wocHudOverlay ? '  |  HUD over Waze'
                        : (sum.showOwnHudNav ? '  |  HUD + Nav' : '')));
            const stateTag = !enabled ? 'Metrics Paused'
                : (renderer.ready ? 'Metrics Active' : 'Waiting for cluster-render') +
                  '  |  ' + (t.demo ? 'Demo' : 'Live') + ' ' + model.profile.mode.toUpperCase().replace('_', ' ') +
                  clusterNote;

            const socPart = (typeof t.soc === 'number' && isFinite(t.soc)) ? ('SOC ' + Math.round(t.soc) + '%')
                : ('OIL ' + fmtTempAscii(t.oilTempC, units));
            const gearPart = sum.inNormalD ? ('Gear D' + Math.round(t.gear)) : ('Stage ' + (t.stage || '--'));
            const detailLine = hero.value + ' ' + hero.unit +
                '  |  ' + asciiOnly(sum.subText || '--') +
                '  |  ' + socPart +
                '  |  ' + gearPart;

            setTwoRow('STATUS_SUMMARY', stateTag, detailLine);
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
                    : (sum.panelAllowed ? ('panel ' + renderer.slotStatus.panelSlot) : 'cluster idle'));
            const hudNote = sum.hudYieldedToNav ? ('HUD yielded (' + (sum.hudYieldReason || 'nav') + ')')
                : (sum.wocHudOverlay ? 'HUD 3-line over Waze'
                    : (sum.showOwnHudNav ? 'HUD 3-line + Full Nav' : (sum.showHud ? 'HUD 3-line' : 'HUD off')));
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
                'Engine & Gearbox Temperatures',
                'Oil: ' + fmtTempAscii(t.oilTempC, units) +
                    ' | Coolant: ' + fmtTempAscii(t.coolantTempC, units) +
                    ' | Gearbox: ' + fmtTempAscii(t.gearboxOilC, units) +
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

            const v12Str = (typeof t.v12 === 'number' && isFinite(t.v12)) ? (t.v12.toFixed(2) + 'V') : '--';
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

            if ((mainVisible || forceUi) && (forceUi || now - lastMainUpdate >= 1000)) {
                lastMainUpdate = now;
                try { updateMainSummary(model); } catch (e) { log.warn('main summary: ' + (e.message || e)); }
            }
            if ((diagVisible || forceUi) && (forceUi || now - lastDiagUpdate >= 240)) {
                lastDiagUpdate = now;
                try { updateDiagRows(model); } catch (e) { log.warn('diag update: ' + (e.message || e)); }
            }
        }

        ui.onClick('BTN_DIAG', () => {
            diagVisible = true;
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
            } else if (name === 'DIAG') {
                diagVisible = shown;
                if (shown) tick(Date.now(), true);
            }
        });

        settings.onChange(() => {
            const nowEnabled = settings.get('enabled') !== false;
            if (!prevEnabled && nowEnabled) {
                hub.pollNow().then(() => tick(Date.now(), true)).catch(() => {});
            }
            prevEnabled = nowEnabled;
            tick(Date.now(), true);
        });

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
