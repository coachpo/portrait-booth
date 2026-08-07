/**
 * File-header parsing (SRC-002: parse header dimensions before full
 * decoding). Supports JPEG / PNG / WebP dimensions and EXIF orientation, and
 * recognizes HEIC/HEIF.
 */

export type ImageFormat = "jpeg" | "png" | "webp" | "heif";

export interface ImageHeader {
  format: ImageFormat;
  width: number;
  height: number;
  /** EXIF orientation 1–8; 1 when no orientation info */
  orientation: number;
}

const ORIENTATION_TAG = 0x0112;

export function parseImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 12) return null;
  if (isJpeg(bytes)) return parseJpeg(bytes);
  if (isPng(bytes)) return parsePng(bytes);
  if (isWebp(bytes)) return parseWebp(bytes);
  if (isHeif(bytes)) return { format: "heif", width: 0, height: 0, orientation: 1 };
  return null;
}

function isJpeg(b: Uint8Array): boolean {
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isPng(b: Uint8Array): boolean {
  return (
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  );
}

function isWebp(b: Uint8Array): boolean {
  return (
    b[0] === 0x52 && // "RIFF"
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 && // "WEBP"
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  );
}

function isHeif(b: Uint8Array): boolean {
  if (b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return false; // "ftyp"
  const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
  return ["heic", "heix", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"].includes(brand);
}

/** TIFF IFD walk: returns the tag value (SHORT/LONG), null when not found. */
function parseTiffOrientation(data: Uint8Array): number | null {
  if (data.length < 8) return null;
  const littleEndian = data[0] === 0x49 && data[1] === 0x49;
  if (!littleEndian && !(data[0] === 0x4d && data[1] === 0x4d)) return null;
  if (data[2] !== 0x2a || data[3] !== 0x00) return null; // TIFF magic 0x2A00

  const u16 = (off: number): number =>
    littleEndian ? data[off] | (data[off + 1] << 8) : (data[off] << 8) | data[off + 1];
  const u32 = (off: number): number =>
    littleEndian
      ? data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)
      : (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];

  const ifdOffset = u32(4);
  if (ifdOffset + 2 > data.length) return null;
  const count = u16(ifdOffset);
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    if (entry + 12 > data.length) return null;
    if (u16(entry) === ORIENTATION_TAG && u16(entry + 2) === 3) {
      return u16(entry + 8);
    }
  }
  return null;
}

function parseJpeg(b: Uint8Array): ImageHeader | null {
  let width = 0;
  let height = 0;
  let orientation = 1;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) break;
    const marker = b[off + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2; // no length field
      continue;
    }
    const len = (b[off + 2] << 8) | b[off + 3];
    if (len < 2 || off + 2 + len > b.length) break;
    if (marker === 0xe1) {
      // APP1: "Exif\0\0" + TIFF
      const p = off + 4;
      if (
        len >= 8 &&
        b[p] === 0x45 &&
        b[p + 1] === 0x78 &&
        b[p + 2] === 0x69 &&
        b[p + 3] === 0x66 &&
        b[p + 4] === 0x00 &&
        b[p + 5] === 0x00
      ) {
        orientation = parseTiffOrientation(b.subarray(p + 6, off + 2 + len)) ?? 1;
      }
    } else if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      // SOF0–SOF15 (excluding DHT/JPG/DAC)
      height = (b[off + 5] << 8) | b[off + 6];
      width = (b[off + 7] << 8) | b[off + 8];
      break;
    }
    off += 2 + len;
  }
  if (width === 0 || height === 0) return null;
  return { format: "jpeg", width, height, orientation };
}

function parsePng(b: Uint8Array): ImageHeader | null {
  if (b.length < 24) return null;
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null; // "IHDR"
  const u32 = (off: number): number =>
    (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
  const width = u32(16);
  const height = u32(20);
  if (width === 0 || height === 0) return null;

  let orientation = 1;
  let off = 8;
  while (off + 12 <= b.length) {
    const len = u32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (type === "eXIf") {
      const start = off + 8;
      if (len >= 8 && start + len <= b.length) {
        orientation = parseTiffOrientation(b.subarray(start, start + len)) ?? 1;
      }
      break;
    }
    if (type === "IDAT") break; // eXIf is only allowed before IDAT
    off += 12 + len;
  }
  return { format: "png", width, height, orientation };
}

function parseWebp(b: Uint8Array): ImageHeader | null {
  let width = 0;
  let height = 0;
  let orientation = 1;
  let off = 12;
  while (off + 8 <= b.length) {
    const size = b[off + 4] | (b[off + 5] << 8) | (b[off + 6] << 16) | (b[off + 7] << 24);
    const chunk = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
    const data = off + 8;
    if (chunk === "VP8X") {
      if (data + 10 > b.length) return null;
      width = 1 + (b[data + 4] | (b[data + 5] << 8) | (b[data + 6] << 16));
      height = 1 + (b[data + 7] | (b[data + 8] << 8) | (b[data + 9] << 16));
      off += size % 2 === 1 ? 9 + size : 8 + size; // keep looking for the EXIF chunk
    } else if (chunk === "VP8 ") {
      if (data + 7 > b.length) return null;
      width = b[data + 3] | ((b[data + 4] & 0x3f) << 8);
      height = b[data + 5] | ((b[data + 6] & 0x3f) << 8);
      break;
    } else if (chunk === "VP8L") {
      if (data + 5 > b.length) return null;
      width = 1 + (b[data + 1] | ((b[data + 2] & 0x3f) << 8));
      height = 1 + ((b[data + 2] >> 6) | (b[data + 3] << 2) | ((b[data + 4] & 0x0f) << 10));
      break;
    } else if (chunk === "EXIF") {
      if (size >= 8 && data + size <= b.length) {
        orientation = parseTiffOrientation(b.subarray(data, data + size)) ?? 1;
      }
      break;
    } else {
      off += size % 2 === 1 ? 9 + size : 8 + size;
    }
  }
  if (width === 0 || height === 0) return null;
  return { format: "webp", width, height, orientation };
}
