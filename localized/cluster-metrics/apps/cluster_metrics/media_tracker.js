'use strict';
/**
 * media_tracker.js - Live head-unit media metadata, playback position, full-color album art
 * (`HmiMediaState` + `MediaPlayer`), and left-stalk BC button page cycling (`KombiIF` + `Light`).
 *
 * Strict Node 8.16.2 (ES2017): no optional chaining, no ??, no native image codecs.
 */

const fs = require('fs');
const { decodeCoverThumb, MAX_BYTES } = require('./image_decode');
const { foldAscii } = require('./hud_nav_renderer');

const COVER_SIDE = 144;
const META_KEYS = { 3: 'TITLE', 5: 'ARTIST', 7: 'ALBUM', 9: 'ALBUM_ARTIST', 17: 'COVER_FILE', 32: 'PERFORMER', 40: 'EPISODE', 47: 'SERIES' };
const ITEM_TYPES = { 0: 'UNDEFINED', 1: 'ARTIST', 2: 'ALBUM', 3: 'TITLE', ARTIST: 'ARTIST', ALBUM: 'ALBUM', TITLE: 'TITLE', UNDEFINED: 'UNDEFINED' };
const PAGES = ['media', 'trip', 'off'];
const BOLD_OPTS = { font: 'bold' };

function isObj(v) { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }

function normId(v) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
        if (typeof v.value === 'number' || typeof v.value === 'string') return String(v.value);
        if (v.high !== undefined || v.low !== undefined) return String(v.high || 0) + ':' + String(v.low || 0);
        try { return JSON.stringify(v); } catch (e) { return ''; }
    }
    return String(v);
}

function fnv1aHex(buf) {
    if (!buf || !buf.length) return 'empty';
    let h = 2166136261;
    for (let i = 0; i < buf.length; i++) {
        h ^= buf[i];
        h = Math.imul(h, 16777619) >>> 0;
    }
    return 'b:' + buf.length + ':' + h.toString(16);
}

function isRenderableMediaCp(cp) {
    if (cp >= 0x20 && cp <= 0x7e) return true;
    if (cp === 0x00b0 || cp === 0x00b7 || cp === 0x2014 || cp === 0x2022 || cp === 0x2026) return true;
    if (cp >= 0x3000 && cp <= 0x30ff) return true; // CJK symbols, Hiragana, Katakana
    if (cp >= 0x31f0 && cp <= 0x31ff) return true; // Katakana phonetic extensions
    if (cp >= 0x3400 && cp <= 0x4dbf) return true; // CJK Extension A
    if (cp >= 0x4e00 && cp <= 0x9fff) return true; // CJK Unified Ideographs
    if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK Compatibility Ideographs
    if (cp >= 0xff00 && cp <= 0xffef) return true; // Halfwidth/Fullwidth forms
    if (cp >= 0xac00 && cp <= 0xd7af) return true; // Hangul syllables
    return false;
}

function isCjkBreakCp(cp) {
    return (cp >= 0x2e80 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0xac00 && cp <= 0xd7af);
}

function cleanMediaText(raw, maxLen) {
    if (typeof raw !== 'string') return '';
    const rawTrim = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!rawTrim) return '';
    // Map common punctuation & Latin diacritics while keeping CJK / Japanese / Korean intact
    let mapped = rawTrim
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E]/g, '"')
        .replace(/[\u2012\u2013\u2014\u2212]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[\u00A0\u3000]/g, ' ')
        .replace(/\u00DF/g, 'ss')
        .replace(/\u00C6/g, 'AE')
        .replace(/\u00E6/g, 'ae')
        .replace(/\u00D8/g, 'O')
        .replace(/\u00F8/g, 'o')
        .replace(/\u0141/g, 'L')
        .replace(/\u0142/g, 'l')
        .replace(/\uFF08/g, '(')
        .replace(/\uFF09/g, ')')
        .replace(/\uFF01/g, '!')
        .replace(/\uFF1F/g, '?')
        .replace(/\uFF1A/g, ':')
        .replace(/\uFF5E/g, '~');
    if (typeof mapped.normalize === 'function') {
        mapped = mapped.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    let kept = '';
    for (const ch of mapped) {
        const cp = ch.codePointAt(0);
        if (isRenderableMediaCp(cp)) {
            kept += ch;
        } else if (cp > 0x7e && cp < 0x0250) {
            // Remaining Latin-extended glyph: run through ASCII folder if transliterable
            const asc = foldAscii(ch);
            if (asc) kept += asc;
        }
    }
    kept = kept.replace(/\s+/g, ' ').trim();
    if (!kept) return rawTrim.length > 0 ? '[Track]' : '';
    const lim = maxLen || 160;
    return kept.length > lim ? (kept.slice(0, lim - 3).trim() + '...') : kept;
}

