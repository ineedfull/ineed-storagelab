import { test, expect, _electron as electron } from "@playwright/test";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";
import { rm } from "node:fs/promises";

test("production Electron loads native SDK adapters and signs real loopback requests", async () => {
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/native-providers-host.mjs"],
  });
  let isolated;
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle("StorageLab");
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const { results, requests } = await app.evaluate(() =>
      globalThis.verifyNativeProviders(),
    );
    expect(results).toEqual([
      {
        provider: "oss",
        size: 7,
        etag: '"fixture"',
        signature: "OSS4-HMAC-SHA256",
      },
      { provider: "obs", size: 7, etag: '"fixture"', signature: true },
      { provider: "cos-native", size: 7, etag: '"fixture"', signature: "sha1" },
      {
        provider: "tos-native",
        size: 7,
        etag: '"fixture"',
        signature: "TOS4-HMAC-SHA256",
      },
    ]);
    expect(requests).toHaveLength(4);
    expect(requests[0].authorization).toMatch(/^OSS4-HMAC-SHA256 /);
    expect(requests[1].authorization).toMatch(/^OBS fixture-key:/);
    expect(requests[2].authorization).toMatch(/^q-sign-algorithm=sha1&/);
    expect(requests[3].authorization).toMatch(/^TOS4-HMAC-SHA256 /);
    expect(requests[3].authorization).toContain("/cn-beijing/tos/request");
    for (const request of requests)
      expect(decodeURIComponent(request.path)).toContain(" 中文 +%.txt ");
  } finally {
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});
