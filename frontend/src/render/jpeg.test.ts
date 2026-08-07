import { describe, expect, it } from "vitest";

import { hasExifSegment, readJpegDensity, rewriteJfifDensityBytes } from "./jpeg";

/** Build a minimal JPEG: SOI + APP0 JFIF (density adjustable) + SOF0 + EOI */
function jpegBytes(
  opts: { xdensity?: number; ydensity?: number; units?: number; exif?: boolean } = {},
): Uint8Array {
  const app0 = [
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // "JFIF\0"
    0x01,
    0x01, // version 1.1
    opts.units ?? 1,
    ((opts.xdensity ?? 96) >> 8) & 0xff,
    (opts.xdensity ?? 96) & 0xff,
    ((opts.ydensity ?? 96) >> 8) & 0xff,
    (opts.ydensity ?? 96) & 0xff,
    0,
    0, // thumbnail
  ];
  const seg = (marker: number, payload: number[]): number[] => [
    0xff,
    marker,
    ((payload.length + 2) >> 8) & 0xff,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const parts: number[] = [0xff, 0xd8];
  parts.push(...seg(0xe0, app0));
  if (opts.exif) parts.push(...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0, 0, 0, 0, 0, 0]));
  parts.push(...seg(0xc0, [8, 0x01, 0x90, 0x01, 0x40, 1, 0x11, 0x00, 0x00, 0x00]));
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

describe("readJpegDensity", () => {
  it("reads JFIF density", () => {
    const d = readJpegDensity(jpegBytes({ xdensity: 96, ydensity: 96, units: 1 }))!;
    expect(d).toEqual({ units: 1, xdensity: 96, ydensity: 96 });
  });

  it("returns null for truncated input", () => {
    expect(readJpegDensity(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(readJpegDensity(new Uint8Array([]))).toBeNull();
  });
});

describe("rewriteJfifDensityBytes", () => {
  it("writes the template PPI as dpi units", () => {
    const out = rewriteJfifDensityBytes(jpegBytes({ xdensity: 96, ydensity: 96 }), 300);
    const d = readJpegDensity(out)!;
    expect(d).toEqual({ units: 1, xdensity: 300, ydensity: 300 });
  });

  it("throws when no JFIF APP0 exists", () => {
    const noJfif = new Uint8Array(jpegBytes({ exif: false }));
    noJfif[3] = 0xe1; // change APP0 to APP1, breaking JFIF
    expect(() => rewriteJfifDensityBytes(noJfif, 300)).toThrow();
  });
});

describe("hasExifSegment", () => {
  it("detects EXIF APP1", () => {
    expect(hasExifSegment(jpegBytes({ exif: true }))).toBe(true);
    expect(hasExifSegment(jpegBytes())).toBe(false);
  });
});
