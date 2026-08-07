/**
 * Final check summary (OUT-007, GDE-008).
 * Distinguishes pass/warn/fail/unknown/manual. Pose and exposure come from
 * the static recheck's real results; only when the recheck did not run or
 * the model is unavailable do they become unknown - never an unconditional
 * "provided in a later version". Mandatory captureRules items with
 * evaluation manual show as "needs manual confirmation".
 */

import { resolveOutputSize, type OutputSizeOption } from "../editor/edit-transform";
import type { TemplateEntry, TemplateRevision } from "../lib/templates/types";
import type { StaticCheckResult } from "../pose/static-check";
import { formatGuidance } from "../pose/guidance-text";
import { uiLocale } from "../lib/locale";
import { QUALITY_CONFIG } from "../pose/quality";
import { hasExifSegment, readJpegDensity } from "./jpeg";
import type { FinalArtifact } from "./final-artifact";

export type CheckStatus = "pass" | "warn" | "fail" | "unknown" | "manual";

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** Unified disclaimer for heuristic checks: these thresholds are not
 * officially calibrated and constitute no acceptance promise. */
export const HEURISTIC_NOTICE = "heuristic judgment, not calibrated to official tolerance";

export async function buildChecks(
  artifact: FinalArtifact,
  template: TemplateEntry,
  staticChecks?: StaticCheckResult | null,
  /** The user-selected size for ranged_pixels templates; defaults when omitted (P6) */
  selectedSize?: OutputSizeOption | null,
): Promise<CheckItem[]> {
  const rev = template.revision;
  const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
  const checks: CheckItem[] = [];

  // OUT-002: exact pixels. expected comes from the "selected size"
  // independent path; out-of-range/broken-aspect selections fall back to
  // default via resolveOutputSize - manifest and expected can never degrade
  // into comparing against themselves; applies to all three kinds
  // exact/ranged/physical.
  const expected = resolveOutputSize(rev, selectedSize);
  const sizeOk =
    expected !== null &&
    artifact.manifest.widthPx === expected.width &&
    artifact.manifest.heightPx === expected.height;
  checks.push({
    id: "exact-pixels",
    label: "Pixel size",
    status: sizeOk ? "pass" : "fail",
    detail: sizeOk
      ? `${artifact.manifest.widthPx}×${artifact.manifest.heightPx} pixels (exact match)`
      : `output ${artifact.manifest.widthPx}×${artifact.manifest.heightPx}; template requires ${expected?.width}×${expected?.height}`,
  });

  // OUT-005: JPEG/sRGB
  checks.push({
    id: "format",
    label: "Format",
    status: artifact.blob.type === "image/jpeg" ? "pass" : "fail",
    detail: "JPEG · sRGB (canvas-rendered, no color profile)",
  });

  // OUT-004: metadata stripping
  checks.push({
    id: "metadata",
    label: "Metadata",
    status: hasExifSegment(bytes) ? "fail" : "pass",
    detail: hasExifSegment(bytes)
      ? "EXIF detected; it should have been stripped"
      : "EXIF/GPS/embedded thumbnail stripped",
  });

  // OUT-003: file size
  const maxBytes = rev.outputFile?.sizeLimit?.maxBytes;
  if (maxBytes) {
    checks.push({
      id: "file-size",
      label: "File size",
      status: artifact.blob.size <= maxBytes ? "pass" : "fail",
      detail: `${Math.round(artifact.blob.size / 1024)} KB ≤ ${Math.round(maxBytes / 1024)} KB`,
    });
  }

  // OUT-006: paper-template PPI
  if (rev.output.kind === "physical_raster") {
    const density = readJpegDensity(bytes);
    const ok = density?.units === 1 && density.xdensity === rev.output.printPpi;
    checks.push({
      id: "print-density",
      label: "Print density",
      status: ok ? "pass" : "fail",
      detail: ok
        ? isPrintReady(template)
          ? `${rev.output.printPpi} dpi (JFIF APP0); verified by calibrated print`
          : `${rev.output.printPpi} dpi (JFIF APP0); PPI source ${rev.output.ppiProvenance}, not verified by calibrated print`
        : `density ${density ? `${density.xdensity} dpi` : "missing"}; template requires ${rev.output.printPpi} dpi`,
    });
  }

  // EDT-009: crop area has no transparent pixels.
  // This used to be a literal pass: combined with "a slight rotation throws
  // the crop frame outside the source", users saw all-green checks while
  // receiving an artifact with black corners.
  const { scannedPixels, transparentPixels } = artifact.coverage;
  if (scannedPixels === 0) {
    checks.push({
      id: "no-alpha",
      label: "Crop integrity",
      status: "unknown",
      detail: "canvas pixels unreadable; could not verify the crop area is fully covered",
    });
  } else if (transparentPixels === 0) {
    checks.push({
      id: "no-alpha",
      label: "Crop integrity",
      status: "pass",
      detail: `scanned ${scannedPixels.toLocaleString("en-US")} pixels; no transparent edges`,
    });
  } else {
    const ratio = (transparentPixels / scannedPixels) * 100;
    checks.push({
      id: "no-alpha",
      label: "Crop integrity",
      status: "fail",
      detail: `${transparentPixels.toLocaleString("en-US")} pixels not covered by the source (${ratio.toFixed(2)}%); the artifact will have blank or black corners`,
    });
  }

  // EDT-004: effective source resolution.
  // The render matrix's linear part maps source pixels to output pixels; the
  // square root of its determinant is the upscale factor. Above 1, the output
  // has more pixels than the source truly provides, so the template's minimum
  // pixel requirement is not actually met.
  const [ma, mb, mc, md] = artifact.manifest.matrix;
  const upscale = Math.sqrt(Math.abs(ma * md - mb * mc));
  checks.push({
    id: "source-resolution",
    label: "Source resolution",
    status: upscale > 1.001 ? "warn" : "pass",
    detail:
      upscale > 1.001
        ? `source upscaled ${upscale.toFixed(2)}× to fill the output; actual sharpness is below what ${artifact.manifest.widthPx}×${artifact.manifest.heightPx} implies`
        : "source resolution is not below the template's output requirement",
  });

  // GDE-008: pose recheck results go straight into the summary
  checks.push(poseCheck(staticChecks));
  checks.push(exposureCheck(staticChecks));
  // GDE-008: the background-uniformity automatic signal never passes; when
  // not measured it must explicitly say unchecked
  checks.push(backgroundCheck(staticChecks));

  // TMP-003: reference_only templates are not submittable
  if (template.publication.status !== "active") {
    checks.push({
      id: "publication",
      label: "Template publication status",
      status: "warn",
      detail: template.publication.statusReason,
    });
  }

  // GDE-008: mandatory capture requirements in captureRules cannot be judged
  // by the model; expose each one as manual confirmation or unchecked
  checks.push(...captureRuleChecks(rev));

  return checks;
}

