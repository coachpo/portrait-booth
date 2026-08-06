import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";

import { PoseGuide } from "./pose-guide";

vi.mock("./landmarker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./landmarker")>();
  return { ...actual, createLandmarkerClient: vi.fn() };
});
vi.mock("./tracking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tracking")>();
  return { ...actual, PoseTracker: actual.PoseTracker };
});

import { createLandmarkerClient } from "./landmarker";
import type { FaceObservation } from "./tracking";

const MOCK_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function faceObservation(): FaceObservation {
  // 带眼/下巴关键点（宽度 0.3、居中）——位置合规
  const landmarks = new Array<{ x: number; y: number; z?: number }>(478).fill({ x: 0.5, y: 0.5 });
  landmarks[33] = { x: 0.35, y: 0.4 };
  landmarks[263] = { x: 0.65, y: 0.4 };
  landmarks[10] = { x: 0.5, y: 0.2 };
  landmarks[152] = { x: 0.5, y: 0.65 };
  return {
    faceIndex: 0,
    landmarks,
    matrix: MOCK_MATRIX,
    score: 1,
  };
}

function makeVideo() {
  const video = document.createElement("video");
  Object.defineProperty(video, "videoWidth", { value: 640 });
  Object.defineProperty(video, "videoHeight", { value: 480 });
  return video;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PoseGuide", () => {
  it("shows guidance when the model returns a face", async () => {
    const client = {
      detect: vi.fn().mockResolvedValue([faceObservation()]),
      detectStatic: vi.fn(),
      close: vi.fn(),
      available: true,
    };
    vi.mocked(createLandmarkerClient).mockResolvedValue(client);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = makeVideo();
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/姿势稳定|保持/);
    expect(client.close).not.toHaveBeenCalled();
  });

  it("falls back gracefully when the model fails to load (GDE-006)", async () => {
    vi.mocked(createLandmarkerClient).mockRejectedValue(new Error("no wasm"));
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = makeVideo();
    render(<PoseGuide videoRef={videoRef} mirrored={false} />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("自动姿态指导不可用");
    expect(status).toHaveTextContent("仍可手动拍摄");
  });

  it("closes the landmarker on unmount (GDE-007)", async () => {
    const client = {
      detect: vi.fn().mockResolvedValue([]),
      detectStatic: vi.fn(),
      close: vi.fn(),
      available: true,
    };
    vi.mocked(createLandmarkerClient).mockResolvedValue(client);
    const videoRef = createRef<HTMLVideoElement>();
    videoRef.current = makeVideo();
    const { unmount } = render(<PoseGuide videoRef={videoRef} mirrored={true} />);
    await screen.findByRole("status");
    unmount();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
