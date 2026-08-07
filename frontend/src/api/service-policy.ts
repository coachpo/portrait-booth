/**
 * Service policy (SPEC §6.0).
 *
 * Retention is decided solely by the server: any "30 days" on the UI must
 * come from here; a hard-coded number becomes a lie once the server policy
 * changes.
 */

export interface ServicePolicy {
  temporaryStorageTtlSeconds: number;
  retrievalMode: string;
  maxUploadBytes: number;
  policyVersion: number;
}

let cached: Promise<ServicePolicy> | null = null;

export function fetchServicePolicy(): Promise<ServicePolicy> {
  cached ??= fetch("/api/v1/service-policy", { headers: { Accept: "application/json" } })
    .then((resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json() as Promise<ServicePolicy>;
    })
    .catch((error: unknown) => {
      cached = null; // failures are not cached, or retries would always get the same rejected Promise
      throw error;
    });
  return cached;
}

export function clearServicePolicyCache(): void {
  cached = null;
}

/** Human-readable retention for a second count. */
export function formatRetention(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export function retrievalModeLabel(mode: string): string {
  switch (mode) {
    case "key_only_ephemeral":
      return "retrieval by retrieval code only (KEY-only), invalid at expiry";
    default:
      return mode;
  }
}

export function formatMaxUpload(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