function extractMetaValue(v, depth) {
    if (typeof v === 'string') return v.replace(/\0/g, '').trim();
    if (!isObj(v) || depth > 3) return '';
    if (typeof v.stringValue === 'string') return v.stringValue.replace(/\0/g, '').trim();
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const s = extractMetaValue(v[keys[i]], depth + 1);
        if (s) return s;
    }
    return '';
}

function parseMediaPlayerMetadata(meta) {
    const list = Array.isArray(meta) ? meta : (isObj(meta) && Array.isArray(meta.metadata) ? meta.metadata : null);
    if (list) {
        const map = {};
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!isObj(e) || e.key === undefined) continue;
            let k = e.key;
            if (isObj(k)) k = k.name !== undefined ? k.name : k.value;
            k = typeof k === 'number' ? META_KEYS[k] : String(k).toUpperCase();
            const val = extractMetaValue(e.value, 0);
            if (k && val && !map[k]) map[k] = val;
        }
        const title = cleanMediaText(map.TITLE || map.EPISODE || '', 160);
        const artist = cleanMediaText(map.ARTIST || map.SERIES || map.ALBUM_ARTIST || map.PERFORMER || '', 80);
        const album = cleanMediaText(map.ALBUM || '', 80);
        const coverFile = typeof map.COVER_FILE === 'string' ? map.COVER_FILE.replace(/\0/g, '').trim() : '';
        if (!title && !artist) return null;
        return { title: title || artist, artist: title ? artist : album, album, coverFile, explicitTitle: Boolean(title) };
    }
    if (!isObj(meta)) return null;
    const t = cleanMediaText(meta.title || meta.track || meta.episode || '', 160);
    const a = cleanMediaText(meta.artist || meta.series || meta.performer || '', 80);
    if (!t && !a) return null;
    return { title: t || a, artist: t ? a : '', album: cleanMediaText(meta.album || '', 80), coverFile: '', explicitTitle: Boolean(t) };
}

function parseHmiPlayerMetadata(v) {
    if (!isObj(v)) return null;
    const rawLine = (s) => (typeof s === 'string' ? s.replace(/[\0\r]+/g, '').trim() : '');
    const l1 = rawLine(v.firstLineText);
    const l2 = rawLine(v.secondLineText);
    const l3Raw = typeof v.threeRowText === 'string' ? v.threeRowText.replace(/\0/g, '').trim() : '';
    const t1 = ITEM_TYPES[v.firstLineType] || '';
    const t2 = ITEM_TYPES[v.secondLineType] || '';
    const uiType = v.uiType;
    const isThreeRow = uiType === 2 || uiType === 'THREE_ROWS_TEXT' || l3Raw.length > 0;

    // Extract any unique track/episode line inside threeRowText (BMW often sends Show in firstLineText,
    // Date/Album in secondLineText, and Episode/Track in threeRowText).
    const l3Parts = l3Raw ? l3Raw.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
    const l3Unique = [];
    for (let i = 0; i < l3Parts.length; i++) {
        const s = l3Parts[i];
        if (s !== l1 && s !== l2 && l3Unique.indexOf(s) < 0) l3Unique.push(s);
    }

    let rawTitle = '';
    let explicitTitle = false;
    if (t1 === 'TITLE' && l1) {
        rawTitle = l1;
        explicitTitle = true;
    } else if (t2 === 'TITLE' && l2) {
        rawTitle = l2;
        explicitTitle = true;
    } else if (l3Unique.length > 0) {
        rawTitle = l3Unique[0];
        explicitTitle = true;
    } else if (isThreeRow && l3Parts.length > 0) {
        rawTitle = l3Parts[l3Parts.length - 1];
        explicitTitle = Boolean(rawTitle);
    } else {
        rawTitle = l1 || l2 || '';
        explicitTitle = false;
    }

    // Choose artist / show name (never concatenate album/date onto artist like "Artist - Album")
    let rawArtist = '';
    if (t1 === 'ARTIST' && l1 && l1 !== rawTitle) rawArtist = l1;
    else if (t2 === 'ARTIST' && l2 && l2 !== rawTitle) rawArtist = l2;
    else if (l1 && l1 !== rawTitle && t1 !== 'ALBUM') rawArtist = l1;
    else if (l2 && l2 !== rawTitle && t2 !== 'ALBUM') rawArtist = l2;
    else if (l1 && l1 !== rawTitle) rawArtist = l1;
    else if (l2 && l2 !== rawTitle) rawArtist = l2;

    const rawAlbum = (t1 === 'ALBUM' && l1) ? l1 : ((t2 === 'ALBUM' && l2) ? l2 : '');
    const title = cleanMediaText(rawTitle, 160);
    const artist = cleanMediaText(rawArtist, 80);
    const album = cleanMediaText(rawAlbum, 80);
    const trackId = typeof v.trackId === 'number' && isFinite(v.trackId) ? v.trackId : null;
    const shape = (t1 || String(v.firstLineType !== undefined ? v.firstLineType : '?')) + '/' +
        (t2 || String(v.secondLineType !== undefined ? v.secondLineType : '?')) +
        (l3Raw ? ('/3R(' + l3Parts.length + ')') : '');

    if (!title && !artist) return { empty: true, trackId, shape };
    return {
        empty: false,
        title: title || artist,
        artist: title ? artist : album,
        album,
        explicitTitle,
        firstType: t1,
        secondType: t2,
        trackId,
        shape,
    };
}

