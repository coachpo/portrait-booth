/**
 * 取回页面（SAV-007：KEY 只进 POST body，不进 URL）。
 * 输入取回码 → resolve → 照片预览 + 下载（token 只存在于内存）。
 */

import { useState } from "react";

import { ApiError, downloadPhoto, resolvePhoto } from "../api/save";

type Stage =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "resolved"; photoUrl: string; mime: string; expiresAt: string; token: string }
  | { kind: "error"; message: string };

export function RetrievePage() {
  const [keyInput, setKeyInput] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const resolve = async () => {
    const key = keyInput.replace(/[\s-]/g, "").toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(key)) {
      setStage({ kind: "error", message: "取回码应为 6 位字母或数字" });
      return;
    }
    setStage({ kind: "resolving" });
    try {
      const resolved = await resolvePhoto(key);
      const blob = await downloadPhoto(resolved.downloadToken);
      const photoUrl = URL.createObjectURL(blob);
      setStage({
        kind: "resolved",
        photoUrl,
        mime: resolved.photo.mime,
        expiresAt: resolved.photo.expiresAt,
        token: resolved.downloadToken,
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 404
          ? "照片不可用：取回码无效、已过期或已删除。"
          : err instanceof Error
            ? err.message
            : "取回失败，请重试";
      setStage({ kind: "error", message });
    }
  };

  const download = () => {
    if (stage.kind !== "resolved") return;
    const a = document.createElement("a");
    a.href = stage.photoUrl;
    a.download = "portrait-photo.jpg";
    a.click();
  };

  return (
    <main className="container">
      <h1>取回照片</h1>
      <p className="muted">输入暂存时生成的 6 位取回码；取回码只发送到服务器，不会出现在地址栏。</p>
      <div className="filter-row">
        <label>
          取回码
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={keyInput}
            placeholder="A7C 2F9"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void resolve();
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void resolve()}
          disabled={stage.kind === "resolving"}
        >
          {stage.kind === "resolving" ? "正在查找…" : "取回"}
        </button>
      </div>
      {stage.kind === "error" && (
        <p role="alert" className="warn-text">
          {stage.message}
        </p>
      )}
      {stage.kind === "resolved" && (
        <div className="source-preview">
          <img src={stage.photoUrl} alt="取回的照片" />
          <p className="muted">
            服务器权威到期时间：{new Date(stage.expiresAt).toLocaleString("zh-CN")} ·
            下载仅本次有效
          </p>
          <div className="step-actions">
            <button type="button" className="primary" onClick={download}>
              下载照片
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
