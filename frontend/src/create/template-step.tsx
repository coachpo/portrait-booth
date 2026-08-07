import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  channelName,
  documentTypeName,
  entryLabel,
  fetchTemplateCatalog,
  filterTemplates,
  isOfficialDocument,
  jurisdictionName,
  uniqueJurisdictions,
} from "../lib/templates/catalog";
import { outputDescription } from "../lib/templates/describe";
import { capabilityRestrictions, sourceNotesFor } from "../lib/templates/disclosure";
import { editorPolicy } from "../lib/templates/policy";
import { uiLocale } from "../lib/locale";
import type {
  DocumentType,
  SubmissionChannel,
  TemplateCatalog,
  TemplateEntry,
} from "../lib/templates/types";

const DOCUMENT_TYPES: DocumentType[] = ["passport", "visa", "id", "portrait"];
const CHANNELS: SubmissionChannel[] = [
  "digital_upload",
  "paper",
  "certified_transfer",
  "onsite_capture",
];

export interface TemplateStepProps {
  onSelect: (entry: TemplateEntry) => void;
}

export function TemplateStep({ onSelect }: TemplateStepProps) {
  const [catalog, setCatalog] = useState<TemplateCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [jurisdiction, setJurisdiction] = useState<string>("");
  const [documentType, setDocumentType] = useState<DocumentType | "">("");
  const [channel, setChannel] = useState<SubmissionChannel | "">("");

  useEffect(() => {
    let cancelled = false;
    fetchTemplateCatalog()
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? `template catalog failed to load: ${err.message}`
            : "template catalog failed to load",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setError(null);
    setCatalog(null);
    setAttempt((n) => n + 1);
  };

  const jurisdictions = useMemo(() => (catalog ? uniqueJurisdictions(catalog) : []), [catalog]);
  const entries = useMemo(
    () =>
      catalog
        ? filterTemplates(catalog, {
            jurisdiction: jurisdiction || undefined,
            documentType: documentType || undefined,
            channel: channel || undefined,
          })
        : [],
    [catalog, jurisdiction, documentType, channel],
  );
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const pa = a.publication.status === "active" ? 0 : 1;
        const pb = b.publication.status === "active" ? 0 : 1;
        return pa - pb;
      }),
    [entries],
  );

  if (error) {
    return (
      <div role="alert" className="template-error">
        <p>{error}</p>
        <button type="button" onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (!catalog) {
    return <p aria-live="polite">Loading template catalog…</p>;
  }

  return (
    <section aria-label="Choose photo template">
      <h2>Choose a photo specification</h2>
      <p className="muted">
        Filter templates by document type; generic portrait templates are not for official
        applications and suit ordinary photos or development acceptance only.
      </p>
      <fieldset className="filter-group">
        <legend>Country or region</legend>
        <button
          type="button"
          className={jurisdiction === "" ? "chip selected" : "chip"}
          onClick={() => setJurisdiction("")}
        >
          All
        </button>
        {jurisdictions.map((code) => (
          <button
            key={code}
            type="button"
            className={jurisdiction === code ? "chip selected" : "chip"}
            onClick={() => setJurisdiction(code)}
          >
            {jurisdictionName(code)}
          </button>
        ))}
      </fieldset>
      <div className="filter-row">
        <label>
          Document type
          <select
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value as DocumentType | "")}
          >
            <option value="">All</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {documentTypeName(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Submission channel
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as SubmissionChannel | "")}
          >
            <option value="">All</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {channelName(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sorted.length === 0 ? (
        <p className="muted">No templates match the current filters.</p>
      ) : (
        <ul className="template-list">
          {sorted.map((entry) => (
            <TemplateCard key={entry.revision.revisionId} entry={entry} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateCard({
  entry,
  onSelect,
}: {
  entry: TemplateEntry;
  onSelect: (e: TemplateEntry) => void;
}) {
  const rev = entry.revision;
  const status = entry.publication.status;
  const official = isOfficialDocument(entry);
  const restrictions = capabilityRestrictions(rev.capabilities);
  const notes = sourceNotesFor(rev, uiLocale());
  return (
    <li className="template-card">
      <div className="template-card-head">
        <h3>{entryLabel(entry, uiLocale())}</h3>
        <span className={`badge badge-${status}`}>
          {status === "active" ? "Available" : "Reference only"}
        </span>
        {!official && <span className="badge badge-portrait">Non-document template</span>}
      </div>
      {status !== "active" && <p className="warn-text">{entry.publication.statusReason}</p>}
      <dl className="template-card-details">
        <div>
          <dt>Specification</dt>
          <dd>{outputDescription(rev.output)}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{rev.sources.map((s) => s.authority).join(", ")}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{rev.version}</dd>
        </div>
        <div>
          <dt>Review date for this project</dt>
          <dd>{entry.publication.verifiedAt}</dd>
        </div>
        {rev.applicationPost && (
          <div>
            <dt>Applicable post</dt>
            <dd>{rev.applicationPost}</dd>
          </div>
        )}
      </dl>
      {restrictions.length > 0 && (
        <ul className="muted">
          {restrictions.map((r) => (
            <li key={r.id}>
              <strong>{r.level === "forbidden" ? "Forbidden" : "Warning"}: </strong>
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {!official && notes.length > 0 && <p className="muted">{notes[0]}</p>}
      {editorPolicy(entry.revision).sourceRequirements.length > 0 && (
        <ul className="muted">
          {editorPolicy(entry.revision).sourceRequirements.map((r) => (
            <li key={r.id}>{r.text}</li>
          ))}
        </ul>
      )}
      <div className="template-card-actions">
        {status === "active" ? (
          <button type="button" className="primary" onClick={() => onSelect(entry)}>
            Select this template
          </button>
        ) : (
          <button
            type="button"
            disabled
            title="this template has not passed publication verification"
          >
            Not submittable
          </button>
        )}
        <Link className="secondary-link" to={`/templates/${entry.revision.revisionId}`}>
          View template details
        </Link>
        <details className="sources">
          <summary>
            {official ? "Official sources" : "Project-internal specification sources"}
          </summary>
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
        </details>
        {notes.length > 0 && (
          <details className="sources">
            <summary>Template review record ({notes.length} entries)</summary>
            <ul>
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}
