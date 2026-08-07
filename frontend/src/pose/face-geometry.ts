/**
 * Face-landmark geometry heuristics (O2).
 * Pure functions: no canvas or MediaPipe dependency, only normalized landmark
 * arrays (canonical face mesh indices; see the faceMetrics comment in
 * tracking.ts).
 * Thresholds are uncalibrated placeholders (same as LANDMARKER_CONFIDENCE);
 * UI copy must carry HEURISTIC_NOTICE.
 */

import type { FaceObservation } from "./tracking";

/** Uncalibrated placeholder threshold: EAR below this flags "eyes may be closed" (vertical distance = 0.3× horizontal on the open-eye side) */
export const EAR_CLOSED_MAX = 0.25;
/** Uncalibrated placeholder threshold: MAR above this flags "mouth may be open" */
export const MAR_OPEN_MIN = 0.5;
/** ROI expansion ratio (on top of the normalized bounding box) */
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
 * Aspect-ratio-corrected vertical/horizontal distance ratio: landmark x is
 * normalized by image width and y by image height, so Δy_norm/Δx_norm is not
 * the true aspect ratio and must be multiplied by aspect = H / W.
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
 * Average two-eye EAR (Eye Aspect Ratio).
 * Left eye (159,145) vertical ÷ (33,133) horizontal; right eye (386,374)
 * vertical ÷ (362,263) horizontal.
 * Missing index or zero denominator returns null (never 0).
 */
export function eyeAspectRatio(face: FaceObservation, aspect: number): number | null {
  const left = eyeVerticalOverHorizontal(face, 159, 145, 33, 133);
  const right = eyeVerticalOverHorizontal(face, 386, 374, 362, 263);
  if (left === null || right === null) return null;
  return ((left + right) / 2) * aspect;
}

/**
 * Mouth MAR (Mouth Aspect Ratio): (13,14) vertical ÷ (61,291) horizontal.
 * Missing index or zero denominator returns null.
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
 * Face ROI: the normalized bounding box of all valid landmarks, expanded by
 * ROI_EXPAND_RATIO and clamped to [0,1]. Returns null when there are no valid
 * landmarks or the box is degenerate (zero width or height).
 */
export function faceRoi(face: FaceObservation, _aspect: number): FaceRoi | null {
  void _aspect; // kept for signature stability; the ROI is the raw landmark bbox
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
