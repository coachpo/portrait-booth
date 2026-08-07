import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import { SourceStep } from "./source-step";

vi.mock("../image/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../image/source")>();
  return {
    ...actual,
    loadSourceImage: vi.fn(),
  };
});

import { loadSourceImage, SourceLoadError, type SourceImage } from "../image/source";
import { runStaticCheck } from "../pose/static-check";

const template = {
  revision: {
    revisionId: "us@1",
    id: "us",
    version: 1,
    schemaVersion: 1,
    label: { en: "US visa" },
    jurisdiction: "US",
    documentType: "visa",
    submissionChannel: "digital_upload",
    applicantClass: "adult",
    sources: [],
    output: {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 600,
      aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
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
    revisionId: "us@1",
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

function fakeSource(overrides: Partial<SourceImage> = {}): SourceImage {
  return {
    file: new File([new Uint8Array(4)], "photo.jpg", { type: "image/jpeg" }),
    format: "jpeg",
    orientation: 1,
    rawWidth: 640,
    rawHeight: 480,
    width: 640,
    height: 480,
    bitmap: { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap,
    previewUrl: "blob:fake",
    dispose: vi.fn(),
    ...overrides,
  };
}

function selectFile(file: File) {
  fireEvent.change(screen.getByTestId("file-input"), { target: { files: [file] } });
}

beforeEach(() => {
  vi.mocked(runStaticCheck).mockResolvedValue({
    pose: null,
    poseAvailable: false,
    quality: {
      status: "warn",
      issues: ["exposure and sharpness show no obvious issues (heuristic, for reference only)"],
      metrics: {
        darkClipRatio: 0,
        brightClipRatio: 0,
        sharpness: 0,
        background: null,
      },
    },
    faceGeometry: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SourceStep", () => {
  it("shows template label and file picker", () => {
    render(<SourceStep template={template} onReady={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Upload photo" })).toBeInTheDocument();
    expect(screen.getByText(/Selected template: US visa/)).toBeInTheDocument();
    expect(screen.getByTestId("file-input")).toBeInTheDocument();
  });

  it("loads the selected file and reports it ready (SRC-005: no network calls)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({} as Response);
    const onReady = vi.fn();
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    render(<SourceStep template={template} onReady={onReady} onBack={vi.fn()} />);

    selectFile(new File([new Uint8Array(4)], "photo.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(loadSourceImage).toHaveBeenCalledWith(expect.any(File));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("shows an explicit message for HEIC files", async () => {
    vi.mocked(loadSourceImage).mockRejectedValue(
      new SourceLoadError("heif-unsupported", "unsupported"),
    );
    render(<SourceStep template={template} onReady={vi.fn()} onBack={vi.fn()} />);

    selectFile(new File([new Uint8Array(4)], "photo.heic", { type: "image/heic" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HEIC/HEIF is not supported");
    expect(alert).toHaveTextContent("camera capture instead");
  });

  it("shows an error for oversized files and does not report ready", async () => {
    vi.mocked(loadSourceImage).mockRejectedValue(
      new SourceLoadError("file-too-large", "too large"),
    );
    const onReady = vi.fn();
    render(<SourceStep template={template} onReady={onReady} onBack={vi.fn()} />);

    selectFile(new File([new Uint8Array(1024)], "photo.jpg", { type: "image/jpeg" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("file size exceeds the limit");
    expect(onReady).not.toHaveBeenCalled();
  });

  it("goes back to template selection", () => {
    const onBack = vi.fn();
    render(<SourceStep template={template} onReady={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to choose another template" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
vi.mock("../pose/static-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pose/static-check")>();
  return { ...actual, runStaticCheck: vi.fn() };
});
