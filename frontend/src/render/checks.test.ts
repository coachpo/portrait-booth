import { describe, expect, it } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
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

function artifact(density: number, exif = false, size = 60): FinalArtifact {
  const bytes = jpegBytes(density, exif);
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return {
    artifactId: "a1",
    blob: new Blob([out], { type: "image/jpeg" }),
    manifest: {
      schemaVersion: 1,
      templateId: "fi",
      templateVersion: 1,
      widthPx: 500,
      heightPx: 653,
      mime: "image/jpeg",
      orientationNormalized: true,
      matrix: [1, 0, 0, 1, 0, 0],
      flipX: false,
    },
  };
}

async function statuses(
  entry: TemplateEntry,
  a: FinalArtifact = artifact(96),
): Promise<Record<string, string>> {
  const checks = await buildChecks(a, entry);
  return Object.fromEntries(checks.map((c) => [c.id, c.status]));
}

describe("buildChecks", () => {
  it("reports pass for a clean exact-pixel render", async () => {
    const s = await statuses(template());
    expect(s["exact-pixels"]).toBe("pass");
    expect(s["format"]).toBe("pass");
    expect(s["metadata"]).toBe("pass");
    expect(s["no-alpha"]).toBe("pass");
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
});
