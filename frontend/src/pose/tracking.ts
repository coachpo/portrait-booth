/**
 * Pose tracking state machine (GDE-001/002/004).
 * Primary-face association, EMA smoothing, enter/exit hysteresis, stability
 * timing, and structured hints (expressed in the subject's body direction).
 */

import { decomposeFaceMatrix, type PoseAngles } from "./angles";

export interface PoseThresholds {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  stableMs: number;
  /** Allowed range of face width / image width */
  faceWidthMin: number;
  faceWidthMax: number;
  /** Allowed offset of the face center relative to the image center (normalized) */
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
 * Hysteresis: thresholds **widen after ready**, so small jitter at the
 * boundary does not kick the state out.
 *
 * This used to be 0.7 - after entering ready the thresholds tightened by 30%,
 * so a user sitting right at 7° bounced between ready and unstable, exactly
 * the phenomenon hysteresis is supposed to eliminate.
 */
export const HYSTERESIS_EXIT_FACTOR = 1.3;

export interface FaceObservation {
  /** Face index within the frame (for primary-face association) */
  faceIndex: number;
  landmarks: Array<{ x: number; y: number; z?: number }>;
  matrix: number[];
}

export type GuidanceStatus = "no-face" | "multi-face" | "out-of-position" | "unstable" | "ready";

/**
 * Structured pose hint keys (O4): tracking only produces keys; the English
 * wording is formatted centrally in pose/guidance-text.ts.
 */
export type GuidanceHint =
  | "move-closer"
  | "move-farther"
  | "move-own-left"
  | "move-own-right"
  | "move-up"
  | "move-down"
  | "adjust-position"
  | "turn-own-left"
  | "turn-own-right"
  | "raise-head"
  | "lower-head"
  | "level-own-left"
  | "level-own-right"
  | "hold-still";

export interface PoseState {
  status: GuidanceStatus;
  angles: PoseAngles;
  /** Face width / image width */
  faceWidthRatio: number;
  /** Face center offset relative to the image center (normalized; negative = left/up) */
  faceOffset: { x: number; y: number };
  stableMs: number;
  /** Ready for automatic capture: stable and position-compliant */
  shootable: boolean;
  /** Pose hint keys (order carries meaning: distance first, then left/right, then up/down; then yaw, pitch, roll) */
  guidanceHints: GuidanceHint[];
}

export interface TrackingOptions {
  thresholds?: PoseThresholds;
  /** Whether the preview is mirrored. Only affects viewfinder drawing, not guidance wording (see guidance). */
  mirrored?: boolean;
  alpha?: number; // EMA smoothing factor
}

interface SmoothedAngles {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FaceMetrics {
  /** Face width / image width */
  width: number;
  /** Normalized face center coordinates (0–1) */
  center: { x: number; y: number };
}

/** Face width is the horizontal distance between landmarks 33 (left eye outer corner) and 263 (right eye outer corner). */
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
 * Primary-face association: scores by "face width × centeredness" with the
 * previous frame's primary position as a nearest-neighbor prior.
 *
 * This used to take the first face ordered by score. But §4.4 pins
 * outputFaceBlendshapes to false, so score was always undefined, the ordering
 * was equivalent throughout, and it degenerated to "take the first face" -
 * while MediaPipe's return order is not guaranteed to prefer the subject.
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
      // When two faces are similar in size, anchor on the previous frame's
      // position to avoid switching back and forth each frame
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
 * The sign mapping of yaw/roll to body direction.
 *
 * The canonical face model's +X points to the subject's own left, so yaw > 0
 * reads as "head turned toward the subject's own left".
 * This mapping has not yet been confirmed against real-person samples
 * (GDE-003); copy will be adjusted after measurement.
 * Whichever direction is final, front and rear cameras must give the same
 * instruction - the instruction describes the subject's body, not the
 * on-screen picture.
 */
const YAW_POSITIVE_IS_OWN_LEFT = true;
const ROLL_POSITIVE_IS_OWN_LEFT = true;

export class PoseTracker {
  private thresholds: PoseThresholds;
  private mirrored: boolean;
  private alpha: number;
  private smoothed: SmoothedAngles | null = null;
  private lastStatus: GuidanceStatus = "no-face";
  /** State from the angle/position judgment, excluding hint states like
   * multi-face; hysteresis looks only at this */
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

