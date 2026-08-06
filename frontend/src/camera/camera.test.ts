import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cameraErrorMessage,
  captureStill,
  captureWithImageCapture,
  isFrontCamera,
  listVideoDevices,
  openCamera,
  stopStream,
} from "./camera";

beforeEach(() => {
  // jsdom 未实现 mediaDevices
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn() },
  });
});

function mockGetUserMedia(impl: (constraints?: MediaStreamConstraints) => Promise<MediaStream>) {
  return vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(impl);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openCamera (CAM-001/003)", () => {
  it("requests audio:false with ideal constraints by default", async () => {
    const spy = mockGetUserMedia(vi.fn(async () => ({}) as MediaStream));
    await openCamera();
    expect(spy).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  });

  it("passes the selected device as exact", async () => {
    const spy = mockGetUserMedia(vi.fn(async () => ({}) as MediaStream));
    await openCamera({ deviceId: "cam-1" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ deviceId: { exact: "cam-1" } }),
      }),
    );
  });

  it("uses relaxed constraints for retry", async () => {
    const spy = mockGetUserMedia(vi.fn(async () => ({}) as MediaStream));
    await openCamera({ relaxed: true });
    expect(spy).toHaveBeenCalledWith({ audio: false, video: true });
  });
});

describe("cameraErrorMessage (CAM-002)", () => {
  it("maps permission denial to guidance", () => {
    const msg = cameraErrorMessage(new DOMException("denied", "NotAllowedError"));
    expect(msg).toContain("权限被拒绝");
    expect(msg).toContain("改用上传照片");
  });

  it("maps missing device", () => {
    expect(cameraErrorMessage(new DOMException("none", "NotFoundError"))).toContain(
      "未检测到摄像头设备",
    );
  });

  it("maps constraint failure", () => {
    expect(cameraErrorMessage(new DOMException("c", "OverconstrainedError"))).toContain(
      "不满足所需约束",
    );
  });

  it("falls back to a generic message", () => {
    expect(cameraErrorMessage(new Error("boom"))).toContain("打开摄像头失败");
  });
});

describe("stream helpers (CAM-005/008)", () => {
  it("stops every track", () => {
    const stop = vi.fn();
    const other = vi.fn();
    const stream = {
      getTracks: () => [{ stop }, { stop: other }],
    } as unknown as MediaStream;
    stopStream(stream);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("tolerates null streams", () => {
    expect(() => stopStream(null)).not.toThrow();
  });

  it("filters video input devices", async () => {
    vi.spyOn(navigator.mediaDevices, "enumerateDevices").mockResolvedValue([
      { kind: "videoinput", deviceId: "a", label: "Camera", groupId: "g" },
      { kind: "audioinput", deviceId: "b", label: "Mic", groupId: "g" },
    ] as MediaDeviceInfo[]);
    const devices = await listVideoDevices();
    expect(devices.map((d) => d.deviceId)).toEqual(["a"]);
  });

  it("detects front camera from track settings (CAM-004)", () => {
    const stream = {
      getVideoTracks: () => [{ getSettings: () => ({ facingMode: "user" }) }],
    } as unknown as MediaStream;
    expect(isFrontCamera(stream)).toBe(true);
    expect(isFrontCamera(null)).toBe(false);
  });
});

describe("captureStill (CAM-006)", () => {
  it("uses ImageCapture when available", async () => {
    const photo = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });
    const takePhoto = vi.fn(async () => photo);
    class FakeImageCapture {
      takePhoto = takePhoto;
    }
    class FakeStream {
      getVideoTracks() {
        return [{}];
      }
    }
    vi.stubGlobal("ImageCapture", FakeImageCapture);
    vi.stubGlobal("MediaStream", FakeStream);
    const video = { srcObject: new FakeStream() } as unknown as HTMLVideoElement;
    const result = await captureWithImageCapture(video);
    expect(result).toBe(photo);
    expect(takePhoto).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("returns null when ImageCapture is unsupported", async () => {
    vi.stubGlobal("ImageCapture", undefined);
    const video = {} as HTMLVideoElement;
    expect(await captureStill(video)).toBeNull();
    vi.unstubAllGlobals();
  });
});
