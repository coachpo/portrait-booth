import { useEffect, useMemo, useState } from "react";

import type { EditTransform, OutputSizeOption } from "../editor/edit-transform";
import { resolveOutputSize } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import { entryLabel, jurisdictionName } from "../lib/templates/catalog";
import type { TemplateEntry } from "../lib/templates/types";
import { buildChecks, isPrintReady, type CheckItem } from "./checks";
import { StagingPanel, type StagedReceipt } from "./staging-panel";
import { renderFinalArtifact, RenderError, type FinalArtifact } from "./final-artifact";
import { capabilityRestrictions, sourceNotesFor } from "../lib/templates/disclosure";
import { uiLocale } from "../lib/locale";

export interface FinalPageProps {
  source: SourceImage;
  template: TemplateEntry;
  transform: EditTransform;
  onBack: () => void;
  onRestart: () => void;
  staged: StagedReceipt | null;
  stagedStale: boolean;
  onStaged: (receipt: StagedReceipt | null) => void;
  /** The user-selected size for ranged_pixels templates (P6) */
  selectedSize?: OutputSizeOption | null;
  /** Regenerate at the default size when the artifact exceeds the limit */
  onUseDefaultSize?: () => void;
}

function todayStamp(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

/** OUT-008: the filename contains neither name nor KEY */
function exportFilename(template: TemplateEntry): string {
  const rev = template.revision;
  return `${rev.jurisdiction.toLowerCase()}-${rev.documentType}-${rev.submissionChannel}-${todayStamp()}.jpg`;
}

export interface PhysicalSizeInfo {
  mm: string;
  printReady: boolean;
}

/** OUT-006: the millimeter value must stay bound to the print conclusion at
 * one place; never shown bare */
export function physicalSizeInfo(template: TemplateEntry): PhysicalSizeInfo | null {
  const out = template.revision.output;
  if (out.kind !== "physical_raster") return null;
  return {
    mm: `${out.widthMm}×${out.heightMm} mm`,
    printReady: isPrintReady(template),
  };
}

/** TMP-002 disclosure block: the source / restriction-phrases / review-notes
 * sub-blocks each render when non-empty; the whole block is skipped when all
 * are empty */
function TemplateDisclosure({ entry }: { entry: TemplateEntry }) {
  const rev = entry.revision;
  const restrictions = capabilityRestrictions(rev.capabilities);
  const notes = sourceNotesFor(rev, uiLocale());
  if (rev.sources.length === 0 && restrictions.length === 0 && notes.length === 0) return null;
  return (
    <section className="template-disclosure" aria-label="Template disclosure">
      <h3>Template disclosure</h3>
      {rev.sources.length > 0 && (
        <div>
          <h4>Sources</h4>
          <ul>
            {rev.sources.map((s) => (
              <li key={s.id}>
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.title} ({s.authority})
                </a>
                {s.sourceUpdatedAt && <span className="muted"> updated {s.sourceUpdatedAt}</span>}
                <span className="muted"> accessed {s.accessedAt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {restrictions.length > 0 && (
        <div>
          <h4>Template restrictions</h4>
          <ul>
            {restrictions.map((r) => (
              <li key={r.id}>
                <strong>{r.level === "forbidden" ? "Forbidden" : "Warning"}: </strong>
                {r.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <h4>Template review record</h4>
          <ul>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function FinalPage({
  source,
  template,
  transform,
  onBack,
  onRestart,
  staged,
  stagedStale,
  onStaged,
  selectedSize,
  onUseDefaultSize,
}: FinalPageProps) {
  const [artifact, setArtifact] = useState<FinalArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckItem[] | null>(null);
  const [attempt, setAttempt] = useState(0);

  const previewUrl = useMemo(() => {
    if (!artifact) return null;
    return URL.createObjectURL(artifact.blob);
  }, [artifact]);
  useEffect(() => {
    if (previewUrl) return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    // Clear stale values before every render: the failure state keeps no
    // previous artifact, the success state keeps no previous error/retry
    // button. This must be written synchronously at the very top of the
    // effect body (writing in then/catch or a separate effect cannot clear
    // the old values); the react-hooks/set-state-in-effect warning is an
    // intentional exception here (ticket A3's mandated pattern)
    /* eslint-disable react-hooks/set-state-in-effect -- synchronously clear stale render results */
    setError(null);
    setErrorKind(null);
    setArtifact(null);
    setChecks(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    let cancelled = false;
    renderFinalArtifact(source, template, transform, undefined, selectedSize)
      .then(async (a) => {
        if (cancelled) return;
        setArtifact(a);
        // The static recheck already produced real results; the summary must
        // use them instead of writing "provided in a later version"
        setChecks(await buildChecks(a, template, source.staticChecks ?? null, selectedSize));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorKind(err instanceof RenderError ? err.kind : null);
        setError(err instanceof Error ? err.message : "final render failed");
      });
    return () => {
      cancelled = true;
    };
  }, [source, template, transform, attempt, selectedSize]);

  const filename = exportFilename(template);
  const physical = physicalSizeInfo(template);
  const rev = template.revision;
  // Downgrade target on size-limit: the template's default size (P6 ticket
  // 8: retrying the same size fails again by construction)
  const defaultSize = resolveOutputSize(rev, null);
  const canDowngrade =
    errorKind === "size-limit" &&
    onUseDefaultSize !== undefined &&
    selectedSize !== null &&
    defaultSize !== null &&
    (selectedSize === undefined ||
      selectedSize.width !== defaultSize.width ||
      selectedSize.height !== defaultSize.height);

  const download = () => {
    if (!artifact) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(artifact.blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section aria-label="Final photo">
      <h2>Final photo</h2>
      <p className="muted">
        Selected template: {entryLabel(template, uiLocale())} ({jurisdictionName(rev.jurisdiction)})
      </p>
      {error && (
        <div role="alert" className="template-error">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
          {canDowngrade && (
            <button type="button" onClick={onUseDefaultSize}>
              Regenerate at {defaultSize.width}×{defaultSize.height}
            </button>
          )}
        </div>
      )}
      {!artifact && !error && <p aria-live="polite">Rendering final photo…</p>}
      {artifact && (
        <>
          <div className="source-preview">
            <img src={previewUrl ?? undefined} alt="Final photo preview" />
          </div>
          <dl className="final-details">
            <div>
              <dt>Pixels</dt>
              <dd>
                {artifact.manifest.widthPx}×{artifact.manifest.heightPx}
              </dd>
            </div>
            {physical && (
              <div>
                <dt>Physical size</dt>
                <dd>
                  {physical.mm}
                  {physical.printReady
                    ? " (printable at actual size)"
                    : " (reference image: print density not verified by calibrated print)"}
                </dd>
              </div>
            )}
            <div>
              <dt>Format</dt>
              <dd>JPEG · sRGB</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{(artifact.blob.size / 1024).toFixed(1)} KB</dd>
            </div>
            <div>
              <dt>Template version</dt>
              <dd>
                {rev.id}@{rev.version}
              </dd>
            </div>
            <div>
              <dt>Review date for this project</dt>
              <dd>{template.publication.verifiedAt}</dd>
            </div>
            {transform.rotationDeg !== 0 && (
              <div>
                <dt>Rotation</dt>
                <dd>{transform.rotationDeg}° (orientation correction only)</dd>
              </div>
            )}
          </dl>
          {checks && (
            <ul className="check-list">
              {checks.map((c) => (
                <li key={c.id} className={`check-${c.status}`}>
                  <strong>{c.label}：</strong>
                  {statusText(c.status)}
                  {c.detail && <span className="muted"> ({c.detail})</span>}
                </li>
              ))}
            </ul>
          )}
          <TemplateDisclosure entry={template} />
          <p className="muted">
            Pose, exposure, and sharpness are heuristic judgments, not calibrated to official
            tolerances, and do not guarantee acceptance by the issuing authority. If a medical or
            physical condition prevents holding the standard pose, you may still export; some
            issuing authorities offer medical or disability exceptions.
          </p>
          {template.publication.status !== "active" && (
            <p className="warn-text">{template.publication.statusReason}</p>
          )}
        </>
      )}
      {/* Exits render unconditionally: even on render failure there is a
      deterministic path back to edit or restart */}
      <div className="step-actions">
        {artifact && (
          <button type="button" className="primary" onClick={download}>
            Download {filename}
          </button>
        )}
        <button type="button" onClick={onBack}>
          Back to edit
        </button>
        <button type="button" onClick={onRestart}>
          Restart
        </button>
      </div>
      {artifact && (
        <StagingPanel
          artifact={artifact}
          template={template}
          staged={staged}
          stagedStale={stagedStale}
          onStaged={onStaged}
        />
      )}
    </section>
  );
}

function statusText(status: CheckItem["status"]): string {
  switch (status) {
    case "pass":
      return "Passed";
    case "warn":
      return "Warning";
    case "fail":
      return "Failed";
    case "unknown":
      return "Not checked";
    case "manual":
      return "Needs manual confirmation";
  }
}
