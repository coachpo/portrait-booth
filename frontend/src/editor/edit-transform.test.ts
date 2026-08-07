import { describe, expect, it } from "vitest";

import { applyTransform, type Transform2D } from "../image/exif";
import type { TemplateRevision } from "../lib/templates/types";
import {
  EditorState,
  reprojectEditorState,
  clampTranslation,
  coverScale,
  fitTransform,
  IDENTITY_TRANSFORM,
  invert,
  isValidTransform,
  MAX_SCALE,
  minScaleForRotation,
  normalizeRotationDeg,
  renderMatrix,
  allowedOutputSizes,
  resolveOutputSize,
  type EditTransform,
} from "./edit-transform";

const SRC = { width: 200, height: 100 };
const OUT = { width: 100, height: 100 };

function at(m: Transform2D, x: number, y: number): [number, number] {
  return applyTransform(m, x, y);
}

describe("cover math (§4.5.1)", () => {
  it("picks the larger axis ratio", () => {
    expect(coverScale({ width: 200, height: 100 }, { width: 100, height: 100 })).toBe(1);
    expect(coverScale({ width: 50, height: 100 }, { width: 100, height: 100 })).toBe(2);
    expect(coverScale({ width: 100, height: 200 }, { width: 100, height: 100 })).toBe(1);
  });

  it("centers a wider source", () => {
    const m = renderMatrix(IDENTITY_TRANSFORM, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([-50, 0]); // source left edge → outside the canvas on the left
    expect(at(m, 100, 50)).toEqual([50, 50]); // source center → canvas center
    expect(at(m, 200, 100)).toEqual([150, 100]); // source right edge → outside the canvas on the right
  });

  it("scales up a taller source to cover", () => {
    const m = renderMatrix(IDENTITY_TRANSFORM, { width: 50, height: 100 }, OUT);
    expect(at(m, 0, 0)).toEqual([0, -50]);
    expect(at(m, 50, 100)).toEqual([100, 150]);
  });
});

describe("renderMatrix composition (cover → scale → flipX → rotation → translation)", () => {
  it("applies user scale relative to cover around the canvas center", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, scale: 2 };
    const m = renderMatrix(t, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([-150, -50]); // source left edge → outside the canvas left
    expect(at(m, 100, 50)).toEqual([50, 50]); // center stays put
    expect(at(m, 200, 100)).toEqual([250, 150]);
  });

  it("mirrors horizontally around the canvas center", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, flipX: true };
    const m = renderMatrix(t, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([150, 0]); // source left edge → outside the canvas right
    expect(at(m, 100, 50)).toEqual([50, 50]); // center stays put
    expect(at(m, 200, 100)).toEqual([-50, 100]);
  });

  it("translates in normalized output units", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.5, translateY: -0.5 };
    const m = renderMatrix(t, SRC, OUT);
    expect(at(m, 0, 0)).toEqual([0, -50]);
    expect(at(m, 100, 50)).toEqual([100, 0]);
  });

  it("rotates around the canvas center (90°)", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, rotationDeg: 90 };
    const m = renderMatrix(t, SRC, OUT);
    const [cx, cy] = at(m, 100, 50);
    expect(cx).toBeCloseTo(50, 9); // center stays put
    expect(cy).toBeCloseTo(50, 9);
    // source (0,0) → cover+scale(-50,0) → rotate about center → (0,150)
    const [x, y] = at(m, 0, 0);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(150, 9);
  });

  it("composes all five operations in order", () => {
    const t: EditTransform = {
      translateX: 0.25,
      translateY: 0.1,
      scale: 1.5,
      rotationDeg: 90,
      flipX: true,
    };
    const m = renderMatrix(t, SRC, OUT);
    // source center (100,50) → cover to canvas center → all center-about
    // operations unchanged → only translation applies
    expect(at(m, 100, 50)).toEqual([75, 60]);
  });
});

describe("isValidTransform (EDT-003)", () => {
  it("accepts identity cover", () => {
    expect(isValidTransform(IDENTITY_TRANSFORM, SRC, OUT)).toBe(true);
  });

  it("rejects under-covered rotation", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, rotationDeg: 45 };
    expect(isValidTransform(t, SRC, OUT)).toBe(false);
  });

  it("accepts rotation once scale covers the rotated bounds", () => {
    const t: EditTransform = {
      ...IDENTITY_TRANSFORM,
      rotationDeg: 45,
      scale: 1.5,
    };
    expect(isValidTransform(t, { width: 300, height: 300 }, OUT)).toBe(true);
  });

  it("rejects translation that exposes an edge", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.75 };
    expect(isValidTransform(t, SRC, OUT)).toBe(false);
  });

  it("accepts x-translation at high scale (y is edge-bound)", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.5, translateY: 0, scale: 4 };
    expect(isValidTransform(t, SRC, OUT)).toBe(true);
  });

  it("rejects y-translation beyond cover at scale 1", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateY: 0.1 };
    expect(isValidTransform(t, SRC, OUT)).toBe(false);
  });
});

