'use strict';
/**
 * bmw_font.js - Runtime TrueType (glyf/loca/cmap) anti-aliased atlas builder for stock BMW MGU fonts.
 *
 * Reads BMW's on-unit HMI TrueType fonts directly from `/mnt/dataro/dataro2/hmi/common/font/`
 * (`BMWTARG.ttf` Regular + `BMWTALG.ttf` Light, or `BMW_FONT_DIR` in local dev/simulator),
 * rasterizes crisp 4x4-supersampled glyph atlases at startup, caches them in the app's data directory,
 * and hooks into `kit/fonts` so every cluster & HUD text element uses genuine BMW typography
 * without bundling proprietary font binaries in the public repository.
 *
 * Falls back transparently to the bundled open-source fonts whenever `/mnt/dataro/...` is absent.
 * Strict Node 8.16.2 (ES2017): zero external dependencies.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_MGU_FONT_DIR = '/mnt/dataro/dataro2/hmi/common/font';
const SHARED_FONT_DIR = '/var/opt/cluster-render/fonts';
const LATIN_PACK_FILENAME = 'latin_auto.pack';
const CJK_PACK_FILENAME = 'cjk_gothic.pack';
const GLYPH_CACHE_MAX = 1600;
const EMPTY_ALPHA = new Uint8Array(0);
const PLAIN_FALLBACK = {
    0x2018: 0x27, 0x2019: 0x27, 0x201c: 0x22, 0x201d: 0x22,
    0x2013: 0x2d, 0x2014: 0x2d, 0x00a0: 0x20, 0x3000: 0x20,
    0xff08: 0x28, 0xff09: 0x29, 0xff5e: 0x7e, 0xff01: 0x21,
    0xff1f: 0x3f, 0xff1a: 0x3a,
};

const TEXT_CHARS = (function () {
    let s = '';
    for (let c = 32; c < 127; c++) s += String.fromCharCode(c);
    return s + '\u00b0\u00b1\u00b7\u2013\u2014\u2026';
})();
const DIGIT_CHARS = '0123456789.,:-+%\u00b0/ kmhKMHrpmbarpsiVNCFgsxRPDSWLOTAM';

function parseTtf(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 64) return null;
    const numTables = buf.readUInt16BE(4);
    const tables = Object.create(null);
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        if (rec + 16 > buf.length) break;
        const tag = buf.toString('ascii', rec, rec + 4);
        tables[tag] = {
            off: buf.readUInt32BE(rec + 8),
            len: buf.readUInt32BE(rec + 12),
        };
    }
    if (!tables.head || !tables.hhea || !tables.hmtx || !tables.maxp || !tables.loca || !tables.glyf || !tables.cmap) {
        return null;
    }

    const headOff = tables.head.off;
    const unitsPerEm = buf.readUInt16BE(headOff + 18);
    const indexToLocFormat = buf.readInt16BE(headOff + 50);

    const hheaOff = tables.hhea.off;
    const ascent = buf.readInt16BE(hheaOff + 4);
    const descent = buf.readInt16BE(hheaOff + 6);
    const numHMetrics = buf.readUInt16BE(hheaOff + 34);

    const numGlyphs = buf.readUInt16BE(tables.maxp.off + 4);

    // Parse cmap (prefer format 12 full Unicode, else format 4 BMP)
    const cmapBase = tables.cmap.off;
    const cmapNum = buf.readUInt16BE(cmapBase + 2);
    let fmt4Off = 0;
    let fmt12Off = 0;
    for (let i = 0; i < cmapNum; i++) {
        const rec = cmapBase + 4 + i * 8;
        const pid = buf.readUInt16BE(rec);
        const eid = buf.readUInt16BE(rec + 2);
        const subOff = cmapBase + buf.readUInt32BE(rec + 4);
        if (subOff + 4 > buf.length) continue;
        const fmt = buf.readUInt16BE(subOff);
        if (fmt === 12 && (pid === 3 || pid === 0)) fmt12Off = subOff;
        else if (fmt === 4 && (pid === 3 || pid === 0) && (!fmt4Off || (pid === 3 && eid === 1))) fmt4Off = subOff;
    }

    let cmapLookup = null;
    if (fmt12Off) {
        const nGroups = buf.readUInt32BE(fmt12Off + 12);
        const groupsOff = fmt12Off + 16;
        cmapLookup = function (cp) {
            let lo = 0, hi = nGroups - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const gOff = groupsOff + mid * 12;
                const startCp = buf.readUInt32BE(gOff);
                if (cp < startCp) { hi = mid - 1; continue; }
                const endCp = buf.readUInt32BE(gOff + 4);
                if (cp > endCp) { lo = mid + 1; continue; }
                return (buf.readUInt32BE(gOff + 8) + (cp - startCp)) & 0xffff;
            }
            return 0;
        };
    } else if (fmt4Off) {
        const segCount = buf.readUInt16BE(fmt4Off + 6) >> 1;
        const endCodeOff = fmt4Off + 14;
        const startCodeOff = endCodeOff + segCount * 2 + 2;
        const idDeltaOff = startCodeOff + segCount * 2;
        const idRangeOff = idDeltaOff + segCount * 2;
        cmapLookup = function (cp) {
            if (cp > 0xffff) return 0;
            let lo = 0, hi = segCount - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const endCp = buf.readUInt16BE(endCodeOff + mid * 2);
                if (cp > endCp) { lo = mid + 1; continue; }
                const startCp = buf.readUInt16BE(startCodeOff + mid * 2);
                if (cp < startCp) { hi = mid - 1; continue; }
                const rangeOffset = buf.readUInt16BE(idRangeOff + mid * 2);
                const idDelta = buf.readInt16BE(idDeltaOff + mid * 2);
                if (rangeOffset === 0) return (cp + idDelta) & 0xffff;
                const glyphAddr = idRangeOff + mid * 2 + rangeOffset + (cp - startCp) * 2;
                if (glyphAddr + 2 > buf.length) return 0;
                const gid = buf.readUInt16BE(glyphAddr);
                return gid === 0 ? 0 : ((gid + idDelta) & 0xffff);
            }
            return 0;
        };
    } else {
        return null;
    }

    const hmtxOff = tables.hmtx.off;
    function advanceUnits(gid) {
        const idx = gid < numHMetrics ? gid : (numHMetrics - 1);
        return buf.readUInt16BE(hmtxOff + idx * 4);
    }

    const locaOff = tables.loca.off;
    const glyfBase = tables.glyf.off;
    function glyphSlice(gid) {
        if (gid < 0 || gid >= numGlyphs) return null;
        let g0, g1;
        if (indexToLocFormat === 0) {
            g0 = buf.readUInt16BE(locaOff + gid * 2) * 2;
            g1 = buf.readUInt16BE(locaOff + (gid + 1) * 2) * 2;
        } else {
            g0 = buf.readUInt32BE(locaOff + gid * 4);
            g1 = buf.readUInt32BE(locaOff + (gid + 1) * 4);
        }
        if (g1 <= g0) return null;
        return { off: glyfBase + g0, end: glyfBase + g1 };
    }

    function decodeContours(gid, depth) {
        if ((depth || 0) > 6) return [];
        const sl = glyphSlice(gid);
        if (!sl || sl.off + 10 > buf.length) return [];
        const nContours = buf.readInt16BE(sl.off);
        if (nContours === 0) return [];

        if (nContours > 0) {
            let p = sl.off + 10;
            const endPts = new Array(nContours);
            for (let i = 0; i < nContours; i++, p += 2) endPts[i] = buf.readUInt16BE(p);
            const numPts = endPts[nContours - 1] + 1;
            const insLen = buf.readUInt16BE(p);
            p += 2 + insLen;

            const flags = new Uint8Array(numPts);
            for (let i = 0; i < numPts; i++) {
                const fl = buf[p++];
                flags[i] = fl;
                if (fl & 0x08) {
                    const rep = buf[p++];
                    for (let r = 0; r < rep && i + 1 < numPts; r++) flags[++i] = fl;
                }
            }
            const xs = new Int16Array(numPts);
            let curX = 0;
            for (let i = 0; i < numPts; i++) {
                const fl = flags[i];
                if (fl & 0x02) {
                    const dx = buf[p++];
                    curX += (fl & 0x10) ? dx : -dx;
                } else if (!(fl & 0x10)) {
                    curX += buf.readInt16BE(p);
                    p += 2;
                }
                xs[i] = curX;
            }
            const ys = new Int16Array(numPts);
            let curY = 0;
            for (let i = 0; i < numPts; i++) {
                const fl = flags[i];
                if (fl & 0x04) {
                    const dy = buf[p++];
                    curY += (fl & 0x20) ? dy : -dy;
                } else if (!(fl & 0x20)) {
                    curY += buf.readInt16BE(p);
                    p += 2;
                }
                ys[i] = curY;
            }

            const contours = [];
            let start = 0;
            for (let c = 0; c < nContours; c++) {
                const end = endPts[c];
                const pts = [];
                for (let i = start; i <= end; i++) {
                    pts.push({ x: xs[i], y: ys[i], on: Boolean(flags[i] & 0x01) });
                }
                contours.push(pts);
                start = end + 1;
            }
            return contours;
        }

        // Composite glyph (nContours < 0)
        let p = sl.off + 10;
        const out = [];
        let more = true;
        while (more && p + 4 <= sl.end) {
            const cFlags = buf.readUInt16BE(p);
            const subGid = buf.readUInt16BE(p + 2);
            p += 4;
            let dx = 0, dy = 0;
            if (cFlags & 0x0001) {
                if (cFlags & 0x0002) { dx = buf.readInt16BE(p); dy = buf.readInt16BE(p + 2); }
                p += 4;
            } else {
                if (cFlags & 0x0002) { dx = buf.readInt8(p); dy = buf.readInt8(p + 1); }
                p += 2;
            }
            let a = 1, b = 0, c = 0, d = 1;
            if (cFlags & 0x0008) {
                a = d = buf.readInt16BE(p) / 16384; p += 2;
            } else if (cFlags & 0x0040) {
                a = buf.readInt16BE(p) / 16384; d = buf.readInt16BE(p + 2) / 16384; p += 4;
            } else if (cFlags & 0x0080) {
                a = buf.readInt16BE(p) / 16384; b = buf.readInt16BE(p + 2) / 16384;
                c = buf.readInt16BE(p + 4) / 16384; d = buf.readInt16BE(p + 6) / 16384; p += 8;
            }
            const sub = decodeContours(subGid, (depth || 0) + 1);
            for (let i = 0; i < sub.length; i++) {
                out.push(sub[i].map((pt) => ({
                    x: pt.x * a + pt.y * c + dx,
                    y: pt.x * b + pt.y * d + dy,
                    on: pt.on,
                })));
            }
            more = Boolean(cFlags & 0x0020);
        }
        return out;
    }

    return {
        unitsPerEm,
        numGlyphs,
        ascent,
        descent,
        cmapLookup,
        advanceUnits,
        decodeContours,
    };
}

function flattenContourToEdges(rawPts, scale, emboldenHalfPx) {
    const n = rawPts.length;
    if (n < 2) return [];
    // Expand implicit on-curve midpoints between consecutive off-curve control points
    const closed = [];
    for (let i = 0; i < n; i++) {
        const cur = rawPts[i];
        const nxt = rawPts[(i + 1) % n];
        closed.push(cur);
        if (!cur.on && !nxt.on) {
            closed.push({ x: (cur.x + nxt.x) * 0.5, y: (cur.y + nxt.y) * 0.5, on: true });
        }
    }
    // Ensure contour starts at an on-curve point
    let firstOn = 0;
    while (firstOn < closed.length && !closed[firstOn].on) firstOn++;
    let ordered;
    if (firstOn === closed.length) {
        const mid = { x: (closed[0].x + closed[1].x) * 0.5, y: (closed[0].y + closed[1].y) * 0.5, on: true };
        ordered = [mid].concat(closed);
    } else if (firstOn > 0) {
        ordered = closed.slice(firstOn).concat(closed.slice(0, firstOn));
    } else {
        ordered = closed;
    }

    // Screen space: x right, y down (baseline at y = 0)
    const poly = [];
    const pushPt = (ux, uy) => {
        poly.push([ux * scale + emboldenHalfPx, -uy * scale]);
    };

    let idx = 0;
    const len = ordered.length;
    pushPt(ordered[0].x, ordered[0].y);
    while (idx < len) {
        const p0 = ordered[idx];
        const p1 = ordered[(idx + 1) % len];
        if (p1.on) {
            pushPt(p1.x, p1.y);
            idx += 1;
        } else {
            const p2 = ordered[(idx + 2) % len];
            const x0 = p0.x * scale + emboldenHalfPx, y0 = -p0.y * scale;
            const cx = p1.x * scale + emboldenHalfPx, cy = -p1.y * scale;
            const x2 = p2.x * scale + emboldenHalfPx, y2 = -p2.y * scale;
            const chord = Math.hypot(x2 - x0, y2 - y0) + Math.hypot(cx - x0, cy - y0);
            const steps = Math.max(2, Math.min(12, Math.ceil(chord / 2.5)));
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const mt = 1 - t;
                poly.push([
                    mt * mt * x0 + 2 * mt * t * cx + t * t * x2,
                    mt * mt * y0 + 2 * mt * t * cy + t * t * y2,
                ]);
            }
            idx += 2;
        }
    }

    const edges = [];
    for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i], b = poly[i + 1];
        if (Math.abs(a[1] - b[1]) < 1e-6) continue;
        edges.push([a[0], a[1], b[0], b[1]]);
    }
    return edges;
}

function rasterizeGlyph(ttf, cp, pxSize, emboldenRatio) {
    const gid = ttf.cmapLookup(cp);
    const scale = pxSize / ttf.unitsPerEm;
    const embPx = emboldenRatio ? (pxSize * emboldenRatio) : 0;
    const adv = ttf.advanceUnits(gid) * scale + embPx;
    const contours = gid ? ttf.decodeContours(gid, 0) : [];
    if (!contours.length) {
        return { w: 0, h: 0, ox: 0, oy: 0, adv, bmp: null };
    }

    const allEdges = [];
    for (let i = 0; i < contours.length; i++) {
        const es = flattenContourToEdges(contours[i], scale, 0);
        for (let j = 0; j < es.length; j++) allEdges.push(es[j]);
    }
    if (!allEdges.length) {
        return { w: 0, h: 0, ox: 0, oy: 0, adv, bmp: null };
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < allEdges.length; i++) {
        const e = allEdges[i];
        if (e[0] < minX) minX = e[0];
        if (e[2] < minX) minX = e[2];
        if (e[0] > maxX) maxX = e[0];
        if (e[2] > maxX) maxX = e[2];
        if (e[1] < minY) minY = e[1];
        if (e[3] < minY) minY = e[3];
        if (e[1] > maxY) maxY = e[1];
        if (e[3] > maxY) maxY = e[3];
    }

    const ox = Math.floor(minX);
    const oy = Math.floor(minY);
    const extraW = embPx > 0 ? Math.ceil(embPx) + 1 : 0;
    const w = Math.max(1, Math.ceil(maxX) - ox + extraW);
    const h = Math.max(1, Math.ceil(maxY) - oy);
    const SUB_Y = 4;
    const SUB_X = 4;
    const covBuf = new Float32Array(w * h);

    for (let py = 0; py < h; py++) {
        for (let sy = 0; sy < SUB_Y; sy++) {
            const scanY = oy + py + (sy + 0.5) / SUB_Y;
            const xings = [];
            for (let i = 0; i < allEdges.length; i++) {
                const e = allEdges[i];
                const y0 = e[1], y1 = e[3];
                if ((y0 <= scanY && y1 > scanY) || (y1 <= scanY && y0 > scanY)) {
                    const dir = y1 > y0 ? 1 : -1;
                    const ix = e[0] + ((scanY - y0) / (y1 - y0)) * (e[2] - e[0]);
                    xings.push({ x: ix, dir });
                }
            }
            if (!xings.length) continue;
            xings.sort((a, b) => a.x - b.x);

            // Non-zero winding intervals
            let wind = 0;
            let spanStart = 0;
            for (let i = 0; i < xings.length; i++) {
                const prev = wind;
                wind += xings[i].dir;
                if (prev === 0 && wind !== 0) {
                    spanStart = xings[i].x;
                } else if (prev !== 0 && wind === 0) {
                    const xA = spanStart - ox;
                    const xB = xings[i].x - ox + embPx;
                    const p0 = Math.max(0, Math.floor(xA));
                    const p1 = Math.min(w - 1, Math.floor(xB));
                    for (let px = p0; px <= p1; px++) {
                        let hit = 0;
                        for (let sx = 0; sx < SUB_X; sx++) {
                            const sampleX = px + (sx + 0.5) / SUB_X;
                            if (sampleX >= xA && sampleX <= xB) hit++;
                        }
                        if (hit > 0) covBuf[py * w + px] += hit / (SUB_X * SUB_Y);
                    }
                }
            }
        }
    }

    const bmp = new Uint8Array(w * h);
    for (let i = 0; i < bmp.length; i++) {
        bmp[i] = Math.min(255, Math.round(covBuf[i] * 255));
    }
    return { w, h, ox, oy, adv, bmp };
}

function bakeSizeAtlas(ttf, pxSize, charset, emboldenRatio) {
    const scale = pxSize / ttf.unitsPerEm;
    const ascent = Math.round(ttf.ascent * scale);
    const descent = Math.round(-ttf.descent * scale);
    const W = 1024;
    let x = 0, y = 0, rowH = 0;
    const placed = [];

    for (let i = 0; i < charset.length; i++) {
        const cp = charset.charCodeAt(i);
        const g = rasterizeGlyph(ttf, cp, pxSize, emboldenRatio);
        if (!g.bmp) {
            placed.push({ cp, px: 0, py: 0, g });
            continue;
        }
        if (x + g.w > W) {
            x = 0;
            y += rowH + 1;
            rowH = 0;
        }
        placed.push({ cp, px: x, py: y, g });
        x += g.w + 1;
        if (g.h > rowH) rowH = g.h;
    }

    const H = Math.max(1, y + rowH + 1);
    const atlas = Buffer.alloc(W * H);
    const glyphs = Object.create(null);

    for (let i = 0; i < placed.length; i++) {
        const it = placed[i];
        const g = it.g;
        if (g.bmp) {
            for (let ry = 0; ry < g.h; ry++) {
                const srcOff = ry * g.w;
                const dstOff = (it.py + ry) * W + it.px;
                for (let rx = 0; rx < g.w; rx++) {
                    atlas[dstOff + rx] = g.bmp[srcOff + rx];
                }
            }
        }
        glyphs[it.cp] = [it.px, it.py, g.w, g.h, g.ox, g.oy, Math.round(g.adv * 100) / 100];
    }

    return {
        size: pxSize,
        ascent,
        descent,
        atlasW: W,
        atlasH: H,
        alpha: atlas,
        glyphs,
    };
}

function serializeFamilies(fams) {
    const out = {};
    const names = Object.keys(fams);
    for (let i = 0; i < names.length; i++) {
        const k = names[i];
        out[k] = fams[k].map((s) => ({
            size: s.size,
            ascent: s.ascent,
            descent: s.descent,
            atlasW: s.atlasW,
            atlasH: s.atlasH,
            glyphs: s.glyphs,
            alphaB64: zlib.deflateSync(s.alpha, { level: 6 }).toString('base64'),
        }));
    }
    return JSON.stringify({ v: 1, families: out });
}

function deserializeFamilies(jsonStr) {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || parsed.v !== 1 || !parsed.families) return null;
    const out = Object.create(null);
    const names = Object.keys(parsed.families);
    for (let i = 0; i < names.length; i++) {
        const k = names[i];
        out[k] = parsed.families[k].map((s) => ({
            size: s.size,
            ascent: s.ascent,
            descent: s.descent,
            atlasW: s.atlasW,
            atlasH: s.atlasH,
            glyphs: s.glyphs,
            alpha: zlib.inflateSync(Buffer.from(s.alphaB64, 'base64')),
            family: k,
            cacheKey: 'bmw_' + k,
        }));
    }
    return out;
}

let hookedFontsMod = null;
let origGetFn = null;
let origResolveFn = null;
let bmwTtfRg = null;
let bmwTtfLg = null;
let latinPackTried = false;
let cjkTtf = null;
let cjkTried = false;
let cjkSource = '';
let activeSource = 'bundled_ubuntu';
let activeFontDir = '';
let lastFontError = '';

const dynHandleCache = Object.create(null);
const glyphCache = new Map();

function loadBundledLatinTtf(log) {
    if (latinPackTried) return null;
    latinPackTried = true;
    const packPath = path.join(__dirname, LATIN_PACK_FILENAME);
    try {
        if (!fs.existsSync(packPath)) return null;
        const raw = fs.readFileSync(packPath);
        if (raw.length < 16 || raw.toString('ascii', 0, 5) !== 'LAUT1') return null;
        const t0 = Date.now();
        const ttf = parseTtf(zlib.inflateSync(raw.slice(12)));
        if (ttf && log && typeof log.info === 'function') {
            log.info('bmw_font: loaded bundled vector Latin (' + ttf.numGlyphs + ' glyphs, ' + (Date.now() - t0) + 'ms)');
        }
        return ttf;
    } catch (e) {
        return null;
    }
}

function loadCjkVectorTtf(log) {
    if (cjkTried) return cjkTtf;
    cjkTried = true;
    const packPath = path.join(__dirname, CJK_PACK_FILENAME);
    try {
        if (!fs.existsSync(packPath)) return null;
        const raw = fs.readFileSync(packPath);
        if (raw.length < 16 || raw.toString('ascii', 0, 5) !== 'CGOT1') return null;
        const t0 = Date.now();
        const ttfBuf = zlib.inflateSync(raw.slice(12));
        cjkTtf = parseTtf(ttfBuf);
        if (cjkTtf) {
            cjkSource = 'vector_cjk';
            if (log && typeof log.info === 'function') {
                log.info('bmw_font: loaded vector CJK (' + cjkTtf.numGlyphs + ' glyphs, ' + (Date.now() - t0) + 'ms)');
            }
        }
    } catch (e) {
        cjkTtf = null;
        if (log && typeof log.warn === 'function') {
            log.warn('bmw_font: cjk pack load failed: ' + (e && e.message || e));
        }
    }
    return cjkTtf;
}

function getOrRasterizeGlyph(ttf, fontTag, pxSize, emb, cp) {
    const key = fontTag + ':' + pxSize + ':' + cp;
    const hit = glyphCache.get(key);
    if (hit !== undefined) return hit;

    const g = rasterizeGlyph(ttf, cp, pxSize, emb);
    const scale = pxSize / ttf.unitsPerEm;
    const entry = {
        font: {
            size: pxSize,
            ascent: Math.round(ttf.ascent * scale),
            descent: Math.round(-ttf.descent * scale),
            atlasW: g.w,
            atlasH: g.h,
            alpha: g.bmp || EMPTY_ALPHA,
        },
        g: [0, 0, g.w, g.h, g.ox, g.oy, Math.round(g.adv * 100) / 100],
    };
    glyphCache.set(key, entry);
    if (glyphCache.size > GLYPH_CACHE_MAX) {
        const oldest = glyphCache.keys().next().value;
        glyphCache.delete(oldest);
    }
    return entry;
}

function getDynamicHandle(familyName, pxSize) {
    const sz = Math.max(8, Math.round(pxSize));
    const key = familyName + ':' + sz;
    if (dynHandleCache[key]) return dynHandleCache[key];

    const isLight = familyName === 'light';
    const isCjk = familyName === 'cjk';
    const ttf = isCjk ? loadCjkVectorTtf(null) : (isLight ? (bmwTtfLg || bmwTtfRg) : bmwTtfRg);
    if (!ttf) return null;

    const emb = familyName === 'bold' ? 0.011
        : (familyName === 'num' ? 0.008 : 0);
    const scale = sz / ttf.unitsPerEm;
    const handle = {
        _vec: familyName,
        _ttf: ttf,
        _emb: emb,
        size: sz,
        ascent: Math.round(ttf.ascent * scale),
        descent: Math.round(-ttf.descent * scale),
        atlasW: 0,
        atlasH: 0,
        alpha: EMPTY_ALPHA,
        glyphs: Object.create(null),
        family: familyName,
        cacheKey: 'vec_' + familyName + '_' + sz,
    };
    dynHandleCache[key] = handle;
    return handle;
}

function ensureFontsHooked(fontsMod, log) {
    if (!fontsMod || typeof fontsMod.get !== 'function') return;
    if (hookedFontsMod === fontsMod) return;
    hookedFontsMod = fontsMod;
    origGetFn = fontsMod.get;
    origResolveFn = fontsMod.resolveGlyph;

    fontsMod.get = function (name, size, text) {
        if (name !== 'cjk' && text && /[\u0400-\u04ff]/.test(text)) {
            return origGetFn.call(fontsMod, 'cyrillic', size, text);
        }
        if (name === 'cyrillic' || name === 'gear') {
            return origGetFn.call(fontsMod, name, size, text);
        }
        if (name === 'cjk') {
            const ch = getDynamicHandle('cjk', size);
            return ch || origGetFn.call(fontsMod, 'cjk', size, text);
        }
        if (bmwTtfRg) {
            const fam = (name === 'bold' || name === 'num' || name === 'light') ? name : 'label';
            const h = getDynamicHandle(fam, size);
            if (h) return h;
        }
        return origGetFn.call(fontsMod, name, size, text);
    };

    fontsMod.resolveGlyph = function (primaryFont, cp) {
        if (!primaryFont) return null;

        // 1. Dynamic 1:1 native-pixel vector font handle (BMWTARG / BMWTALG / Vector CJK)
        if (primaryFont._vec && primaryFont._ttf) {
            const ttf = primaryFont._ttf;
            const sz = primaryFont.size;
            let gid = ttf.cmapLookup(cp);
            if (gid !== 0 || cp === 0x20) {
                return getOrRasterizeGlyph(ttf, primaryFont._vec, sz, primaryFont._emb, cp);
            }
            const plain = PLAIN_FALLBACK[cp];
            if (plain && ttf.cmapLookup(plain) !== 0) {
                return getOrRasterizeGlyph(ttf, primaryFont._vec, sz, primaryFont._emb, plain);
            }
            if (cp > 0x7e) {
                const ct = loadCjkVectorTtf(log);
                if (ct && ct.cmapLookup(cp) !== 0) {
                    const cjkEmb = primaryFont._vec === 'bold' ? 0.005 : 0;
                    const cjkTag = primaryFont._vec === 'bold' ? 'cjk_b' : 'cjk';
                    return getOrRasterizeGlyph(ct, cjkTag, sz, cjkEmb, cp);
                }
                if (origResolveFn) {
                    const legacy = origResolveFn.call(fontsMod, primaryFont, cp);
                    if (legacy && legacy.g) return legacy;
                }
            }
            if (ttf.cmapLookup(63) !== 0) {
                return getOrRasterizeGlyph(ttf, primaryFont._vec, sz, primaryFont._emb, 63);
            }
            return null;
        }

        // 2. Bundled Ubuntu primary font -> still upgrade non-ASCII CJK glyphs to crisp vector Gothic!
        if (primaryFont.glyphs && Object.prototype.hasOwnProperty.call(primaryFont.glyphs, cp)) {
            return { font: primaryFont, g: primaryFont.glyphs[cp] };
        }
        const plain = PLAIN_FALLBACK[cp];
        if (plain && primaryFont.glyphs && Object.prototype.hasOwnProperty.call(primaryFont.glyphs, plain)) {
            return { font: primaryFont, g: primaryFont.glyphs[plain] };
        }
        if (cp > 0x7e) {
            const ct = loadCjkVectorTtf(log);
            if (ct && ct.cmapLookup(cp) !== 0) {
                const sz = Math.max(12, Math.round(primaryFont.size || 28));
                const cjkEmb = primaryFont.family === 'bold' ? 0.005 : 0;
                const cjkTag = primaryFont.family === 'bold' ? 'cjk_b' : 'cjk';
                return getOrRasterizeGlyph(ct, cjkTag, sz, cjkEmb, cp);
            }
        }
        return origResolveFn ? origResolveFn.call(fontsMod, primaryFont, cp) : null;
    };

    fontsMod.measureMixed = function (f, size, s, spacing) {
        if (!f || s === undefined || s === null) return 0;
        const str = String(s);
        const sp = spacing || 0;
        let w = 0;
        let count = 0;
        for (const ch of str) {
            const rg = fontsMod.resolveGlyph(f, ch.codePointAt(0));
            if (rg && rg.g) {
                w += rg.g[6] * (size / rg.font.size);
            }
            count++;
        }
        return w + sp * Math.max(0, count - 1);
    };

    fontsMod.measure = function (f, s) {
        if (!f) return 0;
        return fontsMod.measureMixed(f, f.size, s, 0);
    };
}

/**
 * Load BMW's stock `BMWTARG.ttf` & `BMWTALG.ttf` (plus bundled SIL OFL 1.1 vector CJK Gothic)
 * using exact 1:1 native-pixel on-demand rasterization (zero startup bake lag, zero bilinear blur).
 */
