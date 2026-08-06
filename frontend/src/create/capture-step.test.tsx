import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TemplateEntry } from "../lib/templates/types";
import type { SourceImage } from "../image/source";
import { CaptureStep } from "./capture-step";

vi.mock("../camera/camera", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../camera/camera")>();
  return {
    ...actual,
    openCamera: vi.fn(),
    captureStill: vi.fn(),
    listVideoDevices: vi.fn(),
    isFrontCamera: vi.fn(),
  };
});
vi.mock("../pose/landmarker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pose/landmarker")>();
  return {
    ...actual,
    acquireVideoLandmarker: vi.fn(),
    releaseVideoLandmarker: vi.fn(),
  };
});
vi.mock("../image/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../image/source")>();
  return { ...actual, loadSourceImage: vi.fn() };
});

import { captureStill, isFrontCamera, listVideoDevices, openCamera } from "../camera/camera";
import { loadSourceImage } from "../image/source";
import { acquireVideoLandmarker, releaseVideoLandmarker } from "../pose/landmarker";
import { runStaticCheck } from "../pose/static-check";

const template = {
  revision: {
    revisionId: "us@1",
    id: "us",
    version: 1,
    schemaVersion: 1,
    label: { zh: "美国签证" },
    jurisdiction: "US",
    documentType: "visa",
    submissionChannel: "digital_upload",
    applicantClass: "adult",
    sources: [],
    output: {
      kind: "exact_pixels",
      widthPx: 600,
      heightPx: 600,
      aspect: { width: 1, height: 1, enforcement: "mandatory", provenance: "derived" },
    },
    cropRules: [],
    captureRules: [],
    overlay: { kind: "none", ruleIds: [] },
    capabilities: {
      selfCapture: "allowed",
      crop: "allowed",
      rotate: "allowed",
      mirror: "forbidden",
      retouch: "forbidden",
      backgroundReplace: "forbidden",
      requiresOriginalCameraFile: false,
      requiresProfessionalPhotographer: false,
    },
    sourceNotes: {},
  },
  contentHash: "abc",
  publication: {
    revisionId: "us@1",
    status: "active",
    statusReason: "ok",
    owner: "o",
    reviewer: "r",
    verifiedAt: "2026-08-06",
    reviewDueAt: "2026-11-04",
    effectiveAt: "2026-08-06",
    publicationRevision: 1,
  },
} as unknown as TemplateEntry;

function fakeStream() {
  const stop = vi.fn();
  const track = { stop, getSettings: () => ({ facingMode: "user", deviceId: "cam-1" }) };
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
    stop,
  } as unknown as MediaStream;
}

function fakeSource(): SourceImage {
  return {
    file: new Blob([new Uint8Array(4)]),
    format: "jpeg",
    orientation: 1,
    rawWidth: 640,
    rawHeight: 480,
    width: 640,
    height: 480,
    bitmap: { width: 640, height: 480, close: vi.fn() } as unknown as ImageBitmap,
    previewUrl: "blob:fake",
    dispose: vi.fn(),
  };
}

function renderStep(onReady = vi.fn(), onBack = vi.fn()) {
  return render(<CaptureStep template={template} onReady={onReady} onBack={onBack} />);
}

