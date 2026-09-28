/**
 * One-shot PWA icon generator (Node only — never imported by app code).
 *
 * Run from the repo root:
 *
 *     ./node_modules/.bin/tsx lib/offline/generate-icons.ts
 *
 * It writes real PNG files into `public/icons/`. There is no image dependency
 * available in this project, so the encoder below is a complete, minimal PNG
 * writer: zlib-deflated RGBA scanlines, CRC32 chunks, IHDR/IDAT/IEND.
 *
 * Art: the Klang Valley route mark — an emerald route line with station stops,
 * over a band that stands for the P90 spread, on the app's navy background.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* -------------------------------------------------------------------------- */
/* Minimal raster + drawing                                                    */
/* -------------------------------------------------------------------------- */

type Rgba = readonly [number, number, number, number];

interface Raster {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major. */
  data: Uint8Array;
}

function makeRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Source-over alpha compositing. */
function blend(raster: Raster, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return;
  const [r, g, b, a] = color;
  if (a <= 0) return;
  const index = (y * raster.width + x) * 4;
  const srcA = a / 255;
  const dstA = raster.data[index + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    raster.data[index] = 0;
    raster.data[index + 1] = 0;
    raster.data[index + 2] = 0;
    raster.data[index + 3] = 0;
    return;
  }
  raster.data[index] = Math.round((r * srcA + raster.data[index] * dstA * (1 - srcA)) / outA);
  raster.data[index + 1] = Math.round(
    (g * srcA + raster.data[index + 1] * dstA * (1 - srcA)) / outA,
  );
  raster.data[index + 2] = Math.round(
    (b * srcA + raster.data[index + 2] * dstA * (1 - srcA)) / outA,
  );
  raster.data[index + 3] = Math.round(outA * 255);
}

function insideRoundedRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distanceToSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - x0) * vx + (py - y0) * vy) / lengthSq));
  const dx = px - (x0 + t * vx);
  const dy = py - (y0 + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function fillCircle(raster: Raster, cx: number, cy: number, radius: number, color: Rgba): void {
  const x0 = Math.floor(cx - radius - 1);
  const x1 = Math.ceil(cx + radius + 1);
  const y0 = Math.floor(cy - radius - 1);
  const y1 = Math.ceil(cy + radius + 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= radius * radius) blend(raster, x, y, color);
    }
  }
}

function fillRoundedRect(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  colorAt: (x: number, y: number) => Rgba,
): void {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x += 1) {
      if (insideRoundedRect(x + 0.5, y + 0.5, x0, y0, x1, y1, radius)) {
        blend(raster, x, y, colorAt(x, y));
      }
    }
  }
}

function strokeCapsule(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: Rgba,
): void {
  const half = width / 2;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (distanceToSegment(x + 0.5, y + 0.5, x0, y0, x1, y1) <= half) {
        blend(raster, x, y, color);
      }
    }
  }
}

