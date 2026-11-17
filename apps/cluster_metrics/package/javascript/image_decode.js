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

const MAX_BYTES = 460 * 1024;
const MAX_SIDE = 1200;

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
    return shrinkSquare(img.rgba, img.w, img.h, side || 124);
}

module.exports = {
    MAX_BYTES,
    MAX_SIDE,
    imageSize,
    decodeImage,
    shrinkSquare,
    decodeCoverThumb,
};
