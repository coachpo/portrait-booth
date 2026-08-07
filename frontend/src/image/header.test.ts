import { describe, expect, it } from "vitest";

import { parseImageHeader } from "./header";

function hiLo(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}

function hiLo32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Little-endian TIFF header + an IFD0 with only the Orientation tag */
function tiffOrientation(o: number): number[] {
  const b = new Array<number>(8 + 2 + 12 + 4).fill(0);
  b[0] = 0x49;
  b[1] = 0x49;
  b[2] = 0x2a;
  b[3] = 0x00; // TIFF magic
  b[4] = 8; // IFD0 offset
  b[8] = 1; // entry count = 1
  b[10] = 0x12;
  b[11] = 0x01; // tag 0x0112 Orientation
  b[12] = 3; // type SHORT
  b[14] = 1; // count = 1
  b[18] = o; // value
  return b;
}

function jpegSegment(marker: number, payload: number[]): number[] {
  return [0xff, marker, ...hiLo(payload.length + 2), ...payload];
}

function jpegBytes(
  width: number,
  height: number,
  orientation?: number,
  sofMarker = 0xc0,
): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  parts.push(...jpegSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 0, 0]));
  if (orientation !== undefined) {
    parts.push(
      ...jpegSegment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiffOrientation(orientation)]),
    );
  }
  parts.push(
    ...jpegSegment(sofMarker, [8, ...hiLo(height), ...hiLo(width), 1, 0x11, 0x00, 0x00, 0x00]),
  );
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function pngChunk(type: string, data: number[]): number[] {
  return [
    ...hiLo32(data.length),
    ...type.split("").map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function pngBytes(width: number, height: number, orientation?: number): Uint8Array {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...hiLo32(width), ...hiLo32(height), 8, 6, 0, 0, 0];
  const parts = [...magic, ...pngChunk("IHDR", ihdr)];
  if (orientation !== undefined) parts.push(...pngChunk("eXIf", tiffOrientation(orientation)));
  return new Uint8Array(parts);
}

function webpChunk(type: string, data: number[]): number[] {
  return [
    ...type.split("").map((c) => c.charCodeAt(0)),
    ...le32(data.length),
    ...data,
    ...(data.length % 2 === 1 ? [0] : []),
  ];
}

function webpBytes(
  variant: "vpx8" | "vp8" | "vp8l",
  width: number,
  height: number,
  orientation?: number,
): Uint8Array {
  const parts = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  if (variant === "vpx8") {
    const vpx8 = [0x10, 0, 0, 0, ...le32(width - 1).slice(0, 3), ...le32(height - 1).slice(0, 3)];
    parts.push(...webpChunk("VP8X", vpx8));
    if (orientation !== undefined) parts.push(...webpChunk("EXIF", tiffOrientation(orientation)));
  } else if (variant === "vp8") {
    parts.push(
      ...webpChunk("VP8 ", [
        0x9d,
        0x01,
        0x2a,
        width & 0xff,
        (width >> 8) & 0x3f,
        height & 0xff,
        (height >> 8) & 0x3f,
      ]),
    );
  } else {
    const w1 = width - 1;
    const h1 = height - 1;
    parts.push(
      ...webpChunk("VP8L", [
        0x2f,
        w1 & 0xff,
        ((w1 >> 8) & 0x3f) | ((h1 & 0x3) << 6),
        (h1 >> 2) & 0xff,
        (h1 >> 10) & 0x0f,
      ]),
    );
  }
  return new Uint8Array(parts);
}

function heicBytes(brand: string): Uint8Array {
  const b = [...le32(16), 0x66, 0x74, 0x79, 0x70, ...brand.split("").map((c) => c.charCodeAt(0))];
  return new Uint8Array(b);
}

describe("parseImageHeader", () => {
  it("parses JPEG dimensions and EXIF orientation", () => {
    const h = parseImageHeader(jpegBytes(640, 480, 6))!;
    expect(h).toEqual({ format: "jpeg", width: 640, height: 480, orientation: 6 });
  });

  it("defaults JPEG orientation to 1 when no EXIF", () => {
    const h = parseImageHeader(jpegBytes(320, 240))!;
    expect(h.orientation).toBe(1);
    expect(h.format).toBe("jpeg");
  });

  it("parses JPEG with progressive SOF2", () => {
    const h = parseImageHeader(jpegBytes(100, 200, undefined, 0xc2))!;
    expect(h).toEqual({ format: "jpeg", width: 100, height: 200, orientation: 1 });
  });

  it("parses PNG dimensions and eXIf orientation", () => {
    const h = parseImageHeader(pngBytes(100, 200, 8))!;
    expect(h).toEqual({ format: "png", width: 100, height: 200, orientation: 8 });
  });

  it("parses PNG without orientation", () => {
    const h = parseImageHeader(pngBytes(50, 60))!;
    expect(h).toEqual({ format: "png", width: 50, height: 60, orientation: 1 });
  });

  it("parses WebP VP8X canvas size and EXIF chunk orientation", () => {
    const h = parseImageHeader(webpBytes("vpx8", 640, 480, 3))!;
    expect(h).toEqual({ format: "webp", width: 640, height: 480, orientation: 3 });
  });

  it("parses WebP lossy (VP8) dimensions", () => {
    const h = parseImageHeader(webpBytes("vp8", 640, 480))!;
    expect(h).toEqual({ format: "webp", width: 640, height: 480, orientation: 1 });
  });

  it("parses WebP lossless (VP8L) dimensions", () => {
    const h = parseImageHeader(webpBytes("vp8l", 640, 480))!;
    expect(h).toEqual({ format: "webp", width: 640, height: 480, orientation: 1 });
  });

  it("detects HEIC/HEIF brands", () => {
    for (const brand of ["heic", "heix", "mif1"]) {
      const h = parseImageHeader(heicBytes(brand))!;
      expect(h.format).toBe("heif");
    }
  });

  it("rejects unknown and truncated input", () => {
    expect(parseImageHeader(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(parseImageHeader(new Uint8Array())).toBeNull();
    expect(parseImageHeader(jpegBytes(640, 480).slice(0, 8))).toBeNull();
    expect(parseImageHeader(pngBytes(100, 200).slice(0, 10))).toBeNull();
  });
});
