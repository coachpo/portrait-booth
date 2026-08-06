/**
 * 实时姿态指导（GDE-001/002/004/006）。
 * 显示状态文字与独立图形（不只依赖颜色）；模型失败时仅提示不可用，不阻止拍摄。
 */

import { useEffect, useRef, useState } from "react";

import { acquireVideoLandmarker, releaseVideoLandmarker, type VideoLandmarker } from "./landmarker";
import { measureInference } from "./perf";
import { DEFAULT_POSE_THRESHOLDS, PoseTracker, type PoseState } from "./tracking";

export interface PoseGuideProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mirrored: boolean;
}

const STATUS_COLOR: Record<PoseState["status"], string> = {
  "no-face": "neutral",
  "multi-face": "warn",
  "out-of-position": "warn",
  unstable: "warn",
  ready: "ok",
};

/** 状态不能只靠颜色承载（WCAG 1.4.1）：每种状态配一个不同形状的符号。 */
const STATUS_GLYPH: Record<PoseState["status"], string> = {
  "no-face": "○",
  "multi-face": "◫",
  "out-of-position": "◎",
  unstable: "△",
  ready: "●",
};

/** ≈12 Hz，落在 §4.4 的 8–15 FPS 中段。 */
const MIN_INTERVAL_MS = 83;

/** rVFC 在部分浏览器上缺席（§10.2 能力检测）；缺席时回退到 rAF。 */
function asRvfcVideo(video: HTMLVideoElement | null): HTMLVideoElement | null {
  if (!video) return null;
  return "requestVideoFrameCallback" in video ? video : null;
}

function sameGuidance(a: PoseState | null, b: PoseState): boolean {
  return (
    a !== null &&
    a.status === b.status &&
    a.guidance === b.guidance &&
    a.shootable === b.shootable &&
    Math.floor(a.stableMs / 250) === Math.floor(b.stableMs / 250)
  );
}

export function PoseGuide({ videoRef, mirrored }: PoseGuideProps) {
  const [state, setState] = useState<PoseState | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const trackerRef = useRef<PoseTracker | null>(null);

  useEffect(() => {
    let cancelled = false;
    let client: VideoLandmarker | null = null;
    let vfcHandle = 0;
    let raf = 0;
    let lastInferAt = Number.NEGATIVE_INFINITY;

    const tracker = new PoseTracker();
    trackerRef.current = tracker;

    const frame = () => {
      const video = videoRef.current;
      if (cancelled || !client || !video || video.videoWidth === 0) return;
      const now = performance.now();
      // 显式帧率门控。旧实现靠 landmarker 内的 busy 标志「忙则丢帧」，
      // 但推理是同步的，函数返回时 busy 必然已复位——那个分支永远不成立，
      // 于是推理按显示帧率跑满，主线程被 30–50 ms 的任务塞住。
      if (now - lastInferAt < MIN_INTERVAL_MS) return;
      lastInferAt = now;
      const faces = measureInference(() => client!.detectVideo(video, now));
      const next = tracker.update(faces, now);
      setState((prev) => (sameGuidance(prev, next) ? prev : next));
    };

    const rvfc = asRvfcVideo(videoRef.current);
    if (rvfc) {
      const vfc = () => {
        if (cancelled) return;
        frame();
        vfcHandle = rvfc.requestVideoFrameCallback(vfc);
      };
      vfcHandle = rvfc.requestVideoFrameCallback(vfc);
    } else {
      const loop = () => {
        if (cancelled) return;
        frame();
        raf = requestAnimationFrame(loop);
      };
      loop();
    }

    acquireVideoLandmarker().then(
      (c) => {
        if (cancelled) return;
        client = c;
        setAvailable(true);
      },
      () => {
        if (!cancelled) setAvailable(false);
      },
    );

    return () => {
      cancelled = true;
      // rVFC 循环必须显式取消。旧实现只 cancelAnimationFrame，
      // rVFC 分支的回调会一直自我续订：组件卸载后仍在推理，
      // 每切换一次摄像头就再叠加一条循环。
      if (rvfc && vfcHandle) rvfc.cancelVideoFrameCallback(vfcHandle);
      if (raf) cancelAnimationFrame(raf);
      releaseVideoLandmarker();
    };
  }, [videoRef]);

  // 必须定义在推理 effect 之后：React 按定义顺序执行 effect，
  // 挂载时 tracker 先被创建，这里再把当前镜像标记同步进去。
  // mirrored 只改 tracker 的一个字段，放进上面的依赖数组会让每次前后摄切换
  // 都重新下载并初始化模型。
  useEffect(() => {
    trackerRef.current?.setMirrored(mirrored);
  }, [mirrored]);

  if (available === false) {
    return (
      <p className="muted" role="status">
        自动姿态指导不可用（模型加载失败），仍可手动拍摄。
      </p>
    );
  }
  if (available === null) {
    return (
      <p className="muted" aria-live="polite">
        正在加载姿态模型…
      </p>
    );
  }
  if (!state) return null;

  const color = STATUS_COLOR[state.status];
  const countdown =
    state.status === "ready" && !state.shootable
      ? Math.max(0, Math.ceil((DEFAULT_POSE_THRESHOLDS.stableMs - state.stableMs) / 1000))
      : null;
  return (
    <div className={`pose-guide pose-${color}`}>
      <span className="pose-dot" aria-hidden="true">
        {STATUS_GLYPH[state.status]}
      </span>
      {/* 只有指令进 aria-live：倒计时每帧都变，播报它会把读屏用户淹没 */}
      <span role="status" aria-live="polite">
        {state.guidance}
      </span>
      {countdown !== null && <span aria-hidden="true">（保持 {countdown} 秒）</span>}
      {state.shootable && <span aria-hidden="true"> 可以拍摄。</span>}
    </div>
  );
}
