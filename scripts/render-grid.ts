// render-grid.ts — headless top-down rasterizer + radar overlay + walkable-mask IoU.
//
// PURPOSE
// -------
// Objectively verify the de_dust2 grid against ground truth. Renders any MapData
// top-down at RADAR-CALIBRATED scale (same pixel frame as the real CS:GO radar
// image) so the output can be overlaid 1:1 on a reference radar. Draws landmark
// markers from dust2_truth so a human can eyeball-check placement, and — when a
// local reference radar PNG is provided — computes a walkable-mask IoU score.
//
// This is a DEV SCRIPT. It is NOT imported by the browser bundle (nothing under
// src/ imports it; the build only bundles index.html -> main.ts). It is, however,
// type-checked by `bun run check` (tsconfig includes "scripts"), so it stays
// strict-clean with no `any`.
//
// USAGE
// -----
//   bun scripts/render-grid.ts [--map dust2] [--out ref/dust2-grid.png] \
//                              [--overlay ref/de_dust2_radar.png]
//
//   --map <id>       Map to render (default: dust2). Resolved via maps registry.
//   --out <path>     Output PNG path (default: ref/<map>-grid.png).
//   --overlay <path> LOCAL reference radar PNG to blend over + score IoU against.
//                    The radar image is COPYRIGHTED + human-provided; it lives in
//                    the gitignored ref/ dir and is NEVER fetched/embedded/committed.
//                    If absent, the tool degrades gracefully (grid-only render +
//                    a clear "place the radar here" message).
//
// PNG ENCODING
// ------------
// Self-contained encoder via node:zlib (IHDR / IDAT(deflate) / IEND + CRC32).
// No heavy image dependencies. Reads the optional reference PNG with the same
// minimal decoder (8-bit RGB/RGBA, non-interlaced — what a radar export is).
//
// RADAR ORIENTATION
// -----------------
// dust2_truth.RADAR has NO `rotate` field. The CS:GO de_dust2 minimap is
// axis-aligned with NORTH UP (Source +Y up the image, +X to the right), matching
// our convention (row 0 = north). So no rotation is applied. If a future radar
// calibration adds RADAR.rotate, account for it in cellToRadarPx (see note there).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { resolveMap } from '../src/maps/index';
import {
  DUST2_POINTS,
  DUST2_OPENINGS,
  DUST2_REGIONS,
  HU_TO_M,
  X_OFFSET,
  Z_OFFSET,
  RADAR,
  GRID,
  type Landmark,
} from '../src/maps/dust2_truth';
import type { MapData } from '../src/types';

// ---------------------------------------------------------------------------
// Pass threshold (tune once a ref radar exists; RECORD the achieved IoU in the
// ship commit message). 0.80 = our target walkable-mask agreement with the radar.
// ---------------------------------------------------------------------------
const IOU_PASS_THRESHOLD = 0.8;

// Output canvas = the radar image frame so an overlay aligns 1:1.
const CANVAS = RADAR.imageSize; // 1024

// ---------------------------------------------------------------------------
// Coordinate transforms (the radar pixel formula from dust2_truth, inverted)
// ---------------------------------------------------------------------------

/** Our grid cell (col, row) -> world metres (cell CENTRE). */
function cellToWorld(col: number, row: number): { x: number; z: number } {
  return { x: GRID.origin.x + col + 0.5, z: GRID.origin.z + row + 0.5 };
}

/** Our world metres -> Source-Engine HU (inverse of huToWorld's x/z parts). */
function worldToHU(x: number, z: number): { xHU: number; yHU: number } {
  return {
    xHU: (x - X_OFFSET) / HU_TO_M,
    yHU: -(z - Z_OFFSET) / HU_TO_M, // Source Y (north) = -(our z - Z_OFFSET)
  };
}

/**
 * Source HU -> radar pixel, per dust2_truth.RADAR:
 *   world_X_HU = posX + px * scale   ->  px = (xHU - posX) / scale
 *   world_Y_HU = posY - py * scale   ->  py = (posY - yHU) / scale  (radar Y grows down)
 * NOTE: if a RADAR.rotate is ever added, rotate (px,py) about the image centre here.
 */
