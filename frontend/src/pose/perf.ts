/**
 * Measurement basis for pose-inference performance.
 *
 * Why it exists: whether to move inference to a Worker is a performance
 * question, and the only current basis is a code comment saying "inference
 * ~30-50ms/frame" - which contradicts measurements. Without the real
 * distribution, a thread refactor would just be optimizing an unmeasured
 * quantity.
 *
 * The decision gate is 50 ms: the Long Tasks API's spec threshold, more
 * principled than an off-the-cuff 60 ms. When single-frame p95 stays stably
 * below it, the main-thread path has no real responsiveness problem and the
 * Worker migration degrades to pure spec-compliance work.
 *
 * Collection is enabled only in development builds (see
 * isMeasurementEnabled); the production path has zero overhead.
 */

/** The Long Tasks API's spec threshold (milliseconds). */
export const LONG_TASK_MS = 50;

const CAPACITY = 240;

export interface InferenceStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** Whether p95 crosses the Long Tasks threshold - only then should the Worker migration be reconsidered */
  exceedsLongTaskBudget: boolean;
}

const samples = new Float64Array(CAPACITY);
let written = 0;

export function isMeasurementEnabled(): boolean {
  return import.meta.env.DEV;
}

/** Record one inference duration. Ring buffer, fixed memory, does not grow with session length. */
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
  // Nearest-neighbor quantiles: no interpolation for small samples, avoiding
  // inventing a value that was never observed
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
  /** Number of long tasks in the observation window */
  count: number;
  /** The longest one (milliseconds) */
  longestMs: number;
  stop: () => void;
}

/**
 * Observe long tasks during the preview. Returns null when the browser does
 * not support longtask, letting callers state "this environment cannot
 * measure" instead of pretending a 0 was measured.
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

/** Time one inference by wrapping it. Outside development builds this passes through directly with zero overhead. */
export function measureInference<T>(run: () => T): T {
  if (!isMeasurementEnabled()) return run();
  const start = performance.now();
  try {
    return run();
  } finally {
    recordInference(performance.now() - start);
  }
}
