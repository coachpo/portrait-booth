/**
 * 确认步骤。
 *
 * 拍摄或上传之后必须有一次确认机会：直接跳进编辑器意味着用户要先经过编辑、
 * 再到终态页，才发现这张照片根本不能用。静态复检的结果也在这里就近给出，
 * 而不是等走到终态页才第一次出现。
 */

import { useEffect, useMemo } from "react";

import type { SourceImage } from "../image/source";
import { entryLabel } from "../lib/templates/catalog";
import type { TemplateEntry } from "../lib/templates/types";
import { staticCheckWarnings } from "../pose/static-check";
import { outputSize } from "../editor/edit-transform";

export interface ReviewStepProps {
  source: SourceImage;
  template: TemplateEntry;
  /** 用户是自己拍的还是上传的——决定「重新拍摄」还是「重新选择文件」 */
  origin: "camera" | "upload";
  onConfirm: () => void;
  onRetake: () => void;
  onBack: () => void;
}

export function ReviewStep({
  source,
  template,
  origin,
  onConfirm,
  onRetake,
  onBack,
}: ReviewStepProps) {
  // 源图自带 previewUrl 时直接用；否则临时造一个，并在源切换时释放
  const previewUrl = useMemo(() => source.previewUrl ?? URL.createObjectURL(source.file), [source]);
  useEffect(() => {
    if (source.previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [source, previewUrl]);

  const warnings = useMemo(
    () => (source.staticChecks ? staticCheckWarnings(source.staticChecks) : []),
    [source.staticChecks],
  );

  const out = outputSize(template.revision);
  // 源图分辨率是否够填满模板输出（EDT-004）
  const shortfall =
    out !== null && Math.max(out.width / source.width, out.height / source.height) > 1.001;

  return (
    <section aria-label="确认照片">
      <h2>确认这张照片</h2>
      <p className="muted">
        模板：{entryLabel(template, "zh")}
        {out && `（输出 ${out.width}×${out.height} 像素）`}。确认后进入裁剪与编辑。
      </p>

      <div className="source-preview">
        <img src={previewUrl} alt="待确认的照片" />
      </div>

      <dl className="final-details">
        <div>
          <dt>照片像素</dt>
          <dd>
            {source.width}×{source.height}
          </dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{origin === "camera" ? "本机摄像头拍摄" : "本地文件上传"}</dd>
        </div>
      </dl>

      {shortfall && (
        <p className="warn-text" role="alert">
          这张照片小于模板要求的输出尺寸，继续编辑会需要放大，成品清晰度将明显下降。
        </p>
      )}

      {source.staticChecks && warnings.length > 0 && (
        <div className="warn-text">
          <p>复检提示（启发式判断，未经官方容差校准）：</p>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <p className="muted">
            这些提示不阻止你继续。若因医疗或身体原因无法保持标准姿态，仍可继续导出；
            部分签发机关提供医疗或残障例外。
          </p>
        </div>
      )}
      {source.staticChecks && warnings.length === 0 && (
        <p className="muted">复检未发现明显问题（启发式判断，未经官方容差校准）。</p>
      )}
      {!source.staticChecks && <p className="muted">本次未运行姿态与曝光复检。</p>}

      <div className="step-actions">
        <button type="button" className="primary" onClick={onConfirm}>
          使用这张照片
        </button>
        <button type="button" onClick={onRetake}>
          {origin === "camera" ? "重新拍摄" : "重新选择文件"}
        </button>
        <button type="button" onClick={onBack}>
          返回上一步
        </button>
      </div>
    </section>
  );
}
