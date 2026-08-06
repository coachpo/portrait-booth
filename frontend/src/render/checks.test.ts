import { describe, expect, it } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import type { StaticCheckResult } from "../pose/static-check";
import type { FinalArtifact } from "./final-artifact";
import { buildChecks } from "./checks";

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
      label: { zh: "芬兰警方证件" },
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
    guidance: "姿势稳定，可以拍摄。",
    ...overrides,
  };
}

function staticCheckResult(overrides: Partial<StaticCheckResult> = {}): StaticCheckResult {
  return {
    poseAvailable: true,
    pose: poseState(),
    quality: {
      status: "warn",
      issues: ["曝光与清晰度未发现明显问题（启发式，仅供参考）"],
      metrics: { darkClipRatio: 0, brightClipRatio: 0, sharpness: 120 },
    },
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
    // 没有跑过复检时才是 unknown
    expect(s["pose"]).toBe("unknown");
    expect(s["exposure"]).toBe("unknown");
  });

  it("marks reference_only templates as warn (TMP-003)", async () => {
    const t = template({}, { status: "reference_only", statusReason: "未通过校准打印测试" });
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
    const s = await statuses(t); // blob 约 60 字节 > 50
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

  it("fails when EXIF survives (OUT-004)", async () => {
    const s = await statuses(template(), artifact(96, true));
    expect(s["metadata"]).toBe("fail");
  });

  describe("crop integrity (EDT-009)", () => {
    it("fails when transparent pixels remain in the crop", async () => {
      // 回归：这一项曾是字面量 pass，带黑角的成品也会显示为全绿
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
    it("passes the pose check when the recheck says ready", async () => {
      // 回归：复检结果曾被丢弃，这一项无条件写「后续版本提供」
      const s = await statuses(template(), artifact(96), staticCheckResult());
      expect(s["pose"]).toBe("pass");
    });

    it("warns with the recheck guidance when the pose is off", async () => {
      const checks = await buildChecks(
        artifact(96),
        template(),
        staticCheckResult({
          pose: poseState({ status: "unstable", guidance: "姿势需调整：请抬头一点。" }),
        }),
      );
      const pose = checks.find((c) => c.id === "pose")!;
      expect(pose.status).toBe("warn");
      expect(pose.detail).toContain("请抬头一点");
      expect(pose.detail).toContain("未经官方容差校准");
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
            issues: ["曝光不足：暗部剪切像素占 8.3%"],
            metrics: { darkClipRatio: 0.083, brightClipRatio: 0, sharpness: 120 },
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
      expect(item.detail).toContain("2.00 倍");
    });

    it("accounts for rotation when measuring the upscale factor", async () => {
      // 45° 旋转 + 2 倍缩放：线性部分的行列式仍是 4，放大倍率 2
      const c = Math.SQRT1_2 * 2;
      const checks = await buildChecks(
        artifact(96, false, 60, undefined, [c, -c, c, c, 0, 0]),
        template(),
      );
      const item = checks.find((c) => c.id === "source-resolution")!;
      expect(item.status).toBe("warn");
      expect(item.detail).toContain("2.00 倍");
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
    it("renders a manual rule as 需人工确认 with its source literal (P8)", async () => {
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
      // 两条规则产出两个不同 id，不会互相覆盖
      expect(new Set(checks.map((c) => c.id)).has("capture:t-manual-bg")).toBe(true);
      expect(new Set(checks.map((c) => c.id)).has("capture:t-auto-face")).toBe(true);
    });

    it("marks non-mandatory rules as 拍摄要求（建议） (P8)", async () => {
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
      expect(item!.label).toBe("拍摄要求（建议）");
      // 无 sourceLiteral 时降级为 expected 原文
      expect(item!.detail).toBe("要求：recent");
    });

    it("leaves the base summary unchanged when captureRules is empty (P8)", async () => {
      const checks = await buildChecks(artifact(96), template({ captureRules: [] }));
      const ids = checks.map((c) => c.id).sort();
      expect(ids).toEqual(
        [
          "exact-pixels",
          "format",
          "metadata",
          "no-alpha",
          "source-resolution",
          "pose",
          "exposure",
        ].sort(),
      );
      expect(ids.some((id) => id.startsWith("capture:"))).toBe(false);
    });
  });
});
