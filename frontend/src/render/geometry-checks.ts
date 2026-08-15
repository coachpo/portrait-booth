/**
 * cropRules → final check summary (EDT-008, GDE-008).
 *
 * The editor already draws the template's allowed ranges, but drawing a
 * reference band is not measuring against it. This module maps the recheck's
 * face anchors through the artifact's own render matrix into output pixels and
 * compares them with the same cropRules numbers the overlay drew, so the
 * summary can state what was actually measured.
 *
 * Which rules can be measured is decided by their `anchors`, not by guesswork:
 *
 * - `face_center_line`, `chin_tip`, and `eye_line` all resolve to real face
 *   landmarks, so `face_center_offset_x`, `chin_bottom_margin`, and
 *   `eye_line_from_bottom` yield real pass/warn conclusions.
 * - `head_height` is anchored on `crown_point` / `top_of_head` /
 *   `top_of_head_including_hair` in every template that declares it, and the
 *   face mesh has no crown landmark. Chin-to-hairline is therefore only a
 *   *lower bound* on head height: it can prove the head is already too large,
 *   but it can never prove the head fits. This check accordingly never
 *   returns pass - the same stance backgroundCheck takes - because a fabricated
 *   pass on a mandatory document rule is worse than an explicit "not measured".
 *
 * Remaining cropRules metrics (face_width, interpupil_distance, the left/right
 * margins, and the pose angles) are not consumed here; they stay absent from
 * the summary exactly as before.
 *
 * Fix advice is phrased as moving the *photo*, matching the editor's own
 * controls (its pad is labeled "Pan photo" / "Move up"), not as moving the
 * crop frame - the two read as opposite directions to the user.
 */

import { metricLabel, toOutputPixels } from "../editor/overlay";
import type { Rect } from "../editor/edit-transform";
import type { FaceAnchors } from "../pose/face-geometry";
import type { MeasurementRule, TemplateRevision } from "../lib/templates/types";
import { HEURISTIC_NOTICE, type CheckItem } from "./check-types";
import type { FinalManifest } from "./final-artifact";

const HANDLED_METRICS = new Set([
  "head_height",
  "face_center_offset_x",
  "chin_bottom_margin",
  "eye_line_from_bottom",
]);

interface Point {
  x: number;
  y: number;
}

/**
 * Source-bitmap pixels → output pixels through the render matrix.
 * Column-vector convention, identical to the matrix handed to
 * CanvasRenderingContext2D.setTransform, so mirroring and rotation are already
 * folded in and must not be re-applied here.
 */