/**
 * Resize long titles (Latin & CJK) down across `sizes` until `minSize`; if still wider than `maxW`,
 * split cleanly between words (Latin) or characters (CJK) and paginate across segments over time.
 */
function paginateTitle(cv, title, maxW, sizes, minSize, elapsedMs) {
    const szList = Array.isArray(sizes) && sizes.length ? sizes : [30, 27, 24, 22];
    const minSz = minSize || szList[szList.length - 1] || 22;
    const clean = cleanMediaText(String(title || ''), 220);
    if (!clean) return { text: '', size: szList[0], page: 0, pages: 1 };

    for (let i = 0; i < szList.length; i++) {
        const sz = szList[i];
        if (cv.textWidth(clean, sz, BOLD_OPTS) <= maxW) {
            return { text: clean, size: sz, page: 0, pages: 1 };
        }
    }

    // Tokenize into words (Latin runs) & single characters (CJK) so CJK wraps without inserting extra spaces
    const tokens = [];
    let curWord = '';
    let pendingSpace = false;
    for (const ch of clean) {
        if (/\s/.test(ch)) {
            if (curWord) {
                tokens.push({ str: curWord, spaceBefore: pendingSpace });
                curWord = '';
                pendingSpace = false;
            }
            if (tokens.length > 0) pendingSpace = true;
            continue;
        }
        const cp = ch.codePointAt(0);
        if (isCjkBreakCp(cp)) {
            if (curWord) {
                tokens.push({ str: curWord, spaceBefore: pendingSpace });
                curWord = '';
                pendingSpace = false;
            }
            tokens.push({ str: ch, spaceBefore: pendingSpace });
            pendingSpace = false;
        } else {
            curWord += ch;
        }
    }
    if (curWord) tokens.push({ str: curWord, spaceBefore: pendingSpace });

    const segs = [];
    const contW = cv.textWidth('..', minSz, BOLD_OPTS);
    let idx = 0;

    while (idx < tokens.length && segs.length < 6) {
        const firstTok = tokens[idx++];
        let line = firstTok.str;
        if (cv.textWidth(line, minSz, BOLD_OPTS) > maxW - contW && line.length > 3) {
            // Very long single non-CJK token without spaces: slice cleanly to fit
            let part = line;
            while (part.length > 3 && cv.textWidth(part + '..', minSz, BOLD_OPTS) > maxW) {
                part = part.slice(0, -1);
            }
            const rest = line.slice(part.length);
            if (rest) tokens.splice(idx, 0, { str: rest, spaceBefore: false });
            segs.push({ text: part, truncated: idx < tokens.length });
            continue;
        }
        while (idx < tokens.length) {
            const nxt = tokens[idx];
            const cand = line + (nxt.spaceBefore ? ' ' : '') + nxt.str;
            const isFinal = (idx === tokens.length - 1);
            const limitW = isFinal ? maxW : (maxW - contW);
            if (cv.textWidth(cand, minSz, BOLD_OPTS) <= limitW) {
                line = cand;
                idx++;
            } else {
                break;
            }
        }
        segs.push({ text: line, truncated: idx < tokens.length });
    }

    if (segs.length <= 1) {
        return { text: (segs[0] && segs[0].text) || clean, size: minSz, page: 0, pages: 1 };
    }

    const formatted = [];
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        formatted.push(s.truncated ? (s.text + (i === segs.length - 1 && segs.length === 6 ? '...' : '..')) : s.text);
    }

    const FIRST_HOLD_MS = 3500;
    const NEXT_HOLD_MS = 2800;
    const totalCycle = FIRST_HOLD_MS + (formatted.length - 1) * NEXT_HOLD_MS;
    const tIn = Math.max(0, typeof elapsedMs === 'number' && isFinite(elapsedMs) ? elapsedMs : 0) % totalCycle;
    const page = tIn < FIRST_HOLD_MS ? 0 : (1 + Math.floor((tIn - FIRST_HOLD_MS) / NEXT_HOLD_MS));
    const safePage = Math.max(0, Math.min(formatted.length - 1, page));
    return { text: formatted[safePage], size: minSz, page: safePage, pages: formatted.length };
}

