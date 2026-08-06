import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { OutputSizeOption } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import { ReviewStep } from "./review-step";

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

function entry(output: unknown, overrides: Partial<TemplateEntry["revision"]> = {}): TemplateEntry {
  return {
    revision: {
      revisionId: "visa@1",
      id: "visa",
      version: 1,
      schemaVersion: 1,
      label: { zh: "美国签证" },
      jurisdiction: "US",
      documentType: "visa",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [],
      output,
      cropRules: [],
      captureRules: [],
      overlay: { kind: "none", ruleIds: [] },
      capabilities: {
        selfCapture: "allowed",
        crop: "allowed",
        rotate: "allowed",
        mirror: "warn",
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
      revisionId: "visa@1",
      status: "active",
      statusReason: "ok",
      owner: "o",
      reviewer: "r",
      verifiedAt: "2026-08-06",
      reviewDueAt: "2026-11-04",
      effectiveAt: "2026-08-06",
      publicationRevision: 1,
    },
  } as unknown as TemplateEntry;
}

const ranged = entry(
  {
    kind: "ranged_pixels",
    minWidthPx: 600,
    minHeightPx: 600,
    maxWidthPx: 1200,
    maxHeightPx: 1200,
    defaultWidthPx: 600,
    defaultHeightPx: 600,
    aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
  },
  {
    outputFile: {
      mime: ["image/jpeg"],
      sizeLimit: {
        maxBytes: 240000,
        normalization: "conservative_derived",
        sourceLiteral: "us-visa-digital@1.json:57",
      },
    },
  },
);

const exact = entry(
  {
    kind: "exact_pixels",
    widthPx: 500,
    heightPx: 653,
    aspect: { width: 500, height: 653, enforcement: "mandatory", provenance: "derived" },
  },
  { revisionId: "fi@1", id: "fi" },
);

function renderStep(
  template: TemplateEntry,
  selectedSize: OutputSizeOption | null = null,
  onSizeChange = vi.fn(),
) {
  return render(
    <ReviewStep
      source={source}
      template={template}
      origin="upload"
      onConfirm={vi.fn()}
      onRetake={vi.fn()}
      onBack={vi.fn()}
      onChangeTemplate={vi.fn()}
      selectedSize={selectedSize}
      onSizeChange={onSizeChange}
    />,
  );
}

describe("ReviewStep output size (P6)", () => {
  it("renders the size control for ranged templates with 600 selected by default (P6)", () => {
    renderStep(ranged);
    const group = screen.getByRole("group", { name: "输出尺寸" });
    expect(group).toBeInTheDocument();
    const radios = withinGroup(group);
    expect(radios).toHaveLength(2);
    const checked = radios.find((r) => (r as HTMLInputElement).checked);
    expect(checked?.value).toBe("600x600");
    expect(screen.getByText(/输出 600×600 像素/)).toBeInTheDocument();
  });

  it("does not render the control for exact_pixels templates (P6)", () => {
    renderStep(exact);
    expect(screen.queryByRole("group", { name: "输出尺寸" })).toBeNull();
    expect(screen.getByText(/输出 500×653 像素/)).toBeInTheDocument();
  });

  it("updates the output text when switching to 1200x1200 (P6)", () => {
    const onSizeChange = vi.fn();
    renderStep(ranged, null, onSizeChange);
    fireEvent.click(screen.getByRole("radio", { name: "1200×1200 像素" }));
    expect(onSizeChange).toHaveBeenCalledWith({ width: 1200, height: 1200 });
    // 切档后按新尺寸渲染（selectedSize 由父级写回）
    renderStep(ranged, { width: 1200, height: 1200 }, onSizeChange);
    expect(screen.getByText(/输出 1200×1200 像素/)).toBeInTheDocument();
  });

  it("shows a narrow-window notice when the max size is selected (P6)", () => {
    const { rerender } = renderStep(ranged, { width: 1200, height: 1200 });
    expect(screen.getByText(/文件体积窗口很窄/)).toBeInTheDocument();
    rerender(
      <ReviewStep
        source={source}
        template={ranged}
        origin="upload"
        onConfirm={vi.fn()}
        onRetake={vi.fn()}
        onBack={vi.fn()}
        onChangeTemplate={vi.fn()}
        selectedSize={null}
        onSizeChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/文件体积窗口很窄/)).toBeNull();
  });
});

function withinGroup(group: HTMLElement): HTMLInputElement[] {
  return Array.from(group.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
}
