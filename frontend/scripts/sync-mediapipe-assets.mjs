// MediaPipe 模型与 WASM 资产的版本锁定与构建期同步（O3）。
// 所有路径以 process.cwd() 为基准：npm 跑 prebuild/predev 时 cwd 正是 frontend/，
// 测试把脚本指向临时目录执行时也解析该目录下的 node_modules。
// 语义与后端 template_store 的内容门一致：声明哈希 vs 实算哈希，不符即硬失败。
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
      `${label} 缺失：${path.join(root, filePath)}\n  期望 ${expectedBytes} 字节 ${expectedSha}`,
    );
  }
  const actualSha = sha256Of(actual);
  if (actual.length !== expectedBytes || actualSha !== expectedSha) {
    fail(
      `${label} 校验失败：${path.join(root, filePath)}\n` +
        `  期望 ${expectedBytes} 字节 ${expectedSha}\n` +
        `  实际 ${actual.length} 字节 ${actualSha}`,
    );
  }
  return actual;
}

let lock;
try {
  lock = JSON.parse(readFileSync(path.join(root, "assets-lock.json"), "utf8"));
} catch {
  fail(`无法读取清单 ${path.join(root, "assets-lock.json")}`);
}

// 1. 依赖版本必须精确等于清单版本
const require = createRequire(path.join(root, "package.json"));
let pkgVersion;
try {
  // 包 exports 不暴露 ./package.json，只能直接读文件（require 会 ERR_PACKAGE_PATH_NOT_EXPORTED）
  pkgVersion = JSON.parse(
    readFileSync(path.join(root, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8"),
  ).version;
} catch (err) {
  fail(`无法解析 @mediapipe/tasks-vision 包（${err.code ?? "unknown"}），请先 npm install`);
}
if (pkgVersion !== lock.mediapipeVersion) {
  fail(
    `依赖版本与清单不符：node_modules 是 ${pkgVersion}，assets-lock.json 声明 ${lock.mediapipeVersion}`,
  );
}

// 2. 逐条同步/校验
for (const entry of lock.assets) {
  const target = path.join(root, entry.path);
  if (entry.source.startsWith("npm:")) {
    // source 形如 npm:@mediapipe/tasks-vision@1.0.1/vision_wasm_internal.js：
    // 拆出包名与子路径，@版本后缀不属于模块说明符
    const rest = entry.source.slice(4);
    const slash = rest.lastIndexOf("/");
    const pkg = rest.slice(0, slash).replace(/@[^@]*$/, "");
    const subpath = rest.slice(slash + 1);
    const specifier = `${pkg}/${subpath}`;
    let resolved;
    try {
      // 走包 exports 子路径定位源文件，不拼 node_modules 目录
      resolved = require.resolve(specifier);
    } catch (err) {
      fail(`无法从 npm 包解析 ${specifier}（${err.code ?? "unknown"}）\n  目标路径：${target}`);
    }
    const sourceBytes = readFileSync(resolved);
    cpSync(resolved, target);
    const copiedSha = sha256Of(sourceBytes);
    if (sourceBytes.length !== entry.bytes || copiedSha !== entry.sha256) {
      fail(
        `npm 原件与清单不符：${resolved}\n` +
          `  期望 ${entry.bytes} 字节 ${entry.sha256}\n` +
          `  实际 ${sourceBytes.length} 字节 ${copiedSha}\n  目标路径：${target}`,
      );
    }
  } else {
    // vendored 资产（face_landmarker.task）：只校验不生成
    verifyBytes(entry.path, entry.bytes, entry.sha256, `模型 ${entry.source}`);
  }
}

process.stdout.write(
  `[sync-mediapipe-assets] ${lock.assets.length} 个资产已同步并通过校验（${lock.mediapipeVersion}）\n`,
);
