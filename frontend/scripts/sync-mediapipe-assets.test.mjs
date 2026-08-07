// @vitest-environment node
// O3 regressions: sync-mediapipe-assets version locking, hash verification,
// and non-zero-exit contract.
// Fixture directories are always built with fs.mkdtemp under a temp dir; the
// script resolves paths relative to process.cwd().

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./sync-mediapipe-assets.mjs", import.meta.url));
const FRONTEND = path.resolve(path.dirname(SCRIPT), "..");

const EXPORTS = {
  ".": { import: "./vision_bundle.mjs", require: "./vision_bundle.cjs" },
  "./vision_wasm_internal.js": "./wasm/vision_wasm_internal.js",
  "./vision_wasm_internal.wasm": "./wasm/vision_wasm_internal.wasm",
};

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Build a minimal fixture: only two wasm entries (add missingWasm /
 * corruptSha to break it) */
function buildFixture({ missingWasm = false, corruptSha = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "o3-fixture-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { "@mediapipe/tasks-vision": "1.0.1" } }),
  );
  const jsFile = path.join(
    FRONTEND,
    "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js",
  );
  const wasmFile = path.join(
    FRONTEND,
    "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm",
  );
  const jsBytes = readFileSync(jsFile);
  const wasmBytes = readFileSync(wasmFile);
  mkdirSync(path.join(dir, "node_modules/@mediapipe/tasks-vision/wasm"), { recursive: true });
  mkdirSync(path.join(dir, "public/assets/models/wasm"), { recursive: true });
  writeFileSync(
    path.join(dir, "node_modules/@mediapipe/tasks-vision/package.json"),
    JSON.stringify({ name: "@mediapipe/tasks-vision", version: "1.0.1", exports: EXPORTS }),
  );
  writeFileSync(
    path.join(dir, "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js"),
    jsBytes,
  );
  if (!missingWasm) {
    writeFileSync(
      path.join(dir, "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm"),
      wasmBytes,
    );
  }
  const lock = {
    mediapipeVersion: "1.0.1",
    assets: [
      {
        path: "public/assets/models/wasm/vision_wasm_internal.js",
        bytes: jsBytes.length,
        sha256: sha256Of(jsFile),
        source: "npm:@mediapipe/tasks-vision@1.0.1/vision_wasm_internal.js",
      },
      {
        path: "public/assets/models/wasm/vision_wasm_internal.wasm",
        bytes: wasmBytes.length,
        sha256: corruptSha ? "0".repeat(64) : sha256Of(wasmFile),
        source: "npm:@mediapipe/tasks-vision@1.0.1/vision_wasm_internal.wasm",
      },
    ],
  };
  writeFileSync(path.join(dir, "assets-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  return dir;
}

function runScript(dir) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
}

describe("sync-mediapipe-assets", () => {
  it("fails with a named target when an npm asset is missing from the package (O3)", () => {
    const dir = buildFixture({ missingWasm: true });
    try {
      const result = runScript(dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("vision_wasm_internal.wasm");
      expect(result.stderr).toContain("Unable to resolve");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches the committed lock against the actual committed assets (O3)", () => {
    const lock = JSON.parse(readFileSync(path.join(FRONTEND, "assets-lock.json"), "utf8"));
    expect(lock.assets.length).toBeGreaterThan(0);
    for (const entry of lock.assets) {
      const file = path.join(FRONTEND, entry.path);
      expect(existsSync(file), `missing ${entry.path}`).toBe(true);
      const actual = readFileSync(file);
      expect(actual.length).toBe(entry.bytes);
      expect(sha256Of(file)).toBe(entry.sha256);
    }
  });

  it("pins the dependency to the exact lock version without ranges (O3)", () => {
    const pkg = JSON.parse(readFileSync(path.join(FRONTEND, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(FRONTEND, "assets-lock.json"), "utf8"));
    const pinned = pkg.dependencies["@mediapipe/tasks-vision"];
    expect(pinned).toBe(lock.mediapipeVersion);
    expect(pinned).not.toMatch(/[\^~*x]/);
    const installed = JSON.parse(
      readFileSync(
        path.join(FRONTEND, "node_modules/@mediapipe/tasks-vision/package.json"),
        "utf8",
      ),
    ).version;
    expect(installed).toBe(lock.mediapipeVersion);
  });

  it("fails and names the file when a locked hash drifts (O3)", () => {
    const dir = buildFixture({ corruptSha: true });
    try {
      const result = runScript(dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("vision_wasm_internal.wasm");
      expect(result.stderr).toContain("does not match the lockfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
