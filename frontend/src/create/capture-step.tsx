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
  /** How long the page may stay hidden before auto-stopping the stream
   * (CAM-005); injectable so tests need no fake clocks */
  hiddenStopMs?: number;
}

type Status = "idle" | "requesting" | "live" | "capturing";

/** How long the page may stay hidden before auto-stopping the stream (CAM-005). */
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

  // CAM-005: stop all tracks on unmount/page leave; stale request results
  // are dropped directly
  useEffect(
    () => () => {
      genRef.current += 1;
      stopStream(streamRef.current);
      streamRef.current = null;
    },
    [],
  );

  // CAM-005: stop the stream once the page stays hidden past the threshold.
  // The camera indicator staying on after the user left is a clear privacy
  // problem.
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
        setError(
          "the camera was auto-stopped because the page stayed in the background too long; re-open it when needed.",
        );
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
        // CAM-003: on a constraints failure, degrade to a relaxed-constraints retry
        if (err instanceof DOMException && err.name === "OverconstrainedError") {
          stream = await openCamera({ relaxed: true, deviceId });
        } else {
          throw err;
        }
      }
      if (gen !== genRef.current) {
        stopStream(stream); // superseded by a newer request
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
    // Record which generation this shot belongs to. Decoding and the static
    // recheck take hundreds of milliseconds, during which the user may have
    // clicked "Back" or reconnected the camera; a late onReady would force
    // the state machine back to the confirm step and could even dispose the
    // other source photo in use.
    const gen = genRef.current;
    const isStale = () => gen !== genRef.current;

    setError(null);
    setStatus("capturing");
    const blob = await captureStill(video);
    if (isStale()) return;
    if (!blob) {
      setError("capture failed: try again, or upload a photo instead.");
      setStatus("live");
      return;
    }
    try {
      const source = await loadSourceImage(blob);
      if (isStale()) {
        source.dispose();
        return;
      }
      // GDE-005: run the static recheck on the fixed captured Blob; never
      // use stale preview-inference results
      try {
        // GDE-005 recheck results travel with the source; the final page
        // displays them
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

  // CAM-007: the auto countdown is user-enabled explicitly and cancellable;
  // the shot fires in the timer callback
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
    <section aria-label="Camera capture">
      <h2>Take photo</h2>
      <p className="muted">
        Selected template: {entryLabel(template, uiLocale())}. Camera permission is only requested
        after clicking.
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
              Open camera
            </button>
            <button type="button" onClick={onBack}>
              Back
            </button>
          </div>
        </>
      )}
      {(status === "requesting" || status === "live" || status === "capturing") && (
        <div className="camera-view">
          {/* muted + autoPlay + playsInline all present, or iOS Safari will
          not allow preview autoplay */}
          <video
            ref={videoRef}
            className={mirrored ? "mirrored" : ""}
            playsInline
            autoPlay
            muted
            aria-label="Camera preview"
          />
          {status === "live" && <PoseGuide videoRef={videoRef} mirrored={mirrored} />}
          <p className="muted">
            {status === "requesting" && "Requesting camera…"}
            {status === "capturing" && "Processing photo…"}
            {status === "live" &&
              (mirrored
                ? "preview is mirrored; the artifact has the true orientation (CAM-004)"
                : "rear camera; the artifact has the true orientation")}
          </p>
          {status === "live" && (
            <>
              <div className="step-actions">
                {countdown !== null ? (
                  <button type="button" className="primary" onClick={() => setCountdown(null)}>
                    Cancel ({countdown}s)
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={triggerShoot}
                    disabled={status !== "live"}
                  >
                    Shoot
                  </button>
                )}
                <label className="inline-label">
                  <input
                    type="checkbox"
                    checked={autoCountdown}
                    onChange={(e) => setAutoCountdown(e.target.checked)}
                  />
                  Auto countdown 3s
                </label>
              </div>
              {devices.length > 1 && (
                <label>
                  Switch camera
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
            Reconnect camera
          </button>
        )}
        {(status === "live" || status === "capturing") && (
          <button type="button" onClick={onBack}>
            Back
          </button>
        )}
      </div>
    </section>
  );
}
