/**
 * 姿态提示文案格式化（O4）。纯 TS，不 import react。
 * tracking.ts 只产出 GuidanceHint key；中文措辞与标点集中在本模块。
 * 语言键当前只识别 "zh"，其余值回退到 zh。
 */

import type { GuidanceHint, GuidanceStatus } from "./tracking";

export const ALL_GUIDANCE_HINTS: readonly GuidanceHint[] = [
  "move-closer",
  "move-farther",
  "move-own-left",
  "move-own-right",
  "move-up",
  "move-down",
  "adjust-position",
  "turn-own-left",
  "turn-own-right",
  "raise-head",
  "lower-head",
  "level-own-left",
  "level-own-right",
  "hold-still",
];

const ZH_HINTS: Record<GuidanceHint, string> = {
  "move-closer": "请靠近一些",
  "move-farther": "请离远一些",
  "move-own-left": "请向你自己的左侧移动",
  "move-own-right": "请向你自己的右侧移动",
  "move-up": "请向上移动",
  "move-down": "请向下移动",
  "adjust-position": "请调整站位",
  "turn-own-left": "请向你自己的左侧转一点",
  "turn-own-right": "请向你自己的右侧转一点",
  "raise-head": "请抬头一点",
  "lower-head": "请低头一点",
  "level-own-left": "请把头向你自己的左侧摆正",
  "level-own-right": "请把头向你自己的右侧摆正",
  "hold-still": "请保持当前姿势",
};

const ZH_SHELLS: Record<GuidanceStatus, string> = {
  "no-face": "未检测到人脸：请进入画面。",
  "multi-face": "检测到多张人脸：请确保画面中只有一个人。",
  "out-of-position": "人脸位置需调整：",
  unstable: "姿势需调整：",
  ready: "姿势稳定，可以拍摄（启发式判断，非官方容差）。",
};

/**
 * 拼接规则沿用旧实现：片段以全角逗号「，」连接、句末加「。」。
 * 只有 out-of-position / unstable 走「壳 + 片段」；其余三态 hints 恒为空，
 * 直接返回整句，不会拼出「未检测到人脸：。」。
 */
export function formatGuidance(
  status: GuidanceStatus,
  hints: GuidanceHint[],
  locale: string,
): string {
  if (locale !== "zh") return formatGuidance(status, hints, "zh");
  if (status === "out-of-position" || status === "unstable") {
    const effective: GuidanceHint[] =
      hints.length > 0 ? hints : [status === "out-of-position" ? "adjust-position" : "hold-still"];
    return `${ZH_SHELLS[status]}${effective.map((h) => ZH_HINTS[h]).join("，")}。`;
  }
  return ZH_SHELLS[status];
}
