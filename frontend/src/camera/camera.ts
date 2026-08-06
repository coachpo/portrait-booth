/**
 * 摄像头封装（CAM-001~008）。
 * getUserMedia 仅在用户显式触发后调用；track 生命周期由调用方用 token 管理。
 */

export interface CameraRequest {
  deviceId?: string;
  /** 宽松重试：仅 {audio:false, video:true}，用于约束失败后的降级路径（CAM-003） */
  relaxed?: boolean;
}

export interface CameraSupport {
  supported: boolean;
  /** 不支持时给出可操作的原因，而不是让用户点下去再看到一句通用报错 */
  reason?: string;
}

/**
 * §10.2 能力检测：先确认这个浏览器/上下文根本能不能开摄像头。
 * 不做检测时，不支持 getUserMedia 的浏览器和非安全上下文都会走到
 * 「打开摄像头失败：请重试」——重试多少次都没用。
 */
export function checkCameraSupport(): CameraSupport {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      supported: false,
      reason: "此浏览器不支持摄像头拍摄（缺少 getUserMedia）：请改用上传照片。",
    };
  }
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return {
      supported: false,
      reason: "摄像头需要 HTTPS 或 localhost 安全上下文：请改用上传照片，或通过 HTTPS 访问。",
    };
  }
  return { supported: true };
}

/**
 * 让 <video> 开始播放。iOS Safari 只在 muted + playsInline + autoplay 齐备时
 * 允许自动播放，缺一项 play() 就 reject；失败原因必须暴露出来，
 * 否则用户看到的是一块永远黑着的预览，而界面显示「已就绪」。
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
    // jsdom 的 DOMException 不继承 Error：两种都要认，否则 name 永远读不到
    const name = err instanceof DOMException || err instanceof Error ? err.name : "";
    return {
      playing: false,
      reason:
        name === "NotAllowedError"
          ? "浏览器阻止了预览自动播放：请点击预览区域后重试。"
          : "预览无法播放：请重试，或改用上传照片。",
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

/** CAM-004：预览镜像不影响捕获；后置摄像头不镜像。 */
export function isFrontCamera(stream: MediaStream | null): boolean {
  const settings = stream?.getVideoTracks()[0]?.getSettings();
  return settings?.facingMode === "user";
}

/** CAM-006：ImageCapture 能力检测后的高分辨率增强；失败或挂起时回退画布捕获。 */
export async function captureWithImageCapture(video: HTMLVideoElement): Promise<Blob | null> {
  if (typeof ImageCapture === "undefined") return null;
  const src = video.srcObject;
  const track =
    typeof MediaStream !== "undefined" && src instanceof MediaStream
      ? src.getVideoTracks()[0]
      : null;
  if (!track) return null;
  // 部分浏览器（含 headless）ImageCapture 半实现：takePhoto 可能永久挂起，加超时回退
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

/** CAM-006：基线捕获——从 <video> 固有像素绘制到 Canvas。 */
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
      return "摄像头权限被拒绝：请在浏览器地址栏允许摄像头访问后重试，或改用上传照片。";
    case "NotFoundError":
      return "未检测到摄像头设备：请连接摄像头后重试，或改用上传照片。";
    case "NotReadableError":
      return "摄像头被其他应用占用：请关闭占用摄像头的程序后重试。";
    case "OverconstrainedError":
      return "摄像头不满足所需约束：请重试，或改用上传照片。";
    case "SecurityError":
      return "需要 HTTPS 或本地安全上下文才能使用摄像头。";
    default:
      return "打开摄像头失败：请重试，或改用上传照片。";
  }
}
