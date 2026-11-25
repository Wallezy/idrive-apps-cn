'use strict';
/**
 * image_decode.js - Pure-JS JPEG & PNG cover-art decoder and anti-aliased square thumbnailer
 * for Node 8.16.2 (zero native dependencies; uses vendored Apache-2.0 jpeg_decoder.js + builtin zlib).
 *
 * Strict ES2017: no optional chaining, no ??.
 */

const zlib = require('zlib');
let JpegMod = null;
try { JpegMod = require('./jpeg_decoder'); } catch (e) { JpegMod = null; }

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SIDE = 1600;

function isJpeg(buf) {
    return Boolean(Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8);
}

function isPng(buf) {
    return Boolean(Buffer.isBuffer(buf) && buf.length >= 24 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47);
}

/**
 * Inspect JPEG SOF or PNG IHDR dimensions without decoding pixel data.
 */
function imageSize(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
    if (isPng(buf)) {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        return (w > 0 && h > 0) ? { w, h, kind: 'png' } : null;
    }
    if (isJpeg(buf)) {
        let i = 2;
        while (i + 9 < buf.length) {
            if (buf[i] !== 0xFF) { i++; continue; }
            const marker = buf[i + 1];
            if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
            const len = buf.readUInt16BE(i + 2);
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                const h = buf.readUInt16BE(i + 5);
                const w = buf.readUInt16BE(i + 7);
                return (w > 0 && h > 0) ? { w, h, kind: 'jpeg' } : null;
            }
            if (marker === 0xDA || len < 2) return null;
            i += 2 + len;
        }
    }
    return null;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

function decodePng8(buf) {
    if (!isPng(buf)) return null;
    let w = 0, h = 0, depth = 0, colorType = 0, interlace = 0;
    let palette = null;
    const idat = [];
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const dataStart = off + 8;
        const dataEnd = dataStart + len;
        if (dataEnd + 4 > buf.length) break;
        if (type === 'IHDR' && len >= 13) {
            w = buf.readUInt32BE(dataStart);
            h = buf.readUInt32BE(dataStart + 4);
            depth = buf[dataStart + 8];
            colorType = buf[dataStart + 9];
            interlace = buf[dataStart + 12];
        } else if (type === 'PLTE') {
            palette = buf.slice(dataStart, dataEnd);
        } else if (type === 'IDAT') {
            idat.push(buf.slice(dataStart, dataEnd));
        } else if (type === 'IEND') {
            break;
        }
        off = dataEnd + 4;
    }
    if (!w || !h || w > MAX_SIDE || h > MAX_SIDE || depth !== 8 || interlace !== 0 || !idat.length) return null;
    const ch = colorType === 6 ? 4 : (colorType === 2 ? 3 : (colorType === 4 ? 2 : (colorType === 0 || colorType === 3 ? 1 : 0)));
    if (!ch || (colorType === 3 && !palette)) return null;

    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
    const rowBytes = w * ch;
    if (raw.length < h * (1 + rowBytes)) return null;

    const recon = Buffer.allocUnsafe(h * rowBytes);
    for (let y = 0; y < h; y++) {
        const fType = raw[y * (1 + rowBytes)];
        const srcOff = y * (1 + rowBytes) + 1;
        const dstOff = y * rowBytes;
        const prevOff = (y - 1) * rowBytes;
        for (let i = 0; i < rowBytes; i++) {
            const x = raw[srcOff + i];
            const a = i >= ch ? recon[dstOff + i - ch] : 0;
            const b = y > 0 ? recon[prevOff + i] : 0;
            const c = (y > 0 && i >= ch) ? recon[prevOff + i - ch] : 0;
            let val = x;
            if (fType === 1) val = (x + a) & 0xFF;
            else if (fType === 2) val = (x + b) & 0xFF;
            else if (fType === 3) val = (x + ((a + b) >> 1)) & 0xFF;
            else if (fType === 4) val = (x + paeth(a, b, c)) & 0xFF;
            recon[dstOff + i] = val;
        }
    }

    if (colorType === 6) return { w, h, rgba: recon };
    const out = Buffer.allocUnsafe(w * h * 4);
    const nPx = w * h;
    if (colorType === 2) {
        for (let p = 0; p < nPx; p++) {
            out[p * 4] = recon[p * 3];
            out[p * 4 + 1] = recon[p * 3 + 1];
            out[p * 4 + 2] = recon[p * 3 + 2];
            out[p * 4 + 3] = 255;
        }
    } else if (colorType === 0) {
        for (let p = 0; p < nPx; p++) {
            const g = recon[p];
            out[p * 4] = g; out[p * 4 + 1] = g; out[p * 4 + 2] = g; out[p * 4 + 3] = 255;
        }
    } else if (colorType === 4) {
        for (let p = 0; p < nPx; p++) {
            const g = recon[p * 2];
            out[p * 4] = g; out[p * 4 + 1] = g; out[p * 4 + 2] = g; out[p * 4 + 3] = recon[p * 2 + 1];
        }
    } else if (colorType === 3) {
        for (let p = 0; p < nPx; p++) {
            const idx = recon[p] * 3;
            out[p * 4] = palette[idx] || 0;
            out[p * 4 + 1] = palette[idx + 1] || 0;
            out[p * 4 + 2] = palette[idx + 2] || 0;
            out[p * 4 + 3] = 255;
        }
    }
    return { w, h, rgba: out };
}

