/**
 * 暂存面板（SAV-001/006）。
 * 选择暂存前必须显示上传目的、留存时长与预计到期并取得明确确认；
 * 保存成功后显示服务端权威 expiresAt、KEY 与独立删除密钥。
 */

import { useState } from "react";

import {
  createSaveSession,
  deletePhoto,
  newIdempotencyKey,
  savePhoto,
  type SaveResponse,
} from "../api/save";
import type { FinalArtifact } from "./final-artifact";
import type { TemplateEntry } from "../lib/templates/types";

export interface StagingPanelProps {
  artifact: FinalArtifact;
  template: TemplateEntry;
}

type Stage =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "uploading" }
  | { kind: "done"; saved: SaveResponse }
  | { kind: "deleting"; saved: SaveResponse }
  | { kind: "error"; message: string };

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")} ${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

export function StagingPanel({ artifact, template }: StagingPanelProps) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const upload = async () => {
    setStage({ kind: "uploading" });
    const idempotencyKey = newIdempotencyKey();
    try {
      await createSaveSession();
      const saved = await savePhoto(
        artifact.blob,
        template.revision.id,
        template.revision.version,
        idempotencyKey,
      );
      setStage({ kind: "done", saved });
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? err.message : "暂存失败，请重试" });
    }
  };

  const remove = async () => {
    if (stage.kind !== "done" && stage.kind !== "deleting") return;
    const saved = stage.saved;
    setStage({ kind: "deleting", saved });
    try {
      await deletePhoto(stage.saved.key, stage.saved.deleteSecret);
      setStage({ kind: "idle" });
    } catch (err) {
      setStage({
        kind: "error",
        message: err instanceof Error ? err.message : "删除失败，请重试",
      });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用时用户可手动复制
    }
  };

  return (
    <section aria-label="暂存照片">
      <h3>暂存以便取回</h3>
      {stage.kind === "idle" && (
        <div className="step-actions">
          <button type="button" className="primary" onClick={() => setStage({ kind: "confirm" })}>
            暂存并生成取回码
          </button>
        </div>
      )}
      {stage.kind === "confirm" && (
        <div className="confirm-box">
          <p>
            暂存会上传终态照片到服务器（仅用于取回），保存目的为照片取回，权威留存时长 30 天，
            预计到期时间为 30 天后（保存成功响应中的到期时间为权威时间）。
            取回码为 6 位字符，请妥善保存。
          </p>
          <div className="step-actions">
            <button type="button" className="primary" onClick={() => void upload()}>
              确认并上传
            </button>
            <button type="button" onClick={() => setStage({ kind: "idle" })}>
              取消
            </button>
          </div>
        </div>
      )}
      {stage.kind === "uploading" && <p aria-live="polite">正在上传并生成取回码…</p>}
      {(stage.kind === "done" || stage.kind === "deleting") && (
        <div className="confirm-box">
          <p>
            取回码（保留此页或记下取回码与删除密钥）：
          </p>
          <p className="key-display">
            {stage.saved.keyDisplay}
            <button type="button" onClick={() => void copy(stage.saved.key)}>
              复制
            </button>
          </p>
          <p className="muted">
            删除密钥：{stage.saved.deleteSecret}
            <button type="button" onClick={() => void copy(stage.saved.deleteSecret)}>
              复制
            </button>
          </p>
          <p className="muted">
            服务端到期时间：{formatExpiry(stage.saved.expiresAt)}（权威时间）
          </p>
          <div className="step-actions">
            {stage.kind === "deleting" ? (
              <button type="button" disabled>
                正在删除…
              </button>
            ) : (
              <button type="button" onClick={() => void remove()}>
                删除照片
              </button>
            )}
          </div>
        </div>
      )}
      {stage.kind === "error" && (
        <p role="alert" className="warn-text">
          {stage.message}
        </p>
      )}
    </section>
  );
}