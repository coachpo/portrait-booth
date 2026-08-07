/**
 * Staging panel (SAV-001/006/§11).
 * Before staging, the upload purpose, retention duration, and expected
 * expiry must be shown and explicitly confirmed; after a successful save the
 * server-authoritative expiresAt, KEY, and the separate delete secret are
 * displayed.
 */

import { useEffect, useRef, useState } from "react";

import {
  ApiError,
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

export interface StagedReceipt {
  saved: SaveResponse;
  idempotencyKey: string;
}

export interface StagingPanelProps {
  artifact: FinalArtifact;
  template: TemplateEntry;
  /** Staged receipt: when non-null the panel goes straight back to the done
   * state without a second upload */
  staged: StagedReceipt | null;
  /** Whether the receipt's photo no longer matches the artifact on screen */
  stagedStale: boolean;
  onStaged: (receipt: StagedReceipt | null) => void;
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

/** Delete receipt: the only carrier that still recovers the delete right
 * after a page refresh */
// Exported from the same file as the component for CreatePage to reuse
// (ticket convention: no new module); the react-refresh warning about
// exporting utility functions from a component file is an intentional
// exception here
// eslint-disable-next-line react-refresh/only-export-components
export function receiptText(saved: SaveResponse): string {
  return [
    "Portrait Booth staging receipt",
    "",
    `Retrieval code: ${saved.keyDisplay}`,
    `Delete secret: ${saved.deleteSecret}`,
    `Server expiry time: ${saved.expiresAt}`,
    `Template: ${saved.template.id}@${saved.template.version}`,
    "",
    "The retrieval code retrieves the photo; the delete secret deletes it early.",
    "Neither can be recovered; keep this file safe.",
  ].join("\n");
}

// eslint-disable-next-line react-refresh/only-export-components
export function downloadReceipt(saved: SaveResponse): void {
  const blob = new Blob([receiptText(saved)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "portrait-booth-receipt.txt";
  a.click();
  URL.revokeObjectURL(url);
}

export function StagingPanel({
  artifact,
  template,
  staged,
  stagedStale,
  onStaged,
}: StagingPanelProps) {
  const [stage, setStage] = useState<Stage>(
    staged ? { kind: "done", saved: staged.saved } : { kind: "idle" },
  );
  const [policy, setPolicy] = useState<ServicePolicy | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // SPEC §11's "same idempotency key retry": the key must stay constant
  // across retries; creating a new key per click would always look like a
  // brand-new save to the server.
  const idempotencyKeyRef = useRef<string | null>(staged?.idempotencyKey ?? null);
  // The session cookie is carried automatically same-origin; once created it
  // is never recreated, so retries land in the same namespace
  const sessionReadyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchServicePolicy().then(
      (p) => {
        if (!cancelled) setPolicy(p);
      },
      () => {
        // An unreadable policy must not block the flow, but the UI has to say
        // "loading" instead of inventing a number
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // A different artifact is a different save; the old idempotency key must
  // not be reused. The previous-id guard prevents each mount (back to edit
  // and return) from clearing the key just restored from props
  const prevArtifactIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevArtifactIdRef.current !== null && prevArtifactIdRef.current !== artifact.artifactId) {
      idempotencyKeyRef.current = null;
    }
    prevArtifactIdRef.current = artifact.artifactId;
  }, [artifact.artifactId]);

  const ensureSaveSession = async (): Promise<void> => {
    if (sessionReadyRef.current) return;
    await createSaveSession();
    sessionReadyRef.current = true;
  };

  const upload = async () => {
    setStage({ kind: "uploading" });
    idempotencyKeyRef.current ??= newIdempotencyKey();
    // At most one resend: only on session expiry (SESSION_REQUIRED) does it
    // retry with a new session and new key; all other errors go back to the
    // error state for the user to decide.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ensureSaveSession();
        const saved = await savePhoto(
          artifact.blob,
          template.revision.id,
          template.revision.version,
          idempotencyKeyRef.current,
        );
        setStage({ kind: "done", saved });
        onStaged({ saved, idempotencyKey: idempotencyKeyRef.current });
        return;
      } catch (err) {
        const sessionExpired = err instanceof ApiError && err.code === "SESSION_REQUIRED";
        if (!sessionExpired || attempt === 1) {
          setStage({
            kind: "error",
            message: err instanceof Error ? err.message : "staging failed, please retry",
          });
          return;
        }
        // The old session and its idempotency namespace are gone: reusing
        // the old key would neither hit the replay nor help debugging
        sessionReadyRef.current = false;
        idempotencyKeyRef.current = newIdempotencyKey();
      }
    }
  };

  const remove = async () => {
    if (stage.kind !== "done" && stage.kind !== "deleting") return;
    const saved = stage.saved;
    setDeleteError(null);
    setStage({ kind: "deleting", saved });
    try {
      await deletePhoto(saved.key, saved.deleteSecret);
      idempotencyKeyRef.current = null;
      onStaged(null);
      setStage({ kind: "idle" });
    } catch (err) {
      // A delete failure must stay inside the done panel, never switch to the
      // upload error state: that would take the retrieval code, delete
      // secret, and receipt download with it, and the error state's only
      // primary button is "retry with the same idempotency key" - which runs
      // upload(): with an unexpired session the server hits the completed
      // record and replays the original envelope, handing the user a
      // retrieval code pointing at a deleted photo.
      setDeleteError(err instanceof Error ? err.message : "delete failed, please retry");
      setStage({ kind: "done", saved });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // When the clipboard is unavailable the user can copy manually
    }
  };
  /** The real mobile path to the artifact: <a download> often just opens a
   * new tab on iOS */
  const canShare = (): boolean => {
    if (typeof navigator === "undefined" || !navigator.canShare || !navigator.share) return false;
    return navigator.canShare({ files: [new File([], "p.jpg", { type: "image/jpeg" })] });
  };

  const share = async () => {
    setShareError(null);
    const file = new File([artifact.blob], "portrait-photo.jpg", { type: "image/jpeg" });
    try {
      await navigator.share({ files: [file], title: "Document photo" });
    } catch (err) {
      // User cancellation is not an error
      if (err instanceof DOMException && err.name === "AbortError") return;
      setShareError('Share did not complete; you can use "Download" to save locally instead.');
    }
  };

  return (
    <section aria-label="Stage photo">
      <h3>Stage for retrieval</h3>

      {(stage.kind === "idle" || stage.kind === "error") && canShare() && (
        <div className="step-actions">
          <button type="button" onClick={() => void share()}>
            Share or save to photos
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
            Stage and generate retrieval code
          </button>
        </div>
      )}
      {stage.kind === "confirm" && (
        <div className="confirm-box">
          {/* §9.2: every item must be disclosed before saving. Retention comes
          from the server policy, never hard-coded in the UI */}
          <p>Staging uploads this final photo to the server. Please confirm before uploading:</p>
          <ul>
            <li>
              Purpose: used only to retrieve this photo with the retrieval code, nothing else.
            </li>
            <li>
              Retention: {policy ? formatRetention(policy.temporaryStorageTtlSeconds) : "loading…"}
              (auto-deleted on expiry; no renewal offered). The expiry returned after a successful
              save is authoritative.
            </li>
            <li>
              Retrieval method: {policy ? retrievalModeLabel(policy.retrievalMode) : "loading…"}.
            </li>
            <li>
              The retrieval code is 6 characters, shown once on this device; it cannot be recovered
              if lost.
            </li>
            <li>
              The delete secret is separate from the retrieval code and is the only credential for
              proactively deleting this photo.
            </li>
          </ul>
          <div className="step-actions">
            <button type="button" className="primary" onClick={() => void upload()}>
              Confirm and upload
            </button>
            <button type="button" onClick={() => setStage({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {stage.kind === "uploading" && (
        <p aria-live="polite">Uploading and generating retrieval code…</p>
      )}
      {(stage.kind === "done" || stage.kind === "deleting") && (
        <div className="confirm-box">
          {stagedStale && (
            <p role="alert" className="warn-text">
              This retrieval code belongs to the photo staged last time; the photo on screen has
              changed and is not staged. To stage the new one, first "delete photo".
            </p>
          )}
          <p>Retrieval code (keep this page open or note the code and delete secret):</p>
          <p className="key-display">
            {stage.saved.keyDisplay}
            <button type="button" onClick={() => void copy(stage.saved.key)}>
              Copy
            </button>
          </p>
          <p className="muted">
            Delete secret: {stage.saved.deleteSecret}
            <button type="button" onClick={() => void copy(stage.saved.deleteSecret)}>
              Copy
            </button>
          </p>
          <p className="muted">
            Server expiry time: {formatExpiry(stage.saved.expiresAt)} (authoritative)
          </p>
          <div className="step-actions">
            <button type="button" onClick={() => downloadReceipt(stage.saved)}>
              Download receipt (with retrieval code and delete secret)
            </button>
            {stage.kind === "deleting" ? (
              <button type="button" disabled>
                Deleting…
              </button>
            ) : (
              <button type="button" onClick={() => void remove()}>
                {deleteError ? "Retry delete" : "Delete photo"}
              </button>
            )}
          </div>
          {deleteError && (
            <p role="alert" className="warn-text">
              {deleteError} (the retrieval code and delete secret are still valid; you can retry
              directly)
            </p>
          )}
        </div>
      )}
      {stage.kind === "error" && (
        <>
          <p role="alert" className="warn-text">
            {stage.message}
          </p>
          <div className="step-actions">
            {/* Retry with the same session and idempotency key: with an
            unexpired session the server hits the completed record and
            replays the original response without a new photo; with an
            expired session upload() creates a new session and key and
            resends once */}
            <button type="button" className="primary" onClick={() => void upload()}>
              Retry with the same idempotency key
            </button>
            <button type="button" onClick={() => setStage({ kind: "idle" })}>
              Back
            </button>
          </div>
        </>
      )}
    </section>
  );
}
