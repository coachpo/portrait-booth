import { useEffect, useRef, useState } from "react";

import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { EditorStep } from "../editor/editor-step";
import type { EditTransform } from "../editor/edit-transform";
import { FinalPage } from "../render/final-page";
import { CaptureStep } from "./capture-step";
import { SourceStep } from "./source-step";
import { TemplateStep } from "./template-step";

export function CreatePage() {
  const [selected, setSelected] = useState<TemplateEntry | null>(null);
  const [sourceMode, setSourceMode] = useState<"upload" | "camera" | null>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [transform, setTransform] = useState<EditTransform | null>(null);
  const sourceRef = useRef<SourceImage | null>(null);

  useEffect(
    () => () => {
      sourceRef.current?.dispose();
      sourceRef.current = null;
    },
    [],
  );

  const replaceSource = (next: SourceImage | null) => {
    sourceRef.current?.dispose();
    sourceRef.current = next;
    setSource(next);
    setTransform(null);
  };

  const backToTemplate = () => {
    replaceSource(null);
    setSourceMode(null);
    setSelected(null);
  };

  const backToSourcePicker = () => {
    replaceSource(null);
    setSourceMode(null);
  };

  return (
    <main className="container">
      <h1>创建照片</h1>
      {!selected ? (
        <TemplateStep onSelect={setSelected} />
      ) : !source ? (
        !sourceMode ? (
          <section aria-label="选择照片来源">
            <h2>选择照片来源</h2>
            <p className="muted">上传已有照片，或使用摄像头拍摄新照片。</p>
            <div className="step-actions">
              <button type="button" className="primary" onClick={() => setSourceMode("upload")}>
                上传照片
              </button>
              <button type="button" onClick={() => setSourceMode("camera")}>
                使用摄像头拍摄
              </button>
            </div>
            <div className="step-actions">
              <button type="button" onClick={() => setSelected(null)}>
                返回重新选择模板
              </button>
            </div>
          </section>
        ) : sourceMode === "upload" ? (
          <SourceStep template={selected} onReady={replaceSource} onBack={backToSourcePicker} />
        ) : (
          <CaptureStep template={selected} onReady={replaceSource} onBack={backToSourcePicker} />
        )
      ) : !transform ? (
        <EditorStep
          source={source}
          template={selected}
          onDone={setTransform}
          onBack={backToSourcePicker}
        />
      ) : (
        <FinalPage
          source={source}
          template={selected}
          transform={transform}
          onBack={() => setTransform(null)}
          onRestart={backToTemplate}
        />
      )}
    </main>
  );
}
