import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

test("cloud presets are explicit, retain manual endpoints until applied and save provider identity", async ({
  page,
}) => {
  await installFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  await page.getByLabel("提供商", { exact: true }).selectOption("oss");
  await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
    "http://127.0.0.1:9000",
  );
  await page.getByLabel("服务地域", { exact: true }).fill("cn-shanghai");
  await page
    .getByRole("button", { name: "应用提供商配置", exact: true })
    .click();
  await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
    "https://oss-cn-shanghai.aliyuncs.com",
  );
  await expect(page.getByLabel("Path style 寻址")).not.toBeChecked();
  await page.getByLabel("提供商", { exact: true }).selectOption("r2");
  await page.getByLabel("Account ID", { exact: true }).fill("b".repeat(32));
  await page
    .getByRole("button", { name: "应用提供商配置", exact: true })
    .click();
  await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
    `https://${"b".repeat(32)}.r2.cloudflarestorage.com`,
  );
  await expect(page.getByLabel("签名区域", { exact: true })).toHaveValue(
    "auto",
  );
  await page.getByLabel("名称", { exact: true }).fill("Cloud R2");
  await page.getByLabel("Access Key", { exact: true }).fill("fixture-ak");
  await page.getByLabel("Secret Key", { exact: true }).fill("fixture-sk");
  // us-east-1 is a valid R2 signing alias. Its disabled helper must still use auto.
  await page.getByLabel("签名区域", { exact: true }).fill("us-east-1");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  await expect(page.getByLabel("提供商", { exact: true })).toHaveValue("r2");
  await expect(page.getByLabel("签名区域", { exact: true })).toHaveValue(
    "us-east-1",
  );
  await expect(page.getByLabel("服务地域", { exact: true })).toHaveValue(
    "auto",
  );
  await page
    .getByRole("button", { name: "应用提供商配置", exact: true })
    .click();
  await expect(page.getByLabel("签名区域", { exact: true })).toHaveValue(
    "auto",
  );
  await expect(page.getByLabel("Secret Key", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.getByLabel("已知桶", { exact: true }).fill("known");
  await page.getByRole("button", { name: "打开桶", exact: true }).click();
  await page.getByRole("button", { name: "fast.txt", exact: true }).click();
  if (await page.getByRole("button", { name: "展开详情", exact: true }).count())
    await page.getByRole("button", { name: "展开详情", exact: true }).click();
  const tags = page.getByRole("region", { name: "对象标签" });
  await expect(tags).toContainText("不支持对象标签");
  await expect(
    tags.getByRole("button", { name: "读取标签", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => window.__tagCalls)).toEqual([]);
  await expect(
    page.getByRole("button", { name: "上传文件", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("明确允许覆盖", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "上传文件", exact: true }),
  ).toBeEnabled();
});

for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`cloud connection form ${theme}/${large}/${collapsed}/${width}`, async ({
          page,
        }, info) => {
          await installFixture(page);
          await page.setViewportSize({
            width,
            height: width === 920 ? 620 : 900,
          });
          await page.goto("/");
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
            .getByRole("button", { name: "新建连接", exact: true })
            .click();
          await page.getByLabel("提供商", { exact: true }).selectOption("r2");
          await page
            .getByLabel("Account ID", { exact: true })
            .fill("a".repeat(32));
          await page
            .getByRole("button", { name: "应用提供商配置", exact: true })
            .click();
          const dialog = page.getByRole("dialog");
          await expect(dialog.locator("header")).toBeInViewport();
          await expect(dialog.locator("footer")).toBeInViewport();
          const footerBefore = await dialog.locator("footer").boundingBox();
          expect(
            await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          ).toBe(true);
          await page.screenshot({ path: info.outputPath("cloud-form.png") });
          await page
            .getByLabel("Session Token", { exact: true })
            .fill("session-test");
          await page
            .getByLabel("公开 Base URL", { exact: true })
            .fill("https://files.example.invalid");
          await expect(
            page.getByLabel("公开 Base URL", { exact: true }),
          ).toBeInViewport({ ratio: 1 });
          await expect(dialog.locator("header")).toBeInViewport();
          expect(await dialog.locator("footer").boundingBox()).toEqual(
            footerBefore,
          );
          await page.screenshot({
            path: info.outputPath("cloud-form-bottom.png"),
          });
          await page
            .getByRole("button", { name: "保存连接", exact: true })
            .scrollIntoViewIfNeeded();
          await expect(
            page.getByRole("button", { name: "保存连接", exact: true }),
          ).toBeInViewport();
          await page.keyboard.press("Escape");
          await expect(
            page.getByRole("button", { name: "新建连接", exact: true }),
          ).toBeFocused();
        });

test("new connections offer only current providers and no legacy vendor S3 aliases", async ({
  page,
}) => {
  await installFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  const select = page.getByLabel("提供商", { exact: true });
  expect(
    await select
      .locator("option")
      .evaluateAll((options) => options.map((o) => o.value)),
  ).toEqual([
    "minio",
    "s3",
    "aws",
    "oss",
    "obs",
    "cos-native",
    "tos-native",
    "qiniu",
    "r2",
    "b2",
    "spaces",
    "wasabi",
  ]);
});
