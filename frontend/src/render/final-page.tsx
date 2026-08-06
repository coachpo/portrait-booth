import { useEffect, useMemo, useState } from "react";

import type { EditTransform } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import { entryLabel, jurisdictionName } from "../lib/templates/catalog";
import type { TemplateEntry } from "../lib/templates/types";
import { buildChecks, type CheckItem } from "./checks";
import { StagingPanel } from "./staging-panel";
import { renderFinalArtifact, type FinalArtifact } from "./final-artifact";

export interface FinalPageProps {
  source: SourceImage;
  template: TemplateEntry;
  transform: EditTransform;
  onBack: () => void;
  onRestart: () => void;
}

function todayStamp(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

/** OUT-008：文件名不含姓名或 KEY */
function exportFilename(template: TemplateEntry): string {
  const rev = template.revision;
  return `${rev.jurisdiction.toLowerCase()}-${rev.documentType}-${rev.submissionChannel}-${todayStamp()}.jpg`;
}

function physicalSizeLabel(template: TemplateEntry): string | null {
  const out = template.revision.output;
  return out.kind === "physical_raster" ? `${out.widthMm}×${out.heightMm} 毫米` : null;
}

export function FinalPage({ source, template, transform, onBack, onRestart }: FinalPageProps) {
  const [artifact, setArtifact] = useState<FinalArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    let cancelled = false;
    renderFinalArtifact(source, template, transform)
      .then(async (a) => {
        if (cancelled) return;
        setArtifact(a);
        // 静态复检已经跑出真实结果，检查摘要必须用它，而不是写「后续版本提供」
        setChecks(await buildChecks(a, template, source.staticChecks ?? null));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "终态渲染失败");
      });
    return () => {
      cancelled = true;
    };
  }, [source, template, transform, attempt]);

  const filename = exportFilename(template);
  const physical = physicalSizeLabel(template);
  const rev = template.revision;

  const download = () => {
    if (!artifact) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(artifact.blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section aria-label="终态照片">
      <h2>终态照片</h2>
      <p className="muted">
        已选模板：{entryLabel(template, "zh")}（{jurisdictionName(rev.jurisdiction)}）
      </p>
      {error && (
        <div role="alert" className="template-error">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>
        </div>
      )}
      {!artifact && !error && <p aria-live="polite">正在渲染终态照片…</p>}
      {artifact && (
        <>
          <div className="source-preview">
            <img src={previewUrl ?? undefined} alt="终态照片预览" />
          </div>
          <dl className="final-details">
            <div>
              <dt>像素</dt>
              <dd>
                {artifact.manifest.widthPx}×{artifact.manifest.heightPx}
              </dd>
            </div>
            {physical && (
              <div>
                <dt>物理尺寸</dt>
                <dd>{physical}</dd>
              </div>
            )}
            <div>
              <dt>格式</dt>
              <dd>JPEG · sRGB</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{(artifact.blob.size / 1024).toFixed(1)} KB</dd>
            </div>
            <div>
              <dt>模板版本</dt>
              <dd>
                {rev.id}@{rev.version}
              </dd>
            </div>
            {transform.rotationDeg !== 0 && (
              <div>
                <dt>旋转</dt>
                <dd>{transform.rotationDeg}°（仅纠正画布方向）</dd>
              </div>
            )}
          </dl>
          {checks && (
            <ul className="check-list">
              {checks.map((c) => (
                <li key={c.id} className={`check-${c.status}`}>
                  <strong>{c.label}：</strong>
                  {statusText(c.status)}
                  {c.detail && <span className="muted">（{c.detail}）</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">
            姿态、曝光与清晰度为启发式判断，未经官方容差校准，不代表签发机关一定受理。
            若因医疗或身体原因无法保持标准姿态，仍可继续导出；部分签发机关提供医疗或残障例外。
          </p>
          {template.publication.status !== "active" && (
            <p className="warn-text">{template.publication.statusReason}</p>
          )}
          <div className="step-actions">
            <button type="button" className="primary" onClick={download}>
              下载 {filename}
            </button>
            <button type="button" onClick={onBack}>
              返回编辑
            </button>
            <button type="button" onClick={onRestart}>
              重新开始
            </button>
          </div>
          <StagingPanel artifact={artifact} template={template} />
        </>
      )}
    </section>
  );
}

function statusText(status: CheckItem["status"]): string {
  switch (status) {
    case "pass":
      return "通过";
    case "warn":
      return "警告";
    case "fail":
      return "未通过";
    case "unknown":
      return "未检查";
  }
}
