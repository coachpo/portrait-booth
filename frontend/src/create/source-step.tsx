import { useRef, useState } from "react";

import { entryLabel } from "../lib/templates/catalog";
import { uiLocale } from "../lib/locale";
import type { TemplateEntry } from "../lib/templates/types";
import { loadSourceImage, sourceErrorMessage, type SourceImage } from "../image/source";
import { runStaticCheck } from "../pose/static-check";

export interface SourceStepProps {
  template: TemplateEntry;
  onReady: (source: SourceImage) => void;
  onBack: () => void;
}

export function SourceStep({ template, onReady, onBack }: SourceStepProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      const source = await loadSourceImage(file);
      // GDE-009：上传照片也执行静态位置/角度/质量分析
      try {
        // GDE-009 复检结果随 source 传递，由终态页统一展示
        const checks = await runStaticCheck(source.bitmap);
        onReady({ ...source, staticChecks: checks });
      } catch {
        onReady(source);
      }
    } catch (err) {
      setError(sourceErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section aria-label="选择照片来源">
      <h2>上传照片</h2>
      <p className="muted">
        已选模板：{entryLabel(template, uiLocale())}。支持 JPEG、PNG、WebP（单文件 ≤15
        MB）；照片只在本地处理，不会自动上传。
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="visually-hidden"
        aria-label="选择照片文件"
        data-testid="file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
      />
      <div
        className={`drop-zone${dragOver ? " drag-over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
      >
        {loading ? <p aria-live="polite">正在读取照片…</p> : <p>点击选择文件，或将照片拖到这里</p>}
      </div>
      {error && (
        <p role="alert" className="warn-text">
          {error}
        </p>
      )}
      <div className="step-actions">
        <button type="button" onClick={onBack}>
          返回重新选择模板
        </button>
      </div>
    </section>
  );
}
