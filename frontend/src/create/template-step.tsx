import { useEffect, useMemo, useState } from "react";

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
import { capabilityRestrictions, sourceNotesFor } from "../lib/templates/disclosure";
import { editorPolicy } from "../lib/templates/policy";
import type {
  DocumentType,
  OutputProfile,
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

function outputDescription(output: OutputProfile): string {
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
        setError(err instanceof Error ? `模板目录加载失败：${err.message}` : "模板目录加载失败");
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
          重试
        </button>
      </div>
    );
  }
  if (!catalog) {
    return <p aria-live="polite">正在加载模板目录…</p>;
  }

  return (
    <section aria-label="选择照片模板">
      <h2>选择照片规格</h2>
      <p className="muted">
        按证件类型筛选模板；通用肖像模板不用于官方申请，仅适合普通照片或开发验收。
      </p>
      <fieldset className="filter-group">
        <legend>国家或地区</legend>
        <button
          type="button"
          className={jurisdiction === "" ? "chip selected" : "chip"}
          onClick={() => setJurisdiction("")}
        >
          全部
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
          证件类型
          <select
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value as DocumentType | "")}
          >
            <option value="">全部</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {documentTypeName(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          提交渠道
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as SubmissionChannel | "")}
          >
            <option value="">全部</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {channelName(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {sorted.length === 0 ? (
        <p className="muted">没有符合筛选条件的模板。</p>
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
  const notes = sourceNotesFor(rev, "zh");
  return (
    <li className="template-card">
      <div className="template-card-head">
        <h3>{entryLabel(entry, "zh")}</h3>
        <span className={`badge badge-${status}`}>{status === "active" ? "可用" : "仅供参考"}</span>
        {!official && <span className="badge badge-portrait">非证件模板</span>}
      </div>
      {status !== "active" && <p className="warn-text">{entry.publication.statusReason}</p>}
      <dl className="template-card-details">
        <div>
          <dt>规格</dt>
          <dd>{outputDescription(rev.output)}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{rev.sources.map((s) => s.authority).join("、")}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>{rev.version}</dd>
        </div>
        <div>
          <dt>本项目复核日期</dt>
          <dd>{entry.publication.verifiedAt}</dd>
        </div>
        {rev.applicationPost && (
          <div>
            <dt>适用领区</dt>
            <dd>{rev.applicationPost}</dd>
          </div>
        )}
      </dl>
      {restrictions.length > 0 && (
        <ul className="muted">
          {restrictions.map((r) => (
            <li key={r.id}>
              <strong>{r.level === "forbidden" ? "禁止" : "警告"}：</strong>
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
            选择此模板
          </button>
        ) : (
          <button type="button" disabled title="该模板尚未通过发布验证">
            不可用于提交
          </button>
        )}
        <details className="sources">
          <summary>{official ? "官方来源" : "项目内部规格来源"}</summary>
          <ul>
            {rev.sources.map((s) => (
              <li key={s.id}>
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.title}（{s.authority}）
                </a>
                {s.sourceUpdatedAt && <span className="muted"> 更新于 {s.sourceUpdatedAt}</span>}
                <span className="muted"> 访问于 {s.accessedAt}</span>
              </li>
            ))}
          </ul>
        </details>
        {notes.length > 0 && (
          <details className="sources">
            <summary>模板复核记录（{notes.length} 条）</summary>
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
