'use strict';
/**
 * tests.js - the runs True Time times: the standard ones for each unit system and the driver's own
 * speed ranges (Settings page). Speeds are km/h inside the app, distances metres.
 *
 *   test = { key, label, kind: 'speed' | 'dist' | 'brake', from, to (km/h) | dist (m) }
 *     speed  from -> to, from < to (from 0: a standing start, with the rollout when it's on)
 *     dist   a standing start over dist metres (with the rollout when it's on)
 *     brake  from -> to, from > to (to 0: to a standstill)
 *
 *   accelTests(system, customs)   the Acceleration page's tests
 *   brakeTests(system, customs)   the Braking page's tests
 *   recordKey(test, rollout)      what a record is kept under (a standing start's own key per rollout)
 *
 * Node 8: plain ES2017.
 */
const MPH = 1.609344;
const FT = 0.3048;
const MILE = 1609.344;

const kmh = (from, to) => ({ key: 'kmh:' + from + '-' + to, label: from + '-' + to + ' km/h', from, to });
const mph = (from, to) => ({ key: 'mph:' + from + '-' + to, label: from + '-' + to + ' mph', from: from * MPH, to: to * MPH });

const SPEED = {
    metric: [[0, 50], [0, 100], [0, 150], [0, 200], [0, 250], [40, 100], [60, 100], [70, 120], [80, 120], [60, 160], [100, 150], [100, 200], [200, 300]]
        .map((r) => Object.assign(kmh(r[0], r[1]), { kind: 'speed' })),
    imperial: [[0, 30], [0, 60], [0, 100], [0, 130], [30, 70], [50, 70], [40, 80], [60, 100], [60, 130], [100, 150]]
        .map((r) => Object.assign(mph(r[0], r[1]), { kind: 'speed' })),
};
const DIST = {
    metric: [['200 m', 200], ['400 m', 400], ['1000 m', 1000]],
    // the drag strip's timeslip (60 ft, 330 ft, 1/8, 1000 ft, 1/4) and the half mile
    imperial: [['60 ft', 60 * FT], ['330 ft', 330 * FT], ['1/8 mile', MILE / 8], ['1000 ft', 1000 * FT], ['1/4 mile', MILE / 4], ['1/2 mile', MILE / 2]],
};
const BRAKE = {
    metric: [[100, 0], [200, 0]].map((r) => Object.assign(kmh(r[0], r[1]), { kind: 'brake' })),
    imperial: [[60, 0], [100, 0]].map((r) => Object.assign(mph(r[0], r[1]), { kind: 'brake' })),
};

/** A custom range { from, to, unit: 'kmh' | 'mph' } as a test, or null when it isn't one. */
function customTest(c, i) {
    if (!c || !(c.from >= 0) || !(c.to >= 0) || c.from === c.to) return null;
    const f = c.unit === 'mph' ? MPH : 1, u = c.unit === 'mph' ? 'mph' : 'km/h';
    return {
        key: 'custom:' + (c.unit === 'mph' ? 'mph' : 'kmh') + ':' + c.from + '-' + c.to,
        label: c.from + '-' + c.to + ' ' + u,
        kind: c.from < c.to ? 'speed' : 'brake',
        from: c.from * f, to: c.to * f, custom: i + 1,
    };
}

/** Standard tests first, then the custom ones not already among them. */
function merge(list, customs, kind) {
    const out = list.slice();
    (customs || []).forEach((c, i) => {
        const t = customTest(c, i);
        if (!t || t.kind !== kind) return;
        if (out.some((x) => x.kind === kind && Math.abs(x.from - t.from) < 0.01 && Math.abs(x.to - t.to) < 0.01)) return;
        out.push(t);
    });
    return out;
}

function accelTests(system, customs) {
    const s = system === 'imperial' ? 'imperial' : 'metric';
    const dist = DIST[s].map((d) => ({ key: 'dist:' + d[1].toFixed(3), label: d[0], kind: 'dist', dist: d[1] }));
    return merge(SPEED[s], customs, 'speed').concat(dist);
}

function brakeTests(system, customs) {
    const s = system === 'imperial' ? 'imperial' : 'metric';
    return merge(BRAKE[s], customs, 'brake');
}

/** A standing start (0-X, distances) is timed with or without the rollout: each keeps its own record. */
const standing = (t) => t.kind === 'dist' || (t.kind === 'speed' && t.from === 0);
const recordKey = (t, rollout) => t.key + (standing(t) && rollout ? '@ro' : '');

module.exports = { accelTests, brakeTests, customTest, recordKey, standing, MPH, FT, MILE };
