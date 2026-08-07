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
      // GDE-009: uploaded photos also get static position/angle/quality analysis
      try {
        // GDE-009 recheck results travel with the source; the final page
        // displays them
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
    <section aria-label="Choose photo source">
      <h2>Upload photo</h2>
      <p className="muted">
        Selected template: {entryLabel(template, uiLocale())}. Supports JPEG, PNG, WebP (single file
        ≤15 MB); photos are processed locally only and never uploaded automatically.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="visually-hidden"
        aria-label="Choose photo file"
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
        {loading ? (
          <p aria-live="polite">Reading photo…</p>
        ) : (
          <p>Click to choose a file, or drag a photo here</p>
        )}
      </div>
      {error && (
        <p role="alert" className="warn-text">
          {error}
        </p>
      )}
      <div className="step-actions">
        <button type="button" onClick={onBack}>
          Back to choose another template
        </button>
      </div>
    </section>
  );
}
