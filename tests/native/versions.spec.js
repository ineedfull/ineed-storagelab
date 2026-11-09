import { test, expect, _electron as electron } from "@playwright/test";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("production UI recovers a deleted Key through historical download and non-destructive version restore", async ({}, info) => {
  test.skip(
    !process.env.STORAGELAB_TEST_CONFIG &&
      !process.env.STORAGELAB_TEST_ENDPOINT,
    "Requires isolated loopback MinIO",
  );
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/host.mjs"],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const h = await app.evaluate(() => globalThis.prepareVersionHistory());
    await page
      .getByRole("button", { name: "Isolated MinIO", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "preview.txt", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "版本与恢复", exact: true }).click();
    const d = page.getByRole("dialog", { name: "对象版本与恢复" });
    await d.getByLabel("完整原始 Key", { exact: true }).fill(h.key);
    await d.getByRole("button", { name: "读取历史版本", exact: true }).click();
    await expect(
      d.getByRole("button", { name: `选择版本 ${h.marker}`, exact: true }),
    ).toBeDisabled();
    await d
      .getByRole("button", { name: `选择版本 ${h.old}`, exact: true })
      .click();
    await expect(
      d.getByRole("button", { name: "下载所选版本", exact: true }),
    ).toBeEnabled();
    await expect(d).toContainText("historical");
    await d.getByRole("button", { name: "下载所选版本", exact: true }).click();
    await expect(d.getByRole("status")).toContainText("已加入任务中心");
    await expect
      .poll(() => app.evaluate(() => globalThis.readHistoricalDownload()))
      .toBe("old historical body\n");
    await app.evaluate(() => globalThis.fixture.confirmDelete(false));
    await d
      .getByRole("button", { name: "恢复为当前对象", exact: true })
      .click();
    await expect(d.getByRole("status")).toContainText("已取消恢复");
    expect(
      (await app.evaluate(() => globalThis.readVersionHistory())).versions,
    ).toHaveLength(2);
    await app.evaluate(() => globalThis.fixture.confirmDelete(true));
    await d
      .getByRole("button", { name: "恢复为当前对象", exact: true })
      .click();
    await expect(d.getByRole("status")).toContainText("已恢复");
    await expect(
      d.getByRole("button", { name: "读取历史版本", exact: true }),
    ).toBeEnabled();
    const current = await app.evaluate(() => globalThis.readVersionContent());
    expect(current.content).toBe("old historical body\n");
    expect(current.metadata).toMatchObject({ purpose: "historical" });
    expect(current.tags).toEqual([{ Key: "env", Value: "old" }]);
    const history = await app.evaluate(() => globalThis.readVersionHistory());
    expect(history.versions).toHaveLength(3);
    expect(history.versions).toContain(h.old);
    expect(history.versions).toContain(h.newer);
    expect(history.markers).toEqual([h.marker]);
    await page.screenshot({ path: info.outputPath("restored-version.png") });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /任务中心/ }).click();
    await expect(page.locator(".job")).toContainText(`指定版本：${h.old}`);
    await expect(page.locator(".job")).toContainText("成功");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