describe("clampTranslation (EDT-003)", () => {
  it("keeps valid transforms unchanged", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.2 };
    expect(clampTranslation(t, SRC, OUT)).toEqual(t);
  });

  it("projects an over-translated point back to the valid region", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 5, translateY: 5 };
    const c = clampTranslation(t, SRC, OUT);
    expect(isValidTransform(c, SRC, OUT)).toBe(true);
    expect(c.translateX).toBeLessThan(1);
    expect(c.scale).toBe(1);
  });

  it("clamps toward the nearest boundary along the center ray", () => {
    const t: EditTransform = { ...IDENTITY_TRANSFORM, translateX: 0.8 };
    const c = clampTranslation(t, SRC, OUT);
    // At exactly-cover, x can translate at most 0.5 (source width 200,
    // canvas 100, cover 1x)
    expect(c.translateX).toBeCloseTo(0.5, 3);
    expect(isValidTransform(c, SRC, OUT)).toBe(true);
  });
});

describe("invert", () => {
  it("round-trips a composed matrix", () => {
    const t: EditTransform = {
      translateX: 0.3,
      translateY: -0.2,
      scale: 2.5,
      rotationDeg: 30,
      flipX: true,
    };
    const m = renderMatrix(t, SRC, OUT);
    const inv = invert(m);
    for (const [x, y] of [
      [0, 0],
      [100, 50],
      [200, 100],
    ] as Array<[number, number]>) {
      const [mx, my] = at(m, x, y);
      const [bx, by] = at(inv, mx, my);
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
    }
  });
});

describe("normalizeRotationDeg", () => {
  it("wraps to (-180, 180]", () => {
    expect(normalizeRotationDeg(370)).toBe(10);
    expect(normalizeRotationDeg(-190)).toBe(170);
    expect(normalizeRotationDeg(90)).toBe(90);
    expect(normalizeRotationDeg(-90)).toBe(-90);
  });
});

describe("minScaleForRotation (EDT-003)", () => {
  // After cover the source exactly fits the output height; any nonzero
  // angle throws the crop corners outside the source
  const TIGHT_SRC = { width: 800, height: 600 };
  const TIGHT_OUT = { width: 500, height: 653 };

  it("leaves an already valid transform alone", () => {
    expect(minScaleForRotation(IDENTITY_TRANSFORM, TIGHT_SRC, TIGHT_OUT)).toBe(1);
  });

  it("returns a scale that makes a tilted crop valid again", () => {
    const tilted: EditTransform = { ...IDENTITY_TRANSFORM, rotationDeg: 5 };
    expect(isValidTransform(tilted, TIGHT_SRC, TIGHT_OUT)).toBe(false);

    const scale = minScaleForRotation(tilted, TIGHT_SRC, TIGHT_OUT)!;
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(isValidTransform({ ...tilted, scale }, TIGHT_SRC, TIGHT_OUT)).toBe(true);
  });

  it("needs a larger scale for a larger angle", () => {
    const small = minScaleForRotation(
      { ...IDENTITY_TRANSFORM, rotationDeg: 2 },
      TIGHT_SRC,
      TIGHT_OUT,
    )!;
    const large = minScaleForRotation(
      { ...IDENTITY_TRANSFORM, rotationDeg: 10 },
      TIGHT_SRC,
      TIGHT_OUT,
    )!;
    expect(large).toBeGreaterThan(small);
  });

  it("returns null when the allowed scale ceiling cannot cover the rotation", () => {
    // EDT-004 tightens the ceiling when source resolution is insufficient;
    // when the ceiling is not enough it must say "unsavable" instead of
    // returning a scale that is still out of bounds
    expect(
      minScaleForRotation({ ...IDENTITY_TRANSFORM, rotationDeg: 10 }, TIGHT_SRC, TIGHT_OUT, 1.05),
    ).toBeNull();
  });

  it("still solves a large angle when the ceiling allows it", () => {
    const scale = minScaleForRotation(
      { ...IDENTITY_TRANSFORM, rotationDeg: 45 },
      TIGHT_SRC,
      TIGHT_OUT,
    )!;
    expect(
      isValidTransform({ ...IDENTITY_TRANSFORM, rotationDeg: 45, scale }, TIGHT_SRC, TIGHT_OUT),
    ).toBe(true);
  });
});

