/**
 * 终态检查摘要（OUT-007, GDE-008）。
 * 区分 pass/warn/fail/unknown/manual。姿态与曝光取自静态复检的真实结果；
 * 复检未运行或模型不可用时才是 unknown，不再无条件写「后续版本提供」。
 * 模板 captureRules 中 evaluation 为 manual 的强制项显示为「需人工确认」。
 */

import { outputSize } from "../editor/edit-transform";
import type { TemplateEntry, TemplateRevision } from "../lib/templates/types";
import type { StaticCheckResult } from "../pose/static-check";
import { hasExifSegment, readJpegDensity } from "./jpeg";
import type { FinalArtifact } from "./final-artifact";

export type CheckStatus = "pass" | "warn" | "fail" | "unknown" | "manual";

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** 启发式检查的统一声明：这些阈值未经官方校准，不构成受理承诺。 */
export const HEURISTIC_NOTICE = "启发式判断，未经官方容差校准";

export async function buildChecks(
  artifact: FinalArtifact,
  template: TemplateEntry,
  staticChecks?: StaticCheckResult | null,
): Promise<CheckItem[]> {
  const rev = template.revision;
  const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
  const checks: CheckItem[] = [];

  // OUT-002：精确像素
  const expected = outputSize(rev);
  const sizeOk =
    expected !== null &&
    artifact.manifest.widthPx === expected.width &&
    artifact.manifest.heightPx === expected.height;
  checks.push({
    id: "exact-pixels",
    label: "像素尺寸",
    status: sizeOk ? "pass" : "fail",
    detail: sizeOk
      ? `${artifact.manifest.widthPx}×${artifact.manifest.heightPx} 像素（精确匹配）`
      : `输出 ${artifact.manifest.widthPx}×${artifact.manifest.heightPx}，模板要求 ${expected?.width}×${expected?.height}`,
  });

  // OUT-005：JPEG/sRGB
  checks.push({
    id: "format",
    label: "格式",
    status: artifact.blob.type === "image/jpeg" ? "pass" : "fail",
    detail: "JPEG · sRGB（画布渲染，无色彩配置）",
  });

  // OUT-004：元数据剥离
  checks.push({
    id: "metadata",
    label: "元数据",
    status: hasExifSegment(bytes) ? "fail" : "pass",
    detail: hasExifSegment(bytes) ? "检测到 EXIF，应已剥离" : "EXIF/GPS/嵌入缩略图已剥离",
  });

  // OUT-003：文件大小
  const maxBytes = rev.outputFile?.sizeLimit?.maxBytes;
  if (maxBytes) {
    checks.push({
      id: "file-size",
      label: "文件大小",
      status: artifact.blob.size <= maxBytes ? "pass" : "fail",
      detail: `${Math.round(artifact.blob.size / 1024)} KB ≤ ${Math.round(maxBytes / 1024)} KB`,
    });
  }

  // OUT-006：纸质模板 PPI
  if (rev.output.kind === "physical_raster") {
    const density = readJpegDensity(bytes);
    const ok = density?.units === 1 && density.xdensity === rev.output.printPpi;
    checks.push({
      id: "print-density",
      label: "打印密度",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `${rev.output.printPpi} dpi（JFIF APP0）`
        : `密度 ${density ? `${density.xdensity} dpi` : "缺失"}，模板要求 ${rev.output.printPpi} dpi`,
    });
  }

  // EDT-009：裁剪区无透明像素。
  // 这一项曾是字面量 pass：配合「细微旋转把裁剪框甩出源图」，
  // 用户会看到检查全绿、同时拿到一张带黑角的成品。
  const { scannedPixels, transparentPixels } = artifact.coverage;
  if (scannedPixels === 0) {
    checks.push({
      id: "no-alpha",
      label: "裁剪区完整性",
      status: "unknown",
      detail: "画布像素不可读，未能验证裁剪区是否被完整覆盖",
    });
  } else if (transparentPixels === 0) {
    checks.push({
      id: "no-alpha",
      label: "裁剪区完整性",
      status: "pass",
      detail: `已扫描 ${scannedPixels.toLocaleString("zh-CN")} 个像素，无透明边缘`,
    });
  } else {
    const ratio = (transparentPixels / scannedPixels) * 100;
    checks.push({
      id: "no-alpha",
      label: "裁剪区完整性",
      status: "fail",
      detail: `${transparentPixels.toLocaleString("zh-CN")} 个像素未被源图覆盖（${ratio.toFixed(2)}%），成品会出现空白或黑角`,
    });
  }

  // EDT-004：源图有效分辨率。
  // 渲染矩阵的线性部分把源图像素映射到输出像素，行列式开方即放大倍率；
  // 大于 1 说明输出像素多于源图真正提供的信息，模板的最小像素要求实际未被满足。
  const [ma, mb, mc, md] = artifact.manifest.matrix;
  const upscale = Math.sqrt(Math.abs(ma * md - mb * mc));
  checks.push({
    id: "source-resolution",
    label: "源图分辨率",
    status: upscale > 1.001 ? "warn" : "pass",
    detail:
      upscale > 1.001
        ? `源图被放大 ${upscale.toFixed(2)} 倍以填满输出，实际清晰度低于 ${artifact.manifest.widthPx}×${artifact.manifest.heightPx} 所暗示的水平`
        : "源图分辨率不低于模板输出要求",
  });

  // GDE-008：姿态复检结果直接进摘要
  checks.push(poseCheck(staticChecks));
  checks.push(exposureCheck(staticChecks));

  // TMP-003：reference_only 模板不可提交
  if (template.publication.status !== "active") {
    checks.push({
      id: "publication",
      label: "模板发布状态",
      status: "warn",
      detail: template.publication.statusReason,
    });
  }

  // GDE-008：captureRules 里的强制拍摄要求模型判不了，逐条暴露为人工确认或未检查
  checks.push(...captureRuleChecks(rev));

  return checks;
}

