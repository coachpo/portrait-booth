/**
 * save/retrieve API client (SPEC §6.2~§6.5).
 * KEY/secret only ever enter a POST body or memory; a fresh idempotency key
 * per save (reused across in-session retries).
 * The session cookie is carried automatically same-origin
 * (Path=/api/v1/saves).
 */

export interface SaveResponse {
  key: string;
  keyDisplay: string;
  deleteSecret: string;
  expiresAt: string;
  template: { id: string; version: number };
  photo: { width: number; height: number; mime: string };
}

export interface ResolveResponse {
  photo: {
    width: number | null;
    height: number | null;
    mime: string;
    byteLength?: number | null;
    expiresAt: string;
  };
  template?: { id: string; version: number };
  downloadToken: string;
  tokenExpiresAt: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function jsonOrThrow(resp: Response): Promise<unknown> {
  if (resp.status === 204) return null;
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    // A non-JSON response counts as having no body
  }
  if (!resp.ok) {
    const err = (body ?? null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      err?.error?.code ?? "UNKNOWN",
      err?.error?.message ?? `request failed (HTTP ${resp.status})`,
      resp.status,
    );
  }
  return body;
}
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createSaveSession(): Promise<void> {
  const resp = await fetch("/api/v1/save-sessions", { method: "POST" });
  await jsonOrThrow(resp);
}

export async function savePhoto(
  blob: Blob,
  templateId: string,
  templateVersion: number,
  idempotencyKey: string,
): Promise<SaveResponse> {
  const form = new FormData();
  form.append("photo", blob, "portrait.jpg");
  form.append("templateId", templateId);
  form.append("templateVersion", String(templateVersion));
  const resp = await fetch("/api/v1/saves", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: form,
  });
  return (await jsonOrThrow(resp)) as SaveResponse;
}

export async function resolvePhoto(key: string): Promise<ResolveResponse> {
  const resp = await fetch("/api/v1/retrievals/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  return (await jsonOrThrow(resp)) as ResolveResponse;
}

export async function downloadPhoto(token: string): Promise<Blob> {
  const resp = await fetch("/api/v1/retrievals/download", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    await jsonOrThrow(resp);
    throw new ApiError("UNKNOWN", "download failed", resp.status);
  }
  return resp.blob();
}

export async function deletePhoto(key: string, deleteSecret: string): Promise<void> {
  const resp = await fetch("/api/v1/saves", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, deleteSecret }),
  });
  await jsonOrThrow(resp);
}
