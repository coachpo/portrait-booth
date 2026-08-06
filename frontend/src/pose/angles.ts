/**
 * 姿态角推导（GDE-003）。
 * 从 MediaPipe facial transformation matrix（4×4 行主序，16 元素）分解
 * yaw/pitch/roll。约定：旋转矩阵 R = Ry(yaw)·Rx(pitch)·Rz(roll)（列向量）。
 * 数值为拍摄启发式，不称为官方法定容差（GDE-004）。
 */

export interface PoseAngles {
  yaw: number; // 度
  pitch: number; // 度
  roll: number; // 度
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const RAD_TO_DEG = 180 / Math.PI;

/**
 * 行主序 4×4（16 元素）：row0=m[0..3], row1=m[4..7], row2=m[8..11]。
 *   pitch = asin(-r12)（m[6]）
 *   yaw   = atan2(r02, r22)（m[2], m[10]）
 *   roll  = atan2(r10, r11)（m[4], m[5]）
 */
export function decomposeRotationMatrix(m: number[]): PoseAngles {
  const pitch = Math.asin(clamp(-m[6], -1, 1)) * RAD_TO_DEG;
  const yaw = Math.atan2(m[2], m[10]) * RAD_TO_DEG;
  const roll = Math.atan2(m[4], m[5]) * RAD_TO_DEG;
  return { yaw, pitch, roll };
}

/** 由角度构造 4×4 行主序矩阵（用于校准测试）。 */
export function composeRotationMatrix(angles: PoseAngles): number[] {
  const y = (angles.yaw * Math.PI) / 180;
  const p = (angles.pitch * Math.PI) / 180;
  const r = (angles.roll * Math.PI) / 180;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cx = Math.cos(p);
  const sx = Math.sin(p);
  const cz = Math.cos(r);
  const sz = Math.sin(r);

  const m = new Array<number>(16).fill(0);
  // R = Ry·Rx·Rz（行主序）
  m[0] = cy * cz + sy * sx * sz;
  m[1] = -cy * sz + sy * sx * cz;
  m[2] = sy * cx;
  m[4] = cx * sz;
  m[5] = cx * cz;
  m[6] = -sx;
  m[8] = -sy * cz + cy * sx * sz;
  m[9] = sy * sz + cy * sx * cz;
  m[10] = cy * cx;
  m[15] = 1;
  return m;
}

/** 角度到度数的归一化（±180）。 */
export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
