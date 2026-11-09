import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
});

test("success feedback does not move the list and pauses while being read", async ({
  page,
}) => {
  await page.clock.install();
  const table = page.locator(".browser .table-scroll");
  const before = await table.boundingBox();
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  const status = page.getByRole("status").filter({ hasText: "任务已加入队列" });
  await expect(status).toBeVisible();
  expect((await table.boundingBox()).y).toBe(before.y);
  await status.hover();
  await page.clock.fastForward(7000);
  await expect(status).toBeVisible();
  await page.mouse.move(10, 10);
  await page.clock.fastForward(5000);
  // Repeated actions with identical messages restart the reading interval.
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  await page.clock.fastForward(2000);
  await expect(status).toBeVisible();
  await page.clock.fastForward(4100);
  await expect(status).toHaveCount(0);
  expect((await table.boundingBox()).y).toBe(before.y);
});

test("partial failures remain readable until dismissed without hiding list commands", async ({
  page,
}) => {
  await page.clock.install();
  await page.getByLabel("选择 fast.txt", { exact: true }).check();
  await page.getByRole("button", { name: "删除选中", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("denied.txt");
  await page.clock.fastForward(30000);
  await expect(alert).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "失败 1" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "关闭错误", exact: true }).click();
  await expect(alert).toHaveCount(0);
});

test("compact browser keeps the list prominent and directory arrows open raw prefixes", async ({
  page,
}) => {
  expect((await page.locator(".table-scroll").boundingBox()).y).toBeLessThan(
    300,
  );
  await page
    .getByRole("button", { name: "打开目录 raw/../", exact: true })
    .click();
  await expect(page.locator(".crumb")).toContainText("raw/../");
  await expect(
    page.getByRole("button", { name: "raw/../raw\\../对象.txt", exact: true }),
  ).toBeVisible();
});

test("narrow-window object selection opens details with a local close action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await page.getByRole("button", { name: "收起详情", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  await expect(page.getByLabel("完整原始 Key", { exact: true })).toHaveValue(
    "fast.txt",
  );
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(page.locator(".details")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "fast.txt", exact: true }),
  ).toBeVisible();
});

test("current-page filtering includes directories and explains no matches", async ({
  page,
}) => {
  await page.getByLabel("筛选当前页").fill("fast");
  await expect(
    page.getByRole("button", { name: "raw/../", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "fast.txt", exact: true }),
  ).toBeVisible();
  await page.getByLabel("筛选当前页").fill("missing");
  await expect(page.locator(".browser .empty")).toContainText("没有匹配");
  await page.getByLabel("筛选当前页").fill("");
  await expect(
    page.getByRole("button", { name: "raw/../", exact: true }),
  ).toBeVisible();
});