function huToRadarPx(xHU: number, yHU: number): { px: number; py: number } {
  return {
    px: (xHU - RADAR.posX) / RADAR.scale,
    py: (RADAR.posY - yHU) / RADAR.scale,
  };
}

/** Full chain: grid cell -> radar pixel (cell centre). */
function cellToRadarPx(col: number, row: number): { px: number; py: number } {
  const w = cellToWorld(col, row);
  const hu = worldToHU(w.x, w.z);
  return huToRadarPx(hu.xHU, hu.yHU);
}

/** Pixels spanned by one 1-metre grid cell (for marker/cell sizing). */
function cellPxSize(): number {
  const a = cellToRadarPx(0, 0);
  const b = cellToRadarPx(1, 0);
  return Math.abs(b.px - a.px);
}

// ---------------------------------------------------------------------------
// RGBA canvas
// ---------------------------------------------------------------------------
type RGBA = readonly [number, number, number, number];

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array; // RGBA, row-major

  constructor(w: number, h: number, bg: RGBA = [12, 12, 14, 255]) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4 + 0] = bg[0];
      this.data[i * 4 + 1] = bg[1];
      this.data[i * 4 + 2] = bg[2];
      this.data[i * 4 + 3] = bg[3];
    }
  }

  /** Alpha-blend a pixel (src over dst). */
  blend(x: number, y: number, c: RGBA): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= this.w || yi < 0 || yi >= this.h) return;
    const i = (yi * this.w + xi) * 4;
    const a = c[3] / 255;
    const ia = 1 - a;
    this.data[i + 0] = Math.round(c[0] * a + (this.data[i + 0] ?? 0) * ia);
    this.data[i + 1] = Math.round(c[1] * a + (this.data[i + 1] ?? 0) * ia);
    this.data[i + 2] = Math.round(c[2] * a + (this.data[i + 2] ?? 0) * ia);
    this.data[i + 3] = 255;
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
    const xa = Math.floor(Math.min(x0, x1));
    const xb = Math.ceil(Math.max(x0, x1));
    const ya = Math.floor(Math.min(y0, y1));
    const yb = Math.ceil(Math.max(y0, y1));
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) this.blend(x, y, c);
  }

  /** 1-px-wide rectangle outline. */
  strokeRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
    const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    for (let x = xa; x <= xb; x++) { this.blend(x, ya, c); this.blend(x, yb, c); }
    for (let y = ya; y <= yb; y++) { this.blend(xa, y, c); this.blend(xb, y, c); }
  }

  disc(cx: number, cy: number, r: number, c: RGBA): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.blend(x, y, c);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGBA, width = 1): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (width <= 1) this.blend(x, y, c);
      else this.disc(x, y, width / 2, c);
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal 3x5 bitmap font for the legend / labels (uppercase, digits, few syms)
// ---------------------------------------------------------------------------
const GLYPHS: Record<string, readonly string[]> = {
  A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'],
  C: ['011', '100', '100', '100', '011'], D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'], K: ['101', '110', '100', '110', '101'],
  L: ['100', '100', '100', '100', '111'], M: ['101', '111', '111', '101', '101'],
  N: ['101', '111', '111', '111', '101'], O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'], R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '011'], V: ['101', '101', '101', '010', '010'],
  W: ['101', '101', '111', '111', '101'], X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'],
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['110', '001', '010', '100', '111'], '3': ['110', '001', '010', '001', '110'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '110', '001', '110'],
  '6': ['011', '100', '110', '101', '010'], '7': ['111', '001', '010', '010', '010'],
  '8': ['010', '101', '010', '101', '010'], '9': ['010', '101', '011', '001', '110'],
  '.': ['000', '000', '000', '000', '010'], ':': ['000', '010', '000', '010', '000'],
  '=': ['000', '111', '000', '111', '000'], '/': ['001', '001', '010', '100', '100'],
  '-': ['000', '000', '111', '000', '000'], ' ': ['000', '000', '000', '000', '000'],
};

