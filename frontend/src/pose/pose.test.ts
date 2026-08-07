import { describe, expect, it } from "vitest";

import {
  composeRotationMatrix,
  decomposeFaceMatrix,
  decomposeRotationMatrix,
  matrixScale,
} from "./angles";
import { formatGuidance } from "./guidance-text";
import {
  DEFAULT_POSE_THRESHOLDS,
  PoseTracker,
  selectPrimaryFace,
  type FaceObservation,
} from "./tracking";
import {
  analyzeQuality,
  QUALITY_CONFIG,
  type QualityDeps,
  type StaticBitmapSource,
} from "./quality";

function face(
  angles: { yaw: number; pitch: number; roll: number },
  overrides: Partial<FaceObservation> = {},
): FaceObservation {
  return {
    faceIndex: 0,
    landmarks: [],
    matrix: composeRotationMatrix(angles),
    ...overrides,
  };
}

/** Build an observation with eye/chin landmarks: width ratio + center offset */
function landmarksFace(
  widthRatio: number,
  offset: { x: number; y: number },
  faceIndex = 0,
): FaceObservation {
  const arr = new Array<{ x: number; y: number; z?: number }>(478).fill({ x: 0.5, y: 0.5 });
  arr[33] = { x: 0.5 + offset.x - widthRatio / 2, y: 0.4 + offset.y };
  arr[263] = { x: 0.5 + offset.x + widthRatio / 2, y: 0.4 + offset.y };
  arr[10] = { x: 0.5 + offset.x, y: 0.2 + offset.y };
  arr[152] = { x: 0.5 + offset.x, y: 0.65 + offset.y };
  return {
    faceIndex,
    landmarks: arr,
    matrix: composeRotationMatrix({ yaw: 0, pitch: 0, roll: 0 }),
  };
}

/** A position-compliant face with the given angles */
function anglesFace(
  angles: { yaw: number; pitch: number; roll: number },
  widthRatio = 0.3,
): FaceObservation {
  return { ...landmarksFace(widthRatio, { x: 0, y: 0 }), matrix: composeRotationMatrix(angles) };
}

function fakeBitmap(): StaticBitmapSource {
  return { width: 512, height: 512 } as unknown as StaticBitmapSource;
}

const deg = (d: number) => (d * Math.PI) / 180;
const cos = (d: number) => Math.cos(deg(d));
const sin = (d: number) => Math.sin(deg(d));

/**
 * Hand-written **column-major** matrices straight from the Ry/Rx/Rz
 * definitions: col_j = (R0j, R1j, R2j).
 *
 * These are the anchors that break the self-referential loop. Using
 * composeRotationMatrix to verify decomposeRotationMatrix
 * has both sides reading the matrix row-major and tests stay green - only
 * written-out matrices can catch that consistent error.
 * Reading any sample below row-major yields angles with flipped signs or
 * swapped axes.
 */
