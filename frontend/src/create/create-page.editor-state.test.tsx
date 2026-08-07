import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { SourceImage } from "../image/source";
import type { TemplateEntry } from "../lib/templates/types";
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

// The source must be clearly larger than the template output (600×600)
// to avoid EDT-004 resolution warnings interfering
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
    <button type="button" onClick={() => onSelect(template)}>
      Select this template
    </button>
  ),
}));

vi.mock("./source-step", () => ({
  SourceStep: ({ onReady }: { onReady: (s: SourceImage) => void }) => (
    <button type="button" onClick={() => onReady(fakeSource())}>
      Complete upload
    </button>
  ),
}));

vi.mock("./capture-step", () => ({
  CaptureStep: () => <p>capture step stub</p>,
}));

vi.mock("../render/final-page", () => ({
  FinalPage: ({ onBack }: { onBack: () => void }) => (
    <>
      <p>Final page</p>
      <button type="button" onClick={onBack}>
        Back to edit
      </button>
    </>
  ),
}));

// EditorStep and ReviewStep use real implementations

function mount() {
  render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/create"] })} />);
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function walkToEditor() {
  mount();
  click("Select this template");
  click("Upload photo");
  click("Complete upload");
  click("Use this photo");
  expect(screen.getByRole("heading", { name: "Edit photo" })).toBeInTheDocument();
}

function scaleInput(): HTMLInputElement {
  return screen.getByLabelText("Zoom value") as HTMLInputElement;
}

describe("CreatePage edit-state retention (A4)", () => {
  it("keeps unsubmitted transform and undo history when returning from the editor", () => {
    // Regression: returning to the confirm page and back used to zero the
    // zoom/undo stack entirely
    walkToEditor();
    expect(scaleInput().value).toBe("1");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    fireEvent.change(scaleInput(), { target: { value: "1.6" } });
    click("Back to choose another photo");
    expect(screen.getByRole("heading", { name: "Confirm this photo" })).toBeInTheDocument();

    click("Use this photo");
    expect(scaleInput().value).toBe("1.6");
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("keeps the state committed at the last final-check submission", () => {
    // Second-commit scenario: back to the last committed point, not zeroed
    walkToEditor();
    fireEvent.change(scaleInput(), { target: { value: "1.6" } });
    click("Next (final checks)");
    expect(screen.getByText("Final page")).toBeInTheDocument();

    click("Back to edit");
    expect(scaleInput().value).toBe("1.6");
    fireEvent.change(scaleInput(), { target: { value: "2.4" } });

    click("Back to choose another photo");
    click("Use this photo");
    expect(scaleInput().value).toBe("2.4");
  });

  it("resets the editor state when the photo is actually replaced", () => {
    // Reverse-lock invariant 2: with the photo truly replaced, edit state
    // must be voided to zero
    walkToEditor();
    fireEvent.change(scaleInput(), { target: { value: "1.6" } });

    click("Back to choose another photo");
    click("Choose another file");
    click("Complete upload");
    click("Use this photo");

    expect(scaleInput().value).toBe("1");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });
});
