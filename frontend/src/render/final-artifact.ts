/**
 * 终态渲染（OUT-001~006）。
 * 单次渲染生成不可变 FinalArtifact（sRGB JPEG blob + 内存 manifest）；
 * 预览与导出共用 renderMatrix，本模块只做一次最终绘制。
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

/** EDT-009 的实测结果：JPEG 不保留 alpha，只能在编码前的画布上看。 */
export interface CoverageReport {
  /** 实际扫描的像素数；0 表示画布像素不可读，检查结果为 unknown */
  scannedPixels: number;
  /** alpha 未满的像素数：裁剪框超出源图时，这些位置编码后会变成黑角 */
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
  /** 读取整幅画布的 RGBA 像素；不可读时返回 null（跨源污染等）。 */
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

// canvas.toBlob 的 quality 由 HTML 规范定义在 0.0–1.0；越界值 UA 一律忽略并回落到
// 默认 0.92，于是整个二分会反复编码出同一份字节，OUT-003 的体积搜索完全失效。
// A2：与服务端 backend/app/image_validate.py 的 MIN/MAX_REENCODE_QUALITY
// （PIL 整数 40–92，换算成 0.4–0.95）共享同一质量区间，两端改动必须同步。
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
  /** ranged_pixels 模板的用户选定尺寸；空/非法回落 default（P6） */
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
      throw new RenderError("render-failed", "该模板不需要本地终态渲染");
  }

  const out: Rect = { width: widthPx, height: heightPx };
  const src: Rect = { width: source.width, height: source.height };

  // 最后一道断言：编辑器应已用 fitTransform 把变换投影回合法区域。
  // 走到这里仍越界，说明裁剪框有一角落在源图之外，成品会带黑角——宁可报错也不出图。
  if (!isValidTransform(transform, src, out)) {
    throw new RenderError(
      "crop-out-of-bounds",
      "裁剪框超出源图边界，成品会出现空白或黑角；请缩小裁剪范围或减小旋转角度",
    );
  }

  const matrix = renderMatrix(transform, src, out);

  const canvas = deps.createCanvas(widthPx, heightPx);
  const ctx = deps.canvasContext(canvas);
  if (!ctx) throw new RenderError("render-failed", "无法创建渲染画布");
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
        "当前浏览器编码的 JPEG 无法写入打印密度，这个纸质模板暂时无法在本机生成成品，请更换浏览器后重试",
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

/** EDT-009：在编码前扫描画布 alpha。JPEG 丢弃 alpha，编码后再查已经查不到。 */
function scanCoverage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  deps: RenderDeps,
): CoverageReport {
  // setTransform 之后 getImageData 仍按设备像素取整幅画布，不受当前变换影响
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
    // 二分从中点起步，下界本身从未被试过；放弃前补一次最低质量
    const floor = await encode(canvas, MIN_QUALITY, deps);
    if (floor.size <= maxBytes) return floor;
    throw new RenderError(
      "size-limit",
      `无法在 ${maxBytes} 字节内编码，建议更换更高压缩容差的源图`,
    );
  }
  return best;
}
