'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const js = path.join(root, 'apps/cluster_metrics/package/javascript');
const { decodeDestinationInfo, etaSnapshot, etaParts, TURN_RECT, ETA_RECT } = require(path.join(js, 'nav_cards'));
const { NavTracker } = require(path.join(js, 'nav_tracker'));
const { OverlayRenderer } = require(path.join(js, 'overlay_renderer'));
const { SignalHub } = require(path.join(js, 'signals'));
const { Canvas } = require(path.join(js, 'kit/canvas'));
const spec = JSON.parse(fs.readFileSync(path.join(js, 'kit/app-spec.json')));
let passed = 0;
function test(name, fn) { fn(); console.log('PASS ' + name); passed++; }
const wall = Date.UTC(2026, 10, 28, 15, 55);
function destination(time, distance, hour, minute) {
    return {
        travelTime: time, formattedDistance: { rawDistance: distance },
        estimatedArrivalTime: { time: { hour, minute } },
    };
}
function freshTracker() {
    const t = new NavTracker({ crStatusPath: '/nonexistent', wazeStatusPath: '/nonexistent' });
    t.feedField('guidance', 'guidingProvider', 'CAR_PLAY', 990);
    t.feedField('carplay', 'projectedGuidanceActive', true, 1000);
    return t;
}
test('destination units, invalid values and atomic final waypoint', () => {
    assert.deepStrictEqual(decodeDestinationInfo(destination(540, 6200, 0, 38)),
        { hour: 0, min: 38, remainSec: 540, remainMeters: 6200 });
    assert.strictEqual(decodeDestinationInfo({ distanceToDestination: { distance: '1,2', unit: 'KM' } }).remainMeters, 1200);
    assert.strictEqual(decodeDestinationInfo({ distanceToDestination: { distance: '1,234', unit: 'M' } }).remainMeters, 1234);
    assert.strictEqual(decodeDestinationInfo({ distanceToDestination: { distance: 2, unit: 'MI' } }).remainMeters, 3219);
    assert.strictEqual(decodeDestinationInfo({ distanceToDestination: { distance: '12 junk', unit: 'KM' } }), null);
    assert.strictEqual(decodeDestinationInfo({ travelTime: -1, formattedDistance: { rawDistance: Infinity } }), null);
    assert.strictEqual(decodeDestinationInfo({ travelTime: 7 * 86400 }), null);
    assert.strictEqual(decodeDestinationInfo({ arrivalTime: { hour: 24, minute: 0 } }), null);
    const d = decodeDestinationInfo([destination(60, 100, 9, 0), { travelTime: 540 }]);
    assert.deepStrictEqual(d, { hour: null, min: null, remainSec: 540, remainMeters: null });
    assert.strictEqual(decodeDestinationInfo([]), null);
});
test('provided local arrival is not offset twice', () => {
    const sources = { waypoints: { at: 1000, value: decodeDestinationInfo(destination(540, 6200, 0, 38)) } };
    assert.strictEqual(etaSnapshot(sources, wall, 1000, 480).text, '00:38');
    assert.strictEqual(etaSnapshot(sources, wall, 1000, -300).text, '00:38');
    assert.strictEqual(etaParts(etaSnapshot(sources, wall, 1000, 480), {}).tail, ' | 9分钟 | 6.2 km');
});
test('derived arrival uses vehicle timezone, UTC+8 fallback and midnight rollover', () => {
    const sources = { waypoints: { at: 1000, value: decodeDestinationInfo({ travelTime: 600 }) } };
    assert.strictEqual(etaSnapshot(sources, wall, 1000, 480).text, '00:05');
    assert.strictEqual(etaSnapshot(sources, wall, 1000, null).text, '00:05');
    assert.strictEqual(etaSnapshot(sources, wall, 1000, -300).text, '11:05');
    assert.strictEqual(etaSnapshot(sources, wall + 29000, 30000, 480).text, '00:05');
    assert.strictEqual(etaSnapshot(sources, wall + 29000, 30000, 480).remainSec, 571);
    assert.strictEqual(etaSnapshot(sources, wall + 30001, 31001, 480), null);
});
test('destination preference is independent of event delivery order', () => {
    const t = freshTracker();
    t.feedField('guidance', 'finalDestinationInfo', destination(600, 10000, 10, 30), 1100);
    t.feedField('guidance', 'nextDestinationInfo', destination(60, 100, 9, 30), 1200);
    assert.strictEqual(t.snapshot(wall, 1200, 480).eta.text, '10:30');
    t.feedField('guidance', 'finalDestinationInfo', null, 1300);
    assert.strictEqual(t.snapshot(wall, 1300, 480).eta.text, '09:30');
    t.feedField('guidance', 'nextDestinationInfo', null, 1400);
    assert.strictEqual(t.snapshot(wall, 1400, 480).eta, null);
});
test('route cancellation, phone disconnect and provider changes clear arrival immediately', () => {
    for (const change of [
        ['carplay', 'projectedGuidanceActive', false],
        ['carplay', 'available', false],
        ['guidance', 'guidingProvider', 'ANDROID_AUTO'],
    ]) {
        const t = freshTracker();
        t.feedField('phone', 'waypoints', [destination(540, 6200, 0, 38)], 1100);
        assert(t.snapshot(wall, 1100, 480).eta);
        t.feedField(change[0], change[1], change[2], 1200);
        assert.strictEqual(t.snapshot(wall, 1200, 480).eta, null);
    }
});
test('ambiguous simultaneous phone routes and stale metadata yield no cards', () => {
    const t = freshTracker();
    t.feedField('phone', 'waypoints', [destination(540, 6200, 0, 38)], 1100);
    assert.strictEqual(t.snapshot(wall, 31101, 480).eta, null);
    t.feedField('androidauto', 'projectedGuidanceActive', true, 32000);
    t.feedField('phone', 'waypoints', [destination(540, 6200, 0, 38)], 32100);
    assert.strictEqual(t.snapshot(wall, 32200, 480).eta, null);
});
test('cluster cards expire maneuvers while keeping existing HUD fallback independent', () => {
    const t = freshTracker();
    t.dart = { kind: 'turn', dir: 'RIGHT', dist: '696', unit: 'm', road: '芙蓉西路' };
    t.dartAt = 1100;
    assert(t.snapshot(wall, 1101, 480).cardTurn);
    assert.strictEqual(t.snapshot(wall, 7101, 480).cardTurn, null);
});
test('navigation acquisition works with cluster-only cards, releases when disabled', () => {
    const hub = new SignalHub({});
    hub.syncDemand({ enabled: true, displayTarget: 'cluster', clusterTurnCard: true, hudNavMode: 'yield_route' });
    assert.strictEqual(hub._demand.nav, true);
    hub.syncDemand({ enabled: true, displayTarget: 'cluster', clusterEtaPill: true, hudNavMode: 'yield_route' });
    assert.strictEqual(hub._demand.nav, true);
    hub.syncDemand({ enabled: true, displayTarget: 'cluster', clusterTurnCard: false, clusterEtaPill: false });
    assert.strictEqual(hub._demand.nav, false);
    hub.syncDemand({ enabled: false, clusterTurnCard: true, clusterEtaPill: true });
    assert.strictEqual(hub._demand.nav, false);
    hub.stop();
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-nav-card-test-'));
try {
    const painter = new OverlayRenderer({ allowPanel: true, confDir: tmp, wazeStatusPath: path.join(tmp, 'waze.json') });
    const model = {
        units: { distUnit: 'km', speedUnit: 'km/h', tempUnit: 'C' },
        profile: { mode: 'ice', vehicleType: 'ice' }, efficiency: {},
        telemetry: { stage: 'P', hudNav: {
            routeActive: true,
            cardTurn: { kind: 'turn', dir: 'RIGHT', dist: '696', unit: 'm', road: '进入芙蓉西路' },
            eta: { text: '00:38', remainSec: 540, remainMeters: 6200 },
        } },
    };
    const settings = { enabled: true, displayTarget: 'cluster', clusterTurnCard: true, clusterEtaPill: true };
    test('Chinese cards use existing compositor layers, fixed sizes and clear gear window', () => {
        painter.render(model, settings, 1000);
        for (const name of ['guidance_turn_card', 'eta_pill']) {
            const layer = painter.layers[name];
            assert(layer.visible && layer.target === 'panel');
            assert(layer.cv.d.some((v, i) => i % 4 === 3 && v > 0));
            assert(layer.rect.x + layer.rect.w < 1378);
        }
        assert.deepStrictEqual(painter.layers.guidance_turn_card.rect, TURN_RECT);
        assert.deepStrictEqual(painter.layers.eta_pill.rect, ETA_RECT);
    });
    test('distance threshold and independent switches hide just the selected card', () => {
        painter.render(model, Object.assign({}, settings, { turnCardTriggerM: '350' }), 1200);
        assert(!painter.layers.guidance_turn_card.visible && painter.layers.eta_pill.visible);
        painter.render(model, Object.assign({}, settings, { clusterEtaPill: false, turnCardTriggerM: '800' }), 1300);
        assert(painter.layers.guidance_turn_card.visible && !painter.layers.eta_pill.visible);
    });
    test('map-only, HUD-only, disabled app, missing data and ended route hide both layers', () => {
        for (const extra of [{ clusterSlotMode: 'map_only' }, { displayTarget: 'hud' }, { enabled: false }]) {
            painter.render(model, settings, 1400);
            painter.render(model, Object.assign({}, settings, extra), 1500);
            assert(!painter.layers.guidance_turn_card.visible && !painter.layers.eta_pill.visible);
        }
        model.telemetry.hudNav = { routeActive: true };
        painter.render(model, settings, 1600);
        assert(!painter.layers.guidance_turn_card.visible && !painter.layers.eta_pill.visible);
        model.telemetry.hudNav = { routeActive: false, cardTurn: {}, eta: { text: '00:38' } };
        painter.render(model, settings, 1700);
        assert(!painter.layers.guidance_turn_card.visible && !painter.layers.eta_pill.visible);
    });
    painter.close();
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
test('CN labels and optional navigation reads are included without an SDK or new native requirement', () => {
    for (const key of ['clusterTurnCard', 'turnCardTriggerM', 'clusterEtaPill']) {
        const setting = spec.settings.find((s) => s.key === key);
        assert(setting && /[\u3400-\u9fff]/.test(setting.label));
        assert(spec.screens.find((s) => s.name === 'CLUSTER').settings.includes(key));
    }
    for (const name of ['nav_cards.js', 'nav_tracker.js', 'signals.js', 'overlay_renderer.js']) {
        assert.strictEqual(fs.readFileSync(path.join(js, name), 'utf8'),
            fs.readFileSync(path.join(root, 'localized/cluster-metrics/apps/cluster_metrics', name), 'utf8'));
    }
    assert(!fs.existsSync(path.join(js, 'app.js')));
    const source = JSON.parse(fs.readFileSync(path.join(root, 'localized/cluster-metrics/apps/cluster_metrics/app.json')));
    assert(source.signals['de.bmw.infotainment.navigation.guiding.Guidance']._optional);
    assert(source.signals['de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding']._optional);
    assert(fs.readFileSync(path.join(root, 'apps/cluster_metrics/package/NOTICE'), 'utf8').includes('Hyperionism'));
});
(async () => {
    const t = freshTracker();
    const callbacks = {};
    const watched = [];
    const ctx = { signals: {
        watch(iface, instance, handlers, log, opts) {
            watched.push({ iface, handlers, opts });
            return Promise.resolve({ proxy: { iface }, shutdown() {} });
        },
        onAvailable(proxy, fn) { callbacks[proxy.iface] = fn; return Promise.resolve(); },
    } };
    try {
        t.start(ctx, { info() {}, warn() {} }, () => false);
        await Promise.resolve();
        await Promise.resolve();
        const phoneIface = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';
        const watch = watched.find((w) => w.iface === phoneIface);
        assert.strictEqual(watch.opts.pollMs, 3000);
        assert.strictEqual(typeof watch.handlers.waypoints, 'function');
        t.feedField('phone', 'waypoints', [destination(540, 6200, 0, 38)], 1100);
        t.dart = { kind: 'turn', dir: 'RIGHT', dist: '696', unit: 'm' };
        t.dartAt = 1100;
        assert(t.snapshot(wall, 1100, 480).eta);
        callbacks[phoneIface](false);
        assert.strictEqual(t.snapshot(wall, 1200, 480).eta, null);
        assert.strictEqual(t.snapshot(wall, 1200, 480).cardTurn, null);
        const oldCallback = callbacks[phoneIface];
        t.stop();
        t.start(ctx, { info() {}, warn() {} }, () => false);
        await Promise.resolve();
        await Promise.resolve();
        t.feedField('phone', 'waypoints', [destination(540, 6200, 0, 38)], 1300);
        assert(t.snapshot(wall, 1300, 480).eta);
        oldCallback(false);
        assert(t.snapshot(wall, 1300, 480).eta, 'an old watcher cannot clear the new session');
        console.log('PASS optional watcher polling and real availability callback clear arrival');
        passed++;
    } finally {
        t.stop();
    }
    console.log('Cluster navigation cards: ' + passed + ' checks passed (host simulation; no vehicle).');
})().catch((e) => { console.error(e); process.exitCode = 1; });
