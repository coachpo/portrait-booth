import { describe, expect, it } from "vitest";

import { errorText } from "./error-text";

describe("error-text", () => {
  it("names the secure-origin cause behind a failed save session", () => {
    // The backend says "a save session must be established first", which does
    // not hint at the actual cause: a plain-http origin drops the Secure
    // cookie, so retrying can never succeed.
    const text = errorText("SESSION_REQUIRED", "a save session must be established first");
    expect(text).toContain("secure origin");
    expect(text).toContain("localhost");
    expect(text).not.toContain("save session must be established");
  });

  it("explains a cross-site rejection in terms of the address used", () => {
    const text = errorText("CROSS_ORIGIN_REJECTED", "cross-site request rejected");
    expect(text).toContain("cross-site");
    expect(text).toContain("proxy or tunnel");
  });

  it("tells the user retrying an in-progress save is safe", () => {
    expect(errorText("IDEMPOTENCY_IN_PROGRESS", "still processing")).toContain(
      "will not create a second copy",
    );
  });

  it("falls back to the transport message for an unmapped code", () => {
    expect(errorText("SOMETHING_NEW", "HTTP 502")).toBe("HTTP 502");
  });

  it("falls back when there is no code at all", () => {
    expect(errorText(undefined, "network error")).toBe("network error");
  });

  it("never renders an empty string", () => {
    expect(errorText(undefined, "")).toBe("saving failed, please retry");
    expect(errorText("UNKNOWN", "")).toBe("saving failed, please retry");
  });

  it("leaks no bare HTTP status codes into mapped copy", () => {
    for (const code of [
      "SESSION_REQUIRED",
      "CROSS_ORIGIN_REJECTED",
      "IDEMPOTENCY_CONFLICT",
      "PHOTO_TOO_LARGE",
      "INTERNAL",
    ]) {
      expect(errorText(code, "HTTP 500")).not.toMatch(/HTTP \d{3}/);
    }
  });
});
