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

export interface FinalPageProps {
  source: SourceImage;
  template: TemplateEntry;
  transform: EditTransform;
  onBack: () => void;
  onRestart: () => void;
  staged: StagedReceipt | null;
  stagedStale: boolean;
  onStaged: (receipt: StagedReceipt | null) => void;
  /** ranged_pixels 模板的用户选定尺寸（P6） */
  selectedSize?: OutputSizeOption | null;
  /** 体积超限时降回默认尺寸重新生成 */
  onUseDefaultSize?: () => void;
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

export interface PhysicalSizeInfo {
  mm: string;
  printReady: boolean;
}

/** OUT-006：毫米数值必须与打印结论绑定在同一处，不得裸展示 */
export function physicalSizeInfo(template: TemplateEntry): PhysicalSizeInfo | null {
  const out = template.revision.output;
  if (out.kind !== "physical_raster") return null;
  return {
    mm: `${out.widthMm}×${out.heightMm} 毫米`,
    printReady: isPrintReady(template),
  };
}

/** TMP-002 披露块：来源、限制短语、复核注记三个子块各自判空，全空则不渲染 */
function TemplateDisclosure({ entry }: { entry: TemplateEntry }) {
  const rev = entry.revision;
  const restrictions = capabilityRestrictions(rev.capabilities);
  const notes = sourceNotesFor(rev, "zh");
  if (rev.sources.length === 0 && restrictions.length === 0 && notes.length === 0) return null;
  return (
    <section className="template-disclosure" aria-label="模板披露">
      <h3>模板披露</h3>
      {rev.sources.length > 0 && (
        <div>
          <h4>来源</h4>
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
        </div>
      )}
      {restrictions.length > 0 && (
        <div>
          <h4>模板限制</h4>
          <ul>
            {restrictions.map((r) => (
              <li key={r.id}>
                <strong>{r.level === "forbidden" ? "禁止" : "警告"}：</strong>
                {r.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <h4>模板复核记录</h4>
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
    // 每次渲染前清空旧值：失败态不留上一次成品，成功态不留上一次错误/重试按钮。
    // 必须同步写在 effect 体最前（写进 then/catch 或另开 effect 都清不掉旧值），
    // react-hooks/set-state-in-effect 的告警是此处有意例外（工单 A3 指定写法）
    /* eslint-disable react-hooks/set-state-in-effect -- 同步清空旧渲染结果 */
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
        // 静态复检已经跑出真实结果，检查摘要必须用它，而不是写「后续版本提供」
        setChecks(await buildChecks(a, template, source.staticChecks ?? null, selectedSize));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorKind(err instanceof RenderError ? err.kind : null);
        setError(err instanceof Error ? err.message : "终态渲染失败");
      });
    return () => {
      cancelled = true;
    };
  }, [source, template, transform, attempt, selectedSize]);

  const filename = exportFilename(template);
  const physical = physicalSizeInfo(template);
  const rev = template.revision;
  // 体积超限时的降档目标：模板默认尺寸（P6 坑 8：重试跑同一尺寸必然再次失败）
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
          {canDowngrade && (
            <button type="button" onClick={onUseDefaultSize}>
              改用 {defaultSize.width}×{defaultSize.height} 重新生成
            </button>
          )}
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
                <dd>
                  {physical.mm}
                  {physical.printReady
                    ? "（可按实际尺寸打印）"
                    : "（参考图：打印密度未经校准打印验证）"}
                </dd>
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
            <div>
              <dt>本项目复核日期</dt>
              <dd>{template.publication.verifiedAt}</dd>
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
          <TemplateDisclosure entry={template} />
          <p className="muted">
            姿态、曝光与清晰度为启发式判断，未经官方容差校准，不代表签发机关一定受理。
            若因医疗或身体原因无法保持标准姿态，仍可继续导出；部分签发机关提供医疗或残障例外。
          </p>
          {template.publication.status !== "active" && (
            <p className="warn-text">{template.publication.statusReason}</p>
          )}
        </>
      )}
      {/* 出口无条件渲染：渲染失败时也有回编辑/重开的确定路径 */}
      <div className="step-actions">
        {artifact && (
          <button type="button" className="primary" onClick={download}>
            下载 {filename}
          </button>
        )}
        <button type="button" onClick={onBack}>
          返回编辑
        </button>
        <button type="button" onClick={onRestart}>
          重新开始
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
      return "通过";
    case "warn":
      return "警告";
    case "fail":
      return "未通过";
    case "unknown":
      return "未检查";
    case "manual":
      return "需人工确认";
  }
}