beforeEach(() => {
  vi.mocked(runStaticCheck).mockResolvedValue({
    pose: null,
    poseAvailable: false,
    quality: {
      status: "warn",
      issues: ["曝光与清晰度未发现明显问题（启发式，仅供参考）"],
      metrics: {
        darkClipRatio: 0,
        brightClipRatio: 0,
        sharpness: 0,
        background: null,
      },
    },
    faceGeometry: null,
  });
  // 姿态推理栈隔离：默认走「模型可用」，PoseGuide 在 jsdom 下渲染 null，
  // 不注入模型 <script>、不留悬挂 Promise
  vi.mocked(acquireVideoLandmarker).mockResolvedValue({
    detectVideo: vi.fn().mockReturnValue([]),
  });
  vi.mocked(isFrontCamera).mockReturnValue(true);
  vi.mocked(listVideoDevices).mockResolvedValue([]);
  vi.mocked(openCamera).mockResolvedValue(fakeStream());
  // jsdom 未实现 video.play
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  // jsdom 没有 mediaDevices：能力检测跑的是真实实现，这里补上它期待的形状
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn().mockResolvedValue([]) },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CaptureStep", () => {
  it("does not request the camera until the user clicks (CAM-001)", () => {
    renderStep();
    expect(screen.getByRole("button", { name: "开启摄像头" })).toBeInTheDocument();
    expect(openCamera).not.toHaveBeenCalled();
  });

  it("blocks the camera button when the browser cannot open one (§10.2)", () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    renderStep();
    expect(screen.getByRole("button", { name: "开启摄像头" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("getUserMedia");
  });

  it("stops the stream after the page stays hidden (CAM-005)", async () => {
    const stream = fakeStream();
    vi.mocked(openCamera).mockResolvedValue(stream);
    // 门限注入成极短值，测试不需要假时钟，也就不会和 RTL 的轮询打架
    render(<CaptureStep template={template} onReady={vi.fn()} onBack={vi.fn()} hiddenStopMs={5} />);
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    await screen.findByRole("button", { name: "拍摄" });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    await waitFor(() => expect(stream.getVideoTracks()[0].stop).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent("已自动关闭");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("starts the camera on click and shows the shutter (CAM-002/003)", async () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    expect(await screen.findByRole("button", { name: "拍摄" })).toBeInTheDocument();
    expect(openCamera).toHaveBeenCalledTimes(1);
  });

  it("shows a retry path when permission is denied (CAM-002)", async () => {
    vi.mocked(openCamera).mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("权限被拒绝");
    expect(screen.getByRole("button", { name: "开启摄像头" })).toBeInTheDocument();
  });

  it("falls back to relaxed constraints on OverconstrainedError (CAM-003)", async () => {
    vi.mocked(openCamera)
      .mockRejectedValueOnce(new DOMException("c", "OverconstrainedError"))
      .mockResolvedValueOnce(fakeStream());
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    await screen.findByRole("button", { name: "拍摄" });
    expect(openCamera).toHaveBeenNthCalledWith(2, { relaxed: true, deviceId: undefined });
  });

  it("captures a still and reports the source ready", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    const onReady = vi.fn();
    renderStep(onReady);
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    fireEvent.click(await screen.findByRole("button", { name: "拍摄" }));
    expect(await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1)));
    expect(loadSourceImage).toHaveBeenCalledWith(blob);
  });

  it("counts down automatically only when enabled, and cancels (CAM-007)", async () => {
    const blob = new Blob([new Uint8Array(4)], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    // 先用真实 timers 等相机就绪，再切 fake timers 驱动倒计时
    fireEvent.click(await screen.findByRole("checkbox"));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "拍摄" }));
    expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button", { name: /取消（2 秒）/ })).toBeInTheDocument();
    // React 批处理：每个 tick 需要独立 flush 才能创建下一个倒计时 timer
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {});
    expect(captureStill).toHaveBeenCalledTimes(1);
  });

  it("stops tracks when unmounting (CAM-005)", async () => {
    const stream = fakeStream();
    vi.mocked(openCamera).mockResolvedValue(stream);
    const { unmount } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    await screen.findByRole("button", { name: "拍摄" });
    expect((stream as unknown as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
    unmount();
    expect((stream as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it("shows a device switcher when multiple cameras exist (CAM-008)", async () => {
    vi.mocked(listVideoDevices).mockResolvedValue([
      { kind: "videoinput", deviceId: "cam-1", label: "前置", groupId: "g" },
      { kind: "videoinput", deviceId: "cam-2", label: "后置", groupId: "g" },
    ] as MediaDeviceInfo[]);
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    const select = await screen.findByRole("combobox", { name: /切换摄像头/ });
    fireEvent.change(select, { target: { value: "cam-2" } });
    expect(openCamera).toHaveBeenCalledWith({ deviceId: "cam-2" });
  });

  it("acquires the pose model only in live and releases it on unmount", async () => {
    // 回归：status === "live" 门控零覆盖，PoseGuide 接线被删也不会红
    vi.mocked(releaseVideoLandmarker).mockClear();
    const { unmount } = renderStep();
    expect(acquireVideoLandmarker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    await screen.findByRole("button", { name: "拍摄" });
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalledTimes(1));

    unmount();
    expect(releaseVideoLandmarker).toHaveBeenCalledTimes(1);
  });

  it("keeps the shutter usable when the pose model fails (GDE-006)", async () => {
    // 规格要求模型失败时只关自动指导、不阻止手动拍摄
    vi.mocked(acquireVideoLandmarker).mockRejectedValue(new Error("no wasm"));
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    await screen.findByText(/自动姿态指导不可用/);
    expect(screen.getByRole("button", { name: "拍摄" })).toBeEnabled();
  });

  it("reports the source even when the static recheck fails (GDE-006)", async () => {
    // 静态复检失败是步骤层第二条降级支路：仍把照片交给下一步
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    vi.mocked(runStaticCheck).mockRejectedValue(new Error("x"));
    const onReady = vi.fn();
    renderStep(onReady);
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    fireEvent.click(await screen.findByRole("button", { name: "拍摄" }));
    expect(await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1)));
  });

  it("reports a capture failure without locking the flow", async () => {
    vi.mocked(captureStill).mockResolvedValue(null);
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    fireEvent.click(await screen.findByRole("button", { name: "拍摄" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("拍摄失败");
    expect(screen.getByRole("button", { name: "拍摄" })).toBeInTheDocument();
  });
});
vi.mock("../pose/static-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pose/static-check")>();
  return { ...actual, runStaticCheck: vi.fn() };
});

describe("迟到的拍摄结果", () => {
  it("drops a capture that finishes after the user left the step", async () => {
    // 回归：shoot() 的异步结果没有代际检查。解码与静态复检要几百毫秒，
    // 期间用户点了「返回」；迟到的 onReady 会把状态机硬推到确认步，
    // 并 dispose 掉当时正在使用的另一张源照片。
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    const source = fakeSource();
    let finishDecode: (value: SourceImage) => void = () => {};
    vi.mocked(loadSourceImage).mockReturnValue(
      new Promise<SourceImage>((resolve) => {
        finishDecode = resolve;
      }),
    );

    const onReady = vi.fn();
    const { unmount } = render(
      <CaptureStep template={template} onReady={onReady} onBack={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "开启摄像头" }));
    fireEvent.click(await screen.findByRole("button", { name: "拍摄" }));
    // 等到解码真的开始，再让用户离开——否则第一道代际检查就把请求拦下了，
    // 测不到「解码完成后才发现自己已经过时」这条路径
    await waitFor(() => expect(loadSourceImage).toHaveBeenCalled());

    // 用户离开这一步
    unmount();
    // 解码这才完成
    await act(async () => {
      finishDecode(source);
    });

    expect(onReady).not.toHaveBeenCalled();
    // 迟到的位图必须被释放，否则这份 ImageBitmap 永远没人管
    await waitFor(() => expect(source.dispose).toHaveBeenCalled());
  });
});
