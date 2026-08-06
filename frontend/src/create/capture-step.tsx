import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { entryLabel } from "../lib/templates/catalog";
import { uiLocale } from "../lib/locale";
import type { TemplateEntry } from "../lib/templates/types";
import { loadSourceImage, sourceErrorMessage, type SourceImage } from "../image/source";
import {
  attachStream,
  cameraErrorMessage,
  captureStill,
  checkCameraSupport,
  isFrontCamera,
  listVideoDevices,
  openCamera,
  stopStream,
} from "../camera/camera";
import { PoseGuide } from "../pose/pose-guide";
import { runStaticCheck } from "../pose/static-check";

export interface CaptureStepProps {
  template: TemplateEntry;
  onReady: (source: SourceImage) => void;
  onBack: () => void;
  /** 页面隐藏多久后自动停流（CAM-005）；可注入以便测试无需假时钟 */
  hiddenStopMs?: number;
}

type Status = "idle" | "requesting" | "live" | "capturing";

/** 页面隐藏多久后自动停流（CAM-005）。 */
const HIDDEN_STOP_MS = 30_000;

export function CaptureStep({
  template,
  onReady,
  onBack,
  hiddenStopMs = HIDDEN_STOP_MS,
}: CaptureStepProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [autoCountdown, setAutoCountdown] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [mirrored, setMirrored] = useState(true);
  const [activeDeviceId, setActiveDeviceId] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const genRef = useRef(0);
  const shootRef = useRef<() => void>(() => {});
  const support = useMemo(() => checkCameraSupport(), []);

  // CAM-005：组件卸载/页面离开时停止全部 tracks；迟到的旧请求结果直接丢弃
  useEffect(
    () => () => {
      genRef.current += 1;
      stopStream(streamRef.current);
      streamRef.current = null;
    },
    [],
  );

  // CAM-005：页面持续隐藏超过门限就停流。
  // 摄像头指示灯一直亮着而用户已经切走，是明确的隐私问题。
  useEffect(() => {
    if (status !== "live") return;
    let timer = 0;
    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "hidden") return;
      timer = window.setTimeout(() => {
        genRef.current += 1;
        stopStream(streamRef.current);
        streamRef.current = null;
        setStatus("idle");
        setError("摄像头因页面长时间处于后台已自动关闭：需要时可重新开启。");
      }, hiddenStopMs);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [status, hiddenStopMs]);

  const startCamera = useCallback(async (deviceId?: string) => {
    const gen = ++genRef.current;
    setError(null);
    setStatus("requesting");
    try {
      let stream: MediaStream;
      try {
        stream = await openCamera(deviceId ? { deviceId } : {});
      } catch (err) {
        // CAM-003：约束失败降级为宽松约束重试
        if (err instanceof DOMException && err.name === "OverconstrainedError") {
          stream = await openCamera({ relaxed: true, deviceId });
        } else {
          throw err;
        }
      }
      if (gen !== genRef.current) {
        stopStream(stream); // 已被更新的请求取代
        return;
      }
      stopStream(streamRef.current);
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        const played = await attachStream(video, stream);
        if (!played.playing && played.reason) setError(played.reason);
      }
      setMirrored(isFrontCamera(stream));
      setActiveDeviceId(deviceId ?? stream.getVideoTracks()[0]?.getSettings().deviceId ?? "");
      setStatus("live");
      try {
        setDevices(await listVideoDevices());
      } catch {
        setDevices([]);
      }
    } catch (err) {
      if (gen === genRef.current) {
        setError(cameraErrorMessage(err));
        setStatus("idle");
      }
    }
  }, []);

  const shoot = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    // 记下这次拍摄所属的代际。解码与静态复检要几百毫秒，期间用户可能已经点了
    // 「返回」或重新连接摄像头；迟到的 onReady 会把状态机硬推到确认步，
    // 甚至 dispose 掉当时正在使用的另一张源照片。
    const gen = genRef.current;
    const isStale = () => gen !== genRef.current;

    setError(null);
    setStatus("capturing");
    const blob = await captureStill(video);
    if (isStale()) return;
    if (!blob) {
      setError("拍摄失败：请重试，或改用上传照片。");
      setStatus("live");
      return;
    }
    try {
      const source = await loadSourceImage(blob);
      if (isStale()) {
        source.dispose();
        return;
      }
      // GDE-005：拍摄固定 Blob 后静态复检，不使用预览推理的旧结果
      try {
        // GDE-005 复检结果随 source 传递，由终态页统一展示
        const checks = await runStaticCheck(source.bitmap);
        if (isStale()) {
          source.dispose();
          return;
        }
        onReady({ ...source, staticChecks: checks });
      } catch {
        if (isStale()) {
          source.dispose();
          return;
        }
        onReady(source);
      }
    } catch (err) {
      if (isStale()) return;
      setError(sourceErrorMessage(err));
      setStatus("live");
    }
  }, [onReady]);

  // CAM-007：自动倒计时由用户显式开启，可取消；拍摄调用在 timer 回调中触发
  useEffect(() => {
    shootRef.current = () => {
      void shoot();
    };
  }, [shoot]);
  useEffect(() => {
    if (countdown === null) return;
    const timer = setTimeout(() => {
      if (countdown > 1) {
        setCountdown((n) => (n ?? 3) - 1);
      } else {
        setCountdown(null);
        shootRef.current();
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const triggerShoot = () => {
    if (autoCountdown) setCountdown(3);
    else void shoot();
  };

  return (
    <section aria-label="摄像头拍摄">
      <h2>拍摄照片</h2>
      <p className="muted">
        已选模板：{entryLabel(template, uiLocale())}。仅在点击后才会请求摄像头权限。
      </p>
      {status === "idle" && (
        <>
          {!support.supported && (
            <p role="alert" className="warn-text">
              {support.reason}
            </p>
          )}
          <div className="step-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void startCamera()}
              disabled={!support.supported}
            >
              开启摄像头
            </button>
            <button type="button" onClick={onBack}>
              返回
            </button>
          </div>
        </>
      )}
      {(status === "requesting" || status === "live" || status === "capturing") && (
        <div className="camera-view">
          {/* muted + autoPlay + playsInline 三者齐备，iOS Safari 才允许预览自动播放 */}
          <video
            ref={videoRef}
            className={mirrored ? "mirrored" : ""}
            playsInline
            autoPlay
            muted
            aria-label="摄像头预览"
          />
          {status === "live" && <PoseGuide videoRef={videoRef} mirrored={mirrored} />}
          <p className="muted">
            {status === "requesting" && "正在请求摄像头…"}
            {status === "capturing" && "正在处理照片…"}
            {status === "live" &&
              (mirrored ? "预览为镜像，成品为真实方向（CAM-004）" : "后置摄像头，成品为真实方向")}
          </p>
          {status === "live" && (
            <>
              <div className="step-actions">
                {countdown !== null ? (
                  <button type="button" className="primary" onClick={() => setCountdown(null)}>
                    取消（{countdown} 秒）
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={triggerShoot}
                    disabled={status !== "live"}
                  >
                    拍摄
                  </button>
                )}
                <label className="inline-label">
                  <input
                    type="checkbox"
                    checked={autoCountdown}
                    onChange={(e) => setAutoCountdown(e.target.checked)}
                  />
                  自动倒计时 3 秒
                </label>
              </div>
              {devices.length > 1 && (
                <label>
                  切换摄像头
                  <select
                    value={activeDeviceId}
                    onChange={(e) => {
                      if (e.target.value) void startCamera(e.target.value);
                    }}
                  >
                    {devices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || d.deviceId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="warn-text">
          {error}
        </p>
      )}
      <div className="step-actions">
        {status === "live" && (
          <button type="button" onClick={() => startCamera()}>
            重新连接摄像头
          </button>
        )}
        {(status === "live" || status === "capturing") && (
          <button type="button" onClick={onBack}>
            返回
          </button>
        )}
      </div>
    </section>
  );
}
