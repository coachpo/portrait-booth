import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireImageLandmarker,
  acquireVideoLandmarker,
  NUM_FACES,
  releaseLandmarkers,
  releaseVideoLandmarker,
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
    // GDE-005 acceptance: two consecutive static rechecks create the landmarker only once
    const { createLandmarker } = stubDeps();
    await acquireImageLandmarker();
    await acquireImageLandmarker();
    expect(createLandmarker).toHaveBeenCalledTimes(1);
  });

  it("keeps VIDEO and IMAGE as separate instances", async () => {
    // VIDEO mode carries a cross-frame ROI loop; reusing it would leak the preview's ROI prior into the static recheck
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
    // Mixing performance.now() (~1e4) with Date.now() (~1.75e12) makes wasm throw
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

describe("failed creation cleanup", () => {
  it("a slow failure does not orphan a newer instance", async () => {
    // Regression: the creation-failure catch cleared videoInstance
    // unconditionally. When the first creation is slow and eventually fails,
    // the slot may already hold a later successful instance - its handle is
    // dropped, and releaseVideoLandmarker can never close it afterwards
    // (wasm heap and GL context leak together).
    let failFirst: (reason: unknown) => void = () => {};
    const closed: string[] = [];
    const second = {
      detectForVideo: () => ({ faceLandmarks: [], facialTransformationMatrixes: [] }),
      close: () => closed.push("second"),
    };
    const createLandmarker = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failFirst = reject;
          }),
      )
      .mockResolvedValueOnce(second);
    setLandmarkerDeps({
      createFileset: vi.fn(async () => ({}) as never),
      createLandmarker: createLandmarker as never,
    });

    const firstAttempt = acquireVideoLandmarker();
    const firstSettled = firstAttempt.catch(() => "failed");

    // User leaves and returns before the model finishes loading: release the old handle, re-acquire
    releaseVideoLandmarker();
    const client = await acquireVideoLandmarker();
    expect(client).toBeDefined();

    // Only now does the first creation fail
    failFirst(new Error("no wasm"));
    await firstSettled;

    // The new instance's handle must still be in the slot, otherwise it cannot be closed here
    releaseVideoLandmarker();
    await vi.waitFor(() => expect(closed).toEqual(["second"]));
  });
});
