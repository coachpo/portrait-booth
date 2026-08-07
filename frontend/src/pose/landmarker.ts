/**
 * Landmarker instance management (GDE-005/006/007).
 *
 * Inference runs on the main thread. SPEC §4.4's prose mentions a Worker, but
 * no acceptance item in GDE-001~010 requires it; GDE-006 instead requires
 * that "the degraded path without WebGL/WASM/Worker can complete the full
 * flow" - the main-thread implementation is an evaluated, deliberate
 * deviation, with the re-review condition recorded in STATUS.md.
 *
 * The two instances have clear roles:
 * - The VIDEO instance is long-lived and serves the live preview; timestamps
 *   must be strictly monotonic;
 * - The IMAGE instance is independent and serves the static recheck. VIDEO
 *   mode carries a cross-frame ROI loop
 *   (PreviousLoopbackCalculator + AssociationNormRectCalculator),
 *   and reusing it would leak the last preview frame's ROI prior into the
 *   static recheck, conflicting with GDE-005's intent of "don't use stale
 *   results from the last preview inference".
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

import type { FaceObservation } from "./tracking";

export const MODEL_URL = new URL("/assets/models/face_landmarker.task", window.location.origin)
  .href;
export const WASM_PATH = new URL("/assets/models/wasm", window.location.origin).href;

/**
 * Detection confidence thresholds. These are placeholder values, not
 * calibrated against a fixed sample set - like QualityConfig they carry a
 * testSetVersion and must never be presented as official tolerances.
 */
export const LANDMARKER_CONFIDENCE = {
  testSetVersion: "uncalibrated-v1",
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
} as const;

/** SPEC §4.4 pins this to 2: multiple faces are only a hint, never multi-face processing. */
export const NUM_FACES = 2;

export interface VideoLandmarker {
  /** Synchronously infer one frame. Callers own frame-rate gating - no more "drop frames when busy" here. */
  detectVideo(frame: HTMLVideoElement | ImageBitmap, timestampMs: number): FaceObservation[];
}

export interface ImageLandmarker {
  detectImage(bitmap: ImageBitmap | HTMLCanvasElement): FaceObservation[];
}

interface Deps {
  createFileset: typeof FilesetResolver.forVisionTasks;
  createLandmarker: typeof FaceLandmarker.createFromOptions;
}

const browserDeps: Deps = {
  createFileset: (path) => FilesetResolver.forVisionTasks(path),
  createLandmarker: (fileset, options) => FaceLandmarker.createFromOptions(fileset, options),
};

let deps: Deps = browserDeps;

/** For test injection only. */
export function setLandmarkerDeps(next: Partial<Deps>): void {
  deps = { ...browserDeps, ...next };
}

let videoInstance: Promise<FaceLandmarker> | null = null;
let imageInstance: Promise<FaceLandmarker> | null = null;

// detectForVideo requires strictly increasing timestamps. One process-wide
// counter avoids mixing performance.now() (~1e4) with Date.now() (~1.75e12),
// which would make wasm throw.
let lastTimestamp = 0;

function monotonic(timestampMs: number): number {
  lastTimestamp = Math.max(lastTimestamp + 1, Math.round(timestampMs));
  return lastTimestamp;
}

async function create(runningMode: "VIDEO" | "IMAGE"): Promise<FaceLandmarker> {
  const fileset = await deps.createFileset(WASM_PATH);
  return deps.createLandmarker(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode,
    numFaces: NUM_FACES,
    outputFacialTransformationMatrixes: true,
    // §4.4 pins this to false. Enabling it would produce blendshapes, but that is not a signal this product needs.
    outputFaceBlendshapes: false,
    minFaceDetectionConfidence: LANDMARKER_CONFIDENCE.minFaceDetectionConfidence,
    minFacePresenceConfidence: LANDMARKER_CONFIDENCE.minFacePresenceConfidence,
    minTrackingConfidence: LANDMARKER_CONFIDENCE.minTrackingConfidence,
  });
}

interface DetectionResult {
  faceLandmarks: Array<Array<{ x: number; y: number; z?: number }>>;
  facialTransformationMatrixes?: Array<{ data: number[] }>;
}

function toObservations(result: DetectionResult): FaceObservation[] {
  return result.faceLandmarks.map((landmarks, i) => ({
    faceIndex: i,
    landmarks: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    matrix: result.facialTransformationMatrixes?.[i]?.data ?? [],
  }));
}

/** Get the long-lived VIDEO instance. Multiple calls share the same underlying landmarker. */
export async function acquireVideoLandmarker(): Promise<VideoLandmarker> {
  if (videoInstance === null) {
    // Failures are not cached, otherwise one network blip would permanently
    // disable pose guidance. But only **itself** may be cleared: when a slow
    // creation fails, the slot may already hold a later successful instance,
    // and clearing unconditionally would drop that instance's handle so it is
    // never closed.
    const pending: Promise<FaceLandmarker> = create("VIDEO").catch((error: unknown) => {
      if (videoInstance === pending) videoInstance = null;
      throw error;
    });
    videoInstance = pending;
  }
  const landmarker = await videoInstance;
  return {
    detectVideo(frame, timestampMs) {
      return toObservations(
        landmarker.detectForVideo(frame, monotonic(timestampMs)) as DetectionResult,
      );
    },
  };
}

/** Get a separate IMAGE instance for the static recheck. */
export async function acquireImageLandmarker(): Promise<ImageLandmarker> {
  if (imageInstance === null) {
    const pending: Promise<FaceLandmarker> = create("IMAGE").catch((error: unknown) => {
      if (imageInstance === pending) imageInstance = null;
      throw error;
    });
    imageInstance = pending;
  }
  const landmarker = await imageInstance;
  return {
    detectImage(bitmap) {
      return toObservations(landmarker.detect(bitmap) as DetectionResult);
    },
  };
}

/**
 * Release both instances. Call when leaving the capture flow.
 *
 * Lifecycle is deliberately minimal: no reference counting or TTL. The
 * failure modes that mechanism introduces itself (a missed release leaking
 * the wasm heap and GL context, use-after-close inside the grace period being
 * swallowed by an empty catch) cost more than the problem it solves; add it
 * when evidence shows remounting causes noticeable overhead.
 */
export function releaseLandmarkers(): void {
  releaseVideoLandmarker();
  releaseImageLandmarker();
}

export function releaseVideoLandmarker(): void {
  const pending = videoInstance;
  videoInstance = null;
  closeWhenSettled(pending);
}

export function releaseImageLandmarker(): void {
  const pending = imageInstance;
  imageInstance = null;
  closeWhenSettled(pending);
}

function closeWhenSettled(instance: Promise<FaceLandmarker> | null): void {
  void instance?.then(
    (l) => l.close(),
    () => {},
  );
}

/** For tests only: reset the singletons and the timestamp counter. */
export function resetLandmarkersForTest(): void {
  videoInstance = null;
  imageInstance = null;
  lastTimestamp = 0;
  deps = browserDeps;
}
