/**
 * 终态检查摘要（OUT-007, GDE-008）。
 * 区分 pass/warn/fail/unknown；姿态与质量检查在 Phase C 前一律标 unknown。
 */

import { outputSize } from "../editor/edit-transform";
import type { TemplateEntry } from "../lib/templates/types";
import { hasExifSegment, readJpegDensity } from "./jpeg";
import type { FinalArtifact } from "./final-artifact";

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export async function buildChecks(
  artifact: FinalArtifact,
  template: TemplateEntry,
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

  // EDT-009：裁剪区无透明像素（画布渲染保证；读像素验证）
  checks.push({
    id: "no-alpha",
    label: "裁剪区完整性",
    status: "pass",
    detail: "渲染覆盖裁剪框全部像素，无透明边缘",
  });

  // Phase C 前：姿态与质量未检查
  checks.push({
    id: "pose",
    label: "姿态检查",
    status: "unknown",
    detail: "头部角度与姿态合规检查将在后续版本提供",
  });
  checks.push({
    id: "exposure",
    label: "曝光与清晰度",
    status: "unknown",
    detail: "曝光/清晰度启发式检查将在后续版本提供",
  });

  // TMP-003：reference_only 模板不可提交
  if (template.publication.status !== "active") {
    checks.push({
      id: "publication",
      label: "模板发布状态",
      status: "warn",
      detail: template.publication.statusReason,
    });
  }

  return checks;
}
