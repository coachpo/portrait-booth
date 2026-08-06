import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // tasks-vision 在 Worker 内对 WASM glue 做运行时动态 import，
    // 预打包会产生第二个模块实例导致 ModuleFactory 缺失
    exclude: ["@mediapipe/tasks-vision"],
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // e2e 由 Playwright 运行（playwright.config.ts），排除出 vitest
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
