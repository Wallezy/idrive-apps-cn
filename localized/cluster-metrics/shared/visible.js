'use strict';
/**
 * visible.js - hardware-calibrated 1920x720 KOMBI4 and 800x480 HUD keep-out geometry
 * verified directly against real G30 530e Live Cockpit Professional photographs.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const HOOD = [
    [0, 273], [100, 138], [200, 85], [300, 57], [400, 36], [500, 21], [600, 18], [700, 12], [800, 3], [900, 2],
    [1000, 1], [1100, 2], [1200, 5], [1300, 10], [1400, 19], [1500, 37], [1600, 67], [1700, 84], [1800, 128], [1900, 196],
    [1920, 240],
];

// BMW solid overlays, telltales, gauges, and content keep-out rectangles: [x0, y0, x1, y1]
const LANE_CENTERING = [108, 120, 190, 220];
const BRAKE_ABS_DSC = [10, 220, 195, 405];
const AUTO_HOLD_PARK = [1748, 144, 1916, 265];
const EDRIVE_HOLE = AUTO_HOLD_PARK;
const STEERING_FAULT = [1765, 265, 1905, 365];
const MIDDLE_RIGHT_ICONS = [1680, 365, 1920, 445];

const SPEED_NEEDLE_FAN = [180, 120, 386, 636];
const MAIN_SPEED_DIGITS = [420, 340, 620, 428];
const TRAFFIC_LIGHT_SIGN = [495, 514, 580, 672];

const CENTER_MAP = [660, 120, 1200, 585];
const MEDIA_WIDGET = [1180, 170, 1685, 582];
const BLACK_BOX = [1406, 342, 1597, 419];

const MASTER_WARN_TRIANGLE = [1228, 586, 1274, 634];
const POWER_PCT_LABEL = [1462, 604, 1578, 627];
const BOTTOM_BRACKET_LINE = [1210, 640, 1605, 648];

const FUEL_GAUGE_LOWER_LEFT = [6, 418, 210, 642];
const FUEL_RANGE_CLOCK = [126, 650, 480, 716];
const BELT = [587, 663, 626, 700];
const REAR_BELTS_AIRBAG = [505, 648, 760, 716];
// Real-car KOMBI4 PRNDL window (x: 1380..1460, y: 656..720): BMW draws an opaque mask here
// AND triggers BLACK_BOX (x: 1406..1597, y: 342..419) if any layer overlaps 1380..1460!
const GEAR_WIN = [1380, 656, 1460, 720];
const DRIVE_MODE_STOCK_D = [1230, 652, 1460, 714];
const STOCK_D_INDICATOR = GEAR_WIN;
const AMBIENT_TEMP = [1540, 652, 1668, 712];
const SOC_GAUGE_LOWER_RIGHT = [1695, 405, 1916, 642];
const EV_RANGE = [1680, 650, 1814, 714];

// HUD visible windshield aperture + stock BMW areas (including Assisted Driving / ACC set-speed & car y=202..308)
const HUD_WINDOW = { x: 120, y: 100, w: 560, h: 280 };
const HUD_ACC_ASSIST = [120, 202, 395, 308];
const HUD_BMW = [120, 202, 395, 380];
const HUD_STOCK_SPEED = [135, 308, 395, 378];
const HUD_STOCK_NAV = [405, 115, 680, 378];

function hoodY(x) {
    if (x <= HOOD[0][0]) return HOOD[0][1];
    const last = HOOD[HOOD.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < HOOD.length; i++) {
        const a = HOOD[i - 1], b = HOOD[i];
        if (x <= b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
    }
    return last[1];
}

function overlaps(w, box) {
    return w.x < box[2] && w.x + w.w > box[0] && w.y < box[3] && w.y + w.h > box[1];
}

function check(widgets, target) {
    const out = [];
    if (!Array.isArray(widgets)) return out;
    widgets.forEach((w) => {
        if (!w || typeof w.x !== 'number' || typeof w.y !== 'number' || typeof w.w !== 'number' || typeof w.h !== 'number') return;
        const id = String(w.id);
        if (target === 'panel') {
            const under = [];
            const tryX = (x, what) => {
                const d = Math.ceil(hoodY(x) - w.y);
                if (d > 0) under.push({ d, what });
            };
            tryX(w.x, 'top-left corner');
            tryX(w.x + w.w, 'top-right corner');
            const steps = 4;
            for (let i = 1; i < steps; i++) tryX(w.x + w.w * i / steps, 'top edge at x ' + Math.round(w.x + w.w * i / steps));
            if (under.length) {
                const worst = under.reduce((a, b) => (b.d > a.d ? b : a));
                out.push(id + ': ' + worst.what + ' ' + worst.d + ' px under the hood');
            }
            if (overlaps(w, BLACK_BOX)) out.push(id + ': overlaps BMW BLACK_BOX');
            if (overlaps(w, GEAR_WIN)) out.push(id + ': overlaps BMW GEAR_WIN (triggers BLACK_BOX & clips gear)');
            if (overlaps(w, BELT)) out.push(id + ': overlaps BMW BELT');
            if (overlaps(w, REAR_BELTS_AIRBAG)) out.push(id + ': overlaps BMW REAR_BELTS_AIRBAG');
            if (overlaps(w, LANE_CENTERING)) out.push(id + ': overlaps BMW LANE_CENTERING');
            if (overlaps(w, BRAKE_ABS_DSC)) out.push(id + ': overlaps BMW BRAKE_ABS_DSC');
            if (overlaps(w, AUTO_HOLD_PARK)) out.push(id + ': overlaps BMW AUTO_HOLD_PARK');
            if (overlaps(w, STEERING_FAULT)) out.push(id + ': overlaps BMW STEERING_FAULT');
            if (overlaps(w, MIDDLE_RIGHT_ICONS)) out.push(id + ': overlaps BMW MIDDLE_RIGHT_ICONS');
            if (overlaps(w, SPEED_NEEDLE_FAN)) out.push(id + ': overlaps BMW SPEED_NEEDLE_FAN');
            if (overlaps(w, TRAFFIC_LIGHT_SIGN)) out.push(id + ': overlaps BMW TRAFFIC_LIGHT_SIGN');
            if (overlaps(w, MEDIA_WIDGET)) out.push(id + ': overlaps BMW MEDIA_WIDGET');
            if (overlaps(w, MASTER_WARN_TRIANGLE)) out.push(id + ': overlaps BMW MASTER_WARN_TRIANGLE');
        } else if (target === 'hud') {
            const win = HUD_WINDOW;
            const d = Math.max(
                win.x - w.x, win.y - w.y,
                (w.x + w.w) - (win.x + win.w), (w.y + w.h) - (win.y + win.h));
            if (d > 0) out.push(id + ': ' + Math.ceil(d) + ' px outside HUD_WINDOW');
            if (overlaps(w, HUD_BMW)) out.push(id + ': overlaps BMW HUD_BMW / ACC_ASSIST');
            if (overlaps(w, HUD_STOCK_NAV)) out.push(id + ': overlaps BMW HUD_STOCK_NAV');
        }
    });
    return out;
}

module.exports = {
    HOOD,
    LANE_CENTERING, BRAKE_ABS_DSC, AUTO_HOLD_PARK, EDRIVE_HOLE, STEERING_FAULT, MIDDLE_RIGHT_ICONS,
    SPEED_NEEDLE_FAN, MAIN_SPEED_DIGITS, TRAFFIC_LIGHT_SIGN,
    CENTER_MAP, MEDIA_WIDGET, BLACK_BOX,
    MASTER_WARN_TRIANGLE, POWER_PCT_LABEL, BOTTOM_BRACKET_LINE,
    FUEL_GAUGE_LOWER_LEFT, FUEL_RANGE_CLOCK, BELT, REAR_BELTS_AIRBAG,
    DRIVE_MODE_STOCK_D, GEAR_WIN, STOCK_D_INDICATOR, AMBIENT_TEMP, SOC_GAUGE_LOWER_RIGHT, EV_RANGE,
    HUD_WINDOW, HUD_ACC_ASSIST, HUD_BMW, HUD_STOCK_SPEED, HUD_STOCK_NAV,
    hoodY, overlaps, check,
};
