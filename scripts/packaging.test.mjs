import { test } from "node:test";
import assert from "node:assert/strict";
import { readProduct, selectJobs } from "./desktop-release.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("StorageLab identity and five Electron artifact configurations", async () => {
  const product = await readProduct(root);
  assert.equal(product.product, "StorageLab");
  assert.equal(product.slug, "ineed-storagelab");
  const jobs = ["macos", "windows", "linux"].flatMap((platform) =>
    selectJobs({ platform, arch: "all" }),
  );
  assert.ok(jobs.every((job) => job.runtime === "electron"));
  assert.equal(
    jobs.reduce((sum, job) => sum + job.formats.length, 0),
    5,
  );
  assert.throws(() => selectJobs({ runtime: "tauri" }), /unavailable/);
  const p = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  assert.equal(p.build.appId, "com.ineedfull.storagelab");
  assert.equal(p.build.productName, "StorageLab");
  assert.equal(p.build.nsis.perMachine, false);
  for (const file of [
    "build/icon.icns",
    "build/icon.ico",
    "build/icon.png",
    "public/icon.svg",
  ])
    assert.ok(
      (await readFile(new URL("../" + file, import.meta.url))).length > 0,
    );
});
