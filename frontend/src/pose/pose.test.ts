import { describe, expect, it } from "vitest";

import {
  composeRotationMatrix,
  decomposeFaceMatrix,
  decomposeRotationMatrix,
  matrixScale,
} from "./angles";
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

/** 构造带眼/下巴关键点的观察：宽度比例 + 中心偏移 */
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

const deg = (d: number) => (d * Math.PI) / 180;
const cos = (d: number) => Math.cos(deg(d));
const sin = (d: number) => Math.sin(deg(d));

/**
 * 直接由 Ry/Rx/Rz 的定义手写的**列主序**矩阵：col_j = (R0j, R1j, R2j)。
 *
 * 这些是打破自证循环的锚点。用 composeRotationMatrix 去验 decomposeRotationMatrix
 * 时，两边同时按行主序理解矩阵，测试照样全绿——只有写死的矩阵能抓到这种一致的错误。
 * 按行主序读下面任何一个样本，得到的都是符号相反或轴对调的角度。
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
    // facialTransformationMatrixes 的左上 3×3 是「旋转 × 均匀缩放」，
    // 缩放来自把标准脸模型对齐到当前人脸，量级常见于 1.0–2.0。
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
      // 不除缩放时 asin 的入参是 1.6·sin20 ≈ 0.547，读出约 33°而不是 20°
      const m = composeRotationMatrix({ yaw: 0, pitch: 20, roll: 0 }, 1.6);
      expect(matrixScale(m)).toBeCloseTo(1.6, 6);
      expect(decomposeRotationMatrix(m).pitch).toBeCloseTo(20, 4);
    });

    it("saturates instead of returning NaN for a degenerate matrix", () => {
      const m = composeRotationMatrix({ yaw: 0, pitch: 0, roll: 0 });
      m[9] = -5; // |R12| > scale：clamp 必须兜住 asin 的定义域
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
    // 回归：这里曾按 score 排序，但 §4.4 把 outputFaceBlendshapes 固定为 false，
    // score 恒为 undefined，排序全程等价、退化成「取第一张脸」。
    const background = landmarksFace(0.1, { x: 0.3, y: 0.2 }, 0);
    const subject = landmarksFace(0.35, { x: 0, y: 0 }, 1);
    expect(selectPrimaryFace([background, subject])?.faceIndex).toBe(1);
  });

  it("keeps the same subject across frames using the previous center", () => {
    // 两张脸大小接近时，没有先验就会逐帧来回跳
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
    expect(state.guidance).toContain("靠近");
  });

  describe("hysteresis (GDE-004)", () => {
    it("uses the tighter threshold before settling", () => {
      const tracker = new PoseTracker();
      // 首帧无历史，EMA 直接取当前角度：16° 远超 7° 的进入阈值
      expect(tracker.update([anglesFace({ yaw: 16, pitch: 0, roll: 0 })], 0).status).toBe(
        "unstable",
      );
    });

    it("holds ready through a small wobble once settled", () => {
      // 回归：滞回系数曾是 0.7——进入 ready 后阈值反而收紧 30%，
      // 卡在边界的用户会在 ready 与 unstable 之间来回跳，
      // 正是滞回本该消除的现象。
      const tracker = new PoseTracker();
      expect(tracker.update([landmarksFace(0.3, { x: 0, y: 0 })], 0).status).toBe("ready");
      // EMA 后为 8°：高于 7° 的进入阈值，但低于 7×1.3 的退出阈值
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
      // 回归：旧实现用 mirrored 翻转身体方向，等价于断言「换个摄像头人就转了个身」，
      // 两个分支里必然有一支是错的。
      const plain = new PoseTracker({ mirrored: false });
      const mirrored = new PoseTracker({ mirrored: true });
      const observation = [anglesFace({ yaw: 16, pitch: 0, roll: 0 })];
      expect(plain.update(observation, 0).guidance).toBe(mirrored.update(observation, 0).guidance);
    });

    it("phrases turn instructions in terms of the subject's own body", () => {
      const tracker = new PoseTracker();
      const state = tracker.update([anglesFace({ yaw: 16, pitch: 0, roll: 0 })], 0);
      expect(state.guidance).toContain("你自己的");
    });

    it("sends a subject standing to their own left back to the right", () => {
      // 回归：这一条曾写反，用户照做后脸继续往同一方向走，位置永远收敛不了。
      // MediaPipe 读的是未镜像的原始帧：被摄者向自己的左侧移动时脸往画面右侧走，
      // 所以 center.x > 0.5 表示人已经偏在自己的左侧。
      const tracker = new PoseTracker();
      const state = tracker.update([landmarksFace(0.3, { x: 0.3, y: 0 })], 0);
      expect(state.status).toBe("out-of-position");
      expect(state.guidance).toContain("请向你自己的右侧移动");
    });

    it("sends a subject standing to their own right back to the left", () => {
      const tracker = new PoseTracker();
      const state = tracker.update([landmarksFace(0.3, { x: -0.3, y: 0 })], 0);
      expect(state.guidance).toContain("请向你自己的左侧移动");
    });

    it("tells a subject who is looking down to raise their head", () => {
      // 回归：pitch 方向与本文件自述的坐标约定相反，正在低头的用户被要求继续低头。
      // pitch = asin(-R12/s) 绕 +X 轴，+X 指向被摄者左侧、+Z 朝向相机，
      // 绕 +X 正转把 +Z 转到 -Y，即脸朝下——所以 pitch > 0 是低头。
      const tracker = new PoseTracker();
      const state = tracker.update([anglesFace({ yaw: 0, pitch: 12, roll: 0 })], 0);
      expect(state.status).toBe("unstable");
      expect(state.guidance).toContain("请抬头一点");
    });

    it("tells a subject who is looking up to lower their head", () => {
      const tracker = new PoseTracker();
      const state = tracker.update([anglesFace({ yaw: 0, pitch: -12, roll: 0 })], 0);
      expect(state.guidance).toContain("请低头一点");
    });

    it("labels the ready state as an uncalibrated heuristic", () => {
      const tracker = new PoseTracker();
      expect(tracker.update([landmarksFace(0.3, { x: 0, y: 0 })], 0).guidance).toContain(
        "非官方容差",
      );
    });
  });

  describe("multi-face and unusable frames", () => {
    it("still tracks the primary face while reporting multi-face", () => {
      // 回归：多脸时状态先被置成 multi-face 并 return，关联与平滑的结果永远用不上
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
