import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";
test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.addInitScript(() => {
    const invoke = window.storageLab.invoke;
    window.__directoryCalls = [];
    let batch;
    const entries = [
      {
        key: "release/资料/empty.txt",
        relativePath: "资料/empty.txt",
        size: 0,
        state: "ready",
      },
      {
        key: "release/a.txt",
        relativePath: "a.txt",
        size: 3,
        state: "skipped",
        exists: true,
      },
    ];
    window.storageLab.invoke = async (method, p = {}) => {
      if (!/Directory/.test(method)) return invoke(method, p);
      window.__directoryCalls.push({ method, p });
      let value;
      if (method === "prepareDirectory")
        value = {
          token: "private-token",
          expiresAt: Date.now() + 600000,
          count: 2,
          totalBytes: 3,
          entries,
        };
      if (method === "startDirectory") {
        batch = {
          id: "batch-1",
          direction: "upload",
          bucket: "known",
          prefix: "",
          state: "completed",
          createdAt: 0,
          updatedAt: 0,
          count: 2,
          verified: 1,
          skipped: 1,
          failed: 0,
          totalBytes: 3,
          entries: entries.map((x) => ({
            ...x,
            ...(x.state === "ready"
              ? {
                  state: "success",
                  verification: "verified",
                  sha256: "a".repeat(64),
                  checksumSource: "local-file-and-remote-full-read",
                }
              : {}),
          })),
        };
        value = batch;
      }
      if (method === "listDirectoryBatches") value = batch ? [batch] : [];
      if (method === "getDirectoryBatch") value = batch;
      if (method === "exportDirectory")
        value = { path: "selected-manifest.json" };
      if (method === "discardDirectoryPlan") value = true;
      return { ok: true, value };
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
});
test("directory preview executes, distinguishes skipped files, displays digest evidence and exports manifest", async ({
  page,
}) => {
  await page.getByRole("button", { name: "目录交付", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "目录交付" });
  await dialog.getByRole("button", { name: "选择目录并预览" }).click();
  await expect(dialog).toContainText("资料/empty.txt");
  await expect(dialog).toContainText("已跳过");
  await dialog.getByRole("button", { name: "开始目录传输" }).click();
  await expect(dialog).toContainText("已核验 1");
  await dialog.getByRole("button", { name: "查看文件详情" }).first().click();
  await expect(dialog).toContainText("a".repeat(64));
  await dialog.getByRole("button", { name: "导出交付清单" }).click();
  await expect(dialog).toContainText("交付清单已导出");
});
test("closing preview revokes private file grant and re-opening does not execute stale token", async ({
  page,
}) => {
  await page.getByRole("button", { name: "目录交付", exact: true }).click();
  await page.getByRole("button", { name: "选择目录并预览" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__directoryCalls.filter(
            (x) => x.method === "discardDirectoryPlan",
          ).length,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "目录交付", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始目录传输" }),
  ).toBeDisabled();
});
test("expired selected history clears without a repeated missing-batch error", async ({
  page,
}) => {
  await page.getByRole("button", { name: "目录交付", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "目录交付" });
  await dialog.getByRole("button", { name: "选择目录并预览" }).click();
  await dialog.getByRole("button", { name: "开始目录传输" }).click();
  await expect(dialog).toContainText("已核验 1");
  await page.evaluate(() => {
    const invoke = window.storageLab.invoke;
    window.storageLab.invoke = (method, p) => {
      if (method === "listDirectoryBatches")
        return Promise.resolve({ ok: true, value: [] });
      if (method === "getDirectoryBatch")
        return Promise.resolve({
          ok: false,
          error: { code: "NOT_FOUND", message: "目录批次不存在。" },
        });
      return invoke(method, p);
    };
  });
  await dialog.getByRole("button", { name: "刷新目录批次" }).click();
  await expect(dialog.getByLabel("批次记录")).toHaveValue("");
  await expect(dialog).toContainText("所选批次已超出保留范围");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "导出交付清单" }),
  ).toHaveCount(0);
});
test("a late refresh failure cannot replace the latest directory snapshot", async ({
  page,
}) => {
  await page.getByRole("button", { name: "目录交付", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "目录交付" });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__directoryCalls.filter(
            (x) => x.method === "listDirectoryBatches",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const invoke = window.storageLab.invoke;
    let first = true;
    window.__pendingDirectoryRefresh = false;
    window.storageLab.invoke = (method, payload) => {
      if (method === "listDirectoryBatches" && first) {
        first = false;
        window.__pendingDirectoryRefresh = true;
        return new Promise((resolve) => {
          window.__rejectDirectoryRefresh = () =>
            resolve({
              ok: false,
              error: { code: "STALE", message: "older request failed" },
            });
        });
      }
      return invoke(method, payload);
    };
  });
  const refresh = dialog.getByRole("button", { name: "刷新目录批次" });
  await refresh.click();
  await expect
    .poll(() => page.evaluate(() => window.__pendingDirectoryRefresh))
    .toBe(true);
  await refresh.click();
  await page.evaluate(() => window.__rejectDirectoryRefresh());
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});
for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`directory layout ${theme} ${large} ${collapsed} ${width}`, async ({
          page,
        }, info) => {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 620,
          });
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page.getByLabel("主题", { exact: true }).selectOption(theme);
          await page.getByLabel("大字模式", { exact: true }).setChecked(large);
          await page
            .getByRole("button", { name: "保存设置", exact: true })
            .click();
          if (collapsed)
            await page
              .getByRole("button", { name: "折叠侧栏", exact: true })
              .click();
          await page
            .getByRole("button", { name: "目录交付", exact: true })
            .click();
          await page.getByRole("button", { name: "选择目录并预览" }).click();
          const dialog = page.getByRole("dialog", { name: "目录交付" });
          const box = await dialog.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          const button = await dialog
            .getByRole("button", { name: "开始目录传输" })
            .boundingBox();
          expect(button.y + button.height).toBeLessThanOrEqual(
            width === 1440 ? 900 : 620,
          );
          const inputs = await dialog
            .locator(".directory-controls select")
            .evaluateAll((els) =>
              els.map((e) => e.getBoundingClientRect().top),
            );
          expect(Math.abs(inputs[0] - inputs[1])).toBeLessThan(2);
          await dialog.screenshot({ path: info.outputPath("directory.png") });
        });