function parseTimeStruct(v) {
    if (!isObj(v)) return null;
    if (v.hasProgress === false) return null;
    const e = Number(v.elapsed);
    const t = Number(v.total);
    if (!isFinite(e) || !isFinite(t) || !(t > 0) || e < 0) return null;
    if (t >= 0xFFFFFFF0 || e >= 0xFFFFFFF0) return null;
    const scale = (t > 21600 || e > 21600) ? 1000 : 1;
    const totalSec = t / scale;
    const elapsedSec = e / scale;
    if (totalSec <= 0 || totalSec > 6 * 3600 || elapsedSec > totalSec + 2) return null;
    return {
        elapsedSec: Math.min(totalSec, Math.max(0, elapsedSec)),
        totalSec,
    };
}

function toBytesBuffer(raw) {
    if (!raw) return null;
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof Uint8Array) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (Array.isArray(raw) && raw.length > 0) return Buffer.from(raw);
    return null;
}

let cachedDemoCover = null;
function getDemoCover() {
    if (cachedDemoCover) return cachedDemoCover;
    const n = COVER_SIDE;
    const d = Buffer.allocUnsafe(n * n * 4);
    for (let y = 0; y < n; y++) {
        const fy = y / (n - 1);
        for (let x = 0; x < n; x++) {
            const fx = x / (n - 1);
            const dx = fx - 0.5, dy = fy - 0.44;
            const dist = Math.sqrt(dx * dx + dy * dy);
            let r = Math.round(18 + 42 * (1 - fy) + 60 * fx);
            let g = Math.round(52 + 115 * (1 - dist * 1.4));
            let b = Math.round(118 + 125 * (1 - fy * 0.6));
            if (dist < 0.23) {
                r = 235; g = 188; b = 96;
            } else if (fy > 0.68 && ((y % 5) === 0)) {
                r = Math.round(r * 0.55); g = Math.round(g * 0.7); b = Math.min(255, Math.round(b * 1.15));
            }
            const o = (y * n + x) * 4;
            d[o] = Math.max(0, Math.min(255, r));
            d[o + 1] = Math.max(0, Math.min(255, g));
            d[o + 2] = Math.max(0, Math.min(255, b));
            d[o + 3] = 255;
        }
    }
    cachedDemoCover = { w: n, h: n, d, accent: [56, 178, 246], id: 'demo' };
    return cachedDemoCover;
}

class MediaTracker {
    constructor() {
        this.hmiMeta = null;
        this.hmiMainThird = '';
        this.mpMeta = null;
        this.mpPlaying = false;
        this.mpUpdatedAt = 0;
        this.time = null; // { elapsedSec, totalSec, atMs }
        this.playing = true;
        this.source = '';
        this.trackKey = '';
        this.trackSinceMs = 0;
        this.cover = null; // { w, h, d, accent, id }
        this.coverRev = 0;
        this.coverCache = []; // [{ key, cover }] (keyed strictly by image byte FNV-1a hash!)
        this._coverUpdatedAt = 0;
        this._chunkState = null; // { id, totalSize, buf, written }
        this._decodeTimer = null;
        this._coverRefetchTimer = null;
        this._decodeSeq = 0;
        this._hmiSub = null;
        this._mpSub = null;

        // Right-wing BC page cycling state (checkbox-driven; high-beam double-tap removed)
        this.bcStep = 0;
        this.pageIndex = 0;
        this.bcClicks = 0;
        this.lastBcAt = 0;
        this.lastBcSource = '';
        this._kombiSelBase = null;
        this._stalkRest = null;
        this._stalkDownVal = null;
        this._stalkDownAt = 0;
        this._lastTurnSignalAt = 0;
        this.rawStalk = null;
        this.rawKombiSel = null;

        this._subs = [];
        this._stopped = false;
    }

    _cacheGet(key) {
        for (let i = 0; i < this.coverCache.length; i++) {
            if (this.coverCache[i].key === key) return this.coverCache[i].cover;
        }
        return null;
    }

    _cachePut(key, cover) {
        this.coverCache.unshift({ key, cover });
        if (this.coverCache.length > 8) this.coverCache.length = 8;
    }

    _applyCoverBytes(_hintKey, buf, syncDecode) {
        if (!buf || buf.length < 16 || buf.length > MAX_BYTES) return false;
        // Key by FNV-1a byte hash + length so Int64 coverArtId objects or reused IDs NEVER collide!
        const key = fnv1aHex(buf);
        this._coverUpdatedAt = Date.now();
        const cached = this._cacheGet(key);
        if (cached) {
            this.cover = cached;
            this.coverRev++;
            return true;
        }
        const seq = ++this._decodeSeq;
        if (this._decodeTimer) {
            clearTimeout(this._decodeTimer);
            this._decodeTimer = null;
        }
        const runDecode = () => {
            this._decodeTimer = null;
            if (this._stopped || seq !== this._decodeSeq) return false;
            const thumb = decodeCoverThumb(buf, COVER_SIDE);
            if (!thumb) return false;
            thumb.id = key;
            this._cachePut(key, thumb);
            this.cover = thumb;
            this.coverRev++;
            this._coverUpdatedAt = Date.now();
            return true;
        };
        if (syncDecode) return runDecode();
        this._decodeTimer = setTimeout(runDecode, 60);
        if (this._decodeTimer && typeof this._decodeTimer.unref === 'function') this._decodeTimer.unref();
        return true;
    }

