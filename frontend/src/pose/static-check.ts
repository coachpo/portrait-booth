/**
 * Static recheck (GDE-005/009).
 * After capture/upload, reruns pose and quality checks on the fixed bitmap;
 * never reuses stale results from the preview phase.
 */

import {
  QUALITY_CONFIG,
  analyzeQuality,
  browserQualityDeps,
  type QualityConfig,
  type QualityDeps,
  type QualityResult,
  type StaticBitmapSource,
} from "./quality";
import { formatGuidance } from "./guidance-text";
import { uiLocale } from "../lib/locale";
import { acquireImageLandmarker } from "./landmarker";
import {
  EAR_CLOSED_MAX,
  MAR_OPEN_MIN,
  eyeAspectRatio,
  faceAnchors,
  faceRoi,
  mouthAspectRatio,
  type FaceAnchors,
  type FaceRoi,
} from "./face-geometry";
import { PoseTracker, selectPrimaryFace, type FaceObservation, type PoseState } from "./tracking";

export interface StaticCheckResult {
  /** Pose recheck (null when the model is unavailable) */
  pose: PoseState | null;
  /** Exposure/sharpness heuristics (always runnable) */
  quality: QualityResult;
  /** Whether the pose model is available */
  poseAvailable: boolean;
  /** Eye/mouth geometry heuristics; null when not checked */
  faceGeometry: { eyesClosed: boolean; mouthOpen: boolean } | null;
  /**
   * cropRules anchor points in source-bitmap pixels (EDT-008); null when the
   * model is unavailable or the landmarks are incomplete. The final check
   * summary maps these through the artifact's render matrix to reach output
   * pixels, so they must come from the same bitmap the artifact was rendered
   * from.
   */
  faceAnchors: FaceAnchors | null;
}

export interface StaticCheckOptions {
  qualityConfig?: QualityConfig;
  qualityDeps?: QualityDeps;
}

export async function runStaticCheck(
  bitmap: StaticBitmapSource,
  options?: StaticCheckOptions,
): Promise<StaticCheckResult> {
  let pose: PoseState | null = null;
  let poseAvailable = false;
  // Select the primary face once: geometry and pose must describe the same
  // face (SPEC pins numFaces=2)
  let primary: FaceObservation | null = null;
  try {
    // A separate IMAGE instance: VIDEO mode carries a cross-frame ROI loop,
    // and reusing it would leak the last preview frame's ROI prior into the
    // recheck, conflicting with GDE-005 "don't use stale results from the last
    // preview inference".
    const landmarker = await acquireImageLandmarker();
    const faces = landmarker.detectImage(bitmap);
    poseAvailable = true;
    primary = selectPrimaryFace(faces);
    pose = new PoseTracker().update(primary ? [primary] : [], 0);
  } catch {
    // GDE-006: a model failure only disables automatic guidance. Geometry is
    // computed outside the block: exceptions from geometry out-of-bounds or
    // division by zero must not be recorded as "model unavailable".
  }

  // Geometry and ROI: computed outside the block (safely falls back to null
  // when landmark indices are missing or coordinates coincide)
  let faceGeometry: StaticCheckResult["faceGeometry"] = null;
  let roi: FaceRoi | null = null;
  let anchors: FaceAnchors | null = null;
  if (primary) {
    const aspect = bitmap.height / bitmap.width;
    const ear = eyeAspectRatio(primary, aspect);
    const mar = mouthAspectRatio(primary, aspect);
    if (ear !== null && mar !== null) {
      faceGeometry = { eyesClosed: ear < EAR_CLOSED_MAX, mouthOpen: mar > MAR_OPEN_MIN };
    }
    roi = faceRoi(primary, aspect);
    anchors = faceAnchors(primary, bitmap.width, bitmap.height);
  }

  const config = options?.qualityConfig ?? QUALITY_CONFIG;
  const deps = options?.qualityDeps ?? browserQualityDeps;
  const quality = analyzeQuality(bitmap, config, deps, roi);
  return { pose, quality, poseAvailable, faceGeometry, faceAnchors: anchors };
}

/** Recheck result → user-readable warnings (null when none). */
export function staticCheckWarnings(result: StaticCheckResult): string[] {
  const warnings: string[] = [];
  if (result.pose && result.pose.status !== "ready") {
    warnings.push(
      `pose recheck failed: ${formatGuidance(result.pose.status, result.pose.guidanceHints, uiLocale())}`,
    );
  }
  if (result.faceGeometry?.eyesClosed) {
    warnings.push("eyes may be closed: eye-opening is below the heuristic threshold");
  }
  if (result.faceGeometry?.mouthOpen) {
    warnings.push("mouth may be open: mouth-opening is above the heuristic threshold");
  }
  for (const issue of result.quality.issues) {
    if (!issue.includes("no obvious issues")) warnings.push(issue);
  }
  return warnings;
}

/** Recheck result → names of unchecked items (review page's three states;
 * GDE-008: unchecked must be stated explicitly). */
export function staticCheckUnknowns(result: StaticCheckResult): string[] {
  const unknowns: string[] = [];
  if (!result.poseAvailable) unknowns.push("pose recheck");
  if (result.faceGeometry === null) unknowns.push("face geometry (eyes/mouth)");
  if (result.quality.metrics.background === null) unknowns.push("background uniformity");
  return unknowns;
}
