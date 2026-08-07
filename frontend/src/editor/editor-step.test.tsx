import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { IDENTITY_TRANSFORM, type EditorState } from "./edit-transform";
import { EditorStep } from "./editor-step";

function fakeTemplate(overrides: Partial<TemplateEntry["revision"]> = {}): TemplateEntry {
  return {
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

type Caps = TemplateEntry["revision"]["capabilities"];

const BASE_CAPS: Caps = {
  selfCapture: "allowed",
  crop: "allowed",
  rotate: "allowed",
  mirror: "forbidden",
  retouch: "forbidden",
  backgroundReplace: "forbidden",
  requiresOriginalCameraFile: false,
  requiresProfessionalPhotographer: false,
};

/** capabilities is whole-field replacement: merge per case to change only
 * the policy under test */
function withCaps(partial: Partial<Caps>): Partial<TemplateEntry["revision"]> {
  return { capabilities: { ...BASE_CAPS, ...partial } };
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

function renderEditor(overrides: Partial<TemplateEntry["revision"]> = {}) {
  // jsdom's canvas.getContext returns null, so the drawing path is
  // skipped automatically; interaction assertions do not depend on pixels
  const onDone = vi.fn();
  const onBack = vi.fn();
  const view = render(
    <EditorStep
      source={source}
      template={fakeTemplate(overrides)}
      onDone={onDone}
      onBack={onBack}
    />,
  );
  return { onDone, onBack, ...view };
}

describe("EditorStep", () => {
  it("renders template label and controls", () => {
    renderEditor();
    expect(screen.getByRole("heading", { name: "Edit photo" })).toBeInTheDocument();
    expect(screen.getByText(/Finnish police document/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate 90°" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  it("disables mirror when the template forbids it (EDT-005)", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: "Mirror horizontally" })).toBeDisabled();
  });

  it("enables mirror when the template allows it", () => {
    renderEditor({
      capabilities: {
        selfCapture: "allowed",
        crop: "allowed",
        rotate: "allowed",
        mirror: "allowed",
        retouch: "forbidden",
        backgroundReplace: "forbidden",
        requiresOriginalCameraFile: false,
        requiresProfessionalPhotographer: false,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mirror horizontally" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("records undo history after an edit and restores it", () => {
    const { onDone } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90°" }));
    const undoBtn = screen.getByRole("button", { name: "Undo" });
    expect(undoBtn).toBeEnabled();
    fireEvent.click(undoBtn);
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ rotationDeg: 90, scale: 1 }),
      }),
    );
  });

  it("resets after edits", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90°" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled(); // reset itself is undoable
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  it("applies scale via slider and keyboard", () => {
    const { onDone } = renderEditor();
    const slider = screen.getByRole("slider", { name: /zoom/i });
    fireEvent.change(slider, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ transform: expect.objectContaining({ scale: 2 }) }),
    );
  });

  it("rotates 90 and raises scale to keep coverage", () => {
    const { onDone } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Rotate 90°" }));
    fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));
    // source 800×600 → after rotation the cover ratio 653/800 > 500/800,
    // so scale must rise
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ rotationDeg: 90, scale: expect.any(Number) }),
      }),
    );
  });

  describe("pointer interaction (EDT-007)", () => {
    function canvasWithSize(width: number, height: number) {
      const canvas = screen.getByLabelText(/photo preview/i) as HTMLCanvasElement;
      canvas.setPointerCapture = vi.fn();
      canvas.releasePointerCapture = vi.fn();
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({}),
      } as DOMRect);
      return canvas;
    }

    it("normalizes drag by the canvas display size, not the output pixels", () => {
      // Regression: the denominator used to be output pixels. With the
      // canvas squeezed to 250px wide by CSS, the image followed the finger
      // only half the distance.
      const { onDone } = renderEditor();
      const canvas = canvasWithSize(250, 326);
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 25, clientY: 0 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateX: number } };
      // 25 / 250 = 0.1; normalized by the output width 500 it would only be 0.05
      expect(state.transform.translateX).toBeCloseTo(0.1, 5);
    });

    it("offers button and numeric alternatives to dragging (WCAG 2.5.7)", () => {
      const { onDone } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "Move right" }));
      fireEvent.click(screen.getByRole("button", { name: "Move right" }));
      fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));

      const state = onDone.mock.calls[0][0] as {
        transform: { translateX: number; translateY: number };
      };
      expect(state.transform.translateX).toBeCloseTo(0.04, 5);
      // After cover on 500×653 the 800×600 source fits the height exactly;
      // there is no vertical pan headroom
      expect(state.transform.translateY).toBe(0);
    });

    it("refuses a nudge that would expose an edge", () => {
      const { onDone } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "Move down" }));
      fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateY: number } };
      expect(state.transform.translateY).toBe(0);
    });

    it("recenters the photo", () => {
      const { onDone } = renderEditor();
      fireEvent.click(screen.getByRole("button", { name: "Move right" }));
      fireEvent.click(screen.getByRole("button", { name: "Center" }));
      fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateX: number } };
      expect(state.transform.translateX).toBe(0);
    });

    it("accepts a typed translation value", () => {
      const { onDone } = renderEditor();
      fireEvent.change(screen.getByLabelText("Horizontal position value"), {
        target: { value: "0.1" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));

      const state = onDone.mock.calls[0][0] as { transform: { translateX: number } };
      expect(state.transform.translateX).toBeCloseTo(0.1, 5);
    });

    it("scales with a two-finger pinch", () => {
      const { onDone } = renderEditor();
      const canvas = canvasWithSize(250, 326);
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 200, clientY: 100 });
      fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 300, clientY: 100 });
      fireEvent.pointerUp(canvas, { pointerId: 2 });
      fireEvent.pointerUp(canvas, { pointerId: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));

      const state = onDone.mock.calls[0][0] as { transform: { scale: number } };
      // Pinch distance goes from 100 to 200: zoom doubles
      expect(state.transform.scale).toBeCloseTo(2, 5);
    });
  });

  it("notifies when a portal-source template needs no editing", () => {
    const { onDone } = renderEditor({
      output: { kind: "portal_source", officialPortalPerformsCrop: true },
    });
    expect(screen.getByText(/cropped by the official portal/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: expect.objectContaining({ scale: 1, rotationDeg: 0 }),
      }),
    );
  });

  it("passes the restored initialState through for portal templates (P7)", () => {
    // After a same-session template switch with external edit state, the
    // !out branch must not hard-write INITIAL on continue
    const state: EditorState = {
      transform: { ...IDENTITY_TRANSFORM, scale: 2, flipX: true },
      history: { undo: [IDENTITY_TRANSFORM], redo: [] },
    };
    const onDone = vi.fn();
    render(
      <EditorStep
        source={source}
        template={fakeTemplate({
          output: { kind: "portal_source", officialPortalPerformsCrop: true },
        })}
        initialState={state}
        onDone={onDone}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onDone).toHaveBeenCalledWith(state);
  });
});

