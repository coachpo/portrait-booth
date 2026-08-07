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
      label: { en: "US visa" },
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
  withSource: SourceImage = source,
) {
  return render(
    <ReviewStep
      source={withSource}
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

describe("ReviewStep recheck states (O2)", () => {
  it("lists unchecked items instead of the all-clear message when nothing was checked (O2)", () => {
    // Old implementation: only a has-warnings/no-warnings dichotomy; when
    // the model was unavailable and exposure was fine, it claimed "recheck
    // found no obvious issues" for items never checked
    const unchecked = {
      ...source,
      staticChecks: {
        poseAvailable: false,
        pose: null,
        faceGeometry: null,
        quality: {
          status: "warn",
          issues: ["exposure and sharpness show no obvious issues (heuristic, for reference only)"],
          metrics: {
            darkClipRatio: 0,
            brightClipRatio: 0,
            sharpness: 120,
            background: null,
          },
        },
      },
    } as unknown as SourceImage;
    renderStep(ranged, null, vi.fn(), unchecked);
    expect(screen.getByText(/not checked and need manual confirmation/i)).toBeInTheDocument();
    expect(screen.getByText(/pose recheck/)).toBeInTheDocument();
    expect(screen.getByText(/face geometry \(eyes\/mouth\)/)).toBeInTheDocument();
    expect(screen.getByText(/background uniformity/)).toBeInTheDocument();
    expect(screen.queryByText(/recheck found no obvious issues/i)).toBeNull();
  });

  it("keeps the all-clear message when every project was checked (O2)", () => {
    const checked = {
      ...source,
      staticChecks: {
        poseAvailable: true,
        pose: { status: "ready" as const, guidance: "" },
        faceGeometry: { eyesClosed: false, mouthOpen: false },
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
      },
    } as unknown as SourceImage;
    renderStep(ranged, null, vi.fn(), checked);
    expect(screen.getByText(/recheck found no obvious issues/i)).toBeInTheDocument();
    expect(screen.queryByText(/not checked/i)).toBeNull();
  });
});

describe("ReviewStep output size (P6)", () => {
  it("renders the size control for ranged templates with 600 selected by default (P6)", () => {
    renderStep(ranged);
    const group = screen.getByRole("group", { name: "Output size" });
    expect(group).toBeInTheDocument();
    const radios = withinGroup(group);
    expect(radios).toHaveLength(2);
    const checked = radios.find((r) => (r as HTMLInputElement).checked);
    expect(checked?.value).toBe("600x600");
    expect(screen.getByText(/output 600×600 pixels/)).toBeInTheDocument();
  });

  it("does not render the control for exact_pixels templates (P6)", () => {
    renderStep(exact);
    expect(screen.queryByRole("group", { name: "Output size" })).toBeNull();
    expect(screen.getByText(/output 500×653 pixels/)).toBeInTheDocument();
  });

  it("updates the output text when switching to 1200x1200 (P6)", () => {
    const onSizeChange = vi.fn();
    renderStep(ranged, null, onSizeChange);
    fireEvent.click(screen.getByRole("radio", { name: "1200×1200 pixels" }));
    expect(onSizeChange).toHaveBeenCalledWith({ width: 1200, height: 1200 });
    // After switching, it renders at the new size (selectedSize written
    // back by the parent)
    renderStep(ranged, { width: 1200, height: 1200 }, onSizeChange);
    expect(screen.getByText(/output 1200×1200 pixels/)).toBeInTheDocument();
  });

  it("shows a narrow-window notice when the max size is selected (P6)", () => {
    const { rerender } = renderStep(ranged, { width: 1200, height: 1200 });
    expect(screen.getByText(/narrow size window/i)).toBeInTheDocument();
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
    expect(screen.queryByText(/narrow size window/i)).toBeNull();
  });
});

function withinGroup(group: HTMLElement): HTMLInputElement[] {
  return Array.from(group.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
}
