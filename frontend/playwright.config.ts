import { defineConfig, devices } from "@playwright/test";

/**
 * E2E: full create → stage → retrieve flow.
 * webServer starts both the backend (uvicorn, temporary DB) and the frontend
 * (vite dev).
 * fake media: Chromium launch args provide synthetic video/audio, avoiding a
 * real camera dependency.
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
        // The backend refuses to start when the root secret is missing by
        // design; e2e uses a temporary DB, so a fixed test value is fine
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