function decodeJpeg(buf) {
    if (!JpegMod || !isJpeg(buf)) return null;
    try {
        const fn = JpegMod.decode || JpegMod;
        const out = fn(buf, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true });
        if (!out || !out.width || !out.height || !out.data) return null;
        const rgba = Buffer.isBuffer(out.data)
            ? out.data
            : Buffer.from(out.data.buffer || out.data, out.data.byteOffset || 0, out.data.length);
        if (rgba.length < out.width * out.height * 4) return null;
        return { w: out.width, h: out.height, rgba };
    } catch (e) {
        return null;
    }
}

function decodeImage(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.length > MAX_BYTES) return null;
    const dim = imageSize(buf);
    if (!dim || dim.w > MAX_SIDE || dim.h > MAX_SIDE) return null;
    return dim.kind === 'png' ? decodePng8(buf) : decodeJpeg(buf);
}

/**
 * Center-crop to square and box-average downsample to side x side RGBA,
 * while computing a saturated accent RGB color for the right-wing ambient glow.
 */
function shrinkSquare(rgba, sw, sh, side) {
    const s = Math.min(sw, sh);
    const ox = (sw - s) >> 1;
    const oy = (sh - s) >> 1;
    const k = s / side;
    const d = Buffer.allocUnsafe(side * side * 4);
    let sumR = 0, sumG = 0, sumB = 0, sumW = 0;

    for (let y = 0; y < side; y++) {
        const y0 = Math.floor(y * k);
        const y1 = Math.max(y0 + 1, Math.min(s, Math.floor((y + 1) * k)));
        for (let x = 0; x < side; x++) {
            const x0 = Math.floor(x * k);
            const x1 = Math.max(x0 + 1, Math.min(s, Math.floor((x + 1) * k)));
            let r = 0, g = 0, b = 0, c = 0;
            for (let yy = y0; yy < y1; yy++) {
                let off = ((oy + yy) * sw + ox + x0) * 4;
                for (let xx = x0; xx < x1; xx++, off += 4) {
                    r += rgba[off];
                    g += rgba[off + 1];
                    b += rgba[off + 2];
                    c++;
                }
            }
            const o = (y * side + x) * 4;
            const pr = c ? Math.round(r / c) : 0;
            const pg = c ? Math.round(g / c) : 0;
            const pb = c ? Math.round(b / c) : 0;
            d[o] = pr; d[o + 1] = pg; d[o + 2] = pb; d[o + 3] = 255;

            const mx = Math.max(pr, pg, pb), mn = Math.min(pr, pg, pb);
            const wt = 0.25 + (mx - mn) / 255;
            sumR += pr * wt; sumG += pg * wt; sumB += pb * wt; sumW += wt;
        }
    }

    let ar = sumW > 0 ? Math.round(sumR / sumW) : 56;
    let ag = sumW > 0 ? Math.round(sumG / sumW) : 165;
    let ab = sumW > 0 ? Math.round(sumB / sumW) : 245;
    // Ensure glow has pleasant visibility even for dark covers
    const lum = Math.max(ar, ag, ab);
    if (lum < 75) {
        const boost = 75 / Math.max(12, lum);
        ar = Math.min(255, Math.round(ar * boost + 18));
        ag = Math.min(255, Math.round(ag * boost + 28));
        ab = Math.min(255, Math.round(ab * boost + 42));
    }
    return { w: side, h: side, d, accent: [ar, ag, ab] };
}

function decodeCoverThumb(buf, side) {
    const img = decodeImage(buf);
    if (!img) return null;
    return shrinkSquare(img.rgba, img.w, img.h, side || 176);
}

