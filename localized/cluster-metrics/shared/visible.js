'use strict';
/**
 * visible.js - G30 530e calibrated 1920x720 KOMBI4 and 800x480 HUD keep-out geometry.
 * Measurements calibrated from local car photographs and test patterns.
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no dependencies.
 */

const HOOD = [
    [0, 273], [100, 138], [200, 85], [300, 57], [400, 36], [500, 21], [600, 18], [700, 12], [800, 3], [900, 2],
    [1000, 1], [1100, 2], [1200, 5], [1300, 10], [1400, 19], [1500, 37], [1600, 67], [1700, 84], [1800, 128], [1900, 196],
    [1920, 240],
];

const LANE_CENTERING = [108, 120, 190, 220];
const BRAKE_ABS_DSC = [10, 220, 195, 405];
const AUTO_HOLD_PARK = [1748, 144, 1916, 265];
const EDRIVE_HOLE = AUTO_HOLD_PARK;
const STEERING_FAULT = [1810, 260, 1910, 340];
const MIDDLE_RIGHT_ICONS = [1805, 340, 1920, 425];

const SPEED_NEEDLE_FAN = [180, 120, 386, 636];
const MAIN_SPEED_DIGITS = [420, 340, 620, 428];
const TRAFFIC_LIGHT_SIGN = [495, 536, 580, 672];

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
// KOMBI4 hardware gear window on G30 spans x=1380..1460, y=656..720 even in single-letter 'D'.
// Any pixel overlapping 1380..1460 is both clipped invisible AND latches BMW's safety BLACK_BOX (1406..1597, 342..419).
const GEAR_WIN = [1380, 656, 1460, 720];
const DRIVE_MODE_STOCK_D = [1230, 652, 1460, 714];
const STOCK_D_INDICATOR = GEAR_WIN;
const AMBIENT_TEMP = [1540, 652, 1668, 712];
const SOC_GAUGE_LOWER_RIGHT = [1782, 415, 1916, 642];
const EV_RANGE = [1680, 650, 1814, 714];

const HUD_WINDOW = { x: 120, y: 100, w: 560, h: 280 };
const HUD_ACC_ASSIST = [120, 202, 395, 308];
const HUD_BMW = [120, 202, 395, 380];
const HUD_STOCK_SPEED = [135, 308, 395, 378];
const HUD_STOCK_NAV = [405, 115, 680, 378];

const PANEL_KEEPOUTS = [
    ['BMW BLACK_BOX', BLACK_BOX],
    ['BMW GEAR_WIN (triggers BLACK_BOX & clips gear)', GEAR_WIN],
    ['BMW BELT', BELT],
    ['BMW REAR_BELTS_AIRBAG', REAR_BELTS_AIRBAG],
    ['BMW LANE_CENTERING', LANE_CENTERING],
    ['BMW BRAKE_ABS_DSC', BRAKE_ABS_DSC],
    ['BMW AUTO_HOLD_PARK', AUTO_HOLD_PARK],
    ['BMW STEERING_FAULT', STEERING_FAULT],
    ['BMW MIDDLE_RIGHT_ICONS', MIDDLE_RIGHT_ICONS],
    ['BMW SPEED_NEEDLE_FAN', SPEED_NEEDLE_FAN],
    ['BMW TRAFFIC_LIGHT_SIGN', TRAFFIC_LIGHT_SIGN],
    ['BMW MEDIA_WIDGET', MEDIA_WIDGET],
    ['BMW MASTER_WARN_TRIANGLE', MASTER_WARN_TRIANGLE],
];

function hoodY(x) {
    for (let i = 0; i < HOOD.length - 1; i++) {
        const p0 = HOOD[i], p1 = HOOD[i + 1];
        if (x <= p0[0]) return p0[1];
        if (x <= p1[0]) {
            const frac = (x - p0[0]) / (p1[0] - p0[0]);
            return p0[1] + (p1[1] - p0[1]) * frac;
        }
    }
    return HOOD[HOOD.length - 1][1];
}

function overlaps(rect, zone) {
    return rect.x < zone[2] && rect.x + rect.w > zone[0] && rect.y < zone[3] && rect.y + rect.h > zone[1];
}

function checkPanelRect(rect, id, issues) {
    let maxClip = 0;
    let clipMsg = '';
    for (let s = 0; s <= 4; s++) {
        const sx = rect.x + (rect.w * s) / 4;
        const depth = Math.ceil(hoodY(sx) - rect.y);
        if (depth > maxClip) {
            maxClip = depth;
            clipMsg = s === 0 ? 'left corner' : (s === 4 ? 'right corner' : 'x=' + Math.round(sx));
        }
    }
    if (maxClip > 0) issues.push(id + ': hood overlap ' + maxClip + ' px at ' + clipMsg);
    for (let i = 0; i < PANEL_KEEPOUTS.length; i++) {
        if (overlaps(rect, PANEL_KEEPOUTS[i][1])) {
            issues.push(id + ': overlaps ' + PANEL_KEEPOUTS[i][0]);
        }
    }
}

function checkHudRect(rect, id, issues) {
    const hw = HUD_WINDOW;
    const spill = Math.max(hw.x - rect.x, hw.y - rect.y, (rect.x + rect.w) - (hw.x + hw.w), (rect.y + rect.h) - (hw.y + hw.h));
    if (spill > 0) issues.push(id + ': ' + Math.ceil(spill) + ' px outside HUD_WINDOW');
    if (overlaps(rect, HUD_BMW)) issues.push(id + ': overlaps BMW HUD_BMW / ACC_ASSIST');
    if (overlaps(rect, HUD_STOCK_NAV)) issues.push(id + ': overlaps BMW HUD_STOCK_NAV');
}

function check(layers, target) {
    const issues = [];
    if (!Array.isArray(layers)) return issues;
    for (let i = 0; i < layers.length; i++) {
        const l = layers[i];
        if (!l || typeof l.x !== 'number' || typeof l.y !== 'number' || typeof l.w !== 'number' || typeof l.h !== 'number') continue;
        const id = String(l.id);
        if (target === 'panel') checkPanelRect(l, id, issues);
        else if (target === 'hud') checkHudRect(l, id, issues);
    }
    return issues;
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
