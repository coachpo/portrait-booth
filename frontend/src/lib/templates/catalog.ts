import type { DocumentType, SubmissionChannel, TemplateCatalog, TemplateEntry } from "./types";

const JURISDICTION_NAMES: Record<string, string> = {
  generic: "Generic (non-document)",
  US: "United States",
  FI: "Finland",
  CN: "China",
  JP: "Japan",
};

const DOCUMENT_TYPE_NAMES: Record<DocumentType, string> = {
  passport: "Passport",
  visa: "Visa",
  id: "Identity document",
  permit: "Permit",
  portrait: "Generic portrait",
};

const CHANNEL_NAMES: Record<SubmissionChannel, string> = {
  paper: "Paper submission",
  digital_upload: "Digital upload",
  certified_transfer: "Certified transfer",
  onsite_capture: "On-site capture",
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
      // A rejected Promise must not stay in the cache: otherwise, after one
      // network blip, the "retry" button keeps getting the same rejected
      // Promise and only a full page refresh can recover.
      cached = null;
      throw error;
    });
  return cached;
}

/** Clear the catalog cache. Used after an emergency takedown or an ETag
 * change when a fresh fetch is required. */
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
  return label[locale] ?? label.en ?? label.zh ?? entry.revision.revisionId;
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
