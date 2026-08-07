/**
 * Real-time pose guidance (GDE-001/002/004/006).
 * Shows status text plus an independent graphic (not color alone); on model
 * failure it only says guidance is unavailable and never blocks capture.
 */

import { useEffect, useRef, useState } from "react";

import { acquireVideoLandmarker, releaseVideoLandmarker, type VideoLandmarker } from "./landmarker";
import { measureInference } from "./perf";
import { formatGuidance } from "./guidance-text";
import { uiLocale } from "../lib/locale";
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

/** Status must not be carried by color alone (WCAG 1.4.1): each status gets a differently shaped symbol. */
const STATUS_GLYPH: Record<PoseState["status"], string> = {
  "no-face": "○",
  "multi-face": "◫",
  "out-of-position": "◎",
  unstable: "△",
  ready: "●",
};

/** ≈12 Hz, in the middle of §4.4's 8–15 FPS range. */
const MIN_INTERVAL_MS = 83;

/** rVFC is absent in some browsers (§10.2 capability detection); falls back to rAF when absent. */
function asRvfcVideo(video: HTMLVideoElement | null): HTMLVideoElement | null {
  if (!video) return null;
  return "requestVideoFrameCallback" in video ? video : null;
}

function sameGuidance(a: PoseState | null, b: PoseState): boolean {
  return (
    a !== null &&
    a.status === b.status &&
    sameHints(a.guidanceHints, b.guidanceHints) &&
    a.shootable === b.shootable &&
    Math.floor(a.stableMs / 250) === Math.floor(b.stableMs / 250)
  );
}

/** Compare hints by value: length first, then item by item, order sensitive (O4). */
function sameHints(a: PoseState["guidanceHints"], b: PoseState["guidanceHints"]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
      // Explicit frame-rate gating. The old implementation relied on the
      // landmarker's busy flag to "drop frames when busy", but inference is
      // synchronous - by the time the function returns, busy is already
      // reset, so that branch never fired and inference ran at full display
      // rate, jamming the main thread with 30–50 ms tasks.
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
      // The rVFC loop must be explicitly cancelled. The old implementation
      // only called cancelAnimationFrame, so the rVFC branch kept
      // re-scheduling itself: inference continued after unmount and each
      // camera switch stacked another loop.
      if (rvfc && vfcHandle) rvfc.cancelVideoFrameCallback(vfcHandle);
      if (raf) cancelAnimationFrame(raf);
      releaseVideoLandmarker();
    };
  }, [videoRef]);

  // Must be defined after the inference effect: React runs effects in
  // definition order, so on mount the tracker is created first and the
  // current mirror flag is synced in here. mirrored only changes one field
  // of the tracker; putting it in the dependency array above would re-fetch
  // and re-init the model on every front/rear camera switch.
  useEffect(() => {
    trackerRef.current?.setMirrored(mirrored);
  }, [mirrored]);

  if (available === false) {
    return (
      <p className="muted" role="status">
        Automatic pose guidance unavailable (model failed to load); manual capture still works.
      </p>
    );
  }
  if (available === null) {
    return (
      <p className="muted" aria-live="polite">
        Loading pose model…
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
      {/* Only guidance text goes into aria-live: the countdown changes every
      frame and announcing it would drown screen-reader users */}
      <span role="status" aria-live="polite">
        {formatGuidance(state.status, state.guidanceHints, uiLocale())}
      </span>
      {countdown !== null && <span aria-hidden="true"> (hold {countdown}s)</span>}
      {state.shootable && <span aria-hidden="true"> Ready to shoot.</span>}
    </div>
  );
}
