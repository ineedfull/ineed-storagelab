import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function setup(page, theme, large, collapsed) {
  await installFixture(page);
  await page.goto("/");
  await page.evaluate(() => {
    const invoke = window.storageLab.invoke;
    window.storageLab.invoke = async (method, payload) => {
      if (method === "prepareObjectMutation")
        return {
          ok: true,
          value: {
            size: 4,
            contentType: "text/plain",
            metadata: { env: "old" },
            capabilities: { conditionalCopy: true },
          },
        };
      if (method === "listObjectVersions")
        return {
          ok: true,
          value: { versioning: "enabled", entries: [] },
        };
      return invoke(method, payload);
    };
  });
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption(theme);
  await page.getByLabel("大字模式", { exact: true }).setChecked(large);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  if (collapsed)
    await page.getByRole("button", { name: "折叠侧栏", exact: true }).click();
}

async function aligned(controls, { equalWidth = true } = {}) {
  const boxes = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  expect(boxes.length).toBeGreaterThan(1);
  for (const box of boxes.slice(1)) {
    expect(Math.abs(box.y - boxes[0].y), JSON.stringify(boxes)).toBeLessThan(1);
    expect(Math.abs(box.height - boxes[0].height)).toBeLessThan(1);
    if (equalWidth)
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1);
  }
  return boxes;
}

async function dialogBounds(dialog) {
  await expect(dialog.locator(":scope > header")).toBeInViewport({ ratio: 1 });
  const footer = dialog.locator(":scope > .dialog-footer");
  await expect(footer).toBeInViewport({ ratio: 1 });
  const before = await footer.boundingBox();
  const body = dialog.locator(":scope > .dialog-body");
  expect(
    await body.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await body.evaluate((element) => (element.scrollTop = element.scrollHeight));
  expect(await footer.boundingBox()).toEqual(before);
  await body.evaluate((element) => (element.scrollTop = 0));
}

async function connectionFields(dialog, large) {
  for (const selector of [
    "#connection-name, #connection-group",
    "#connection-region, #connection-bucket",
    "#connection-access-key, #connection-secret-key",
  ]) {
    const boxes = await aligned(dialog.locator(selector));
    expect(boxes[0].height).toBe(large ? 40 : 34);
  }
  const errors = await dialog
    .locator(".connection-field")
    .evaluateAll((fields) =>
      fields.flatMap((field) => {
        const control = field.querySelector(
          "input:not([type=checkbox]), select",
        );
        if (!control) return [];
        const bounds = field.getBoundingClientRect();
        const input = control.getBoundingClientRect();
        const description = field.querySelector(":scope > p");
        return input.left !== bounds.left ||
          input.width !== bounds.width ||
          (description &&
            description.getBoundingClientRect().top < input.bottom)
          ? [control.id]
          : [];
      }),
    );
  expect(errors).toEqual([]);
  await dialogBounds(dialog);
  const last = dialog.getByLabel("公开 Base URL", { exact: true });
  await dialog.getByLabel("名称", { exact: true }).focus();
  await last.focus();
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(last).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "保存连接", exact: true }),
  ).toBeInViewport({ ratio: 1 });
}

for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 1120, 920]) {
        test(`input forms align ${theme}/${large}/${collapsed}/${width}`, async ({
          page,
        }, info) => {
          test.setTimeout(60_000);
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : width === 1120 ? 720 : 620,
          });
          await setup(page, theme, large, collapsed);
          await aligned(
            page.locator(".bucket-toolbar input, .bucket-toolbar > button"),
            {
              equalWidth: false,
            },
          );
          await aligned(
            page.locator(".object-filters input, .object-filters select"),
            {
              equalWidth: false,
            },
          );
          await page
            .getByRole("button", { name: "新建连接", exact: true })
            .click();
          let dialog = page.getByRole("dialog");
          const providers = await dialog
            .locator("#connection-provider option")
            .evaluateAll((options) => options.map((option) => option.value));
          expect(providers).toHaveLength(12);
          for (const provider of providers) {
            await dialog
              .getByLabel("提供商", { exact: true })
              .selectOption(provider);
            await connectionFields(dialog, large);
            if (provider === "r2")
              await aligned(
                dialog.locator("#connection-location, #connection-account"),
              );
          }
          await page.screenshot({ path: info.outputPath("connection.png") });
          await page.keyboard.press("Escape");
          await page
            .getByRole("button", { name: "编辑连接", exact: true })
            .click();
          await connectionFields(page.getByRole("dialog"), large);
          await page.keyboard.press("Escape");

          await page.getByRole("button", { name: "设置", exact: true }).click();
          dialog = page.getByRole("dialog");
          const settings = await dialog
            .locator("select, input[type=number]")
            .evaluateAll((controls) =>
              controls.map((control) => {
                const { x, width, height } = control.getBoundingClientRect();
                return { x, width, height };
              }),
            );
          expect(settings).toHaveLength(3);
          expect(
            settings.every(
              (box) =>
                box.x === settings[0].x &&
                box.width === settings[0].width &&
                box.height === settings[0].height,
            ),
          ).toBe(true);
          await dialogBounds(dialog);
          await page.keyboard.press("Escape");

          const expand = page.getByRole("button", {
            name: "展开详情",
            exact: true,
          });
          if (await expand.count()) await expand.click();
          await page
            .getByRole("button", { name: "fast.txt", exact: true })
            .click();
          const tags = page.getByRole("region", {
            name: "对象标签",
            exact: true,
          });
          await tags
            .getByRole("button", { name: "读取标签", exact: true })
            .click();
          await tags
            .getByRole("button", { name: "添加标签", exact: true })
            .click();
          await aligned(tags.locator(".tag-row input, .tag-row > button"), {
            equalWidth: false,
          });
          expect(
            await tags.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          await page.screenshot({ path: info.outputPath("tags.png") });

          for (const name of [
            "分享",
            "编辑元数据",
            "复制对象",
            "重命名对象",
            "版本与恢复",
          ]) {
            await page.getByRole("button", { name, exact: true }).click();
            dialog = page.getByRole("dialog");
            if (name === "分享") {
              await aligned(
                dialog.locator(".form-grid input, .form-grid select"),
              );
              await dialog
                .getByRole("button", { name: "生成链接", exact: true })
                .click();
              await expect(
                dialog.getByLabel("分享链接", { exact: true }),
              ).toHaveValue(/signed/);
            }
            if (name === "编辑元数据") {
              await expect(
                dialog.getByLabel("元数据键 1", { exact: true }),
              ).toHaveValue("env");
              await aligned(dialog.locator(".form-grid input"));
              await aligned(
                dialog.locator(".mutation-row input, .mutation-row > button"),
                {
                  equalWidth: false,
                },
              );
            }
            if (name === "版本与恢复") {
              const query = await dialog.locator("textarea").boundingBox();
              const button = await dialog
                .getByRole("button", { name: "读取历史版本", exact: true })
                .boundingBox();
              expect(
                Math.abs(query.y + query.height - button.y - button.height),
              ).toBeLessThan(1);
            }
            await dialogBounds(dialog);
            await page.screenshot({ path: info.outputPath(`${name}.png`) });
            const last = dialog.locator("input, select, textarea").last();
            await last.focus();
            await expect(last).toBeFocused();
            await expect(last).toBeInViewport({ ratio: 1 });
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
          }
        });
      }
