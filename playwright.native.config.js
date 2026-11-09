import { defineConfig } from "@playwright/test";
export default defineConfig({
  outputDir: "test-results-native",
  testDir: "tests/native",
  testMatch: "*.spec.js",
  timeout: 60000,
  workers: 1,
});
