#!/usr/bin/env python3
"""Bake GB2312 Chinese text for the CPU Canvas; takes a verified Noto Sans SC font path."""
import base64, hashlib, json, sys, zlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
root = Path(__file__).resolve().parents[2]
font_path = Path(sys.argv[1])
assert hashlib.sha256(font_path.read_bytes()).hexdigest() == 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
chars = set(chr(n) for n in range(32, 127))
for a in range(0xa1, 0xf8):
    for b in range(0xa1, 0xff):
        try: chars.add(bytes([a, b]).decode('gb2312'))
        except UnicodeDecodeError: pass
chars.update((root / 'translations.zh-CN.tsv').read_text())
chars.update('°μ…→←↑↓')
chars.difference_update('\n\r\t')
font = ImageFont.truetype(str(font_path), 32)
font.set_variation_by_axes([500])
glyphs = {}; images = []; x = y = row = 0
for ch in sorted(chars):
    box = font.getbbox(ch, anchor='ls'); w = box[2]-box[0]; h = box[3]-box[1]
    if x+w > 1024: x=0; y+=row+1; row=0
    if w and h:
        im=Image.new('L',(w,h)); ImageDraw.Draw(im).text((-box[0],-box[1]),ch,font=font,fill=255,anchor='ls')
        images.append((im,x,y))
    glyphs[ord(ch)]=[x,y,w,h,box[0],box[1],round(font.getlength(ch),2)]
    x+=w+1; row=max(row,h)
atlas=Image.new('L',(1024,y+row+1))
for im,x,y in images: atlas.paste(im,(x,y))
a,d=font.getmetrics()
s={'size':32,'ascent':a,'descent':d,'atlasW':atlas.width,'atlasH':atlas.height,'glyphs':glyphs,'alpha':base64.b64encode(zlib.compress(atlas.tobytes(),9)).decode()}
key=hashlib.sha256(json.dumps(s,sort_keys=True).encode()).hexdigest()[:16]
out=root/'kit/runtime/fonts/cjk.json'
out.write_text(json.dumps({'family':'cjk','source':'Noto Sans SC (OFL-1.1); GB2312 + UI','cacheKey':key,'sizes':[s]},ensure_ascii=False,separators=(',',':'))+'\n')
print(len(glyphs),'glyphs;',atlas.size,'CPU alpha atlas;',out.stat().st_size,'bytes')
