// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

/* Native status text is translated only for display, never before protocol
 * decisions. Unrecognized diagnostic details remain available verbatim. */
const { language, message } = require('./i18n.js');

function nativeText(value) {
    const text = String(value || '');
    if (!text || language() !== 'zh-CN') return text;
    const exact = message(text);
    if (exact !== text) return exact;
    const templates = [
        [/^(\d+) pkts, (\d+) B, len (\d+)-(\d+), (.+)$/, '{0} pkts, {1} B, len {2}-{3}, {4}'],
        [/^not supported on this car \((.*)\)$/, 'not supported on this car ({0})'],
        [/^the cluster renderer has no target (.*)$/, 'the cluster renderer has no target {0}'],
        [/^saving the choice failed: (.*)$/, 'saving the choice failed: {0}'],
        [/^reboot failed: (.*)$/, 'reboot failed: {0}'],
        [/^remount rw: (.*)$/, 'remount rw: {0}'],
        [/^density must be (\d+)-(\d+) in steps of (\d+)$/, 'density must be {0}-{1} in steps of {2}'],
        [/^at most (\d+) profiles have their own settings$/, 'at most {0} profiles have their own settings'],
        [/^(\d+) updates\/s$/, '{0} updates/s']
    ];
    for (const [pattern, key] of templates) {
        const match = pattern.exec(text);
        if (match) return message(key, ...match.slice(1));
    }
    return message('Details: {0}', text);
}

function decodeText(value) {
    const text = String(value || '');
    if (language() !== 'zh-CN') return text;
    const error = / \[(\d+) decode err, last: (.*)\]$/.exec(text);
    const body = error ? text.slice(0, error.index) : text;
    let shown;
    let match = /^([\d.]+ (?:B|KB|MB)), (\d+) frames$/.exec(body);
    if (match) {
        shown = message('{0}, {1} frames', match[1], match[2]);
    } else if ((match = /^waiting for CarPlay \((.*)\)$/.exec(body))) {
        shown = message('waiting for CarPlay ({0})', match[1]);
    } else if ((match = /^receiving, not decoding \(([^)]+)\) — (.*)$/.exec(body))) {
        shown = message('receiving, not decoding ({0}) — {1}', match[1], nativeText(match[2]));
    } else {
        shown = nativeText(body);
    }
    return shown + (error ? `（${message('{0} decode err, last: {1}', error[1], nativeText(error[2]))}）` : '');
}

function mapPage(value) {
    const text = String(value || '');
    if (language() !== 'zh-CN') return text;
    const map = /^Waze map — (\d+) frames\/s \((.*)\)$/.exec(text);
    if (!map) return text === 'Waze map' ? message('Navigation map') : decodeText(text);
    const cap = /, upload cap (\d+) KB\/s$/.exec(map[2]);
    const decoded = cap ? map[2].slice(0, cap.index) : map[2];
    return message('Map — {0} frames/s ({1})', map[1],
        decodeText(decoded) + (cap ? `，${message('upload cap {0} KB/s', cap[1])}` : ''));
}

function withDetail(label, raw) {
    return language() === 'zh-CN' && raw ? message('{0}: {1}', label, nativeText(raw)) : label;
}

module.exports = { nativeText, decodeText, mapPage, withDetail };
