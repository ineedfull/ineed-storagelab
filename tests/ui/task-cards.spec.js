import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function openTasks(page) {
  await installFixture(page);
  await page.addInitScript(() => {
    const invoke = window.storageLab.invoke;
    const base = {
      connectionName: "隔离存储测试",
      bucket: "demo-bucket",
      direction: "download",
      updatedAt: 0,
      rate: 0,
    };
    const jobs = [
      {
        ...base,
        id: "done",
        key: "repair/2026_10_28/photo.jpg",
        state: "success",
        bytesTransferred: 555827,
        totalBytes: 555827,
      },
      {
        ...base,
        id: "running",
        key: "数据/".repeat(25) + "running.bin",
        direction: "upload",
        state: "running",
        bytesTransferred: 1024 ** 2,
        totalBytes: 4 * 1024 ** 2,
        rate: 512 * 1024,
      },
      {
        ...base,
        id: "unknown",
        key: "unknown.bin",
        state: "running",
        bytesTransferred: 1024,
        totalBytes: 0,
      },
      {
        ...base,
        id: "empty",
        key: "empty.txt",
        state: "success",
        bytesTransferred: 0,
        totalBytes: 0,
      },
      {
        ...base,
        id: "failed",
        key: "failed.bin",
        state: "failed",
        bytesTransferred: 1024,
        totalBytes: 4096,
        error: "网络中断，请重试。",
        warning: "请核实远端结果。",
      },
    ];
    window.storageLab.invoke = async (method, payload) => {
      const result = await invoke(method, payload);
      if (method === "bootstrap") result.value.jobs = jobs;
      if (method === "listJobs") result.value = jobs;
      return result;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
}

test("completed task uses compact columns without a stopped speed or empty actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTasks(page);
  const job = page.locator(".job").first();
  await expect(job.locator(".job-title")).toHaveText("photo.jpg");
  await expect(job.locator(".job-state")).toHaveText("成功");
  await expect(job.locator(".job-percentage")).toHaveText("100%");
  await expect(job.locator(".job-key")).toHaveText(
    "repair/2026_10_28/photo.jpg",
  );
  await expect(job.locator(".job-speed")).toHaveCount(0);
  await expect(job.locator(".job-actions")).toHaveCount(0);
  const bar = await job
    .getByRole("progressbar", { name: "传输进度" })
    .boundingBox();
  const card = await job.boundingBox();
  expect(bar.width).toBeGreaterThan(card.width * 0.2);
  expect(bar.width).toBeLessThan(card.width * 0.6);
  expect(card.height).toBeLessThanOrEqual(108);
  const state = await job.locator(".job-state").boundingBox();
  expect(state.x).toBeGreaterThan(bar.x + bar.width);
});

test("active, unknown-size, empty and failed tasks retain distinct progress and feedback", async ({
  page,
}) => {
  await openTasks(page);
  const running = page.locator(".job").filter({ hasText: "running.bin" });
  await expect(running.locator(".job-percentage")).toHaveText("25%");
  await expect(running.locator(".job-speed")).toContainText("512 KB/s");
  const unknown = page.locator(".job").filter({ hasText: "unknown.bin" });
  await expect(unknown).toContainText("总大小未知");
  await expect(unknown.getByRole("progressbar")).not.toHaveAttribute("value");
  const empty = page.locator(".job").filter({ hasText: "empty.txt" });
  await expect(empty.locator(".job-percentage")).toHaveText("100%");
  expect(
    await empty.getByRole("progressbar").evaluate((el) => el.position),
  ).toBe(1);
  const failed = page.locator(".job").filter({ hasText: "failed.bin" });
  await expect(failed.locator(".job-state")).toHaveText("失败");
  await expect(failed).toContainText("网络中断，请重试。");
  await expect(failed).toContainText("请核实远端结果。");
  await expect(
    failed.getByRole("button", { name: "重试任务", exact: true }),
  ).toBeVisible();
});

test("task cards keep status, progress and actions aligned in all display combinations", async ({
  page,
}, info) => {
  await openTasks(page);
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
            },
            { theme, large, collapsed },
          );
          for (const card of await page.locator(".job").all()) {
            expect(
              await card.evaluate((el) => el.scrollWidth <= el.clientWidth),
            ).toBe(true);
            const state = await card.locator(".job-state").boundingBox();
            const bounds = await card.boundingBox();
            expect(state.x + state.width).toBeLessThanOrEqual(
              bounds.x + bounds.width,
            );
          }
          expect(
            await page
              .locator(".tasks")
              .evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          if (
            !collapsed &&
            ((theme === "light" && !large && width === 1440) ||
              (theme === "dark" && large && width === 920))
          )
            await page.screenshot({
              path: info.outputPath(`${theme}-${width}.png`),
            });
        }
});
