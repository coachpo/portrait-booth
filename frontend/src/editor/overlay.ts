/**
 * 模板蒙版与允许区间的坐标换算（EDT-008）。
 *
 * cropRules 里的数字有三种坐标空间——输出像素、物理毫米、归一化比例——
 * 而编辑器画布只认输出像素。这里把它们统一换算过去，
 * 顺便把「从顶部起算」「从底部起算」「相对中线」这几种锚定方式解释成画布上的区间。
 *
 * 换算失败时返回 null 而不是猜一个数：宁可不画，也不能画一条位置错误的参考线，
 * 那比没有参考线更糟。
 */

import type { MeasurementRule, TemplateRevision } from "../lib/templates/types";
import type { Rect } from "./edit-transform";

const MM_PER_INCH = 25.4;

export type GuideKind =
  /** 画布上的一条水平带（y 区间） */
  | "horizontal-band"
  /** 画布上的一条垂直带（x 区间） */
  | "vertical-band"
  /** 纵向尺寸的允许范围，画成标尺 */
  | "size-y"
  /** 横向尺寸的允许范围，画成标尺 */
  | "size-x";

export interface OverlayGuide {
  ruleId: string;
  metric: string;
  kind: GuideKind;
  /** 输出像素坐标，from <= to */
  fromPx: number;
  toPx: number;
  label: string;
  enforcement: string;
  sourceLiteral?: string;
}

const METRIC_LABELS: Record<string, string> = {
  head_height: "头部高度",
  head_top_margin: "头顶留白",
  chin_bottom_margin: "下巴到底边",
  eye_line_from_bottom: "眼睛高度（自底边）",
  face_center_offset_x: "面部中线偏移",
  face_width: "面部宽度",
  interpupil_distance: "瞳距",
  face_left_margin: "面部左侧留白",
  face_right_margin: "面部右侧留白",
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/** 把一个规则值换算成输出像素。无法换算时返回 null。 */
export function toOutputPixels(
  value: number,
  rule: MeasurementRule,
  rev: TemplateRevision,
  out: Rect,
): number | null {
  const axis = rule.axis;
  switch (rule.coordinateSpace) {
    case "output_pixel_top_left":
      return value;
    case "output_physical_mm_top_left": {
      // 毫米只有在模板声明了打印密度时才有确定的像素含义
      if (rev.output.kind !== "physical_raster") return null;
      return (value / MM_PER_INCH) * rev.output.printPpi;
    }
    case "output_normalized_top_left":
      return axis === "x" ? value * out.width : value * out.height;
    default:
      // pose_camera_degrees 等：不是画布上的长度，画不出来
      return null;
  }
}

interface Span {
  from: number;
  to: number;
  kind: GuideKind;
}

/** 把 [min, max] 解释成画布上的区间。max 缺失时用画布边界兜底。 */
function spanFor(metric: string, min: number | null, max: number | null, out: Rect): Span | null {
  const H = out.height;
  const W = out.width;
  switch (metric) {
    case "head_top_margin":
      return { from: min ?? 0, to: max ?? H, kind: "horizontal-band" };
    case "chin_bottom_margin":
    case "eye_line_from_bottom":
      // 自底边起算：越大越靠上
      return { from: H - (max ?? H), to: H - (min ?? 0), kind: "horizontal-band" };
    case "face_left_margin":
      return { from: min ?? 0, to: max ?? W, kind: "vertical-band" };
    case "face_right_margin":
      return { from: W - (max ?? W), to: W - (min ?? 0), kind: "vertical-band" };
    case "face_center_offset_x":
      return { from: W / 2 + (min ?? 0), to: W / 2 + (max ?? 0), kind: "vertical-band" };
    case "head_height":
      return { from: min ?? 0, to: max ?? H, kind: "size-y" };
    case "face_width":
    case "interpupil_distance":
      return { from: min ?? 0, to: max ?? W, kind: "size-x" };
    default:
      return null;
  }
}

/**
 * 生成可绘制的蒙版参考。
 *
 * 只处理 overlay.ruleIds 点名的规则——overlay.kind 决定画什么是模板作者的决定，
 * 不是编辑器猜出来的。
 */
export function buildOverlayGuides(rev: TemplateRevision, out: Rect): OverlayGuide[] {
  if (rev.overlay.kind === "none") return [];
  const byId = new Map(rev.cropRules.map((r) => [r.id, r]));
  const guides: OverlayGuide[] = [];

  for (const ruleId of rev.overlay.ruleIds) {
    const rule = byId.get(ruleId);
    if (!rule) continue; // 坏引用由 CI 的内容门拦截，运行期安静跳过

    // 尺寸档位过滤位置（P6 坑 12）：SPEC:337 的 appliesToOutputSize 声明了
    // 规则适用的输出尺寸档，buildOverlayGuides 目前未消费；一旦有模板按档位
    // 声明不同参考线，必须在这里按当前 out 过滤规则后再走换算。
    // MeasurementRule 的类型声明缺 appliesToOutputSize（坑 19），属于别的工作。

    const min = rule.min == null ? null : toOutputPixels(rule.min, rule, rev, out);
    const max = rule.max == null ? null : toOutputPixels(rule.max, rule, rev, out);
    if (min === null && max === null) continue;

    const span = spanFor(rule.metric, min, max, out);
    if (!span) continue;

    const from = Math.min(span.from, span.to);
    const to = Math.max(span.from, span.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

    guides.push({
      ruleId,
      metric: rule.metric,
      kind: span.kind,
      fromPx: from,
      toPx: to,
      label: metricLabel(rule.metric),
      enforcement: rule.enforcement,
      sourceLiteral: rule.sourceLiteral,
    });
  }
  return guides;
}

/** 目标头部椭圆：由头顶留白与下巴留白共同确定的纵向区间推导。 */
export function headEllipse(
  guides: OverlayGuide[],
  out: Rect,
): { cx: number; cy: number; rx: number; ry: number } | null {
  const top = guides.find((g) => g.metric === "head_top_margin");
  const bottom = guides.find((g) => g.metric === "chin_bottom_margin");
  if (!top || !bottom) return null;
  // 两条带都已经是画布 y 坐标，取中点作为头顶与下巴的目标位置
  const crownY = (top.fromPx + top.toPx) / 2;
  const chinY = (bottom.fromPx + bottom.toPx) / 2;
  if (chinY <= crownY) return null;
  const ry = (chinY - crownY) / 2;
  return { cx: out.width / 2, cy: crownY + ry, rx: ry * 0.72, ry };
}
