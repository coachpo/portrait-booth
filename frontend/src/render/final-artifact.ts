/**
 * Final render (OUT-001~006).
 * A single render produces an immutable FinalArtifact (sRGB JPEG blob + an
 * in-memory manifest); preview and export share renderMatrix, and this
 * module draws only the one final pass.
 */

import {
  isValidTransform,
  renderMatrix,
  type EditTransform,
  type Rect,
} from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import { resolveOutputSize, type OutputSizeOption } from "../editor/edit-transform";
import type { TemplateEntry } from "../lib/templates/types";
import { rewriteJfifDensity } from "./jpeg";

export interface FinalManifest {
  schemaVersion: 1;
  templateId: string;
  templateVersion: number;
  widthPx: number;
  heightPx: number;
  mime: "image/jpeg";
  orientationNormalized: true;
  matrix: [number, number, number, number, number, number];
  flipX: boolean;
}

/** EDT-009's measured result: JPEG does not preserve alpha, so it can only
 * be inspected on the canvas before encoding. */
export interface CoverageReport {
  /** Number of pixels actually scanned; 0 means the canvas pixels are
   * unreadable and the check result is unknown */
  scannedPixels: number;
  /** Pixels whose alpha is not full: when the crop frame leaves the source,
   * these become black corners after encoding */
  transparentPixels: number;
}

export interface FinalArtifact {
  artifactId: string;
  blob: Blob;
  manifest: FinalManifest;
  coverage: CoverageReport;
}

