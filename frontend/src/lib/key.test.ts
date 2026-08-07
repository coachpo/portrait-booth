import { describe, expect, it } from "vitest";

import { formatKeyGroups, isCompleteKey, normalizeKeyInput } from "./key";

describe("normalizeKeyInput", () => {
  it("uppercases and strips separators", () => {
    // Pasting a retrieval code with spaces, hyphens, or lowercase must not
    // be blocked by a "format error"
    expect(normalizeKeyInput("a7c 2f9")).toBe("A7C2F9");
    expect(normalizeKeyInput("A7C-2F9")).toBe("A7C2F9");
    expect(normalizeKeyInput(" a7c\t2f9 ")).toBe("A7C2F9");
  });

  it("drops characters outside the key alphabet", () => {
    expect(normalizeKeyInput("A7C@2F9!")).toBe("A7C2F9");
    expect(normalizeKeyInput("-- A7C2F9")).toBe("A7C2F9");
  });

  it("truncates to six characters", () => {
    expect(normalizeKeyInput("A7C2F9EXTRA")).toBe("A7C2F9");
  });

  it("handles an empty input", () => {
    expect(normalizeKeyInput("")).toBe("");
  });
});

describe("formatKeyGroups", () => {
  it("groups as 3+3 once there is a second group", () => {
    expect(formatKeyGroups("A7C2F9")).toBe("A7C 2F9");
    expect(formatKeyGroups("A7C2")).toBe("A7C 2");
  });

  it("leaves short input alone", () => {
    expect(formatKeyGroups("A7")).toBe("A7");
    expect(formatKeyGroups("")).toBe("");
  });
});

describe("isCompleteKey", () => {
  it("requires exactly six characters", () => {
    expect(isCompleteKey("A7C2F9")).toBe(true);
    expect(isCompleteKey("A7C2F")).toBe(false);
  });
});
