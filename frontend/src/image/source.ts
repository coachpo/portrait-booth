/**
 * Source photo loading (SRC-001~005, §8.1).
 * Order: size limits → header parsing (dimensions/format/EXIF) → pre-decode
 * limits → decode → EXIF normalization + budgeted scaling → normalized
 * bitmap. Selecting a file makes no network requests (SRC-005).
 */

import { normalizedSize, orientationTransform, withScale } from "./exif";
import { parseImageHeader } from "./header";
import type { ImageFormat } from "./header";
import type { StaticCheckResult } from "../pose/static-check";

export interface SourceLimits {
  /** Per-file byte cap (SRC-002 default 15 MB) */
  maxBytes: number;
  /** Pixel cap (default 24 MP) */
  maxMegapixels: number;
  /** Per-edge cap (default 8,000 px) */
  maxEdgePx: number;
  /** Normalized working-bitmap cap (§8.1.2: a single working bitmap ≤16 MP) */
  maxWorkMegapixels: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  maxBytes: 15 * 1024 * 1024,
  maxMegapixels: 24,
  maxEdgePx: 8000,
  maxWorkMegapixels: 16,
};

/** Total budget for all coexisting RGBA bitmaps/canvases (§8.1.2 default 128 MiB) */
export const TOTAL_BITMAP_BUDGET_BYTES = 128 * 1024 * 1024;

export type SourceErrorKind =
  | "file-too-large"
  | "dimension-too-large"
  | "unsupported-format"
  | "heif-unsupported"
  | "decode-failed";

export class SourceLoadError extends Error {
  readonly kind: SourceErrorKind;
  constructor(kind: SourceErrorKind, message: string) {
    super(message);
    this.name = "SourceLoadError";
    this.kind = kind;
  }
}

export interface SourceImage {
  file: Blob;
  format: Exclude<ImageFormat, "heif">;
  /** EXIF orientation from the file header (1–8; 1 when absent) */
  orientation: number;
  /** Pixel dimensions from the header (pre-decode) */
  rawWidth: number;
  rawHeight: number;
  /** Working bitmap size after normalization + budgeted scaling */
  width: number;
  height: number;
  bitmap: ImageBitmap;
  /** Object URL for preview (§8.1.2: the original Blob stays in session memory) */
  previewUrl: string;
  /** Static recheck result after capture/upload (GDE-005/009; may be absent) */
  staticChecks?: StaticCheckResult;
  /** Release the bitmap and Object URL (§8.1.5); the object must not be used after */
  dispose(): void;
}

export interface SourceImageDeps {
  createImageBitmap: (
    source: ImageBitmapSource,
    options?: ImageBitmapOptions,
  ) => Promise<ImageBitmap>;
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  canvasContext: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
}

export const browserDeps: SourceImageDeps = {
  createImageBitmap: (blob, options) => window.createImageBitmap(blob, options),
  createCanvas: (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  canvasContext: (canvas) => canvas.getContext("2d"),
};

/** File-header read window: covers all target formats' dimension/orientation fields */
const HEADER_READ_BYTES = 64 * 1024;

export async function loadSourceImage(
  file: Blob,
  limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  deps: SourceImageDeps = browserDeps,
): Promise<SourceImage> {
  if (file.size > limits.maxBytes) {
    throw new SourceLoadError(
      "file-too-large",
      `file size ${formatBytes(file.size)} exceeds the limit ${formatBytes(limits.maxBytes)}`,
    );
  }

  const head = parseImageHeader(
    new Uint8Array(await file.slice(0, HEADER_READ_BYTES).arrayBuffer()),
  );
  if (!head) {
    throw new SourceLoadError(
      "unsupported-format",
      "unrecognized image format; only JPEG, PNG, and WebP are supported",
    );
  }
  if (head.format === "heif") {
    throw new SourceLoadError(
      "heif-unsupported",
      "HEIC/HEIF is not supported: convert the photo to JPEG/PNG/WebP and retry, or use camera capture instead",
    );
  }
  if (head.width * head.height > limits.maxMegapixels * 1e6) {
    throw new SourceLoadError(
      "dimension-too-large",
      `pixels ${head.width}×${head.height} (${((head.width * head.height) / 1e6).toFixed(1)} MP) exceed the ${limits.maxMegapixels} MP cap`,
    );
  }
  if (Math.max(head.width, head.height) > limits.maxEdgePx) {
    throw new SourceLoadError(
      "dimension-too-large",
      `edge ${Math.max(head.width, head.height)} px exceeds the ${limits.maxEdgePx} px cap`,
    );
  }

  let bitmap: ImageBitmap;
  let orientation = head.orientation;
  try {
    // EXIF is not applied yet; this module normalizes centrally (consistent behavior across browsers)
    bitmap = await deps.createImageBitmap(file, { imageOrientation: "none" });
  } catch {
    try {
      // Older browsers lack the imageOrientation option: let the browser
      // apply EXIF and treat the bitmap as already normalized
      bitmap = await deps.createImageBitmap(file);
      orientation = 1;
    } catch {
      throw new SourceLoadError("decode-failed", "image cannot be decoded");
    }
  }

  const normalized = normalizedSize(bitmap.width, bitmap.height, orientation);
  const scale = Math.min(
    1,
    Math.sqrt((limits.maxWorkMegapixels * 1e6) / (normalized.width * normalized.height)),
  );
  const width = Math.max(1, Math.round(normalized.width * scale));
  const height = Math.max(1, Math.round(normalized.height * scale));

  const canvas = deps.createCanvas(width, height);
  const ctx = deps.canvasContext(canvas);
  if (!ctx) throw new SourceLoadError("decode-failed", "image cannot be decoded");
  ctx.setTransform(
    withScale(orientationTransform(orientation, bitmap.width, bitmap.height), scale),
  );
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  let normalizedBitmap: ImageBitmap;
  try {
    normalizedBitmap = await deps.createImageBitmap(canvas);
  } catch {
    throw new SourceLoadError("decode-failed", "image cannot be decoded");
  }

  const previewUrl = URL.createObjectURL(file);
  return {
    file,
    format: head.format as SourceImage["format"],
    orientation,
    rawWidth: head.width,
    rawHeight: head.height,
    width,
    height,
    bitmap: normalizedBitmap,
    previewUrl,
    dispose() {
      normalizedBitmap.close();
      URL.revokeObjectURL(previewUrl);
    },
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  "file-too-large": "file size exceeds the limit (15 MB); compress or choose another photo.",
  "dimension-too-large":
    "photo pixels exceed the limit (24 MP or 8,000 px per edge); choose another photo.",
  "unsupported-format": "unrecognized image format; only JPEG, PNG, and WebP are supported.",
  "heif-unsupported":
    "HEIC/HEIF is not supported. Convert the photo to JPEG/PNG/WebP and retry, or use camera capture instead.",
  "decode-failed": "image decoding failed; the file may be corrupt.",
};

export function sourceErrorMessage(err: unknown): string {
  if (err instanceof SourceLoadError) return ERROR_MESSAGES[err.kind] ?? err.message;
  return "failed to read the file; please retry.";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