function poseCheck(staticChecks?: StaticCheckResult | null): CheckItem {
  if (!staticChecks || !staticChecks.poseAvailable || !staticChecks.pose) {
    return {
      id: "pose",
      label: "Pose check",
      status: "unknown",
      detail: staticChecks
        ? "pose model unavailable; no pose recheck was run this time"
        : "pose recheck not run this time (go back and reshoot to enable it)",
    };
  }
  const pose = staticChecks.pose;
  if (pose.status === "ready") {
    return {
      id: "pose",
      label: "Pose check",
      status: "pass",
      detail: `head angles within tolerance (${HEURISTIC_NOTICE})`,
    };
  }
  return {
    id: "pose",
    label: "Pose check",
    status: "warn",
    detail: `${formatGuidance(pose.status, pose.guidanceHints, uiLocale())} (${HEURISTIC_NOTICE})`,
  };
}

/**
 * Whether a paper template may be labeled "printable at actual size"
 * (OUT-006).
 * The conclusion is modeled on publication.status: it holds only when the
 * template passed calibrated print tests and went active, and the PPI value
 * was confirmed through the official entry (portal_verified); the two are a
 * conjunction, and looking only at ppiProvenance would mislabel
 * reference_only templates as printable.
 */
export function isPrintReady(template: TemplateEntry): boolean {
  const out = template.revision.output;
  return (
    out.kind === "physical_raster" &&
    template.publication.status === "active" &&
    out.ppiProvenance === "portal_verified"
  );
}

