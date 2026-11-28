// SPDX-License-Identifier: GPL-3.0-only
// Navigation cards adapted from Hyperionism/idrive7-cockpit-plus, commit
// 0ba2af68b4fe4c4825b2db2f69dab174cc617209 (nav_tracker.js, overlay_renderer.js).
// Cockpit+ builds upon Cluster Metrics by chyiz. Bundled arrow drawing is MIT.
'use strict';

const { drawArrow } = require('./redline_hud_nav');

const DEST_TTL_MS = 30000;
const TURN_RECT = { x: 760, y: 18, w: 400, h: 96 };
const ETA_RECT = { x: 760, y: 628, w: 400, h: 46 };
const UNIT_M = {
    KM: 1000, KILOMETER: 1000, KILOMETRE: 1000, KILOMETERS: 1000,
    METER: 1, METRE: 1, M: 1, METERS: 1,
    MILE_US: 1609.344, MILE_UK: 1609.344, MILE: 1609.344, MILES: 1609.344, MI: 1609.344,
    YARD: 0.9144, YARDS: 0.9144, YD: 0.9144, FEET: 0.3048, FOOT: 0.3048, FT: 0.3048,
};
function numberIn(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && v >= lo && v < hi;
}

// A waypoint is atomic: never combine the arrival of one stop with another
// stop's distance. The final entry in a projected route is its destination.
function decodeDestinationInfo(value) {
    const w = Array.isArray(value) ? value[value.length - 1] : value;
    if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
    const at = w.estimatedArrivalTime || w.arrivalTime;
    const tm = at && (at.time || at);
    const clockValid = tm && at.invalid !== true && tm.invalid !== true &&
        numberIn(tm.hour, 0, 24) && numberIn(tm.minute, 0, 60);
    const time = typeof w.travelTime === 'number' ? w.travelTime : w.timeToDestination;
    const fd = w.formattedDistance || w.distanceToDestination;
    let metres = null;
    if (fd && numberIn(fd.rawDistance, 0, 10000000)) {
        metres = Math.round(fd.rawDistance);
    } else if (fd && fd.distance !== undefined && fd.distance !== null) {
        const raw = String(fd.distance).trim();
        const normalized = /^\d{1,3}([, ]\d{3})+$/.test(raw)
            ? raw.replace(/[, ]/g, '') : raw.replace(',', '.');
        const n = /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
        const mul = UNIT_M[String(fd.unit || '').toUpperCase()];
        if (mul && numberIn(n * mul, 0, 10000000)) metres = Math.round(n * mul);
    }
    const remainSec = numberIn(time, 0, 7 * 86400) ? Math.round(time) : null;
    if (!clockValid && remainSec === null && metres === null) return null;
    return {
        hour: clockValid ? Math.floor(tm.hour) : null,
        min: clockValid ? Math.floor(tm.minute) : null,
        remainSec, remainMeters: metres,
    };
}

function etaSnapshot(sources, wall, mono, offsetMin) {
    // Prefer the final destination to an intermediate stop, regardless of
    // field delivery order. Each optional source expires independently.
    const keys = ['finalDestinationInfo', 'waypoints', 'nextDestinationInfo'];
    let item = null;
    for (let i = 0; i < keys.length; i++) {
        const v = sources[keys[i]];
        if (v && mono >= v.at && mono - v.at <= DEST_TTL_MS) {
            item = v;
            break;
        }
    }
    if (!item) return null;
    const d = item.value;
    const elapsed = Math.max(0, (mono - item.at) / 1000);
    const remainSec = d.remainSec === null ? null : Math.max(0, d.remainSec - elapsed);
    let hour = d.hour;
    let min = d.min;
    if (hour === null && remainSec !== null) {
        // Supplied arrival clocks are already local. Only a derived clock
        // uses the vehicle offset, with UTC+8 as the CN fallback.
        const offset = numberIn(offsetMin, -840, 841) ? offsetMin : 480;
        const dt = new Date(wall + remainSec * 1000 + offset * 60000);
        hour = dt.getUTCHours();
        min = dt.getUTCMinutes();
    }
    const text = hour === null ? '' : ('0' + hour).slice(-2) + ':' + ('0' + min).slice(-2);
    return { text, remainSec, remainMeters: d.remainMeters };
}