    _scheduleCoverRefetch() {
        if (this._stopped) return;
        if (this._coverRefetchTimer) {
            clearTimeout(this._coverRefetchTimer);
            this._coverRefetchTimer = null;
        }
        const changedAt = Date.now();
        this._coverRefetchTimer = setTimeout(() => {
            this._coverRefetchTimer = null;
            if (this._stopped) return;
            if (this._coverUpdatedAt < changedAt - 1200) {
                this._queryCoverArtNow();
            }
        }, 450);
        if (this._coverRefetchTimer && typeof this._coverRefetchTimer.unref === 'function') {
            this._coverRefetchTimer.unref();
        }
    }

    _queryCoverArtNow() {
        const px = this._hmiSub && this._hmiSub.proxy;
        if (px && typeof px.getValue === 'function') {
            px.getValue('coverArt', 2500).then((v) => {
                if (!this._stopped && v) this.feedHmiCoverArt(v, false);
            }).catch(() => {});
        }
    }

    refresh() {
        if (this._stopped) return;
        const px = this._hmiSub && this._hmiSub.proxy;
        if (px && typeof px.getValue === 'function') {
            px.getValue('playerMetadata', 2500).then((v) => {
                if (!this._stopped && v) this.feedHmiMetadata(v, Date.now());
            }).catch(() => {});
            px.getValue('mainMenuMetadata', 2500).then((v) => {
                if (!this._stopped && v) this.feedHmiMainMenuMetadata(v);
            }).catch(() => {});
            px.getValue('coverArt', 2500).then((v) => {
                if (!this._stopped && v) this.feedHmiCoverArt(v, false);
            }).catch(() => {});
        }
        const mpx = this._mpSub && this._mpSub.proxy;
        if (mpx && typeof mpx.getValue === 'function') {
            mpx.getValue('currentItemMetadata', 2500).then((v) => {
                if (!this._stopped && v) this.feedMediaPlayerMetadata(v, Date.now());
            }).catch(() => {});
        }
    }

    _loadCoverFile(filePath) {
        if (!filePath || typeof filePath !== 'string' || filePath.length > 360) return;
        const seq = ++this._decodeSeq;
        fs.stat(filePath, (err, st) => {
            if (err || !st || !st.isFile() || st.size > MAX_BYTES || seq !== this._decodeSeq || this._stopped) return;
            fs.readFile(filePath, (err2, buf) => {
                if (err2 || !buf || seq !== this._decodeSeq || this._stopped) return;
                this._applyCoverBytes('file:' + filePath, buf, true);
            });
        });
    }

    feedHmiMainMenuMetadata(v) {
        if (!isObj(v)) return;
        const l1 = typeof v.firstLineText === 'string' ? v.firstLineText.replace(/\0/g, '').trim() : '';
        const l2 = typeof v.secondLineText === 'string' ? v.secondLineText.replace(/\0/g, '').trim() : '';
        const l3 = typeof v.thirdLineText === 'string' ? v.thirdLineText.replace(/\0/g, '').trim() : '';
        if (l3 && l3 !== l1 && l3 !== l2) {
            this.hmiMainThird = cleanMediaText(l3, 160);
        } else if (!l3) {
            this.hmiMainThird = '';
        }
    }

    feedHmiMetadata(v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const parsed = parseHmiPlayerMetadata(v);
        if (!parsed) return;
        if (parsed.empty) {
            this.hmiMeta = null;
            return;
        }
        const prevKey = this.hmiMeta ? (this.hmiMeta.title + '|' + this.hmiMeta.artist) : '';
        const nextKey = parsed.title + '|' + parsed.artist;
        this.hmiMeta = parsed;
        this.source = 'HMI';
        // Drop stale CarPlayMedia metadata when user switched HMI to a different source/show
        if (this.mpMeta && !this.mpPlaying &&
            this.mpMeta.artist !== parsed.title && this.mpMeta.artist !== parsed.artist &&
            this.mpMeta.title !== parsed.title) {
            this.mpMeta = null;
        }
        if (prevKey && prevKey !== nextKey) {
            this.time = null;
            this.trackSinceMs = now;
            this._scheduleCoverRefetch();
        } else if (!this.trackSinceMs) {
            this.trackSinceMs = now;
        }
    }

    feedHmiProgress(v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const t = parseTimeStruct(v);
        if (!t) {
            if (isObj(v) && v.hasProgress === false) this.time = null;
            return;
        }
        this.time = { elapsedSec: t.elapsedSec, totalSec: t.totalSec, atMs: now };
    }

