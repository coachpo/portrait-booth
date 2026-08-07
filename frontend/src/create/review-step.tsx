/**
 * Confirmation step.
 *
 * After capture or upload there must be one confirmation chance: jumping
 * straight into the editor means users only discover the photo is unusable
 * after editing and reaching the final page. Static-recheck results are also
 * given here, rather than first appearing at the final page.
 */

import { useEffect, useMemo } from "react";

import type { SourceImage } from "../image/source";
import { entryLabel } from "../lib/templates/catalog";
import { uiLocale } from "../lib/locale";
import type { TemplateEntry } from "../lib/templates/types";
import { staticCheckUnknowns, staticCheckWarnings } from "../pose/static-check";
import {
  allowedOutputSizes,
  resolveOutputSize,
  type OutputSizeOption,
} from "../editor/edit-transform";

export interface ReviewStepProps {
  source: SourceImage;
  template: TemplateEntry;
  /** Whether the user shot it or uploaded it - decides "retake" vs
   * "choose another file" */
  origin: "camera" | "upload";
  onConfirm: () => void;
  onRetake: () => void;
  onBack: () => void;
  /** Same-session template switch: keeps the photo and edit state */
  onChangeTemplate: () => void;
  /** Visible note from the template-switch projection (role=status) */
  notice?: string | null;
  /** The user-selected output size for ranged_pixels templates (P6) */
  selectedSize?: OutputSizeOption | null;
  onSizeChange?: (size: OutputSizeOption) => void;
}

export function ReviewStep({
  source,
  template,
  origin,
  onConfirm,
  onRetake,
  onBack,
  onChangeTemplate,
  notice,
  selectedSize,
  onSizeChange,
}: ReviewStepProps) {
  // Use the source's own previewUrl when present; otherwise create a
  // temporary one and release it when the source changes
  const previewUrl = useMemo(() => source.previewUrl ?? URL.createObjectURL(source.file), [source]);
  useEffect(() => {
    if (source.previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [source, previewUrl]);

  const warnings = useMemo(
    () => (source.staticChecks ? staticCheckWarnings(source.staticChecks) : []),
    [source.staticChecks],
  );
  const unknowns = useMemo(
    () => (source.staticChecks ? staticCheckUnknowns(source.staticChecks) : []),
    [source.staticChecks],
  );

  const rev = template.revision;
  const sizeOptions = allowedOutputSizes(rev);
  const out = resolveOutputSize(rev, selectedSize);
  const defaultOut = resolveOutputSize(rev, null);
  const chosen = sizeOptions.find(
    (s) => out !== null && s.width === out.width && s.height === out.height,
  );
  // Between the upper band and the size cap there may be only a narrow
  // window; the user must know before switching (P6 ticket 7)
  const maxBytes = rev.outputFile?.sizeLimit?.maxBytes;
  const maxRatio = rev.outputFile?.maxCompressionRatio;
  const sizeLimitNote =
    sizeOptions.length > 1 &&
    chosen !== undefined &&
    defaultOut !== null &&
    chosen.width > defaultOut.width &&
    maxBytes !== undefined;
  // Whether the source resolution suffices to fill the template output (EDT-004)
  const shortfall =
    out !== null && Math.max(out.width / source.width, out.height / source.height) > 1.001;

  return (
    <section aria-label="Confirm photo">
      <h2>Confirm this photo</h2>
      <p className="muted">
        Template: {entryLabel(template, uiLocale())}
        {out && ` (output ${out.width}×${out.height} pixels)`}. After confirming you move on to
        cropping and editing.
      </p>

      {sizeOptions.length > 1 && (
        <fieldset aria-label="Output size">
          <legend>Output size</legend>
          {sizeOptions.map((s) => (
            <label key={`${s.width}x${s.height}`} className="size-option">
              <input
                type="radio"
                name="output-size"
                value={`${s.width}x${s.height}`}
                checked={out !== null && s.width === out.width && s.height === out.height}
                onChange={() => onSizeChange?.(s)}
              />
              {s.width}×{s.height} pixels
            </label>
          ))}
          {sizeLimitNote && (
            <p className="muted">
              Note: the {out?.width}×{out?.height} band has a narrow size window (≤{" "}
              {Math.round(maxBytes! / 1024)} KB
              {maxRatio !== undefined && ` and compression ratio ≤${maxRatio}:1`}); with noisy
              sources the artifact may not be producible - switch back to the default size.
            </p>
          )}
        </fieldset>
      )}

      <div className="source-preview">
        <img src={previewUrl} alt="Photo awaiting confirmation" />
      </div>

      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}

      <dl className="final-details">
        <div>
          <dt>Photo pixels</dt>
          <dd>
            {source.width}×{source.height}
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {origin === "camera" ? "Captured with the device camera" : "Uploaded from a local file"}
          </dd>
        </div>
      </dl>

      {shortfall && (
        <p className="warn-text" role="alert">
          This photo is smaller than the template's required output size; continuing to edit will
          require upscaling and the artifact sharpness will visibly drop.
        </p>
      )}

      {source.staticChecks && warnings.length > 0 && (
        <div className="warn-text">
          <p>Recheck notes (heuristic judgment, not calibrated to official tolerance):</p>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="muted">
            These notes do not block you. If a medical or physical condition prevents holding the
            standard pose, you may still export; some issuing authorities offer medical or
            disability exceptions.
          </p>
        </div>
      )}
      {source.staticChecks && warnings.length === 0 && unknowns.length > 0 && (
        <p className="muted">
          Checked items show no obvious issues; the following were not checked and need manual
          confirmation: {unknowns.join(", ")}.
        </p>
      )}
      {source.staticChecks && warnings.length === 0 && unknowns.length === 0 && (
        <p className="muted">
          Recheck found no obvious issues (heuristic judgment, not calibrated to official
          tolerance).
        </p>
      )}
      {!source.staticChecks && <p className="muted">No pose and exposure recheck ran this time.</p>}

      <div className="step-actions">
        <button type="button" className="primary" onClick={onConfirm}>
          Use this photo
        </button>
        <button type="button" onClick={onRetake}>
          {origin === "camera" ? "Retake" : "Choose another file"}
        </button>
        <button type="button" onClick={onBack}>
          Back to previous step
        </button>
        <button type="button" onClick={onChangeTemplate}>
          Switch template
        </button>
      </div>
    </section>
  );
}