function toOutput(p: Point, matrix: FinalManifest["matrix"]): Point {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

/** Rule bounds in output pixels; null entries mean the bound is absent or the
 * coordinate space cannot be converted (e.g. millimeters on a digital
 * template). */
function bounds(
  rule: MeasurementRule,
  rev: TemplateRevision,
  out: Rect,
): { min: number | null; max: number | null } {
  return {
    min: rule.min == null ? null : toOutputPixels(rule.min, rule, rev, out),
    max: rule.max == null ? null : toOutputPixels(rule.max, rule, rev, out),
  };
}

/** Describe the allowed interval in output pixels; `separator` joins a
 * two-sided range ("445-500 px" for a size, "-21..21 px" for an offset). */
function describeRange(min: number | null, max: number | null, separator: string): string {
  if (min !== null && max !== null) {
    return `${Math.round(min)}${separator}${Math.round(max)} px`;
  }
  if (min !== null) return `at least ${Math.round(min)} px`;
  if (max !== null) return `at most ${Math.round(max)} px`;
  return "";
}

function unmeasured(rule: MeasurementRule, label: string, reason: string): CheckItem {
  return {
    id: `crop:${rule.id}`,
    label,
    status: "unknown",
    detail: rule.sourceLiteral ? `${reason}; official source: ${rule.sourceLiteral}` : reason,
  };
}

/**
 * Head height (lower bound only).
 * Reports the measured chin-to-hairline span and states plainly that the crown
 * is above the model's topmost landmark, so the real head is taller than the
 * number shown.
 */
function headHeightCheck(
  rule: MeasurementRule,
  rev: TemplateRevision,
  out: Rect,
  anchors: FaceAnchors,
  matrix: FinalManifest["matrix"],
): CheckItem {
  const label = metricLabel(rule.metric);
  const chin = toOutput(anchors.chinTip, matrix);
  const hairline = toOutput(anchors.hairline, matrix);
  const span = chin.y - hairline.y;
  if (!Number.isFinite(span) || span <= 0) {
    return unmeasured(rule, label, "not checked: the face anchors do not map to a valid span");
  }
  const { min, max } = bounds(rule, rev, out);
  if (min === null && max === null) {
    return unmeasured(
      rule,
      label,
      "not checked: this rule's coordinate space cannot be converted to output pixels",
    );
  }
  const range = describeRange(min, max, "-");
  // Sound one-sided conclusion: the true crown sits above the hairline, so a
  // span already past the maximum can only get worse.
  if (max !== null && span > max) {
    return {
      id: `crop:${rule.id}`,
      label,
      status: "warn",
      detail: `chin to hairline measures ${Math.round(span)} px and the template allows ${range}; the crown sits above the hairline, so the head is larger than the rule permits - crop tighter or move further from the camera (${HEURISTIC_NOTICE})`,
    };
  }
  return {
    id: `crop:${rule.id}`,
    label,
    status: "unknown",
    detail: `chin to hairline measures ${Math.round(span)} px; the template measures ${range} from the crown, which is above the landmark model's topmost point, so the head is taller than the measured value and this rule still needs manual confirmation (${HEURISTIC_NOTICE})`,
  };
}

/**
 * Face center-line offset.
 * Fully measurable: both the face center line and the photo center line are
 * known, so this yields a real pass/warn conclusion.
 */
function faceCenterOffsetCheck(
  rule: MeasurementRule,
  rev: TemplateRevision,
  out: Rect,
  anchors: FaceAnchors,
  matrix: FinalManifest["matrix"],
): CheckItem {
  const label = metricLabel(rule.metric);
  const center = toOutput(anchors.faceCenter, matrix);
  const offset = center.x - out.width / 2;
  if (!Number.isFinite(offset)) {
    return unmeasured(rule, label, "not checked: the face anchors do not map to a valid position");
  }
  const { min, max } = bounds(rule, rev, out);
  if (min === null && max === null) {
    return unmeasured(
      rule,
      label,
      "not checked: this rule's coordinate space cannot be converted to output pixels",
    );
  }
  const side = offset < 0 ? "left" : "right";
  const magnitude = Math.abs(offset).toFixed(1);
  const withinMin = min === null || offset >= min;
  const withinMax = max === null || offset <= max;
  const limit = describeRange(min, max, "..");
  if (withinMin && withinMax) {
    return {
      id: `crop:${rule.id}`,
      label,
      status: "pass",
      detail: `face center line is ${magnitude} px ${side} of the photo center line, within the allowed ${limit} (${HEURISTIC_NOTICE})`,
    };
  }
  // The editor pans the photo, so correcting a face that sits right of center
  // means moving the photo left - the opposite of moving the crop frame.
  const fix = offset < 0 ? "right" : "left";
  return {
    id: `crop:${rule.id}`,
    label,
    status: "warn",
    detail: `face center line is ${magnitude} px ${side} of the photo center line, outside the allowed ${limit}; move the photo ${fix} to recenter the face (${HEURISTIC_NOTICE})`,
  };
}

/**
 * Distances measured up from the bottom edge (`chin_bottom_margin`,
 * `eye_line_from_bottom`).
 * Both anchors resolve to real landmarks, so these are genuine pass/warn
 * conclusions rather than lower bounds.
 */
function marginFromBottomCheck(
  rule: MeasurementRule,
  rev: TemplateRevision,
  out: Rect,
  point: Point,
  anchorName: string,
  matrix: FinalManifest["matrix"],
): CheckItem {
  const label = metricLabel(rule.metric);
  const distance = out.height - toOutput(point, matrix).y;
  if (!Number.isFinite(distance)) {
    return unmeasured(rule, label, "not checked: the face anchors do not map to a valid position");
  }
  const { min, max } = bounds(rule, rev, out);
  if (min === null && max === null) {
    return unmeasured(
      rule,
      label,
      "not checked: this rule's coordinate space cannot be converted to output pixels",
    );
  }
  const range = describeRange(min, max, "-");
  const measured = `${anchorName} sits ${Math.round(distance)} px above the bottom edge`;
  if ((min === null || distance >= min) && (max === null || distance <= max)) {
    return {
      id: `crop:${rule.id}`,
      label,
      status: "pass",
      detail: `${measured}, within the allowed ${range} (${HEURISTIC_NOTICE})`,
    };
  }
  // Too small a distance means the anchor sits too low, which is corrected by
  // moving the photo up; too large is the mirror case.
  const fix = min !== null && distance < min ? "up" : "down";
  return {
    id: `crop:${rule.id}`,
    label,
    status: "warn",
    detail: `${measured}, outside the allowed ${range}; move the photo ${fix} (${HEURISTIC_NOTICE})`,
  };
}

/**
 * Build the cropRules geometry items.
 * Rules the module does not handle are skipped entirely; handled rules always
 * produce an item, including when the recheck produced no anchors - GDE-008
 * requires an unchecked mandatory rule to say so rather than vanish.
 */
export function geometryChecks(
  rev: TemplateRevision,
  manifest: FinalManifest,
  anchors: FaceAnchors | null,
): CheckItem[] {
  const rules = Array.isArray(rev.cropRules) ? rev.cropRules : [];
  const out: Rect = { width: manifest.widthPx, height: manifest.heightPx };
  const items: CheckItem[] = [];
  for (const rule of rules) {
    if (!HANDLED_METRICS.has(rule.metric)) continue;
    if (!anchors) {
      items.push(
        unmeasured(
          rule,
          metricLabel(rule.metric),
          "not checked: no face landmarks from this recheck (go back and reshoot to enable it)",
        ),
      );
      continue;
    }
    switch (rule.metric) {
      case "head_height":
        items.push(headHeightCheck(rule, rev, out, anchors, manifest.matrix));
        break;
      case "face_center_offset_x":
        items.push(faceCenterOffsetCheck(rule, rev, out, anchors, manifest.matrix));
        break;
      case "chin_bottom_margin":
        items.push(
          marginFromBottomCheck(rule, rev, out, anchors.chinTip, "chin tip", manifest.matrix),
        );
        break;
      case "eye_line_from_bottom":
        items.push(
          marginFromBottomCheck(rule, rev, out, anchors.eyeLine, "eye line", manifest.matrix),
        );
        break;
    }
  }
  return items;
}
