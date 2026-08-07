/**
 * Camera wrapper (CAM-001~008).
 * getUserMedia is only called after an explicit user action; track lifecycle
 * is managed by the caller via tokens.
 */

export interface CameraRequest {
  deviceId?: string;
  /** Relaxed retry: only {audio:false, video:true}, for the constrained
   * fallback path after a failure (CAM-003) */
  relaxed?: boolean;
}

export interface CameraSupport {
  supported: boolean;
  /** An actionable reason when unsupported, instead of a generic error
   * after the user clicks */
  reason?: string;
}

/**
 * §10.2 capability detection: first confirm this browser/context can open a
 * camera at all. Without it, browsers without getUserMedia and insecure
 * contexts both end up at "failed to open camera: retry" - retrying never
 * helps.
 */
export function checkCameraSupport(): CameraSupport {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      supported: false,
      reason:
        "this browser does not support camera capture (no getUserMedia): please upload a photo instead.",
    };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return {
      supported: false,
      reason:
        "the camera needs an HTTPS or localhost secure context: please upload a photo instead, or visit over HTTPS.",
    };
  }
  return { supported: true };
}

/**
 * Start <video> playback. iOS Safari only allows autoplay with
 * muted + playsInline + autoplay all present; missing any one makes play()
 * reject. The failure reason must be surfaced, otherwise the user sees a
 * permanently black preview while the UI says "ready".
 */
export async function attachStream(
  video: HTMLVideoElement,
  stream: MediaStream,
): Promise<{ playing: boolean; reason?: string }> {
  video.srcObject = stream;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  try {
    await video.play();
    return { playing: true };
  } catch (err) {
    // jsdom's DOMException does not extend Error: recognize both, or name
    // would never be readable
    const name = err instanceof DOMException || err instanceof Error ? err.name : "";
    return {
      playing: false,
      reason:
        name === "NotAllowedError"
          ? "the browser blocked preview autoplay: click the preview area and try again."
          : "preview cannot play: try again, or upload a photo instead.",
    };
  }
}

export function openCamera(req: CameraRequest = {}): Promise<MediaStream> {
  const video: MediaStreamConstraints["video"] = req.relaxed
    ? true
    : {
        facingMode: { ideal: "user" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        ...(req.deviceId ? { deviceId: { exact: req.deviceId } } : {}),
      };
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listVideoDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

/** CAM-004: preview mirroring does not affect capture; the rear camera is not mirrored. */
export function isFrontCamera(stream: MediaStream | null): boolean {
  const settings = stream?.getVideoTracks()[0]?.getSettings();
  return settings?.facingMode === "user";
}

/** CAM-006: high-resolution enhancement after ImageCapture capability
 * detection; falls back to canvas capture on failure or hang. */
export async function captureWithImageCapture(video: HTMLVideoElement): Promise<Blob | null> {
  if (typeof ImageCapture === "undefined") return null;
  const src = video.srcObject;
  const track =
    typeof MediaStream !== "undefined" && src instanceof MediaStream
      ? src.getVideoTracks()[0]
      : null;
  if (!track) return null;
  // Some browsers (including headless) half-implement ImageCapture:
  // takePhoto can hang forever, so add a timeout fallback
  try {
    const photo = await Promise.race([
      new ImageCapture(track).takePhoto(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    return photo;
  } catch {
    return null;
  }
}

/** CAM-006: baseline capture - draw from the <video>'s intrinsic pixels to a Canvas. */
export async function captureFromVideo(video: HTMLVideoElement): Promise<Blob | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
}

export async function captureStill(video: HTMLVideoElement): Promise<Blob | null> {
  return (await captureWithImageCapture(video)) ?? (await captureFromVideo(video));
}

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return "camera permission denied: allow camera access in the browser address bar and retry, or upload a photo instead.";
    case "NotFoundError":
      return "no camera device detected: connect a camera and retry, or upload a photo instead.";
    case "NotReadableError":
      return "the camera is in use by another application: close the program using it and retry.";
    case "OverconstrainedError":
      return "the camera does not satisfy the required constraints: retry, or upload a photo instead.";
    case "SecurityError":
      return "HTTPS or a local secure context is required to use the camera.";
    default:
      return "failed to open the camera: retry, or upload a photo instead.";
  }
}
