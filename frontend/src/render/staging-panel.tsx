/**
 * 暂存面板（SAV-001/006/§11）。
 * 选择暂存前必须显示上传目的、留存时长与预计到期并取得明确确认；
 * 保存成功后显示服务端权威 expiresAt、KEY 与独立删除密钥。
 */

import { useEffect, useRef, useState } from "react";

import {
  createSaveSession,
  deletePhoto,
  newIdempotencyKey,
  savePhoto,
  type SaveResponse,
} from "../api/save";
import {
  fetchServicePolicy,
  formatRetention,
  retrievalModeLabel,
  type ServicePolicy,
} from "../api/service-policy";
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

/** 删除回执：刷新页面后仍能找回删除权的唯一载体 */
function receiptText(saved: SaveResponse): string {
  return [
    "Portrait Booth 暂存回执",
    "",
    `取回码：${saved.keyDisplay}`,
    `删除密钥：${saved.deleteSecret}`,
    `服务端到期时间：${saved.expiresAt}`,
    `模板：${saved.template.id}@${saved.template.version}`,
    "",
    "取回码用于取回照片，删除密钥用于提前删除。",
    "两者都无法找回，请妥善保存本文件。",
  ].join("\n");
}

export function StagingPanel({ artifact, template }: StagingPanelProps) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [policy, setPolicy] = useState<ServicePolicy | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  // SPEC §11 的「同一幂等键重试」：键必须跨重试保持不变，
  // 每次点击都新建一个键的话，服务端看到的永远是一次全新的保存。
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchServicePolicy().then(
      (p) => {
        if (!cancelled) setPolicy(p);
      },
      () => {
        // 政策读不到时不阻断流程，但界面必须显示「读取中」而不是编一个数字
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // 换了一张成品就是另一次保存，旧的幂等键不能再用
  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [artifact.artifactId]);

  const upload = async () => {
    setStage({ kind: "uploading" });
    idempotencyKeyRef.current ??= newIdempotencyKey();
    try {
      await createSaveSession();
      const saved = await savePhoto(
        artifact.blob,
        template.revision.id,
        template.revision.version,
        idempotencyKeyRef.current,
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
      await deletePhoto(saved.key, saved.deleteSecret);
      idempotencyKeyRef.current = null;
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

  const downloadReceipt = (saved: SaveResponse) => {
    const blob = new Blob([receiptText(saved)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "portrait-booth-回执.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  /** 移动端拿到成品的实际路径：<a download> 在 iOS 上常常只是打开新标签页 */
  const canShare = (): boolean => {
    if (typeof navigator === "undefined" || !navigator.canShare || !navigator.share) return false;
    return navigator.canShare({ files: [new File([], "p.jpg", { type: "image/jpeg" })] });
  };

  const share = async () => {
    setShareError(null);
    const file = new File([artifact.blob], "portrait-photo.jpg", { type: "image/jpeg" });
    try {
      await navigator.share({ files: [file], title: "证件照片" });
    } catch (err) {
      // 用户取消不是错误
      if (err instanceof DOMException && err.name === "AbortError") return;
      setShareError("分享未完成：可改用「下载」保存到本地。");
    }
  };

  return (
    <section aria-label="暂存照片">
      <h3>暂存以便取回</h3>

      {(stage.kind === "idle" || stage.kind === "error") && canShare() && (
        <div className="step-actions">
          <button type="button" onClick={() => void share()}>
            分享或保存到相册
          </button>
        </div>
      )}
      {shareError && (
        <p role="alert" className="warn-text">
          {shareError}
        </p>
      )}

      {stage.kind === "idle" && (
        <div className="step-actions">
          <button type="button" className="primary" onClick={() => setStage({ kind: "confirm" })}>
            暂存并生成取回码
          </button>
        </div>
      )}
      {stage.kind === "confirm" && (
        <div className="confirm-box">
          {/* §9.2：保存前必须逐项告知。留存时长来自服务端政策，不写死在界面上 */}
          <p>暂存会把这张终态照片上传到服务器。上传前请确认：</p>
          <ul>
            <li>用途：仅用于凭取回码取回这张照片，不做其他用途。</li>
            <li>
              留存时长：
              {policy ? formatRetention(policy.temporaryStorageTtlSeconds) : "读取中…"}
              （到期自动删除，不提供续期）。保存成功后返回的到期时间为权威时间。
            </li>
            <li>取回方式：{policy ? retrievalModeLabel(policy.retrievalMode) : "读取中…"}。</li>
            <li>取回码为 6 位字符，只在这台设备上显示一次；遗失后无法找回。</li>
            <li>删除密钥与取回码分开，是你主动删除这张照片的唯一凭证。</li>
          </ul>
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
          <p>取回码（保留此页或记下取回码与删除密钥）：</p>
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
          <p className="muted">服务端到期时间：{formatExpiry(stage.saved.expiresAt)}（权威时间）</p>
          <div className="step-actions">
            <button type="button" onClick={() => downloadReceipt(stage.saved)}>
              下载回执（含取回码与删除密钥）
            </button>
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
        <>
          <p role="alert" className="warn-text">
            {stage.message}
          </p>
          <div className="step-actions">
            {/* 复用同一个幂等键重试：服务端据此识别这是同一次保存，不会产生第二张照片 */}
            <button type="button" className="primary" onClick={() => void upload()}>
              用同一幂等键重试
            </button>
            <button type="button" onClick={() => setStage({ kind: "idle" })}>
              返回
            </button>
          </div>
        </>
      )}
    </section>
  );
}