function drawText(cv: Canvas, text: string, x: number, y: number, c: RGBA, scale = 2): void {
  let cx = x;
  for (const raw of text.toUpperCase()) {
    const g = GLYPHS[raw] ?? GLYPHS[' ']!;
    for (let gy = 0; gy < 5; gy++) {
      const rowStr = g[gy] ?? '000';
      for (let gx = 0; gx < 3; gx++) {
        if (rowStr[gx] === '1') cv.fillRect(cx + gx * scale, y + gy * scale, cx + (gx + 1) * scale, y + (gy + 1) * scale, c);
      }
    }
    cx += (3 + 1) * scale;
  }
}

// ---------------------------------------------------------------------------
// Map walkability + floor band
// ---------------------------------------------------------------------------

/** True if a cell is walkable (non-wall, in legend). */
function isWalkable(map: MapData, row: number, col: number): boolean {
  const r = map.grid[row];
  if (r === undefined) return false;
  const ch = r[col];
  if (ch === undefined) return false;
  const cell = map.legend[ch];
  if (cell === undefined) return false;
  return cell.wall !== true;
}

/** Floor height of a cell (0 if wall/unknown). */
function floorOf(map: MapData, row: number, col: number): number {
  const ch = map.grid[row]?.[col];
  if (ch === undefined) return 0;
  return map.legend[ch]?.floor ?? 0;
}

/** Build a height-banded colour for a walkable cell (low = dark teal, high = warm sand). */
function floorColor(floor: number, lo: number, hi: number): RGBA {
  const span = Math.max(0.001, hi - lo);
  const t = Math.min(1, Math.max(0, (floor - lo) / span));
  // dark blue-green -> sand -> light highland
  const r = Math.round(40 + t * 170);
  const g = Math.round(90 + t * 120);
  const b = Math.round(120 - t * 70);
  return [r, g, b, 255];
}

// ---------------------------------------------------------------------------
// Render the grid into a canvas (returns the canvas + walkable-pixel mask)
// ---------------------------------------------------------------------------
interface GridRender {
  canvas: Canvas;
  /** Per-pixel: true if covered by a walkable cell. Length = CANVAS*CANVAS. */
  walkMask: Uint8Array;
}

function renderGrid(map: MapData, gridAlpha = 255): GridRender {
  const cv = new Canvas(CANVAS, CANVAS);
  const walkMask = new Uint8Array(CANVAS * CANVAS);

  // Floor range for banding.
  let lo = Infinity, hi = -Infinity;
  for (let row = 0; row < map.grid.length; row++) {
    for (let col = 0; col < (map.grid[row]?.length ?? 0); col++) {
      if (!isWalkable(map, row, col)) continue;
      const f = floorOf(map, row, col);
      if (f < lo) lo = f;
      if (f > hi) hi = f;
    }
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }

  const cps = cellPxSize();
  const half = cps / 2 + 0.6; // slight overlap so cells tile seamlessly

  for (let row = 0; row < map.grid.length; row++) {
    for (let col = 0; col < (map.grid[row]?.length ?? 0); col++) {
      const walk = isWalkable(map, row, col);
      // Skip pure void (out-of-legend) cells to keep background clean; render
      // explicit '#' walls dim so the building footprint reads.
      const ch = map.grid[row]?.[col];
      const inLegend = ch !== undefined && map.legend[ch] !== undefined;
      if (!inLegend) continue;

      const p = cellToRadarPx(col, row);
      const x0 = p.px - half, x1 = p.px + half, y0 = p.py - half, y1 = p.py + half;

      if (walk) {
        const c = floorColor(floorOf(map, row, col), lo, hi);
        cv.fillRect(x0, y0, x1, y1, [c[0], c[1], c[2], gridAlpha]);
        // mark walkable mask
        const mxa = Math.max(0, Math.floor(x0)), mxb = Math.min(CANVAS - 1, Math.ceil(x1));
        const mya = Math.max(0, Math.floor(y0)), myb = Math.min(CANVAS - 1, Math.ceil(y1));
        for (let my = mya; my <= myb; my++) for (let mx = mxa; mx <= mxb; mx++) walkMask[my * CANVAS + mx] = 1;
      } else {
        cv.fillRect(x0, y0, x1, y1, [38, 36, 40, Math.round(gridAlpha * 0.85)]);
      }
    }
  }

  return { canvas: cv, walkMask };
}

// ---------------------------------------------------------------------------
// Landmark markers
// ---------------------------------------------------------------------------
const CONF_COLOR: Record<string, RGBA> = {
  high: [80, 255, 120, 255],
  medium: [255, 210, 70, 255],
  low: [255, 110, 110, 255],
};

