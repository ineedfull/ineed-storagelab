import { test, expect, _electron as electron } from "@playwright/test";
import { rm } from "node:fs/promises";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("native task center opens the object browser from empty state and filters isolated display jobs", async ({}, info) => {
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native"],
  });
  let isolated;
  try {
    isolated = await app.evaluate(() => globalThis.isolatedAppData);
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    await expect(
      page.getByRole("heading", { name: "暂无传输任务", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "导出任务", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "前往对象浏览", exact: true })
      .click();
    await expect(page.locator(".tasks")).toBeHidden();

    // The empty state above uses production IPC. The rest verifies native
    // rendering/preload with isolated display jobs, without cloud/file access.
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const jobs = ["upload", "download", "upload"].map((direction, index) => ({
        id: `display-${index}`,
        direction,
        key: `${direction}-${index}.bin`,
        connectionName: "隔离显示测试",
        bucket: "demo",
        state: "success",
        totalBytes: 1024,
        bytesTransferred: 1024,
        updatedAt: 0,
      }));
      ipcMain.removeHandler("storagelab:invoke");
      ipcMain.handle("storagelab:invoke", (_event, method) => ({
        ok: true,
        value: method === "listJobs" ? jobs : true,
      }));
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(920, 620);
      window.show();
    });
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    await page.getByRole("button", { name: "刷新任务", exact: true }).click();
    await expect(page.locator(".job")).toHaveCount(3);
    await page.getByRole("button", { name: "上传 (2)", exact: true }).click();
    await expect(page.locator(".job-title")).toHaveText([
      "upload-0.bin",
      "upload-2.bin",
    ]);
    await page.getByRole("button", { name: "下载 (1)", exact: true }).click();
    await expect(page.locator(".job-title")).toHaveText(["download-1.bin"]);
    await page.getByRole("button", { name: "刷新任务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "下载 (1)", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.dataset.large = "true";
    });
    await expect(
      page.getByRole("group", { name: "任务方向", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath("native-task-filter.png") });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (isolated) await rm(isolated, { recursive: true, force: true });
  }
});
