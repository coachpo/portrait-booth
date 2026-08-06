/**
 * 姿态跟踪状态机（GDE-001/002/004）。
 * 主脸关联、EMA 平滑、进入/退出滞回、稳定计时与中文指令（以用户身体方向表达）。
 */

import { decomposeFaceMatrix, type PoseAngles } from "./angles";

export interface PoseThresholds {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  stableMs: number;
  /** 脸宽 / 图像宽 的允许区间 */
  faceWidthMin: number;
  faceWidthMax: number;
  /** 脸中心相对图像中心的允许偏移（归一化） */
  faceOffsetMax: number;
}

export const DEFAULT_POSE_THRESHOLDS: PoseThresholds = {
  yawDeg: 7,
  pitchDeg: 7,
  rollDeg: 5,
  stableMs: 800,
  faceWidthMin: 0.15,
  faceWidthMax: 0.6,
  faceOffsetMax: 0.25,
};

/**
 * 滞回：**已经就绪后放宽**阈值，边界上的小抖动才不会把状态踢出去。
 *
 * 这里曾经是 0.7——进入 ready 之后阈值反而收紧 30%，
 * 于是刚好卡在 7° 的用户会在 ready 与 unstable 之间来回跳，
 * 正是滞回本该消除的现象。
 */
export const HYSTERESIS_EXIT_FACTOR = 1.3;

export interface FaceObservation {
  /** 帧内人脸序号（用于主脸关联） */
  faceIndex: number;
  landmarks: Array<{ x: number; y: number; z?: number }>;
  matrix: number[];
}

export type GuidanceStatus = "no-face" | "multi-face" | "out-of-position" | "unstable" | "ready";

export interface PoseState {
  status: GuidanceStatus;
  angles: PoseAngles;
  /** 脸宽 / 图像宽 */
  faceWidthRatio: number;
  /** 脸中心相对图像中心偏移（归一化，负数=左/上） */
  faceOffset: { x: number; y: number };
  stableMs: number;
  /** 自动拍摄就绪：稳定且位置合规 */
  shootable: boolean;
  guidance: string;
}

export interface TrackingOptions {
  thresholds?: PoseThresholds;
  /** 预览是否为镜像。只影响取景框绘制，不再影响指令措辞（见 guidance）。 */
  mirrored?: boolean;
  alpha?: number; // EMA 平滑系数
}

interface SmoothedAngles {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FaceMetrics {
  /** 脸宽 / 图像宽 */
  width: number;
  /** 脸中心的归一化坐标（0–1） */
  center: { x: number; y: number };
}

/** 脸宽取 landmarks 33（左眼外眦）与 263（右眼外眦）的水平距离。 */
export function faceMetrics(face: FaceObservation): FaceMetrics | null {
  const left = face.landmarks[33];
  const right = face.landmarks[263];
  const chin = face.landmarks[152];
  if (!left || !right || !chin) return null;
  const top = face.landmarks[10] ?? face.landmarks[9];
  return {
    width: Math.abs(left.x - right.x),
    center: {
      x: (left.x + right.x) / 2,
      y: top ? (top.y + chin.y) / 2 : (left.y + right.y) / 2,
    },
  };
}

/**
 * 主脸关联：按「脸宽 × 居中度」打分，并以上一帧主脸位置作最近邻先验。
 *
 * 这里曾经按 score 降序取第一张。但 §4.4 把 outputFaceBlendshapes 固定为 false，
 * 于是 score 恒为 undefined，排序全程等价、退化成「取第一张脸」——
 * 而 MediaPipe 的返回顺序并不保证是主体优先。
 */
export function selectPrimaryFace(
  faces: FaceObservation[],
  previousCenter?: { x: number; y: number } | null,
): FaceObservation | null {
  if (faces.length === 0) return null;
  if (faces.length === 1) return faces[0];

  let best = faces[0];
  let bestScore = -Infinity;
  for (const face of faces) {
    const metrics = faceMetrics(face);
    if (!metrics) continue;
    const offCenter = Math.hypot(metrics.center.x - 0.5, metrics.center.y - 0.5);
    const centering = 1 - Math.min(1, offCenter * 2);
    let score = metrics.width * (0.5 + 0.5 * centering);
    if (previousCenter) {
      // 两张脸大小接近时，靠上一帧的位置定住主体，避免逐帧来回跳
      const drift = Math.hypot(
        metrics.center.x - previousCenter.x,
        metrics.center.y - previousCenter.y,
      );
      score /= 1 + drift * 4;
    }
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }
  return best;
}

/**
 * yaw/roll 的正负与身体方向的映射。
 *
 * canonical face model 的 +X 指向被摄者自己的左侧，因此 yaw > 0 读作「头转向自己的左侧」。
 * 这条映射还没有用真人样本实测确认（GDE-003），文案会在实测后调整。
 * 但无论最终是哪个方向，前置与后置摄像头必须给出同一句指令——
 * 指令描述的是被摄者的身体，不是屏幕上的画面。
 */
const YAW_POSITIVE_IS_OWN_LEFT = true;
const ROLL_POSITIVE_IS_OWN_LEFT = true;

export class PoseTracker {
  private thresholds: PoseThresholds;
  private mirrored: boolean;
  private alpha: number;
  private smoothed: SmoothedAngles | null = null;
  private lastStatus: GuidanceStatus = "no-face";
  /** 角度/位置判定得到的状态，不含 multi-face 这类提示态；迟滞只看它 */
  private lastComputed: GuidanceStatus = "no-face";
  private stableSince: number | null = null;
  private lastAngles: PoseAngles = { yaw: 0, pitch: 0, roll: 0 };
  private lastFaceWidth = 0;
  private lastFaceOffset = { x: 0, y: 0 };
  private lastCenter: { x: number; y: number } | null = null;

