/**
 * 模板详情页（TMP-002 完整披露）：/templates/:revisionId。
 * 只读展示目录响应里已有的 revision/publication 全量字段；
 * 目录缓存是模块级单例，本页不新增任何网络调用。
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
    { label: "自行拍摄", value: capabilityValueLabel(caps.selfCapture) },
    { label: "调整构图", value: capabilityValueLabel(caps.crop) },
    { label: "旋转", value: capabilityValueLabel(caps.rotate) },
    { label: "镜像", value: capabilityValueLabel(caps.mirror) },
    { label: "修饰", value: capabilityValueLabel(caps.retouch) },
    { label: "背景替换", value: capabilityValueLabel(caps.backgroundReplace) },
    {
      label: "原始相机文件",
      value: caps.requiresOriginalCameraFile ? "要求" : "不要求",
    },
    {
      label: "认证摄影师",
      value: caps.requiresProfessionalPhotographer ? "要求" : "不要求",
    },
  ];
  return (
    <ul className="capability-list">
      {rows.map((r) => (
        <li key={r.label}>
          <strong>{r.label}：</strong>
          {r.value}
        </li>
      ))}
    </ul>
  );
}

function RuleSource({ refs, literal }: { refs: string[]; literal?: string }) {
  return (
    <ul className="rule-meta">
      {literal && <li>官方原文：{literal}</li>}
      {refs.length > 0 && <li>来源引用：{refs.join("、")}</li>}
    </ul>
  );
}

function CropRules({ entry }: { entry: TemplateEntry }) {
  const rev = entry.revision;
  if (rev.cropRules.length === 0) {
    return <p className="muted">本模板未声明裁剪规则。</p>;
  }
  const overlayIds = new Set(entry.revision.overlay.ruleIds);
  return (
    <ul className="rule-list">
      {rev.cropRules.map((r) => (
        <li key={r.id}>
          <strong>{r.id}</strong>
          {overlayIds.has(r.id) && <span className="badge badge-active">用于蒙版</span>}
          <ul className="rule-meta">
            <li>
              指标：{metricLabel(r.metric)}
              {r.min !== undefined && `，最小 ${r.min} ${r.unit}`}
              {r.max !== undefined && `，最大 ${r.max} ${r.unit}`}
              {r.target !== undefined && `，目标 ${r.target} ${r.unit}`}
              {r.tolerance !== undefined && `，容差 ${r.tolerance} ${r.unit}`}
            </li>
            <li>
              坐标：{r.coordinateSpace}，轴 {r.axis}，锚点 {r.anchors.join("、")}
            </li>
            <li>
              判定：{evaluationLabel(r.evaluation)}，{enforcementLabel(r.enforcement)}，来源：
              {provenanceLabel(r.provenance)}
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
    return <p className="muted">本模板未声明拍摄规则。</p>;
  }
  return (
    <ul className="rule-list">
      {rules.map((r) => {
        const expected =
          typeof r.expected === "boolean"
            ? r.expected
              ? "必须满足"
              : "必须不满足"
            : String(r.expected);
        return (
          <li key={r.id}>
            <strong>{r.id}</strong>
            <ul className="rule-meta">
              <li>
                检查：{r.check}；期望：{expected}
              </li>
              <li>
                判定：{evaluationLabel(r.evaluation)}，{enforcementLabel(r.enforcement)}，来源：
                {provenanceLabel(r.provenance)}
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
      <h2>输出规格</h2>
      <dl className="final-details">
        <div>
          <dt>描述</dt>
          <dd>{outputDescription(out)}</dd>
        </div>
        {(out.kind === "exact_pixels" || out.kind === "ranged_pixels") && (
          <div>
            <dt>宽高比</dt>
            <dd>
              {out.aspect.width}:{out.aspect.height}（{enforcementLabel(out.aspect.enforcement)}，
              来源：{provenanceLabel(out.aspect.provenance)}）
            </dd>
          </div>
        )}
        {of && (
          <>
            <div>
              <dt>格式</dt>
              <dd>{of.mime.join("、")}</dd>
            </div>
            {of.sizeLimit && (
              <div>
                <dt>体积限制</dt>
                <dd>
                  {of.sizeLimit.minBytes !== undefined && `最小 ${of.sizeLimit.minBytes} 字节；`}
                  {of.sizeLimit.maxBytes !== undefined && `最大 ${of.sizeLimit.maxBytes} 字节；`}
                  {of.sizeLimit.normalization && normalizationLabel(of.sizeLimit.normalization)}
                  {of.sizeLimit.sourceLiteral && `（${of.sizeLimit.sourceLiteral}）`}
                </dd>
              </div>
            )}
            {of.colorSpace && (
              <div>
                <dt>色彩空间</dt>
                <dd>{of.colorSpace}</dd>
              </div>
            )}
            {of.bitsPerChannel !== undefined && (
              <div>
                <dt>位深</dt>
                <dd>{of.bitsPerChannel}</dd>
              </div>
            )}
            {of.channels !== undefined && (
              <div>
                <dt>通道</dt>
                <dd>{of.channels}</dd>
              </div>
            )}
            {of.maxCompressionRatio !== undefined && (
              <div>
                <dt>最大压缩比</dt>
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
    // 每次重新加载/重试都先回到 loading 态（写进 then/catch 或另开 effect 都清不掉旧态）
    /* eslint-disable react-hooks/set-state-in-effect -- 数据获取的 loading 复位 */
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
        setState({ kind: "error", message: err instanceof Error ? err.message : "加载失败" });
      });
    return () => {
      cancelled = true;
    };
  }, [revisionId, attempt]);

  if (state.kind === "loading") {
    return <p aria-live="polite">正在加载模板详情…</p>;
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="template-error">
        <p>模板目录加载失败：{state.message}</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          重试
        </button>
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <section aria-label="模板不存在">
        <h1>模板不存在</h1>
        <p className="muted">未找到模板「{revisionId}」，可能已被移除或地址有误。</p>
        <Link to="/create">返回模板列表</Link>
      </section>
    );
  }

  const entry = state.catalog.templates.find((e) => e.revision.revisionId === revisionId)!;
  const rev = entry.revision;
  const pub = entry.publication;
  const official = isOfficial(entry);
  const notes = sourceNotesFor(rev, uiLocale());

  return (
    <section aria-label="模板详情">
      <h1>{entryLabel(entry, uiLocale())}</h1>
      <p className="muted">
        <span className={`badge badge-${pub.status}`}>
          {pub.status === "active" ? "可用" : "仅供参考"}
        </span>
        {!official && <span className="badge badge-portrait">非证件模板</span>}
      </p>
      {pub.statusReason && <p className="warn-text">{pub.statusReason}</p>}

      <div>
        <h2>版本与治理</h2>
        <dl className="final-details">
          <div>
            <dt>revisionId</dt>
            <dd>{rev.revisionId}</dd>
          </div>
          <div>
            <dt>模板 ID / 版本</dt>
            <dd>
              {rev.id}@{rev.version}（schema v{rev.schemaVersion}）
            </dd>
          </div>
          <div>
            <dt>contentHash</dt>
            <dd>{entry.contentHash}</dd>
          </div>
          <div>
            <dt>本项目复核日期</dt>
            <dd>{pub.verifiedAt}</dd>
          </div>
          <div>
            <dt>复核到期日</dt>
            <dd>{pub.reviewDueAt}</dd>
          </div>
          <div>
            <dt>生效日期</dt>
            <dd>{pub.effectiveAt}</dd>
          </div>
          <div>
            <dt>维护 / 复核</dt>
            <dd>
              {pub.owner} / {pub.reviewer}（发布修订 v{pub.publicationRevision}）
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h2>适用范围</h2>
        <dl className="final-details">
          <div>
            <dt>辖区</dt>
            <dd>{jurisdictionName(rev.jurisdiction)}</dd>
          </div>
          <div>
            <dt>证件类型</dt>
            <dd>{documentTypeName(rev.documentType)}</dd>
          </div>
          <div>
            <dt>提交渠道</dt>
            <dd>{channelName(rev.submissionChannel)}</dd>
          </div>
          <div>
            <dt>适用人群</dt>
            <dd>{rev.applicantClass}</dd>
          </div>
          {rev.applicationPost && (
            <div>
              <dt>适用领区</dt>
              <dd>{rev.applicationPost}</dd>
            </div>
          )}
        </dl>
      </div>

      <OutputSection entry={entry} />

      <div>
        <h2>裁剪规则</h2>
        <CropRules entry={entry} />
      </div>

      <div>
        <h2>拍摄规则</h2>
        <CaptureRules entry={entry} />
      </div>

      <div>
        <h2>能力限制</h2>
        <CapabilityList entry={entry} />
      </div>

      <div>
        <h2>官方来源</h2>
        <ul className="rule-list">
          {rev.sources.map((s) => (
            <li key={s.id}>
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                {s.title}（{s.authority}）
              </a>
              <ul className="rule-meta">
                <li>访问于 {s.accessedAt}</li>
                <li>
                  {s.sourceUpdatedAt ? `官方更新于 ${s.sourceUpdatedAt}` : "官方未标注更新时间"}
                </li>
              </ul>
            </li>
          ))}
        </ul>
      </div>

      {notes.length > 0 && (
        <div>
          <h2>模板复核记录</h2>
          <ul className="rule-list">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="step-actions">
        <Link to="/create">返回模板列表</Link>
      </div>
    </section>
  );
}