function exposureCheck(staticChecks?: StaticCheckResult | null): CheckItem {
  const quality = staticChecks?.quality;
  if (!quality || quality.status === "unknown") {
    return {
      id: "exposure",
      label: "Exposure & sharpness",
      status: "unknown",
      detail: quality
        ? quality.issues.join(";")
        : "exposure and sharpness recheck not run this time",
    };
  }
  const problems = quality.issues.filter((issue) => !issue.includes("no obvious issues"));
  if (problems.length === 0) {
    return {
      id: "exposure",
      label: "Exposure & sharpness",
      status: "pass",
      detail: `no obvious issues (${HEURISTIC_NOTICE})`,
    };
  }
  return {
    id: "exposure",
    label: "Exposure & sharpness",
    status: "warn",
    detail: `${problems.join(";")} (${HEURISTIC_NOTICE})`,
  };
}

/**
 * Background uniformity (GDE-008). Unrelated to the template's background
 * captureRules (evaluation: manual): this is a layered automatic signal that
 * never returns pass - with metrics under the thresholds it stays unknown
 * with the detail saying manual confirmation is still required, so users
 * never believe "the background was checked".
 */
function backgroundCheck(staticChecks?: StaticCheckResult | null): CheckItem {
  const bg = staticChecks?.quality.metrics.background;
  if (!bg) {
    return {
      id: "background",
      label: "Background check",
      status: "unknown",
      detail: "not checked: background uniformity requires manual confirmation",
    };
  }
  const problems: string[] = [];
  if (bg.lumaStd > QUALITY_CONFIG.backgroundLumaStdMax) {
    problems.push(`uneven background brightness (stddev ${bg.lumaStd.toFixed(1)})`);
  }
  if (bg.blockRange > QUALITY_CONFIG.backgroundBlockRangeMax) {
    problems.push(`uneven light/dark distribution (block range ${bg.blockRange.toFixed(1)})`);
  }
  if (bg.leftRightDiff > QUALITY_CONFIG.shadowLeftRightDiffMax) {
    problems.push(`unbalanced left/right shadows (diff ${bg.leftRightDiff.toFixed(1)})`);
  }
  if (bg.topBottomDiff > QUALITY_CONFIG.shadowTopBottomDiffMax) {
    problems.push(`unbalanced top/bottom shadows (diff ${bg.topBottomDiff.toFixed(1)})`);
  }
  if (problems.length === 0) {
    return {
      id: "background",
      label: "Background check",
      status: "unknown",
      detail: `automatic signal found no anomaly; background still requires manual confirmation (${HEURISTIC_NOTICE})`,
    };
  }
  return {
    id: "background",
    label: "Background check",
    status: "warn",
    detail: `${problems.join(";")} (needs manual confirmation; ${HEURISTIC_NOTICE})`,
  };
}

/**
 * captureRules → check summary (GDE-008).
 * The check field in templates is misused as a classification bucket by the
 * real data (fi-police's "no appearance alteration" sits under check:
 * "background"), so the label is fixed as "capture requirement" rather than
 * derived from check; rules with evaluation manual cannot in principle be
 * judged by a machine and show as "needs manual confirmation", all others
 * are unknown - a pass is never fabricated.
 */
function captureRuleChecks(rev: TemplateRevision): CheckItem[] {
  const rules = Array.isArray(rev.captureRules) ? rev.captureRules : [];
  return rules.map((rule) => ({
    id: `capture:${rule.id}`,
    label:
      rule.enforcement !== "mandatory"
        ? "Capture requirement (recommended)"
        : "Capture requirement",
    status: rule.evaluation === "manual" ? "manual" : "unknown",
    detail: rule.sourceLiteral
      ? `official source: ${rule.sourceLiteral}`
      : `requirement: ${String(rule.expected)}`,
  }));
}
