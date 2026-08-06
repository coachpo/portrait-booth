// @vitest-environment jsdom
/**
 * runStaticCheck 端到端（O2）：注入 landmarker deps + qualityDeps，验证
 * 主脸几何、ROI 背景与未检查信号。landmarker 的 imageInstance 是进程级
 * 单例缓存，每个用例后必须 resetLandmarkersForTest()。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetLandmarkersForTest, setLandmarkerDeps } from "./landmarker";
import { runStaticCheck, staticCheckWarnings } from "./static-check";
import type { QualityDeps, StaticBitmapSource } from "./quality";

/** 478 长度 canonical face mesh，睁眼闭嘴样本（square 图） */
function openEyesFaceLandmarks() {
  const landmarks = new Array(478).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  // 左眼 33/133 横距 0.04，159/145 竖距 0.012 → EAR 0.3（睁眼）
  landmarks[33] = { x: 0.5, y: 0.5 };
  landmarks[133] = { x: 0.54, y: 0.5 };
  landmarks[159] = { x: 0.52, y: 0.488 };
  landmarks[145] = { x: 0.52, y: 0.5 };
  // 右眼
  landmarks[362] = { x: 0.54, y: 0.5 };
  landmarks[263] = { x: 0.5, y: 0.5 };
  landmarks[386] = { x: 0.52, y: 0.488 };
  landmarks[374] = { x: 0.52, y: 0.5 };
  // 嘴 61/291 横距 0.04，13/14 竖距 0.012 → MAR 0.3（闭嘴）
  landmarks[61] = { x: 0.5, y: 0.7 };
  landmarks[291] = { x: 0.54, y: 0.7 };
  landmarks[13] = { x: 0.52, y: 0.688 };
  landmarks[14] = { x: 0.52, y: 0.7 };
  return landmarks;
}

function stubLandmarker(faces: Array<{ x: number; y: number }[]>) {
  setLandmarkerDeps({
    createFileset: vi.fn(async () => ({}) as never),
    createLandmarker: vi.fn(
      async () =>
        ({
          detect: () => ({
            faceLandmarks: faces,
            facialTransformationMatrixes: faces.map(() => []),
          }),
          close: vi.fn(),
        }) as never,
    ),
  });
}

function bitmap(w = 512, h = 512): StaticBitmapSource {
  return { width: w, height: h } as unknown as StaticBitmapSource;
}

/** 假像素 deps：左半 luma 60 带条纹、右半 luma 180 带条纹（仅均值不同） */
function qualityDeps(w = 512, h = 512): QualityDeps {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const stripe = ((x + y) / 8) % 2 < 1 ? 0 : 30;
      const base = x < w / 2 ? 60 : 180;
      const v = base + stripe;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const ctx = {
    drawImage: () => {},
    getImageData: (_x: number, _y: number, ww: number, hh: number) => ({
      data,
      width: ww,
      height: hh,
    }),
  };
  return {
    createCanvas: ((ww: number, hh: number) => ({
      width: ww,
      height: hh,
    })) as QualityDeps["createCanvas"],
    canvasContext: () => ctx as unknown as CanvasRenderingContext2D,
  };
}

afterEach(() => {
  resetLandmarkersForTest();
});

describe("runStaticCheck (O2)", () => {
  it("produces eye/mouth geometry and a background metric for a detected face (O2)", async () => {
    stubLandmarker([openEyesFaceLandmarks()]);
    const result = await runStaticCheck(bitmap(), { qualityDeps: qualityDeps() });
    expect(result.poseAvailable).toBe(true);
    expect(result.faceGeometry).toEqual({ eyesClosed: false, mouthOpen: false });
    // 左 60 / 右 180 均值差 120 > 40 阈值 → 背景指标已测量
    expect(result.quality.metrics.background).not.toBeNull();
    expect(result.quality.metrics.background!.leftRightDiff).toBeGreaterThan(40);
    expect(result.quality.metrics.background!.lumaStd).toBeGreaterThan(0);
  });

  it("marks face geometry unchecked when the model fails (O2)", async () => {
    stubLandmarker([]);
    // landmarker 正常但 detect 返回空 → 无主脸 → 几何 null、背景 null
    const result = await runStaticCheck(bitmap(), { qualityDeps: qualityDeps() });
    expect(result.poseAvailable).toBe(true);
    expect(result.faceGeometry).toBeNull();
    expect(result.quality.metrics.background).toBeNull();
  });

  it("formats the recheck warning as a complete Chinese sentence (O4)", () => {
    const warnings = staticCheckWarnings({
      poseAvailable: true,
      pose: {
        status: "unstable",
        guidanceHints: ["raise-head"],
        angles: { yaw: 0, pitch: 12, roll: 0 },
        faceWidthRatio: 0.3,
        faceOffset: { x: 0, y: 0 },
        stableMs: 0,
        shootable: false,
      },
      faceGeometry: null,
      quality: {
        status: "warn",
        issues: ["曝光与清晰度未发现明显问题（启发式，仅供参考）"],
        metrics: {
          darkClipRatio: 0,
          brightClipRatio: 0,
          sharpness: 120,
          background: null,
        },
      },
    });
    expect(warnings).toEqual(["姿态复检未通过：姿势需调整：请抬头一点。"]);
  });

  it("keeps poseAvailable false and geometry null when the model throws (O2)", async () => {
    setLandmarkerDeps({
      createFileset: vi.fn(async () => ({}) as never),
      createLandmarker: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    });
    const result = await runStaticCheck(bitmap(), { qualityDeps: qualityDeps() });
    expect(result.poseAvailable).toBe(false);
    expect(result.faceGeometry).toBeNull();
    expect(result.quality.metrics.background).toBeNull();
  });
});
