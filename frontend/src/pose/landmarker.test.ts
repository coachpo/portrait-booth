import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireImageLandmarker,
  acquireVideoLandmarker,
  NUM_FACES,
  releaseLandmarkers,
  resetLandmarkersForTest,
  setLandmarkerDeps,
} from "./landmarker";

interface CreatedOptions {
  runningMode: "VIDEO" | "IMAGE";
  numFaces: number;
  outputFaceBlendshapes: boolean;
  outputFacialTransformationMatrixes: boolean;
}

function stubDeps() {
  const created: CreatedOptions[] = [];
  const closed: string[] = [];
  const videoTimestamps: number[] = [];
  const detectCalls: string[] = [];

  const createLandmarker = vi.fn(async (_fileset: unknown, options: CreatedOptions) => {
    created.push(options);
    return {
      detectForVideo: (_frame: unknown, ts: number) => {
        videoTimestamps.push(ts);
        detectCalls.push("video");
        return { faceLandmarks: [[{ x: 0.5, y: 0.5, z: 0 }]], facialTransformationMatrixes: [] };
      },
      detect: () => {
        detectCalls.push("image");
        return { faceLandmarks: [], facialTransformationMatrixes: [] };
      },
      close: () => closed.push(options.runningMode),
    };
  });

  setLandmarkerDeps({
    createFileset: vi.fn(async () => ({}) as never),
    createLandmarker: createLandmarker as never,
  });

  return { created, closed, videoTimestamps, detectCalls, createLandmarker };
}

afterEach(() => {
  resetLandmarkersForTest();
});

describe("landmarker instances", () => {
  it("reuses one VIDEO instance across acquisitions", async () => {
    const { created, createLandmarker } = stubDeps();
    await acquireVideoLandmarker();
    await acquireVideoLandmarker();
    expect(createLandmarker).toHaveBeenCalledTimes(1);
    expect(created[0].runningMode).toBe("VIDEO");
  });

  it("reuses one IMAGE instance across static rechecks", async () => {
    // GDE-005 的验收：连续两次静态复检只创建一次 landmarker
    const { createLandmarker } = stubDeps();
    await acquireImageLandmarker();
    await acquireImageLandmarker();
    expect(createLandmarker).toHaveBeenCalledTimes(1);
  });

  it("keeps VIDEO and IMAGE as separate instances", async () => {
    // VIDEO 模式带跨帧 ROI 回环，复用会把预览的 ROI 先验带进静态复检
    const { created } = stubDeps();
    await acquireVideoLandmarker();
    await acquireImageLandmarker();
    expect(created.map((c) => c.runningMode)).toEqual(["VIDEO", "IMAGE"]);
  });

  it("keeps blendshapes off and numFaces at the spec value", async () => {
    const { created } = stubDeps();
    await acquireVideoLandmarker();
    expect(created[0].outputFaceBlendshapes).toBe(false);
    expect(created[0].outputFacialTransformationMatrixes).toBe(true);
    expect(created[0].numFaces).toBe(NUM_FACES);
  });

  it("feeds strictly increasing timestamps to detectForVideo", async () => {
    // 混用 performance.now()（约 1e4）与 Date.now()（约 1.75e12）会让 wasm 抛
    // "New timestamp is equal or less than the last one."
    const { videoTimestamps } = stubDeps();
    const client = await acquireVideoLandmarker();
    client.detectVideo({} as ImageBitmap, 1000);
    client.detectVideo({} as ImageBitmap, 1000);
    client.detectVideo({} as ImageBitmap, 500);
    client.detectVideo({} as ImageBitmap, 5000);
    for (let i = 1; i < videoTimestamps.length; i++) {
      expect(videoTimestamps[i]).toBeGreaterThan(videoTimestamps[i - 1]);
    }
  });

  it("does not cache a failed creation", async () => {
    const createLandmarker = vi
      .fn()
      .mockRejectedValueOnce(new Error("no wasm"))
      .mockResolvedValueOnce({ detectForVideo: () => ({ faceLandmarks: [] }), close: () => {} });
    setLandmarkerDeps({
      createFileset: vi.fn(async () => ({}) as never),
      createLandmarker: createLandmarker as never,
    });

    await expect(acquireVideoLandmarker()).rejects.toThrow("no wasm");
    await expect(acquireVideoLandmarker()).resolves.toBeDefined();
    expect(createLandmarker).toHaveBeenCalledTimes(2);
  });

  it("closes both instances on release and rebuilds on demand", async () => {
    const { closed, createLandmarker } = stubDeps();
    await acquireVideoLandmarker();
    await acquireImageLandmarker();

    releaseLandmarkers();
    await vi.waitFor(() => expect(closed.sort()).toEqual(["IMAGE", "VIDEO"]));

    await acquireVideoLandmarker();
    expect(createLandmarker).toHaveBeenCalledTimes(3);
  });
});
