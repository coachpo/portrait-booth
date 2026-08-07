/**
 * Retrieve page (SAV-007: the KEY only ever enters a POST body, never a
 * URL). Enter the retrieval code → resolve → photo summary and preview +
 * download (the token exists only in memory).
 * The delete entry also lives here: once the delete secret leaves the
 * staging page, nowhere else can use it.
 */

import { useEffect, useState } from "react";

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
    return "photo unavailable: the retrieval code is invalid, expired, or the photo was deleted.";
  }
  return err instanceof Error ? err.message : "retrieval failed, please retry";
}

export function RetrievePage() {
  const [key, setKey] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [deleteSecret, setDeleteSecret] = useState("");
  const [deleteStage, setDeleteStage] = useState<DeleteStage>({ kind: "idle" });

  // The single blob URL release point: on URL overwrite, delete/failure back
  // to idle, and unmount, the effect cleanup revokes - no scattered revoke
  // calls
  const previewUrl = stage.kind === "resolved" ? stage.photoUrl : null;
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const complete = isCompleteKey(key);

  const resolve = async () => {
    if (!complete) {
      setStage({
        kind: "error",
        message: `the retrieval code must be ${KEY_LENGTH} letters or digits`,
      });
      return;
    }
    // Reset the delete section: after done it has no other reset path, so
    // retrieving a second photo in the same session would leave the delete
    // form stuck at "delete submitted" with no inputs or buttons rendered.
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
      // After deletion this photo must not be retrievable: go back to idle;
      // the preview URL is revoked by the effect above
      setStage({ kind: "idle" });
    } catch (err) {
      setDeleteStage({
        kind: "error",
        message: err instanceof Error ? err.message : "delete failed, please retry",
      });
    }
  };

  return (
    <section aria-label="Retrieve photo">
      <h1>Retrieve photo</h1>
      <p className="muted">
        Enter the {KEY_LENGTH}-character code generated when staging; the code is sent only to the
        server and never appears in the address bar.
      </p>
      <div className="filter-row">
        <label>
          Retrieval code
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
          {stage.kind === "resolving" ? "Looking up…" : "Retrieve"}
        </button>
      </div>
      {stage.kind === "error" && (
        <p role="alert" id="retrieve-error" className="warn-text">
          {stage.message}
        </p>
      )}
      {stage.kind === "resolved" && (
        <div className="source-preview">
          <img src={stage.photoUrl} alt="Retrieved photo" />
          <dl className="final-details">
            {stage.width && stage.height && (
              <div>
                <dt>Pixels</dt>
                <dd>
                  {stage.width}×{stage.height}
                </dd>
              </div>
            )}
            {stage.byteLength && (
              <div>
                <dt>Size</dt>
                <dd>{(stage.byteLength / 1024).toFixed(1)} KB</dd>
              </div>
            )}
            <div>
              <dt>Format</dt>
              <dd>{stage.mime}</dd>
            </div>
            {stage.template && (
              <div>
                <dt>Template</dt>
                <dd>
                  {stage.template.id}@{stage.template.version}
                </dd>
              </div>
            )}
            <div>
              <dt>Server expiry time</dt>
              <dd>{new Date(stage.expiresAt).toLocaleString("en-US")}</dd>
            </div>
          </dl>
          <p className="muted">
            The download credential is valid only for this fetch; retrieving again requires
            re-entering the code.
          </p>
          <div className="step-actions">
            <button type="button" className="primary" onClick={download}>
              Download photo
            </button>
          </div>
        </div>
      )}

      <section aria-label="Delete photo">
        <h2>Delete now</h2>
        <p className="muted">
          Use the delete secret from staging to delete this photo immediately, without waiting for
          expiry. Deletion cannot be undone.
        </p>
        {deleteStage.kind === "done" ? (
          <p role="status" className="muted">
            Delete submitted. To avoid leaking whether a photo exists, the delete endpoint returns
            the same result for any input.
          </p>
        ) : (
          <>
            <div className="filter-row">
              <label>
                Delete secret
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
                    Confirm delete
                  </button>
                  <button type="button" onClick={() => setDeleteStage({ kind: "idle" })}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteStage({ kind: "confirm" })}
                  disabled={!complete || !deleteSecret || deleteStage.kind === "deleting"}
                >
                  {deleteStage.kind === "deleting" ? "Deleting…" : "Delete this photo"}
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
