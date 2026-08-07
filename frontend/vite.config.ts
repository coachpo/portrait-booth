import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // tasks-vision does a runtime dynamic import of the WASM glue inside a
    // Worker; pre-bundling would create a second module instance and break
    // the ModuleFactory lookup
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
    // e2e is run by Playwright (playwright.config.ts), excluded from vitest
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
