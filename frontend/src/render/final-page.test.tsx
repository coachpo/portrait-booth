import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_TRANSFORM } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import { FinalPage, physicalSizeInfo } from "./final-page";

vi.mock("./final-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./final-artifact")>();
  return { ...actual, renderFinalArtifact: vi.fn() };
});
vi.mock("./checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checks")>();
  return { ...actual, buildChecks: vi.fn() };
});

import { RenderError, renderFinalArtifact } from "./final-artifact";
import { buildChecks } from "./checks";

const template = {
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
} as unknown as TemplateEntry;

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

const fakeArtifact = {
  artifactId: "a1",
  blob: new Blob([new Uint8Array(5000)], { type: "image/jpeg" }),
  coverage: { scannedPixels: 500 * 653, transparentPixels: 0 },
  manifest: {
    schemaVersion: 1 as const,
    templateId: "fi",
    templateVersion: 1,
    widthPx: 500,
    heightPx: 653,
    mime: "image/jpeg" as const,
    orientationNormalized: true as const,
    matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    flipX: false,
  },
};

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage(onBack = vi.fn(), onRestart = vi.fn()) {
  return render(
    <FinalPage
      source={source}
      template={template}
      transform={IDENTITY_TRANSFORM}
      onBack={onBack}
      onRestart={onRestart}
      staged={null}
      stagedStale={false}
      onStaged={vi.fn()}
    />,
  );
}