  constructor(options: TrackingOptions = {}) {
    this.thresholds = options.thresholds ?? DEFAULT_POSE_THRESHOLDS;
    this.mirrored = options.mirrored ?? false;
    this.alpha = options.alpha ?? 0.5;
  }

  /** 切换前后摄像头时更新镜像标记，不需要重建 tracker 或 landmarker。 */
  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
  }

  get isMirrored(): boolean {
    return this.mirrored;
  }

  /** 输入一帧的人脸观察结果与时间戳；返回更新后的姿态状态。 */
  update(faces: FaceObservation[], nowMs: number): PoseState {
    const primary = selectPrimaryFace(faces, this.lastCenter);
    if (!primary) {
      this.lastStatus = "no-face";
      this.lastComputed = "no-face";
      this.stableSince = null;
      this.smoothed = null;
      this.lastCenter = null;
      return this.buildState("no-face", nowMs);
    }

    const angles = decomposeFaceMatrix(primary.matrix);
    if (!angles) {
      // 这一帧没有可用角度。保持上一状态——把 NaN 平滑进 EMA 会让之后每一帧都是 NaN。
      return this.buildState(this.lastStatus, nowMs);
    }

    // EMA 平滑（防指令抖动）
    this.smoothed = this.smoothed
      ? {
          yaw: this.smoothed.yaw * (1 - this.alpha) + angles.yaw * this.alpha,
          pitch: this.smoothed.pitch * (1 - this.alpha) + angles.pitch * this.alpha,
          roll: this.smoothed.roll * (1 - this.alpha) + angles.roll * this.alpha,
        }
      : { yaw: angles.yaw, pitch: angles.pitch, roll: angles.roll };
    const smoothedAngles: PoseAngles = { ...this.smoothed };
    this.lastAngles = smoothedAngles;

    const metrics = faceMetrics(primary);
    this.lastFaceWidth = metrics?.width ?? 0;
    this.lastCenter = metrics?.center ?? null;
    this.lastFaceOffset = metrics
      ? { x: metrics.center.x - 0.5, y: metrics.center.y - 0.5 }
      : { x: 0, y: 0 };

    // 滞回：已经就绪时放宽阈值，未就绪时用原阈值
    const settled = this.lastComputed === "ready";
    const factor = settled ? HYSTERESIS_EXIT_FACTOR : 1;
    const inPosition = this.inPosition(this.lastFaceWidth, this.lastFaceOffset, factor);
    const withinAngles =
      Math.abs(smoothedAngles.yaw) <= this.thresholds.yawDeg * factor &&
      Math.abs(smoothedAngles.pitch) <= this.thresholds.pitchDeg * factor &&
      Math.abs(smoothedAngles.roll) <= this.thresholds.rollDeg * factor;

    let computed: GuidanceStatus;
    if (!inPosition) {
      computed = "out-of-position";
      this.stableSince = null;
    } else if (!withinAngles) {
      computed = "unstable";
      this.stableSince = null;
    } else {
      computed = "ready";
      this.stableSince ??= nowMs;
    }
    this.lastComputed = computed;

    // 多脸是提示性状态：关联与平滑照常进行，结果才不会被丢掉（§4.4）
    const status: GuidanceStatus = faces.length > 1 ? "multi-face" : computed;
    this.lastStatus = status;
    return this.buildState(status, nowMs);
  }

