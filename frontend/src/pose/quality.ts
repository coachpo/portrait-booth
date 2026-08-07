/**
 * Exposure and sharpness heuristics (GDE-010).
 * QualityConfig is versioned: when any value is empty the check is disabled;
 * the first version only triggers warn and never fakes a "pass".
 */

export interface QualityConfig {
  version: string;
  /** Luminance color space */
  luminance: "luma-sRGB";
  /** Normalized long edge */
  normalizeLongEdge: 512;
  /** Dark clipping: luma at or below this counts as clipped */
  darkClipLevel: number;
  /** Dark-clip pixel ratio cap; above it warns underexposed */
  darkClipRatioLimit: number;
  /** Bright clipping: luma at or above this counts as clipped */
  brightClipLevel: number;
  /** Bright-clip pixel ratio cap; above it warns overexposed */
  brightClipRatioLimit: number;
  /** Sharpness operator */
  sharpnessOperator: "laplacian-variance";
  /** Laplacian variance floor (512px normalized); below it warns possibly blurry */
  sharpnessMin: number;
  /** Face ROI / whole-image fallback strategy (SPEC:167; behavior driven by whether an ROI is passed) */
  faceRoiStrategy: "landmark-bbox-expand" | "whole-image";
  /** ROI expansion ratio (matches face-geometry's ROI_EXPAND_RATIO) */
  roiExpandRatio: number;
  /** Background luma stddev cap; above it warns uneven background brightness */
  backgroundLumaStdMax: number;
  /** Background 3×3 block-mean range cap; above it warns uneven light/dark distribution */
  backgroundBlockRangeMax: number;
  /** Background left/right half mean-diff cap; above it warns unbalanced left/right shadows */
  shadowLeftRightDiffMax: number;
  /** Background top/bottom half mean-diff cap; above it warns unbalanced top/bottom shadows */
  shadowTopBottomDiffMax: number;
  testSetVersion: string;
  warnOnly: true;
}

/** First-version values await calibration against the fixed sample set in §12.3; until then they are heuristic warnings only */
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
  /** Stddev of background-pixel luma */
  lumaStd: number;
  /** Range of the background 3×3 block means */
  blockRange: number;
  /** Mean difference between the background's left and right halves */
  leftRightDiff: number;
  /** Mean difference between the background's top and bottom halves */
  topBottomDiff: number;
}

export interface QualityMetrics {
  darkClipRatio: number;
  brightClipRatio: number;
  /** Laplacian variance (after normalization) */
  sharpness: number;
  /** Background statistics; null when no ROI (whole-image fallback) or too few background pixels */
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

/** Static bitmap sources (all have pixel dimensions) */
export type StaticBitmapSource = ImageBitmap | HTMLCanvasElement;

export function analyzeQuality(
  bitmap: StaticBitmapSource,
  config: QualityConfig = QUALITY_CONFIG,
  deps: QualityDeps = browserQualityDeps,
  /** Normalized [0,1] face ROI (O2); default is whole-image fallback without background stats */
  roi?: FaceRoi | null,
): QualityResult {
  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (!longEdge)
    return { status: "unknown", issues: ["cannot read the image"], metrics: emptyMetrics() };
  const scale = config.normalizeLongEdge / longEdge;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = deps.createCanvas(width, height);
  const ctx = deps.canvasContext(canvas);
  if (!ctx)
    return {
      status: "unknown",
      issues: ["cannot create the analysis canvas"],
      metrics: emptyMetrics(),
    };
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;

  // luma = 0.299R + 0.587G + 0.114B (sRGB, approximating Rec.601)
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
    issues.push(`underexposed: dark-clipped pixels are ${(darkRatio * 100).toFixed(1)}%`);
  if (brightRatio > config.brightClipRatioLimit)
    issues.push(`overexposed: bright-clipped pixels are ${(brightRatio * 100).toFixed(1)}%`);
  if (sharpness < config.sharpnessMin)
    issues.push("image may be blurry: sharpness below the heuristic threshold");
  if (issues.length === 0)
    issues.push("exposure and sharpness show no obvious issues (heuristic, for reference only)");

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
 * Background statistics (O2): reuse the existing luma array, treating pixels
 * outside the ROI as background. Returns null when no ROI is passed
 * (whole-image fallback) or background pixels are under 10% of the total.
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

  // Range of the 3×3 block means
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

  // Left/right and top/bottom half mean differences
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
