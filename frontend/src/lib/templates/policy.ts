/**
 * 模板 capabilities → 政策派生（P2）。
 * 纯函数、零 React 依赖：编辑器锁定标志、限制清单与来源步骤的前置约束文案。
 * 本模块是 capabilities 语义与中文文案的唯一来源（第 3 轮约定：policy.ts），
 * 其他模块一律 import 它，禁止另建第二份映射。
 */

import type { TemplateRevision } from "./types";

export interface PolicyNotice {
  id: "crop" | "rotate" | "mirror" | "retouch" | "backgroundReplace";
  level: "warn" | "forbidden";
  /** 写明限制什么 + 本工具怎么处理 */
  text: string;
}

export interface SourceRequirement {
  id: "selfCapture" | "requiresOriginalCameraFile" | "requiresProfessionalPhotographer";
  text: string;
}

export interface EditorPolicy {
  /** crop === "forbidden"：用户不得改变构图，固定在默认覆盖构图 */
  composeLocked: boolean;
  composeLockReason: string | null;
  rotateLocked: boolean;
  mirrorLocked: boolean;
  notices: PolicyNotice[];
  sourceRequirements: SourceRequirement[];
}

const COMPOSE_LOCKED_TEXT = "模板禁止调整构图：照片固定在默认覆盖构图，缩放与平移已停用。";

function noticeText(op: string, level: "warn" | "forbidden"): string {
  if (level === "forbidden") {
    return `模板禁止${op}：本工具不会执行该操作。`;
  }
  return `模板对${op}有警告：请核对官方规则后决定是否执行。`;
}

export function editorPolicy(rev: TemplateRevision): EditorPolicy {
  const caps = rev.capabilities;
  const notices: PolicyNotice[] = [];

  const add = (
    id: PolicyNotice["id"],
    op: string,
    level: "allowed" | "warn" | "forbidden",
  ): void => {
    if (level === "warn" || level === "forbidden") {
      notices.push({ id, level, text: noticeText(op, level) });
    }
  };
  add("crop", "裁剪", caps.crop);
  add("rotate", "旋转", caps.rotate);
  add("mirror", "镜像", caps.mirror);
  add("retouch", "修饰", caps.retouch);
  add("backgroundReplace", "背景替换", caps.backgroundReplace);

  const sourceRequirements: SourceRequirement[] = [];
  if (caps.selfCapture !== "allowed") {
    const text =
      caps.selfCapture === "forbidden"
        ? "该模板不允许自行拍摄证件照。"
        : caps.selfCapture === "certified_only"
          ? "该模板要求由认证渠道拍摄照片。"
          : "该模板的自行拍摄状态未经官方确认，请按官方渠道要求执行。";
    sourceRequirements.push({ id: "selfCapture", text });
  }
  if (caps.requiresOriginalCameraFile) {
    sourceRequirements.push({
      id: "requiresOriginalCameraFile",
      text: "该模板要求原始相机文件；本工具的成品是重新编码的 JPEG，不满足此要求。",
    });
  }
  if (caps.requiresProfessionalPhotographer) {
    sourceRequirements.push({
      id: "requiresProfessionalPhotographer",
      text: "该模板要求认证摄影师拍摄；本工具不产出认证摄影师出品。",
    });
  }

  return {
    composeLocked: caps.crop === "forbidden",
    composeLockReason: caps.crop === "forbidden" ? COMPOSE_LOCKED_TEXT : null,
    rotateLocked: caps.rotate === "forbidden",
    mirrorLocked: caps.mirror === "forbidden",
    notices,
    sourceRequirements,
  };
}
