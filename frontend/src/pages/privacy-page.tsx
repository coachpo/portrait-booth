/**
 * Privacy and retention statement (SPEC §3.1 / §9.2).
 * Retention, retrieval method, and upload caps all come from
 * /api/v1/service-policy - these numbers are decided by the server policy
 * and must never be hard-coded on the page.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  fetchServicePolicy,
  formatMaxUpload,
  formatRetention,
  retrievalModeLabel,
  type ServicePolicy,
} from "../api/service-policy";

export function PrivacyPage() {
  const [policy, setPolicy] = useState<ServicePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchServicePolicy().then(
      (p) => {
        if (!cancelled) setPolicy(p);
      },
      () => {
        if (!cancelled)
          setError("unable to load the service policy right now; please try again later.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <section aria-label="Privacy">
      <h1>Privacy & retention</h1>

      <h2>When photos leave your device</h2>
      <p>
        Choosing a template, taking or uploading, editing, and final rendering all happen inside
        your browser; photos never leave the device. The artifact is uploaded to the server only
        when you explicitly click "Stage and generate retrieval code" on the final page.
      </p>

      <h2>Server policy</h2>
      {error && (
        <div role="alert" className="template-error">
          <p>{error}</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {!policy && !error && <p aria-live="polite">Loading service policy…</p>}
      {policy && (
        <dl className="final-details">
          <div>
            <dt>Staging retention</dt>
            <dd>
              {formatRetention(policy.temporaryStorageTtlSeconds)} (auto-deleted on expiry; no
              renewal offered)
            </dd>
          </div>
          <div>
            <dt>Retrieval method</dt>
            <dd>{retrievalModeLabel(policy.retrievalMode)}</dd>
          </div>
          <div>
            <dt>Upload cap per photo</dt>
            <dd>{formatMaxUpload(policy.maxUploadBytes)}</dd>
          </div>
          <div>
            <dt>Policy version</dt>
            <dd>{policy.policyVersion}</dd>
          </div>
        </dl>
      )}

      <h2>What you will know before staging</h2>
      <ul>
        <li>
          Upload purpose: used only to retrieve this photo with the retrieval code, nothing else.
        </li>
        <li>
          Retention: per the server policy above; the response after a successful save gives the
          authoritative expiry.
        </li>
        <li>
          Retrieval code: 6 characters, shown once in your browser; the server stores only its
          fingerprint.
        </li>
        <li>
          Delete secret: separate from the retrieval code; the only credential for proactively
          deleting this photo.
        </li>
        <li>
          A lost retrieval code cannot be recovered, nor restored via email or phone - the server
          has none of that information.
        </li>
      </ul>

      <h2>What we do not do</h2>
      <ul>
        <li>No accounts, emails, or phone numbers; no user profiling.</li>
        <li>No local persistence of photos, edit state, or face landmarks.</li>
        <li>Photos, retrieval codes, and delete secrets never enter logs, URLs, or caches.</li>
        <li>
          Pose and exposure checks are never presented as official certification - they are
          uncalibrated heuristics.
        </li>
      </ul>

      <div className="step-actions">
        <Link to="/create">Start creating a photo</Link>
        <Link to="/retrieve">Retrieve a photo with your code</Link>
      </div>
    </section>
  );
}
