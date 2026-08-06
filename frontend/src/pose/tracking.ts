/**
 * 姿态跟踪状态机（GDE-001/002/004）。
 * 主脸关联、EMA 平滑、进入/退出滞回、稳定计时与中文指令（以用户身体方向表达）。
 */

import { decomposeRotationMatrix, type PoseAngles } from "./angles";

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

/** 滞回：进入阈值比退出阈值宽松，防止边界抖动（GDE-004） */
export const HYSTERESIS_FACTOR = 0.7;

export interface FaceObservation {
  /** 帧内人脸序号（用于主脸关联） */
  faceIndex: number;
  landmarks: Array<{ x: number; y: number; z?: number }>;
  matrix: number[];
  score?: number;
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
  /** 预览是否为镜像（GDE-002：指令按身体方向表达） */
  mirrored?: boolean;
  alpha?: number; // EMA 平滑系数
}

interface SmoothedAngles {
  yaw: number;
  pitch: number;
  roll: number;
}

/** 主脸关联：取置信度最高的人脸；无置信度时取第一张（MVP 简化）。 */
export function selectPrimaryFace(faces: FaceObservation[]): FaceObservation | null {
  if (faces.length === 0) return null;
  return [...faces].sort((a, b) => (b.score ?? 1) - (a.score ?? 1))[0];
}

export class PoseTracker {
  private thresholds: PoseThresholds;
  private mirrored: boolean;
  private alpha: number;
  private smoothed: SmoothedAngles | null = null;
  private lastStatus: GuidanceStatus = "no-face";
  private stableSince: number | null = null;
  private lastAngles: PoseAngles = { yaw: 0, pitch: 0, roll: 0 };
  private lastFaceWidth = 0;
  private lastFaceOffset = { x: 0, y: 0 };

  constructor(options: TrackingOptions = {}) {
    this.thresholds = options.thresholds ?? DEFAULT_POSE_THRESHOLDS;
    this.mirrored = options.mirrored ?? false;
    this.alpha = options.alpha ?? 0.5;
  }

  /** 输入一帧的人脸观察结果与时间戳；返回更新后的姿态状态。 */
  update(faces: FaceObservation[], nowMs: number): PoseState {
    const primary = selectPrimaryFace(faces);
    if (!primary) {
      this.lastStatus = "no-face";
      this.stableSince = null;
      return this.buildState("no-face", nowMs);
    }
    if (faces.length > 1) {
      this.lastStatus = "multi-face";
      this.stableSince = null;
      return this.buildState("multi-face", nowMs);
    }

    const angles = decomposeRotationMatrix(primary.matrix);
    // EMA 平滑（防指令抖动）
    if (this.smoothed) {
      this.smoothed = {
        yaw: this.smoothed.yaw * (1 - this.alpha) + angles.yaw * this.alpha,
        pitch: this.smoothed.pitch * (1 - this.alpha) + angles.pitch * this.alpha,
        roll: this.smoothed.roll * (1 - this.alpha) + angles.roll * this.alpha,
      };
    } else {
      this.smoothed = { yaw: angles.yaw, pitch: angles.pitch, roll: angles.roll };
    }
    const smoothedAngles: PoseAngles = { ...this.smoothed };
    this.lastAngles = smoothedAngles;

    const faceWidth = this.faceWidthRatio(primary);
    this.lastFaceWidth = faceWidth;
    this.lastFaceOffset = this.faceOffset(primary);

    const inPosition = this.inPosition(faceWidth, this.lastFaceOffset);
    // 滞回：进入阈值宽松、退出收紧，防止边界抖动（GDE-004）
    const hysteresis =
      this.lastStatus === "ready" || this.lastStatus === "unstable" ? HYSTERESIS_FACTOR : 1;
    const withinAngles =
      Math.abs(smoothedAngles.yaw) <= this.thresholds.yawDeg * hysteresis &&
      Math.abs(smoothedAngles.pitch) <= this.thresholds.pitchDeg * hysteresis &&
      Math.abs(smoothedAngles.roll) <= this.thresholds.rollDeg * hysteresis;

    let status: GuidanceStatus;
    if (!inPosition) {
      status = "out-of-position";
      this.stableSince = null;
    } else if (!withinAngles) {
      status = "unstable";
      this.stableSince = null;
    } else {
      status = "ready";
      this.stableSince ??= nowMs;
    }
    this.lastStatus = status;
    return this.buildState(status, nowMs);
  }

  private inPosition(faceWidth: number, offset: { x: number; y: number }): boolean {
    return (
      faceWidth >= this.thresholds.faceWidthMin &&
      faceWidth <= this.thresholds.faceWidthMax &&
      Math.abs(offset.x) <= this.thresholds.faceOffsetMax &&
      Math.abs(offset.y) <= this.thresholds.faceOffsetMax
    );
  }

  /** 脸宽：landmarks 33（左眼外）与 263（右眼外）的像素距离（归一化） */
  private faceWidthRatio(face: FaceObservation): number {
    const left = face.landmarks[33];
    const right = face.landmarks[263];
    if (!left || !right) return 0;
    return Math.abs(left.x - right.x);
  }

  private faceOffset(face: FaceObservation): { x: number; y: number } {
    const left = face.landmarks[33];
    const right = face.landmarks[263];
    const top = face.landmarks[10] ?? face.landmarks[9];
    const chin = face.landmarks[152];
    if (!left || !right || !chin) return { x: 0, y: 0 };
    const cx = (left.x + right.x) / 2;
    const cy = top ? (top.y + chin.y) / 2 : (left.y + right.y) / 2;
    return { x: cx - 0.5, y: cy - 0.5 };
  }

  private buildState(status: GuidanceStatus, nowMs: number): PoseState {
    const stableMs = status === "ready" && this.stableSince !== null ? nowMs - this.stableSince : 0;
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

  /** GDE-002：指令以用户身体方向表达；镜像预览时左右与画面相反 */
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
        parts.push(
          this.mirrored
            ? x > 0
              ? "请向你自己的右侧移动"
              : "请向你自己的左侧移动"
            : x > 0
              ? "请向右移动"
              : "请向左移动",
        );
      }
      if (Math.abs(y) > this.thresholds.faceOffsetMax) {
        parts.push(y > 0 ? "请向下移动" : "请向上移动");
      }
      return `人脸位置需调整：${parts.join("，")}。`;
    }
    if (status === "unstable") {
      const { yaw, pitch, roll } = this.lastAngles;
      const parts: string[] = [];
      if (Math.abs(yaw) > this.thresholds.yawDeg) {
        // yaw 符号约定：正值表示头转向画面右侧；镜像时身体方向相反
        const turnLeft = this.mirrored ? yaw > 0 : yaw < 0;
        parts.push(turnLeft ? "请向你自己的左侧转一点" : "请向你自己的右侧转一点");
      }
      if (Math.abs(pitch) > this.thresholds.pitchDeg) {
        parts.push(pitch > 0 ? "请抬头一点" : "请低头一点");
      }
      if (Math.abs(roll) > this.thresholds.rollDeg) {
        parts.push(roll > 0 ? "请向你的左侧倾斜一点" : "请向你的右侧倾斜一点");
      }
      if (parts.length === 0) parts.push("请保持当前姿势");
      return `姿势需调整：${parts.join("，")}。`;
    }
    return "姿势稳定，可以拍摄。";
  }
}
