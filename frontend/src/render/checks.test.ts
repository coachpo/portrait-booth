import { describe, expect, it } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import type { StaticCheckResult } from "../pose/static-check";
import type { FinalArtifact } from "./final-artifact";
import { HEURISTIC_NOTICE, buildChecks } from "./checks";

function jpegBytes(density: number, exif = false): Uint8Array {
  const app0 = [
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    1,
    (density >> 8) & 0xff,
    density & 0xff,
    (density >> 8) & 0xff,
    density & 0xff,
    0,
    0,
  ];
  const seg = (marker: number, payload: number[]): number[] => [
    0xff,
    marker,
    ((payload.length + 2) >> 8) & 0xff,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const parts: number[] = [0xff, 0xd8];
  parts.push(...seg(0xe0, app0));
  if (exif) parts.push(...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0, 0, 0, 0, 0, 0]));
  parts.push(...seg(0xc0, [8, 0x01, 0x90, 0x01, 0x40, 1, 0x11, 0x00, 0x00, 0x00]));
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function template(
  overrides: Partial<TemplateEntry["revision"]> = {},
  publication: Partial<TemplateEntry["publication"]> = {},
): TemplateEntry {
  return {
    revision: {
      revisionId: "fi@1",
      id: "fi",
      version: 1,
      schemaVersion: 1,
      label: { en: "Finnish police document" },
      jurisdiction: "FI",
      documentType: "id",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [],
      output: {
        kind: "exact_pixels",
        widthPx: 500,
        heightPx: 653,
        aspect: { width: 500, height: 653, enforcement: "mandatory", provenance: "derived" },
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
      revisionId: "fi@1",
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

function artifact(
  density: number,
  exif = false,
  size = 60,
  coverage: FinalArtifact["coverage"] = { scannedPixels: 500 * 653, transparentPixels: 0 },
  matrix: FinalArtifact["manifest"]["matrix"] = [1, 0, 0, 1, 0, 0],
): FinalArtifact {
  const bytes = jpegBytes(density, exif);
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return {
    artifactId: "a1",
    blob: new Blob([out], { type: "image/jpeg" }),
    coverage,
    manifest: {
      schemaVersion: 1,
      templateId: "fi",
      templateVersion: 1,
      widthPx: 500,
      heightPx: 653,
      mime: "image/jpeg",
      orientationNormalized: true,
      matrix,
      flipX: false,
    },
  };
}

async function statuses(
  entry: TemplateEntry,
  a: FinalArtifact = artifact(96),
  staticChecks?: StaticCheckResult | null,
): Promise<Record<string, string>> {
  const checks = await buildChecks(a, entry, staticChecks);
  return Object.fromEntries(checks.map((c) => [c.id, c.status]));
}

function poseState(overrides: Partial<StaticCheckResult["pose"] & object> = {}) {
  return {
    status: "ready" as const,
    angles: { yaw: 0, pitch: 0, roll: 0 },
    faceWidthRatio: 0.3,
    faceOffset: { x: 0, y: 0 },
    stableMs: 900,
    shootable: true,
    guidanceHints: [],
    ...overrides,
  };
}

function staticCheckResult(overrides: Partial<StaticCheckResult> = {}): StaticCheckResult {
  return {
    poseAvailable: true,
    pose: poseState(),
    quality: {
      status: "warn",
      issues: ["exposure and sharpness show no obvious issues (heuristic, for reference only)"],
      metrics: {
        darkClipRatio: 0,
        brightClipRatio: 0,
        sharpness: 120,
        background: { lumaStd: 5, blockRange: 8, leftRightDiff: 3, topBottomDiff: 4 },
      },
    },
    faceGeometry: { eyesClosed: false, mouthOpen: false },
    ...overrides,
  };
}

describe("buildChecks", () => {
  it("reports pass for a clean exact-pixel render", async () => {
    const s = await statuses(template());
    expect(s["exact-pixels"]).toBe("pass");
    expect(s["format"]).toBe("pass");
    expect(s["metadata"]).toBe("pass");
    expect(s["no-alpha"]).toBe("pass");
    expect(s["source-resolution"]).toBe("pass");
    // Only when no recheck ran is it unknown
    expect(s["pose"]).toBe("unknown");
    expect(s["exposure"]).toBe("unknown");
  });

  it("marks reference_only templates as warn (TMP-003)", async () => {
    const t = template(
      {},
      { status: "reference_only", statusReason: "not verified by calibrated print tests" },
    );
    const s = await statuses(t);
    expect(s["publication"]).toBe("warn");
  });

  it("passes the file-size check when within the limit", async () => {
    const t = template({
      outputFile: {
        mime: ["image/jpeg"],
        sizeLimit: { maxBytes: 5000, sourceLiteral: "5 KB", normalization: "source_exact" },
      },
    });
    const s = await statuses(t, artifact(96, false, 4000));
    expect(s["file-size"]).toBe("pass");
  });

  it("fails the file-size check when over the limit", async () => {
    const t = template({
      outputFile: {
        mime: ["image/jpeg"],
        sizeLimit: { maxBytes: 50, sourceLiteral: "50 B", normalization: "source_exact" },
      },
    });
    const s = await statuses(t); // blob ~60 bytes > 50
    expect(s["file-size"]).toBe("fail");
  });

  it("verifies PPI for physical-raster templates (OUT-006)", async () => {
    const t = template({
      output: {
        kind: "physical_raster",
        widthMm: 35,
        heightMm: 45,
        printPpi: 300,
        rounding: "nearest",
        widthPx: 413,
        heightPx: 531,
        pixelDerivation: "round(mm / 25.4 * printPpi)",
        ppiProvenance: "source_literal",
        calibrationProfileId: "none",
      },
    });
    expect((await statuses(t, artifact(300)))["print-density"]).toBe("pass");
    expect((await statuses(t, artifact(96)))["print-density"]).toBe("fail");
  });

  it("qualifies a passing density as uncalibrated when PPI is not portal_verified (P5)", async () => {
    const t = template({
      output: {
        kind: "physical_raster",
        widthMm: 35,
        heightMm: 45,
        printPpi: 300,
        rounding: "nearest",
        widthPx: 413,
        heightPx: 531,
        pixelDerivation: "round(mm / 25.4 * printPpi)",
        ppiProvenance: "derived",
        calibrationProfileId: "none",
      },
    });
    const checks = await buildChecks(artifact(300), t);
    const item = checks.find((c) => c.id === "print-density");
    expect(item!.status).toBe("pass");
    expect(item!.detail).toMatch(/derived|not verified/);
  });

  it("appends the calibration confirmation only when print-ready (P5)", async () => {
    const t = template(
      {
        output: {
          kind: "physical_raster",
          widthMm: 35,
          heightMm: 45,
          printPpi: 300,
          rounding: "nearest",
          widthPx: 413,
          heightPx: 531,
          pixelDerivation: "round(mm / 25.4 * printPpi)",
          ppiProvenance: "portal_verified",
          calibrationProfileId: "none",
        },
      },
      { status: "active" },
    );
    const checks = await buildChecks(artifact(300), t);
    const item = checks.find((c) => c.id === "print-density");
    expect(item!.status).toBe("pass");
    expect(item!.detail).toContain("verified by calibrated print");
    expect(item!.detail).not.toContain("not verified");
  });

  it("fails when EXIF survives (OUT-004)", async () => {
    const s = await statuses(template(), artifact(96, true));
    expect(s["metadata"]).toBe("fail");
  });

  describe("crop integrity (EDT-009)", () => {
    it("fails when transparent pixels remain in the crop", async () => {
      // Regression: this used to be a literal pass, so an artifact with
      // black corners also showed all green
      const s = await statuses(
        template(),
        artifact(96, false, 60, { scannedPixels: 1000, transparentPixels: 7 }),
      );
      expect(s["no-alpha"]).toBe("fail");
    });

    it("explains how much of the crop is uncovered", async () => {
      const checks = await buildChecks(
        artifact(96, false, 60, { scannedPixels: 1000, transparentPixels: 7 }),
        template(),
      );
      const item = checks.find((c) => c.id === "no-alpha")!;
      expect(item.detail).toContain("0.70%");
    });

    it("is unknown when canvas pixels could not be read", async () => {
      const s = await statuses(
        template(),
        artifact(96, false, 60, { scannedPixels: 0, transparentPixels: 0 }),
      );
      expect(s["no-alpha"]).toBe("unknown");
    });
  });

  describe("static recheck wiring (GDE-008)", () => {
    it("reports background as unchecked when no metric was measured (O2)", async () => {
      const checks = await buildChecks(
        artifact(96),
        template(),
        staticCheckResult({
          quality: {
            status: "warn",
            issues: [
              "exposure and sharpness show no obvious issues (heuristic, for reference only)",
            ],
            metrics: {
              darkClipRatio: 0,
              brightClipRatio: 0,
              sharpness: 120,
              background: null,
            },
          },
        }),
      );
      const item = checks.find((c) => c.id === "background")!;
      expect(item.status).toBe("unknown");
      expect(item.detail).toContain("not checked");
    });

    it("never passes the background item even when the auto signal is clean (O2)", async () => {
      const checks = await buildChecks(
        artifact(96),
        template(),
        staticCheckResult({
          quality: {
            status: "warn",
            issues: [
              "exposure and sharpness show no obvious issues (heuristic, for reference only)",
            ],
            metrics: {
              darkClipRatio: 0,
              brightClipRatio: 0,
              sharpness: 120,
              background: { lumaStd: 5, blockRange: 8, leftRightDiff: 3, topBottomDiff: 4 },
            },
          },
        }),
      );
      const item = checks.find((c) => c.id === "background")!;
      expect(item.status).not.toBe("pass");
      expect(item.detail).toContain("requires manual confirmation");
    });

    it("warns with the heuristic notice when the background signal exceeds a threshold (O2)", async () => {
      const checks = await buildChecks(
        artifact(96),
        template(),
        staticCheckResult({
          quality: {
            status: "warn",
            issues: [
              "exposure and sharpness show no obvious issues (heuristic, for reference only)",
            ],
            metrics: {
              darkClipRatio: 0,
              brightClipRatio: 0,
              sharpness: 120,
              background: { lumaStd: 5, blockRange: 8, leftRightDiff: 120, topBottomDiff: 4 },
            },
          },
        }),
      );
      const item = checks.find((c) => c.id === "background")!;
      expect(item.status).toBe("warn");
      expect(item.detail).toContain("left/right shadows");
      expect(item.detail).toContain(HEURISTIC_NOTICE);
    });

    it("passes the pose check when the recheck says ready", async () => {
      // Regression: the recheck results used to be discarded and this
      // item unconditionally wrote "provided in a later version"
      const s = await statuses(template(), artifact(96), staticCheckResult());
      expect(s["pose"]).toBe("pass");
    });

    it("warns with the recheck guidance when the pose is off", async () => {
      const checks = await buildChecks(
        artifact(96),
        template(),
        staticCheckResult({
          pose: poseState({ status: "unstable", guidanceHints: ["raise-head"] }),
        }),
      );
      const pose = checks.find((c) => c.id === "pose")!;
      expect(pose.status).toBe("warn");
      expect(pose.detail).toContain("raise your head a little");
      expect(pose.detail).toContain("not calibrated to official tolerance");
    });

    it("stays unknown when the pose model was unavailable", async () => {
      const s = await statuses(
        template(),
        artifact(96),
        staticCheckResult({ poseAvailable: false, pose: null }),
      );
      expect(s["pose"]).toBe("unknown");
    });

    it("passes the exposure check when the heuristic found nothing", async () => {
      const s = await statuses(template(), artifact(96), staticCheckResult());
      expect(s["exposure"]).toBe("pass");
    });

    it("warns with the concrete exposure issue", async () => {
      const checks = await buildChecks(
        artifact(96),
        template(),
        staticCheckResult({
          quality: {
            status: "warn",
            issues: ["underexposed: dark-clipped pixels are 8.3%"],
            metrics: {
              darkClipRatio: 0.083,
              brightClipRatio: 0,
              sharpness: 120,
              background: { lumaStd: 5, blockRange: 8, leftRightDiff: 3, topBottomDiff: 4 },
            },
          },
        }),
      );
      const exposure = checks.find((c) => c.id === "exposure")!;
      expect(exposure.status).toBe("warn");
      expect(exposure.detail).toContain("8.3%");
    });
  });

  describe("source resolution (EDT-004)", () => {
    it("warns when the render had to upscale the source", async () => {
      const checks = await buildChecks(
        artifact(96, false, 60, undefined, [2, 0, 0, 2, 0, 0]),
        template(),
      );
      const item = checks.find((c) => c.id === "source-resolution")!;
      expect(item.status).toBe("warn");
      expect(item.detail).toContain("2.00");
    });

    it("accounts for rotation when measuring the upscale factor", async () => {
      // 45° rotation + 2× scale: the linear part's determinant is still 4,
      // so the upscale factor is 2
      const c = Math.SQRT1_2 * 2;
      const checks = await buildChecks(
        artifact(96, false, 60, undefined, [c, -c, c, c, 0, 0]),
        template(),
      );
      const item = checks.find((c) => c.id === "source-resolution")!;
      expect(item.status).toBe("warn");
      expect(item.detail).toContain("2.00");
    });

    it("passes when the source is at least as large as the output", async () => {
      const checks = await buildChecks(
        artifact(96, false, 60, undefined, [0.5, 0, 0, 0.5, 0, 0]),
        template(),
      );
      expect(checks.find((c) => c.id === "source-resolution")!.status).toBe("pass");
    });
  });

  describe("captureRules (P8)", () => {
    it("renders a manual rule as needs-manual-confirmation with its source literal (P8)", async () => {
      const checks = await buildChecks(
        artifact(96),
        template({
          captureRules: [
            {
              id: "t-manual-bg",
              check: "background",
              expected: "plain_white",
              evaluation: "manual",
              enforcement: "mandatory",
              provenance: "source_literal",
              sourceRefs: ["s1"],
              sourceLiteral: "plain white background",
            },
          ],
        }),
      );
      const item = checks.find((c) => c.id === "capture:t-manual-bg");
      expect(item).toBeDefined();
      expect(item!.status).toBe("manual");
      expect(item!.detail).toContain("plain white background");
    });

    it("never judges an automatic rule as pass: unknown instead of manual (P8)", async () => {
      const checks = await buildChecks(
        artifact(96),
        template({
          captureRules: [
            {
              id: "t-manual-bg",
              check: "background",
              expected: "plain_white",
              evaluation: "manual",
              enforcement: "mandatory",
              provenance: "source_literal",
              sourceRefs: ["s1"],
              sourceLiteral: "plain white background",
            },
            {
              id: "t-auto-face",
              check: "single_face",
              expected: true,
              evaluation: "automatic",
              enforcement: "mandatory",
              provenance: "derived",
              sourceRefs: [],
            },
          ],
        }),
      );
      const auto = checks.find((c) => c.id === "capture:t-auto-face");
      expect(auto).toBeDefined();
      expect(auto!.status).toBe("unknown");
      expect(auto!.status).not.toBe("manual");
      // The two rules produce two distinct ids; they do not overwrite
      // each other
      expect(new Set(checks.map((c) => c.id)).has("capture:t-manual-bg")).toBe(true);
      expect(new Set(checks.map((c) => c.id)).has("capture:t-auto-face")).toBe(true);
    });

    it("marks non-mandatory rules as capture-requirement-recommended (P8)", async () => {
      const checks = await buildChecks(
        artifact(96),
        template({
          captureRules: [
            {
              id: "t-rec",
              check: "lighting",
              expected: "recent",
              evaluation: "manual",
              enforcement: "recommended",
              provenance: "source_literal",
              sourceRefs: [],
            },
          ],
        }),
      );
      const item = checks.find((c) => c.id === "capture:t-rec");
      expect(item).toBeDefined();
      expect(item!.label).toBe("Capture requirement (recommended)");
      // Without sourceLiteral it degrades to the expected value
      expect(item!.detail).toBe("requirement: recent");
    });

    it("leaves the base summary unchanged when captureRules is empty (P8)", async () => {
      const checks = await buildChecks(artifact(96), template({ captureRules: [] }));
      const ids = checks.map((c) => c.id).sort();
      // Since O2 the baseline includes background (unknown "not checked"
      // when the automatic signal was not measured)
      expect(ids).toEqual(
        [
          "exact-pixels",
          "format",
          "metadata",
          "no-alpha",
          "source-resolution",
          "pose",
          "exposure",
          "background",
        ].sort(),
      );
      expect(ids.some((id) => id.startsWith("capture:"))).toBe(false);
    });
  });

  describe("ranged_pixels selected sizes (P6)", () => {
    function rangedTemplate(): TemplateEntry {
      return template({
        revisionId: "visa@1",
        id: "visa",
        output: {
          kind: "ranged_pixels",
          minWidthPx: 600,
          minHeightPx: 600,
          maxWidthPx: 1200,
          maxHeightPx: 1200,
          defaultWidthPx: 600,
          defaultHeightPx: 600,
          aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
        },
      } as unknown as Partial<TemplateEntry["revision"]>);
    }

    function manifestArtifact(w: number, h: number): FinalArtifact {
      const bytes = jpegBytes(96, false);
      return {
        artifactId: "a1",
        blob: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }),
        coverage: { scannedPixels: w * h, transparentPixels: 0 },
        manifest: {
          schemaVersion: 1,
          templateId: "visa",
          templateVersion: 1,
          widthPx: w,
          heightPx: h,
          mime: "image/jpeg",
          orientationNormalized: true,
          matrix: [1, 0, 0, 1, 0, 0],
          flipX: false,
        },
      };
    }

    it("passes exact-pixels when the manifest matches the selected size (P6)", async () => {
      const checks = await buildChecks(manifestArtifact(1200, 1200), rangedTemplate(), null, {
        width: 1200,
        height: 1200,
      });
      const item = checks.find((c) => c.id === "exact-pixels");
      expect(item!.status).toBe("pass");
      expect(item!.detail).toContain("1200×1200");
    });

    it("still fails for a 1300x1300 manifest with an out-of-range selection (P6)", async () => {
      const checks = await buildChecks(manifestArtifact(1300, 1300), rangedTemplate(), null, {
        width: 1300,
        height: 1300,
      });
      const item = checks.find((c) => c.id === "exact-pixels");
      // An out-of-range selection falls back to default (600) via resolve,
      // so it no longer equals the manifest
      expect(item!.status).toBe("fail");
    });

    it("fails for an off-aspect manifest (P6)", async () => {
      const checks = await buildChecks(manifestArtifact(1200, 600), rangedTemplate(), null, {
        width: 1200,
        height: 1200,
      });
      const item = checks.find((c) => c.id === "exact-pixels");
      expect(item!.status).toBe("fail");
    });

    it("defaults to 600x600 when no selection is passed (P6)", async () => {
      const checks = await buildChecks(manifestArtifact(600, 600), rangedTemplate(), null);
      expect(checks.find((c) => c.id === "exact-pixels")!.status).toBe("pass");
      const fail = await buildChecks(manifestArtifact(1200, 1200), rangedTemplate(), null);
      expect(fail.find((c) => c.id === "exact-pixels")!.status).toBe("fail");
    });
  });
});
