// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n.js');
const { nativeText, decodeText, mapPage } = require('../src/native_text.js');
const { WazeClusterControl } = require('../src/waze_cluster_control.js');
const { LogsControl } = require('../src/logs_control.js');

let checks = 0;
const eq = (a, b) => { checks += 1; assert.deepStrictEqual(a, b); };
i18n.setHmiLanguage('CHINESISCH_SIMPLE');
const cases = [
    ['Stream lost', '视频流中断'],
    ['no packets', '尚未收到数据包'],
    ['64 pkts, 8123 B, len 12-1460, H.264 Annex-B (00 00 00 01 start code), SPS=1 IDR=2',
        '64 个数据包，8123 字节，包长 12 至 1460 字节，H.264 Annex-B (00 00 00 01 start code), SPS=1 IDR=2'],
    ['10 pkts, 1200 B, len 12-240, likely RTP (v2); payload type 96',
        '10 个数据包，1200 字节，包长 12 至 240 字节，likely RTP (v2); payload type 96'],
    ['1 pkts, 12 B, len 12-12, unknown — read the leading bytes',
        '1 个数据包，12 字节，包长 12 至 12 字节，unknown — read the leading bytes'],
    ["Waiting for the phone's map", '等待手机输出地图'],
    ['cluster renderer not reachable', '无法连接仪表盘渲染器'],
    ['the stock map holds the slot', '原厂地图正在占用显示区域'],
    ['another app holds the slot', '其他应用正在占用显示区域'],
    ['under an alert on the cluster', '仪表盘警告正在遮挡地图'],
    ['saving the choice failed: EROFS', '保存设置失败：EROFS'],
    ['not supported on this car (head unit: MGU-21)', '本车不支持（head unit: MGU-21）'],
    ['density must be 120-240 in steps of 10', '显示密度须在 120 至 240 之间，步长为 10'],
    ['30 updates/s', '30 次更新/秒'],
    ['unrecognized decoder status 0x24', '原始详情：unrecognized decoder status 0x24']
];
cases.forEach(([raw, shown]) => eq(nativeText(raw), shown));
eq(decodeText('5.2 MB, 1234 frames'), '5.2 MB，1234 帧');
eq(decodeText('waiting for CarPlay (0 B)'), '等待 CarPlay（0 B）');
eq(decodeText('receiving, not decoding (12 KB) — no SPS'), '已接收但尚未解码（12 KB）— 原始详情：no SPS');
eq(decodeText('receiving, not decoding (12 KB) — 10 pkts, 1200 B, len 12-240, likely RTP (v2); payload type 96'),
    '已接收但尚未解码（12 KB）— 10 个数据包，1200 字节，包长 12 至 240 字节，likely RTP (v2); payload type 96');
eq(decodeText('5.2 MB, 1234 frames [2 decode err, last: EAGAIN]'),
    '5.2 MB，1234 帧（2 次解码错误，最近一次：原始详情：EAGAIN）');
eq(mapPage('Waze map — 30 frames/s (5.2 MB, 1234 frames, upload cap 200 KB/s)'),
    '导航地图 — 30 帧/秒（5.2 MB，1234 帧，上传上限 200 KB/秒）');

const control = new WazeClusterControl({});
control.patch.link = 'up';
control.render.link = 'up';
control._inEffect.carplay = true;
const raw = { ev: 'status', state: 'showing', cluster: 1, hud: 1, hud_state: 'showing',
    page: 'Waze map — 10 frames/s (25.0 MB, 51229 frames)', reason: 'Stream lost' };
const before = JSON.stringify(raw);
control.renderStatus = raw;
eq(control.mapText(), '仪表盘地图：正在显示 导航地图 — 10 帧/秒（25.0 MB，51229 帧） — 视频流中断');
eq(JSON.stringify(raw), before);
control.renderStatus = Object.assign({}, raw, { state: 'starting', reason: 'the stock map holds the slot',
    hud_x: 20, hud_y: -10 });
eq(control.mapText(), '仪表盘地图：启动中…：原厂地图正在占用显示区域');
eq(control.hudPositionText(), '位置：向右 20 像素，向上 10 像素');
control.patchStatus = { state: 'error', reason: 'remount rw: EBUSY' };
eq(control.statusText(), '状态：失败：切换文件系统为可写失败：EBUSY');
control.patchStatus = { state: 'patched', aa: { state: 'error', reason: 'new firmware diagnostic: 0x10' } };
eq(control.aaStatusText(), '状态：失败：原始详情：new firmware diagnostic: 0x10');
control.captureState = { state: 'error', error: 'disk descriptor lost' };
eq(control.captureText(), '采集：失败：原始详情：disk descriptor lost');
const logs = new LogsControl({});
logs.state = { error: 'no-space' };
eq(logs.statusText(), '已保存的日志：空间不足');
logs.state = { error: 'archive write failed: EIO' };
eq(logs.statusText(), '已保存的日志：保存失败：原始详情：archive write failed: EIO');

i18n.setHmiLanguage('KANTONESISCH_SIMPLE');
eq(nativeText('Stream lost'), '视频流中断');
for (const locale of ['zh_CN', 'zh_yue_Hans_CN']) {
    const words = JSON.parse(fs.readFileSync(path.join(__dirname,
        '../package/rhmiData/variantGroups/Common/texts', `${locale}.json`)));
    eq(words.SID_WOC_LOGS, '日志');
    eq(words.SID_WOC_TITLE, 'Waze 仪表盘显示');
}
i18n.setHmiLanguage('ENGLISCH__US');
cases.forEach(([raw]) => eq(nativeText(raw), raw));
eq(mapPage(raw.page), raw.page);
eq(control.captureText(), 'Capture: Failed');
i18n.setHmiLanguage('DEUTSCH');
eq(nativeText('Stream lost'), 'Stream lost');
i18n.setHmiLanguage('SIGNAL_UNGUELTIG');
eq(i18n.language(), 'zh-CN');
console.log(`native status localization: ${checks} checks pass`);
