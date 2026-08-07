import { describe, expect, it } from "vitest";

import type { FaceObservation } from "./tracking";
import {
  EAR_CLOSED_MAX,
  MAR_OPEN_MIN,
  eyeAspectRatio,
  faceRoi,
  mouthAspectRatio,
} from "./face-geometry";

/** 478-length canonical face mesh; key indices get explicit distinct objects (trap: must not share one reference) */
function faceWith(at: (x: number, y: number) => { x: number; y: number }): FaceObservation {
  const landmarks = new Array(478).fill(null).map(() => at(0.5, 0.5));
  for (const i of [159, 145, 33, 133, 386, 374, 362, 263, 13, 14, 61, 291]) {
    landmarks[i] = { x: 0.5, y: 0.5 };
  }
  return { landmarks } as unknown as FaceObservation;
}

/** Open-eye sample: vertical = 0.3× horizontal (square image), on the open-eye side */
function openEyesFace(): FaceObservation {
  const f = faceWith((x, y) => ({ x, y }));
  // Left eye: outer corner 33 = (0.5, 0.5), inner corner 133 = (0.54, 0.5) → horizontal 0.04; upper lid 159 / lower lid 145 vertical 0.012
  f.landmarks[33] = { x: 0.5, y: 0.5 };
  f.landmarks[133] = { x: 0.54, y: 0.5 };
  f.landmarks[159] = { x: 0.52, y: 0.488 };
  f.landmarks[145] = { x: 0.52, y: 0.5 };
  // Right eye: 362 = (0.54, 0.5), 263 = (0.5, 0.5); 386/374 vertical 0.012
  f.landmarks[362] = { x: 0.54, y: 0.5 };
  f.landmarks[263] = { x: 0.5, y: 0.5 };
  f.landmarks[386] = { x: 0.52, y: 0.488 };
  f.landmarks[374] = { x: 0.52, y: 0.5 };
  // Mouth: 61/291 horizontal 0.04, 13/14 vertical 0.012
  f.landmarks[61] = { x: 0.5, y: 0.7 };
  f.landmarks[291] = { x: 0.54, y: 0.7 };
  f.landmarks[13] = { x: 0.52, y: 0.688 };
  f.landmarks[14] = { x: 0.52, y: 0.7 };
  return f;
}

describe("face geometry (O2)", () => {
  it("applies aspect correction: EAR(W=1000,H=2000) is twice EAR(W=1000,H=1000) (O2)", () => {
    const face = openEyesFace();
    const earSquare = eyeAspectRatio(face, 1)!;
    const earTall = eyeAspectRatio(face, 2)!;
    expect(earTall / earSquare).toBeCloseTo(2, 9);
    // 0.3× vertical/horizontal sample is 0.3 on a square image: must be open
    expect(earSquare).toBeGreaterThan(EAR_CLOSED_MAX);
  });

  it("judges closed eyes when the lids collapse (EAR ~ 0) (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    f.landmarks[33] = { x: 0.5, y: 0.5 };
    f.landmarks[133] = { x: 0.54, y: 0.5 };
    f.landmarks[159] = { x: 0.52, y: 0.5 }; // upper and lower lids coincide
    f.landmarks[145] = { x: 0.52, y: 0.5 };
    f.landmarks[362] = { x: 0.54, y: 0.5 };
    f.landmarks[263] = { x: 0.5, y: 0.5 };
    f.landmarks[386] = { x: 0.52, y: 0.5 };
    f.landmarks[374] = { x: 0.52, y: 0.5 };
    const ear = eyeAspectRatio(f, 1)!;
    expect(ear).toBeLessThan(EAR_CLOSED_MAX);
  });

  it("keeps a wide-open mouth above MAR_OPEN_MIN (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    f.landmarks[61] = { x: 0.5, y: 0.7 };
    f.landmarks[291] = { x: 0.54, y: 0.7 };
    f.landmarks[13] = { x: 0.52, y: 0.65 };
    f.landmarks[14] = { x: 0.52, y: 0.75 }; // vertical 0.1 = 2.5× horizontal
    const mar = mouthAspectRatio(f, 1)!;
    expect(mar).toBeGreaterThan(MAR_OPEN_MIN);
  });

  it("returns null when required landmarks are missing (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    // Left eye missing 159
    delete f.landmarks[159];
    f.landmarks[33] = { x: 0.5, y: 0.5 };
    f.landmarks[133] = { x: 0.54, y: 0.5 };
    f.landmarks[145] = { x: 0.52, y: 0.5 };
    f.landmarks[362] = { x: 0.54, y: 0.5 };
    f.landmarks[263] = { x: 0.5, y: 0.5 };
    f.landmarks[386] = { x: 0.52, y: 0.488 };
    f.landmarks[374] = { x: 0.52, y: 0.5 };
    expect(eyeAspectRatio(f, 1)).toBeNull();
  });

  it("returns null when the eye width collapses to zero (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    f.landmarks[33] = { x: 0.5, y: 0.5 };
    f.landmarks[133] = { x: 0.5, y: 0.5 }; // horizontal 0
    f.landmarks[159] = { x: 0.5, y: 0.49 };
    f.landmarks[145] = { x: 0.5, y: 0.51 };
    f.landmarks[362] = { x: 0.54, y: 0.5 };
    f.landmarks[263] = { x: 0.5, y: 0.5 };
    f.landmarks[386] = { x: 0.52, y: 0.488 };
    f.landmarks[374] = { x: 0.52, y: 0.5 };
    expect(eyeAspectRatio(f, 1)).toBeNull();
  });

  it("computes a clamped ROI from the landmark bbox (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    // Spread landmarks across the image corners to verify expansion and clamping
    f.landmarks[33] = { x: 0, y: 0 };
    f.landmarks[263] = { x: 1, y: 0 };
    f.landmarks[152] = { x: 0.5, y: 1 };
    const roi = faceRoi(f, 1)!;
    expect(roi.x).toBe(0);
    expect(roi.y).toBe(0);
    expect(roi.width).toBeLessThanOrEqual(1);
    expect(roi.height).toBeLessThanOrEqual(1);
    expect(roi.width).toBeGreaterThan(0.5);
    expect(roi.height).toBeGreaterThan(0.5);
  });

  it("returns null for a degenerate face (no valid landmarks) (O2)", () => {
    const f = { landmarks: [] } as unknown as FaceObservation;
    expect(faceRoi(f, 1)).toBeNull();
    expect(eyeAspectRatio(f, 1)).toBeNull();
    expect(mouthAspectRatio(f, 1)).toBeNull();
  });
});
