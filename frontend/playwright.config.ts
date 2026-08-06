import { defineConfig, devices } from "@playwright/test";

/**
 * E2E：完整创建 → 暂存 → 取回流程。
 * webServer 同时启动后端（uvicorn，临时 DB）与前端（vite dev）。
 * fake media：Chromium 启动参数提供合成视频/音频，避免真实摄像头依赖。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: 1,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--disable-web-security",
      ],
    },
  },
  webServer: [
    {
      command: ".venv/bin/uvicorn app.main:app --port 8000",
      cwd: "../backend",
      port: 8000,
      reuseExistingServer: !process.env.CI,
      env: {
        // 根密钥缺失时后端按设计拒绝启动；e2e 用临时 DB，固定测试值即可
        PORTRAIT_SECRET_KEY_BASE: "ZTJlLXRlc3Qtb25seS1yb290LWtleS0zMmJ5dGVzISE=",
        PORTRAIT_DB_PATH: "/tmp/pb-e2e/portrait.db",
        PORTRAIT_STORAGE_DIR: "/tmp/pb-e2e/objects",
      },
    },
    {
      command: "npm run dev",
      port: 5173,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
