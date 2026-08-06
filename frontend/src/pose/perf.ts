/**
 * 姿态推理的性能测量口径。
 *
 * 存在的理由：是否把推理迁到 Worker 是一个性能问题，而当前唯一的依据是一句
 * 「推理 ~30-50ms/帧」的代码注释——它与实测矛盾。在拿到真实分布之前，
 * 线程重构只是在优化一个没被测量过的量。
 *
 * 判定门限取 50 ms：这是 Long Tasks API 的规范门限，比拍脑袋的 60 ms 更有依据。
 * 单帧 p95 稳定低于它时，主线程路径在响应性上没有实际问题，
 * Worker 迁移降级为纯规范符合性工作。
 *
 * 采集只在开发构建下启用（见 isMeasurementEnabled），生产路径零开销。
 */

/** Long Tasks API 的规范门限（毫秒）。 */
export const LONG_TASK_MS = 50;

const CAPACITY = 240;

export interface InferenceStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** p95 是否越过 Long Tasks 门限——越过才需要重新考虑 Worker 迁移 */
  exceedsLongTaskBudget: boolean;
}

const samples = new Float64Array(CAPACITY);
let written = 0;

export function isMeasurementEnabled(): boolean {
  return import.meta.env.DEV;
}

/** 记录一次推理耗时。环形缓冲，固定内存，不随会话时长增长。 */
export function recordInference(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  samples[written % CAPACITY] = durationMs;
  written++;
}

export function resetInferenceSamples(): void {
  written = 0;
  samples.fill(0);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  // 最近邻取值法：样本量小时不做插值，避免造出一个从未观测到的数
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export function inferenceStats(): InferenceStats | null {
  const count = Math.min(written, CAPACITY);
  if (count === 0) return null;
  const sorted = Array.from(samples.slice(0, count)).sort((a, b) => a - b);
  const p95 = percentile(sorted, 0.95);
  return {
    count,
    p50: percentile(sorted, 0.5),
    p95,
    max: sorted[sorted.length - 1],
    exceedsLongTaskBudget: p95 > LONG_TASK_MS,
  };
}

export interface LongTaskWindow {
  /** 观测窗口内的长任务条数 */
  count: number;
  /** 最长的一次（毫秒） */
  longestMs: number;
  stop: () => void;
}

/**
 * 观测预览期间的长任务。浏览器不支持 longtask 时返回 null，
 * 调用方据此说明「本环境无法测量」而不是假装测到了 0。
 */
export function observeLongTasks(): LongTaskWindow | null {
  if (typeof PerformanceObserver === "undefined") return null;
  const supported = PerformanceObserver.supportedEntryTypes;
  if (supported && !supported.includes("longtask")) return null;

  const window: LongTaskWindow = { count: 0, longestMs: 0, stop: () => {} };
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.count++;
        window.longestMs = Math.max(window.longestMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    window.stop = () => observer.disconnect();
    return window;
  } catch {
    return null;
  }
}

/** 把一次推理包起来计时。非开发构建下直接透传，不产生额外调用开销。 */
export function measureInference<T>(run: () => T): T {
  if (!isMeasurementEnabled()) return run();
  const start = performance.now();
  try {
    return run();
  } finally {
    recordInference(performance.now() - start);
  }
}
