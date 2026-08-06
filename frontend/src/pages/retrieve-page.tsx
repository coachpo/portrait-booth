/**
 * 取回页面（SAV-007：KEY 只进 POST body，不进 URL）。
 * 输入取回码 → resolve → 照片摘要与预览 + 下载（token 只存在于内存）。
 * 删除入口也在这里：删除密钥一旦离开暂存页，别处就再也用不上了。
 */

import { useState } from "react";

import { ApiError, deletePhoto, downloadPhoto, resolvePhoto } from "../api/save";
import { formatKeyGroups, isCompleteKey, KEY_LENGTH, normalizeKeyInput } from "../lib/key";

type Stage =
  | { kind: "idle" }
  | { kind: "resolving" }
  | {
      kind: "resolved";
      photoUrl: string;
      mime: string;
      expiresAt: string;
      width: number | null;
      height: number | null;
      byteLength: number | null;
      template: { id: string; version: number } | null;
    }
  | { kind: "error"; message: string };

type DeleteStage =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "deleting" }
  | { kind: "done" }
  | { kind: "error"; message: string };

function resolveErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return "照片不可用：取回码无效、已过期或已删除。";
  }
  return err instanceof Error ? err.message : "取回失败，请重试";
}

export function RetrievePage() {
  const [key, setKey] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [deleteSecret, setDeleteSecret] = useState("");
  const [deleteStage, setDeleteStage] = useState<DeleteStage>({ kind: "idle" });

  const complete = isCompleteKey(key);

  const resolve = async () => {
    if (!complete) {
      setStage({ kind: "error", message: `取回码应为 ${KEY_LENGTH} 位字母或数字` });
      return;
    }
    // 复位删除区：它到达 done 之后没有任何其它复位路径，同一会话里取回第二张
    // 照片时删除表单会一直停在「已提交删除」，输入框与按钮都不再渲染。
    setDeleteStage({ kind: "idle" });
    setStage({ kind: "resolving" });
    try {
      const resolved = await resolvePhoto(key);
      const blob = await downloadPhoto(resolved.downloadToken);
      setStage({
        kind: "resolved",
        photoUrl: URL.createObjectURL(blob),
        mime: resolved.photo.mime,
        expiresAt: resolved.photo.expiresAt,
        width: resolved.photo.width,
        height: resolved.photo.height,
        byteLength: resolved.photo.byteLength ?? blob.size,
        template: resolved.template ?? null,
      });
    } catch (err) {
      setStage({ kind: "error", message: resolveErrorMessage(err) });
    }
  };

  const download = () => {
    if (stage.kind !== "resolved") return;
    const a = document.createElement("a");
    a.href = stage.photoUrl;
    a.download = "portrait-photo.jpg";
    a.click();
  };

  const remove = async () => {
    setDeleteStage({ kind: "deleting" });
    try {
      await deletePhoto(key, deleteSecret);
      setDeleteStage({ kind: "done" });
      // 删除后这张照片不该还能取回：清掉本地预览与 token 状态
      setStage({ kind: "idle" });
    } catch (err) {
      setDeleteStage({
        kind: "error",
        message: err instanceof Error ? err.message : "删除失败，请重试",
      });
    }
  };

  return (
    <section aria-label="取回照片">
      <h1>取回照片</h1>
      <p className="muted">
        输入暂存时生成的 {KEY_LENGTH} 位取回码；取回码只发送到服务器，不会出现在地址栏。
      </p>
      <div className="filter-row">
        <label>
          取回码
          <input
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={formatKeyGroups(key)}
            placeholder="A7C 2F9"
            aria-describedby={stage.kind === "error" ? "retrieve-error" : undefined}
            aria-invalid={stage.kind === "error" || undefined}
            onChange={(e) => setKey(normalizeKeyInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void resolve();
            }}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void resolve()}
          disabled={stage.kind === "resolving" || !complete}
        >
          {stage.kind === "resolving" ? "正在查找…" : "取回"}
        </button>
      </div>
      {stage.kind === "error" && (
        <p role="alert" id="retrieve-error" className="warn-text">
          {stage.message}
        </p>
      )}
      {stage.kind === "resolved" && (
        <div className="source-preview">
          <img src={stage.photoUrl} alt="取回的照片" />
          <dl className="final-details">
            {stage.width && stage.height && (
              <div>
                <dt>像素</dt>
                <dd>
                  {stage.width}×{stage.height}
                </dd>
              </div>
            )}
            {stage.byteLength && (
              <div>
                <dt>大小</dt>
                <dd>{(stage.byteLength / 1024).toFixed(1)} KB</dd>
              </div>
            )}
            <div>
              <dt>格式</dt>
              <dd>{stage.mime}</dd>
            </div>
            {stage.template && (
              <div>
                <dt>模板</dt>
                <dd>
                  {stage.template.id}@{stage.template.version}
                </dd>
              </div>
            )}
            <div>
              <dt>服务器到期时间</dt>
              <dd>{new Date(stage.expiresAt).toLocaleString("zh-CN")}</dd>
            </div>
          </dl>
          <p className="muted">下载凭证仅本次有效；再次取回需要重新输入取回码。</p>
          <div className="step-actions">
            <button type="button" className="primary" onClick={download}>
              下载照片
            </button>
          </div>
        </div>
      )}

      <section aria-label="删除照片">
        <h2>立即删除</h2>
        <p className="muted">
          用暂存时生成的删除密钥立即删除这张照片，不必等到期。删除后无法恢复。
        </p>
        {deleteStage.kind === "done" ? (
          <p role="status" className="muted">
            已提交删除。为不泄露照片是否存在，删除接口对任何输入都返回相同结果。
          </p>
        ) : (
          <>
            <div className="filter-row">
              <label>
                删除密钥
                <input
                  type="text"
                  autoCorrect="off"
                  spellCheck={false}
                  value={deleteSecret}
                  onChange={(e) => setDeleteSecret(e.target.value.trim())}
                />
              </label>
              {deleteStage.kind === "confirm" ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void remove()}
                    disabled={!complete || !deleteSecret}
                  >
                    确认删除
                  </button>
                  <button type="button" onClick={() => setDeleteStage({ kind: "idle" })}>
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteStage({ kind: "confirm" })}
                  disabled={!complete || !deleteSecret || deleteStage.kind === "deleting"}
                >
                  {deleteStage.kind === "deleting" ? "正在删除…" : "删除这张照片"}
                </button>
              )}
            </div>
            {deleteStage.kind === "error" && (
              <p role="alert" className="warn-text">
                {deleteStage.message}
              </p>
            )}
          </>
        )}
      </section>
    </section>
  );
}
