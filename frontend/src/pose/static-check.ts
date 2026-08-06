/**
 * 静态复检（GDE-005/009）。
 * 拍摄/上传后对固定位图重跑姿态与质量检查，不使用预览阶段的旧结果。
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
import { acquireImageLandmarker } from "./landmarker";
import {
  EAR_CLOSED_MAX,
  MAR_OPEN_MIN,
  eyeAspectRatio,
  faceRoi,
  mouthAspectRatio,
  type FaceRoi,
} from "./face-geometry";
import { PoseTracker, selectPrimaryFace, type FaceObservation, type PoseState } from "./tracking";

export interface StaticCheckResult {
  /** 姿态复检（模型不可用时为 null） */
  pose: PoseState | null;
  /** 曝光/清晰度启发式（始终可运行） */
  quality: QualityResult;
  /** 姿态模型是否可用 */
  poseAvailable: boolean;
  /** 眼/嘴几何启发式；未检查为 null */
  faceGeometry: { eyesClosed: boolean; mouthOpen: boolean } | null;
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
  // 主脸只选一次：几何与姿态必须描述同一张脸（SPEC 固定 numFaces=2）
  let primary: FaceObservation | null = null;
  try {
    // 独立的 IMAGE 实例：VIDEO 模式带跨帧 ROI 回环，复用它会把最后一帧预览的
    // ROI 先验带进复检，与 GDE-005「不使用最后一次预览推理的旧结果」冲突。
    const landmarker = await acquireImageLandmarker();
    const faces = landmarker.detectImage(bitmap);
    poseAvailable = true;
    primary = selectPrimaryFace(faces);
    pose = new PoseTracker().update(primary ? [primary] : [], 0);
  } catch {
    // GDE-006：模型失败只关闭自动指导。几何在块外计算：几何越界/除零
    // 抛出的异常不得被记成模型不可用。
  }

  // 几何与 ROI：块外计算（landmark 索引缺失/坐标重合时安全回落 null）
  let faceGeometry: StaticCheckResult["faceGeometry"] = null;
  let roi: FaceRoi | null = null;
  if (primary) {
    const aspect = bitmap.height / bitmap.width;
    const ear = eyeAspectRatio(primary, aspect);
    const mar = mouthAspectRatio(primary, aspect);
    if (ear !== null && mar !== null) {
      faceGeometry = { eyesClosed: ear < EAR_CLOSED_MAX, mouthOpen: mar > MAR_OPEN_MIN };
    }
    roi = faceRoi(primary, aspect);
  }

  const config = options?.qualityConfig ?? QUALITY_CONFIG;
  const deps = options?.qualityDeps ?? browserQualityDeps;
  const quality = analyzeQuality(bitmap, config, deps, roi);
  return { pose, quality, poseAvailable, faceGeometry };
}

/** 复检结果 → 用户可读警告（无警告返回 null）。 */
export function staticCheckWarnings(result: StaticCheckResult): string[] {
  const warnings: string[] = [];
  if (result.pose && result.pose.status !== "ready") {
    warnings.push(`姿态复检未通过：${result.pose.guidance}`);
  }
  if (result.faceGeometry?.eyesClosed) {
    warnings.push("疑似闭眼：眼睛张开的程度低于启发式阈值");
  }
  if (result.faceGeometry?.mouthOpen) {
    warnings.push("疑似张嘴：嘴部张开的程度高于启发式阈值");
  }
  for (const issue of result.quality.issues) {
    if (!issue.includes("未发现明显问题")) warnings.push(issue);
  }
  return warnings;
}

/** 复检结果 → 未检查项名称（review 页三态用；GDE-008：未检查必须明说）。 */
export function staticCheckUnknowns(result: StaticCheckResult): string[] {
  const unknowns: string[] = [];
  if (!result.poseAvailable) unknowns.push("姿态复检");
  if (result.faceGeometry === null) unknowns.push("人脸几何（眼/嘴）");
  if (result.quality.metrics.background === null) unknowns.push("背景均匀度");
  return unknowns;
}
