/**
 * 源照片载入（SRC-001~005, §8.1）。
 * 顺序：大小限制 → 文件头解析（尺寸/格式/EXIF）→ 解码前限制 → 解码 →
 * EXIF 归一化 + 预算内缩放 → 归一化位图。选择文件不产生任何网络请求（SRC-005）。
 */

import { normalizedSize, orientationTransform, withScale } from "./exif";
import { parseImageHeader } from "./header";
import type { ImageFormat } from "./header";
import type { StaticCheckResult } from "../pose/static-check";

export interface SourceLimits {
  /** 单文件字节上限（SRC-002 默认 15 MB） */
  maxBytes: number;
  /** 像素上限（默认 24 MP） */
  maxMegapixels: number;
  /** 任一边上限（默认 8,000 px） */
  maxEdgePx: number;
  /** 归一化工作位图上限（§8.1.2 单工作位图 ≤16 MP） */
  maxWorkMegapixels: number;
}

export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  maxBytes: 15 * 1024 * 1024,
  maxMegapixels: 24,
  maxEdgePx: 8000,
  maxWorkMegapixels: 16,
};

/** 全部 RGBA 位图/Canvas 并存总预算（§8.1.2 默认 128 MiB） */
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
  /** 文件头中的 EXIF orientation（1–8，无信息为 1） */
  orientation: number;
  /** 解码前（文件头）像素尺寸 */
  rawWidth: number;
  rawHeight: number;
  /** 归一化 + 预算缩放后的工作位图尺寸 */
  width: number;
  height: number;
  bitmap: ImageBitmap;
  /** 预览用 Object URL（§8.1.2 原始 Blob 留会话内存） */
  previewUrl: string;
  /** 拍摄/上传后的静态复检结果（GDE-005/009；可能缺失） */
  staticChecks?: StaticCheckResult;
  /** 释放位图与 Object URL（§8.1.5）；调用后对象不可再用 */
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

/** 文件头读取窗口：覆盖所有目标格式的尺寸/方向字段 */
const HEADER_READ_BYTES = 64 * 1024;

export async function loadSourceImage(
  file: Blob,
  limits: SourceLimits = DEFAULT_SOURCE_LIMITS,
  deps: SourceImageDeps = browserDeps,
): Promise<SourceImage> {
  if (file.size > limits.maxBytes) {
    throw new SourceLoadError(
      "file-too-large",
      `文件大小 ${formatBytes(file.size)} 超过上限 ${formatBytes(limits.maxBytes)}`,
    );
  }

  const head = parseImageHeader(
    new Uint8Array(await file.slice(0, HEADER_READ_BYTES).arrayBuffer()),
  );
  if (!head) {
    throw new SourceLoadError("unsupported-format", "无法识别的图片格式，仅支持 JPEG、PNG、WebP");
  }
  if (head.format === "heif") {
    throw new SourceLoadError(
      "heif-unsupported",
      "不支持 HEIC/HEIF 格式：请将照片转换为 JPEG/PNG/WebP 后重试，或改用摄像头拍摄",
    );
  }
  if (head.width * head.height > limits.maxMegapixels * 1e6) {
    throw new SourceLoadError(
      "dimension-too-large",
      `像素 ${head.width}×${head.height}（${((head.width * head.height) / 1e6).toFixed(1)} MP）超过上限 ${limits.maxMegapixels} MP`,
    );
  }
  if (Math.max(head.width, head.height) > limits.maxEdgePx) {
    throw new SourceLoadError(
      "dimension-too-large",
      `边长 ${Math.max(head.width, head.height)} px 超过上限 ${limits.maxEdgePx} px`,
    );
  }

  let bitmap: ImageBitmap;
  let orientation = head.orientation;
  try {
    // 先不应用 EXIF，由本模块统一归一化（行为跨浏览器一致）
    bitmap = await deps.createImageBitmap(file, { imageOrientation: "none" });
  } catch {
    try {
      // 旧浏览器不支持 imageOrientation 选项：让浏览器应用 EXIF，视位图为已归一化
      bitmap = await deps.createImageBitmap(file);
      orientation = 1;
    } catch {
      throw new SourceLoadError("decode-failed", "无法解码图片");
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
  if (!ctx) throw new SourceLoadError("decode-failed", "无法解码图片");
  ctx.setTransform(
    withScale(orientationTransform(orientation, bitmap.width, bitmap.height), scale),
  );
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  let normalizedBitmap: ImageBitmap;
  try {
    normalizedBitmap = await deps.createImageBitmap(canvas);
  } catch {
    throw new SourceLoadError("decode-failed", "无法解码图片");
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
  "file-too-large": "文件大小超过上限（15 MB），请压缩或换一张照片。",
  "dimension-too-large": "照片像素超过上限（24 MP 或边长 8,000 px），请换一张照片。",
  "unsupported-format": "无法识别的图片格式，仅支持 JPEG、PNG、WebP。",
  "heif-unsupported":
    "不支持 HEIC/HEIF 格式。请将照片转换为 JPEG/PNG/WebP 后重试，或改用摄像头拍摄。",
  "decode-failed": "图片解码失败，文件可能已损坏。",
};

export function sourceErrorMessage(err: unknown): string {
  if (err instanceof SourceLoadError) return ERROR_MESSAGES[err.kind] ?? err.message;
  return "读取文件失败，请重试。";
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
