/**
 * Template detail page (TMP-002 full disclosure): /templates/:revisionId.
 * Read-only display of the full revision/publication fields already in the
 * catalog response; the catalog cache is a module-level singleton and this
 * page makes no new network calls.
 */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  channelName,
  documentTypeName,
  entryLabel,
  fetchTemplateCatalog,
  isOfficialDocument,
  jurisdictionName,
} from "../lib/templates/catalog";
import {
  capabilityValueLabel,
  enforcementLabel,
  evaluationLabel,
  normalizationLabel,
  outputDescription,
  provenanceLabel,
} from "../lib/templates/describe";
import { sourceNotesFor } from "../lib/templates/disclosure";
import { uiLocale } from "../lib/locale";
import type { TemplateCatalog, TemplateEntry } from "../lib/templates/types";
import { metricLabel } from "../editor/overlay";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; catalog: TemplateCatalog }
  | { kind: "missing" };

function isOfficial(entry: TemplateEntry): boolean {
  return isOfficialDocument(entry);
}

function CapabilityList({ entry }: { entry: TemplateEntry }) {
  const caps = entry.revision.capabilities;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Self-capture", value: capabilityValueLabel(caps.selfCapture) },
    { label: "Adjust composition", value: capabilityValueLabel(caps.crop) },
    { label: "Rotation", value: capabilityValueLabel(caps.rotate) },
    { label: "Mirroring", value: capabilityValueLabel(caps.mirror) },
    { label: "Retouching", value: capabilityValueLabel(caps.retouch) },
    { label: "Background replacement", value: capabilityValueLabel(caps.backgroundReplace) },
    {
      label: "Original camera file",
      value: caps.requiresOriginalCameraFile ? "Required" : "Not required",
    },
    {
      label: "Certified photographer",
      value: caps.requiresProfessionalPhotographer ? "Required" : "Not required",
    },
  ];
  return (
    <ul className="capability-list">
      {rows.map((r) => (
        <li key={r.label}>
          <strong>{r.label}: </strong>
          {r.value}
        </li>
      ))}
    </ul>
  );
}

function RuleSource({ refs, literal }: { refs: string[]; literal?: string }) {
  return (
    <ul className="rule-meta">
      {literal && <li>Official source text: {literal}</li>}
      {refs.length > 0 && <li>Source references: {refs.join(", ")}</li>}
    </ul>
  );
}

function CropRules({ entry }: { entry: TemplateEntry }) {
  const rev = entry.revision;
  if (rev.cropRules.length === 0) {
    return <p className="muted">This template declares no crop rules.</p>;
  }
  const overlayIds = new Set(entry.revision.overlay.ruleIds);
  return (
    <ul className="rule-list">
      {rev.cropRules.map((r) => (
        <li key={r.id}>
          <strong>{r.id}</strong>
          {overlayIds.has(r.id) && <span className="badge badge-active">Used in mask</span>}
          <ul className="rule-meta">
            <li>
              Metric: {metricLabel(r.metric)}
              {r.min !== undefined && `, min ${r.min} ${r.unit}`}
              {r.max !== undefined && `, max ${r.max} ${r.unit}`}
              {r.target !== undefined && `, target ${r.target} ${r.unit}`}
              {r.tolerance !== undefined && `, tolerance ${r.tolerance} ${r.unit}`}
            </li>
            <li>
              Coordinates: {r.coordinateSpace}, axis {r.axis}, anchors {r.anchors.join(", ")}
            </li>
            <li>
              Judgment: {evaluationLabel(r.evaluation)}, {enforcementLabel(r.enforcement)},
              provenance: {provenanceLabel(r.provenance)}
            </li>
          </ul>
          <RuleSource refs={r.sourceRefs} literal={r.sourceLiteral} />
        </li>
      ))}
    </ul>
  );
}

function CaptureRules({ entry }: { entry: TemplateEntry }) {
  const rules = entry.revision.captureRules;
  if (rules.length === 0) {
    return <p className="muted">This template declares no capture rules.</p>;
  }
  return (
    <ul className="rule-list">
      {rules.map((r) => {
        const expected =
          typeof r.expected === "boolean"
            ? r.expected
              ? "must hold"
              : "must not hold"
            : String(r.expected);
        return (
          <li key={r.id}>
            <strong>{r.id}</strong>
            <ul className="rule-meta">
              <li>
                Check: {r.check}; expected: {expected}
              </li>
              <li>
                Judgment: {evaluationLabel(r.evaluation)}, {enforcementLabel(r.enforcement)},
                provenance: {provenanceLabel(r.provenance)}
              </li>
            </ul>
            <RuleSource refs={r.sourceRefs} literal={r.sourceLiteral} />
          </li>
        );
      })}
    </ul>
  );
}

