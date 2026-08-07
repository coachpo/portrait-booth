import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
import type { EditorState } from "../editor/edit-transform";
import { routes } from "../app/App";

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

const dispose = vi.fn();

function fakeSource(): SourceImage {
  return {
    file: new Blob([new Uint8Array(4)], { type: "image/jpeg" }),
    format: "jpeg",
    orientation: 1,
    rawWidth: 1200,
    rawHeight: 1200,
    width: 1200,
    height: 1200,
    bitmap: { width: 1200, height: 1200, close: vi.fn() } as unknown as ImageBitmap,
    previewUrl: "blob:fake",
    dispose,
  } as unknown as SourceImage;
}

const fakeArtifact = {
  artifactId: "a1",
  blob: new Blob([new Uint8Array(5000)], { type: "image/jpeg" }),
  coverage: { scannedPixels: 100, transparentPixels: 0 },
  manifest: {
    schemaVersion: 1 as const,
    templateId: "us",
    templateVersion: 1,
    widthPx: 600,
    heightPx: 600,
    mime: "image/jpeg" as const,
    orientationNormalized: true as const,
    matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    flipX: false,
  },
};

const saved = {
  key: "A7C2F9",
  keyDisplay: "A7C 2F9",
  deleteSecret: "secret-value-1234567890",
  expiresAt: "2026-09-05T10:00:00Z",
  template: { id: "us", version: 1 },
  photo: { width: 600, height: 600, mime: "image/jpeg" },
};

vi.mock("./template-step", () => ({
  TemplateStep: ({ onSelect }: { onSelect: (t: TemplateEntry) => void }) => (
    <button type="button" onClick={() => onSelect(template)}>
      Select this template
    </button>
  ),
}));

vi.mock("./source-step", () => ({
  SourceStep: ({ onReady, onBack }: { onReady: (s: SourceImage) => void; onBack: () => void }) => (
    <>
      <button type="button" onClick={() => onReady(fakeSource())}>
        Complete upload
      </button>
      <button type="button" onClick={onBack}>
        Upload step back
      </button>
    </>
  ),
}));

vi.mock("./capture-step", () => ({
  CaptureStep: ({ onReady }: { onReady: (s: SourceImage) => void }) => (
    <button type="button" onClick={() => onReady(fakeSource())}>
      Complete capture
    </button>
  ),
}));

vi.mock("../editor/editor-step", async () => {
  const { INITIAL_EDITOR_STATE } = await import("../editor/edit-transform");
  return {
    EditorStep: ({
      initialState,
      onDone,
      onBack,
    }: {
      initialState?: EditorState | null;
      onDone: (s: EditorState) => void;
      onBack: (s: EditorState) => void;
    }) => (
      <>
        <p>Editor: zoom {initialState?.transform.scale ?? "initial"}</p>
        <button
          type="button"
          onClick={() =>
            onDone({
              transform: { ...INITIAL_EDITOR_STATE.transform, scale: 1.75 },
              history: { undo: [INITIAL_EDITOR_STATE.transform], redo: [] },
            })
          }
        >
          Complete edit
        </button>
        <button type="button" onClick={() => onBack(INITIAL_EDITOR_STATE)}>
          Editor back
        </button>
      </>
    ),
  };
});

// Final render and check stubs; final-page and review-step stay real
vi.mock("../render/final-artifact", () => ({
  renderFinalArtifact: vi.fn(async () => fakeArtifact),
}));
vi.mock("../render/checks", () => ({
  buildChecks: vi.fn(async () => []),
}));
vi.mock("../api/save", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/save")>();
  return {
    ...actual,
    createSaveSession: vi.fn(),
    savePhoto: vi.fn(),
    deletePhoto: vi.fn(),
  };
});
vi.mock("../api/service-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/service-policy")>();
  return { ...actual, fetchServicePolicy: vi.fn() };
});

import { createSaveSession, deletePhoto, savePhoto } from "../api/save";
import { fetchServicePolicy } from "../api/service-policy";

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Walk the full flow to the final page and stage successfully */
async function walkToStaged() {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/create"] })} />);
  click("Select this template");
  click("Upload photo");
  click("Complete upload");
  click("Use this photo");
  click("Complete edit");
  await screen.findByRole("button", { name: "Stage and generate retrieval code" });
  click("Stage and generate retrieval code");
  click("Confirm and upload");
  await screen.findByText("A7C 2F9");
}

beforeEach(() => {
  vi.clearAllMocks();
  dispose.mockClear();
  vi.mocked(fetchServicePolicy).mockResolvedValue({
    temporaryStorageTtlSeconds: 2592000,
    retrievalMode: "key_only_ephemeral",
    maxUploadBytes: 15728640,
    policyVersion: 1,
  });
  vi.mocked(createSaveSession).mockResolvedValue(undefined);
  vi.mocked(savePhoto).mockResolvedValue(saved);
  vi.mocked(deletePhoto).mockResolvedValue(undefined);
});

describe("CreatePage staging receipt", () => {
  it("keeps the staging receipt when going back to editing and returning", async () => {
    // Regression: the receipt lived only in StagingPanel local state and
    // unmounted on back-to-edit, taking the retrieval code and delete secret
    // with it - an orphan photo nobody could delete
    await walkToStaged();

    click("Back to edit");
    click("Complete edit");

    expect(await screen.findByText("A7C 2F9")).toBeInTheDocument();
    expect(screen.getByText(/secret-value-1234567890/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download receipt/i })).toBeInTheDocument();
    // The server has no second photo from this round trip, and the panel
    // offers no second staging
    expect(savePhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Stage and generate retrieval code" })).toBeNull();
  });

  it("asks for confirmation before restart discards a staged receipt", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await walkToStaged();

      click("Restart");
      expect(confirm).toHaveBeenCalledTimes(1);
      // Cancel: nothing changes and the receipt stays
      expect(screen.getByText("A7C 2F9")).toBeInTheDocument();

      confirm.mockReturnValue(true);
      click("Restart");
      expect(screen.getByRole("button", { name: "Select this template" })).toBeInTheDocument();
    } finally {
      confirm.mockRestore();
    }
  });
});
