/**
 * Landmarker 实例管理（GDE-005/006/007）。
 *
 * 推理跑在主线程。SPEC §4.4 正文提到 Worker，但 GDE-001~010 的验收表没有一条要求它，
 * GDE-006 反而要求「无 WebGL/WASM/Worker 的降级测试可完成全流程」——
 * 主线程实现是已评估的有意偏差，重新评审条件记在 STATUS.md。
 *
 * 两个实例分工明确：
 * - VIDEO 实例长驻，服务实时预览，时间戳必须严格单调递增；
 * - IMAGE 实例独立，服务静态复检。VIDEO 模式带跨帧 ROI 回环
 *   （PreviousLoopbackCalculator + AssociationNormRectCalculator），
 *   复用它会把最后一帧预览的 ROI 先验带进静态复检，
 *   与 GDE-005「不使用最后一次预览推理的旧结果」的立法意图冲突。
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

import type { FaceObservation } from "./tracking";

export const MODEL_URL = new URL("/assets/models/face_landmarker.task", window.location.origin)
  .href;
export const WASM_PATH = new URL("/assets/models/wasm", window.location.origin).href;

/**
 * 检测置信度阈值。这些是占位值，没有经过固定样本校准——
 * 与 QualityConfig 一样带 testSetVersion，禁止对外表述为官方容差。
 */
export const LANDMARKER_CONFIDENCE = {
  testSetVersion: "uncalibrated-v1",
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
} as const;

/** SPEC §4.4 固定为 2：多脸只用于提示，不做多脸处理。 */
export const NUM_FACES = 2;

export interface VideoLandmarker {
  /** 同步推理一帧。调用方负责帧率门控——这里不再做「忙则丢帧」。 */
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

/** 仅供测试注入。 */
export function setLandmarkerDeps(next: Partial<Deps>): void {
  deps = { ...browserDeps, ...next };
}

let videoInstance: Promise<FaceLandmarker> | null = null;
let imageInstance: Promise<FaceLandmarker> | null = null;

// detectForVideo 要求时间戳严格递增。整个进程共用一个计数器，
// 避免 performance.now()（约 1e4）与 Date.now()（约 1.75e12）混用导致 wasm 抛错。
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
    // §4.4 固定为 false。开启它才有 blendshapes，但那不是本产品需要的信号。
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

/** 取得长驻的 VIDEO 实例。多次调用共享同一个底层 landmarker。 */
export async function acquireVideoLandmarker(): Promise<VideoLandmarker> {
  videoInstance ??= create("VIDEO").catch((error: unknown) => {
    videoInstance = null; // 失败不缓存，否则一次网络抖动就永久关闭姿态指导
    throw error;
  });
  const landmarker = await videoInstance;
  return {
    detectVideo(frame, timestampMs) {
      return toObservations(
        landmarker.detectForVideo(frame, monotonic(timestampMs)) as DetectionResult,
      );
    },
  };
}

/** 取得独立的 IMAGE 实例，用于静态复检。 */
export async function acquireImageLandmarker(): Promise<ImageLandmarker> {
  imageInstance ??= create("IMAGE").catch((error: unknown) => {
    imageInstance = null;
    throw error;
  });
  const landmarker = await imageInstance;
  return {
    detectImage(bitmap) {
      return toObservations(landmarker.detect(bitmap) as DetectionResult);
    },
  };
}

/**
 * 释放两个实例。离开拍摄流程时调用。
 *
 * 生命周期刻意保持最简：没有引用计数与 TTL。那套机制自身引入的失败模式
 * （漏 release 泄漏 wasm 堆与 GL 上下文、宽限期内 use-after-close 被空 catch 吞掉）
 * 比它解决的问题更贵；有证据表明重挂载造成可感知开销时再加。
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

/** 仅供测试：重置单例与时间戳计数器。 */
export function resetLandmarkersForTest(): void {
  videoInstance = null;
  imageInstance = null;
  lastTimestamp = 0;
  deps = browserDeps;
}
