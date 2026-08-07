import { describe, expect, it } from "vitest";

import { editorPolicy } from "./policy";
import type { Capabilities, TemplateRevision } from "./types";

function revision(caps: Capabilities): TemplateRevision {
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
    capabilities: caps,
    sourceNotes: {},
  } as unknown as TemplateRevision;
}

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

describe("editorPolicy", () => {
  it("locks compose only when crop is forbidden", () => {
    const policy = editorPolicy(revision({ ...ALL_ALLOWED, crop: "forbidden" }));
    expect(policy.composeLocked).toBe(true);
    expect(policy.composeLockReason).toContain("forbids adjusting the composition");
    // The lock reason must not say "forbidden cropping" - the output aspect is
    // fixed so cropping is inevitable; the correct semantics is locking the
    // composition
    expect(policy.composeLockReason).not.toContain("cropping");

    expect(editorPolicy(revision(ALL_ALLOWED)).composeLocked).toBe(false);
    expect(editorPolicy(revision({ ...ALL_ALLOWED, crop: "warn" })).composeLocked).toBe(false);
  });

  it("locks rotate and mirror flags from capabilities", () => {
    const policy = editorPolicy(
      revision({ ...ALL_ALLOWED, rotate: "forbidden", mirror: "forbidden" }),
    );
    expect(policy.rotateLocked).toBe(true);
    expect(policy.mirrorLocked).toBe(true);
    expect(policy.notices.map((n) => n.id)).toContain("rotate");
    expect(policy.notices.map((n) => n.id)).toContain("mirror");
  });

  it("emits distinguishable notices for retouch warn and backgroundReplace forbidden", () => {
    const policy = editorPolicy(
      revision({ ...ALL_ALLOWED, retouch: "warn", backgroundReplace: "forbidden" }),
    );
    const retouch = policy.notices.find((n) => n.id === "retouch");
    const bg = policy.notices.find((n) => n.id === "backgroundReplace");
    expect(retouch).toBeDefined();
    expect(retouch!.level).toBe("warn");
    expect(bg).toBeDefined();
    expect(bg!.level).toBe("forbidden");
    expect(retouch!.text).not.toBe(bg!.text);
  });

  it("derives source requirements from the three prerequisite fields", () => {
    const policy = editorPolicy(
      revision({
        ...ALL_ALLOWED,
        selfCapture: "not_confirmed",
        requiresOriginalCameraFile: true,
        requiresProfessionalPhotographer: true,
      }),
    );
    expect(policy.sourceRequirements.map((r) => r.id)).toEqual([
      "selfCapture",
      "requiresOriginalCameraFile",
      "requiresProfessionalPhotographer",
    ]);
    // The copy must state that this tool's artifact is a re-encoded file
    // and does not produce certified-photographer output
    expect(policy.sourceRequirements[1].text).toContain("re-encoded");
    expect(policy.sourceRequirements[2].text).toContain("certified photographer");
  });

  it("produces no notices or requirements when everything is allowed", () => {
    const policy = editorPolicy(revision(ALL_ALLOWED));
    expect(policy.notices).toEqual([]);
    expect(policy.sourceRequirements).toEqual([]);
    expect(policy.composeLocked).toBe(false);
    expect(policy.rotateLocked).toBe(false);
    expect(policy.mirrorLocked).toBe(false);
  });
});
