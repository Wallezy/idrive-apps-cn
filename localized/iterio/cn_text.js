'use strict';
// Display text only: protocol values, camera requests and recording paths keep their names.
const words = require('./translations.zh-CN.json');
const keys = Object.keys(words).filter(k => k.length > 2).sort((a,b) => b.length-a.length);
function text(value) {
    let s = String(value == null ? '' : value);
    if (Object.prototype.hasOwnProperty.call(words, s)) return words[s];
    if (/^(Turn View|Drive Recorder|Developed by|©|Copyright)/i.test(s)) return s;
    const rules = [
        [/^(\d+) of the (\d+) s before the tap recorded$/, '$2 秒预录已缓存 $1 秒'],
        [/^Save clip in (\d+) s$/, '$1 秒后可保存'],
        [/^Save clip · (\d+) s before$/, '保存片段 · 前 $1 秒'],
        [/^Recording the next (\d+) s, then writing the clip\.?$/, '继续录制 $1 秒后保存片段'],
        [/^(\d+) clips? · (.+) of 4 GB · newest first$/, '$1 段视频 · $2 / 4 GB · 最新在前'],
        [/^No clips · (.+) of 4 GB$/, '暂无视频 · $1 / 4 GB'],
        [/^([\d.]+ (?:MB|GB)) of 4 GB$/, '$1 / 4 GB'],
        [/^Copying (\d+) %$/, '正在复制 $1 %'],
        [/^Preparing (front|rear|left|right) camera…(.*)$/, '正在处理 $1 摄像头…$2'],
        [/^Copying to (.+)… (\d+) %$/, '正在复制到 $1… $2 %'],
        [/^(\d+) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(.*)$/, (m,d,mon,tail) => (['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(mon)+1)+'月'+d+'日'+tail],
        [/^asked (\d+) of (\d+)$/, '已请求 $1 / $2 次'],
        [/^Waiting for (.+)$/, '等待 $1'],
        [/^([A-Za-z ]+) failed: (.+)$/, '$1失败：$2'],
        [/^(\d+) s before the tap · (\d+) s after(.*)$/, '点击前 $1 秒 · 后 $2 秒$3'],
        [/^(\d+) s before tap · (\d+) s after$/, '点击前 $1 秒 · 后 $2 秒'],
        [/^Writing (.+) to (DriveRecorder\/.*)$/, '正在将 $1 写入 $2'],
        [/^USB stick · (.+) free · about (.+) will be copied$/, 'USB 存储 · 可用 $1 · 预计复制 $2']
    ];
    for (const [rx,replacement] of rules) if (rx.test(s)) { s=s.replace(rx,replacement); break; }
    // Longest phrase wins; split once to keep arbitrary paths / error details intact.
    const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!text.rx) text.rx = new RegExp('(^|[^A-Za-z0-9_])(' + escaped.join('|') + ')(?=$|[^A-Za-z0-9_])', 'gi');
    const lower = {}; for (const k of keys) lower[k.toLowerCase()] = words[k];
    return s.replace(text.rx, (m, prefix, k) => prefix + (lower[k.toLowerCase()] || k)).replace(/(\d+) s\b/g, '$1 秒').replace(/(\d+) m\b/g, '$1 米');
}
module.exports = text;
