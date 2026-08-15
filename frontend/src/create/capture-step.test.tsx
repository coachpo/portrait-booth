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
    label: { en: "US visa" },
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
      issues: ["exposure and sharpness show no obvious issues (heuristic, for reference only)"],
      metrics: {
        darkClipRatio: 0,
        brightClipRatio: 0,
        sharpness: 0,
        background: null,
      },
    },
    faceGeometry: null,
    faceAnchors: null,
  });
  // Pose inference stack isolation: default to "model available"; PoseGuide
  // renders null in jsdom, injecting no model <script> and leaving no
  // dangling Promises
  vi.mocked(acquireVideoLandmarker).mockResolvedValue({
    detectVideo: vi.fn().mockReturnValue([]),
  });
  vi.mocked(isFrontCamera).mockReturnValue(true);
  vi.mocked(listVideoDevices).mockResolvedValue([]);
  vi.mocked(openCamera).mockResolvedValue(fakeStream());
  // jsdom does not implement video.play
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  // jsdom has no mediaDevices: capability detection runs the real
  // implementation, so provide the shape it expects
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
    expect(screen.getByRole("button", { name: "Open camera" })).toBeInTheDocument();
    expect(openCamera).not.toHaveBeenCalled();
  });

  it("blocks the camera button when the browser cannot open one (§10.2)", () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
    renderStep();
    expect(screen.getByRole("button", { name: "Open camera" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("getUserMedia");
  });

  it("stops the stream after the page stays hidden (CAM-005)", async () => {
    const stream = fakeStream();
    vi.mocked(openCamera).mockResolvedValue(stream);
    const hiddenStopMs = 30_000;
    render(
      <CaptureStep
        template={template}
        onReady={vi.fn()}
        onBack={vi.fn()}
        hiddenStopMs={hiddenStopMs}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    await screen.findByRole("button", { name: "Shoot" });
    // findByRole resolves on the DOM mutation, but the effect registering the
    // visibilitychange listener is a passive effect flushed later; under load
    // the dispatch below used to land before it and hit no listener at all
    await act(async () => {});
    // From here the threshold runs on a fake clock, never on wall time
    vi.useFakeTimers();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(hiddenStopMs - 1);
    });
    expect(stream.getVideoTracks()[0].stop).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // Restore before asserting: a failing assertion must not leak "hidden"
    // into the tests that follow
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    // RTL polling (waitFor/findBy*) hangs on a frozen clock, and is no longer
    // needed: act() has already flushed the timer's state update
    expect(stream.getVideoTracks()[0].stop).toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("auto-stopped");
  });

  it("starts the camera on click and shows the shutter (CAM-002/003)", async () => {
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    expect(await screen.findByRole("button", { name: "Shoot" })).toBeInTheDocument();
    expect(openCamera).toHaveBeenCalledTimes(1);
  });

  it("shows a retry path when permission is denied (CAM-002)", async () => {
    vi.mocked(openCamera).mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("permission denied");
    expect(screen.getByRole("button", { name: "Open camera" })).toBeInTheDocument();
  });

  it("falls back to relaxed constraints on OverconstrainedError (CAM-003)", async () => {
    vi.mocked(openCamera)
      .mockRejectedValueOnce(new DOMException("c", "OverconstrainedError"))
      .mockResolvedValueOnce(fakeStream());
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    await screen.findByRole("button", { name: "Shoot" });
    expect(openCamera).toHaveBeenNthCalledWith(2, { relaxed: true, deviceId: undefined });
  });

  it("captures a still and reports the source ready", async () => {
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    const onReady = vi.fn();
    renderStep(onReady);
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(await screen.findByRole("button", { name: "Shoot" }));
    expect(await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1)));
    expect(loadSourceImage).toHaveBeenCalledWith(blob);
  });

  it("counts down automatically only when enabled, and cancels (CAM-007)", async () => {
    const blob = new Blob([new Uint8Array(4)], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    // Use real timers until the camera is ready, then switch to fake
    // timers to drive the countdown
    fireEvent.click(await screen.findByRole("checkbox"));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Shoot" }));
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button", { name: /cancel \(2s\)/i })).toBeInTheDocument();
    // React batching: each tick needs its own flush to create the next
    // countdown timer
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
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    await screen.findByRole("button", { name: "Shoot" });
    expect((stream as unknown as { stop: ReturnType<typeof vi.fn> }).stop).not.toHaveBeenCalled();
    unmount();
    expect((stream as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });

  it("shows a device switcher when multiple cameras exist (CAM-008)", async () => {
    vi.mocked(listVideoDevices).mockResolvedValue([
      { kind: "videoinput", deviceId: "cam-1", label: "Front", groupId: "g" },
      { kind: "videoinput", deviceId: "cam-2", label: "Rear", groupId: "g" },
    ] as MediaDeviceInfo[]);
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    const select = await screen.findByRole("combobox", { name: /switch camera/i });
    fireEvent.change(select, { target: { value: "cam-2" } });
    expect(openCamera).toHaveBeenCalledWith({ deviceId: "cam-2" });
  });

  it("acquires the pose model only in live and releases it on unmount", async () => {
    // Regression: the status === "live" gate had zero coverage; deleting
    // the PoseGuide wiring would not turn red
    vi.mocked(releaseVideoLandmarker).mockClear();
    const { unmount } = renderStep();
    expect(acquireVideoLandmarker).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    await screen.findByRole("button", { name: "Shoot" });
    await vi.waitFor(() => expect(acquireVideoLandmarker).toHaveBeenCalledTimes(1));

    unmount();
    expect(releaseVideoLandmarker).toHaveBeenCalledTimes(1);
  });

  it("keeps the shutter usable when the pose model fails (GDE-006)", async () => {
    // The spec requires a model failure to only disable
    // automatic guidance, never block manual capture
    vi.mocked(acquireVideoLandmarker).mockRejectedValue(new Error("no wasm"));
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    await screen.findByText(/pose guidance unavailable/i);
    expect(screen.getByRole("button", { name: "Shoot" })).toBeEnabled();
  });

  it("reports the source even when the static recheck fails (GDE-006)", async () => {
    // A static-recheck failure is the second degraded branch at the step
    // level: the photo still goes to the next step
    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" });
    vi.mocked(captureStill).mockResolvedValue(blob);
    vi.mocked(loadSourceImage).mockResolvedValue(fakeSource());
    vi.mocked(runStaticCheck).mockRejectedValue(new Error("x"));
    const onReady = vi.fn();
    renderStep(onReady);
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(await screen.findByRole("button", { name: "Shoot" }));
    expect(await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1)));
  });

  it("reports a capture failure without locking the flow", async () => {
    vi.mocked(captureStill).mockResolvedValue(null);
    renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(await screen.findByRole("button", { name: "Shoot" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("capture failed");
    expect(screen.getByRole("button", { name: "Shoot" })).toBeInTheDocument();
  });
});
vi.mock("../pose/static-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pose/static-check")>();
  return { ...actual, runStaticCheck: vi.fn() };
});

describe("late capture results", () => {
  it("drops a capture that finishes after the user left the step", async () => {
    // Regression: shoot()'s async result had no generation check. Decoding
    // and the static recheck take hundreds of milliseconds, during which the
    // user clicked "Back"; a late onReady forced the state machine back to
    // the confirm step and disposed the other source photo in use.
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
    fireEvent.click(screen.getByRole("button", { name: "Open camera" }));
    fireEvent.click(await screen.findByRole("button", { name: "Shoot" }));
    // Wait until decoding has actually started before the user leaves -
    // otherwise the first generation check intercepts the request and the
    // "discovered stale after decode finished" path is never exercised
    await waitFor(() => expect(loadSourceImage).toHaveBeenCalled());

    // The user leaves this step
    unmount();
    // Only now does decoding finish
    await act(async () => {
      finishDecode(source);
    });

    expect(onReady).not.toHaveBeenCalled();
    // The late bitmap must be released, or this ImageBitmap is never
    // managed by anyone
    await waitFor(() => expect(source.dispose).toHaveBeenCalled());
  });
});