function smoothstep(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

function pwl(pts, x) {
    if (x <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if (x <= b[0]) return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]));
    }
    return last[1];
}

// Homography-calibrated 1920x720 G30 right-wing Power % gauge face (verified against live 530e KOMBI4 photos):
// Fills the pointed top-left eyebrow handle (x=1245..1356, y=91..122), smooth inner-left boomerang curve,
// insets top & bottom edges ~2px cleanly inside the inner cyan rim (y=91..599), and extends the middle-right
// curve out to x=1772 so it reaches the glowing cyan bezel cleanly around 20 / eDRIVE / 0 / READY / CHARGE.
const WING_TOP_Y = [
    [1245, 91], [1295, 94], [1350, 99], [1390, 104], [1430, 110],
    [1470, 116], [1508, 123], [1545, 134], [1585, 151], [1625, 177],
    [1665, 210], [1702, 240], [1740, 285], [1762, 325], [1772, 358],
];
const WING_OUTER_X = [
    [91, 1390], [104, 1390], [116, 1470], [123, 1508], [134, 1545],
    [151, 1585], [177, 1625], [210, 1665], [240, 1702], [275, 1734],
    [305, 1756], [335, 1769], [360, 1772], [385, 1768], [410, 1759],
    [445, 1741], [485, 1717], [525, 1690], [560, 1660], [585, 1633],
    [599, 1612],
];
const WING_INNER_X = [
    [91, 1245], [104, 1249], [117, 1255], [122, 1356], [136, 1372],
    [164, 1392], [205, 1417], [250, 1444], [295, 1471], [335, 1496],
    [360, 1505], [380, 1504], [415, 1493], [460, 1476], [520, 1455],
    [575, 1437], [599, 1430],
];
const WING_BOTTOM_Y = 599;

/**
 * Full-wing gauge-edge translucent album-art backdrop matching BMW's stock Media widget:
 *   - 1-pass smoothed zoomed artwork extends cleanly to the top, outer-right & bottom gauge edges
 *     at uniform opacity (zero darkened border or outer circular falloff).
 *   - Crisp 3px AA cut along the inner boomerang seam and pointed top-left eyebrow tip.
 *   - Compact local dark shadow only directly behind foreground cover & text for crisp readability.
 */
