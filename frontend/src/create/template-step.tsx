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
      .catch(() => {
        if (cancelled) return;
        // The raw transport error ("HTTP 500") tells the user nothing and
        // reads as a broken product; the actionable part is that the catalog
        // comes from the server, so this is a connection problem rather than
        // anything they did.
        setError(
          "could not load the photo templates. The template service is not responding - check that the server is running, then retry.",
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
  // Split rather than sort. Half the catalog is reference_only, and rendered
  // inline those cards are a wall of disabled buttons carrying their own
  // "not verified" text - filtering by passport used to return nothing else.
  // Collapsed, every disclosure is still one click away (TMP-003) while the
  // templates that can actually produce a photo come first.
  const { selectable, unavailable } = useMemo(
    () => ({
      selectable: entries.filter((e) => e.publication.status === "active"),
      unavailable: entries.filter((e) => e.publication.status !== "active"),
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
      {selectable.length === 0 && unavailable.length === 0 && (
        <p className="muted">No templates match the current filters.</p>
      )}
      {selectable.length > 0 && (
        <ul className="template-list">
          {selectable.map((entry) => (
            <TemplateCard key={entry.revision.revisionId} entry={entry} onSelect={onSelect} />
          ))}
        </ul>
      )}
      {selectable.length === 0 && unavailable.length > 0 && (
        <p className="muted">
          No template matching these filters can produce a submittable photo yet. The ones that
          match are listed below with the verification each is still waiting on.
        </p>
      )}
      {unavailable.length > 0 && (
        <details className="unavailable-templates">
          <summary>
            {unavailable.length} matching {unavailable.length === 1 ? "template" : "templates"} not
            yet submittable
          </summary>
          <p className="muted">
            These specifications are recorded with their official sources, but have not passed this
            project&apos;s publication verification, so they cannot produce a submittable photo yet.
          </p>
          <ul className="template-list">
            {unavailable.map((entry) => (
              <TemplateCard key={entry.revision.revisionId} entry={entry} onSelect={onSelect} />
            ))}
          </ul>
        </details>
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
