/**
 * 曝光与清晰度启发式（GDE-010）。
 * QualityConfig 版本化：任何数值为空都不启用；首版只触发 warn，不伪造“通过”。
 */

export interface QualityConfig {
  version: string;
  /** 亮度颜色空间 */
  luminance: "luma-sRGB";
  /** 归一化长边 */
  normalizeLongEdge: 512;
  /** 暗剪切：≤该亮度视为剪切 */
  darkClipLevel: number;
  /** 暗剪切像素比例上限，超过则警告欠曝 */
  darkClipRatioLimit: number;
  /** 亮剪切：≥该亮度视为剪切 */
  brightClipLevel: number;
  /** 亮剪切像素比例上限，超过则警告过曝 */
  brightClipRatioLimit: number;
  /** 清晰度算子 */
  sharpnessOperator: "laplacian-variance";
  /** 拉普拉斯方差下限（512px 归一化），低于则警告可能模糊 */
  sharpnessMin: number;
  testSetVersion: string;
  warnOnly: true;
}

/** 首版数值待 §12.3 固定样本校准；未校准前仅作启发式警告 */
export const QUALITY_CONFIG: QualityConfig = {
  version: "v1",
  luminance: "luma-sRGB",
  normalizeLongEdge: 512,
  darkClipLevel: 10,
  darkClipRatioLimit: 0.02,
  brightClipLevel: 245,
  brightClipRatioLimit: 0.02,
  sharpnessOperator: "laplacian-variance",
  sharpnessMin: 60,
  testSetVersion: "uncalibrated-v1",
  warnOnly: true,
};

export interface QualityMetrics {
  darkClipRatio: number;
  brightClipRatio: number;
  /** 拉普拉斯方差（归一化后） */
  sharpness: number;
}

export interface QualityResult {
  status: "warn" | "unknown";
  issues: string[];
  metrics: QualityMetrics;
}

export interface QualityDeps {
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  canvasContext: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
}

export const browserQualityDeps: QualityDeps = {
  createCanvas: (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  canvasContext: (canvas) => canvas.getContext("2d"),
};

/** 静态位图来源（均有像素尺寸） */
export type StaticBitmapSource = ImageBitmap | HTMLCanvasElement;

export function analyzeQuality(
  bitmap: StaticBitmapSource,
  config: QualityConfig = QUALITY_CONFIG,
  deps: QualityDeps = browserQualityDeps,
): QualityResult {
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (!longEdge) return { status: "unknown", issues: ["无法读取图像"], metrics: emptyMetrics() };
  const scale = config.normalizeLongEdge / longEdge;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = deps.createCanvas(width, height);
  const ctx = deps.canvasContext(canvas);
  if (!ctx) return { status: "unknown", issues: ["无法创建分析画布"], metrics: emptyMetrics() };
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;

  // luma = 0.299R + 0.587G + 0.114B（sRGB，近似 Rec.601）
  const luma = new Float32Array(width * height);
  let dark = 0;
  let bright = 0;
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    const v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    luma[i] = v;
    if (v <= config.darkClipLevel) dark++;
    if (v >= config.brightClipLevel) bright++;
  }
  const darkRatio = dark / luma.length;
  const brightRatio = bright / luma.length;

  const sharpness = laplacianVariance(luma, width, height);

  const issues: string[] = [];
  if (darkRatio > config.darkClipRatioLimit)
    issues.push(`曝光不足：暗部剪切像素占 ${(darkRatio * 100).toFixed(1)}%`);
  if (brightRatio > config.brightClipRatioLimit)
    issues.push(`曝光过度：亮部剪切像素占 ${(brightRatio * 100).toFixed(1)}%`);
  if (sharpness < config.sharpnessMin) issues.push("图像可能模糊：清晰度低于启发式阈值");
  if (issues.length === 0) issues.push("曝光与清晰度未发现明显问题（启发式，仅供参考）");

  return {
    status: "warn",
    issues,
    metrics: { darkClipRatio: darkRatio, brightClipRatio: brightRatio, sharpness },
  };
}

function laplacianVariance(luma: Float32Array, width: number, height: number): number {
  const lap = new Float32Array(width * height);
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = -4 * luma[i] + luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width];
      lap[i] = v;
      sum += v;
      sumSq += v * v;
    }
  }
  const n = lap.length;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function emptyMetrics(): QualityMetrics {
  return { darkClipRatio: 0, brightClipRatio: 0, sharpness: 0 };
}
