'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const source = path.resolve(__dirname, '../localized/cauliflower/apps/live_data/trip-time.js');
const shipped = path.resolve(__dirname, '../apps/live_data/package/javascript/trip-time.js');
for (const modulePath of [source, shipped]) {
    const script = `
        const assert = require('assert'), time = require(${JSON.stringify(modulePath)});
        const stamp = Date.parse('2026-11-25T23:39:00Z');
        assert.strictEqual(time.clock(stamp), '07:39');
        assert.strictEqual(time.day(stamp), '11月26日');
        const yearEnd = Date.parse('2026-12-31T16:00:00Z');
        assert.strictEqual(time.clock(yearEnd), '00:00');
        assert.strictEqual(time.day(yearEnd), '1月1日');
        assert.strictEqual(time.year(yearEnd), 2027);
        const leap = Date.parse('2028-02-28T16:01:00Z');
        assert.strictEqual(time.day(leap), '2月29日');
        assert.strictEqual(Date.parse('2026-11-26T00:34:00Z') - stamp, 55 * 60000);
        process.stdout.write(JSON.stringify([time.clock(stamp), time.day(stamp), stamp]));
    `;
    const outputs = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Europe/Berlin'].map((TZ) =>
        execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ }), encoding: 'utf8' }));
    outputs.forEach((output) => assert.strictEqual(output, outputs[0]));
}
console.log('Live Data: Beijing time, date/year rollover, leap day and TZ-independent stored timestamps passed');
