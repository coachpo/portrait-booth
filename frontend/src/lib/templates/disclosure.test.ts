import { describe, expect, it } from "vitest";

import { capabilityRestrictions, sourceNotesFor } from "./disclosure";
import type { Capabilities, TemplateRevision } from "./types";

const ALL_ALLOWED: Capabilities = {
  selfCapture: "allowed",
  crop: "allowed",
  rotate: "allowed",
  mirror: "allowed",
  retouch: "allowed",
  backgroundReplace: "allowed",
  requiresOriginalCameraFile: false,
  requiresProfessionalPhotographer: false,
};

function revision(overrides: Partial<TemplateRevision> = {}): TemplateRevision {
  return {
    revisionId: "t@1",
    id: "t",
    version: 1,
    schemaVersion: 1,
    label: { en: "test" },
    jurisdiction: "XX",
    documentType: "id",
    submissionChannel: "digital_upload",
    applicantClass: "adult",
    sources: [],
    output: {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 600,
      aspect: { width: 600, height: 600, enforcement: "mandatory", provenance: "derived" },
    },
    cropRules: [],
    captureRules: [],
    overlay: { kind: "none", ruleIds: [] },
    capabilities: ALL_ALLOWED,
    sourceNotes: {},
    ...overrides,
  } as unknown as TemplateRevision;
}

describe("capabilityRestrictions", () => {
  it("produces nothing when every field is allowed/false", () => {
    expect(capabilityRestrictions(ALL_ALLOWED)).toEqual([]);
  });

  it("distinguishes warn from forbidden wording", () => {
    const warn = capabilityRestrictions({ ...ALL_ALLOWED, mirror: "warn" });
    const forbidden = capabilityRestrictions({ ...ALL_ALLOWED, mirror: "forbidden" });
    expect(warn).toHaveLength(1);
    expect(forbidden).toHaveLength(1);
    expect(warn[0].level).toBe("warn");
    expect(forbidden[0].level).toBe("forbidden");
    // Wording must differ: warn is "not officially endorsed", forbidden is
    // "prohibited"
    expect(warn[0].text).not.toBe(forbidden[0].text);
    expect(forbidden[0].text).toContain("forbids");
  });

  it("covers the three prerequisite fields", () => {
    const out = capabilityRestrictions({
      ...ALL_ALLOWED,
      selfCapture: "not_confirmed",
      requiresOriginalCameraFile: true,
      requiresProfessionalPhotographer: true,
    });
    expect(out.map((r) => r.id)).toEqual([
      "selfCapture",
      "requiresOriginalCameraFile",
      "requiresProfessionalPhotographer",
    ]);
  });
});

describe("sourceNotesFor", () => {
  it("returns all entries of the requested locale without merging", () => {
    const rev = revision({
      sourceNotes: { en: ["one", "two", "three"] },
    });
    expect(sourceNotesFor(rev, "en")).toEqual(["one", "two", "three"]);
  });

  it("falls back en → zh → first key", () => {
    expect(sourceNotesFor(revision({ sourceNotes: { en: ["e"] } }), "fr")).toEqual(["e"]);
    expect(sourceNotesFor(revision({ sourceNotes: { ja: ["j"] } }), "zh")).toEqual(["j"]);
  });

  it("tolerates undefined, empty, and missing locales", () => {
    expect(sourceNotesFor(revision(), "en")).toEqual([]);
    expect(sourceNotesFor(revision({ sourceNotes: {} }), "en")).toEqual([]);
    expect(sourceNotesFor(revision({ sourceNotes: { ja: [] } }), "en")).toEqual([]);
  });
});