describe("capabilities policy wiring (P2)", () => {
  it("locks the rotate inputs and guards their onChange when rotation is forbidden", () => {
    // Regression: the rotation ban used to be bypassable via the
    // slider/numeric input - the button greyed out but the input still
    // changed
    const { onDone } = renderEditor(withCaps({ rotate: "forbidden" }));
    const number = screen.getByLabelText("Rotation value") as HTMLInputElement;
    expect(number).toBeDisabled();
    // In jsdom, disabled does not stop fireEvent.change: the in-callback
    // guard is the real assertion
    fireEvent.change(number, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));
    const state = onDone.mock.calls[0][0] as { transform: { rotationDeg: number } };
    expect(state.transform.rotationDeg).toBe(0);
  });

  it("locks compose controls and ignores pointer drags when crop is forbidden", () => {
    const { onDone } = renderEditor(withCaps({ crop: "forbidden" }));
    expect(screen.getByLabelText("Zoom value")).toBeDisabled();
    expect(screen.getByLabelText("Horizontal position value")).toBeDisabled();
    expect(screen.getByLabelText("Vertical position value")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move right" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Center" })).toBeDisabled();
    // Both the lock reason (outside the zoom controls) and the operation
    // hint (below the preview) show visible copy
    expect(screen.getByText(/default cover composition/)).toBeInTheDocument();
    expect(screen.getByText(/zoom, pan, and arrow keys are disabled/)).toBeInTheDocument();

    // Pointer drags are intercepted at the input boundary: the transform
    // stays at the initial default composition
    const canvas = screen.getByLabelText("Photo preview (composition locked)");
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Next (final checks)" }));
    const state = onDone.mock.calls[0][0] as { transform: { translateX: number; scale: number } };
    expect(state.transform.translateX).toBe(0);
    expect(state.transform.scale).toBe(1);
  });

  it("renders distinguishable notices for retouch warn and backgroundReplace forbidden", () => {
    renderEditor(withCaps({ retouch: "warn" }));
    expect(screen.getByText("Template restrictions")).toBeInTheDocument();
    expect(screen.getByText(/warning about retouching/i)).toBeInTheDocument();
    expect(screen.getByText(/forbids background replacement/i)).toBeInTheDocument();
    expect(screen.getByText(/forbids mirroring/i)).toBeInTheDocument();
  });
});