describe("fitTransform", () => {
  const TIGHT_SRC = { width: 800, height: 600 };
  const TIGHT_OUT = { width: 500, height: 653 };

  it("turns a tilted, shifted transform into a valid one", () => {
    const messy: EditTransform = {
      ...IDENTITY_TRANSFORM,
      rotationDeg: 4,
      translateX: 0.3,
      translateY: -0.2,
    };
    const fitted = fitTransform(messy, TIGHT_SRC, TIGHT_OUT);
    expect(isValidTransform(fitted, TIGHT_SRC, TIGHT_OUT)).toBe(true);
    expect(fitted.rotationDeg).toBe(4);
  });

  it("keeps a valid transform unchanged", () => {
    expect(fitTransform(IDENTITY_TRANSFORM, TIGHT_SRC, TIGHT_OUT)).toEqual(IDENTITY_TRANSFORM);
  });
});

describe("allowedOutputSizes / resolveOutputSize (P6)", () => {
  function ranged(
    overrides: Partial<TemplateRevision["output"] & { allowedSizes?: unknown }> = {},
  ): TemplateRevision {
    return {
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
      output: {
        kind: "ranged_pixels",
        minWidthPx: 600,
        minHeightPx: 600,
        maxWidthPx: 1200,
        maxHeightPx: 1200,
        defaultWidthPx: 600,
        defaultHeightPx: 600,
        aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
        ...overrides,
      },
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
    } as unknown as TemplateRevision;
  }

  it("derives exactly [default, max] when allowedSizes is absent (P6)", () => {
    const sizes = allowedOutputSizes(ranged());
    expect(sizes).toEqual([
      { width: 600, height: 600 },
      { width: 1200, height: 1200 },
    ]);
  });

  it("dedupes when default equals max (P6)", () => {
    const sizes = allowedOutputSizes(ranged({ defaultWidthPx: 1200, defaultHeightPx: 1200 }));
    expect(sizes).toEqual([{ width: 1200, height: 1200 }]);
  });

  it("uses allowedSizes strictly, dropping items outside range or aspect (P6)", () => {
    const sizes = allowedOutputSizes(
      ranged({
        allowedSizes: [
          { widthPx: 600, heightPx: 600 },
          { widthPx: 800, heightPx: 800 },
          { widthPx: 1200, heightPx: 1200 },
          { widthPx: 1400, heightPx: 1400 }, // out of range
          { widthPx: 900, heightPx: 700 }, // breaks 1:1
        ],
      }),
    );
    expect(sizes).toEqual([
      { width: 600, height: 600 },
      { width: 800, height: 800 },
      { width: 1200, height: 1200 },
    ]);
  });

  it("returns [] for non-ranged kinds (P6)", () => {
    const exact = {
      ...ranged(),
      output: {
        kind: "exact_pixels",
        widthPx: 500,
        heightPx: 653,
        aspect: { width: 500, height: 653, enforcement: "mandatory", provenance: "derived" },
      },
    } as unknown as TemplateRevision;
    expect(allowedOutputSizes(exact)).toEqual([]);
    expect(resolveOutputSize(exact, { width: 999, height: 999 })).toEqual({
      width: 500,
      height: 653,
    });
  });

  it("falls back to default for empty, out-of-range, off-aspect or non-whitelisted selections (P6)", () => {
    const r = ranged();
    const fallback = { width: 600, height: 600 };
    expect(resolveOutputSize(r, null)).toEqual(fallback);
    expect(resolveOutputSize(r, undefined)).toEqual(fallback);
    expect(resolveOutputSize(r, { width: 1400, height: 1400 })).toEqual(fallback);
    expect(resolveOutputSize(r, { width: 1200, height: 600 })).toEqual(fallback);
    expect(resolveOutputSize(r, { width: 1200, height: 1200 })).toEqual({
      width: 1200,
      height: 1200,
    });
  });

  it("honors the whitelist when allowedSizes is present (P6)", () => {
    const r = ranged({
      allowedSizes: [{ widthPx: 800, heightPx: 800 }],
    });
    // 800 is in the whitelist but is neither default nor max: the
    // allowedSizes branch must adopt it
    expect(resolveOutputSize(r, { width: 800, height: 800 })).toEqual({
      width: 800,
      height: 800,
    });
    expect(resolveOutputSize(r, { width: 1200, height: 1200 })).toEqual({
      width: 600,
      height: 600,
    });
  });
});

