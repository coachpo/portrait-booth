/**
 * 静态复检（GDE-005/009）。
 * 拍摄/上传后对固定位图重跑姿态与质量检查，不使用预览阶段的旧结果。
 */

import { analyzeQuality, type QualityResult, type StaticBitmapSource } from "./quality";
import { acquireImageLandmarker } from "./landmarker";
import { PoseTracker, type PoseState } from "./tracking";

export interface StaticCheckResult {
  /** 姿态复检（模型不可用时为 null） */
  pose: PoseState | null;
  /** 曝光/清晰度启发式（始终可运行） */
  quality: QualityResult;
  /** 姿态模型是否可用 */
  poseAvailable: boolean;
}

export async function runStaticCheck(bitmap: StaticBitmapSource): Promise<StaticCheckResult> {
  let pose: PoseState | null = null;
  let poseAvailable = false;
  try {
    // 独立的 IMAGE 实例：VIDEO 模式带跨帧 ROI 回环，复用它会把最后一帧预览的
    // ROI 先验带进复检，与 GDE-005「不使用最后一次预览推理的旧结果」冲突。
    const landmarker = await acquireImageLandmarker();
    const faces = landmarker.detectImage(bitmap);
    poseAvailable = true;
    pose = new PoseTracker().update(faces, 0);
  } catch {
    // GDE-006：模型失败只关闭自动指导
  }
  const quality = analyzeQuality(bitmap);
  return { pose, quality, poseAvailable };
}

/** 复检结果 → 用户可读警告（无警告返回 null）。 */
export function staticCheckWarnings(result: StaticCheckResult): string[] {
  const warnings: string[] = [];
  if (result.pose && result.pose.status !== "ready") {
    warnings.push(`姿态复检未通过：${result.pose.guidance}`);
  }
  for (const issue of result.quality.issues) {
    if (!issue.includes("未发现明显问题")) warnings.push(issue);
  }
  return warnings;
}
