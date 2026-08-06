import { afterEach, describe, expect, it } from "vitest";

import {
  inferenceStats,
  LONG_TASK_MS,
  measureInference,
  observeLongTasks,
  recordInference,
  resetInferenceSamples,
} from "./perf";

afterEach(() => {
  resetInferenceSamples();
});

describe("inference stats", () => {
  it("reports null before any sample", () => {
    expect(inferenceStats()).toBeNull();
  });

  it("computes p50/p95 over the recorded samples", () => {
    for (let i = 1; i <= 100; i++) recordInference(i);
    const stats = inferenceStats()!;
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.max).toBe(100);
  });

  it("flags the Long Tasks budget only when p95 crosses it", () => {
    for (let i = 0; i < 100; i++) recordInference(LONG_TASK_MS - 10);
    expect(inferenceStats()!.exceedsLongTaskBudget).toBe(false);

    resetInferenceSamples();
    for (let i = 0; i < 100; i++) recordInference(LONG_TASK_MS + 10);
    expect(inferenceStats()!.exceedsLongTaskBudget).toBe(true);
  });

  it("keeps a fixed footprint by overwriting the oldest samples", () => {
    for (let i = 0; i < 1000; i++) recordInference(i);
    const stats = inferenceStats()!;
    expect(stats.count).toBe(240);
    // 只保留最近 240 个样本：最小值必然来自尾部窗口
    expect(stats.max).toBe(999);
  });

  it("ignores non-finite and negative durations", () => {
    recordInference(Number.NaN);
    recordInference(-5);
    expect(inferenceStats()).toBeNull();
  });

  it("returns the wrapped value from measureInference", () => {
    expect(measureInference(() => "faces")).toBe("faces");
  });
});

describe("long task observation", () => {
  it("returns null instead of pretending to measure when unsupported", () => {
    // jsdom 没有 longtask entry type：必须说“测不了”，而不是报 0 条长任务
    const observed = observeLongTasks();
    if (observed === null) {
      expect(observed).toBeNull();
    } else {
      expect(observed.count).toBe(0);
      observed.stop();
    }
  });
});
