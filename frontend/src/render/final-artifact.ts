/**
 * 终态渲染（OUT-001~006）。
 * 单次渲染生成不可变 FinalArtifact（sRGB JPEG blob + 内存 manifest）；
 * 预览与导出共用 renderMatrix，本模块只做一次最终绘制。
 */

import { renderMatrix, type EditTransform, type Rect } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
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

export interface FinalArtifact {
  artifactId: string;
  blob: Blob;
  manifest: FinalManifest;
}

export interface RenderDeps {
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  canvasContext: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
  toBlob: (canvas: HTMLCanvasElement, type: string, quality: number) => Promise<Blob | null>;
  randomId: () => string;
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
};

const MIN_QUALITY = 40;
const MAX_QUALITY = 95;
const QUALITY_STEPS = 10;

export class RenderError extends Error {
  readonly kind: "size-limit" | "render-failed" | "ppi-failed";
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
    case "ranged_pixels":
      widthPx = rev.output.defaultWidthPx;
      heightPx = rev.output.defaultHeightPx;
      break;
    case "physical_raster":
      widthPx = rev.output.widthPx;
      heightPx = rev.output.heightPx;
      ppi = rev.output.printPpi;
      break;
    default:
      throw new RenderError("render-failed", "该模板不需要本地终态渲染");
  }

  const out: Rect = { width: widthPx, height: heightPx };
  const src: Rect = { width: source.width, height: source.height };
  const matrix = renderMatrix(transform, src, out);

  const canvas = deps.createCanvas(widthPx, heightPx);
  const ctx = deps.canvasContext(canvas);
  if (!ctx) throw new RenderError("render-failed", "无法创建渲染画布");
  ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  ctx.drawImage(source.bitmap, 0, 0, source.width, source.height);

  const maxBytes = rev.outputFile?.sizeLimit?.maxBytes;
  const blob = maxBytes
    ? await searchQuality(canvas, maxBytes, deps)
    : await encode(canvas, MAX_QUALITY, deps);

  const finalBlob = ppi ? await rewriteJfifDensity(blob, ppi) : blob;

  return {
    artifactId: deps.randomId(),
    blob: finalBlob,
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

async function encode(canvas: HTMLCanvasElement, quality: number, deps: RenderDeps): Promise<Blob> {
  const blob = await deps.toBlob(canvas, "image/jpeg", quality);
  if (!blob) throw new RenderError("render-failed", "编码器不可用");
  return blob;
}

/** OUT-003：有界二分质量搜索，不可改变规定像素；无法满足时清晰报错。 */
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
    const q = Math.round((lo + hi) / 2);
    const blob = await encode(canvas, q, deps);
    if (blob.size <= maxBytes) {
      if (q > bestQuality) {
        best = blob;
        bestQuality = q;
      }
      lo = q;
    } else {
      hi = q - 1;
    }
    if (lo >= hi) break;
  }
  if (!best) {
    throw new RenderError(
      "size-limit",
      `无法在 ${maxBytes} 字节内编码，建议更换更高压缩容差的源图`,
    );
  }
  return best;
}
