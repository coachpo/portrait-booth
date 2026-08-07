/**
 * Template mask and allowed-range coordinate conversion (EDT-008).
 *
 * cropRules numbers live in three coordinate spaces - output pixels,
 * physical millimeters, normalized ratios - while the editor canvas only
 * knows output pixels. This module converts them all over, and interprets
 * the anchoring styles "from the top", "from the bottom", and "relative to
 * the center line" as canvas intervals.
 *
 * A failed conversion returns null instead of guessing: better to draw
 * nothing than a reference line in the wrong place - that is worse than no
 * line at all.
 */

import type { MeasurementRule, TemplateRevision } from "../lib/templates/types";
import type { Rect } from "./edit-transform";

const MM_PER_INCH = 25.4;

export type GuideKind =
  /** A horizontal band on the canvas (y interval) */
  | "horizontal-band"
  /** A vertical band on the canvas (x interval) */
  | "vertical-band"
  /** Allowed range of a vertical size, drawn as a ruler */
  | "size-y"
  /** Allowed range of a horizontal size, drawn as a ruler */
  | "size-x";

export interface OverlayGuide {
  ruleId: string;
  metric: string;
  kind: GuideKind;
  /** Output-pixel coordinates, from <= to */
  fromPx: number;
  toPx: number;
  label: string;
  enforcement: string;
  sourceLiteral?: string;
}

const METRIC_LABELS: Record<string, string> = {
  head_height: "Head height",
  head_top_margin: "Head top margin",
  chin_bottom_margin: "Chin to bottom edge",
  eye_line_from_bottom: "Eye height (from bottom)",
  face_center_offset_x: "Face center-line offset",
  face_width: "Face width",
  interpupil_distance: "Interpupillary distance",
  face_left_margin: "Face left margin",
  face_right_margin: "Face right margin",
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/** Convert one rule value to output pixels. Returns null when the
 * conversion is impossible. */
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
      // Millimeters only have a definite pixel meaning when the template
      // declares a print density
      if (rev.output.kind !== "physical_raster") return null;
      return (value / MM_PER_INCH) * rev.output.printPpi;
    }
    case "output_normalized_top_left":
      return axis === "x" ? value * out.width : value * out.height;
    default:
      // pose_camera_degrees etc.: not a canvas length; cannot be drawn
      return null;
  }
}

interface Span {
  from: number;
  to: number;
  kind: GuideKind;
}

/** Interpret [min, max] as a canvas interval. When max is missing, fall
 * back to the canvas edge. */
function spanFor(metric: string, min: number | null, max: number | null, out: Rect): Span | null {
  const H = out.height;
  const W = out.width;
  switch (metric) {
    case "head_top_margin":
      return { from: min ?? 0, to: max ?? H, kind: "horizontal-band" };
    case "chin_bottom_margin":
    case "eye_line_from_bottom":
      // Measured from the bottom: larger values sit higher
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
 * Build drawable mask guides.
 *
 * Only rules named by overlay.ruleIds are handled - what overlay.kind draws
 * is the template author's decision, not something the editor guesses.
 */
export function buildOverlayGuides(rev: TemplateRevision, out: Rect): OverlayGuide[] {
  if (rev.overlay.kind === "none") return [];
  const byId = new Map(rev.cropRules.map((r) => [r.id, r]));
  const guides: OverlayGuide[] = [];

  for (const ruleId of rev.overlay.ruleIds) {
    const rule = byId.get(ruleId);
    if (!rule) continue; // broken references are blocked by CI's content gate; skip quietly at runtime

    // Size-band filter position (P6 ticket 12): SPEC:337's appliesToOutputSize
    // declares which output-size band a rule applies to, and
    // buildOverlayGuides does not consume it yet; once a template declares
    // band-specific guides, rules must be filtered by the current out here
    // before conversion.
    // MeasurementRule's type declaration lacks appliesToOutputSize (ticket
    // 19); that is separate work.

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

/** Target head ellipse: derived from the vertical interval jointly defined
 * by the head-top margin and chin-bottom margin. */
export function headEllipse(
  guides: OverlayGuide[],
  out: Rect,
): { cx: number; cy: number; rx: number; ry: number } | null {
  const top = guides.find((g) => g.metric === "head_top_margin");
  const bottom = guides.find((g) => g.metric === "chin_bottom_margin");
  if (!top || !bottom) return null;
  // Both bands are already canvas y coordinates; their midpoints are the
  // target crown and chin positions
  const crownY = (top.fromPx + top.toPx) / 2;
  const chinY = (bottom.fromPx + bottom.toPx) / 2;
  if (chinY <= crownY) return null;
  const ry = (chinY - crownY) / 2;
  return { cx: out.width / 2, cy: crownY + ry, rx: ry * 0.72, ry };
}
