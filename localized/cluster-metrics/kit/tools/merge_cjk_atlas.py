#!/usr/bin/env python3
"""Build unified 20px CJK glyph atlas (Simplified Chinese + Traditional Chinese + Japanese)
from SIL OFL 1.1 Noto Sans SC, TC, and JP pre-baked atlases using Python stdlib only.

Usage:
    python3 kit/tools/merge_cjk_atlas.py [source_fonts_dir]
"""
import base64
import hashlib
import json
import math
import os
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
DEFAULT_SRC = os.path.abspath(os.path.join(ROOT, '..', 'mgu-store', 'apps', 'robertn_store', 'package', 'fonts'))
OUT_PATH = os.path.join(ROOT, 'kit', 'runtime', 'fonts', 'cjk.json')
ATLAS_W = 1024
TARGET_SIZE = 20


def load_face(path):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    s = data['sizes'][-1]
    raw = zlib.decompress(base64.b64decode(s['alpha']))
    return {
        'size': s['size'],
        'ascent': s['ascent'],
        'descent': s['descent'],
        'w': s['atlasW'],
        'h': s['atlasH'],
        'glyphs': s['glyphs'],
        'alpha': raw,
    }


def extract_bitmap(face, g):
    gx, gy, gw, gh, ox, oy, adv = g
    if gw <= 0 or gh <= 0:
        return b'', 0, 0, ox, oy, adv
    aw = face['w']
    alpha = face['alpha']
    rows = []
    for r in range(gh):
        start = (gy + r) * aw + gx
        rows.append(alpha[start:start + gw])
    return b''.join(rows), gw, gh, ox, oy, adv


def upscale_bitmap(buf, gw, gh, scale):
    if gw <= 0 or gh <= 0:
        return b'', 0, 0
    nw = max(1, int(round(gw * scale)))
    nh = max(1, int(round(gh * scale)))
    out = bytearray(nw * nh)
    for py in range(nh):
        sy = (py + 0.5) / scale - 0.5
        iy = int(math.floor(sy))
        fy = sy - iy
        y0 = max(0, min(gh - 1, iy))
        y1 = max(0, min(gh - 1, iy + 1))
        for px in range(nw):
            sx = (px + 0.5) / scale - 0.5
            ix = int(math.floor(sx))
            fx = sx - ix
            x0 = max(0, min(gw - 1, ix))
            x1 = max(0, min(gw - 1, ix + 1))
            v00 = buf[y0 * gw + x0]
            v10 = buf[y0 * gw + x1]
            v01 = buf[y1 * gw + x0]
            v11 = buf[y1 * gw + x1]
            val = (v00 * (1.0 - fx) * (1.0 - fy) +
                   v10 * fx * (1.0 - fy) +
                   v01 * (1.0 - fx) * fy +
                   v11 * fx * fy)
            out[py * nw + px] = max(0, min(255, int(round(val))))
    return bytes(out), nw, nh


def main():
    src_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    sc = load_face(os.path.join(src_dir, 'chinese.json'))
    jp = load_face(os.path.join(src_dir, 'japanese.json'))
    tc = load_face(os.path.join(src_dir, 'chinese-tc.json'))

    collected = {}  # cp (int) -> (bmp_bytes, gw, gh, ox, oy, adv)

    for face in (sc, jp, tc):
        scale = float(TARGET_SIZE) / float(face['size'])
        need_scale = abs(scale - 1.0) > 1e-6
        for k, g in face['glyphs'].items():
            cp = int(k)
            if cp <= 0x7E or cp == 0x00B0 or cp in collected:
                continue
            bmp, gw, gh, ox, oy, adv = extract_bitmap(face, g)
            if need_scale:
                bmp, gw, gh = upscale_bitmap(bmp, gw, gh, scale)
                ox = round(ox * scale, 2)
                oy = round(oy * scale, 2)
                adv = round(adv * scale, 3)
            else:
                adv = round(float(adv), 3)
            collected[cp] = (bmp, gw, gh, ox, oy, adv)

    # Sort by height descending, then codepoint for tight deterministic shelf packing
    ordered = sorted(collected.items(), key=lambda kv: (-kv[1][2], kv[0]))

    placements = {}
    pen_x = 0
    pen_y = 0
    row_h = 0
    for cp, (bmp, gw, gh, ox, oy, adv) in ordered:
        if gw == 0 or gh == 0:
            placements[cp] = (b'', [0, 0, 0, 0, ox, oy, adv])
            continue
        if pen_x + gw > ATLAS_W:
            pen_x = 0
            pen_y += row_h + 1
            row_h = 0
        placements[cp] = (bmp, [pen_x, pen_y, gw, gh, ox, oy, adv])
        pen_x += gw + 1
        if gh > row_h:
            row_h = gh

    atlas_h = pen_y + row_h
    atlas = bytearray(ATLAS_W * atlas_h)
    glyph_out = {}
    for cp in sorted(placements.keys()):
        bmp, entry = placements[cp]
        gx, gy, gw, gh = entry[0], entry[1], entry[2], entry[3]
        if gw > 0 and gh > 0:
            for r in range(gh):
                dst_off = (gy + r) * ATLAS_W + gx
                src_off = r * gw
                atlas[dst_off:dst_off + gw] = bmp[src_off:src_off + gw]
        glyph_out[str(cp)] = entry

    comp = zlib.compress(bytes(atlas), 9)
    b64 = base64.b64encode(comp).decode('ascii')
    size_obj = {
        'size': TARGET_SIZE,
        'ascent': 24,
        'descent': 6,
        'atlasW': ATLAS_W,
        'atlasH': atlas_h,
        'glyphs': glyph_out,
        'alpha': b64,
    }
    cache_key = hashlib.sha256(json.dumps(size_obj, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()[:16]
    out_data = {
        'family': 'cjk',
        'source': 'Noto Sans SC / TC / JP (SIL Open Font License 1.1, LICENSE-NotoSansCJK.txt)',
        'cacheKey': cache_key,
        'sizes': [size_obj],
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out_data, f, separators=(',', ':'))
        f.write('\n')
    print('Built %s: %d CJK glyphs, %dx%d px, %.1f KiB JSON (%.1f KiB zlib)' % (
        os.path.relpath(OUT_PATH, ROOT), len(glyph_out), ATLAS_W, atlas_h,
        os.path.getsize(OUT_PATH) / 1024.0, len(comp) / 1024.0))


if __name__ == '__main__':
    main()
