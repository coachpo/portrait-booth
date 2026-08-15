import { describe, expect, it } from "vitest";

import type { MeasurementRule, TemplateRevision } from "../lib/templates/types";
import type { FaceAnchors } from "../pose/face-geometry";
import { HEURISTIC_NOTICE } from "./check-types";
import type { FinalManifest } from "./final-artifact";
import { geometryChecks } from "./geometry-checks";

/** fi-police-digital@1's real numbers: 500×653 output, head 445-500 px,
 * face center line within ±21 px of the photo center line. */
const HEAD_HEIGHT: MeasurementRule = {
  id: "fi-head-height",
  metric: "head_height",
  min: 445,
  max: 500,
  unit: "px",
  anchors: ["crown_point", "chin_tip"],
  axis: "y",
  bounds: "inclusive",
  coordinateSpace: "output_pixel_top_left",
  evaluation: "automatic_with_manual_confirmation",
  enforcement: "mandatory",
  provenance: "source_literal",
  sourceRefs: ["poliisi-photo-instructions"],
  sourceLiteral: "32-36 mm crown point (without hair/beard) to chin tip",
};

const CENTER_OFFSET: MeasurementRule = {
  id: "fi-face-center-offset",
  metric: "face_center_offset_x",
  min: -21,
  max: 21,
  unit: "px",
  anchors: ["face_center_line", "photo_center_line"],
  axis: "x",
  bounds: "inclusive",
  coordinateSpace: "output_pixel_top_left",
  evaluation: "automatic_with_manual_confirmation",
  enforcement: "mandatory",
  provenance: "source_literal",
  sourceRefs: ["poliisi-photo-instructions"],
  sourceLiteral: "deviation of face centre line from photo centre line at most 1.5 mm",
};

const CHIN_BOTTOM: MeasurementRule = {
  id: "fi-chin-bottom-margin",
  metric: "chin_bottom_margin",
  min: 96,
  max: 124,
  unit: "px",
  anchors: ["chin_tip"],
  axis: "y",
  bounds: "inclusive",
  coordinateSpace: "output_pixel_top_left",
  evaluation: "automatic_with_manual_confirmation",
  enforcement: "mandatory",
  provenance: "source_literal",
  sourceRefs: ["poliisi-photo-instructions"],
  sourceLiteral: "7-9 mm chin tip to bottom edge",
};

/** us-visa-digital@1 states this one as a ratio of the output height */
const EYE_LINE: MeasurementRule = {
  id: "us-visa-eye-line",
  metric: "eye_line_from_bottom",
  min: 0.56,
  max: 0.69,
  unit: "ratio",
  anchors: ["eye_line"],
  axis: "y",
  bounds: "inclusive",
  coordinateSpace: "output_normalized_top_left",
  evaluation: "automatic_with_manual_confirmation",
  enforcement: "mandatory",
  provenance: "source_literal",
  sourceRefs: ["us-visa-photo-requirements"],
  sourceLiteral: "eye height between 56% and 69% of the image height measured from the bottom",
};

function revision(cropRules: MeasurementRule[]): TemplateRevision {
  return {
    output: {
      kind: "exact_pixels",
      widthPx: 500,
      heightPx: 653,
      aspect: { width: 500, height: 653, enforcement: "mandatory", provenance: "derived" },
    },
    cropRules,
  } as unknown as TemplateRevision;
}

/** Source 1000×1306 → output 500×653: a plain 0.5 downscale, no rotation. */
function manifest(matrix: FinalManifest["matrix"] = [0.5, 0, 0, 0.5, 0, 0]): FinalManifest {
  return { widthPx: 500, heightPx: 653, matrix } as unknown as FinalManifest;
}

/** Source-pixel anchors; defaults put the face dead center with a 400 px
 * hairline-to-chin span in the output. */
function anchors(overrides: Partial<FaceAnchors> = {}): FaceAnchors {
  return {
    chinTip: { x: 500, y: 1100 },
    hairline: { x: 500, y: 300 },
    faceCenter: { x: 500, y: 700 },
    eyeLine: { x: 500, y: 700 },
    ...overrides,
  };
}

function byId(items: ReturnType<typeof geometryChecks>, id: string) {
  const item = items.find((i) => i.id === `crop:${id}`);
  if (!item) throw new Error(`missing check crop:${id}`);
  return item;
}

