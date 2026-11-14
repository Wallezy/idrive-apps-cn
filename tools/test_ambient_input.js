'use strict';
// Real Display touch dispatch and rendered frame changes, without a vehicle or lighting writes.
const assert = require('assert');
const path = require('path');
const kit = path.join(__dirname, '../apps/ambient_config/package/javascript/kit');
const { Display } = require(path.join(kit, 'display'));
const { Recorder } = require(path.join(kit, 'record'));
const G = require(path.join(kit, 'gauges'));
const { theme } = require(path.join(kit, 'themes'));
const { CREDIT, drawCredit } = require(path.join(kit, 'credits'));

(async () => {
    const frames = [], taps = [], settings = { get: () => 'full' };
    let buttonCalls = 0;
    const d = Object.create(Display.prototype);
    Object.assign(d, {
        spec: { title: 'Ambient config' }, screen: { name: 'MAIN', title: 'Ambient config', buttons: [], bar: false },
        settings, theme: () => theme('m_tricolour'), blocked: false, labels: {}, ownHidden: new Set(),
        place: { full: true, x: 0, y: 0, scale: 1, ox: 0, oy: 80, w: 1920, h: 720 },
        gpu: { ready: true, native: true, touch: true, screen: { w: 1920, h: 720 },
            grab() {}, frame(r) { frames.push(Array.from(r.words())); } },
        ui: { isVisible: (name) => name === 'MAIN', hasFocus: () => true },
        log: { info() {}, warn(e) { throw Error(e); }, error(e) { throw Error(e); } },
        onTap: (x, y) => { taps.push([x, y]); },
        tabs: [], pageTargets: [], barOff: 0, frames: 0, jsMs: 0, statT: Date.now(),
    });
    const r = new Recorder(1600, 520);
    r.own = true;
    r.clear('#000000');
    G.button(r, d.theme(), 1150, 270, 268, 48, 'Save favourite', () => { buttonCalls++; }, { key: 'save' });
    d.pageTargets = r.targets;
    d.app = { name: 'MAIN_GFX', w: r.w, h: r.h, words: new Uint32Array(r.words()),
        atlases: r.atlases, ramps: r.ramps, layersUsed: new Set(), tabs: { tabs: ['Colour'], sel: 0, badges: [] } };
    try {
        d._repaint();
        const idle = frames[frames.length - 1];
        // mgu-render's guard counts four downs whose frame remains unchanged.
        // Every ignored preview tap must produce feedback, even at the same coordinates.
        for (let i = 0; i < 8; i++) {
            const count = frames.length;
            d._touch(1, 900, 240);
            assert(frames.length > count, 'preview down produces a frame');
            assert.notDeepStrictEqual(frames[frames.length - 1], idle, 'preview input changes the actual frame words');
            d._touch(3, 900, 240);
            await Promise.resolve(); await Promise.resolve();
            assert.deepStrictEqual(frames[frames.length - 1], idle, 'release removes touch feedback');
        }
        assert.strictEqual(taps.length, 8, 'preview taps still reach the app');
        assert.strictEqual(buttonCalls, 0, 'preview taps do not trigger a lighting/action button');
        d._touch(1, 1200, 290); d._touch(3, 1200, 290);
        assert.strictEqual(buttonCalls, 1, 'existing button runs exactly once');
        assert.strictEqual(taps.length, 8, 'button tap is not also a free-page tap');
        d._touch(1, 900, 240);
        await new Promise((resolve) => setTimeout(resolve, 380));
        assert.strictEqual(d.pageTouch, null, 'lost touch-up cannot leave feedback on screen');
        const count = frames.length;
        d.blocked = true;
        d._touch(1, 900, 240); d._touch(3, 900, 240);
        await Promise.resolve(); await Promise.resolve();
        assert.strictEqual(frames.length, count, 'does not draw over an HMI popup');
        assert.strictEqual(taps.length, 8, 'does not claim input while the HMI owns it');
        assert.strictEqual(CREDIT, '', 'no corner watermark in the shipped locale');
        drawCredit({ text() { throw Error('corner watermark was drawn'); } }, 1580, 25);
        console.log('Ambient input: repeated preview taps, button dispatch, feedback expiry, HMI ownership and watermark passed');
    } finally {
        clearInterval(d.keepTimer);
        clearTimeout(d.pageTouchTimer);
    }
})().catch((e) => { console.error(e.stack); process.exitCode = 1; });
