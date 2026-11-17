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

const COVER_SIDE = 124;
const META_KEYS = { 3: 'TITLE', 5: 'ARTIST', 7: 'ALBUM', 9: 'ALBUM_ARTIST', 17: 'COVER_FILE', 32: 'PERFORMER' };
const ITEM_TYPES = { 1: 'ARTIST', 2: 'ALBUM', 3: 'TITLE', ARTIST: 'ARTIST', ALBUM: 'ALBUM', TITLE: 'TITLE' };
const PAGES = ['media', 'trip', 'off'];

function isObj(v) { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }

function cleanMediaText(raw, maxLen) {
    if (typeof raw !== 'string') return '';
    const rawTrim = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!rawTrim) return '';
    const folded = foldAscii(rawTrim);
    if (!folded) return rawTrim.length > 0 ? '[Track]' : '';
    const lim = maxLen || 64;
    return folded.length > lim ? (folded.slice(0, lim - 3).trim() + '...') : folded;
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
        const title = cleanMediaText(map.TITLE || '');
        const artist = cleanMediaText(map.ARTIST || map.ALBUM_ARTIST || map.PERFORMER || '');
        const album = cleanMediaText(map.ALBUM || '');
        const coverFile = typeof map.COVER_FILE === 'string' ? map.COVER_FILE.replace(/\0/g, '').trim() : '';
        if (!title && !artist) return null;
        return { title: title || artist, artist: title ? artist : album, album, coverFile };
    }
    if (!isObj(meta)) return null;
    const t = cleanMediaText(meta.title || meta.track || '');
    const a = cleanMediaText(meta.artist || meta.performer || '');
    if (!t && !a) return null;
    return { title: t || a, artist: t ? a : '', album: cleanMediaText(meta.album || ''), coverFile: '' };
}

