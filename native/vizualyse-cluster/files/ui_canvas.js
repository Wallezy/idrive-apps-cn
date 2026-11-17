// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The touch kit's software canvas: an opaque RGBX picture (4 bytes a pixel,
 * the 4th always 255) that a tool hands to mgu-render as a pixmap. Node 8,
 * no dependencies. Grown from vizualyse-cluster's ui_draw.js.
 *
 * Every drawing call honours the clip (setClip): the kit redraws only the
 * damaged rectangles of a screen, each clipped, so the cost of a change is
 * the size of what changed. Opaque fills and the straight middle of a
 * rounded rectangle are native Buffer fills; only corners, edges and text
 * are blended pixel by pixel (corners from a coverage mask cached per radius).
 *
 *   fill, rrect (anti-aliased rounded rectangle, optionally translucent),
 *   ring (its outline), image (an RGBA picture, optionally rounded), fade,
 *   line (a round-capped stroke), tri (a filled triangle), text, measure, fit;
 *   resize and crop (area-averaged, for building pictures off the car).
 *
 * Colours are 0xRRGGBB numbers.
 */
'use strict';
const { translate } = require('./i18n.js');

function rgb(c) { return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; }

/* signed distance from a point to a rounded rectangle (negative inside) */
function rrDist(px, py, x, y, w, h, r) {
    const hx = w / 2, hy = h / 2, cx = x + hx, cy = y + hy;
    const qx = Math.abs(px - cx) - (hx - r), qy = Math.abs(py - cy) - (hy - r);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/* coverage of an r x r corner (the top-left one; the others mirror it):
 * cov[j * r + i] for the pixel i across, j down from the corner */
const MASKS = {};
function cornerMask(r) {
    if (MASKS[r]) return MASKS[r];
    const m = new Float32Array(r * r);
    for (let j = 0; j < r; j++) {
        for (let i = 0; i < r; i++) {
            const dx = r - (i + 0.5), dy = r - (j + 0.5);
            m[j * r + i] = Math.min(1, Math.max(0, r + 0.5 - Math.sqrt(dx * dx + dy * dy)));
        }
    }
    MASKS[r] = m;
    return m;
}

class Canvas {
    constructor(w, h, colour) {
        this.w = w; this.h = h;
        this.px = Buffer.alloc(w * h * 4, 255);
        this.clip = { x0: 0, y0: 0, x1: w, y1: h };
        if (colour !== undefined) this.fill(0, 0, w, h, colour);
    }

    /* draw only inside r ({ x, y, w, h }), or everywhere (null) */
    setClip(r) {
        this.clip = r ? { x0: Math.max(0, r.x), y0: Math.max(0, r.y), x1: Math.min(this.w, r.x + r.w), y1: Math.min(this.h, r.y + r.h) }
            : { x0: 0, y0: 0, x1: this.w, y1: this.h };
    }

    _blend(i, c, a) {
        const p = this.px;
        if (a >= 1) { p[i] = c[0]; p[i + 1] = c[1]; p[i + 2] = c[2]; return; }
        p[i] = p[i] + (c[0] - p[i]) * a + 0.5 | 0;
        p[i + 1] = p[i + 1] + (c[1] - p[i + 1]) * a + 0.5 | 0;
        p[i + 2] = p[i + 2] + (c[2] - p[i + 2]) * a + 0.5 | 0;
    }

    _clip(x, y, w, h) {
        const k = this.clip;
        const x0 = Math.max(k.x0, Math.floor(x)), y0 = Math.max(k.y0, Math.floor(y));
        const x1 = Math.min(k.x1, Math.ceil(x + w)), y1 = Math.min(k.y1, Math.ceil(y + h));
        return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
    }

    /* an opaque span of one row: native */
    _span(yy, xa, xb, pat) { if (xb > xa) this.px.fill(pat, (yy * this.w + xa) * 4, (yy * this.w + xb) * 4); }

    fill(x, y, w, h, colour) {
        const c = rgb(colour), b = this._clip(x, y, w, h);
        if (!b) return;
        const pat = Buffer.from([c[0], c[1], c[2], 255]);
        for (let yy = b[1]; yy < b[3]; yy++) this._span(yy, b[0], b[2], pat);
    }

    /* a rounded rectangle on whole pixels (x, y, w, h, r rounded), anti-aliased
     * corners; alpha 0..1 */
    rrect(x, y, w, h, r, colour, alpha) {
        x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
        r = Math.max(0, Math.min(Math.round(r), w >> 1, h >> 1));
        const c = rgb(colour), a = alpha === undefined ? 1 : alpha, b = this._clip(x, y, w, h);
        if (!b) return;
        const m = r ? cornerMask(r) : null, pat = a >= 1 ? Buffer.from([c[0], c[1], c[2], 255]) : null;
        for (let yy = b[1]; yy < b[3]; yy++) {
            const j = yy - y < r ? yy - y : y + h - 1 - yy < r ? y + h - 1 - yy : -1;
            /* the straight part of the row */
            const sx0 = Math.max(b[0], j >= 0 ? x + r : x), sx1 = Math.min(b[2], j >= 0 ? x + w - r : x + w);
            if (pat) this._span(yy, sx0, sx1, pat);
            else for (let xx = sx0; xx < sx1; xx++) this._blend((yy * this.w + xx) * 4, c, a);
            if (j < 0) continue;
            /* the two corners of the row */
            for (let i = 0; i < r; i++) {
                const cov = m[j * r + i] * a;
                if (cov <= 0) continue;
                const xl = x + i, xr = x + w - 1 - i;
                if (xl >= b[0] && xl < b[2]) this._blend((yy * this.w + xl) * 4, c, cov);
                if (xr >= b[0] && xr < b[2] && xr !== xl) this._blend((yy * this.w + xr) * 4, c, cov);
            }
        }
    }

    /* the outline of a rounded rectangle, t px wide, inside its bounds */
    ring(x, y, w, h, r, t, colour, alpha) {
        const c = rgb(colour), a = alpha === undefined ? 1 : alpha, b = this._clip(x, y, w, h);
        if (!b) return;
        r = Math.min(r, w / 2, h / 2);
        const ri = Math.max(0, r - t);
        for (let yy = b[1]; yy < b[3]; yy++) {
            const py = yy + 0.5;
            const midRow = py > y + Math.max(t, r) + 1 && py < y + h - Math.max(t, r) - 1;
            for (let xx = b[0]; xx < b[2]; xx++) {
                const px = xx + 0.5;
                if (midRow && px > x + t + 1 && px < x + w - t - 1) { xx = Math.max(xx, Math.floor(x + w - t - 2)); continue; }
                const out = Math.min(1, Math.max(0, 0.5 - rrDist(px, py, x, y, w, h, r)));
                const inn = Math.min(1, Math.max(0, 0.5 - rrDist(px, py, x + t, y + t, w - 2 * t, h - 2 * t, ri)));
                const cov = out - inn;
                if (cov > 0) this._blend((yy * this.w + xx) * 4, c, cov * a);
            }
        }
    }

    /* an RGBA picture { w, h, rgba } at x, y (its alpha blended), optionally
     * with rounded corners of radius r */
    image(img, x, y, r) {
        x = Math.round(x); y = Math.round(y); r = Math.round(r || 0);
        const b = this._clip(x, y, img.w, img.h);
        if (!b) return;
        const s = img.rgba, c = [0, 0, 0];
        if (img.opaque === undefined) {
            img.opaque = true;
            for (let i = 3; i < s.length; i += 4) if (s[i] !== 255) { img.opaque = false; break; }
        }
        const m = r ? cornerMask(r) : null;
        for (let yy = b[1]; yy < b[3]; yy++) {
            const sy = yy - y;
            const j = r ? (sy < r ? sy : img.h - 1 - sy < r ? img.h - 1 - sy : -1) : -1;
            if (img.opaque) {
                /* opaque: the row copied as it is (RGBA onto RGBX, the alpha
                 * 255), then its rounded ends blended */
                const xa = j >= 0 ? Math.max(b[0], x + r) : b[0], xb = j >= 0 ? Math.min(b[2], x + img.w - r) : b[2];
                if (xb > xa) s.copy(this.px, (yy * this.w + xa) * 4, (sy * img.w + xa - x) * 4, (sy * img.w + xb - x) * 4);
                if (j < 0) continue;
                for (let i = 0; i < r; i++) {
                    const cov = m[j * r + i];
                    [x + i, x + img.w - 1 - i].forEach((xx) => {
                        if (xx < b[0] || xx >= b[2] || cov <= 0) return;
                        const si = (sy * img.w + xx - x) * 4;
                        c[0] = s[si]; c[1] = s[si + 1]; c[2] = s[si + 2];
                        this._blend((yy * this.w + xx) * 4, c, cov);
                    });
                }
                continue;
            }
            for (let xx = b[0]; xx < b[2]; xx++) {
                const sx = xx - x, si = (sy * img.w + sx) * 4;
                let al = s[si + 3] / 255;
                if (j >= 0 && (sx < r || sx >= img.w - r)) al *= m[j * r + (sx < r ? sx : img.w - 1 - sx)];
                if (al <= 0) continue;
                c[0] = s[si]; c[1] = s[si + 1]; c[2] = s[si + 2];
                this._blend((yy * this.w + xx) * 4, c, al);
            }
        }
    }

    /* a vertical fade over x, y, w, h: alpha a0 at the top to a1 at the bottom */
    fade(x, y, w, h, colour, a0, a1) {
        const c = rgb(colour), b = this._clip(x, y, w, h);
        if (!b) return;
        for (let yy = b[1]; yy < b[3]; yy++) {
            const a = a0 + (a1 - a0) * ((yy + 0.5 - y) / h);
            for (let xx = b[0]; xx < b[2]; xx++) this._blend((yy * this.w + xx) * 4, c, a);
        }
    }

    /* a stroke from (x0, y0) to (x1, y1), width wd, round caps */
    line(x0, y0, x1, y1, wd, colour) {
        const c = rgb(colour), hw = wd / 2;
        const b = this._clip(Math.min(x0, x1) - hw - 1, Math.min(y0, y1) - hw - 1, Math.abs(x1 - x0) + wd + 2, Math.abs(y1 - y0) + wd + 2);
        if (!b) return;
        const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
        for (let yy = b[1]; yy < b[3]; yy++) {
            for (let xx = b[0]; xx < b[2]; xx++) {
                const px = xx + 0.5 - x0, py = yy + 0.5 - y0;
                const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
                const ex = px - t * dx, ey = py - t * dy;
                const cov = Math.min(1, Math.max(0, hw + 0.5 - Math.sqrt(ex * ex + ey * ey)));
                if (cov > 0) this._blend((yy * this.w + xx) * 4, c, cov);
            }
        }
    }

    /* a filled triangle, 4 samples a pixel */
    tri(ax, ay, bx, by, cx, cy, colour) {
        const c = rgb(colour);
        const b = this._clip(Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.max(ax, bx, cx) - Math.min(ax, bx, cx) + 1, Math.max(ay, by, cy) - Math.min(ay, by, cy) + 1);
        if (!b) return;
        const edge = (x0, y0, x1, y1, px, py) => (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
        const sign = edge(ax, ay, bx, by, cx, cy) > 0 ? 1 : -1;
        const S = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
        for (let yy = b[1]; yy < b[3]; yy++) {
            for (let xx = b[0]; xx < b[2]; xx++) {
                let n = 0;
                for (let k = 0; k < 4; k++) {
                    const px = xx + S[k][0], py = yy + S[k][1];
                    if (sign * edge(ax, ay, bx, by, px, py) >= 0 && sign * edge(bx, by, cx, cy, px, py) >= 0 && sign * edge(cx, cy, ax, ay, px, py) >= 0) n++;
                }
                if (n) this._blend((yy * this.w + xx) * 4, c, n / 4);
            }
        }
    }

    /* text in a font (a glyph atlas built off the car): x is its left, centre
     * or right edge (align 'left', 'center', 'right'), y the top of its line
     * box; cut at maxW when given (fit() adds the ellipsis) */
    text(font, str, x, y, colour, align, maxW) {
        str = translate(String(str));
        const w = measure(font, str);
        if (align === 'center') x -= w / 2; else if (align === 'right') x -= w;
        x = Math.round(x); y = Math.round(y);
        const c = rgb(colour), k = this.clip, right = Math.min(k.x1, maxW ? x + maxW : this.w);
        let pen = x;
        for (let n = 0; n < str.length; n++) {
            const g = font.index[str[n]];
            if (g === undefined) { pen += font.adv[font.index[' ']] || 0; continue; }
            if (pen >= right) break;
            /* a glyph's own columns only: the next glyph's ink can reach
             * into the end of its cell in the atlas */
            const gx = g * font.cell, ty = y + font.top, cols = Math.min(font.cell, font.adv[g] + 2);
            if (pen + cols > k.x0) {
                for (let row = 0; row < font.h; row++) {
                    const yy = ty + row;
                    if (yy < k.y0 || yy >= k.y1) continue;
                    for (let col = 0; col < cols; col++) {
                        const xx = pen + col;
                        if (xx < k.x0 || xx >= right) continue;
                        const v = font.r8[row * font.w + gx + col];
                        if (v) this._blend((yy * this.w + xx) * 4, c, v / 255);
                    }
                }
            }
            pen += font.adv[g];
        }
        return w;
    }
}

function measure(font, str) {
    str = translate(String(str));
    let w = 0;
    for (let k = 0; k < str.length; k++) {
        const g = font.index[str[k]];
        w += font.adv[g === undefined ? font.index[' '] : g] || 0;
    }
    return w;
}

/* str cut to fit maxW, with "..." */
function fit(font, str, maxW) {
    str = translate(String(str));
    if (measure(font, str) <= maxW) return str;
    let s = str;
    while (s.length && measure(font, s + '...') > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, '') + '...';
}

/* an RGBA picture resized by area averaging (each output pixel the mean of
 * the source pixels it covers): for building smaller pictures off the car */
function resize(img, w, h) {
    const out = Buffer.alloc(w * h * 4), sx = img.w / w, sy = img.h / h;
    const acc = new Float64Array(4);
    for (let y = 0; y < h; y++) {
        const y0 = y * sy, y1 = y0 + sy;
        for (let x = 0; x < w; x++) {
            const x0 = x * sx, x1 = x0 + sx;
            acc.fill(0);
            let total = 0;
            for (let yy = Math.floor(y0); yy < Math.min(img.h, Math.ceil(y1)); yy++) {
                const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
                for (let xx = Math.floor(x0); xx < Math.min(img.w, Math.ceil(x1)); xx++) {
                    const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx)), i = (yy * img.w + xx) * 4;
                    acc[0] += img.rgba[i] * wgt; acc[1] += img.rgba[i + 1] * wgt; acc[2] += img.rgba[i + 2] * wgt; acc[3] += img.rgba[i + 3] * wgt;
                    total += wgt;
                }
            }
            const o = (y * w + x) * 4;
            for (let k = 0; k < 4; k++) out[o + k] = Math.round(acc[k] / total);
        }
    }
    return { w, h, rgba: out };
}

/* a w x h part of a picture */
function crop(img, x, y, w, h) {
    const out = Buffer.alloc(w * h * 4);
    for (let r = 0; r < h; r++) img.rgba.copy(out, r * w * 4, ((r + y) * img.w + x) * 4, ((r + y) * img.w + x + w) * 4);
    return { w, h, rgba: out };
}

module.exports = { Canvas, measure, fit, resize, crop, rgb };