function drawLandmarks(cv: Canvas): void {
  const cps = cellPxSize();

  // Region bboxes first (outlines, behind points).
  for (const lm of DUST2_REGIONS) {
    if (lm.bbox === undefined) continue;
    const a = cellToRadarPx(lm.bbox.col0, lm.bbox.row0);
    const b = cellToRadarPx(lm.bbox.col1, lm.bbox.row1);
    const col = CONF_COLOR[lm.confidence] ?? CONF_COLOR.medium!;
    cv.strokeRect(
      a.px - cps / 2, a.py - cps / 2, b.px + cps / 2, b.py + cps / 2,
      [col[0], col[1], col[2], 170],
    );
    drawText(cv, lm.name, Math.min(a.px, b.px) + 2, Math.min(a.py, b.py) + 1, [col[0], col[1], col[2], 220], 1);
  }

  // Openings (short bars across the choke, sized by widthCells).
  for (const lm of DUST2_OPENINGS) {
    const p = cellToRadarPx(lm.col, lm.row);
    const col = CONF_COLOR[lm.confidence] ?? CONF_COLOR.medium!;
    const w = (lm.widthCells ?? 1) * cps;
    cv.fillRect(p.px - w / 2, p.py - cps * 0.35, p.px + w / 2, p.py + cps * 0.35, [col[0], col[1], col[2], 230]);
    drawText(cv, lm.name, p.px + 4, p.py - 6, [col[0], col[1], col[2], 230], 1);
  }

  // Points (dots).
  for (const lm of DUST2_POINTS) {
    const p = cellToRadarPx(lm.col, lm.row);
    const col = CONF_COLOR[lm.confidence] ?? CONF_COLOR.medium!;
    cv.disc(p.px, p.py, Math.max(2.5, cps * 0.45), col);
    cv.disc(p.px, p.py, Math.max(1, cps * 0.18), [10, 10, 10, 255]);
    drawText(cv, lm.name, p.px + 5, p.py - 3, [col[0], col[1], col[2], 235], 1);
  }
}

