/**
 * 模板描述与标签映射（P4）：输出规格描述 + 规则/能力枚举的中文标签。
 * 展示用纯函数；capabilities 的限制短语唯一来源是 ./disclosure.ts（第 3 轮约定），
 * 本文件只做枚举取值 → 中文标签，不写第二份限制短语。
 */

import type { OutputProfile } from "./types";

/** 逐字保持原输出（卡片与详情页共用，不得改写文案） */
export function outputDescription(output: OutputProfile): string {
  switch (output.kind) {
    case "exact_pixels":
      return `${output.widthPx}×${output.heightPx} 像素`;
    case "ranged_pixels":
      return `${output.minWidthPx}–${output.maxWidthPx}×${output.minHeightPx}–${output.maxHeightPx} 像素，默认 ${output.defaultWidthPx}×${output.defaultHeightPx}`;
    case "physical_raster":
      return `${output.widthMm}×${output.heightMm} 毫米（${output.printPpi} ppi → ${output.widthPx}×${output.heightPx} 像素）`;
    case "portal_source":
      return "由官方门户执行裁剪";
    case "guidance_only":
      return "仅拍摄指导，不生成文件";
  }
}

const ENFORCEMENT_LABELS: Record<string, string> = {
  mandatory: "强制",
  recommended: "建议",
};

const EVALUATION_LABELS: Record<string, string> = {
  automatic: "自动判定",
  manual: "人工判定",
  automatic_with_manual_confirmation: "自动判定 + 人工确认",
};

const CAPABILITY_VALUE_LABELS: Record<string, string> = {
  allowed: "允许",
  warn: "警告",
  forbidden: "禁止",
  not_confirmed: "未确认",
  certified_only: "仅认证渠道",
};

const PROVENANCE_LABELS: Record<string, string> = {
  source_literal: "来源原文",
  derived: "推导",
  portal_verified: "门户核实",
};

const NORMALIZATION_LABELS: Record<string, string> = {
  server_authoritative: "服务端权威",
  client_hint: "客户端提示",
};

/** 未知值原样返回（provenance 是裸 string，不得写成穷尽 switch） */
export function labelFor(table: Record<string, string>, value: string): string {
  return table[value] ?? value;
}

export function enforcementLabel(value: string): string {
  return labelFor(ENFORCEMENT_LABELS, value);
}

export function evaluationLabel(value: string): string {
  return labelFor(EVALUATION_LABELS, value);
}

export function capabilityValueLabel(value: string): string {
  return labelFor(CAPABILITY_VALUE_LABELS, value);
}

export function provenanceLabel(value: string): string {
  return labelFor(PROVENANCE_LABELS, value);
}

export function normalizationLabel(value: string): string {
  return labelFor(NORMALIZATION_LABELS, value);
}
