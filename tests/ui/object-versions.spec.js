import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function setup(page) {
  await installFixture(page);
  await page.goto("/");
  await page.evaluate(() => {
    const base = window.storageLab.invoke;
    window.__versionCalls = [];
    window.storageLab.invoke = async (method, payload = {}) => {
      if (
        ![
          "listObjectVersions",
          "headObjectVersion",
          "restoreObjectVersion",
          "downloadObjectVersion",
        ].includes(method)
      )
        return base(method, payload);
      window.__versionCalls.push({ method, payload });
      if (window.__denyVersions)
        return {
          ok: false,
          error: { code: "ACCESS_DENIED", message: "历史版本权限不足" },
        };
      if (window.__slowVersions) await new Promise((r) => setTimeout(r, 300));
      let value;
      if (method === "listObjectVersions")
        value = {
          versioning: "enabled",
          entries: payload.keyMarker
            ? [
                {
                  key: payload.key,
                  versionId: "null",
                  latest: false,
                  deleteMarker: false,
                  size: 7,
                  lastModified: 0,
                },
              ]
            : [
                {
                  key: payload.key,
                  versionId: "marker-v",
                  latest: true,
                  deleteMarker: true,
                  lastModified: 1000,
                },
                {
                  key: payload.key,
                  versionId: "old+/v",
                  latest: false,
                  deleteMarker: false,
                  size: 3,
                  lastModified: 0,
                },
              ],
          nextPage: payload.keyMarker
            ? undefined
            : { keyMarker: payload.key, versionIdMarker: "raw+/next" },
        };
      if (method === "headObjectVersion")
        value = {
          key: payload.key,
          versionId: payload.versionId,
          size: 3,
          contentType: "text/plain",
          metadata: { env: "old" },
          retention: { mode: "GOVERNANCE", retainUntil: 0, legalHold: "ON" },
        };
      if (method === "downloadObjectVersion")
        value = { jobs: [{ id: "version-job" }] };
      if (method === "restoreObjectVersion")
        value = window.__cancelRestore
          ? { cancelled: true }
          : { restored: true, versionId: "new-v", warning: "历史版本保留" };
      return { ok: true, value };
    };
  });
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
}
test("deleted Key history, fixed-version download/restore and raw double-marker pagination", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "版本与恢复", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "对象版本与恢复" });
  await expect(dialog).toBeVisible();
  const key = "已删除/+%?#.txt ";
  await dialog.getByLabel("完整原始 Key", { exact: true }).fill(key);
  await dialog
    .getByRole("button", { name: "读取历史版本", exact: true })
    .click();
  await expect(dialog).toContainText("删除标记");
  await expect(
    dialog.getByRole("button", { name: "选择版本 marker-v", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "选择版本 old+/v", exact: true })
    .click();
  await expect(dialog).toContainText("GOVERNANCE");
  await expect(dialog).toContainText("1970-01-01");
  await dialog
    .getByRole("button", { name: "下载所选版本", exact: true })
    .click();
  expect(
    await page.evaluate(
      () =>
        window.__versionCalls.find((c) => c.method === "downloadObjectVersion")
          .payload,
    ),
  ).toMatchObject({ key, versionId: "old+/v", overwrite: false });
  await page.evaluate(() => {
    window.__cancelRestore = true;
  });
  await dialog
    .getByRole("button", { name: "恢复为当前对象", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已取消恢复");
  await page.evaluate(() => {
    window.__cancelRestore = false;
  });
  await dialog
    .getByRole("button", { name: "恢复为当前对象", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("已恢复");
  expect(
    await page.evaluate(
      () =>
        window.__versionCalls.find((c) => c.method === "restoreObjectVersion")
          .payload,
    ),
  ).toMatchObject({ key, versionId: "old+/v" });
  await dialog.getByRole("button", { name: "下一页版本", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__versionCalls
          .filter((c) => c.method === "listObjectVersions")
          .at(-1).payload,
    ),
  ).toMatchObject({ key, keyMarker: key, versionIdMarker: "raw+/next" });
  await dialog
    .getByRole("button", { name: "选择版本 null", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "恢复为当前对象", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText("null版本可被替换");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "版本与恢复", exact: true }),
  ).toBeFocused();
});
test("failed history is distinct from empty history and late results cannot populate another Key", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "版本与恢复", exact: true }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("完整原始 Key", { exact: true }).fill("denied.txt");
  await page.evaluate(() => {
    window.__denyVersions = true;
  });
  await d.getByRole("button", { name: "读取历史版本", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("ACCESS_DENIED");
  await expect(
    d.getByText("本页没有此 Key 的历史版本", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__denyVersions = false;
    window.__slowVersions = true;
  });
  await d.getByRole("button", { name: "读取历史版本", exact: true }).click();
  await expect(d).toContainText("正在读取");
  await d.getByLabel("完整原始 Key", { exact: true }).fill("next.txt");
  await page.waitForTimeout(400);
  await expect(
    d.getByRole("button", { name: "选择版本 old+/v", exact: true }),
  ).toHaveCount(0);
  await expect(d.getByRole("alert")).toHaveCount(0);
});

for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`versions display ${theme}/${large}/${collapsed}/${width}`, async ({
          page,
        }, info) => {
          await setup(page);
          await page.setViewportSize({
            width,
            height: width === 920 ? 620 : 900,
          });
          await page.getByRole("button", { name: "设置", exact: true }).click();
          await page
            .getByRole("combobox", { name: "主题", exact: true })
            .selectOption(theme);
          await page.getByLabel("大字模式", { exact: true }).setChecked(large);
          await page
            .getByRole("button", { name: "保存设置", exact: true })
            .click();
          if (collapsed)
            await page
              .getByRole("button", { name: "折叠侧栏", exact: true })
              .click();
          await page
            .getByRole("button", { name: "版本与恢复", exact: true })
            .click();
          const d = page.getByRole("dialog");
          await d
            .getByLabel("完整原始 Key", { exact: true })
            .fill("长Key/".repeat(30) + "历史.txt");
          await d
            .getByRole("button", { name: "读取历史版本", exact: true })
            .click();
          await d
            .getByRole("button", { name: "选择版本 old+/v", exact: true })
            .click();
          await expect(d).toContainText("GOVERNANCE");
          expect(
            await d.evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
          ).toBe(true);
          await d
            .getByRole("button", { name: "恢复为当前对象", exact: true })
            .scrollIntoViewIfNeeded();
          await expect(
            d.getByRole("button", { name: "恢复为当前对象", exact: true }),
          ).toBeInViewport();
          await page.screenshot({ path: info.outputPath("versions.png") });
          await page.keyboard.press("Escape");
          await expect(
            page.getByRole("button", { name: "版本与恢复", exact: true }),
          ).toBeFocused();
        });

test("version dialog balances history and selected details, with an aligned Key query", async ({
  page,
}, info) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "版本与恢复", exact: true }).click();
  const d = page.getByRole("dialog", { name: "对象版本与恢复" });
  await d
    .getByLabel("完整原始 Key", { exact: true })
    .fill("history/sample.txt");
  await d.getByRole("button", { name: "读取历史版本", exact: true }).click();
  await d.getByRole("button", { name: "选择版本 old+/v", exact: true }).click();
  await expect(d).toContainText("GOVERNANCE");
  await page.screenshot({ path: info.outputPath("version-layout.png") });
  const list = await d.locator(".version-table").boundingBox();
  const detail = await d
    .getByRole("region", { name: "所选版本", exact: true })
    .boundingBox();
  expect(detail.x).toBeGreaterThanOrEqual(list.x + list.width);
  expect(Math.abs(detail.y - list.y)).toBeLessThan(85);
  const query = await d
    .getByLabel("完整原始 Key", { exact: true })
    .boundingBox();
  const read = await d
    .getByRole("button", { name: "读取历史版本", exact: true })
    .boundingBox();
  expect(read.x).toBeGreaterThanOrEqual(query.x + query.width);
  expect(Math.abs(read.y + read.height - query.y - query.height)).toBeLessThan(
    2,
  );
});
