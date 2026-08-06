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
  /** 脸部 ROI / 整图回退策略（SPEC:167；行为由是否传入 ROI 驱动） */
  faceRoiStrategy: "landmark-bbox-expand" | "whole-image";
  /** ROI 外扩比例（与 face-geometry 的 ROI_EXPAND_RATIO 一致） */
  roiExpandRatio: number;
  /** 背景 luma 标准差上限，超过则警告背景亮度不均 */
  backgroundLumaStdMax: number;
  /** 背景 3×3 分块均值极差上限，超过则警告明暗分布不均 */
  backgroundBlockRangeMax: number;
  /** 背景左右两半均值差上限，超过则警告左右阴影不平衡 */
  shadowLeftRightDiffMax: number;
  /** 背景上下两半均值差上限，超过则警告上下阴影不平衡 */
  shadowTopBottomDiffMax: number;
  testSetVersion: string;
  warnOnly: true;
}

/** 首版数值待 §12.3 固定样本校准；未校准前仅作启发式警告 */
export const QUALITY_CONFIG: QualityConfig = {
  version: "v2",
  luminance: "luma-sRGB",
  normalizeLongEdge: 512,
  darkClipLevel: 10,
  darkClipRatioLimit: 0.02,
  brightClipLevel: 245,
  brightClipRatioLimit: 0.02,
  sharpnessOperator: "laplacian-variance",
  sharpnessMin: 60,
  faceRoiStrategy: "landmark-bbox-expand",
  roiExpandRatio: 0.15,
  backgroundLumaStdMax: 30,
  backgroundBlockRangeMax: 60,
  shadowLeftRightDiffMax: 40,
  shadowTopBottomDiffMax: 40,
  testSetVersion: "uncalibrated-v1",
  warnOnly: true,
};

export interface BackgroundMetrics {
  /** 背景像素 luma 标准差 */
  lumaStd: number;
  /** 背景 3×3 分块均值的极差 */
  blockRange: number;
  /** 背景左右两半均值差 */
  leftRightDiff: number;
  /** 背景上下两半均值差 */
  topBottomDiff: number;
}

export interface QualityMetrics {
  darkClipRatio: number;
  brightClipRatio: number;
  /** 拉普拉斯方差（归一化后） */
  sharpness: number;
  /** 背景统计；未传 ROI（整图回退）或背景像素不足时为 null */
  background: BackgroundMetrics | null;
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

import type { FaceRoi } from "./face-geometry";

/** 静态位图来源（均有像素尺寸） */
export type StaticBitmapSource = ImageBitmap | HTMLCanvasElement;

export function analyzeQuality(
  bitmap: StaticBitmapSource,
  config: QualityConfig = QUALITY_CONFIG,
  deps: QualityDeps = browserQualityDeps,
  /** 归一化 [0,1] 人脸 ROI（O2）；缺省为整图回退，不计算背景 */
  roi?: FaceRoi | null,
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
  const background = roi ? backgroundMetrics(luma, width, height, roi) : null;

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
    metrics: {
      darkClipRatio: darkRatio,
      brightClipRatio: brightRatio,
      sharpness,
      background,
    },
  };
}

/**
 * 背景统计（O2）：只用已有 luma 数组，把 ROI 之外的像素当背景。
 * 未传 ROI（整图回退）或背景像素少于总像素 10% 时返回 null。
 */
function backgroundMetrics(
  luma: Float32Array,
  width: number,
  height: number,
  roi: FaceRoi,
): BackgroundMetrics | null {
  const px0 = Math.max(0, Math.floor(roi.x * width));
  const py0 = Math.max(0, Math.floor(roi.y * height));
  const px1 = Math.min(width, Math.ceil((roi.x + roi.width) * width));
  const py1 = Math.min(height, Math.ceil((roi.y + roi.height) * height));
  const inRoi = (x: number, y: number) => x >= px0 && x < px1 && y >= py0 && y < py1;

  const bg: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inRoi(x, y)) continue;
      bg.push(luma[y * width + x]);
    }
  }
  const total = width * height;
  if (bg.length / total < 0.1) return null;

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const lumaMean = mean(bg);
  const lumaStd = Math.sqrt(bg.reduce((s, v) => s + (v - lumaMean) ** 2, 0) / bg.length);

  // 3×3 分块均值的极差
  const blockMeans: number[] = [];
  for (let by = 0; by < 3; by++) {
    for (let bx = 0; bx < 3; bx++) {
      const bsx = Math.floor((bx * width) / 3);
      const bex = Math.max(bsx + 1, Math.floor(((bx + 1) * width) / 3));
      const bsy = Math.floor((by * height) / 3);
      const bey = Math.max(bsy + 1, Math.floor(((by + 1) * height) / 3));
      let sum = 0;
      let n = 0;
      for (let y = bsy; y < bey; y++) {
        for (let x = bsx; x < bex; x++) {
          if (inRoi(x, y)) continue;
          sum += luma[y * width + x];
          n++;
        }
      }
      if (n > 0) blockMeans.push(sum / n);
    }
  }
  const blockRange = blockMeans.length > 0 ? Math.max(...blockMeans) - Math.min(...blockMeans) : 0;

  // 左右两半 / 上下两半均值差
  const half = (predicate: (x: number, y: number) => boolean): number | null => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (inRoi(x, y) || !predicate(x, y)) continue;
        sum += luma[y * width + x];
        n++;
      }
    }
    return n > 0 ? sum / n : null;
  };
  const left = half((x) => x < width / 2);
  const right = half((x) => x >= width / 2);
  const top = half((_x, y) => y < height / 2);
  const bottom = half((_x, y) => y >= height / 2);
  const leftRightDiff = left !== null && right !== null ? Math.abs(left - right) : 0;
  const topBottomDiff = top !== null && bottom !== null ? Math.abs(top - bottom) : 0;

  return { lumaStd, blockRange, leftRightDiff, topBottomDiff };
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
  return { darkClipRatio: 0, brightClipRatio: 0, sharpness: 0, background: null };
}
