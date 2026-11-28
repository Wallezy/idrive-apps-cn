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
 * The language table is src/locales.js and each language's word map is in
 * locales/<code>.json (tools/gen_locales.js, from locales/<code>.json),
 * loaded on demand when selected. setHmiLanguage(value) picks the one for
 * the HMI's display language (a CommonTypes.Language name), English for any
 * other supported languages. CN defaults to Simplified Chinese.
 */
const fs = require('fs');
const path = require('path');
const LOCALES = require('./locales.js');

const DEFAULT = LOCALES.find((l) => l.code === 'zh-CN');
let current = DEFAULT;
let currentWords = DEFAULT ? loadWords(DEFAULT.code) : null;
let currentMessages = DEFAULT ? loadWords(`${DEFAULT.code}.messages`) : null;

/* The package's runtime locales folder: beside javascript/ in the installed
 * app, in the staged tree mgu-app.json names in the repository. */
function localesDir() {
    const up = path.join(__dirname, '..');
    const manifest = path.join(up, 'mgu-app.json');
    if (fs.existsSync(manifest)) {
        return path.join(up, JSON.parse(fs.readFileSync(manifest, 'utf8')).tree, 'locales');
    }
    return path.join(up, 'locales');
}

function loadWords(code) {
    try {
        const w = JSON.parse(fs.readFileSync(path.join(localesDir(), `${code}.json`), 'utf8'));
        return w && typeof w === 'object' && !Array.isArray(w) ? w : null;
    } catch (e) {
        return null;
    }
}

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
    currentWords = current ? loadWords(current.code) : null;
    currentMessages = current ? loadWords(`${current.code}.messages`) : null;
    return true;
}

function language() {
    return current ? current.code : 'en';
}

function t(key, ...args) {
    const words = current && (current.words || currentWords);
    const text = words && Object.prototype.hasOwnProperty.call(words, key) && typeof words[key] === 'string' ? words[key] : key;
    return text.replace(/\{(\d+)\}/g, (match, i) => (Number(i) < args.length ? String(args[i]) : match));
}

function message(key, ...args) {
    const words = currentMessages;
    const text = words && Object.prototype.hasOwnProperty.call(words, key) ? words[key] : key;
    return text.replace(/\{(\d+)\}/g, (match, i) => (Number(i) < args.length ? String(args[i]) : match));
}

module.exports = { codes, setHmiLanguage, language, t, message };
