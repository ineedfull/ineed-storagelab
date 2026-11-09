import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function openTasks(page, directions = ["upload", "download", "upload"]) {
  await installFixture(page);
  await page.addInitScript((directions) => {
    window.__taskFilterJobs = directions.map((direction, index) => ({
      id: `task-${index}`,
      direction,
      key: `${direction}-${index}.bin`,
      state: "success",
      connectionName: "隔离测试",
      bucket: "demo",
      totalBytes: 1024,
      bytesTransferred: 1024,
      updatedAt: 0,
    }));
    const invoke = window.storageLab.invoke;
    window.storageLab.invoke = async (method, payload) => {
      const result = await invoke(method, payload);
      // Match IPC's detached snapshots so changes arrive only through refresh.
      if (method === "bootstrap")
        result.value.jobs = structuredClone(window.__taskFilterJobs);
      if (method === "listJobs")
        result.value = structuredClone(window.__taskFilterJobs);
      return result;
    };
  }, directions);
  await page.goto("/");
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
}

test("direction filter counts and visible tasks follow refresh while the choice survives page switches", async ({
  page,
}) => {
  await openTasks(page);
  const filters = page.getByRole("group", { name: "任务方向", exact: true });
  await expect(
    filters.getByRole("button", { name: "全部 (3)", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".job")).toHaveCount(3);
  await filters.getByRole("button", { name: "上传 (2)", exact: true }).click();
  await expect(page.locator(".job-title")).toHaveText([
    "upload-0.bin",
    "upload-2.bin",
  ]);
  await filters.getByRole("button", { name: "下载 (1)", exact: true }).click();
  await expect(page.locator(".job-title")).toHaveText(["download-1.bin"]);
  await page.evaluate(() => {
    window.__taskFilterJobs.push({
      ...window.__taskFilterJobs[1],
      id: "new",
      key: "new-download.bin",
    });
  });
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await expect(
    filters.getByRole("button", { name: "下载 (2)", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".job-title")).toHaveText([
    "download-1.bin",
    "new-download.bin",
  ]);
  await page.getByRole("button", { name: "对象浏览", exact: true }).click();
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
  await expect(
    filters.getByRole("button", { name: "下载 (2)", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".job")).toHaveCount(2);
});

test("filtered empty state restores all tasks and returns keyboard focus to the active filter", async ({
  page,
}) => {
  await openTasks(page, ["upload"]);
  await page.getByRole("button", { name: "下载 (0)", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "暂无下载任务", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".job")).toHaveCount(0);
  await page.getByRole("button", { name: "查看全部任务", exact: true }).click();
  const all = page.getByRole("button", { name: "全部 (1)", exact: true });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await expect(all).toBeFocused();
  await expect(page.locator(".job")).toHaveCount(1);
  await page.getByRole("button", { name: "上传 (1)", exact: true }).click();
  await page.evaluate(() => {
    window.__taskFilterJobs = [];
  });
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "暂无传输任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "查看全部任务", exact: true }),
  ).toHaveCount(0);
});

test("first-use empty state explains transfers and opens the object browser", async ({
  page,
}) => {
  await openTasks(page, []);
  await expect(
    page.getByRole("heading", { name: "暂无传输任务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出任务", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "前往对象浏览", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "上传文件", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".tasks")).toBeHidden();
});

test("filters and both empty states fit every supported display combination", async ({
  page,
}, info) => {
  await openTasks(page, ["upload"]);
  for (const theme of ["light", "dark"])
    for (const large of [false, true])
      for (const collapsed of [false, true])
        for (const width of [1440, 920]) {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 620,
          });
          await page.evaluate(
            ({ theme, large, collapsed }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.dataset.large = String(large);
              document
                .querySelector(".workbench")
                .classList.toggle("collapsed", collapsed);
              window.__taskFilterJobs = [];
            },
            { theme, large, collapsed },
          );
          await page
            .getByRole("button", { name: "刷新任务", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: "暂无传输任务", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "前往对象浏览", exact: true }),
          ).toBeInViewport({ ratio: 1 });
          if (
            !collapsed &&
            ((theme === "light" && !large && width === 1440) ||
              (theme === "dark" && large && width === 920))
          )
            await page.screenshot({
              path: info.outputPath(`empty-${theme}-${width}.png`),
            });
          await page.evaluate(() => {
            window.__taskFilterJobs = [
              {
                id: "up",
                direction: "upload",
                key: "upload.bin",
                state: "success",
                connectionName: "隔离",
                bucket: "demo",
                totalBytes: 1,
                bytesTransferred: 1,
                updatedAt: 0,
              },
            ];
          });
          await page
            .getByRole("button", { name: "刷新任务", exact: true })
            .click();
          await page
            .getByRole("button", { name: "下载 (0)", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: "暂无下载任务", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "查看全部任务", exact: true }),
          ).toBeInViewport({ ratio: 1 });
          expect(
            await page
              .locator(".tasks")
              .evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          const buttons = await page
            .getByRole("group", { name: "任务方向", exact: true })
            .getByRole("button")
            .all();
          for (const button of buttons) {
            await expect(button).toBeInViewport({ ratio: 1 });
            expect(
              await button.evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);
          }
          await page
            .getByRole("button", { name: "查看全部任务", exact: true })
            .click();
          await expect(page.locator(".job")).toHaveCount(1);
        }
});
