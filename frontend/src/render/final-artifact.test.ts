import { describe, expect, it, vi } from "vitest";

import { IDENTITY_TRANSFORM } from "../editor/edit-transform";
import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { renderFinalArtifact, RenderError, type RenderDeps } from "./final-artifact";

/** 最小 JPEG（带 JFIF APP0），用于密度改写与字节扫描 */
function jpegBytes(): Uint8Array {
  const app0 = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 1, 0, 96, 0, 96, 0, 0];
  const seg = (marker: number, payload: number[]): number[] => [
    0xff,
    marker,
    ((payload.length + 2) >> 8) & 0xff,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const parts: number[] = [0xff, 0xd8];
  parts.push(...seg(0xe0, app0));
  parts.push(...seg(0xc0, [8, 0x01, 0x90, 0x01, 0x40, 1, 0x11, 0x00, 0x00, 0x00]));
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function template(overrides: Partial<TemplateEntry["revision"]> = {}): TemplateEntry {
  return {
    revision: {
      revisionId: "fi@1",
      id: "fi",
      version: 3,
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
    },
  };
}

const source = {
  file: new File([new Uint8Array(4)], "photo.jpg", { type: "image/jpeg" }),
  format: "jpeg",
  orientation: 1,
  rawWidth: 800,
  rawHeight: 600,
  width: 800,
  height: 600,
  bitmap: { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap,
  previewUrl: "blob:fake",
  dispose: vi.fn(),
} as unknown as SourceImage;

/** 构造 toBlob：字节长度 = base + quality 驱动的大小关系 */
function makeDeps(
  opts: {
    sizeAt?: (quality: number) => number;
    failToBlob?: boolean;
  } = {},
) {
  const ctx = { setTransform: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 0, height: 0 };
  const toBlob = vi.fn(async (_c: HTMLCanvasElement, _type: string, q: number) => {
    if (opts.failToBlob) return null;
    const size = opts.sizeAt ? opts.sizeAt(q) : 60;
    const base = jpegBytes();
    const out = new Uint8Array(Math.max(size, base.length));
    out.set(base);
    return new Blob([out], { type: "image/jpeg" });
  });
  const deps: RenderDeps = {
    createCanvas: ((w: number, h: number) => {
      canvas.width = w;
      canvas.height = h;
      return { width: w, height: h } as HTMLCanvasElement;
    }) as RenderDeps["createCanvas"],
    canvasContext: () => ctx as unknown as CanvasRenderingContext2D,
    toBlob,
    randomId: () => "artifact-1",
  };
  return { deps, ctx, canvas, toBlob };
}

describe("renderFinalArtifact (OUT-001/002/005)", () => {
  it("renders exact pixels with the composed matrix and a manifest", async () => {
    const { deps, ctx, canvas } = makeDeps();
    const artifact = await renderFinalArtifact(source, template(), IDENTITY_TRANSFORM, deps);

    expect(canvas.width).toBe(500);
    expect(canvas.height).toBe(653);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(artifact.artifactId).toBe("artifact-1");
    expect(artifact.blob.type).toBe("image/jpeg");
    expect(artifact.manifest.schemaVersion).toBe(1);
    expect(artifact.manifest.templateId).toBe("fi");
    expect(artifact.manifest.templateVersion).toBe(3);
    expect(artifact.manifest.widthPx).toBe(500);
    expect(artifact.manifest.heightPx).toBe(653);
    expect(artifact.manifest.mime).toBe("image/jpeg");
    expect(artifact.manifest.orientationNormalized).toBe(true);
    expect(artifact.manifest.flipX).toBe(false);
    // src 800×600 → out 500×653：cover = 653/600 ≈ 1.08833，x 居中偏移 = (500-800*cs)/2
    expect(artifact.manifest.matrix[0]).toBeCloseTo(1.088333, 5);
    expect(artifact.manifest.matrix[1]).toBe(0);
    expect(artifact.manifest.matrix[2]).toBe(0);
    expect(artifact.manifest.matrix[3]).toBeCloseTo(1.088333, 5);
    expect(artifact.manifest.matrix[4]).toBeCloseTo(-185.333, 2);
    expect(artifact.manifest.matrix[5]).toBe(0);
  });

  it("uses the default size for ranged-pixel templates", async () => {
    const { deps, canvas } = makeDeps();
    const t = template({
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
    });
    const artifact = await renderFinalArtifact(source, t, IDENTITY_TRANSFORM, deps);
    expect(canvas.width).toBe(600);
    expect(artifact.manifest.widthPx).toBe(600);
  });

  it("rejects templates without local rendering", async () => {
    const { deps } = makeDeps();
    const t = template({ output: { kind: "portal_source", officialPortalPerformsCrop: true } });
    await expect(renderFinalArtifact(source, t, IDENTITY_TRANSFORM, deps)).rejects.toMatchObject({
      kind: "render-failed",
    });
  });

  it("reports render-failed when the encoder is unavailable", async () => {
    const { deps } = makeDeps({ failToBlob: true });
    await expect(
      renderFinalArtifact(source, template(), IDENTITY_TRANSFORM, deps),
    ).rejects.toMatchObject({
      kind: "render-failed",
    });
  });
});

describe("renderFinalArtifact quality search (OUT-003)", () => {
  it("searches quality until the blob fits maxBytes", async () => {
    const { deps, toBlob } = makeDeps({ sizeAt: (q) => 1000 + q * 10 });
    const t = template({
      outputFile: {
        mime: ["image/jpeg"],
        sizeLimit: {
          maxBytes: 1500,
          sourceLiteral: "250 KB",
          normalization: "source_exact",
        },
      },
    });
    const artifact = await renderFinalArtifact(source, t, IDENTITY_TRANSFORM, deps);
    expect(artifact.blob.size).toBeLessThanOrEqual(1500);
    expect(toBlob.mock.calls.length).toBeLessThanOrEqual(11);
    // 最后成功那次质量应高于失败边界
    expect(toBlob).toHaveBeenCalledWith(expect.anything(), "image/jpeg", expect.any(Number));
  });

  it("rejects when no quality fits the limit", async () => {
    const { deps } = makeDeps({ sizeAt: () => 2000 });
    const t = template({
      outputFile: {
        mime: ["image/jpeg"],
        sizeLimit: { maxBytes: 1500, sourceLiteral: "1.5 KB", normalization: "source_exact" },
      },
    });
    await expect(renderFinalArtifact(source, t, IDENTITY_TRANSFORM, deps)).rejects.toMatchObject({
      kind: "size-limit",
    });
  });
});

describe("renderFinalArtifact print density (OUT-006)", () => {
  it("writes the template PPI into JFIF density", async () => {
    const { deps } = makeDeps();
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
    const artifact = await renderFinalArtifact(source, t, IDENTITY_TRANSFORM, deps);
    const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
    // APP0 payload: "JFIF\0"(5) + version(2) + units(1) + xdensity(2, BE) + ydensity(2, BE)
    const p = 6;
    expect(bytes[p + 7]).toBe(1); // units = dpi
    expect((bytes[p + 8] << 8) | bytes[p + 9]).toBe(300);
    expect((bytes[p + 10] << 8) | bytes[p + 11]).toBe(300);
  });
});

describe("RenderError", () => {
  it("carries a kind", () => {
    const err = new RenderError("size-limit", "msg");
    expect(err.kind).toBe("size-limit");
    expect(err).toBeInstanceOf(Error);
  });
});
