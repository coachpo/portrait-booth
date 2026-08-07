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

/** Column-major identity matrix: facing the camera */
const MOCK_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function faceObservation(): FaceObservation {
  // With eye/chin landmarks (width 0.3, centered) - position compliant
  const landmarks = new Array<{ x: number; y: number; z?: number }>(478).fill({ x: 0.5, y: 0.5 });
  landmarks[33] = { x: 0.35, y: 0.4 };
  landmarks[263] = { x: 0.65, y: 0.4 };
  landmarks[10] = { x: 0.5, y: 0.2 };
  landmarks[152] = { x: 0.5, y: 0.65 };
  return { faceIndex: 0, landmarks, matrix: MOCK_MATRIX };
}

/** jsdom has no requestVideoFrameCallback: hand-install a drivable,
 * assertable implementation */
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

// Use beforeEach instead of afterEach: testing-library's automatic cleanup
// is also registered in afterEach, and unmounting the component calls
// releaseVideoLandmarker once more, leaking the count into the next case.
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
    expect(status).toHaveTextContent(/pose stable|needs adjustment/i);
  });

  it("falls back gracefully when the model fails to load (GDE-006)", async () => {
    vi.mocked(acquireVideoLandmarker).mockRejectedValue(new Error("no wasm"));
    const { video } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Automatic pose guidance unavailable");
    expect(status).toHaveTextContent("manual capture still works");
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
    // Regression: the old implementation only called cancelAnimationFrame,
    // so the rVFC branch kept re-scheduling itself: inference continued
    // after unmount and each camera switch stacked another loop.
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

  it("updates the guidance text when hints change within the same status (O4)", async () => {
    // Regression: if sameGuidance compared only status and not hints, the
    // same status (out-of-position) with hints changing from "closer" to
    // "closer + right" would be treated as unchanged and never update
    const outOfPositionFace = (width: number, offsetX: number) => {
      const f = faceObservation();
      const left = 0.5 - width / 2 + offsetX;
      const right = 0.5 + width / 2 + offsetX;
      f.landmarks = new Array<{ x: number; y: number; z?: number }>(478).fill({
        x: 0.5,
        y: 0.5,
      });
      f.landmarks[33] = { x: left, y: 0.4 };
      f.landmarks[263] = { x: right, y: 0.4 };
      f.landmarks[10] = { x: 0.5, y: 0.2 };
      f.landmarks[152] = { x: 0.5, y: 0.65 };
      return f;
    };
    let faces: FaceObservation[] = [outOfPositionFace(0.05, 0)];
    const detectVideo = vi.fn().mockImplementation(() => faces);
    vi.mocked(acquireVideoLandmarker).mockResolvedValue({ detectVideo } as never);
    const { video, tick } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(0);
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());

    await act(async () => tick());
    const status = await screen.findByRole("status");
    const before = status.textContent;

    // Same status, hints change from [move-closer] to [move-closer,
    // move-own-right]
    faces = [outOfPositionFace(0.05, 0.3)];
    nowSpy.mockReturnValue(200);
    await act(async () => tick());
    expect(status.textContent).not.toBe(before);
    expect(status.textContent).toContain("move a little closer");
    expect(status.textContent).toContain("move to your own right");
    nowSpy.mockRestore();
  });

  it("throttles inference instead of running at display frame rate", async () => {
    // Regression: the old implementation relied on the landmarker's busy
    // flag to drop frames, but inference is synchronous - by the time the
    // function returns busy is already reset, so that branch never fired.
    const detectVideo = mockLandmarker();
    const { video, tick } = makeVideo(true);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = video;
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalled());

    await act(async () => {
      for (let i = 0; i < 8; i++) tick();
    });
    // 8 frames arrive within the same 83 ms window: only one inference
    // allowed
    expect(detectVideo).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild the landmarker when the mirror flag flips", async () => {
    // Regression: mirrored used to be in the effect deps, re-downloading
    // and re-initializing the model on every front/rear camera switch
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