    feedHmiCoverArt(v, syncDecode) {
        if (!isObj(v)) return false;
        if (v.sink === 1 || v.sink === 2 || v.sink === 'FOND_LEFT' || v.sink === 'FOND_RIGHT') return false;
        const chunk = toBytesBuffer(v.coverArt);
        const cidRaw = normId(v.coverArtId);
        const trkRaw = normId(v.trackId);
        const cid = (cidRaw ? cidRaw : 'noid') + ':' + trkRaw;
        const totalSize = typeof v.totalSize === 'number' && isFinite(v.totalSize) ? v.totalSize : (chunk ? chunk.length : 0);
        const offset = typeof v.offset === 'number' && isFinite(v.offset) && v.offset >= 0 ? v.offset : 0;

        if (!chunk || chunk.length === 0 || totalSize <= 0) {
            if (totalSize === 0) {
                this._chunkState = null;
                this.cover = null;
                this.coverRev++;
                this._coverUpdatedAt = Date.now();
            }
            return false;
        }
        if (totalSize > MAX_BYTES) return false;

        if (offset === 0 && chunk.length >= totalSize) {
            this._chunkState = null;
            const full = chunk.length === totalSize ? chunk : chunk.slice(0, totalSize);
            return this._applyCoverBytes(cid, full, Boolean(syncDecode));
        }

        // Multi-chunk CoverArt reassembly: fresh transfer on offset === 0 or size/id change
        if (offset === 0 || !this._chunkState || this._chunkState.id !== cid || this._chunkState.totalSize !== totalSize) {
            this._chunkState = {
                id: cid,
                totalSize,
                buf: Buffer.alloc(totalSize),
                written: 0,
            };
        }
        const st = this._chunkState;
        const copyLen = Math.max(0, Math.min(chunk.length, st.totalSize - offset));
        if (copyLen > 0) {
            chunk.copy(st.buf, offset, 0, copyLen);
            st.written = Math.max(st.written, offset + copyLen);
        }
        if (st.written >= st.totalSize) {
            const doneBuf = st.buf;
            this._chunkState = null;
            return this._applyCoverBytes(cid, doneBuf, Boolean(syncDecode));
        }
        return false;
    }

    feedMediaPlayerState(v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const raw = isObj(v) ? (v.name !== undefined ? v.name : v.value) : v;
        let playing = this.playing;
        if (typeof raw === 'number') {
            if (raw === 1) playing = true;
            else if (raw === 2 || raw === 3) playing = false;
        } else if (typeof raw === 'string') {
            if (/(^|_)PLAY$/i.test(raw)) playing = true;
            else if (/PAUSE|STOP/i.test(raw)) playing = false;
        }
        this.mpPlaying = playing;
        if (playing !== this.playing) {
            if (this.time) {
                const prog = this._computeProgress(now);
                if (prog) this.time = { elapsedSec: prog.elapsedSec, totalSec: prog.totalSec, atMs: now };
            }
            this.playing = playing;
        }
    }

    feedMediaPlayerMetadata(v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const parsed = parseMediaPlayerMetadata(v);
        const prevTrack = this.mpMeta ? (this.mpMeta.title + '|' + this.mpMeta.artist) : '';
        this.mpMeta = parsed;
        if (!parsed) return;
        this.mpUpdatedAt = now;
        if (!this.source) this.source = 'CarPlay';
        const nextTrack = parsed.title + '|' + parsed.artist;
        const trackChanged = Boolean(prevTrack && prevTrack !== nextTrack);
        if (trackChanged) {
            this.time = null;
            this.trackSinceMs = now;
        } else if (!this.trackSinceMs) {
            this.trackSinceMs = now;
        }
        if (parsed.coverFile) {
            this._loadCoverFile(parsed.coverFile);
        } else if (trackChanged) {
            this._scheduleCoverRefetch();
        }
    }

    feedMediaPlayerTime(v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const t = parseTimeStruct(v);
        if (!t) return;
        this.time = { elapsedSec: t.elapsedSec, totalSec: t.totalSec, atMs: now };
    }

    triggerBcClick(reason, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (now - this.lastBcAt < 220) return false;
        this.lastBcAt = now;
        this.bcClicks++;
        this.bcStep++;
        this.lastBcSource = reason || 'bc';
        this.pageIndex = (this.pageIndex + 1) % PAGES.length;
        return true;
    }

    feedKombiSelection(v, nowMs) {
        if (!isObj(v)) return false;
        const c1 = typeof v.statusActivationInstrumentPackContent === 'number' && v.statusActivationInstrumentPackContent < 65535
            ? v.statusActivationInstrumentPackContent : null;
        const c2 = typeof v.statusActivationInstrumentPackBC === 'number' && v.statusActivationInstrumentPackBC < 2147483647
            ? v.statusActivationInstrumentPackBC : null;
        if (c1 === null && c2 === null) return false;
        const sig = String(c1) + ':' + String(c2);
        this.rawKombiSel = sig;
        if (this._kombiSelBase === null) {
            this._kombiSelBase = sig;
            return false;
        }
        if (sig !== this._kombiSelBase) {
            this._kombiSelBase = sig;
            return this.triggerBcClick('kombi_sel', nowMs);
        }
        return false;
    }