/** Box-downsample by an integer factor — this is where the anti-aliasing comes from. */
function downsample(source: Raster, factor: number): Raster {
  const width = source.width / factor;
  const height = source.height / factor;
  const out = makeRaster(width, height);
  const samples = factor * factor;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = ((y * factor + sy) * source.width + (x * factor + sx)) * 4;
          const alpha = source.data[index + 3] / 255;
          r += source.data[index] * alpha;
          g += source.data[index + 1] * alpha;
          b += source.data[index + 2] * alpha;
          a += alpha;
        }
      }
      const outIndex = (y * width + x) * 4;
      if (a <= 0) {
        out.data[outIndex] = 0;
        out.data[outIndex + 1] = 0;
        out.data[outIndex + 2] = 0;
        out.data[outIndex + 3] = 0;
      } else {
        out.data[outIndex] = Math.round(r / a);
        out.data[outIndex + 1] = Math.round(g / a);
        out.data[outIndex + 2] = Math.round(b / a);
        out.data[outIndex + 3] = Math.round((a / samples) * 255);
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Minimal PNG encoder                                                         */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(raster: Raster): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(raster.width, 0);
  ihdr.writeUInt32BE(raster.height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  const stride = raster.width * 4;
  const raw = Buffer.alloc((stride + 1) * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(raster.data.buffer, raster.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* The artwork                                                                 */
/* -------------------------------------------------------------------------- */

const NAVY_TOP: Rgba = [15, 23, 42, 255];
const NAVY_BOTTOM: Rgba = [8, 14, 28, 255];
const EMERALD: Rgba = [52, 211, 153, 255];
const EMERALD_BAND: Rgba = [52, 211, 153, 46];
const WHITE: Rgba = [244, 248, 255, 255];

export interface IconRenderOptions {
  /** Full-bleed square background and a glyph inside the maskable safe zone. */
  maskable?: boolean;
  /** Supersampling factor. 4 gives 16 samples per output pixel. */
  supersample?: number;
}

export function renderIconPng(size: number, options: IconRenderOptions = {}): Buffer {
  const factor = options.supersample ?? 4;
  const maskable = options.maskable ?? false;
  const S = size * factor;
  const canvas = makeRaster(S, S);

  // Background: rounded square for "any", full bleed for "maskable".
  const radius = maskable ? 0 : S * 0.22;
  fillRoundedRect(canvas, 0, 0, S, S, radius, (_x, y) => {
    const t = y / S;
    return [
      Math.round(NAVY_TOP[0] + (NAVY_BOTTOM[0] - NAVY_TOP[0]) * t),
      Math.round(NAVY_TOP[1] + (NAVY_BOTTOM[1] - NAVY_TOP[1]) * t),
      Math.round(NAVY_TOP[2] + (NAVY_BOTTOM[2] - NAVY_TOP[2]) * t),
      255,
    ];
  });

  // Glyph geometry in 0..1 space, scaled into the safe zone for maskable icons.
  const scale = maskable ? 0.62 : 1;
  const offset = (1 - scale) / 2;
  const px = (v: number): number => (offset + v * scale) * S;
  const unit = S * scale;

  const points: Array<readonly [number, number]> = [
    [0.25, 0.74],
    [0.5, 0.46],
    [0.76, 0.27],
  ];

  // The P90 band: a translucent wide stroke behind the route line.
  for (let i = 0; i < points.length - 1; i += 1) {
    strokeCapsule(
      canvas,
      px(points[i][0]),
      px(points[i][1]),
      px(points[i + 1][0]),
      px(points[i + 1][1]),
      unit * 0.2,
      EMERALD_BAND,
    );
  }

  // The route line.
  for (let i = 0; i < points.length - 1; i += 1) {
    strokeCapsule(
      canvas,
      px(points[i][0]),
      px(points[i][1]),
      px(points[i + 1][0]),
      px(points[i + 1][1]),
      unit * 0.075,
      EMERALD,
    );
  }

  // Station stops.
  for (const [x, y] of points) {
    fillCircle(canvas, px(x), px(y), unit * 0.062, WHITE);
  }

  return encodePng(downsample(canvas, factor));
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

interface IconSpec {
  file: string;
  size: number;
  maskable?: boolean;
}

export const ICON_SPECS: readonly IconSpec[] = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180 },
];

export function iconOutputDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../public/icons");
}

export function generateIcons(directory = iconOutputDir()): Array<{ file: string; bytes: number }> {
  mkdirSync(directory, { recursive: true });
  return ICON_SPECS.map((spec) => {
    const png = renderIconPng(spec.size, { maskable: spec.maskable });
    const target = resolve(directory, spec.file);
    writeFileSync(target, png);
    return { file: target, bytes: png.length };
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const written = generateIcons();
  for (const entry of written) {
    console.log(`${entry.file}  ${entry.bytes} bytes`);
  }
}
