import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/ui",
  workers: 1,
  use: { channel: "chrome", baseURL: "http://127.0.0.1:5179" },
  webServer: {
    command: "npm run dev -- --port 5179",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
  },
});
