'use strict';
// Exercise the shipped renderer, source package contract and Recorder's parked playback policy offline.
const assert = require('assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const ids = process.argv[2] ? [path.basename(process.argv[2])] : ['iteriodev_turnview', 'oap-driverecorder-next'];
let screens = 0, glyphs = 0;
for (const id of ids) {
    const app = path.join(root, 'apps', id), pkg = path.join(app, 'package');
    const words = require(path.join(pkg, 'renderer/kit/translations.zh-CN.json'));
    const text = require(path.join(pkg, 'renderer/kit/cn_text'));
    const fonts = require(path.join(pkg, 'renderer/kit/fonts'));
    const f = fonts.get('label', 36, '中文');
    for (const c of Object.values(words).join('')) if (/[\u3000-\u9fff\uff00-\uffef]/.test(c)) {
        assert(f.glyphs[c.codePointAt(0)], `Missing glyph ${c}`); glyphs++;
    }
    assert.strictEqual(text('Save clip in 12 s'), '12 秒后可保存');
    assert.strictEqual(text('2 clips · 10 MB of 4 GB · newest first'), '2 段视频 · 10 MB / 4 GB · 最新在前');
    assert.strictEqual(text('de.bmw.infotainment.vehicle.Vehicle2'), 'de.bmw.infotainment.vehicle.Vehicle2');
    assert.strictEqual(text('Developed by IterioDev'), 'Developed by IterioDev');
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'manifest.json')));
    assert(!manifest.proxies['de.bmw.infotainment.hmi.hmicontext2.HMIContext2']);
    const { Recorder, atlasById } = require(path.join(pkg, 'renderer/kit/record'));
    const rec = new Recorder(1920,720); rec.text('Save clip in 12 s',0,50,32,'#ffffff');
    assert(rec.words().length > 4); assert(rec.atlases.size > 0);
    for (const a of rec.atlases) assert(atlasById(a).atlasH <= 512, 'supplemental atlas fits shared GPU gaps');
    const gpu = require(path.join(pkg, 'renderer/gpu'));
    const design = require(path.join(pkg, 'renderer/screens.json'));
    for (const st of design.screens) {
        if (st.kind !== 'gpu') continue;
        for (const variant of [st, st.id7 ? Object.assign({},st,{components:st.id7.components}) : st]) {
            const drawing = gpu.record(variant,{view:'id7'});
            assert.deepStrictEqual(drawing.errors || [],[], id+':'+st.name);
            assert(drawing.words().length > 4);screens++;
        }
    }
    assert(fs.readFileSync(path.join(pkg,'renderer/screenapp.js'),'utf8').includes("gpu.on('ready'"));
    assert(fs.readFileSync(path.join(pkg,'renderer/kit/renderd.js'),'utf8').includes('/run/mgu-render/render.sock'));
    assert(!fs.existsSync(path.join(pkg,'renderer/kit/fonts/icon.json')));
    for (const name of ['label','num','bold','gear','light','cjk']) {
        const data = JSON.parse(fs.readFileSync(path.join(pkg,'renderer/kit/fonts',name+'.json')));
        assert(!/BMW|HMI/.test(data.source));
    }
    const provenance = require(path.join(pkg,'PROVENANCE.json'));
    assert.strictEqual(provenance.authorization.date,'2026-11-23');
    assert.strictEqual(provenance.runtimeValidation,'pending; no car connected or changed');
    if (id === 'oap-driverecorder-next') {
        const { Ui } = require(path.join(app,'src/ui'));
        const ui = new Ui({now:()=>10000});ui.setTool(true,'1.2.7');
        const c = {id:'20261123_100000',secs:30,bytes:1234,cams:0};ui.setClips([c],1234,false);
        assert(!ui.parked()); ui.open(c.id,'clips');assert(!ui.take().some(x=>x.do==='play'));
        ui.setSpeed(0,10000);ui.open(c.id,'clips');assert(ui.take().some(x=>x.do==='play'));
        ui.setShown('viewer');ui.setPlayer({clip:c.id,state:'playing',pos:0,dur:30});ui.setSpeed(20,10000);ui.tick();
        assert(ui.take().some(x=>x.do==='pause'),'moving pauses playback');
        ui.setSpeed(0,0);assert(!ui.parked(),'stale speed does not allow playback');
        for (const page of ['record','clips','settings','viewer','export','confirm','diag']) assert(ui.values(page));
    }
}
for (const id of ['iteriodev-turnview','iteriodev-drplay']) {
    const dir=path.join(root,'native',id),prov=require(path.join(dir,'PROVENANCE.json'));
    for (const [file,sha] of Object.entries(prov.binarySha256)) assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,file))).digest('hex'),sha);
}
const card=require('../native/iteriodev-turnview/card');
for (const notice of Object.keys(card.NOTICES)) assert.strictEqual(card.notice(notice).rgba.length,640*120*4);
console.log(`Iterio: ${screens} screen variants, ${glyphs} Chinese glyph checks; source-drawn icons, renderer reconnect and parked playback passed`);