    feedTurnSignal(v, nowMs) {
        if (!isObj(v)) return;
        this._lastTurnSignalAt = typeof nowMs === 'number' ? nowMs : Date.now();
    }

    feedStalk(v, nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const raw = isObj(v) ? v.operationColumnStalks : v;
        if (typeof raw !== 'number' || !isFinite(raw) || raw === 255) return false;
        this.rawStalk = raw;
        if (this._stalkRest === null) {
            this._stalkRest = raw;
            return false;
        }
        // Ignore changes coinciding with turn-signal actuation
        if (now - this._lastTurnSignalAt < 320) {
            this._stalkDownVal = null;
            this._stalkRest = raw;
            return false;
        }
        if (raw !== this._stalkRest) {
            if (this._stalkDownVal === null) {
                this._stalkDownVal = raw;
                this._stalkDownAt = now;
            } else if (now - this._stalkDownAt > 1500) {
                // Sustained new stalk position (e.g. steady high-beam lever), adopt as new rest
                this._stalkRest = raw;
                this._stalkDownVal = null;
            }
            return false;
        }
        // Returned to resting value: if it was a momentary 20..1100ms button pulse, count as BC click!
        if (this._stalkDownVal !== null) {
            const heldMs = now - this._stalkDownAt;
            this._stalkDownVal = null;
            if (heldMs >= 20 && heldMs <= 1100 && now - this._lastTurnSignalAt >= 320) {
                return this.triggerBcClick('stalk_bc', now);
            }
        }
        return false;
    }

    _computeProgress(nowMs) {
        if (!this.time || !(this.time.totalSec > 0)) return null;
        const addSec = this.playing ? Math.max(0, (nowMs - this.time.atMs) / 1000) : 0;
        const elapsedSec = Math.min(this.time.totalSec, Math.max(0, this.time.elapsedSec + addSec));
        const totalSec = this.time.totalSec;
        return {
            elapsedSec,
            totalSec,
            remainSec: Math.max(0, totalSec - elapsedSec),
            frac: totalSec > 0 ? Math.min(1, Math.max(0, elapsedSec / totalSec)) : 0,
        };
    }