function drawLegend(cv: Canvas, iou: number | null): void {
  const x = 8, y = 8;
  cv.fillRect(x - 4, y - 4, x + 230, y + (iou !== null ? 78 : 64), [0, 0, 0, 170]);
  drawText(cv, 'CLODSTRIKE FIDELITY', x, y, [230, 200, 130, 255], 2);
  drawText(cv, 'HIGH CONF', x + 16, y + 16, CONF_COLOR.high!, 1);
  cv.disc(x + 8, y + 19, 3, CONF_COLOR.high!);
  drawText(cv, 'MED CONF', x + 16, y + 28, CONF_COLOR.medium!, 1);
  cv.disc(x + 8, y + 31, 3, CONF_COLOR.medium!);
  drawText(cv, 'LOW CONF', x + 16, y + 40, CONF_COLOR.low!, 1);
  cv.disc(x + 8, y + 43, 3, CONF_COLOR.low!);
  drawText(cv, 'FLOOR LOW-HIGH = COLD-WARM', x, y + 52, [180, 180, 190, 255], 1);
  if (iou !== null) {
    const ok = iou >= IOU_PASS_THRESHOLD;
    drawText(cv, `IOU ${iou.toFixed(3)} ${ok ? 'PASS' : 'FAIL'}`, x, y + 64, ok ? CONF_COLOR.high! : CONF_COLOR.low!, 2);
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encode/decode (node:zlib for the DEFLATE step)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const crc = crc32(body);
  const out = new Uint8Array(4 + body.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(4 + body.length, crc);
  return out;
}

function encodePNG(cv: Canvas): Uint8Array {
  const { w, h, data } = cv;
  // Raw image data with a 0 filter byte per scanline.
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter type 0 (None)
    raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type 6 = RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

interface DecodedImage { w: number; h: number; rgba: Uint8Array }

/** Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced, all 5 filter types. */
function decodePNG(buf: Uint8Array): DecodedImage {
  let p = 8; // skip signature
  let w = 0, h = 0, colorType = 6, bitDepth = 8;
  const idatParts: Uint8Array[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p < buf.length) {
    const len = dv.getUint32(p); p += 4;
    const type = String.fromCharCode(buf[p]!, buf[p + 1]!, buf[p + 2]!, buf[p + 3]!); p += 4;
    if (type === 'IHDR') {
      w = dv.getUint32(p); h = dv.getUint32(p + 4); bitDepth = buf[p + 8]!; colorType = buf[p + 9]!;
    } else if (type === 'IDAT') {
      idatParts.push(buf.subarray(p, p + len));
    } else if (type === 'IEND') {
      p += len + 4; break;
    }
    p += len + 4; // data + CRC
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}); expected 8-bit RGB/RGBA.`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const concatLen = idatParts.reduce((n, a) => n + a.length, 0);
  const concat = new Uint8Array(concatLen);
  { let o = 0; for (const a of idatParts) { concat.set(a, o); o += a.length; } }
  const raw = new Uint8Array(inflateSync(concat));

  const stride = w * channels;
  const rgba = new Uint8Array(w * h * 4);
  const prevLine = new Uint8Array(stride);
  const curLine = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++]!;
    for (let i = 0; i < stride; i++) {
      const rawByte = raw[rp++]!;
      const a = i >= channels ? curLine[i - channels]! : 0;
      const b = prevLine[i]!;
      const c = i >= channels ? prevLine[i - channels]! : 0;
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = rawByte + pred; break;
        }
        default: val = rawByte; break;
      }
      curLine[i] = val & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const s = x * channels;
      rgba[o] = curLine[s]!;
      rgba[o + 1] = curLine[s + 1]!;
      rgba[o + 2] = curLine[s + 2]!;
      rgba[o + 3] = channels === 4 ? curLine[s + 3]! : 255;
    }
    prevLine.set(curLine);
  }
  return { w, h, rgba };
}

// ---------------------------------------------------------------------------
// IoU: walkable-mask intersection-over-union vs a thresholded radar.
//
// A CS radar paints playable floor as light (sand/grey) and OOB/void as dark or
// transparent. We derive the radar's "walkable" mask by: pixel is walkable if it
// is sufficiently bright AND (if it has alpha) not transparent. The exact
// threshold is HONESTLY a heuristic that must be TUNED once a real ref image
// exists; record the achieved IoU + the threshold used in the ship commit.
// ---------------------------------------------------------------------------
const RADAR_BRIGHTNESS_THRESHOLD = 60; // luma 0..255; tune with the real image
const RADAR_ALPHA_THRESHOLD = 40;

function radarWalkMask(img: DecodedImage): { mask: Uint8Array; w: number; h: number } {
  const mask = new Uint8Array(img.w * img.h);
  for (let i = 0; i < img.w * img.h; i++) {
    const r = img.rgba[i * 4]!, g = img.rgba[i * 4 + 1]!, b = img.rgba[i * 4 + 2]!, a = img.rgba[i * 4 + 3]!;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    mask[i] = a >= RADAR_ALPHA_THRESHOLD && luma >= RADAR_BRIGHTNESS_THRESHOLD ? 1 : 0;
  }
  return { mask, w: img.w, h: img.h };
}

/** IoU of two boolean masks. Resamples grid mask to radar dims by nearest-pixel. */
function computeIoU(gridMask: Uint8Array, radar: { mask: Uint8Array; w: number; h: number }): number {
  let inter = 0, uni = 0;
  for (let y = 0; y < radar.h; y++) {
    for (let x = 0; x < radar.w; x++) {
      // Map radar pixel -> grid canvas pixel (both nominally CANVAS-sized; resample if not).
      const gx = Math.min(CANVAS - 1, Math.floor((x / radar.w) * CANVAS));
      const gy = Math.min(CANVAS - 1, Math.floor((y / radar.h) * CANVAS));
      const a = gridMask[gy * CANVAS + gx]! === 1;
      const bIdx = y * radar.w + x;
      const b = radar.mask[bIdx]! === 1;
      if (a || b) uni++;
      if (a && b) inter++;
    }
  }
  return uni === 0 ? 0 : inter / uni;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { map: string; out: string; overlay: string | null } {
  let map = 'dust2';
  let out: string | null = null;
  let overlay: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map') { map = argv[++i] ?? map; }
    else if (a === '--out') { out = argv[++i] ?? null; }
    else if (a === '--overlay') { overlay = argv[++i] ?? null; }
  }
  return { map, out: out ?? `ref/${map}-grid.png`, overlay };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  const { map: mapId, out, overlay } = parseArgs(process.argv.slice(2));

  let map: MapData;
  try {
    map = resolveMap(mapId);
  } catch (err) {
    console.error(`[render-grid] Unknown map id "${mapId}": ${String(err)}`);
    process.exit(1);
    return;
  }

  console.log(`[render-grid] Rendering "${map.name}" at radar scale ${CANVAS}x${CANVAS} (px/cell ${cellPxSize().toFixed(2)})`);

  // --- Optional overlay: load + threshold the reference radar (graceful absence) ---
  let radarMask: { mask: Uint8Array; w: number; h: number } | null = null;
  let radarImg: DecodedImage | null = null;
  if (overlay !== null) {
    if (!existsSync(overlay)) {
      console.log(
        `[render-grid] No reference radar at "${overlay}". ` +
        `Place a LOCAL de_dust2 radar PNG there (8-bit RGB/RGBA) to compute IoU. ` +
        `The radar image is copyrighted + gitignored — never fetched or committed. Rendering grid-only.`,
      );
    } else {
      try {
        radarImg = decodePNG(readFileSync(overlay));
        radarMask = radarWalkMask(radarImg);
        console.log(`[render-grid] Loaded reference radar ${radarImg.w}x${radarImg.h} from "${overlay}".`);
      } catch (err) {
        console.warn(`[render-grid] Failed to decode "${overlay}": ${String(err)}. Rendering grid-only.`);
      }
    }
  } else {
    console.log('[render-grid] No --overlay given; rendering grid-only (pass --overlay ref/de_dust2_radar.png to score IoU).');
  }

  // --- Render the grid (semi-transparent if we have a radar to blend over) ---
  const gridAlpha = radarImg !== null ? 150 : 255;
  const { canvas: gridCv, walkMask } = renderGrid(map, gridAlpha);

  // --- Compose ---
  let composed: Canvas;
  let iou: number | null = null;
  if (radarImg !== null && radarMask !== null) {
    // Blend grid over the radar image.
    composed = new Canvas(CANVAS, CANVAS, [0, 0, 0, 255]);
    // Paint radar (resampled to CANVAS) as the base.
    for (let y = 0; y < CANVAS; y++) {
      for (let x = 0; x < CANVAS; x++) {
        const rx = Math.min(radarImg.w - 1, Math.floor((x / CANVAS) * radarImg.w));
        const ry = Math.min(radarImg.h - 1, Math.floor((y / CANVAS) * radarImg.h));
        const ri = (ry * radarImg.w + rx) * 4;
        composed.blend(x, y, [radarImg.rgba[ri]!, radarImg.rgba[ri + 1]!, radarImg.rgba[ri + 2]!, 255]);
      }
    }
    // Blend the (semi-transparent) grid render over it.
    for (let y = 0; y < CANVAS; y++) {
      for (let x = 0; x < CANVAS; x++) {
        const i = (y * CANVAS + x) * 4;
        composed.blend(x, y, [gridCv.data[i]!, gridCv.data[i + 1]!, gridCv.data[i + 2]!, gridCv.data[i + 3]!]);
      }
    }
    iou = computeIoU(walkMask, radarMask);
  } else {
    composed = gridCv;
  }

  drawLandmarks(composed);
  drawLegend(composed, iou);

  // --- Write PNG ---
  const dir = dirname(out);
  if (dir.length > 0 && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(out, encodePNG(composed));
  console.log(`[render-grid] Wrote ${out}`);

  if (iou !== null) {
    const ok = iou >= IOU_PASS_THRESHOLD;
    console.log(`[render-grid] Walkable-mask IoU = ${iou.toFixed(4)}  (target >= ${IOU_PASS_THRESHOLD})  -> ${ok ? 'PASS' : 'FAIL'}`);
    console.log('[render-grid] NOTE: IoU threshold heuristics (brightness/alpha) must be tuned once a real radar exists; record the achieved IoU in the ship commit.');
  }
}

main();