export interface RenderDeps {
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  canvasContext: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
  toBlob: (canvas: HTMLCanvasElement, type: string, quality: number) => Promise<Blob | null>;
  randomId: () => string;
  /** Read the full canvas RGBA pixels; null when unreadable (cross-origin
   * taint, etc.). */
  readPixels: (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => Uint8ClampedArray | null;
}

export const browserRenderDeps: RenderDeps = {
  createCanvas: (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  canvasContext: (canvas) => canvas.getContext("2d"),
  toBlob: (canvas, type, quality) =>
    new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
  randomId: () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  readPixels: (ctx, width, height) => {
    try {
      return ctx.getImageData(0, 0, width, height).data;
    } catch {
      return null;
    }
  },
};

// canvas.toBlob's quality is defined by the HTML spec as 0.0–1.0; UAs ignore
// out-of-range values and fall back to the default 0.92, so the whole binary
// search re-encodes the same bytes and OUT-003's size search is dead.
// A2: shares the same quality range with the server's
// backend/app/image_validate.py MIN/MAX_REENCODE_QUALITY
// (PIL integers 40–92, converted to 0.4–0.95); changing either end requires
// syncing both sides.
const MIN_QUALITY = 0.4;
const MAX_QUALITY = 0.95;
const QUALITY_STEPS = 10;
const QUALITY_EPSILON = 0.005;

export class RenderError extends Error {
  readonly kind: "size-limit" | "render-failed" | "ppi-failed" | "crop-out-of-bounds";
  constructor(kind: RenderError["kind"], message: string) {
    super(message);
    this.name = "RenderError";
    this.kind = kind;
  }
}

function renderMatrixValues(m: {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

export async function renderFinalArtifact(
  source: SourceImage,
  template: TemplateEntry,
  transform: EditTransform,
  deps: RenderDeps = browserRenderDeps,
  /** The user-selected size for ranged_pixels templates; empty/invalid falls
   * back to default (P6) */
  selectedSize?: OutputSizeOption | null,
): Promise<FinalArtifact> {
  const rev = template.revision;
  let widthPx: number;
  let heightPx: number;
  let ppi: number | null = null;
  switch (rev.output.kind) {
    case "exact_pixels":
      widthPx = rev.output.widthPx;
      heightPx = rev.output.heightPx;
      break;
    case "ranged_pixels": {
      const size = resolveOutputSize(rev, selectedSize) ?? {
        width: rev.output.defaultWidthPx,
        height: rev.output.defaultHeightPx,
      };
      widthPx = size.width;
      heightPx = size.height;
      break;
    }
    case "physical_raster":
      widthPx = rev.output.widthPx;
      heightPx = rev.output.heightPx;
      ppi = rev.output.printPpi;
      break;
    default:
      throw new RenderError("render-failed", "this template does not need local final rendering");
  }

  const out: Rect = { width: widthPx, height: heightPx };
  const src: Rect = { width: source.width, height: source.height };

  // Final assertion: the editor should have projected the transform back
  // into the valid region via fitTransform. Getting here still out of bounds
  // means a crop corner sits outside the source and the artifact would carry
  // black corners - better to error than to produce it.
  if (!isValidTransform(transform, src, out)) {
    throw new RenderError(
      "crop-out-of-bounds",
      "the crop frame is outside the source image, so the artifact would have blank or black corners; shrink the crop or reduce the rotation angle",
    );
  }

  const matrix = renderMatrix(transform, src, out);

  const canvas = deps.createCanvas(widthPx, heightPx);
  const ctx = deps.canvasContext(canvas);
  if (!ctx) throw new RenderError("render-failed", "cannot create the render canvas");
  ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.drawImage(source.bitmap, 0, 0, source.width, source.height);

  const coverage = scanCoverage(ctx, widthPx, heightPx, deps);

  const maxBytes = rev.outputFile?.sizeLimit?.maxBytes;
  const blob = maxBytes
    ? await searchQuality(canvas, maxBytes, deps)
    : await encode(canvas, MAX_QUALITY, deps);

  let finalBlob = blob;
  if (ppi) {
    try {
      finalBlob = await rewriteJfifDensity(blob, ppi);
    } catch {
      throw new RenderError(
        "ppi-failed",
        "the current browser's encoded JPEG cannot carry the print density, so this paper template cannot produce an artifact on this device for now; please try another browser",
      );
    }
  }

  return {
    artifactId: deps.randomId(),
    blob: finalBlob,
    coverage,
    manifest: {
      schemaVersion: 1,
      templateId: rev.id,
      templateVersion: rev.version,
      widthPx,
      heightPx,
      mime: "image/jpeg",
      orientationNormalized: true,
      matrix: renderMatrixValues(matrix),
      flipX: transform.flipX,
    },
  };
}

/** EDT-009: scan the canvas alpha before encoding. JPEG drops alpha, so
 * after encoding it is no longer inspectable. */
function scanCoverage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  deps: RenderDeps,
): CoverageReport {
  // After setTransform, getImageData still reads the whole canvas in device
  // pixels, unaffected by the current transform
  const data = deps.readPixels(ctx, width, height);
  if (!data || data.length < width * height * 4) {
    return { scannedPixels: 0, transparentPixels: 0 };
  }
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) transparent++;
  }
  return { scannedPixels: width * height, transparentPixels: transparent };
}

async function encode(canvas: HTMLCanvasElement, quality: number, deps: RenderDeps): Promise<Blob> {
  const blob = await deps.toBlob(canvas, "image/jpeg", quality);
  if (!blob) throw new RenderError("render-failed", "encoder unavailable");
  return blob;
}

/** OUT-003: bounded binary quality search; the mandated pixels must not
 * change; a clear error when unsatisfiable. */
async function searchQuality(
  canvas: HTMLCanvasElement,
  maxBytes: number,
  deps: RenderDeps,
): Promise<Blob> {
  let lo = MIN_QUALITY;
  let hi = MAX_QUALITY;
  let best: Blob | null = null;
  let bestQuality = -1;
  for (let i = 0; i < QUALITY_STEPS; i++) {
    const q = (lo + hi) / 2;
    const blob = await encode(canvas, q, deps);
    if (blob.size <= maxBytes) {
      if (q > bestQuality) {
        best = blob;
        bestQuality = q;
      }
      lo = q;
    } else {
      hi = q;
    }
    if (hi - lo <= QUALITY_EPSILON) break;
  }
  if (!best) {
    // The binary search starts from the midpoint, so the lower bound itself
    // is never tried; before giving up, try the minimum quality once
    const floor = await encode(canvas, MIN_QUALITY, deps);
    if (floor.size <= maxBytes) return floor;
    throw new RenderError(
      "size-limit",
      `cannot encode within ${maxBytes} bytes; consider a source image with more compression headroom`,
    );
  }
  return best;
}