    demoSnapshot(nowMs) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        const totalSec = 208;
        const elapsedSec = ((now / 1000) % totalSec);
        return {
            active: true,
            playing: true,
            source: 'CarPlay',
            title: 'Midnight City',
            artist: 'M83',
            elapsedSec,
            totalSec,
            remainSec: totalSec - elapsedSec,
            frac: elapsedSec / totalSec,
            cover: getDemoCover(),
            coverRev: 1,
            trackSinceMs: 0,
            rawShape: 'DEMO',
            page: PAGES[this.pageIndex] || 'media',
            bcStep: this.bcStep,
            bcClicks: this.bcClicks,
            lastBcSource: this.lastBcSource,
            rawStalk: this.rawStalk,
            rawKombiSel: this.rawKombiSel,
        };
    }

    snapshot(nowMs, isDemo) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (isDemo) return this.demoSnapshot(now);

        let title = '';
        let artist = '';
        const h = this.hmiMeta;
        const m = this.mpMeta;
        const mpMatchesHmi = Boolean(h && m && m.explicitTitle && (
            m.artist === h.title || m.artist === h.artist || m.album === h.artist ||
            this.mpPlaying || (now - this.mpUpdatedAt < 30000)
        ));

        if (h && h.explicitTitle) {
            title = h.title;
            artist = h.artist || (mpMatchesHmi ? m.artist : '');
        } else if (m && m.title && (!h || mpMatchesHmi)) {
            title = m.title;
            artist = m.artist || (h ? h.title : '') || '';
        } else if (h && this.hmiMainThird && h.firstType !== 'TITLE') {
            title = this.hmiMainThird;
            artist = h.title || h.artist || '';
        } else if (h) {
            title = h.title;
            artist = h.artist || '';
        } else if (m) {
            title = m.title;
            artist = m.artist || m.album || '';
        }

        const key = title + '|' + artist;
        if (key && key !== this.trackKey) {
            this.trackKey = key;
            this.trackSinceMs = now;
        } else if (!key) {
            this.trackKey = '';
        }

        const active = Boolean(title);
        const prog = active ? this._computeProgress(now) : null;

        return {
            active,
            playing: this.playing,
            source: this.source || (m ? 'CarPlay' : ''),
            title,
            artist,
            elapsedSec: prog ? prog.elapsedSec : null,
            totalSec: prog ? prog.totalSec : null,
            remainSec: prog ? prog.remainSec : null,
            frac: prog ? prog.frac : null,
            cover: active ? this.cover : null,
            coverRev: this.coverRev,
            trackSinceMs: this.trackSinceMs || now,
            rawShape: h ? h.shape : (m ? 'CarPlayMeta' : '--'),
            page: PAGES[this.pageIndex] || 'media',
            bcStep: this.bcStep,
            bcClicks: this.bcClicks,
            lastBcSource: this.lastBcSource,
            rawStalk: this.rawStalk,
            rawKombiSel: this.rawKombiSel,
        };
    }

    start(ctx, log) {
        this._stopped = false;
        if (!ctx || !ctx.signals || typeof ctx.signals.watch !== 'function') return;

        const addSub = (p, onReady) => {
            if (p && typeof p.then === 'function') {
                p.then((r) => {
                    if (!r) return;
                    if (this._stopped) {
                        try { if (r.shutdown) r.shutdown(); } catch (e) { /* ignore */ }
                        return;
                    }
                    this._subs.push(r);
                    if (onReady) onReady(r);
                }).catch(() => {});
            } else if (p) {
                this._subs.push(p);
                if (onReady) onReady(p);
            }
        };

        try {
            addSub(ctx.signals.watch(
                'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState',
                'HMI_CID',
                {
                    playerMetadata: (v) => this.feedHmiMetadata(v, Date.now()),
                    mainMenuMetadata: (v) => this.feedHmiMainMenuMetadata(v),
                    trackProgress: (v) => this.feedHmiProgress(v, Date.now()),
                    coverArt: (v) => this.feedHmiCoverArt(v, false),
                },
                log
            ), (r) => { this._hmiSub = r; });
        } catch (e) { /* optional */ }

        try {
            addSub(ctx.signals.watch(
                'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer',
                'CarPlayMedia',
                {
                    currentItemMetadata: (v) => this.feedMediaPlayerMetadata(v, Date.now()),
                    currentItemTime: (v) => this.feedMediaPlayerTime(v, Date.now()),
                    playerState: (v) => this.feedMediaPlayerState(v, Date.now()),
                },
                log
            ), (r) => { this._mpSub = r; });
        } catch (e) { /* optional */ }

        try {
            addSub(ctx.signals.watch(
                'de.bmw.body.Light',
                '1',
                {
                    StatusFunctionsIndicators: (v) => this.feedTurnSignal(v, Date.now()),
                    IndicatorSteeringColumn: (v) => this.feedStalk(v, Date.now()),
                    IndicatorSteeringColumnComplete: (v) => this.feedStalk(v, Date.now()),
                },
                log
            ));
        } catch (e) { /* optional */ }
    }

    stop() {
        this._stopped = true;
        if (this._decodeTimer) {
            clearTimeout(this._decodeTimer);
            this._decodeTimer = null;
        }
        if (this._coverRefetchTimer) {
            clearTimeout(this._coverRefetchTimer);
            this._coverRefetchTimer = null;
        }
        for (let i = 0; i < this._subs.length; i++) {
            const s = this._subs[i];
            try {
                if (s && typeof s.stop === 'function') s.stop();
                else if (s && typeof s.shutdown === 'function') s.shutdown();
            } catch (e) { /* ignore */ }
        }
        this._subs = [];
        this._hmiSub = null;
        this._mpSub = null;
    }
}

function resolveRightWidgetPage(settingsObj, media, isCharging) {
    if (isCharging) return 'charging';
    const s = settingsObj || {};
    if (s.rightWidgetMode && s.widgetMedia === undefined && s.widgetTrip === undefined) {
        const legacyMode = s.rightWidgetMode;
        if (legacyMode === 'off') return 'off';
        if (legacyMode === 'media') return 'media';
        if (legacyMode === 'trip') return 'trip';
    }
    const allowMedia = s.widgetMedia !== false;
    const allowTrip = s.widgetTrip !== false;
    const enabled = [];
    if (allowMedia) enabled.push('media');
    if (allowTrip) enabled.push('trip');
    if (!enabled.length) return 'off';

    const cycle = enabled.concat(['off']);
    const stepRaw = (media && typeof media.bcStep === 'number') ? media.bcStep
        : (media && typeof media.bcClicks === 'number' ? media.bcClicks
            : (media && media.page ? Math.max(0, PAGES.indexOf(media.page)) : 0));
    const idx = ((stepRaw % cycle.length) + cycle.length) % cycle.length;
    const picked = cycle[idx];
    if (idx === 0 && picked === 'media' && !(media && media.active) && enabled.indexOf('trip') >= 0) {
        return 'trip';
    }
    return picked;
}

module.exports = {
    COVER_SIDE,
    PAGES,
    MediaTracker,
    parseHmiPlayerMetadata,
    parseMediaPlayerMetadata,
    parseTimeStruct,
    paginateTitle,
    resolveRightWidgetPage,
    cleanMediaText,
    fnv1aHex,
    normId,
    getDemoCover,
};