function buildStockBackdrop(cover, cw, ch, opts) {
    if (!cover || !cover.d || !cover.w || !cover.h) return null;
    const o = opts || {};
    const ox = typeof o.ox === 'number' ? o.ox : 1244;
    const oy = typeof o.oy === 'number' ? o.oy : 88;
    const vx = typeof o.vx === 'number' ? o.vx : 220; // foreground cover & text local center (world 1464)
    const vy = typeof o.vy === 'number' ? o.vy : 252; // foreground local vertical center
    const cacheKey = [cw, ch, ox, oy, vx, vy].join(':');
    if (cover._backdrop && cover._backdropKey === cacheKey) return cover._backdrop;

    const s = cover.w;
    const sh = cover.h;
    const srcRgba = cover.d;
    const blurred = Buffer.allocUnsafe(s * sh * 3);

    // 1-pass 3x3 smoothing keeps bold shapes & colors recognizable like BMW's stock wing backdrop
    for (let y = 0; y < sh; y++) {
        const ym = y > 0 ? y - 1 : 0;
        const yp = y + 1 < sh ? y + 1 : sh - 1;
        const rows = [ym, y, yp];
        for (let x = 0; x < s; x++) {
            const xm = x > 0 ? x - 1 : 0;
            const xp = x + 1 < s ? x + 1 : s - 1;
            const cols = [xm, x, xp];
            let r = 0, g = 0, b = 0;
            for (let ry = 0; ry < 3; ry++) {
                const rowOff = rows[ry] * s;
                for (let cx0 = 0; cx0 < 3; cx0++) {
                    const so = (rowOff + cols[cx0]) * 4;
                    r += srcRgba[so];
                    g += srcRgba[so + 1];
                    b += srcRgba[so + 2];
                }
            }
            const dstOff = (y * s + x) * 3;
            blurred[dstOff] = Math.round(r / 9);
            blurred[dstOff + 1] = Math.round(g / 9);
            blurred[dstOff + 2] = Math.round(b / 9);
        }
    }

    const out = Buffer.alloc(cw * ch * 4);
    // Span zoomed artwork generously over the whole Power % gauge face centered at world (1552, 344)
    const artW = 524;
    const artH = 524;
    const artX0World = 1552 - Math.round(artW / 2);
    const artY0World = 344 - Math.round(artH / 2);
    const srcSpanX = (s - 1) / artW;
    const srcSpanY = (sh - 1) / artH;
    const peakArtAlpha = 98;
    const rxVig = 124;
    const ryVig = 148;

    for (let y = 0; y < ch; y++) {
        const wy = oy + y;
        const rowOut = y * cw;
        const vdy = (y - vy) / ryVig;

        const inYBand = wy >= 91 && wy <= WING_BOTTOM_Y;
        const botAa = inYBand ? smoothstep(WING_BOTTOM_Y, WING_BOTTOM_Y - 3, wy) : 0;
        const innerX = inYBand ? pwl(WING_INNER_X, wy) : 9999;
        const outerX = inYBand ? pwl(WING_OUTER_X, wy) : -1;
        const innerFadeLo = innerX - 1.5;
        const innerFadeHi = innerX + 2.0;

        for (let x = 0; x < cw; x++) {
            const wx = ox + x;

            let artR = 0, artG = 0, artB = 0, artA = 0;
            if (inYBand && wx >= innerFadeLo && wx <= outerX) {
                const topY = pwl(WING_TOP_Y, wx);
                if (wy >= topY) {
                    const topAa = smoothstep(topY, topY + 3, wy);
                    const rightAa = smoothstep(outerX, outerX - 3, wx);
                    const innerFade = smoothstep(innerFadeLo, innerFadeHi, wx);
                    const mask = topAa * botAa * rightAa * innerFade;
                    if (mask > 0.005) {
                        const sx = Math.max(0, Math.min(s - 1, (wx - artX0World) * srcSpanX));
                        const sy = Math.max(0, Math.min(sh - 1, (wy - artY0World) * srcSpanY));
                        const ix0 = Math.floor(sx);
                        const iy0 = Math.floor(sy);
                        const ix1 = Math.min(s - 1, ix0 + 1);
                        const iy1 = Math.min(sh - 1, iy0 + 1);
                        const fx = sx - ix0;
                        const fy = sy - iy0;

                        const o00 = (iy0 * s + ix0) * 3;
                        const o10 = (iy0 * s + ix1) * 3;
                        const o01 = (iy1 * s + ix0) * 3;
                        const o11 = (iy1 * s + ix1) * 3;

                        const w00 = (1 - fx) * (1 - fy);
                        const w10 = fx * (1 - fy);
                        const w01 = (1 - fx) * fy;
                        const w11 = fx * fy;

                        artR = blurred[o00] * w00 + blurred[o10] * w10 + blurred[o01] * w01 + blurred[o11] * w11;
                        artG = blurred[o00 + 1] * w00 + blurred[o10 + 1] * w10 + blurred[o01 + 1] * w01 + blurred[o11 + 1] * w11;
                        artB = blurred[o00 + 2] * w00 + blurred[o10 + 2] * w10 + blurred[o01 + 2] * w01 + blurred[o11 + 2] * w11;
                        artA = peakArtAlpha * mask;
                    }
                }
            }

            // Compact local dark shadow behind foreground cover, title, artist, and bar ONLY (never darkens outer wing edges!)
            const vdx = (x - vx) / rxVig;
            const vDist = Math.sqrt(vdx * vdx + vdy * vdy);
            const vigFade = (vDist < 1 && wx >= 1276) ? smoothstep(1.0, 0.25, vDist) : 0;

            if (artA <= 0.5 && vigFade <= 0.005) continue;

            const artDim = 1 - 0.72 * vigFade;
            const dArtA = (artA / 255) * artDim;
            const darkA = 0.46 * vigFade;
            const outA = darkA + dArtA * (1 - darkA);
            if (outA <= 0.002) continue;

            const sr = Math.round((4 * darkA + artR * dArtA * (1 - darkA)) / outA);
            const sg = Math.round((7 * darkA + artG * dArtA * (1 - darkA)) / outA);
            const sb = Math.round((12 * darkA + artB * dArtA * (1 - darkA)) / outA);

            const oo = (rowOut + x) * 4;
            out[oo] = sr;
            out[oo + 1] = sg;
            out[oo + 2] = sb;
            out[oo + 3] = Math.min(255, Math.round(outA * 255));
        }
    }

    cover._backdrop = out;
    cover._backdropKey = cacheKey;
    return out;
}

module.exports = {
    MAX_BYTES,
    MAX_SIDE,
    imageSize,
    decodeImage,
    shrinkSquare,
    decodeCoverThumb,
    buildStockBackdrop,
};
