// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * The app's words in the head unit's display language. The English text is
 * the key: t('Status: {0}', t('Patched')) is its translation in the
 * language in use, with {0}, {1} ... replaced by the arguments, or the
 * English where the language has no translation. Addresses, numbers and
 * file names remain data. Known native messages have a separate presentation
 * dictionary; the socket protocol and diagnostic logs remain unchanged.
 *
 * The languages are src/locales.js (tools/gen_locales.js, from
 * locales/<code>.json). setHmiLanguage(value) picks the one for the HMI's
 * display language (a CommonTypes.Language name). The CN edition defaults
 * to Simplified Chinese before the HMI reports a supported language.
 */
const LOCALES = require('./locales.js');

const DEFAULT = LOCALES.find((l) => l.code === 'zh-CN');
let current = DEFAULT;

function codes() {
    return LOCALES.map((l) => l.code);
}

/* Returns whether the language changed. */
function setHmiLanguage(value) {
    const next = ['ENGLISCH__UK', 'ENGLISCH__US'].indexOf(value) >= 0 ? null :
        LOCALES.find((l) => typeof value === 'string' && l.hmiLanguages.indexOf(value) >= 0) || DEFAULT;
    if (next === current) {
        return false;
    }
    current = next;
    return true;
}

function language() {
    return current ? current.code : 'en';
}

function t(key, ...args) {
    const words = current && current.words;
    const text = words && Object.prototype.hasOwnProperty.call(words, key) && typeof words[key] === 'string' ? words[key] : key;
    return text.replace(/\{(\d+)\}/g, (match, i) => (Number(i) < args.length ? String(args[i]) : match));
}

function message(key, ...args) {
    const words = current && current.messages;
    const text = words && Object.prototype.hasOwnProperty.call(words, key) ? words[key] : key;
    return text.replace(/\{(\d+)\}/g, (match, i) => (Number(i) < args.length ? String(args[i]) : match));
}

module.exports = { codes, setHmiLanguage, language, t, message };
