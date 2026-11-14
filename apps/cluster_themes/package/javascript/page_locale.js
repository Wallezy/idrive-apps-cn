'use strict';
// Centre-screen presentation only: instrument fonts, labels and protocol values stay untouched.
const t = require('./kit/i18n').t;
function text(value) {
    const s = String(value == null ? '' : value);
    let m;
    if ((m = /^SLOT (\d+) · PICK A SENSOR$/i.exec(s))) return '第 ' + m[1] + ' 项 · 选择数据';
    if ((m = /^(.*) · (\d+) slots$/.exec(s))) return m[1] + ' · ' + m[2] + ' 项';
    if ((m = /^(\d+) warnings? on$/.exec(s))) return '已启用 ' + m[1] + ' 项告警';
    if ((m = /^Playing on the cluster · (\d+) s$/.exec(s))) return '仪表演示中 · ' + m[1] + ' 秒';
    if ((m = /^([\d,]+) rpm before$/.exec(s))) return '提前 ' + m[1] + ' rpm';
    if ((m = /^Turn HUD Widgets off so (.*) shows\?$/.exec(s))) return '关闭 HUD Widgets 并显示 ' + m[1] + '？';
    if ((m = /^Can't reach Waze on Cluster \((.*)\)$/.exec(s))) return '无法连接 Waze 仪表盘（' + m[1] + '）';
    if ((m = /^Off · (.*) has the screen · pick one to take it back$/.exec(s))) return m[1] + ' 正在显示，请选主题切换';
    return t(s.replace(' · trail ', ' · 轨迹 ').replace(/  ·  now/i, ' · 当前'));
}
function localizeCanvas(cv) {
    if (cv._clusterLocalized) return cv;
    cv._clusterLocalized = true;
    const draw = cv.text, measure = cv.textWidth;
    cv.text = function (value, x, y, size, color, opts) {
        return draw.call(this, text(value), x, y, size, color, Object.assign({}, opts, { literal: true }));
    };
    cv.textWidth = function (value, size, opts) {
        return measure.call(this, text(value), size, Object.assign({}, opts, { literal: true }));
    };
    return cv;
}
module.exports = { text, localizeCanvas };
