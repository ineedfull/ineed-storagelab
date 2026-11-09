import { test, expect, _electron as electron } from "@playwright/test";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";
test("native opt-in upload cancel retains parts and re-pick resumes verified content", async ({}, info) => {
  test.skip(
    !process.env.STORAGELAB_TEST_CONFIG &&
      !process.env.STORAGELAB_TEST_ENDPOINT,
    "Requires isolated loopback MinIO",
  );
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/host.mjs"],
    env: { ...process.env, STORAGELAB_NATIVE_RESUME: "1" },
  });
  try {
    const page = await app.firstWindow();
    const expected = await app.evaluate(() =>
      globalThis.prepareResumableFile(),
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("button", { name: "Isolated MinIO", exact: true })
      .click();
    await page.getByLabel("启用上传断点续传", { exact: true }).check();
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    await expect
      .poll(() => app.evaluate(() => globalThis.resumePartPaused === true))
      .toBe(true);
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    const recover = page.getByRole("button", {
      name: "重新选择文件并续传",
      exact: true,
    });
    await expect(recover).toBeVisible();
    await app.evaluate(() => {
      globalThis.releaseResumePart();
      globalThis.pickResumableFile();
    });
    await recover.click();
    await expect(page.locator(".job").filter({ hasText: "成功" })).toHaveCount(
      1,
    );
    expect(
      await app.evaluate(() => globalThis.readObjectDigest("resume.bin")),
    ).toEqual(expected);
    await expect(
      page.getByRole("button", { name: "重新选择文件并续传", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("native-resume.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
