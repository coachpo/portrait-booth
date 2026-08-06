/**
 * 实时姿态指导（GDE-001/002/004/006）。
 * 显示状态文字与色块（不只依赖颜色）；模型失败时仅提示不可用，不阻止拍摄。
 */

import { useEffect, useRef, useState } from "react";

import { createLandmarkerClient, type LandmarkerClient } from "./landmarker";
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

export function PoseGuide({ videoRef, mirrored }: PoseGuideProps) {
  const [state, setState] = useState<PoseState | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const trackerRef = useRef<PoseTracker | null>(null);

  useEffect(() => {
    let cancelled = false;
    let client: LandmarkerClient | null = null;
    trackerRef.current = new PoseTracker({ mirrored });

    const frame = () => {
      const video = videoRef.current;
      if (!video || video.videoWidth === 0) return;
      const ts = performance.now();
      void client
        ?.detect(video, ts)
        .then((faces) => {
          if (!cancelled) setState(trackerRef.current?.update(faces, ts) ?? null);
        })
        .catch(() => {});
    };

    createLandmarkerClient()
      .then((c) => {
        if (cancelled) {
          c.close();
          return;
        }
        client = c;
        setAvailable(true);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    // rVFC 优先，回退 rAF（§4.4）
    const video = videoRef.current;
    let raf = 0;
    const loop = () => {
      frame();
      raf = requestAnimationFrame(loop);
    };
    if (video && "requestVideoFrameCallback" in video) {
      const vfc = () => {
        frame();
        (
          video as HTMLVideoElement & {
            requestVideoFrameCallback: (cb: () => void) => number;
          }
        ).requestVideoFrameCallback(vfc);
      };
      (
        video as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: () => void) => number;
        }
      ).requestVideoFrameCallback(vfc);
    } else {
      loop();
    }

    return () => {
      cancelled = true;
      client?.close();
      cancelAnimationFrame(raf);
    };
  }, [mirrored, videoRef]);

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
  return (
    <div className={`pose-guide pose-${color}`} role="status" aria-live="polite">
      <span className="pose-dot" aria-hidden="true" />
      <span>
        {state.guidance}
        {state.status === "ready" &&
          !state.shootable &&
          `（保持 ${Math.max(0, Math.ceil((DEFAULT_POSE_THRESHOLDS.stableMs - state.stableMs) / 1000))} 秒）`}
        {state.status === "ready" && state.shootable && " 可以拍摄。"}
      </span>
    </div>
  );
}
