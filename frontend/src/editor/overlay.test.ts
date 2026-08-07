import { describe, expect, it } from "vitest";

import type { MeasurementRule, TemplateRevision } from "../lib/templates/types";
import { buildOverlayGuides, headEllipse, metricLabel, toOutputPixels } from "./overlay";

function rule(overrides: Partial<MeasurementRule> = {}): MeasurementRule {
  return {
    id: "r1",
    metric: "head_top_margin",
    min: 10,
    max: 20,
    unit: "px",
    anchors: ["crown_point"],
    axis: "y",
    bounds: "inclusive",
    coordinateSpace: "output_pixel_top_left",
    evaluation: "automatic",
    enforcement: "mandatory",
    provenance: "source_literal",
    sourceRefs: [],
    ...overrides,
  };
}

function revision(overrides: Partial<TemplateRevision> = {}): TemplateRevision {
  return {
    revisionId: "t@1",
    id: "t",
    version: 1,
    schemaVersion: 1,
    label: { en: "test" },
    jurisdiction: "US",
    documentType: "passport",
    submissionChannel: "digital_upload",
    applicantClass: "adult",
    sources: [],
    output: {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 800,
      aspect: { width: 3, height: 4, enforcement: "mandatory", provenance: "derived" },
    },
    cropRules: [],
    captureRules: [],
    overlay: { kind: "combined", ruleIds: [] },
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
  } as TemplateRevision;
}

const OUT = { width: 600, height: 800 };

describe("toOutputPixels", () => {
  it("passes through output pixels unchanged", () => {
    expect(toOutputPixels(120, rule(), revision(), OUT)).toBe(120);
  });

  it("converts millimetres using the template print density", () => {
    const rev = revision({
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
    } as Partial<TemplateRevision>);
    const mm = rule({ coordinateSpace: "output_physical_mm_top_left", unit: "mm" });
    // 25.4 mm = 1 inch = 300 px
    expect(toOutputPixels(25.4, mm, rev, OUT)).toBeCloseTo(300, 6);
  });

  it("refuses millimetres when the template declares no print density", () => {
    // Better to draw nothing than a misplaced reference line
    const mm = rule({ coordinateSpace: "output_physical_mm_top_left", unit: "mm" });
    expect(toOutputPixels(10, mm, revision(), OUT)).toBeNull();
  });

  it("scales normalized values by the matching axis", () => {
    const ratio = rule({ coordinateSpace: "output_normalized_top_left", unit: "ratio" });
    expect(toOutputPixels(0.5, ratio, revision(), OUT)).toBe(400);
    expect(toOutputPixels(0.5, { ...ratio, axis: "x" }, revision(), OUT)).toBe(300);
  });

  it("returns null for pose angles, which are not canvas lengths", () => {
    const pose = rule({ coordinateSpace: "pose_camera_degrees", unit: "degree", axis: "angle" });
    expect(toOutputPixels(7, pose, revision(), OUT)).toBeNull();
  });
});

