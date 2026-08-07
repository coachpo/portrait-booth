import { act, fireEvent, render, screen } from "@testing-library/react";
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

// P7 template-switch fixtures: wide template A (600×800, mirror allowed)
// via "Select this template"; base template B (600×600, mirror forbidden)
// via "Select the square template"
const wideTemplate = {
  ...template,
  revision: {
    ...template.revision,
    output: {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 800,
      aspect: { width: 600, height: 800, enforcement: "mandatory", provenance: "derived" },
    },
    capabilities: { ...template.revision.capabilities, mirror: "allowed" },
  },
} as unknown as TemplateEntry;

// Prerequisite-constraint template: requires* booleans true (the source
// step should show the hints)
const restrictedTemplate = {
  ...template,
  revision: {
    ...template.revision,
    revisionId: "restricted@1",
    capabilities: {
      ...template.revision.capabilities,
      requiresOriginalCameraFile: true,
      requiresProfessionalPhotographer: true,
    },
  },
} as unknown as TemplateEntry;

// Composition-locked template: crop forbidden (inherited composition must
// be voided on switch)
const lockedTemplate = {
  ...template,
  revision: {
    ...template.revision,
    revisionId: "locked@1",
    capabilities: { ...template.revision.capabilities, crop: "forbidden" },
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

vi.mock("./template-step", () => ({
  TemplateStep: ({ onSelect }: { onSelect: (t: TemplateEntry) => void }) => (
    <>
      <button type="button" onClick={() => onSelect(wideTemplate)}>
        Select this template
      </button>
      <button type="button" onClick={() => onSelect(template)}>
        Select the square template
      </button>
      <button type="button" onClick={() => onSelect(restrictedTemplate)}>
        Select the restricted template
      </button>
      <button type="button" onClick={() => onSelect(lockedTemplate)}>
        Select the locked template
      </button>
    </>
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

const editorMockState = vi.hoisted(() => ({ lastDone: null as EditorState | null }));

vi.mock("../editor/editor-step", async () => {
  const { INITIAL_EDITOR_STATE } = await import("../editor/edit-transform");
  const finish = (s: EditorState, onDone: (s: EditorState) => void) => {
    editorMockState.lastDone = s;
    onDone(s);
  };
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
        <p>Undo stack {initialState?.history.undo.length ?? 0}</p>
        <p data-testid="editor-translateX">{initialState?.transform.translateX ?? 0}</p>
        <p data-testid="editor-flipX">{initialState?.transform.flipX ? "on" : "off"}</p>
        <button
          type="button"
          onClick={() =>
            finish(
              {
                transform: { ...INITIAL_EDITOR_STATE.transform, scale: 1.75 },
                history: { undo: [INITIAL_EDITOR_STATE.transform], redo: [] },
              },
              onDone,
            )
          }
        >
          Complete edit
        </button>
        <button
          type="button"
          onClick={() =>
            finish(
              {
                transform: {
                  translateX: 0.15,
                  translateY: 0,
                  scale: 1,
                  rotationDeg: 0,
                  flipX: false,
                },
                history: { undo: [], redo: [] },
              },
              onDone,
            )
          }
        >
          Complete edit with pan
        </button>
        <button
          type="button"
          onClick={() =>
            finish(
              {
                transform: {
                  ...INITIAL_EDITOR_STATE.transform,
                  flipX: true,
                },
                history: { undo: [], redo: [] },
              },
              onDone,
            )
          }
        >
          Complete edit with mirror
        </button>
        <button
          type="button"
          onClick={() => onBack(editorMockState.lastDone ?? INITIAL_EDITOR_STATE)}
        >
          Editor back
        </button>
      </>
    ),
  };
});

vi.mock("../render/final-page", () => {
  const saved = {
    key: "ABC123",
    keyDisplay: "ABC-123",
    deleteSecret: "secret-value-1234567890",
    expiresAt: "2026-09-05T10:00:00Z",
    template: { id: "us", version: 1 },
    photo: { width: 600, height: 600, mime: "image/jpeg" },
  };
  return {
    FinalPage: ({
      onBack,
      onRestart,
      onStaged,
    }: {
      onBack: () => void;
      onRestart: () => void;
      onStaged: (r: { saved: typeof saved; idempotencyKey: string } | null) => void;
    }) => (
      <>
        <p>Final page</p>
        <button type="button" onClick={onBack}>
          Back to edit
        </button>
        <button type="button" onClick={onRestart}>
          Restart
        </button>
        <button type="button" onClick={() => onStaged({ saved, idempotencyKey: "k" })}>
          Simulate staged
        </button>
      </>
    ),
  };
});

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** Mount with the real Layout navigation and route-blocker scaffold
 * (useBlocker needs a data-router context) */
function mount() {
  const router = createMemoryRouter(routes, { initialEntries: ["/create"] });
  render(<RouterProvider router={router} />);
  return router;
}

/** The common path to the editor */
function walkToEditor() {
  mount();
  click("Select this template");
  click("Upload photo");
  click("Complete upload");
  click("Use this photo");
}

beforeEach(() => {
  dispose.mockClear();
  editorMockState.lastDone = null;
});

describe("CreatePage state machine", () => {
  it("shows a progress bar with the current step", () => {
    mount();
    const bar = screen.getByRole("list", { name: "Creation progress" });
    expect(bar).toBeInTheDocument();
    expect(screen.getByText("1. Choose template").getAttribute("aria-current")).toBe("step");
  });

  it("inserts a review step between capture and the editor (SPEC flow)", () => {
    // Regression: after capture or upload it used to jump straight into the
    // editor with no chance to confirm or retake
    mount();
    click("Select this template");
    click("Use camera capture");
    click("Complete capture");
    expect(screen.getByRole("heading", { name: "Confirm this photo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retake" })).toBeInTheDocument();
  });

  it("labels the retake action by where the photo came from", () => {
    walkToEditor();
    click("Editor back");
    expect(screen.getByRole("button", { name: "Choose another file" })).toBeInTheDocument();
  });

  it("keeps transform and undo history when returning from the final page", () => {
    // Regression: returning from final to edit used to drop all crop
    // parameters and the undo stack, restarting from scratch
    walkToEditor();
    expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();

    click("Complete edit");
    expect(screen.getByText("Final page")).toBeInTheDocument();

    click("Back to edit");
    expect(screen.getByText("Editor: zoom 1.75")).toBeInTheDocument();
    expect(screen.getByText("Undo stack 1")).toBeInTheDocument();
  });

  it("keeps the photo when stepping back from the editor to review", () => {
    walkToEditor();
    click("Editor back");
    expect(screen.getByRole("heading", { name: "Confirm this photo" })).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("drops the editor state when the photo itself is replaced", () => {
    walkToEditor();
    click("Complete edit");
    click("Back to edit");
    expect(screen.getByText("Editor: zoom 1.75")).toBeInTheDocument();

    click("Editor back");
    click("Choose another file");
    expect(dispose).toHaveBeenCalled();
    click("Complete upload");
    click("Use this photo");
    expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();
  });

  it("returns to the template step on restart", () => {
    walkToEditor();
    click("Complete edit");
    click("Restart");
    expect(screen.getByRole("button", { name: "Select this template" })).toBeInTheDocument();
    expect(screen.getByText("1. Choose template").getAttribute("aria-current")).toBe("step");
  });

  it("advances the progress bar as the flow moves forward", () => {
    walkToEditor();
    expect(screen.getByText("4. Edit").getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("1. Choose template").className).toContain("done");
  });
});

describe("leave-flow interception (A11)", () => {
  it.each(["Retrieve photo", "Privacy", "Portrait Booth", "Privacy & retention"])(
    "blocks leaving via the %s link and keeps the flow intact",
    (exit) => {
      // Regression: any of the four exits used to silently unmount,
      // evaporating photo/crop/undo stack
      walkToEditor();

      fireEvent.click(screen.getByRole("link", { name: exit }));
      // The edit step is still there, nothing is disposed, and an in-app
      // confirm block appears
      expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();
      expect(dispose).not.toHaveBeenCalled();
      expect(screen.getByRole("alertdialog")).toHaveTextContent(/unsaved/i);

      fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it("releases resources only after confirming the leave", () => {
    walkToEditor();
    fireEvent.click(screen.getByRole("link", { name: "Retrieve photo" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue leaving" }));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Retrieve photo" })).toBeInTheDocument();
  });

  it("names the retrieval code and delete secret in the staged leave confirmation", () => {
    // When staged, the confirmation copy must name the retrieval code and
    // delete secret as unrecoverable and offer the receipt download in place
    mount();
    click("Select this template");
    click("Upload photo");
    click("Complete upload");
    click("Use this photo");
    click("Complete edit");
    fireEvent.click(screen.getByRole("button", { name: "Simulate staged" }));

    fireEvent.click(screen.getByRole("link", { name: "Retrieve photo" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("retrieval code");
    expect(dialog).toHaveTextContent("delete secret");
    expect(dialog).toHaveTextContent("cannot be recovered");
    expect(screen.getByRole("button", { name: /download receipt/i })).toBeInTheDocument();
  });

  it("does not silently drop the flow on the browser back gesture", async () => {
    const router = createMemoryRouter(routes, {
      initialEntries: ["/", "/create"],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);
    click("Select this template");
    click("Upload photo");
    click("Complete upload");
    click("Use this photo");

    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/unsaved/i);
  });

  it("does not block when navigating to the same route", () => {
    // Anti-overfix: clicking "Create photo" while already on /create shows no confirm
    walkToEditor();
    fireEvent.click(screen.getByRole("link", { name: "Create photo" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
    expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();
  });
});

describe("same-session template switch (P7)", () => {
  function toReviewWithEdits(editButton: string) {
    walkToEditor();
    click(editButton); // submit an edit state → final
    click("Back to edit"); // back to the editor; initialState carries the state
    click("Editor back"); // back to confirm; state written back via onBack
  }

  it("keeps the photo and editor state when switching templates", () => {
    // Regression: the state machine had no template-switch transition;
    // switching meant the back chain that disposes the source photo
    toReviewWithEdits("Complete edit");

    click("Switch template");
    click("Select this template");
    expect(dispose).not.toHaveBeenCalled();

    click("Use this photo");
    expect(screen.getByText("Editor: zoom 1.75")).toBeInTheDocument();
    expect(screen.getByText("Undo stack 1")).toBeInTheDocument();
  });

  it("reprojects the kept transform to the new output size", () => {
    // Without projection, the pan valid only at 600×800 would be carried
    // into 600×600 and hit out-of-bounds at the final page
    toReviewWithEdits("Complete edit with pan"); // translateX 0.15, valid under the wide template (ceiling ≈ 0.1667)

    click("Switch template");
    click("Select the square template"); // 600×600: pan must zero out

    click("Use this photo");
    expect(screen.getByTestId("editor-translateX").textContent).toBe("0");
  });

  it("clears the mirror forbidden by the new template and shows a notice", () => {
    // Mirror enabled under A (mirror allowed); switching to B (mirror
    // forbidden) must cancel it and say so
    toReviewWithEdits("Complete edit with mirror");

    click("Switch template");
    click("Select the square template");
    expect(screen.getByRole("status")).toHaveTextContent(
      "the new template forbids mirroring; horizontal mirror was cancelled",
    );

    click("Use this photo");
    expect(screen.getByTestId("editor-flipX").textContent).toBe("off");
  });

  it("abandons the template switch without losing anything", () => {
    toReviewWithEdits("Complete edit");

    click("Switch template");
    click("Back (keep current template)");
    expect(dispose).not.toHaveBeenCalled();

    click("Use this photo");
    expect(screen.getByText("Editor: zoom 1.75")).toBeInTheDocument();
    expect(screen.getByText("Undo stack 1")).toBeInTheDocument();
  });

  it("shows source requirements on the source step (P2)", () => {
    mount();
    click("Select the restricted template");
    expect(screen.getByText(/certified photographer/i)).toBeInTheDocument();
    expect(screen.getByText(/original camera file/i)).toBeInTheDocument();
  });

  it("discards inherited compose when the new template forbids cropping (P2)", () => {
    // The composition lock must not be bypassed by an inherited
    // composition: switching to a crop-forbidden template must reset
    toReviewWithEdits("Complete edit");
    click("Switch template");
    click("Select the locked template");
    expect(screen.getByRole("status")).toHaveTextContent("forbids adjusting composition");
    click("Use this photo");
    expect(screen.getByText("Editor: zoom initial")).toBeInTheDocument();
  });
});
