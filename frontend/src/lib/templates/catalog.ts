import type { DocumentType, SubmissionChannel, TemplateCatalog, TemplateEntry } from "./types";

const JURISDICTION_NAMES: Record<string, string> = {
  generic: "通用（非证件）",
  US: "美国",
  FI: "芬兰",
  CN: "中国",
  JP: "日本",
};

const DOCUMENT_TYPE_NAMES: Record<DocumentType, string> = {
  passport: "护照",
  visa: "签证",
  id: "身份证件",
  permit: "许可",
  portrait: "通用肖像",
};

const CHANNEL_NAMES: Record<SubmissionChannel, string> = {
  paper: "纸质提交",
  digital_upload: "数字上传",
  certified_transfer: "认证传输",
  onsite_capture: "现场拍摄",
};

let cached: Promise<TemplateCatalog> | null = null;

export function fetchTemplateCatalog(): Promise<TemplateCatalog> {
  cached ??= fetch("/api/v1/templates", { headers: { Accept: "application/json" } })
    .then((resp) => {
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return resp.json() as Promise<TemplateCatalog>;
    })
    .catch((error: unknown) => {
      // 被拒绝的 Promise 不能留在缓存里：否则一次网络抖动后，
      // 「重试」按钮会永远拿到同一个已拒绝的 Promise，只能刷新整页才能恢复。
      cached = null;
      throw error;
    });
  return cached;
}

/** 清空目录缓存。紧急停用或 ETag 变化后需要重新拉取时使用。 */
export function clearTemplateCatalogCache(): void {
  cached = null;
}

export function jurisdictionName(code: string): string {
  return JURISDICTION_NAMES[code] ?? code;
}

export function documentTypeName(type: DocumentType): string {
  return DOCUMENT_TYPE_NAMES[type] ?? type;
}

export function channelName(channel: SubmissionChannel): string {
  return CHANNEL_NAMES[channel] ?? channel;
}

export function entryLabel(entry: TemplateEntry, locale: string): string {
  const label = entry.revision.label;
  return label[locale] ?? label.zh ?? label.en ?? entry.revision.revisionId;
}

export function uniqueJurisdictions(catalog: TemplateCatalog): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of catalog.templates) {
    const code = entry.revision.jurisdiction;
    if (!seen.has(code)) {
      seen.add(code);
      result.push(code);
    }
  }
  return result;
}

export interface TemplateFilters {
  jurisdiction?: string;
  documentType?: DocumentType;
  channel?: SubmissionChannel;
}

export function filterTemplates(
  catalog: TemplateCatalog,
  filters: TemplateFilters,
): TemplateEntry[] {
  return catalog.templates.filter((entry) => {
    const rev = entry.revision;
    if (filters.jurisdiction && rev.jurisdiction !== filters.jurisdiction) return false;
    if (filters.documentType && rev.documentType !== filters.documentType) return false;
    if (filters.channel && rev.submissionChannel !== filters.channel) return false;
    return true;
  });
}

export function isOfficialDocument(entry: TemplateEntry): boolean {
  return entry.revision.documentType !== "portrait";
}