function poseCheck(staticChecks?: StaticCheckResult | null): CheckItem {
  if (!staticChecks || !staticChecks.poseAvailable || !staticChecks.pose) {
    return {
      id: "pose",
      label: "姿态检查",
      status: "unknown",
      detail: staticChecks
        ? "姿态模型不可用，本次未做姿态复检"
        : "本次未运行姿态复检（可返回重新拍摄以启用）",
    };
  }
  const pose = staticChecks.pose;
  if (pose.status === "ready") {
    return {
      id: "pose",
      label: "姿态检查",
      status: "pass",
      detail: `头部角度在容差内（${HEURISTIC_NOTICE}）`,
    };
  }
  return {
    id: "pose",
    label: "姿态检查",
    status: "warn",
    detail: `${pose.guidance}（${HEURISTIC_NOTICE}）`,
  };
}

function exposureCheck(staticChecks?: StaticCheckResult | null): CheckItem {
  const quality = staticChecks?.quality;
  if (!quality || quality.status === "unknown") {
    return {
      id: "exposure",
      label: "曝光与清晰度",
      status: "unknown",
      detail: quality ? quality.issues.join(";") : "本次未运行曝光与清晰度复检",
    };
  }
  const problems = quality.issues.filter((issue) => !issue.includes("未发现明显问题"));
  if (problems.length === 0) {
    return {
      id: "exposure",
      label: "曝光与清晰度",
      status: "pass",
      detail: `未发现明显问题（${HEURISTIC_NOTICE}）`,
    };
  }
  return {
    id: "exposure",
    label: "曝光与清晰度",
    status: "warn",
    detail: `${problems.join(";")}（${HEURISTIC_NOTICE}）`,
  };
}

/**
 * captureRules → 检查摘要（GDE-008）。
 * 模板里的 check 字段被真实数据当分类桶乱用（fi-police 的「不得修改外观」
 * 挂在 check: "background" 下），所以 label 固定为「拍摄要求」，不用 check
 * 推导；evaluation 为 manual 的规则机器原则上判不了，显示为「需人工确认」，
 * 其余一律 unknown，绝不伪造 pass。
 */
function captureRuleChecks(rev: TemplateRevision): CheckItem[] {
  const rules = Array.isArray(rev.captureRules) ? rev.captureRules : [];
  return rules.map((rule) => ({
    id: `capture:${rule.id}`,
    label: rule.enforcement !== "mandatory" ? "拍摄要求（建议）" : "拍摄要求",
    status: rule.evaluation === "manual" ? "manual" : "unknown",
    detail: rule.sourceLiteral
      ? `官方原文：${rule.sourceLiteral}`
      : `要求：${String(rule.expected)}`,
  }));
}