  private inPosition(faceWidth: number, offset: { x: number; y: number }, factor: number): boolean {
    return (
      faceWidth >= this.thresholds.faceWidthMin / factor &&
      faceWidth <= this.thresholds.faceWidthMax * factor &&
      Math.abs(offset.x) <= this.thresholds.faceOffsetMax * factor &&
      Math.abs(offset.y) <= this.thresholds.faceOffsetMax * factor
    );
  }

  private buildState(status: GuidanceStatus, nowMs: number): PoseState {
    const stableMs = this.stableSince !== null ? Math.max(0, nowMs - this.stableSince) : 0;
    const shootable = status === "ready" && stableMs >= this.thresholds.stableMs;
    return {
      status,
      angles: this.lastAngles,
      faceWidthRatio: this.lastFaceWidth,
      faceOffset: this.lastFaceOffset,
      stableMs,
      shootable,
      guidance: this.guidance(status),
    };
  }

  /**
   * GDE-002：指令以用户身体方向表达。
   *
   * 措辞不依赖 mirrored——身体方向是物理事实，不随预览是否镜像而改变。
   * 旧实现用 mirrored 去翻转身体方向，等价于断言「换个摄像头，人就转了个身」，
   * 两个分支里必然有一支是错的。
   */
  private guidance(status: GuidanceStatus): string {
    if (status === "no-face") return "未检测到人脸：请进入画面。";
    if (status === "multi-face") return "检测到多张人脸：请确保画面中只有一个人。";
    if (status === "out-of-position") {
      const { x, y } = this.lastFaceOffset;
      const w = this.lastFaceWidth;
      const parts: string[] = [];
      if (w < this.thresholds.faceWidthMin) parts.push("请靠近一些");
      else if (w > this.thresholds.faceWidthMax) parts.push("请离远一些");
      if (Math.abs(x) > this.thresholds.faceOffsetMax) {
        // MediaPipe 读的是 <video> 的原始帧——预览镜像只是 CSS transform，
        // 不改变送进推理的像素。未镜像画面里，被摄者向自己的左侧移动时脸往画面
        // 右侧走（x 增大）。所以 x > 0 表示人已经偏在自己的左侧，要往右回中。
        parts.push(x > 0 ? "请向你自己的右侧移动" : "请向你自己的左侧移动");
      }
      if (Math.abs(y) > this.thresholds.faceOffsetMax) {
        parts.push(y > 0 ? "请向上移动" : "请向下移动");
      }
      if (parts.length === 0) parts.push("请调整站位");
      return `人脸位置需调整：${parts.join("，")}。`;
    }
    if (status === "unstable") {
      const { yaw, pitch, roll } = this.lastAngles;
      const parts: string[] = [];
      if (Math.abs(yaw) > this.thresholds.yawDeg) {
        const turnedToOwnLeft = YAW_POSITIVE_IS_OWN_LEFT ? yaw > 0 : yaw < 0;
        parts.push(turnedToOwnLeft ? "请向你自己的右侧转一点" : "请向你自己的左侧转一点");
      }
      if (Math.abs(pitch) > this.thresholds.pitchDeg) {
        // pitch = asin(-R12/s) 是绕 +X 轴的转角，而本文件采用的约定是
        // +X 指向被摄者自己的左侧、+Y 向上、+Z 朝向相机。绕 +X 正向旋转把前向 +Z
        // 转到 -Y，也就是脸朝下。所以 pitch > 0 表示正在低头，该提示抬头。
        parts.push(pitch > 0 ? "请抬头一点" : "请低头一点");
      }
      if (Math.abs(roll) > this.thresholds.rollDeg) {
        const tiltedToOwnLeft = ROLL_POSITIVE_IS_OWN_LEFT ? roll > 0 : roll < 0;
        parts.push(tiltedToOwnLeft ? "请把头向你自己的右侧摆正" : "请把头向你自己的左侧摆正");
      }
      if (parts.length === 0) parts.push("请保持当前姿势");
      return `姿势需调整：${parts.join("，")}。`;
    }
    return "姿势稳定，可以拍摄（启发式判断，非官方容差）。";
  }
}
