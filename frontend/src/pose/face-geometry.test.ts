import { describe, expect, it } from "vitest";

import type { FaceObservation } from "./tracking";
import {
  EAR_CLOSED_MAX,
  MAR_OPEN_MIN,
  eyeAspectRatio,
  faceRoi,
  mouthAspectRatio,
} from "./face-geometry";

/** 478 长度 canonical face mesh；关键索引显式赋独立对象（坑：不能用同一引用） */
function faceWith(at: (x: number, y: number) => { x: number; y: number }): FaceObservation {
  const landmarks = new Array(478).fill(null).map(() => at(0.5, 0.5));
  for (const i of [159, 145, 33, 133, 386, 374, 362, 263, 13, 14, 61, 291]) {
    landmarks[i] = { x: 0.5, y: 0.5 };
  }
  return { landmarks } as unknown as FaceObservation;
}

/** 睁眼样本：竖距 = 横距 0.3 倍（square 图），落在睁眼一侧 */
function openEyesFace(): FaceObservation {
  const f = faceWith((x, y) => ({ x, y }));
  // 左眼：外眦 33 = (0.5, 0.5)，内眦 133 = (0.54, 0.5) → 横距 0.04；上睑 159/下睑 145 竖距 0.012
  f.landmarks[33] = { x: 0.5, y: 0.5 };
  f.landmarks[133] = { x: 0.54, y: 0.5 };
  f.landmarks[159] = { x: 0.52, y: 0.488 };
  f.landmarks[145] = { x: 0.52, y: 0.5 };
  // 右眼：362 = (0.54, 0.5)，263 = (0.5, 0.5)；386/374 竖距 0.012
  f.landmarks[362] = { x: 0.54, y: 0.5 };
  f.landmarks[263] = { x: 0.5, y: 0.5 };
  f.landmarks[386] = { x: 0.52, y: 0.488 };
  f.landmarks[374] = { x: 0.52, y: 0.5 };
  // 嘴：61/291 横距 0.04，13/14 竖距 0.012
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
    // 0.3 倍竖/横距样本在 square 下为 0.3，必须是睁眼
    expect(earSquare).toBeGreaterThan(EAR_CLOSED_MAX);
  });

  it("judges closed eyes when the lids collapse (EAR ~ 0) (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    f.landmarks[33] = { x: 0.5, y: 0.5 };
    f.landmarks[133] = { x: 0.54, y: 0.5 };
    f.landmarks[159] = { x: 0.52, y: 0.5 }; // 上睑与下睑重合
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
    f.landmarks[14] = { x: 0.52, y: 0.75 }; // 竖距 0.1 = 横距 2.5 倍
    const mar = mouthAspectRatio(f, 1)!;
    expect(mar).toBeGreaterThan(MAR_OPEN_MIN);
  });

  it("returns null when required landmarks are missing (O2)", () => {
    const f = faceWith((x, y) => ({ x, y }));
    // 左眼缺 159
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
    f.landmarks[133] = { x: 0.5, y: 0.5 }; // 横距 0
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
    // 把几个 landmark 铺到全图角落，验证外扩与夹取
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