function clean(v) {
    return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}
function fit(cv, text, maxW, sizes) {
    const opts = { font: 'bold', literal: true };
    for (let i = 0; i < sizes.length; i++) {
        if (cv.textWidth(text, sizes[i], opts) <= maxW) return { text, size: sizes[i] };
    }
    const cps = Array.from(text);
    const size = sizes[sizes.length - 1];
    while (cps.length && cv.textWidth(cps.join('') + '...', size, opts) > maxW) cps.pop();
    return { text: cps.join('') + '...', size };
}
function drawText(cv, text, x, y, size, color) {
    return cv.text(text, x, y, size, color, { font: 'bold', literal: true });
}
function plate(cv) {
    cv.clear([0, 0, 0, 0]);
    cv.roundRect(2, 2, cv.w - 4, cv.h - 4, 14, [12, 22, 38, 180]);
    cv.strokeRoundRect(2, 2, cv.w - 4, cv.h - 4, 14, 1, [180, 210, 240, 65]);
}
function paintTurn(cv, guide) {
    plate(cv);
    drawArrow(cv, guide, 54, 48, 0.85, [244, 248, 255, 255], [108, 126, 150, 225]);
    const dist = clean(guide.dist);
    const unit = clean(guide.unit);
    const fitted = fit(cv, dist + (unit ? ' ' + unit : ''), cv.w - 122, [34, 30, 26, 22]);
    drawText(cv, fitted.text, 104, 44, fitted.size, '#f2f5fa');
    const fallback = guide.kind === 'destination' ? '\u5230\u8fbe\u76ee\u7684\u5730'
        : (guide.dir === 'STRAIGHT_ON' ? '\u7ee7\u7eed\u76f4\u884c' : '\u524d\u65b9');
    const road = fit(cv, clean(guide.road) || fallback, cv.w - 122, [22, 19, 17, 15]);
    drawText(cv, road.text, 104, 78, road.size, '#dbe7f5');
}
function distanceText(m, units) {
    if (!numberIn(m, 0, 10000000)) return '';
    if (units && units.distUnit === 'mi') return (m / 1609.344).toFixed(1) + ' mi';
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}
function etaParts(eta, units) {
    const prefix = eta.text ? eta.text + ' \u5230\u8fbe' : '';
    const rest = [];
    if (numberIn(eta.remainSec, 0, 7 * 86400)) {
        const mins = Math.ceil(eta.remainSec / 60);
        rest.push(mins >= 60 ? Math.floor(mins / 60) + '\u5c0f\u65f6' +
            (mins % 60 ? mins % 60 + '\u5206' : '') : mins + '\u5206\u949f');
    }
    const distance = distanceText(eta.remainMeters, units);
    if (distance) rest.push(distance);
    return { prefix, tail: (prefix && rest.length ? ' | ' : '') + rest.join(' | ') };
}
function paintEta(cv, eta, units) {
    plate(cv);
    const parts = etaParts(eta, units);
    const fitted = fit(cv, parts.prefix + parts.tail, cv.w - 28, [22, 20, 18, 16]);
    const x = Math.max(14, (cv.w - cv.textWidth(fitted.text, fitted.size, { font: 'bold', literal: true })) / 2);
    const y = cv.h / 2 + fitted.size * 0.35;
    if (parts.prefix && fitted.text.indexOf(parts.prefix) === 0) {
        const width = drawText(cv, parts.prefix, x, y, fitted.size, '#5bc8ff');
        drawText(cv, fitted.text.slice(parts.prefix.length), x + width, y, fitted.size, '#f2f5fa');
    } else {
        drawText(cv, fitted.text, x, y, fitted.size, '#f2f5fa');
    }
}

module.exports = { decodeDestinationInfo, etaSnapshot, etaParts, paintTurn, paintEta, TURN_RECT, ETA_RECT };
