'use strict';

// The CN trip page uses Beijing civil time, independently of the head unit's TZ.
// Stored timestamps and elapsed durations remain Unix milliseconds.
const OFFSET_MS = 8 * 60 * 60 * 1000;
const pad = (value) => (value < 10 ? '0' : '') + value;
const date = (timestamp) => new Date(timestamp + OFFSET_MS);
const clock = (timestamp) => {
    const d = date(timestamp);
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
};
const day = (timestamp) => {
    const d = date(timestamp);
    return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
};
const year = (timestamp) => date(timestamp).getUTCFullYear();

module.exports = { clock, day, year };
