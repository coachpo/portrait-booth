/**
 * Pose angle derivation (GDE-003).
 *
 * MediaPipe's facialTransformationMatrixes are **column-major** 4×4 (16
 * elements):
 *   R[row][col] = m[col * 4 + row]
 * and the top-left 3×3 is "rotation × uniform scale", not an orthogonal
 * rotation matrix - the scale comes from the model aligning the canonical
 * face model to the current face's size, typically 1.0–2.0.
 *
 * Two consequences:
 * 1. Reading row-major reads yaw and roll as the transposed angles, wrong in
 *    both sign and magnitude;
 * 2. pitch goes through asin and can saturate to ±90° after scale
 *    amplification.
 *
 * Convention: rotation matrix R = Ry(yaw)·Rx(pitch)·Rz(roll) (column
 * vectors).
 * Values are capture heuristics and must not be called official statutory
 * tolerances (GDE-004).
 */

export interface PoseAngles {
  yaw: number; // degrees
  pitch: number; // degrees
  roll: number; // degrees
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const RAD_TO_DEG = 180 / Math.PI;

/** Column-major 4×4 element access: R[row][col]. */
function at(m: number[], row: number, col: number): number {
  return m[col * 4 + row];
}

/**
 * Uniform scale factor of the top-left 3×3: the first column's length.
 * Under uniform scaling all three columns have equal length, so one column
 * suffices and also signals whether the matrix is degenerate.
 */
export function matrixScale(m: number[]): number {
  return Math.hypot(at(m, 0, 0), at(m, 1, 0), at(m, 2, 0));
}

/**
 * Decompose yaw/pitch/roll (degrees) from a column-major 4×4.
 *   pitch = asin(-R12 / s)
 *   yaw   = atan2(R02, R22)   -- a ratio; scale cancels out
 *   roll  = atan2(R10, R11)   -- same
 */
export function decomposeRotationMatrix(m: number[]): PoseAngles {
  const s = matrixScale(m) || 1;
  const pitch = Math.asin(clamp(-at(m, 1, 2) / s, -1, 1)) * RAD_TO_DEG;
  const yaw = Math.atan2(at(m, 0, 2), at(m, 2, 2)) * RAD_TO_DEG;
  const roll = Math.atan2(at(m, 1, 0), at(m, 1, 1)) * RAD_TO_DEG;
  return { yaw, pitch, roll };
}

/**
 * Validated decomposition: returns null when the matrix is missing, wrong
 * length, contains non-finite values, or is degenerate (scale 0).
 *
 * Callers must treat null as "no usable angles this frame", not "angles are
 * 0" - otherwise one frame of NaN gets smoothed into the EMA and every later
 * frame is NaN.
 */
export function decomposeFaceMatrix(m: number[] | undefined | null): PoseAngles | null {
  if (!m || m.length < 16) return null;
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(m[i])) return null;
  }
  if (matrixScale(m) < 1e-6) return null;
  const angles = decomposeRotationMatrix(m);
  if (!Number.isFinite(angles.yaw) || !Number.isFinite(angles.pitch)) return null;
  if (!Number.isFinite(angles.roll)) return null;
  return angles;
}

/**
 * Build a column-major 4×4 from angles (helper).
 *
 * Note: **do not use this as the only verification of
 * decomposeRotationMatrix** - verifying a hand-written decompose with a
 * hand-written compose is a self-referential loop, and tests stay green while
 * both sides read the matrix row-major. Real regression assertions must write
 * the matrix literal for known angles directly; see pose.test.ts.
 */
export function composeRotationMatrix(angles: PoseAngles, scale = 1): number[] {
  const y = (angles.yaw * Math.PI) / 180;
  const p = (angles.pitch * Math.PI) / 180;
  const r = (angles.roll * Math.PI) / 180;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cx = Math.cos(p);
  const sx = Math.sin(p);
  const cz = Math.cos(r);
  const sz = Math.sin(r);

  // R = Ry·Rx·Rz, written out by [row][col] then laid into column-major positions
  const r00 = cy * cz + sy * sx * sz;
  const r01 = -cy * sz + sy * sx * cz;
  const r02 = sy * cx;
  const r10 = cx * sz;
  const r11 = cx * cz;
  const r12 = -sx;
  const r20 = -sy * cz + cy * sx * sz;
  const r21 = sy * sz + cy * sx * cz;
  const r22 = cy * cx;

  const m = new Array<number>(16).fill(0);
  m[0] = r00 * scale;
  m[1] = r10 * scale;
  m[2] = r20 * scale;
  m[4] = r01 * scale;
  m[5] = r11 * scale;
  m[6] = r21 * scale;
  m[8] = r02 * scale;
  m[9] = r12 * scale;
  m[10] = r22 * scale;
  m[15] = 1;
  return m;
}

/** Normalize an angle to degrees (±180). */
export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
