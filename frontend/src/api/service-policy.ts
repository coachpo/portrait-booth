/**
 * 服务政策（SPEC §6.0）。
 *
 * 留存时长只由服务端决定：界面上任何「30 天」都必须来自这里，
 * 硬编码的数字会在服务端改政策后变成一句谎话。
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
      cached = null; // 失败不进缓存，否则重试永远拿到同一个已拒绝的 Promise
      throw error;
    });
  return cached;
}

export function clearServicePolicyCache(): void {
  cached = null;
}

/** 把秒数说成人能读的留存时长。 */
export function formatRetention(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

export function retrievalModeLabel(mode: string): string {
  switch (mode) {
    case "key_only_ephemeral":
      return "仅凭取回码取回（KEY-only），到期即失效";
    default:
      return mode;
  }
}

export function formatMaxUpload(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