function installStockBmwFonts(fontsMod, opts) {
    const o = opts || {};
    const log = o.log || null;
    const cacheDir = o.cacheDir || process.env.CLUSTER_METRICS_DATA_DIR || null;

    // Always install hooks so vector CJK Gothic is active even when BMW TTF is unavailable!
    ensureFontsHooked(fontsMod, log);

    if (bmwTtfRg && activeSource === 'bmw_stock_ttf') return activeSource;

    const dirs = [];
    const addDir = (d) => {
        if (d && typeof d === 'string' && dirs.indexOf(d) < 0) dirs.push(d);
    };
    if (!o.bundledOnly) {
    addDir(o.fontDir);
    addDir(process.env.BMW_FONT_DIR);
    addDir(SHARED_FONT_DIR);
    if (cacheDir) {
        addDir(path.join(cacheDir, 'fonts'));
        addDir(cacheDir);
    }
    addDir(DEFAULT_MGU_FONT_DIR);
    }

    let rgBuf = null;
    let lgBuf = null;
    let foundDir = '';
    let firstErr = '';

    for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        const rgPath = path.join(dir, 'BMWTARG.ttf');
        try {
            rgBuf = fs.readFileSync(rgPath);
            foundDir = dir;
            try { lgBuf = fs.readFileSync(path.join(dir, 'BMWTALG.ttf')); } catch (e2) { lgBuf = null; }
            break;
        } catch (e) {
            const code = (e && e.code) ? String(e.code) : String(e && e.message || e);
            if (!firstErr || (firstErr === 'ENOENT' && code !== 'ENOENT')) {
                firstErr = code;
            }
        }
    }

    if (!rgBuf) {
        lastFontError = firstErr || 'ENOENT';
        const bundledLat = loadBundledLatinTtf(log);
        if (bundledLat) {
            bmwTtfRg = bundledLat;
            bmwTtfLg = bundledLat;
            activeSource = 'bundled_vector_sans';
            activeFontDir = LATIN_PACK_FILENAME;
            return activeSource;
        }
        if (log && typeof log.info === 'function') {
            log.info('bmw_font: stock BMWTARG.ttf unavailable (' + lastFontError + '); using bundled Ubuntu + vector CJK');
        }
        return activeSource;
    }

    try {
        const t0 = Date.now();
        const ttfRg = parseTtf(rgBuf);
        const ttfLg = lgBuf ? parseTtf(lgBuf) : ttfRg;
        if (!ttfRg) {
            lastFontError = 'PARSE';
            return activeSource;
        }
        bmwTtfRg = ttfRg;
        bmwTtfLg = ttfLg || ttfRg;
        Object.keys(dynHandleCache).forEach((k) => { delete dynHandleCache[k]; });
        glyphCache.clear();
        activeSource = 'bmw_stock_ttf';
        activeFontDir = foundDir;
        lastFontError = '';
        if (log && typeof log.info === 'function') {
            log.info('bmw_font: active 1:1 vector (source=' + foundDir + ', ' + (Date.now() - t0) + 'ms)');
        }
    } catch (e) {
        lastFontError = String((e && e.code) || (e && e.message) || e).slice(0, 24);
        if (log && typeof log.warn === 'function') {
            log.warn('bmw_font: parse failed: ' + (e && e.stack || e));
        }
    }
    return activeSource;
}

function getFontSource() {
    return activeSource;
}

function getFontStatus() {
    return { source: activeSource, dir: activeFontDir, error: lastFontError, cjk: cjkSource };
}

module.exports = {
    SHARED_FONT_DIR,
    DEFAULT_MGU_FONT_DIR,
    LATIN_PACK_FILENAME,
    CJK_PACK_FILENAME,
    parseTtf,
    rasterizeGlyph,
    bakeSizeAtlas,
    installStockBmwFonts,
    getFontSource,
    getFontStatus,
};