  /** Update the mirror flag when switching between front and rear cameras;
   * no need to rebuild the tracker or landmarker. */
  setMirrored(mirrored: boolean): void {
    this.mirrored = mirrored;
  }

  get isMirrored(): boolean {
    return this.mirrored;
  }

  /** Feed one frame of face observations with a timestamp; returns the updated pose state. */
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
      // No usable angles this frame. Keep the previous state - smoothing NaN
      // into the EMA would make every later frame NaN.
      return this.buildState(this.lastStatus, nowMs);
    }

    // EMA smoothing (prevents guidance flicker)
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

    // Hysteresis: widen thresholds once ready; use the base thresholds otherwise
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

    // Multi-face is a hint state: association and smoothing continue so the
    // result is not discarded (§4.4)
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
      guidanceHints: this.guidance(status),
    };
  }

  /**
   * GDE-002: guidance expressed in the subject's body direction.
   *
   * Wording does not depend on mirrored - body direction is a physical fact
   * and does not change with preview mirroring. The old implementation used
   * mirrored to flip body direction, which is equivalent to asserting
   * "switching cameras turns the person around"; one of the two branches is
   * necessarily wrong.
   * Only keys are produced, never copy; after real-sample calibration only
   * the two direction constants below flip, never the copy tables.
   */
  private guidance(status: GuidanceStatus): GuidanceHint[] {
    if (status === "no-face" || status === "multi-face" || status === "ready") return [];
    if (status === "out-of-position") {
      const { x, y } = this.lastFaceOffset;
      const w = this.lastFaceWidth;
      const parts: GuidanceHint[] = [];
      if (w < this.thresholds.faceWidthMin) parts.push("move-closer");
      else if (w > this.thresholds.faceWidthMax) parts.push("move-farther");
      if (Math.abs(x) > this.thresholds.faceOffsetMax) {
        // MediaPipe reads the raw <video> frame - preview mirroring is only a
        // CSS transform and does not change the pixels fed to inference. In an
        // unmirrored frame, when the subject moves to their own left the face
        // moves right on screen (x increases). So x > 0 means the person is
        // already off to their own left and needs to move back right.
        parts.push(x > 0 ? "move-own-right" : "move-own-left");
      }
      if (Math.abs(y) > this.thresholds.faceOffsetMax) {
        parts.push(y > 0 ? "move-up" : "move-down");
      }
      if (parts.length === 0) parts.push("adjust-position");
      return parts;
    }
    {
      const { yaw, pitch, roll } = this.lastAngles;
      const parts: GuidanceHint[] = [];
      if (Math.abs(yaw) > this.thresholds.yawDeg) {
        const turnedToOwnLeft = YAW_POSITIVE_IS_OWN_LEFT ? yaw > 0 : yaw < 0;
        parts.push(turnedToOwnLeft ? "turn-own-right" : "turn-own-left");
      }
      if (Math.abs(pitch) > this.thresholds.pitchDeg) {
        // pitch = asin(-R12/s) is the rotation about the +X axis, and this
        // file's convention has +X pointing to the subject's own left, +Y up,
        // +Z toward the camera. A positive rotation about +X turns the forward
        // +Z toward -Y, i.e. face down. So pitch > 0 means looking down and
        // the hint is to raise the head.
        parts.push(pitch > 0 ? "raise-head" : "lower-head");
      }
      if (Math.abs(roll) > this.thresholds.rollDeg) {
        const tiltedToOwnLeft = ROLL_POSITIVE_IS_OWN_LEFT ? roll > 0 : roll < 0;
        parts.push(tiltedToOwnLeft ? "level-own-right" : "level-own-left");
      }
      if (parts.length === 0) parts.push("hold-still");
      return parts;
    }
  }
}
