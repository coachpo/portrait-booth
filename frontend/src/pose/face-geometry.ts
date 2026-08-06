/**
 * 人脸关键点几何启发式（O2）。
 * 纯函数：不依赖 canvas 与 MediaPipe，只吃归一化 landmark 数组（canonical
 * face mesh 索引，见 tracking.ts 的 faceMetrics 注释）。
 * 阈值是未校准占位值（同 LANDMARKER_CONFIDENCE），UI 文案必须带 HEURISTIC_NOTICE。
 */

import type { FaceObservation } from "./tracking";

/** 未校准占位阈值：EAR 低于它判定「疑似闭眼」（竖距 = 横距 0.3 倍在睁眼一侧） */
export const EAR_CLOSED_MAX = 0.25;
/** 未校准占位阈值：MAR 高于它判定「疑似张嘴」 */
export const MAR_OPEN_MIN = 0.5;
/** ROI 外扩比例（归一化包围盒基础上） */
export const ROI_EXPAND_RATIO = 0.15;

export interface FaceRoi {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

function pt(face: FaceObservation, index: number): Point | null {
  const p = face.landmarks[index];
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

/**
 * 纵横比校正的竖/横距比：landmark 的 x 按图宽、y 按图高归一化，
 * 所以 Δy_norm/Δx_norm 不是真实纵横比，必须乘以 aspect = H / W。
 */
function ratioWithAspect(dy: number, dx: number, aspect: number): number | null {
  if (dx === 0 || !Number.isFinite(dy) || !Number.isFinite(aspect)) return null;
  const r = (dy / dx) * aspect;
  return Number.isFinite(r) ? r : null;
}

function eyeVerticalOverHorizontal(
  face: FaceObservation,
  top: number,
  bottom: number,
  outer: number,
  inner: number,
): number | null {
  const a = pt(face, top);
  const b = pt(face, bottom);
  const c = pt(face, outer);
  const d = pt(face, inner);
  if (!a || !b || !c || !d) return null;
  return ratioWithAspect(Math.abs(b.y - a.y), Math.abs(d.x - c.x), 1);
}

/**
 * 平均双眼 EAR（Eye Aspect Ratio）。
 * 左眼 (159,145) 竖距 ÷ (33,133) 横距；右眼 (386,374) 竖距 ÷ (362,263) 横距。
 * 任一索引缺失或分母为 0 返回 null（不返回 0）。
 */
export function eyeAspectRatio(face: FaceObservation, aspect: number): number | null {
  const left = eyeVerticalOverHorizontal(face, 159, 145, 33, 133);
  const right = eyeVerticalOverHorizontal(face, 386, 374, 362, 263);
  if (left === null || right === null) return null;
  return ((left + right) / 2) * aspect;
}

/**
 * 嘴部 MAR（Mouth Aspect Ratio）：(13,14) 竖距 ÷ (61,291) 横距。
 * 索引缺失或分母为 0 返回 null。
 */
export function mouthAspectRatio(face: FaceObservation, aspect: number): number | null {
  const a = pt(face, 13);
  const b = pt(face, 14);
  const c = pt(face, 61);
  const d = pt(face, 291);
  if (!a || !b || !c || !d) return null;
  return ratioWithAspect(Math.abs(b.y - a.y), Math.abs(d.x - c.x), aspect);
}

/**
 * 人脸 ROI：全部有效 landmark 的归一化包围盒，按 ROI_EXPAND_RATIO 外扩并
 * 夹到 [0,1]。无有效 landmark 或包围盒退化（宽或高为 0）返回 null。
 */
export function faceRoi(face: FaceObservation, _aspect: number): FaceRoi | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const p of face.landmarks) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    count++;
  }
  if (count === 0) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 || h <= 0) return null;
  const x = Math.max(0, minX - w * ROI_EXPAND_RATIO);
  const y = Math.max(0, minY - h * ROI_EXPAND_RATIO);
  const right = Math.min(1, maxX + w * ROI_EXPAND_RATIO);
  const bottom = Math.min(1, maxY + h * ROI_EXPAND_RATIO);
  return { x, y, width: right - x, height: bottom - y };
}
