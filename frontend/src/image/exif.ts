/**
 * EXIF orientation 1–8 normalization (SRC-003).
 * Normalization is an affine transform: target pixel coords = M · source
 * pixel coords. The transform is fully decoupled from edit coordinates - the
 * editor only ever sees the normalized bitmap.
 */

export interface Transform2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Transform2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function applyTransform(t: Transform2D, x: number, y: number): [number, number] {
  return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

export function normalizedSize(
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

/**
 * setTransform parameters for drawing the raw bitmap (orientation
 * unapplied) into the normalized canvas. The target canvas size must be
 * normalizedSize(rawW, rawH).
 */
export function orientationTransform(orientation: number, rawW: number, rawH: number): Transform2D {
  switch (orientation) {
    case 1:
      return IDENTITY;
    case 2:
      return { a: -1, b: 0, c: 0, d: 1, e: rawW, f: 0 };
    case 3:
      return { a: -1, b: 0, c: 0, d: -1, e: rawW, f: rawH };
    case 4:
      return { a: 1, b: 0, c: 0, d: -1, e: 0, f: rawH };
    case 5:
      return { a: 0, b: 1, c: 1, d: 0, e: 0, f: 0 };
    case 6:
      return { a: 0, b: -1, c: 1, d: 0, e: 0, f: rawW };
    case 7:
      return { a: 0, b: -1, c: -1, d: 0, e: rawH, f: rawW };
    case 8:
      return { a: 0, b: 1, c: -1, d: 0, e: rawH, f: 0 };
    default:
      return IDENTITY;
  }
}

/** Compose a uniform scale on top of the normalization transform (orient
 * first, then shrink into budget). */
export function withScale(t: Transform2D, scale: number): Transform2D {
  return {
    a: t.a * scale,
    b: t.b * scale,
    c: t.c * scale,
    d: t.d * scale,
    e: t.e * scale,
    f: t.f * scale,
  };
}