describe("reprojectEditorState", () => {
  const SRC_1200 = { width: 1200, height: 1200 };

  function rev(
    width: number,
    height: number,
    mirror: "allowed" | "forbidden",
    rotate: "allowed" | "forbidden" = "allowed",
  ): TemplateRevision {
    return {
      revisionId: "t@1",
      id: "t",
      version: 1,
      schemaVersion: 1,
      label: { en: "test" },
      jurisdiction: "XX",
      documentType: "id",
      submissionChannel: "digital_upload",
      applicantClass: "adult",
      sources: [],
      output: {
        kind: "exact_pixels",
        widthPx: width,
        heightPx: height,
        aspect: { width, height, enforcement: "mandatory", provenance: "derived" },
      },
      cropRules: [],
      captureRules: [],
      overlay: { kind: "none", ruleIds: [] },
      capabilities: {
        selfCapture: "allowed",
        crop: "allowed",
        rotate,
        mirror,
        retouch: "forbidden",
        backgroundReplace: "forbidden",
        requiresOriginalCameraFile: false,
        requiresProfessionalPhotographer: false,
      },
      sourceNotes: {},
    } as unknown as TemplateRevision;
  }

  it("refits translation to the new output size", () => {
    const square = rev(600, 600, "forbidden");
    const state: EditorState = {
      transform: { translateX: 0.15, translateY: 0, scale: 1, rotationDeg: 0, flipX: false },
      history: { undo: [], redo: [] },
    };
    // Control: the original transform is genuinely valid under the wide
    // template (translateX ceiling ≈ 0.1667)
    expect(isValidTransform(state.transform, SRC_1200, { width: 600, height: 800 })).toBe(true);

    const { state: next, notes } = reprojectEditorState(state, SRC_1200, square);
    expect(next.transform.translateX).toBeCloseTo(0, 5);
    expect(next.transform.translateY).toBeCloseTo(0, 5);
    expect(isValidTransform(next.transform, SRC_1200, { width: 600, height: 600 })).toBe(true);
    expect(notes).toContain("refit");
    expect(notes).not.toContain("reset");
  });

  it("clears mirror and rotation forbidden by the new template", () => {
    const forbidden = rev(600, 600, "forbidden", "forbidden");
    const state: EditorState = {
      transform: { translateX: 0, translateY: 0, scale: 1, rotationDeg: 90, flipX: true },
      history: { undo: [], redo: [] },
    };
    const { state: next, notes } = reprojectEditorState(state, SRC_1200, forbidden);
    expect(next.transform.flipX).toBe(false);
    expect(next.transform.rotationDeg).toBe(0);
    expect(notes).toContain("mirror-cleared");
    expect(notes).toContain("rotation-cleared");
  });

  it("projects every history entry and keeps stack length", () => {
    const square = rev(600, 600, "forbidden");
    const undo = [
      { translateX: 0.15, translateY: 0, scale: 1, rotationDeg: 0, flipX: true },
      { translateX: 0, translateY: 0, scale: 1, rotationDeg: 0, flipX: false },
    ];
    const state: EditorState = {
      transform: undo[0],
      history: { undo, redo: [undo[1]] },
    };
    const { state: next } = reprojectEditorState(state, SRC_1200, square);
    expect(next.history.undo).toHaveLength(2);
    expect(next.history.redo).toHaveLength(1);
    for (const t of [...next.history.undo, ...next.history.redo]) {
      expect(isValidTransform(t, SRC_1200, { width: 600, height: 600 })).toBe(true);
      expect(t.flipX).toBe(false); // mirror normalized too
    }
  });

  it("leaves the transform untouched for portal templates", () => {
    const portal = {
      ...rev(600, 600, "allowed"),
      output: { kind: "guidance_only" },
    } as unknown as TemplateRevision;
    const state: EditorState = {
      transform: { translateX: 0.2, translateY: -0.1, scale: 2, rotationDeg: 30, flipX: true },
      history: { undo: [], redo: [] },
    };
    const { state: next, notes } = reprojectEditorState(state, SRC_1200, portal);
    expect(next.transform).toEqual(state.transform);
    expect(notes).toEqual([]);
  });
});
