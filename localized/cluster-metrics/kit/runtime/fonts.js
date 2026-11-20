'use strict';
/**
 * fonts.js - loads the pre-baked glyph atlases (kit/runtime/fonts/*.json,
 * made by kit/tools/bake_fonts.py and merge_cjk_atlas.py) and resolves
 * per-codepoint Latin + CJK fallback glyphs lazily.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, 'fonts');
const families = Object.create(null);

const PLAIN = {
    0x2018: 0x27,
    0x2019: 0x27,
    0x201c: 0x22,
    0x201d: 0x22,
    0x2013: 0x2d,
    0x2014: 0x2d,
    0x00a0: 0x20,
    0x3000: 0x20,
    0xff08: 0x28,
    0xff09: 0x29,
    0xff5e: 0x7e,
    0xff01: 0x21,
    0xff1f: 0x3f,
    0xff1a: 0x3a,
};

function hasGlyph(font, cp) {
    return Boolean(font && font.glyphs && Object.prototype.hasOwnProperty.call(font.glyphs, cp));
}

function inflateFont(f) {
    if (f && !f.alpha && f._alpha) {
        f.alpha = zlib.inflateSync(Buffer.from(f._alpha, 'base64'));
        f._alpha = null;
    }
    return f;
}

function family(name) {
    if (families[name] !== undefined) return families[name];
    let fam = null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8'));
        fam = j.sizes.map((s) => ({
            size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
            glyphs: s.glyphs, _alpha: s.alpha, alpha: null, family: name, cacheKey: j.cacheKey || '',
        }));
    } catch (e) { fam = null; }
    families[name] = fam;
    return fam;
}

/** Smallest baked size >= requested (downscaling looks better), else largest. */
function get(name, size, text) {
    if (name !== 'cjk' && text && /[\u0400-\u04ff]/.test(text)) name = 'cyrillic';
    const fam = family(name) || family('label');
    if (!fam) return null;
    let best = null;
    for (let i = 0; i < fam.length; i++) {
        const f = fam[i];
        if (f.size >= size && (!best || f.size < best.size)) best = f;
    }
    if (!best) best = fam[fam.length - 1];
    return inflateFont(best);
}

/** Resolve glyph for codepoint cp, lazily falling back to unified CJK atlas when primary lacks cp. */
function resolveGlyph(primaryFont, cp) {
    if (!primaryFont) return null;
    if (hasGlyph(primaryFont, cp)) return { font: primaryFont, g: primaryFont.glyphs[cp] };
    const plainCp = PLAIN[cp];
    if (plainCp && hasGlyph(primaryFont, plainCp)) return { font: primaryFont, g: primaryFont.glyphs[plainCp] };
    if (cp > 0x7e) {
        const cjkFam = family('cjk');
        const cjkFont = cjkFam && cjkFam.length ? inflateFont(cjkFam[cjkFam.length - 1]) : null;
        if (cjkFont && hasGlyph(cjkFont, cp)) {
            return { font: cjkFont, g: cjkFont.glyphs[cp] };
        }
    }
    if (hasGlyph(primaryFont, 63)) return { font: primaryFont, g: primaryFont.glyphs[63] };
    return null;
}

function measureMixed(f, size, s, spacing) {
    if (!f || s === undefined || s === null) return 0;
    const str = String(s);
    const sp = spacing || 0;
    let w = 0;
    let count = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        const rg = resolveGlyph(f, cp);
        if (rg && rg.g) {
            w += rg.g[6] * (size / rg.font.size);
        }
        count++;
    }
    return w + sp * Math.max(0, count - 1);
}

function measure(f, s) {
    if (!f) return 0;
    return measureMixed(f, f.size, s, 0);
}

module.exports = { get, measure, measureMixed, resolveGlyph };