function OutputSection({ entry }: { entry: TemplateEntry }) {
  const rev = entry.revision;
  const out = rev.output;
  const of = rev.outputFile;
  return (
    <div>
      <h2>Output specification</h2>
      <dl className="final-details">
        <div>
          <dt>Description</dt>
          <dd>{outputDescription(out)}</dd>
        </div>
        {(out.kind === "exact_pixels" || out.kind === "ranged_pixels") && (
          <div>
            <dt>Aspect ratio</dt>
            <dd>
              {out.aspect.width}:{out.aspect.height} ({enforcementLabel(out.aspect.enforcement)},
              provenance: {provenanceLabel(out.aspect.provenance)})
            </dd>
          </div>
        )}
        {of && (
          <>
            <div>
              <dt>Format</dt>
              <dd>{of.mime.join(", ")}</dd>
            </div>
            {of.sizeLimit && (
              <div>
                <dt>Size limit</dt>
                <dd>
                  {of.sizeLimit.minBytes !== undefined && `min ${of.sizeLimit.minBytes} bytes; `}
                  {of.sizeLimit.maxBytes !== undefined && `max ${of.sizeLimit.maxBytes} bytes; `}
                  {of.sizeLimit.normalization && normalizationLabel(of.sizeLimit.normalization)}
                  {of.sizeLimit.sourceLiteral && ` (${of.sizeLimit.sourceLiteral})`}
                </dd>
              </div>
            )}
            {of.colorSpace && (
              <div>
                <dt>Color space</dt>
                <dd>{of.colorSpace}</dd>
              </div>
            )}
            {of.bitsPerChannel !== undefined && (
              <div>
                <dt>Bits per channel</dt>
                <dd>{of.bitsPerChannel}</dd>
              </div>
            )}
            {of.channels !== undefined && (
              <div>
                <dt>Channels</dt>
                <dd>{of.channels}</dd>
              </div>
            )}
            {of.maxCompressionRatio !== undefined && (
              <div>
                <dt>Max compression ratio</dt>
                <dd>{of.maxCompressionRatio}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </div>
  );
}

export function TemplateDetailPage() {
  const { revisionId } = useParams<{ revisionId: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Every reload/retry starts back at loading (writing in then/catch or a
    // separate effect cannot clear the stale state)
    /* eslint-disable react-hooks/set-state-in-effect -- loading reset for data fetching */
    setState({ kind: "loading" });
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchTemplateCatalog()
      .then((catalog) => {
        if (cancelled) return;
        const entry = catalog.templates.find((e) => e.revision.revisionId === revisionId);
        setState(entry ? { kind: "ready", catalog } : { kind: "missing" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : "load failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [revisionId, attempt]);

  if (state.kind === "loading") {
    return <p aria-live="polite">Loading template details…</p>;
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="template-error">
        <p>Template catalog failed to load: {state.message}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <section aria-label="Template not found">
        <h1>Template not found</h1>
        <p className="muted">
          No template found for "{revisionId}"; it may have been removed or the address is wrong.
        </p>
        <Link to="/create">Back to template list</Link>
      </section>
    );
  }

  const entry = state.catalog.templates.find((e) => e.revision.revisionId === revisionId)!;
  const rev = entry.revision;
  const pub = entry.publication;
  const official = isOfficial(entry);
  const notes = sourceNotesFor(rev, uiLocale());

  return (
    <section aria-label="Template details">
      <h1>{entryLabel(entry, uiLocale())}</h1>
      <p className="muted">
        <span className={`badge badge-${pub.status}`}>
          {pub.status === "active" ? "Available" : "Reference only"}
        </span>
        {!official && <span className="badge badge-portrait">Non-document template</span>}
      </p>
      {pub.statusReason && <p className="warn-text">{pub.statusReason}</p>}

      <div>
        <h2>Version & governance</h2>
        <dl className="final-details">
          <div>
            <dt>revisionId</dt>
            <dd>{rev.revisionId}</dd>
          </div>
          <div>
            <dt>Template ID / version</dt>
            <dd>
              {rev.id}@{rev.version} (schema v{rev.schemaVersion})
            </dd>
          </div>
          <div>
            <dt>contentHash</dt>
            <dd>{entry.contentHash}</dd>
          </div>
          <div>
            <dt>Review date for this project</dt>
            <dd>{pub.verifiedAt}</dd>
          </div>
          <div>
            <dt>Review due date</dt>
            <dd>{pub.reviewDueAt}</dd>
          </div>
          <div>
            <dt>Effective date</dt>
            <dd>{pub.effectiveAt}</dd>
          </div>
          <div>
            <dt>Maintainer / reviewer</dt>
            <dd>
              {pub.owner} / {pub.reviewer} (publication revision v{pub.publicationRevision})
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h2>Applicable scope</h2>
        <dl className="final-details">
          <div>
            <dt>Jurisdiction</dt>
            <dd>{jurisdictionName(rev.jurisdiction)}</dd>
          </div>
          <div>
            <dt>Document type</dt>
            <dd>{documentTypeName(rev.documentType)}</dd>
          </div>
          <div>
            <dt>Submission channel</dt>
            <dd>{channelName(rev.submissionChannel)}</dd>
          </div>
          <div>
            <dt>Applicant class</dt>
            <dd>{rev.applicantClass}</dd>
          </div>
          {rev.applicationPost && (
            <div>
              <dt>Applicable post</dt>
              <dd>{rev.applicationPost}</dd>
            </div>
          )}
        </dl>
      </div>

      <OutputSection entry={entry} />

      <div>
        <h2>Crop rules</h2>
        <CropRules entry={entry} />
      </div>

      <div>
        <h2>Capture rules</h2>
        <CaptureRules entry={entry} />
      </div>

      <div>
        <h2>Capability restrictions</h2>
        <CapabilityList entry={entry} />
      </div>

      <div>
        <h2>Official sources</h2>
        <ul className="rule-list">
          {rev.sources.map((s) => (
            <li key={s.id}>
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title} ({s.authority})
              </a>
              <ul className="rule-meta">
                <li>Accessed {s.accessedAt}</li>
                <li>
                  {s.sourceUpdatedAt
                    ? `Officially updated ${s.sourceUpdatedAt}`
                    : "Official update time not provided"}
                </li>
              </ul>
            </li>
          ))}
        </ul>
      </div>

      {notes.length > 0 && (
        <div>
          <h2>Template review record</h2>
          <ul className="rule-list">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="step-actions">
        <Link to="/create">Back to template list</Link>
      </div>
    </section>
  );
}