describe("cropRules geometry checks (EDT-008)", () => {
  it("passes a centered face and reports the measured offset", () => {
    const items = geometryChecks(revision([CENTER_OFFSET]), manifest(), anchors());
    const item = byId(items, "fi-face-center-offset");
    expect(item.status).toBe("pass");
    expect(item.detail).toContain("0.0 px");
    expect(item.detail).toContain(HEURISTIC_NOTICE);
  });

  it("warns with a direction when the face center line leaves the tolerance", () => {
    // Source x 600 → output x 300; 50 px right of the 250 px center line
    const items = geometryChecks(
      revision([CENTER_OFFSET]),
      manifest(),
      anchors({ faceCenter: { x: 600, y: 700 } }),
    );
    const item = byId(items, "fi-face-center-offset");
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("50.0 px right");
    // The editor pans the photo, so a face on the right is fixed by moving the
    // photo left - advising "move right" would send the user the wrong way
    expect(item.detail).toContain("move the photo left");
  });

  it("advises the opposite pan direction for a face left of center", () => {
    const items = geometryChecks(
      revision([CENTER_OFFSET]),
      manifest(),
      anchors({ faceCenter: { x: 400, y: 700 } }),
    );
    const item = byId(items, "fi-face-center-offset");
    expect(item.detail).toContain("50.0 px left");
    expect(item.detail).toContain("move the photo right");
  });

  it("measures the offset in output space, so a mirrored artifact flips the side", () => {
    // flipX folded into the matrix: out.x = -0.5 * src.x + 500
    const items = geometryChecks(
      revision([CENTER_OFFSET]),
      manifest([-0.5, 0, 0, 0.5, 500, 0]),
      anchors({ faceCenter: { x: 600, y: 700 } }),
    );
    const item = byId(items, "fi-face-center-offset");
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("50.0 px left");
  });

  it("honors rotation when mapping anchors to output pixels", () => {
    // 90° rotation about the origin plus a +500 px x shift keeps the point on
    // canvas: out = (-0.5 * src.y + 500, 0.5 * src.x)
    const items = geometryChecks(
      revision([CENTER_OFFSET]),
      manifest([0, 0.5, -0.5, 0, 500, 0]),
      anchors({ faceCenter: { x: 500, y: 700 } }),
    );
    const item = byId(items, "fi-face-center-offset");
    // out.x = -0.5 * 700 + 500 = 150 → 100 px left of center
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("100.0 px left");
  });

  it("never passes head height: the crown is above the model's topmost landmark", () => {
    // Hairline-to-chin span is 400 px in the output - inside neither bound can
    // be confirmed, because the crown adds an unmeasured amount on top
    const items = geometryChecks(revision([HEAD_HEIGHT]), manifest(), anchors());
    const item = byId(items, "fi-head-height");
    expect(item.status).toBe("unknown");
    expect(item.detail).toContain("400 px");
    expect(item.detail).toContain("445-500 px");
    expect(item.detail).toContain("crown");
    expect(item.detail).toContain("manual confirmation");
  });

  it("stays unknown even when the measured span sits inside the allowed range", () => {
    // Span 460 px is within 445-500, but the true head is taller than measured,
    // so a pass would be fabricated
    const items = geometryChecks(
      revision([HEAD_HEIGHT]),
      manifest(),
      anchors({ chinTip: { x: 500, y: 1120 }, hairline: { x: 500, y: 200 } }),
    );
    expect(byId(items, "fi-head-height").status).toBe("unknown");
  });

  it("warns when the span already exceeds the maximum before counting the crown", () => {
    // Span 600 px > 500 px: adding the unmeasured crown can only make it worse
    const items = geometryChecks(
      revision([HEAD_HEIGHT]),
      manifest(),
      anchors({ chinTip: { x: 500, y: 1300 }, hairline: { x: 500, y: 100 } }),
    );
    const item = byId(items, "fi-head-height");
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("600 px");
    expect(item.detail).toContain("crop tighter");
  });

  it("reports handled rules as unchecked when the recheck produced no anchors", () => {
    const items = geometryChecks(revision([HEAD_HEIGHT, CENTER_OFFSET]), manifest(), null);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.status).toBe("unknown");
      expect(item.detail).toContain("no face landmarks");
    }
    // The official wording still travels with the unchecked item
    expect(byId(items, "fi-head-height").detail).toContain("crown point (without hair/beard)");
  });

  it("skips metrics this module does not consume", () => {
    const faceWidth: MeasurementRule = {
      ...HEAD_HEIGHT,
      id: "fi-face-width",
      metric: "face_width",
    };
    const items = geometryChecks(revision([faceWidth]), manifest(), anchors());
    expect(items).toHaveLength(0);
  });

  it("passes chin-to-bottom when the chin sits inside the allowed band", () => {
    // Source y 1100 → output y 550; 653 - 550 = 103 px, inside 96-124
    const item = byId(
      geometryChecks(revision([CHIN_BOTTOM]), manifest(), anchors()),
      "fi-chin-bottom-margin",
    );
    expect(item.status).toBe("pass");
    expect(item.detail).toContain("chin tip sits 103 px above the bottom edge");
    expect(item.detail).toContain("96-124 px");
  });

  it("tells the user to pan up when the chin sits too close to the bottom", () => {
    // Source y 1200 → output y 600; only 53 px of margin left
    const item = byId(
      geometryChecks(
        revision([CHIN_BOTTOM]),
        manifest(),
        anchors({ chinTip: { x: 500, y: 1200 } }),
      ),
      "fi-chin-bottom-margin",
    );
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("53 px");
    expect(item.detail).toContain("move the photo up");
  });

  it("tells the user to pan down when the chin sits too far from the bottom", () => {
    // Source y 900 → output y 450; 203 px of margin, above the 124 px ceiling
    const item = byId(
      geometryChecks(revision([CHIN_BOTTOM]), manifest(), anchors({ chinTip: { x: 500, y: 900 } })),
      "fi-chin-bottom-margin",
    );
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("203 px");
    expect(item.detail).toContain("move the photo down");
  });

  it("measures the eye line against ratio bounds resolved on the output height", () => {
    // Source y 500 → output y 250; 403 px above the bottom, inside
    // 0.56-0.69 of 653 px (366-451)
    const item = byId(
      geometryChecks(revision([EYE_LINE]), manifest(), anchors({ eyeLine: { x: 500, y: 500 } })),
      "us-visa-eye-line",
    );
    expect(item.status).toBe("pass");
    expect(item.detail).toContain("eye line sits 403 px above the bottom edge");
    expect(item.detail).toContain("366-451 px");
  });

  it("warns when the eye line falls below the allowed band", () => {
    // Source y 900 → output y 450; only 203 px above the bottom
    const item = byId(
      geometryChecks(revision([EYE_LINE]), manifest(), anchors({ eyeLine: { x: 500, y: 900 } })),
      "us-visa-eye-line",
    );
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("move the photo up");
  });

  it("uses the chin anchor for the chin rule and the eye anchor for the eye rule", () => {
    // Distinct anchors must not be swapped: chin 103 px, eye line 403 px
    const items = geometryChecks(
      revision([CHIN_BOTTOM, EYE_LINE]),
      manifest(),
      anchors({ eyeLine: { x: 500, y: 500 } }),
    );
    expect(byId(items, "fi-chin-bottom-margin").detail).toContain("chin tip sits 103 px");
    expect(byId(items, "us-visa-eye-line").detail).toContain("eye line sits 403 px");
  });

  it("labels every item with the same wording the editor draws on the band", () => {
    const items = geometryChecks(
      revision([HEAD_HEIGHT, CENTER_OFFSET, CHIN_BOTTOM, EYE_LINE]),
      manifest(),
      anchors(),
    );
    expect(items.map((i) => i.label)).toEqual([
      "Head height",
      "Face center-line offset",
      "Chin to bottom edge",
      "Eye height (from bottom)",
    ]);
  });

  it("reports the rule as unchecked when its coordinate space cannot be converted", () => {
    // Millimeters only have a pixel meaning on a physical_raster template
    const mmRule: MeasurementRule = {
      ...CENTER_OFFSET,
      unit: "mm",
      coordinateSpace: "output_physical_mm_top_left",
      min: -1.5,
      max: 1.5,
    };
    const item = byId(
      geometryChecks(revision([mmRule]), manifest(), anchors()),
      "fi-face-center-offset",
    );
    expect(item.status).toBe("unknown");
    expect(item.detail).toContain("cannot be converted");
  });

  it("converts normalized bounds against the artifact's own output size", () => {
    // 0.02 of 500 px = ±10 px; a 50 px offset must fall outside it
    const normalized: MeasurementRule = {
      ...CENTER_OFFSET,
      unit: "ratio",
      coordinateSpace: "output_normalized_top_left",
      min: -0.02,
      max: 0.02,
    };
    const item = byId(
      geometryChecks(revision([normalized]), manifest(), anchors({ faceCenter: { x: 600, y: 700 } })),
      "fi-face-center-offset",
    );
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("-10..10 px");
  });

  it("reports an unchecked item rather than a conclusion for a degenerate span", () => {
    const items = geometryChecks(
      revision([HEAD_HEIGHT]),
      manifest(),
      anchors({ chinTip: { x: 500, y: 300 }, hairline: { x: 500, y: 300 } }),
    );
    const item = byId(items, "fi-head-height");
    expect(item.status).toBe("unknown");
    expect(item.detail).toContain("valid span");
  });
});
