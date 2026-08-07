// Version-locking and build-time sync of MediaPipe model and WASM assets (O3).
// All paths are anchored at process.cwd(): during prebuild/predev npm runs
// with cwd exactly frontend/, and tests point the script at a temp directory
// that resolves its own node_modules.
// Semantics are identical to the backend template_store content gate:
// declared hash vs computed hash, hard failure on mismatch.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function fail(message) {
  process.stderr.write(`[sync-mediapipe-assets] ${message}\n`);
  process.exit(1);
}

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function verifyBytes(filePath, expectedBytes, expectedSha, label) {
  let actual;
  try {
    actual = readFileSync(filePath);
  } catch (err) {
    fail(
      `${label} missing: ${path.join(root, filePath)}\n  expected ${expectedBytes} bytes ${expectedSha}`,
    );
  }
  const actualSha = sha256Of(actual);
  if (actual.length !== expectedBytes || actualSha !== expectedSha) {
    fail(
      `${label} verification failed: ${path.join(root, filePath)}\n` +
        `  expected ${expectedBytes} bytes ${expectedSha}\n` +
        `  actual ${actual.length} bytes ${actualSha}`,
    );
  }
  return actual;
}

let lock;
try {
  lock = JSON.parse(readFileSync(path.join(root, "assets-lock.json"), "utf8"));
} catch {
  fail(`Unable to read lockfile ${path.join(root, "assets-lock.json")}`);
}

// 1. The dependency version must exactly equal the lockfile version
const require = createRequire(path.join(root, "package.json"));
let pkgVersion;
try {
  // The package exports do not expose ./package.json, so read the file directly
  // (require would throw ERR_PACKAGE_PATH_NOT_EXPORTED)
  pkgVersion = JSON.parse(
    readFileSync(path.join(root, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8"),
  ).version;
} catch (err) {
  fail(
    `Unable to resolve @mediapipe/tasks-vision package (${err.code ?? "unknown"}); run npm install first`,
  );
}
if (pkgVersion !== lock.mediapipeVersion) {
  fail(
    `Dependency version does not match the lockfile: node_modules has ${pkgVersion}, assets-lock.json declares ${lock.mediapipeVersion}`,
  );
}

// 2. Sync/verify each entry
for (const entry of lock.assets) {
  const target = path.join(root, entry.path);
  if (entry.source.startsWith("npm:")) {
    // source looks like npm:@mediapipe/tasks-vision@1.0.1/vision_wasm_internal.js:
    // split out package name and subpath; the @version suffix is not part of
    // the module specifier
    const rest = entry.source.slice(4);
    const slash = rest.lastIndexOf("/");
    const pkg = rest.slice(0, slash).replace(/@[^@]*$/, "");
    const subpath = rest.slice(slash + 1);
    const specifier = `${pkg}/${subpath}`;
    let resolved;
    try {
      // Locate the source file via the package exports subpath, never by
      // constructing a node_modules path
      resolved = require.resolve(specifier);
    } catch (err) {
      fail(
        `Unable to resolve ${specifier} from the npm package (${err.code ?? "unknown"})\n  target path: ${target}`,
      );
    }
    const sourceBytes = readFileSync(resolved);
    cpSync(resolved, target);
    const copiedSha = sha256Of(sourceBytes);
    if (sourceBytes.length !== entry.bytes || copiedSha !== entry.sha256) {
      fail(
        `npm original does not match the lockfile: ${resolved}\n` +
          `  expected ${entry.bytes} bytes ${entry.sha256}\n` +
          `  actual ${sourceBytes.length} bytes ${copiedSha}\n  target path: ${target}`,
      );
    }
  } else {
    // Vendored asset (face_landmarker.task): verify only, never generate
    verifyBytes(entry.path, entry.bytes, entry.sha256, `model ${entry.source}`);
  }
}

process.stdout.write(
  `[sync-mediapipe-assets] ${lock.assets.length} assets synced and verified (${lock.mediapipeVersion})\n`,
);