describe("FinalPage", () => {
  it("renders artifact details and check summary (OUT-007)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([
      { id: "exact-pixels", label: "Pixel size", status: "pass", detail: "500×653" },
      { id: "pose", label: "Pose check", status: "unknown" },
    ]);
    renderPage();

    expect(await screen.findByText("500×653")).toBeInTheDocument();
    expect(screen.getByText("JPEG · sRGB")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "fi@1")).toBeInTheDocument();
    expect(screen.getByText(/4\.9 KB/)).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
  });

  it("renders a manual check item as needs-manual-confirmation with the check-manual class (P8)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([
      {
        id: "capture:x",
        label: "Capture requirement",
        status: "manual",
        detail: "official source: plain white background",
      },
    ]);
    renderPage();

    expect(await screen.findByText("Needs manual confirmation")).toBeInTheDocument();
    expect(screen.getByText("(official source: plain white background)")).toBeInTheDocument();
    const li = screen.getByText("Needs manual confirmation").closest("li");
    expect(li).not.toBeNull();
    expect(li!.className).toContain("check-manual");
  });

  it("shows the export filename without identity info (OUT-008)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();
    const btn = await screen.findByRole("button", { name: /download/i });
    expect(btn.textContent).toMatch(/^Download fi-id-digital_upload-\d{8}\.jpg$/);
    expect(btn.textContent).not.toMatch(/photo|KEY|name/i);
  });

  it("shows physical size for paper templates", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const paper = {
      ...template,
      revision: {
        ...template.revision,
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
      },
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={paper}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    const dd = await screen.findByText(/35×45 mm/);
    expect(dd).toBeInTheDocument();
    expect(dd.textContent).toContain("reference image");
    expect(screen.queryByText(/printable at actual size/)).toBeNull();
  });

  it("labels portal_verified + active paper as printable-at-actual-size (P5)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const paper = {
      ...template,
      publication: { ...template.publication, status: "active" as const },
      revision: {
        ...template.revision,
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
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={paper}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    const dd = await screen.findByText(/35×45 mm/);
    expect(dd.textContent).toContain("printable at actual size");
    expect(dd.textContent).not.toContain("reference image");
  });

  it("never labels portal_verified + reference_only paper as printable (P5)", async () => {
    // Conjunction criterion: looking only at ppiProvenance would mislabel
    // a template that has not passed calibrated printing as printable
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const paper = {
      ...template,
      publication: { ...template.publication, status: "reference_only" as const },
      revision: {
        ...template.revision,
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
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={paper}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    const dd = await screen.findByText(/35×45 mm/);
    expect(dd.textContent).toContain("reference image");
    expect(screen.queryByText(/printable at actual size/)).toBeNull();
  });

  it("physicalSizeInfo judges print-readiness by provenance and status (P5)", () => {
    const base = {
      ...template,
      publication: { ...template.publication, status: "active" as const },
      revision: {
        ...template.revision,
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
      },
    } as unknown as TemplateEntry;
    const withProvenance = (ppiProvenance: string) =>
      ({
        ...base,
        revision: { ...base.revision, output: { ...base.revision.output, ppiProvenance } },
      }) as unknown as TemplateEntry;
    expect(physicalSizeInfo(withProvenance("source_literal"))!.printReady).toBe(false);
    expect(physicalSizeInfo(withProvenance("derived"))!.printReady).toBe(false);
    expect(physicalSizeInfo(withProvenance("portal_verified"))!.printReady).toBe(true);
    expect(physicalSizeInfo(template as unknown as TemplateEntry)).toBeNull(); // exact_pixels has no physical size
    expect(physicalSizeInfo(withProvenance("portal_verified"))!.mm).toBe("35×45 mm");
  });

  it("does not show mm or print claims for pixel templates (P5)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();
    await screen.findByRole("heading", { name: "Final photo" });
    expect(screen.queryByText(/mm/)).toBeNull();
    expect(screen.queryByText(/print/i)).toBeNull();
  });

  it("shows an error with retry when rendering fails", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("render failed"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("render failed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("offers a downgrade to the default size on size-limit errors (P6)", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(
      new RenderError("size-limit", "all compression bands tried; still above the file size limit"),
    );
    const onUseDefaultSize = vi.fn();
    render(
      <FinalPage
        source={source}
        template={template}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
        selectedSize={{ width: 1200, height: 1200 }}
        onUseDefaultSize={onUseDefaultSize}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("all compression bands tried");
    // The template default is 500×653: retrying the same size fails again by
    // construction, so a downgrade exit is mandatory
    const downgrade = screen.getByRole("button", { name: "Regenerate at 500×653" });
    fireEvent.click(downgrade);
    expect(onUseDefaultSize).toHaveBeenCalled();
  });

  it("does not offer the downgrade when already on the default size (P6)", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(
      new RenderError("size-limit", "all compression bands tried; still above the file size limit"),
    );
    renderPage(); // no selectedSize passed = default band
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /regenerate/i })).toBeNull();
  });

  it("discloses sources, restrictions and review notes on the final page (P3)", async () => {
    // Old implementation: the final page had no sources, no restriction
    // phrases, and no review notes
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const withSources = {
      ...template,
      revision: {
        ...template.revision,
        sources: [
          {
            id: "s1",
            url: "https://example.com/spec",
            title: "Official specification",
            authority: "Test authority",
            accessedAt: "2026-08-06",
            sourceUpdatedAt: "2026-01-01",
          },
        ],
        sourceNotes: { en: ["review note one", "review note two"] },
      },
    } as unknown as TemplateEntry;
    render(
      <FinalPage
        source={source}
        template={withSources}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "Final photo" });
    expect(screen.getByText("2026-08-06")).toBeInTheDocument(); // review date for this project
    expect(screen.getByText("updated 2026-01-01")).toBeInTheDocument();
    expect(screen.getByText("review note one")).toBeInTheDocument();
    expect(screen.getByText("review note two")).toBeInTheDocument();
    // Restriction phrases: the fi fixture mirror/retouch/backgroundReplace
    // are all forbidden
    expect(screen.getByText(/forbids mirroring/i)).toBeInTheDocument();
    // No unsupported compliance/submittable copy appears
    expect(screen.queryByText(/submittable artifact/i)).toBeNull();
    expect(screen.queryByText(/compliant/i)).toBeNull();
  });

  it("offers escape hatches when rendering fails (A3)", async () => {
    // Regression: the failure state used to have only "Retry" with no
    // back-to-edit/restart exit
    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("BOOM"));
    const onBack = vi.fn();
    const onRestart = vi.fn();
    renderPage(onBack, onRestart);

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Back to edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("starts the retry from a clean slate (A3)", async () => {
    // Regression: after one failure, a successful retry must clear the old
    // error message and "Retry" button
    vi.mocked(renderFinalArtifact)
      .mockRejectedValueOnce(new Error("BOOM"))
      .mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: /download/i });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("drops the stale artifact when a re-render fails (A3)", async () => {
    // Regression: success-then-failure must not leave the old artifact's
    // "Download"/"Stage" entries behind
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const view = renderPage();
    await screen.findByRole("button", { name: /download/i });

    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("BOOM"));
    view.rerender(
      <FinalPage
        source={source}
        template={template}
        transform={{ ...IDENTITY_TRANSFORM }}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /stage/i })).toBeNull();
  });

  it("navigates back to editing and restart", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const onBack = vi.fn();
    const onRestart = vi.fn();
    renderPage(onBack, onRestart);
    await screen.findByRole("button", { name: /download/i });
    const back = screen.getByRole("button", { name: "Back to edit" });
    back.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    const restart = screen.getByRole("button", { name: "Restart" });
    restart.click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps the artifact immutable across re-renders", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const { rerender } = renderPage();
    await screen.findByRole("button", { name: /download/i });
    rerender(
      <FinalPage
        source={source}
        template={template}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        staged={null}
        stagedStale={false}
        onStaged={vi.fn()}
      />,
    );
    expect(renderFinalArtifact).toHaveBeenCalledTimes(1);
  });
});