const COLUMN_MAJOR_SAMPLES: Array<{
  name: string;
  m: number[];
  expected: { yaw: number; pitch: number; roll: number };
}> = [
  {
    name: "yaw +30°（Ry）",
    m: [cos(30), 0, -sin(30), 0, 0, 1, 0, 0, sin(30), 0, cos(30), 0, 0, 0, 0, 1],
    expected: { yaw: 30, pitch: 0, roll: 0 },
  },
  {
    name: "pitch +20°（Rx）",
    m: [1, 0, 0, 0, 0, cos(20), sin(20), 0, 0, -sin(20), cos(20), 0, 0, 0, 0, 1],
    expected: { yaw: 0, pitch: 20, roll: 0 },
  },
  {
    name: "roll +15°（Rz）",
    m: [cos(15), sin(15), 0, 0, -sin(15), cos(15), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    expected: { yaw: 0, pitch: 0, roll: 15 },
  },
];

describe("decomposeRotationMatrix (GDE-003)", () => {
  it("returns zero angles for identity", () => {
    const a = decomposeRotationMatrix(composeRotationMatrix({ yaw: 0, pitch: 0, roll: 0 }));
    expect(a.yaw).toBeCloseTo(0, 6);
    expect(a.pitch).toBeCloseTo(0, 6);
    expect(a.roll).toBeCloseTo(0, 6);
  });

  it("round-trips known yaw/pitch/roll samples", () => {
    for (const sample of [
      { yaw: 5, pitch: 0, roll: 0 },
      { yaw: -10, pitch: 3, roll: 2 },
      { yaw: 0, pitch: -8, roll: 0 },
      { yaw: 2, pitch: 0, roll: -4 },
      { yaw: 6, pitch: -6, roll: 4 },
    ]) {
      const a = decomposeRotationMatrix(composeRotationMatrix(sample));
      expect(a.yaw).toBeCloseTo(sample.yaw, 4);
      expect(a.pitch).toBeCloseTo(sample.pitch, 4);
      expect(a.roll).toBeCloseTo(sample.roll, 4);
    }
  });

  describe("reads MediaPipe's column-major layout", () => {
    for (const sample of COLUMN_MAJOR_SAMPLES) {
      it(`decomposes a hand-written matrix for ${sample.name}`, () => {
        const a = decomposeRotationMatrix(sample.m);
        expect(a.yaw).toBeCloseTo(sample.expected.yaw, 4);
        expect(a.pitch).toBeCloseTo(sample.expected.pitch, 4);
        expect(a.roll).toBeCloseTo(sample.expected.roll, 4);
      });
    }
  });

  describe("divides out the uniform scale", () => {
    // The top-left 3×3 of facialTransformationMatrixes is "rotation ×
    // uniform scale"; the scale comes from aligning the canonical face
    // model to the current face, commonly 1.0–2.0.
    for (const scale of [1.2, 1.6, 2.4]) {
      it(`recovers the same angles at scale ${scale}`, () => {
        const scaled = COLUMN_MAJOR_SAMPLES.map((s) => ({
          ...s,
          m: s.m.map((v, i) => (i === 15 ? v : v * scale)),
        }));
        for (const sample of scaled) {
          const a = decomposeRotationMatrix(sample.m);
          expect(a.yaw).toBeCloseTo(sample.expected.yaw, 4);
          expect(a.pitch).toBeCloseTo(sample.expected.pitch, 4);
          expect(a.roll).toBeCloseTo(sample.expected.roll, 4);
        }
      });
    }

    it("would saturate pitch without the scale division", () => {
      // Without dividing out the scale, asin's input is 1.6·sin20 ≈ 0.547,
      // reading about 33° instead of 20°
      const m = composeRotationMatrix({ yaw: 0, pitch: 20, roll: 0 }, 1.6);
      expect(matrixScale(m)).toBeCloseTo(1.6, 6);
      expect(decomposeRotationMatrix(m).pitch).toBeCloseTo(20, 4);
    });

    it("saturates instead of returning NaN for a degenerate matrix", () => {
      const m = composeRotationMatrix({ yaw: 0, pitch: 0, roll: 0 });
      m[9] = -5; // |R12| > scale: clamp must keep asin within its domain
      expect(Number.isNaN(decomposeRotationMatrix(m).pitch)).toBe(false);
    });
  });
});

describe("decomposeFaceMatrix", () => {
  it("returns angles for a well-formed matrix", () => {
    expect(
      decomposeFaceMatrix(composeRotationMatrix({ yaw: 4, pitch: 0, roll: 0 }))?.yaw,
    ).toBeCloseTo(4, 4);
  });

  it("rejects a missing or short matrix", () => {
    expect(decomposeFaceMatrix(undefined)).toBeNull();
    expect(decomposeFaceMatrix(null)).toBeNull();
    expect(decomposeFaceMatrix([1, 0, 0])).toBeNull();
  });

  it("rejects a matrix containing non-finite values", () => {
    const m = composeRotationMatrix({ yaw: 0, pitch: 0, roll: 0 });
    m[9] = Number.NaN;
    expect(decomposeFaceMatrix(m)).toBeNull();
  });

  it("rejects a degenerate (zero-scale) matrix", () => {
    expect(decomposeFaceMatrix(new Array<number>(16).fill(0))).toBeNull();
  });
});

describe("selectPrimaryFace", () => {
  it("returns null without faces and passes a single face through", () => {
    expect(selectPrimaryFace([])).toBeNull();
    const only = landmarksFace(0.1, { x: 0.4, y: 0 }, 7);
    expect(selectPrimaryFace([only])?.faceIndex).toBe(7);
  });

  it("prefers the wider, more centered face", () => {
    // Regression: this used to sort by score, but §4.4 pins
    // outputFaceBlendshapes to false, so score was always undefined, the
    // ordering was equivalent throughout, and it degenerated to "take the
    // first face".
    const background = landmarksFace(0.1, { x: 0.3, y: 0.2 }, 0);
    const subject = landmarksFace(0.35, { x: 0, y: 0 }, 1);
    expect(selectPrimaryFace([background, subject])?.faceIndex).toBe(1);
  });

  it("keeps the same subject across frames using the previous center", () => {
    // With two similar-sized faces, without the prior the primary face
    // switches back and forth each frame
    const left = landmarksFace(0.3, { x: -0.2, y: 0 }, 0);
    const right = landmarksFace(0.3, { x: 0.2, y: 0 }, 1);
    expect(selectPrimaryFace([left, right], { x: 0.3, y: 0.4 })?.faceIndex).toBe(0);
    expect(selectPrimaryFace([left, right], { x: 0.7, y: 0.4 })?.faceIndex).toBe(1);
  });
});

describe("PoseTracker (GDE-001/004)", () => {
  const t = DEFAULT_POSE_THRESHOLDS;

  it("reports no-face without landmarks", () => {
    const tracker = new PoseTracker();
    const state = tracker.update([], 0);
    expect(state.status).toBe("no-face");
    expect(state.shootable).toBe(false);
  });

  it("reports multi-face when several faces are present", () => {
    const tracker = new PoseTracker();
    const state = tracker.update(
      [
        face({ yaw: 0, pitch: 0, roll: 0 }, { faceIndex: 0 }),
        face({ yaw: 0, pitch: 0, roll: 0 }, { faceIndex: 1 }),
      ],
      0,
    );
    expect(state.status).toBe("multi-face");
  });

  it("becomes shootable after stable for the required duration", () => {
    const tracker = new PoseTracker();
    const f = landmarksFace(0.3, { x: 0, y: 0 });
    let state = tracker.update([f], 0);
    expect(state.status).toBe("ready");
    expect(state.shootable).toBe(false);
    state = tracker.update([f], t.stableMs);
    expect(state.shootable).toBe(true);
  });

  it("resets stability when the face moves out of the angle window", () => {
    const tracker = new PoseTracker();
    tracker.update([landmarksFace(0.3, { x: 0, y: 0 })], 0);
    const state = tracker.update([anglesFace({ yaw: 40, pitch: 0, roll: 0 })], 2000);
    expect(state.status).toBe("unstable");
    expect(state.shootable).toBe(false);
  });

  it("warns about position and size", () => {
    const tracker = new PoseTracker();
    const state = tracker.update([landmarksFace(0.05, { x: 0, y: 0 })], 0);
    expect(state.status).toBe("out-of-position");
    expect(state.guidanceHints).toEqual(["move-closer"]);
  });

  describe("hysteresis (GDE-004)", () => {
    it("uses the tighter threshold before settling", () => {
      const tracker = new PoseTracker();
      // First frame has no history, so the EMA takes the current angle: 16° is
      // far above the 7° entry threshold
      expect(tracker.update([anglesFace({ yaw: 16, pitch: 0, roll: 0 })], 0).status).toBe(
        "unstable",
      );
    });

    it("holds ready through a small wobble once settled", () => {
      // Regression: the hysteresis factor used to be 0.7 - after entering
      // ready the thresholds tightened by 30%, so a user at the boundary
      // bounced between ready and unstable, exactly what hysteresis is
      // supposed to eliminate.
      const tracker = new PoseTracker();
      expect(tracker.update([landmarksFace(0.3, { x: 0, y: 0 })], 0).status).toBe("ready");
      // After EMA it is 8°: above the 7° entry threshold but below the 7×1.3
      // exit threshold
      const state = tracker.update([anglesFace({ yaw: 16, pitch: 0, roll: 0 })], 100);
      expect(state.status).toBe("ready");
    });

    it("still leaves ready for a genuine movement", () => {
      const tracker = new PoseTracker();
      tracker.update([landmarksFace(0.3, { x: 0, y: 0 })], 0);
      expect(tracker.update([anglesFace({ yaw: 40, pitch: 0, roll: 0 })], 100).status).toBe(
        "unstable",
      );
    });
  });

  describe("guidance wording (GDE-002)", () => {
    it("gives the same body-direction instruction regardless of mirroring", () => {
      // Regression: the old implementation used mirrored to flip body
      // direction, equivalent to asserting "switching cameras turns the
      // person around"; one of the two branches is necessarily wrong.
      const plain = new PoseTracker({ mirrored: false });
      const mirrored = new PoseTracker({ mirrored: true });
      const observation = [anglesFace({ yaw: 16, pitch: 0, roll: 0 })];
      expect(plain.update(observation, 0).guidanceHints).toEqual(
        mirrored.update(observation, 0).guidanceHints,
      );
    });

    it("phrases turn instructions in terms of the subject's own body", () => {
      const tracker = new PoseTracker();
      const state = tracker.update([anglesFace({ yaw: 16, pitch: 0, roll: 0 })], 0);
      expect(state.guidanceHints).toEqual(["turn-own-right"]);
    });

    it("sends a subject standing to their own left back to the right", () => {
      // Regression: this one used to be inverted, so the user followed
      // the hint and the face kept drifting in the same direction, never
      // converging. MediaPipe reads the unmirrored raw frame: when the
      // subject moves to their own left the face moves right on screen, so
      // center.x > 0.5 means the person is already off to their own left.
      const tracker = new PoseTracker();
      const state = tracker.update([landmarksFace(0.3, { x: 0.3, y: 0 })], 0);
      expect(state.status).toBe("out-of-position");
      expect(state.guidanceHints).toEqual(["move-own-right"]);
    });

    it("sends a subject standing to their own right back to the left", () => {
      const tracker = new PoseTracker();
      const state = tracker.update([landmarksFace(0.3, { x: -0.3, y: 0 })], 0);
      expect(state.guidanceHints).toEqual(["move-own-left"]);
    });

    it("tells a subject who is looking down to raise their head", () => {
      // Regression: pitch direction contradicted this file's own
      // coordinate convention - a user looking down was told to keep looking
      // down. pitch = asin(-R12/s) is about the +X axis, with +X pointing to
      // the subject's left and +Z toward the camera; positive rotation about
      // +X turns the forward +Z toward -Y, i.e. face down - so pitch > 0
      // means looking down.
      const tracker = new PoseTracker();
      const state = tracker.update([anglesFace({ yaw: 0, pitch: 12, roll: 0 })], 0);
      expect(state.status).toBe("unstable");
      expect(state.guidanceHints).toEqual(["raise-head"]);
    });

    it("tells a subject who is looking up to lower their head", () => {
      const tracker = new PoseTracker();
      const state = tracker.update([anglesFace({ yaw: 0, pitch: -12, roll: 0 })], 0);
      expect(state.guidanceHints).toEqual(["lower-head"]);
    });

    it("labels the ready state as an uncalibrated heuristic", () => {
      const tracker = new PoseTracker();
      expect(tracker.update([landmarksFace(0.3, { x: 0, y: 0 })], 0).guidanceHints).toEqual([]);
      expect(formatGuidance("ready", [], "en")).toContain("not official tolerance");
    });
  });

  describe("multi-face and unusable frames", () => {
    it("still tracks the primary face while reporting multi-face", () => {
      // Regression: with multiple faces the status was set to multi-face
      // and returned early, so association and smoothing results were never
      // used
      const tracker = new PoseTracker();
      const subject = landmarksFace(0.35, { x: 0, y: 0 }, 0);
      const bystander = landmarksFace(0.1, { x: 0.3, y: 0.2 }, 1);
      const state = tracker.update([subject, bystander], 0);
      expect(state.status).toBe("multi-face");
      expect(state.faceWidthRatio).toBeCloseTo(0.35, 6);
    });

    it("keeps the last state for an unusable matrix and recovers afterwards", () => {
      const tracker = new PoseTracker();
      const good = landmarksFace(0.3, { x: 0, y: 0 });
      tracker.update([good], 0);

      const broken = { ...good, matrix: new Array<number>(16).fill(Number.NaN) };
      const during = tracker.update([broken], 100);
      expect(Number.isNaN(during.angles.yaw)).toBe(false);
      expect(during.status).toBe("ready");

      const after = tracker.update([good], 200);
      expect(Number.isNaN(after.angles.yaw)).toBe(false);
      expect(after.status).toBe("ready");
    });
  });

  describe("setMirrored", () => {
    it("updates the flag without rebuilding the tracker", () => {
      const tracker = new PoseTracker({ mirrored: false });
      tracker.setMirrored(true);
      expect(tracker.isMirrored).toBe(true);
    });
  });
});

describe("analyzeQuality (GDE-010)", () => {
  // jsdom has no canvas 2d: inject fake deps and simulate pixels with pure
  // data
  function makeDeps(fill: (x: number, y: number) => [number, number, number], w = 512, h = 512) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = fill(x, y);
        const i = (y * w + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    const canvas = { width: 0, height: 0 };
    const ctx = {
      drawImage: () => {},
      getImageData: (_x: number, _y: number, ww: number, hh: number) => ({
        data,
        width: ww,
        height: hh,
      }),
    };
    const deps = {
      createCanvas: ((ww: number, hh: number) => {
        canvas.width = ww;
        canvas.height = hh;
        return canvas as unknown as HTMLCanvasElement;
      }) as QualityDeps["createCanvas"],
      canvasContext: () => ctx as unknown as CanvasRenderingContext2D,
    };
    return { deps, canvas };
  }

  it("warns on a mostly black image (under-exposed)", () => {
    const { deps } = makeDeps(() => [0, 0, 0]);
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.status).toBe("warn");
    expect(result.issues.some((i) => i.includes("underexposed"))).toBe(true);
    expect(result.metrics.darkClipRatio).toBeGreaterThan(0.9);
  });

  it("warns on a mostly white image (over-exposed)", () => {
    const { deps } = makeDeps(() => [255, 255, 255]);
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("overexposed"))).toBe(true);
    expect(result.metrics.brightClipRatio).toBeGreaterThan(0.9);
  });

  it("warns on a flat image (blurred)", () => {
    const { deps } = makeDeps(() => [128, 128, 128]);
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("blurry"))).toBe(true);
    expect(result.metrics.sharpness).toBeLessThan(QUALITY_CONFIG.sharpnessMin);
  });

  it("reports no issue for a textured well-exposed image", () => {
    const { deps } = makeDeps((x, y) => ((x / 8 + y / 8) % 2 < 1 ? [60, 60, 60] : [200, 200, 200]));
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("no obvious issues"))).toBe(true);
  });

  it("reports unknown for unreadable input", () => {
    const { deps } = makeDeps(() => [0, 0, 0]);
    const result = analyzeQuality({} as StaticBitmapSource, QUALITY_CONFIG, deps);
    expect(result.status).toBe("unknown");
    expect(result.metrics).toBeDefined();
  });

  it("measures the background outside the ROI and flags uneven halves (O2)", () => {
    // Left half luma 40 with stripes, right half 200 with stripes: only
    // the means differ, avoiding the Laplacian blur trigger
    const { deps } = makeDeps((x) => {
      const stripe = ((x / 8) % 2 < 1 ? 0 : 30) as number;
      return x < 256
        ? [40 + stripe, 40 + stripe, 40 + stripe]
        : [200 + stripe, 200 + stripe, 200 + stripe];
    });
    // The ROI covers only the central third: both halves are background
    const roi = { x: 1 / 3, y: 1 / 3, width: 1 / 3, height: 1 / 3 };
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps, roi);
    expect(result.metrics.background).not.toBeNull();
    expect(result.metrics.background!.leftRightDiff).toBeGreaterThan(100);
    // Whole-image fallback (no ROI passed): background is not computed
    const fallback = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(fallback.metrics.background).toBeNull();
  });

  it("keeps the whole-image fallback silent about the background (O2)", () => {
    // Stripe image fills the whole canvas with no ROI: must not produce
    // any background issue (regression: whole-image background stats would
    // flag it "uneven" and the positive copy would drop out of the list)
    const { deps } = makeDeps((x, y) => ((x / 8 + y / 8) % 2 < 1 ? [60, 60, 60] : [200, 200, 200]));
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("no obvious issues"))).toBe(true);
    expect(result.metrics.background).toBeNull();
  });
});
