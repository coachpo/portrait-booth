import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { PoseGuide } from "./pose-guide";

vi.mock("./landmarker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./landmarker")>();
  return {
    ...actual,
    acquireVideoLandmarker: vi.fn(),
    releaseVideoLandmarker: vi.fn(),
  };
});

import { acquireVideoLandmarker, releaseVideoLandmarker } from "./landmarker";
import type { FaceObservation } from "./tracking";

/** 列主序单位矩阵：正对镜头 */
const MOCK_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function faceObservation(): FaceObservation {
  // 带眼/下巴关键点（宽度 0.3、居中）——位置合规
  const landmarks = new Array<{ x: number; y: number; z?: number }>(478).fill({ x: 0.5, y: 0.5 });
  landmarks[33] = { x: 0.35, y: 0.4 };
  landmarks[263] = { x: 0.65, y: 0.4 };
  landmarks[10] = { x: 0.5, y: 0.2 };
  landmarks[152] = { x: 0.5, y: 0.65 };
  return { faceIndex: 0, landmarks, matrix: MOCK_MATRIX };
}

/** jsdom 没有 requestVideoFrameCallback：手工装一个可驱动、可断言的实现 */
function makeVideo(withRvfc = false) {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: 640 });
  Object.defineProperty(video, "videoHeight", { value: 480 });
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  const cancel = vi.fn((handle: number) => {
    pending.delete(handle);
  });
  if (withRvfc) {
    Object.assign(video, {
      requestVideoFrameCallback: (cb: () => void) => {
        const handle = nextHandle++;
        pending.set(handle, cb);
        return handle;
      },
      cancelVideoFrameCallback: cancel,
    });
  }
  const tick = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const cb of callbacks) cb();
  };
  return { video, tick, cancel, pendingCount: () => pending.size };
}

function mockLandmarker(faces: FaceObservation[] = [faceObservation()]) {
  const detectVideo = vi.fn().mockReturnValue(faces);
  vi.mocked(acquireVideoLandmarker).mockResolvedValue({ detectVideo });
  return detectVideo;
}

// 用 beforeEach 而不是 afterEach：testing-library 的自动 cleanup 也注册在 afterEach，
// 卸载组件时还会再调一次 releaseVideoLandmarker，计数会漏到下一个用例。
beforeEach(() => {
  vi.clearAllMocks();
});

describe("PoseGuide", () => {
  it("shows guidance when the model returns a face", async () => {
    mockLandmarker();
    const { video, tick } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);

    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());
    await act(async () => {
      tick();
    });

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/姿势稳定|需调整/);
  });

  it("falls back gracefully when the model fails to load (GDE-006)", async () => {
    vi.mocked(acquireVideoLandmarker).mockRejectedValue(new Error("no wasm"));
    const { video } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("自动姿态指导不可用");
    expect(status).toHaveTextContent("仍可手动拍摄");
  });

  it("releases the video landmarker on unmount (GDE-007)", async () => {
    mockLandmarker();
    const { video } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    const { unmount } = render(<PoseGuide videoRef={videoRef} mirrored={true} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());

    unmount();
    expect(releaseVideoLandmarker).toHaveBeenCalledTimes(1);
  });

  it("cancels the rVFC loop on unmount", async () => {
    // 回归：旧实现只调 cancelAnimationFrame，rVFC 分支的回调会一直自我续订，
    // 卸载后继续推理，每次切换摄像头再叠加一条循环。
    mockLandmarker();
    const { video, cancel, tick, pendingCount } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    const { unmount } = render(<PoseGuide videoRef={videoRef} mirrored={false} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());
    await act(async () => {
      tick();
    });
    expect(pendingCount()).toBe(1);

    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pendingCount()).toBe(0);
  });

  it("stops inferring after unmount", async () => {
    const detectVideo = mockLandmarker();
    const { video, tick } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    const { unmount } = render(<PoseGuide videoRef={videoRef} mirrored={false} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());
    await act(async () => {
      tick();
    });
    const callsBefore = detectVideo.mock.calls.length;

    unmount();
    tick();
    expect(detectVideo.mock.calls.length).toBe(callsBefore);
  });

  it("throttles inference instead of running at display frame rate", async () => {
    // 回归：旧实现靠 landmarker 内的 busy 标志丢帧，但推理是同步的，
    // 函数返回时 busy 必然已复位——那个分支永远不成立。
    const detectVideo = mockLandmarker();
    const { video, tick } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());

    await act(async () => {
      for (let i = 0; i < 8; i++) tick();
    });
    // 8 帧在同一个 83 ms 窗口内到达：只允许一次推理
    expect(detectVideo).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild the landmarker when the mirror flag flips", async () => {
    // 回归：mirrored 曾在 effect 依赖里，每次前后摄切换都重新下载并初始化模型
    mockLandmarker();
    const { video } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    const { rerender } = render(<PoseGuide videoRef={videoRef} mirrored={false} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalledTimes(1));

    rerender(<PoseGuide videoRef={videoRef} mirrored={true} />);
    rerender(<PoseGuide videoRef={videoRef} mirrored={false} />);

    expect(acquireVideoLandmarker).toHaveBeenCalledTimes(1);
    expect(releaseVideoLandmarker).not.toHaveBeenCalled();
  });
});
