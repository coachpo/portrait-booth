import { describe, expect, it } from "vitest";

import {
  documentTypeName,
  entryLabel,
  filterTemplates,
  isOfficialDocument,
  jurisdictionName,
  uniqueJurisdictions,
} from "./catalog";
import type { TemplateCatalog, TemplateEntry } from "./types";

function entry(
  overrides: Partial<TemplateEntry["revision"]> = {},
  publication: Partial<TemplateEntry["publication"]> = {},
): TemplateEntry {
  return {
    revision: {
      revisionId: "t@1",
      id: "t",
      version: 1,
      schemaVersion: 1,
      label: { zh: "测试模板", en: "Test template" },
      jurisdiction: "US",
      documentType: "passport",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [],
      output: {
        kind: "exact_pixels",
        widthPx: 100,
        heightPx: 100,
        aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
      },
      cropRules: [],
      captureRules: [],
      overlay: { kind: "none", ruleIds: [] },
      capabilities: {
        selfCapture: "allowed",
        crop: "allowed",
        rotate: "allowed",
        mirror: "forbidden",
        retouch: "forbidden",
        backgroundReplace: "forbidden",
        requiresOriginalCameraFile: false,
        requiresProfessionalPhotographer: false,
      },
      sourceNotes: {},
      ...overrides,
    },
    contentHash: "abc",
    publication: {
      revisionId: "t@1",
      status: "active",
      statusReason: "ok",
      owner: "o",
      reviewer: "r",
      verifiedAt: "2026-08-06",
      reviewDueAt: "2026-11-04",
      effectiveAt: "2026-08-06",
      publicationRevision: 1,
      ...publication,
    },
  };
}

const catalog: TemplateCatalog = {
  schemaVersion: 1,
  catalogVersion: "v",
  templates: [
    entry(),
    entry({
      revisionId: "generic@1",
      id: "generic",
      label: { zh: "通用肖像" },
      jurisdiction: "generic",
      documentType: "portrait",
      submissionChannel: "digital_upload",
    }),
    entry({
      revisionId: "fi@1",
      id: "fi",
      label: { zh: "芬兰证件" },
      jurisdiction: "FI",
      documentType: "id",
      submissionChannel: "certified_transfer",
    }),
    entry(
      {
        revisionId: "us-paper@1",
        id: "us-paper",
        label: { zh: "美国护照纸质" },
        jurisdiction: "US",
        documentType: "passport",
        submissionChannel: "paper",
      },
      {
        revisionId: "us-paper@1",
        status: "reference_only",
        statusReason: "未通过校准打印测试",
      },
    ),
  ],
};

describe("template catalog", () => {
  it("uniquifies jurisdictions in first-seen order", () => {
    expect(uniqueJurisdictions(catalog)).toEqual(["US", "generic", "FI"]);
  });

  it("filters by jurisdiction", () => {
    const ids = filterTemplates(catalog, { jurisdiction: "US" }).map((e) => e.revision.revisionId);
    expect(ids).toEqual(["t@1", "us-paper@1"]);
  });

  it("filters by document type", () => {
    const ids = filterTemplates(catalog, { documentType: "passport" }).map(
      (e) => e.revision.revisionId,
    );
    expect(ids).toEqual(["t@1", "us-paper@1"]);
  });

  it("filters by channel", () => {
    const ids = filterTemplates(catalog, { channel: "paper" }).map((e) => e.revision.revisionId);
    expect(ids).toEqual(["us-paper@1"]);
  });

  it("combines filters", () => {
    const ids = filterTemplates(catalog, {
      jurisdiction: "US",
      documentType: "passport",
      channel: "digital_upload",
    }).map((e) => e.revision.revisionId);
    expect(ids).toEqual(["t@1"]);
  });

  it("falls back across label locales", () => {
    expect(entryLabel(catalog.templates[0], "fr")).toBe("测试模板");
  });

  it("marks portrait templates as non-official", () => {
    const generic = catalog.templates.find((e) => e.revision.id === "generic")!;
    expect(isOfficialDocument(generic)).toBe(false);
    expect(isOfficialDocument(catalog.templates[0])).toBe(true);
  });

  it("maps display names", () => {
    expect(jurisdictionName("US")).toBe("美国");
    expect(jurisdictionName("XY")).toBe("XY");
    expect(documentTypeName("visa")).toBe("签证");
  });
});
