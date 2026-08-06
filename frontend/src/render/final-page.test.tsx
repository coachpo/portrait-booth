import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IDENTITY_TRANSFORM } from "../editor/edit-transform";
import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import { FinalPage } from "./final-page";

vi.mock("./final-artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./final-artifact")>();
  return { ...actual, renderFinalArtifact: vi.fn() };
});
vi.mock("./checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./checks")>();
  return { ...actual, buildChecks: vi.fn() };
});

import { renderFinalArtifact } from "./final-artifact";
import { buildChecks } from "./checks";

const template = {
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
    />,
  );
}

describe("FinalPage", () => {
  it("renders artifact details and check summary (OUT-007)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([
      { id: "exact-pixels", label: "像素尺寸", status: "pass", detail: "500×653" },
      { id: "pose", label: "姿态检查", status: "unknown" },
    ]);
    renderPage();

    expect(await screen.findByText("500×653")).toBeInTheDocument();
    expect(screen.getByText("JPEG · sRGB")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "fi@1")).toBeInTheDocument();
    expect(screen.getByText(/4\.9 KB/)).toBeInTheDocument();
    expect(screen.getByText("通过")).toBeInTheDocument();
    expect(screen.getByText("未检查")).toBeInTheDocument();
  });

  it("shows the export filename without identity info (OUT-008)", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    renderPage();
    const btn = await screen.findByRole("button", { name: /下载/ });
    expect(btn.textContent).toMatch(/^下载 fi-id-digital_upload-\d{8}\.jpg$/);
    expect(btn.textContent).not.toMatch(/photo|KEY|姓名/i);
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
          ppiProvenance: "source_literal",
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
      />,
    );
    expect(await screen.findByText("35×45 毫米")).toBeInTheDocument();
  });

  it("shows an error with retry when rendering fails", async () => {
    vi.mocked(renderFinalArtifact).mockRejectedValue(new Error("渲染失败"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("渲染失败");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("navigates back to editing and restart", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const onBack = vi.fn();
    const onRestart = vi.fn();
    renderPage(onBack, onRestart);
    await screen.findByRole("button", { name: /下载/ });
    const back = screen.getByRole("button", { name: "返回编辑" });
    back.click();
    expect(onBack).toHaveBeenCalledTimes(1);
    const restart = screen.getByRole("button", { name: "重新开始" });
    restart.click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("keeps the artifact immutable across re-renders", async () => {
    vi.mocked(renderFinalArtifact).mockResolvedValue(fakeArtifact);
    vi.mocked(buildChecks).mockResolvedValue([]);
    const { rerender } = renderPage();
    await screen.findByRole("button", { name: /下载/ });
    rerender(
      <FinalPage
        source={source}
        template={template}
        transform={IDENTITY_TRANSFORM}
        onBack={vi.fn()}
        onRestart={vi.fn()}
      />,
    );
    expect(renderFinalArtifact).toHaveBeenCalledTimes(1);
  });
});
