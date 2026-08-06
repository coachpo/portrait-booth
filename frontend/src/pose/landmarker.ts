/**
 * Landmarker 客户端（GDE-005/006/007）。
 * 主线程推理（MVP）：tasks-vision 在主线程经 script 标签加载 WASM glue，
 * 无 importScripts/模块实例问题；推理 ~30-50ms/帧，忙时丢弃新帧保证 8-15 FPS。
 * Worker 迁移（§4.4 推荐）留作后续增强；模型/WASM 全部同源（§9.4）。
 */

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";

import type { FaceObservation } from "./tracking";

export const MODEL_URL = new URL("/assets/models/face_landmarker.task", window.location.origin)
  .href;
export const WASM_PATH = new URL("/assets/models/wasm", window.location.origin).href;

export interface LandmarkerClient {
  /** 逐帧送入推理；推理忙时返回空结果并丢弃该帧 */
  detect(frame: ImageBitmap | HTMLVideoElement, timestampMs: number): Promise<FaceObservation[]>;
  /** 静态分析（GDE-005/009：拍摄/上传后复检） */
  detectStatic(bitmap: ImageBitmap | HTMLCanvasElement): Promise<FaceObservation[]>;
  close(): void;
  get available(): boolean;
}

function isVideoSource(
  v: ImageBitmap | HTMLVideoElement | HTMLCanvasElement,
): v is HTMLVideoElement {
  return typeof HTMLVideoElement !== "undefined" && v instanceof HTMLVideoElement;
}

export async function createLandmarkerClient(): Promise<LandmarkerClient> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 2,
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: false,
  });

  let closed = false;
  let busy = false;

  const run = (bitmap: ImageBitmap | HTMLCanvasElement, timestampMs: number): FaceObservation[] => {
    if (closed) return [];
    if (busy) {
      // 至多一张待处理帧：忙时丢弃新帧（§4.4）
      return [];
    }
    busy = true;
    try {
      const result = landmarker.detectForVideo(bitmap, timestampMs);
      return result.faceLandmarks.map((landmarks, i) => ({
        faceIndex: i,
        landmarks: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        matrix: result.facialTransformationMatrixes?.[i]?.data ?? [],
        score: result.faceBlendshapes?.[i]?.categories?.[0]?.score,
      }));
    } finally {
      busy = false;
    }
  };

  return {
    async detect(frame, timestampMs) {
      const source = isVideoSource(frame) ? await createImageBitmap(frame) : frame;
      const faces = run(source, timestampMs);
      if (isVideoSource(frame) || source !== frame) {
        (source as ImageBitmap).close?.();
      }
      return faces;
    },
    async detectStatic(bitmap) {
      return run(bitmap, Date.now());
    },
    close() {
      closed = true;
      landmarker.close();
    },
    available: true,
  };
}
