/**
 * JPEG metadata handling (OUT-004, OUT-006).
 * Canvas toBlob output naturally has no EXIF; paper templates need the JFIF
 * APP0 density rewritten to the template's mandated PPI.
 */

export interface JpegDensity {
  units: number; // 0=none 1=dpi 2=dpcm
  xdensity: number;
  ydensity: number;
}

/** Read the JFIF APP0 density; returns null for non-JFIF JPEGs. */
export function readJpegDensity(bytes: Uint8Array): JpegDensity | null {
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return null;
    const marker = bytes[off + 1];
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 2 || off + 2 + len > bytes.length) return null;
    if (marker === 0xe0 && len >= 14) {
      const p = off + 4;
      if (
        bytes[p] === 0x4a &&
        bytes[p + 1] === 0x46 &&
        bytes[p + 2] === 0x49 &&
        bytes[p + 3] === 0x46 &&
        bytes[p + 4] === 0x00
      ) {
        return {
          units: bytes[p + 7],
          xdensity: (bytes[p + 8] << 8) | bytes[p + 9],
          ydensity: (bytes[p + 10] << 8) | bytes[p + 11],
        };
      }
    }
    off += 2 + len;
  }
  return null;
}

/** Rewrite the JFIF APP0 density to the given PPI (units=1, dpi). Returns new bytes. */
export function rewriteJfifDensityBytes(bytes: Uint8Array, ppi: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let off = 2;
  while (off + 4 <= out.length) {
    if (out[off] !== 0xff) break;
    const marker = out[off + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (out[off + 2] << 8) | out[off + 3];
    if (len < 2 || off + 2 + len > out.length) break;
    if (marker === 0xe0 && len >= 14) {
      const p = off + 4;
      if (
        out[p] === 0x4a &&
        out[p + 1] === 0x46 &&
        out[p + 2] === 0x49 &&
        out[p + 3] === 0x46 &&
        out[p + 4] === 0x00
      ) {
        out[p + 7] = 1; // units = dpi
        out[p + 8] = (ppi >> 8) & 0xff;
        out[p + 9] = ppi & 0xff;
        out[p + 10] = (ppi >> 8) & 0xff;
        out[p + 11] = ppi & 0xff;
        return out;
      }
    }
    off += 2 + len;
  }
  throw new Error("JPEG has no JFIF APP0 segment; print density cannot be written");
}

/** Scan whether the JPEG contains an EXIF APP1 segment (OUT-004 stripping verification). */
export function hasExifSegment(bytes: Uint8Array): boolean {
  let off = 2;
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return false;
    const marker = bytes[off + 1];
    if (marker === 0xd9 || marker === 0xda) return false;
    const len = (bytes[off + 2] << 8) | bytes[off + 3];
    if (len < 2 || off + 2 + len > bytes.length) return false;
    if (marker === 0xe1 && len >= 8) {
      const p = off + 4;
      if (
        bytes[p] === 0x45 &&
        bytes[p + 1] === 0x78 &&
        bytes[p + 2] === 0x69 &&
        bytes[p + 3] === 0x66
      )
        return true;
    }
    off += 2 + len;
  }
  return false;
}

export async function rewriteJfifDensity(blob: Blob, ppi: number): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const rewritten = rewriteJfifDensityBytes(bytes, ppi);
  return new Blob([rewritten as BlobPart], { type: blob.type });
}
