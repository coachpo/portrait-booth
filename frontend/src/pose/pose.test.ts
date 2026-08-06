import { describe, expect, it } from "vitest";

import { composeRotationMatrix, decomposeRotationMatrix } from "./angles";
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
    score: 1,
    ...overrides,
  };
}

/** 构造带眼/下巴关键点的观察：宽度比例 + 中心偏移 */
function landmarksFace(widthRatio: number, offset: { x: number; y: number }): FaceObservation {
  const arr = new Array<{ x: number; y: number; z?: number }>(478).fill({ x: 0.5, y: 0.5 });
  arr[33] = { x: 0.5 + offset.x - widthRatio / 2, y: 0.4 + offset.y };
  arr[263] = { x: 0.5 + offset.x + widthRatio / 2, y: 0.4 + offset.y };
  arr[10] = { x: 0.5 + offset.x, y: 0.2 + offset.y };
  arr[152] = { x: 0.5 + offset.x, y: 0.65 + offset.y };
  return {
    faceIndex: 0,
    landmarks: arr,
    matrix: composeRotationMatrix({ yaw: 0, pitch: 0, roll: 0 }),
    score: 1,
  };
}

/** 带指定角度的位置合规人脸 */
function anglesFace(
  angles: { yaw: number; pitch: number; roll: number },
  widthRatio = 0.3,
): FaceObservation {
  return { ...landmarksFace(widthRatio, { x: 0, y: 0 }), matrix: composeRotationMatrix(angles) };
}

function fakeBitmap(): StaticBitmapSource {
  return { width: 512, height: 512 } as unknown as StaticBitmapSource;
}

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
});

describe("selectPrimaryFace", () => {
  it("picks the highest-score face", () => {
    const a = face({ yaw: 0, pitch: 0, roll: 0 }, { faceIndex: 0, score: 0.5 });
    const b = face({ yaw: 0, pitch: 0, roll: 0 }, { faceIndex: 1, score: 0.9 });
    expect(selectPrimaryFace([a, b])?.faceIndex).toBe(1);
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
    const state = tracker.update([anglesFace({ yaw: 15, pitch: 0, roll: 0 })], 2000);
    expect(state.status).toBe("unstable");
    expect(state.shootable).toBe(false);
  });

  it("gives body-direction guidance for mirrored previews (GDE-002)", () => {
    const tracker = new PoseTracker({ mirrored: true });
    const state = tracker.update([anglesFace({ yaw: 15, pitch: 0, roll: 0 })], 0);
    // yaw > 0（画面右侧）在镜像预览中对应用户身体的左侧
    expect(state.guidance).toContain("左侧");
  });

  it("warns about position and size", () => {
    const tracker = new PoseTracker();
    const state = tracker.update([landmarksFace(0.05, { x: 0, y: 0 })], 0);
    expect(state.status).toBe("out-of-position");
    expect(state.guidance).toContain("靠近");
  });
});

describe("analyzeQuality (GDE-010)", () => {
  // jsdom 无 canvas 2d：注入 fake deps，用纯数据模拟像素
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
    expect(result.issues.some((i) => i.includes("曝光不足"))).toBe(true);
    expect(result.metrics.darkClipRatio).toBeGreaterThan(0.9);
  });

  it("warns on a mostly white image (over-exposed)", () => {
    const { deps } = makeDeps(() => [255, 255, 255]);
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("曝光过度"))).toBe(true);
    expect(result.metrics.brightClipRatio).toBeGreaterThan(0.9);
  });

  it("warns on a flat image (blurred)", () => {
    const { deps } = makeDeps(() => [128, 128, 128]);
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("模糊"))).toBe(true);
    expect(result.metrics.sharpness).toBeLessThan(QUALITY_CONFIG.sharpnessMin);
  });

  it("reports no issue for a textured well-exposed image", () => {
    const { deps } = makeDeps((x, y) => ((x / 8 + y / 8) % 2 < 1 ? [60, 60, 60] : [200, 200, 200]));
    const result = analyzeQuality(fakeBitmap(), QUALITY_CONFIG, deps);
    expect(result.issues.some((i) => i.includes("明显问题"))).toBe(true);
  });

  it("reports unknown for unreadable input", () => {
    const { deps } = makeDeps(() => [0, 0, 0]);
    const result = analyzeQuality({} as StaticBitmapSource, QUALITY_CONFIG, deps);
    expect(result.status).toBe("unknown");
    expect(result.metrics).toBeDefined();
  });
});