describe("buildOverlayGuides", () => {
  it("draws nothing when the template declares no overlay", () => {
    const rev = revision({ overlay: { kind: "none", ruleIds: ["r1"] }, cropRules: [rule()] });
    expect(buildOverlayGuides(rev, OUT)).toEqual([]);
  });

  it("places a top margin band measured from the top edge", () => {
    const rev = revision({ cropRules: [rule()], overlay: { kind: "combined", ruleIds: ["r1"] } });
    const [guide] = buildOverlayGuides(rev, OUT);
    expect(guide.kind).toBe("horizontal-band");
    expect(guide.fromPx).toBe(10);
    expect(guide.toPx).toBe(20);
  });

  it("flips bottom-anchored metrics into canvas coordinates", () => {
    const chin = rule({ id: "chin", metric: "chin_bottom_margin", min: 96, max: 124 });
    const rev = revision({ cropRules: [chin], overlay: { kind: "combined", ruleIds: ["chin"] } });
    const [guide] = buildOverlayGuides(rev, OUT);
    // From the bottom 96–124 → canvas y 676–704
    expect(guide.fromPx).toBe(800 - 124);
    expect(guide.toPx).toBe(800 - 96);
  });

  it("centers face-offset metrics on the canvas mid-line", () => {
    const offset = rule({
      id: "off",
      metric: "face_center_offset_x",
      min: -21,
      max: 21,
      axis: "x",
    });
    const rev = revision({ cropRules: [offset], overlay: { kind: "combined", ruleIds: ["off"] } });
    const [guide] = buildOverlayGuides(rev, OUT);
    expect(guide.kind).toBe("vertical-band");
    expect(guide.fromPx).toBe(279);
    expect(guide.toPx).toBe(321);
  });

  it("treats head height as a size range, not a position", () => {
    const head = rule({ id: "hh", metric: "head_height", min: 445, max: 500 });
    const rev = revision({ cropRules: [head], overlay: { kind: "combined", ruleIds: ["hh"] } });
    expect(buildOverlayGuides(rev, OUT)[0].kind).toBe("size-y");
  });

  it("falls back to the canvas edge when a bound is open", () => {
    const eye = rule({ id: "eye", metric: "eye_line_from_bottom", min: 256, max: undefined });
    const rev = revision({ cropRules: [eye], overlay: { kind: "combined", ruleIds: ["eye"] } });
    const [guide] = buildOverlayGuides(rev, OUT);
    expect(guide.fromPx).toBe(0);
    expect(guide.toPx).toBe(800 - 256);
  });

  it("skips rules that cannot be converted", () => {
    const pose = rule({
      id: "yaw",
      metric: "yaw",
      coordinateSpace: "pose_camera_degrees",
      unit: "degree",
      axis: "angle",
      min: -7,
      max: 7,
    });
    const rev = revision({ cropRules: [pose], overlay: { kind: "combined", ruleIds: ["yaw"] } });
    expect(buildOverlayGuides(rev, OUT)).toEqual([]);
  });

  it("ignores overlay ids with no matching rule", () => {
    const rev = revision({ cropRules: [], overlay: { kind: "combined", ruleIds: ["ghost"] } });
    expect(buildOverlayGuides(rev, OUT)).toEqual([]);
  });

  it("carries the source literal so the UI can cite it", () => {
    const rev = revision({
      cropRules: [rule({ sourceLiteral: "crown to chin 32-36 mm" })],
      overlay: { kind: "combined", ruleIds: ["r1"] },
    });
    expect(buildOverlayGuides(rev, OUT)[0].sourceLiteral).toBe("crown to chin 32-36 mm");
  });
});

describe("headEllipse", () => {
  it("derives the target head area from crown and chin bands", () => {
    const rev = revision({
      cropRules: [
        rule({ id: "top", metric: "head_top_margin", min: 56, max: 84 }),
        rule({ id: "chin", metric: "chin_bottom_margin", min: 96, max: 124 }),
      ],
      overlay: { kind: "combined", ruleIds: ["top", "chin"] },
    });
    const ellipse = headEllipse(buildOverlayGuides(rev, OUT), OUT)!;
    expect(ellipse.cx).toBe(300);
    // Crown midpoint 70, chin midpoint 800-110=690
    expect(ellipse.cy).toBeCloseTo(380, 6);
    expect(ellipse.ry).toBeCloseTo(310, 6);
  });

  it("returns null when either band is missing", () => {
    const rev = revision({
      cropRules: [rule({ id: "top", metric: "head_top_margin" })],
      overlay: { kind: "combined", ruleIds: ["top"] },
    });
    expect(headEllipse(buildOverlayGuides(rev, OUT), OUT)).toBeNull();
  });
});

describe("metricLabel", () => {
  it("translates known metrics and passes unknown ones through", () => {
    expect(metricLabel("head_height")).toBe("Head height");
    expect(metricLabel("something_new")).toBe("something_new");
  });
});
