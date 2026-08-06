/**
 * 姿态角推导（GDE-003）。
 *
 * MediaPipe 的 facialTransformationMatrixes 是 **列主序** 4×4（16 元素）：
 *   R[row][col] = m[col * 4 + row]
 * 并且左上 3×3 是「旋转 × 均匀缩放」，不是正交旋转矩阵——缩放来自模型把
 * 标准脸模型对齐到当前人脸的尺度，量级通常在 1.0–2.0 之间。
 *
 * 两个后果：
 * 1. 按行主序取元素会把 yaw 与 roll 读成转置后的角度，符号与量级都错；
 * 2. pitch 走 asin，被缩放放大后可能直接饱和到 ±90°。
 *
 * 约定：旋转矩阵 R = Ry(yaw)·Rx(pitch)·Rz(roll)（列向量）。
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

/** 列主序 4×4 取元素：R[row][col]。 */
function at(m: number[], row: number, col: number): number {
  return m[col * 4 + row];
}

/**
 * 左上 3×3 的均匀缩放因子：取第一列的模长。
 * 三列模长在均匀缩放下相等，取一列即可，也顺带给出矩阵是否退化的信号。
 */
export function matrixScale(m: number[]): number {
  return Math.hypot(at(m, 0, 0), at(m, 1, 0), at(m, 2, 0));
}

/**
 * 从列主序 4×4 分解 yaw/pitch/roll（度）。
 *   pitch = asin(-R12 / s)
 *   yaw   = atan2(R02, R22)   —— 比值，缩放自动抵消
 *   roll  = atan2(R10, R11)   —— 同上
 */
export function decomposeRotationMatrix(m: number[]): PoseAngles {
  const s = matrixScale(m) || 1;
  const pitch = Math.asin(clamp(-at(m, 1, 2) / s, -1, 1)) * RAD_TO_DEG;
  const yaw = Math.atan2(at(m, 0, 2), at(m, 2, 2)) * RAD_TO_DEG;
  const roll = Math.atan2(at(m, 1, 0), at(m, 1, 1)) * RAD_TO_DEG;
  return { yaw, pitch, roll };
}

/**
 * 带校验的分解：矩阵缺失、长度不对、含非有限值或退化（缩放为 0）时返回 null。
 *
 * 调用方必须把 null 当作「这一帧没有可用角度」而不是「角度为 0」——
 * 否则一帧 NaN 会被平滑进 EMA，之后每一帧都是 NaN。
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
 * 由角度构造列主序 4×4（辅助工具）。
 *
 * 注意：**不要用它作为 decomposeRotationMatrix 的唯一验证手段**——
 * 用自写的 compose 去验自写的 decompose 是自证循环，
 * 两边同时按行主序理解矩阵时测试依然全绿。真正的回归断言必须直接写出
 * 已知角度对应的矩阵字面量，见 pose.test.ts。
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

  // R = Ry·Rx·Rz，按 [row][col] 写出后再落到列主序位置
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

/** 角度到度数的归一化（±180）。 */
export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