function parseHmiPlayerMetadata(v) {
    if (!isObj(v)) return null;
    const l1 = typeof v.firstLineText === 'string' ? v.firstLineText.replace(/\0/g, '').trim() : '';
    const l2 = typeof v.secondLineText === 'string' ? v.secondLineText.replace(/\0/g, '').trim() : '';
    const l3 = typeof v.threeRowText === 'string' ? v.threeRowText.replace(/\0/g, '').trim() : '';
    const t1 = ITEM_TYPES[v.firstLineType] || '';
    const t2 = ITEM_TYPES[v.secondLineType] || '';

    let rawTitle = l1;
    let rawSub = l2;
    if (t2 === 'TITLE' && t1 === 'ARTIST' && l2) {
        rawTitle = l2;
        rawSub = l1;
    }
    if (!rawTitle && l3) {
        const parts = l3.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        rawTitle = parts[0] || '';
        rawSub = parts[1] || '';
    }
    const title = cleanMediaText(rawTitle);
    const artist = cleanMediaText(rawSub);
    const trackId = typeof v.trackId === 'number' && isFinite(v.trackId) ? v.trackId : null;
    if (!title && !artist) return { empty: true, trackId };
    return { empty: false, title: title || artist, artist: title ? artist : '', trackId };
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
        this.mpMeta = null;
        this.time = null; // { elapsedSec, totalSec, atMs }
        this.playing = true;
        this.source = '';
        this.cover = null; // { w, h, d, accent, id }
        this.coverRev = 0;
        this.coverCache = []; // [{ key, cover }]
        this._chunkState = null; // { id, totalSize, buf, written }
        this._decodeTimer = null;
        this._decodeSeq = 0;

        // Right-wing BC page cycling state
        this.pageIndex = 0; // 0='media', 1='trip', 2='off'
        this.bcClicks = 0;
        this.lastBcAt = 0;
        this.lastBcSource = '';
        this._kombiSelBase = null;
        this._stalkRest = null;
        this._stalkDownVal = null;
        this._stalkDownAt = 0;
        this._lastTurnSignalAt = 0;
        this._hbaDown = false;
        this._hbaTaps = 0;
        this._hbaTimer = null;
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

    _applyCoverBytes(key, buf, syncDecode) {
        if (!buf || buf.length < 16 || buf.length > MAX_BYTES) return false;
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
            return true;
        };
        if (syncDecode) return runDecode();
        this._decodeTimer = setTimeout(runDecode, 60);
        if (this._decodeTimer && typeof this._decodeTimer.unref === 'function') this._decodeTimer.unref();
        return true;
    }

    _loadCoverFile(filePath) {
        if (!filePath || typeof filePath !== 'string' || filePath.length > 360) return;
        const key = 'file:' + filePath;
        const cached = this._cacheGet(key);
        if (cached) {
            this.cover = cached;
            this.coverRev++;
            return;
        }
        const seq = ++this._decodeSeq;
        fs.stat(filePath, (err, st) => {
            if (err || !st || !st.isFile() || st.size > MAX_BYTES || seq !== this._decodeSeq || this._stopped) return;
            fs.readFile(filePath, (err2, buf) => {
                if (err2 || !buf || seq !== this._decodeSeq || this._stopped) return;
                this._applyCoverBytes(key, buf, true);
            });
        });
    }

    feedHmiMetadata(v) {
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
        if (prevKey && prevKey !== nextKey) {
            this.time = null;
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
        const chunk = toBytesBuffer(v.coverArt);
        const cid = v.coverArtId !== undefined && v.coverArtId !== null ? String(v.coverArtId) : '';
        const totalSize = typeof v.totalSize === 'number' && isFinite(v.totalSize) ? v.totalSize : (chunk ? chunk.length : 0);
        const offset = typeof v.offset === 'number' && isFinite(v.offset) && v.offset >= 0 ? v.offset : 0;

        if (!chunk || chunk.length === 0 || totalSize <= 0) {
            if (totalSize === 0) {
                this.cover = null;
                this.coverRev++;
            }
            return false;
        }
        if (totalSize > MAX_BYTES) return false;

        if (offset === 0 && chunk.length >= totalSize) {
            this._chunkState = null;
            const full = chunk.length === totalSize ? chunk : chunk.slice(0, totalSize);
            const key = 'hmi:' + (cid || (totalSize + ':' + full[0] + ':' + full[full.length - 1]));
            return this._applyCoverBytes(key, full, Boolean(syncDecode));
        }

        // Multi-chunk CoverArt reassembly
        if (!this._chunkState || this._chunkState.id !== cid || this._chunkState.totalSize !== totalSize) {
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
            const key = 'hmi:' + (cid || st.totalSize);
            return this._applyCoverBytes(key, doneBuf, Boolean(syncDecode));
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
        if (playing !== this.playing) {
            if (this.time) {
                const prog = this._computeProgress(now);
                if (prog) this.time = { elapsedSec: prog.elapsedSec, totalSec: prog.totalSec, atMs: now };
            }
            this.playing = playing;
        }
    }

    feedMediaPlayerMetadata(v) {
        const parsed = parseMediaPlayerMetadata(v);
        const prevTrack = this.mpMeta ? (this.mpMeta.title + '|' + this.mpMeta.artist) : '';
        this.mpMeta = parsed;
        if (!parsed) return;
        if (!this.source) this.source = 'CarPlay';
        const nextTrack = parsed.title + '|' + parsed.artist;
        if (prevTrack && prevTrack !== nextTrack) {
            this.time = null;
        }
        if (parsed.coverFile && !this.cover) {
            this._loadCoverFile(parsed.coverFile);
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
        if (isObj(v) && v.statusPushButtonMainBeamAssistant !== undefined) {
            const hba = v.statusPushButtonMainBeamAssistant;
            const pressed = hba === 'TASTER_GEDRUECKT' || hba === 1;
            if (pressed && !this._hbaDown) {
                this._hbaTaps++;
                if (this._hbaTimer) clearTimeout(this._hbaTimer);
                this._hbaTimer = setTimeout(() => {
                    const n = this._hbaTaps;
                    this._hbaTaps = 0;
                    this._hbaTimer = null;
                    if (n === 2) this.triggerBcClick('stalk_hba_2tap', Date.now());
                }, 620);
                if (this._hbaTimer && typeof this._hbaTimer.unref === 'function') this._hbaTimer.unref();
            }
            this._hbaDown = pressed;
        }
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
        // Returned to resting value: if it was a momentary 25..1100ms button pulse, count as BC click!
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
            artist: 'M83 - Hurry Up, We Are Dreaming',
            elapsedSec,
            totalSec,
            remainSec: totalSec - elapsedSec,
            frac: elapsedSec / totalSec,
            cover: getDemoCover(),
            coverRev: 1,
            page: PAGES[this.pageIndex] || 'media',
            bcClicks: this.bcClicks,
            lastBcSource: this.lastBcSource,
            rawStalk: this.rawStalk,
            rawKombiSel: this.rawKombiSel,
        };
    }

    snapshot(nowMs, isDemo) {
        const now = typeof nowMs === 'number' ? nowMs : Date.now();
        if (isDemo) return this.demoSnapshot(now);

        const meta = this.hmiMeta || this.mpMeta;
        const prog = meta ? this._computeProgress(now) : null;
        const artistLine = meta
            ? (meta.artist && meta.album && meta.artist.indexOf(meta.album) < 0 && (meta.artist.length + meta.album.length < 34)
                ? (meta.artist + ' - ' + meta.album)
                : (meta.artist || meta.album || ''))
            : '';

        return {
            active: Boolean(meta && meta.title),
            playing: this.playing,
            source: this.source || (this.mpMeta ? 'CarPlay' : ''),
            title: meta ? meta.title : '',
            artist: artistLine,
            elapsedSec: prog ? prog.elapsedSec : null,
            totalSec: prog ? prog.totalSec : null,
            remainSec: prog ? prog.remainSec : null,
            frac: prog ? prog.frac : null,
            cover: meta ? this.cover : null,
            coverRev: this.coverRev,
            page: PAGES[this.pageIndex] || 'media',
            bcClicks: this.bcClicks,
            lastBcSource: this.lastBcSource,
            rawStalk: this.rawStalk,
            rawKombiSel: this.rawKombiSel,
        };
    }

    start(ctx, log) {
        this._stopped = false;
        if (!ctx || !ctx.signals || typeof ctx.signals.watch !== 'function') return;

        const addSub = (p) => {
            if (p && typeof p.then === 'function') {
                p.then((r) => {
                    if (!r) return;
                    if (this._stopped) {
                        try { if (r.shutdown) r.shutdown(); } catch (e) { /* ignore */ }
                        return;
                    }
                    this._subs.push(r);
                }).catch(() => {});
            } else if (p) {
                this._subs.push(p);
            }
        };

        try {
            addSub(ctx.signals.watch(
                'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState',
                'HMI_CID',
                {
                    playerMetadata: (v) => this.feedHmiMetadata(v),
                    trackProgress: (v) => this.feedHmiProgress(v, Date.now()),
                    coverArt: (v) => this.feedHmiCoverArt(v, false),
                },
                log
            ));
        } catch (e) { /* optional */ }

        try {
            addSub(ctx.signals.watch(
                'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer',
                'CarPlayMedia',
                {
                    currentItemMetadata: (v) => this.feedMediaPlayerMetadata(v),
                    currentItemTime: (v) => this.feedMediaPlayerTime(v, Date.now()),
                    playerState: (v) => this.feedMediaPlayerState(v, Date.now()),
                },
                log
            ));
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
        if (this._hbaTimer) {
            clearTimeout(this._hbaTimer);
            this._hbaTimer = null;
        }
        for (let i = 0; i < this._subs.length; i++) {
            const s = this._subs[i];
            try {
                if (s && typeof s.stop === 'function') s.stop();
                else if (s && typeof s.shutdown === 'function') s.shutdown();
            } catch (e) { /* ignore */ }
        }
        this._subs = [];
    }
}

module.exports = {
    COVER_SIDE,
    PAGES,
    MediaTracker,
    parseHmiPlayerMetadata,
    parseMediaPlayerMetadata,
    parseTimeStruct,
    getDemoCover,
};
