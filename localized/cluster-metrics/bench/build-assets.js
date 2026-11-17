'use strict';
/**
 * bench/build-assets.js - builds 1920x720 perspective-rectified real BMW 530e
 * instrument cluster scene assets in bench/assets/ from design/resources/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RES_DIR = path.join(ROOT, 'design', 'resources');
const OUT_DIR = path.join(__dirname, 'assets');
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));

fs.mkdirSync(OUT_DIR, { recursive: true });

function loadPngRgb(filePath) {
    const b = fs.readFileSync(filePath);
    let o = 8, w = 0, h = 0, ctype = 2;
    const idats = [];
    while (o < b.length) {
        const len = b.readUInt32BE(o);
        const type = b.toString('ascii', o + 4, o + 8);
        if (type === 'IHDR') {
            w = b.readUInt32BE(o + 8);
            h = b.readUInt32BE(o + 12);
            ctype = b[o + 17];
        } else if (type === 'IDAT') {
            idats.push(b.subarray(o + 8, o + 8 + len));
        }
        o += 12 + len;
    }
    const bpp = ctype === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idats));
    const stride = w * bpp;
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    const cv = new Canvas(w, h);
    const paeth = (a, pb, c) => {
        const p = a + pb - c;
        const pa = Math.abs(p - a), ppb = Math.abs(p - pb), pc = Math.abs(p - c);
        return pa <= ppb && pa <= pc ? a : ppb <= pc ? pb : c;
    };
    let ro = 0;
    for (let y = 0; y < h; y++) {
        const ft = raw[ro++];
        for (let i = 0; i < stride; i++) {
            const x = raw[ro++];
            const left = i >= bpp ? cur[i - bpp] : 0;
            const up = prev[i];
            const upLeft = i >= bpp ? prev[i - bpp] : 0;
            let v = x;
            if (ft === 1) v = (x + left) & 255;
            else if (ft === 2) v = (x + up) & 255;
            else if (ft === 3) v = (x + ((left + up) >> 1)) & 255;
            else if (ft === 4) v = (x + paeth(left, up, upLeft)) & 255;
            cur[i] = v;
        }
        for (let x = 0; x < w; x++) {
            const di = (y * w + x) * 4, si = x * bpp;
            cv.d[di] = cur[si];
            cv.d[di + 1] = cur[si + 1];
            cv.d[di + 2] = cur[si + 2];
            cv.d[di + 3] = bpp === 4 ? cur[si + 3] : 255;
        }
        prev.set(cur);
    }
    return cv;
}

function decodeToPng(srcFile, outPng, scaleFilter) {
    const args = ['-y', '-i', srcFile];
    if (scaleFilter) args.push('-vf', scaleFilter);
    args.push('-pix_fmt', 'rgb24', outPng);
    execFileSync('ffmpeg', args, { stdio: 'ignore' });
    return loadPngRgb(outPng);
}

function saveJpeg(cv, outJpg, tmpDir) {
    const tmpPng = path.join(tmpDir, path.basename(outJpg, '.jpg') + '.png');
    fs.writeFileSync(tmpPng, cv.png(2));
    execFileSync('ffmpeg', ['-y', '-i', tmpPng, '-q:v', '2', outJpg], { stdio: 'ignore' });
}

function warpQuadTo1920x720(src, tl, tr, br, bl) {
    const W = 1920, H = 720;
    const out = new Canvas(W, H);
    for (let y = 0; y < H; y++) {
        const v = y / (H - 1);
        const lx = tl[0] + (bl[0] - tl[0]) * v;
        const ly = tl[1] + (bl[1] - tl[1]) * v;
        const rx = tr[0] + (br[0] - tr[0]) * v;
        const ry = tr[1] + (br[1] - tr[1]) * v;
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1);
            const sx = lx + (rx - lx) * u;
            const sy = ly + (ry - ly) * u;
            const x0 = Math.max(0, Math.min(src.w - 1, Math.floor(sx)));
            const y0 = Math.max(0, Math.min(src.h - 1, Math.floor(sy)));
            const x1 = Math.min(src.w - 1, x0 + 1);
            const y1 = Math.min(src.h - 1, y0 + 1);
            const fx = sx - x0, fy = sy - y0;
            const i00 = (y0 * src.w + x0) * 4, i10 = (y0 * src.w + x1) * 4;
            const i01 = (y1 * src.w + x0) * 4, i11 = (y1 * src.w + x1) * 4;
            const di = (y * W + x) * 4;
            for (let c = 0; c < 3; c++) {
                const top = src.d[i00 + c] * (1 - fx) + src.d[i10 + c] * fx;
                const bot = src.d[i01 + c] * (1 - fx) + src.d[i11 + c] * fx;
                out.d[di + c] = Math.round(top * (1 - fy) + bot * fy);
            }
            out.d[di + 3] = 255;
        }
    }
    return out;
}

function cloneCv(src) {
    const out = new Canvas(src.w, src.h);
    out.d.set(src.d);
    return out;
}

function smoothstep(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

function erasePatchHorizontal(cv, x0, y0, w, h) {
    const feather = 6;
    for (let y = y0; y < y0 + h; y++) {
        const lx = Math.max(0, x0 - 2);
        const rx = Math.min(cv.w - 1, x0 + w + 2);
        const li = (y * cv.w + lx) * 4;
        const ri = (y * cv.w + rx) * 4;
        const fy = Math.min(1, (y - y0) / feather, (y0 + h - 1 - y) / feather);
        for (let x = x0; x < x0 + w; x++) {
            const t = (x - x0) / Math.max(1, w - 1);
            const fx = Math.min(1, (x - x0) / feather, (x0 + w - 1 - x) / feather);
            const blend = fx * fy;
            const di = (y * cv.w + x) * 4;
            const pr = cv.d[li] * (1 - t) + cv.d[ri] * t;
            const pg = cv.d[li + 1] * (1 - t) + cv.d[ri + 1] * t;
            const pb = cv.d[li + 2] * (1 - t) + cv.d[ri + 2] * t;
            cv.d[di] = Math.round(cv.d[di] * (1 - blend) + pr * blend);
            cv.d[di + 1] = Math.round(cv.d[di + 1] * (1 - blend) + pg * blend);
            cv.d[di + 2] = Math.round(cv.d[di + 2] * (1 - blend) + pb * blend);
        }
    }
}

function blitPatch(dst, src, sx, sy, w, h, dx, dy, feather) {
    const f = feather || 6;
    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            const tx = dx + px, ty = dy + py;
            if (tx < 0 || tx >= dst.w || ty < 0 || ty >= dst.h) continue;
            const wx = Math.min(1, px / f, (w - 1 - px) / f);
            const wy = Math.min(1, py / f, (h - 1 - py) / f);
            const a = wx * wy;
            const si = ((sy + py) * src.w + (sx + px)) * 4;
            const di = (ty * dst.w + tx) * 4;
            dst.d[di] = Math.round(dst.d[di] * (1 - a) + src.d[si] * a);
            dst.d[di + 1] = Math.round(dst.d[di + 1] * (1 - a) + src.d[si + 1] * a);
            dst.d[di + 2] = Math.round(dst.d[di + 2] * (1 - a) + src.d[si + 2] * a);
        }
    }
}

function drawTextShadow(cv, str, x, y, size, color, opts) {
    const o = Object.assign({ literal: true }, opts || {});
    cv.text(str, x + 2, y + 2, size, [0, 0, 0, 215], o);
    return cv.text(str, x, y, size, color, o);
}

function paintFullAlbumArtRightWing(cv) {
    for (let y = 165; y < 632; y++) {
        const boomInnerX = y < 275 ? 1510 + (y - 165) * 1.15
            : y < 430 ? 1636 + (y - 275) * 0.25
            : 1675 - (y - 430) * 0.62;
        for (let x = 1175; x < 1690; x++) {
            const boomFade = smoothstep(boomInnerX + 6, boomInnerX - 28, x);
            if (boomFade <= 0.005) continue;
            const nx = (x - 1432) / 252;
            const ny = (y - 378) / 228;
            const dist = Math.hypot(nx, ny);
            let radial = smoothstep(1.06, 0.42, dist);
            radial *= smoothstep(628, 584, y);
            if (x > 1440 && y > 560) {
                const pDist = Math.hypot((x - 1530) / 85, (y - 600) / 32);
                radial *= smoothstep(0.75, 1.25, pDist);
            }
            const mask = radial * boomFade;
            if (mask <= 0.005) continue;
            const suppress = Math.min(0.98, mask * 1.45);
            const di = (y * cv.w + x) * 4;
            const darkR = cv.d[di] * (1 - suppress) + 12 * suppress;
            const darkG = cv.d[di + 1] * (1 - suppress) + 15 * suppress;
            const darkB = cv.d[di + 2] * (1 - suppress) + 23 * suppress;

            const wave = Math.sin((x - 1240) * 0.019 + (y - 210) * 0.014) * 0.5 + 0.5;
            const glow2 = Math.exp(-Math.pow((x - 1475) / 130, 2) - Math.pow((y - 355) / 135, 2));
            const ar = Math.round(115 * wave + 105 * glow2 + 22);
            const ag = Math.round(28 + 52 * glow2 + 24 * (1 - wave));
            const ab = Math.round(135 * (1 - wave * 0.35) + 42);

            const tintA = mask * 0.62;
            cv.d[di] = Math.round(darkR * (1 - tintA) + ar * tintA);
            cv.d[di + 1] = Math.round(darkG * (1 - tintA) + ag * tintA);
            cv.d[di + 2] = Math.round(darkB * (1 - tintA) + ab * tintA);
        }
    }

    const ax = 1344, ay = 232, asz = 108;
    for (let py = 0; py < asz; py++) {
        for (let px = 0; px < asz; px++) {
            const u = px / asz, v = py / asz;
            const sunDist = Math.hypot(u - 0.52, v - 0.42);
            const sun = smoothstep(0.26, 0.21, sunDist);
            const bgR = Math.round(74 + 148 * (1 - v));
            const bgG = Math.round(28 + 68 * (1 - Math.abs(v - 0.5) * 2));
            const bgB = Math.round(132 + 95 * u);
            const di = ((ay + py) * cv.w + (ax + px)) * 4;
            cv.d[di] = Math.round(bgR * (1 - sun) + 252 * sun);
            cv.d[di + 1] = Math.round(bgG * (1 - sun) + 178 * sun);
            cv.d[di + 2] = Math.round(bgB * (1 - sun) + 96 * sun);
        }
    }
    cv.line(ax, ay, ax + asz, ay, 1, [255, 255, 255, 95]);
    cv.line(ax + asz, ay, ax + asz, ay + asz, 1, [255, 255, 255, 95]);
    cv.line(ax + asz, ay + asz, ax, ay + asz, 1, [255, 255, 255, 95]);
    cv.line(ax, ay + asz, ax, ay, 1, [255, 255, 255, 95]);
    drawTextShadow(cv, 'Moments of summer', 1398, 382, 22, '#f2f5fa', { font: 'bold', align: 'center' });
    drawTextShadow(cv, 'Jacob Thommsen', 1398, 412, 17, '#b0c2d8', { font: 'label', align: 'center' });
    cv.fillRect(1300, 434, 196, 4, [255, 255, 255, 55]);
    cv.fillRect(1300, 434, 122, 4, '#f59e0b');
    drawTextShadow(cv, '2:47', 1496, 456, 14, '#c8d6e8', { font: 'label', align: 'right' });
}

if (!fs.existsSync(path.join(RES_DIR, 'dashboard-driving.jpeg'))) {
    console.log('Skipping photo plate generation: optional local photos in design/resources/ are not present (bench/ui.html will use vector cluster fallback).');
    process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-assets-'));
try {
    const drvSrc = decodeToPng(path.join(RES_DIR, 'dashboard-driving.jpeg'), path.join(tmpDir, 'drv.png'), 'scale=iw*3:ih*3:flags=lanczos');
    const stSrc = decodeToPng(path.join(RES_DIR, 'dashboard-startup.jpeg'), path.join(tmpDir, 'st.png'), 'scale=iw*3:ih*3:flags=lanczos');
    const stAnnSrc = decodeToPng(path.join(RES_DIR, 'dashboard-startup-annotated.jpeg'), path.join(tmpDir, 'st_ann.png'), 'scale=iw*3:ih*3:flags=lanczos');
    const ahSrc = decodeToPng(path.join(RES_DIR, 'dashboard-auto-hold.png'), path.join(tmpDir, 'ah.png'), 'scale=iw/2:ih/2:flags=lanczos');

    const drvBase = warpQuadTo1920x720(drvSrc, [244, 128], [2298, 168], [2294, 896], [224, 864]);
    const stBase = warpQuadTo1920x720(stSrc, [276, 102], [1797, 106], [1797, 646], [276, 644]);
    const stAnnBase = warpQuadTo1920x720(stAnnSrc, [276, 102], [1797, 106], [1797, 646], [276, 644]);
    const ahBase = warpQuadTo1920x720(ahSrc, [315, 444], [1998, 434], [2004, 1066], [305, 1084]);

    // 1. cluster_530e_media.jpg: Real US 530e (67 mph, D) + Full Album Art + 'Second speed = Off'
    {
        const cv = cloneCv(drvBase);
        erasePatchHorizontal(cv, 456, 430, 198, 70); // Cleanly remove secondary '107 km/h' only
        paintFullAlbumArtRightWing(cv);
        saveJpeg(cv, path.join(OUT_DIR, 'cluster_530e_media.jpg'), tmpDir);
    }

    // 2. cluster_530e_edrive.jpg: Real US 530e (67 mph, D) + Stock BMW eDrive widget + 'Second speed = Off'
    {
        const cv = cloneCv(drvBase);
        erasePatchHorizontal(cv, 456, 430, 198, 70);
        saveJpeg(cv, path.join(OUT_DIR, 'cluster_530e_edrive.jpg'), tmpDir);
    }

    // 3. cluster_530e_autohold.jpg: Real 12MP Metric PHEV (HYBRID D, AUTO H, G-Meter)
    {
        const cv = cloneCv(ahBase);
        saveJpeg(cv, path.join(OUT_DIR, 'cluster_530e_autohold.jpg'), tmpDir);
    }

    // 4. cluster_530e_telltales.jpg: Real US 530e Startup + Lane Centering + Traffic Light + AUTO H + 'Second speed = Off'
    {
        const cv = cloneCv(stBase);
        blitPatch(cv, stAnnBase, 118, 134, 58, 72, 118, 134, 8);
        blitPatch(cv, stAnnBase, 518, 520, 38, 60, 518, 520, 6);
        blitPatch(cv, ahBase, 1764, 146, 116, 44, 1756, 150, 6);
        erasePatchHorizontal(cv, 455, 438, 172, 62); // Remove secondary '0 km/h' only
        saveJpeg(cv, path.join(OUT_DIR, 'cluster_530e_telltales.jpg'), tmpDir);
    }

    console.log('Built 4 real 530e cluster scene assets in ' + OUT_DIR);
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
