import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

async function open(page) {
  await installFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
}
async function openLegacy(page, provider, endpoint, region) {
  await installFixture(page);
  await page.addInitScript(
    ({ provider, endpoint, region }) => {
      const original = window.storageLab.invoke;
      let seeded = false;
      window.storageLab.invoke = async (method, payload) => {
        if (method === "bootstrap" && !seeded) {
          seeded = true;
          await original("saveConnection", {
            connection: {
              id: "legacy",
              name: "Saved legacy",
              provider,
              endpoint,
              region,
              forcePathStyle: false,
            },
            credentialStorage: "session",
          });
        }
        return original(method, payload);
      };
    },
    { provider, endpoint, region },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Saved legacy", exact: true }).click();
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
}
async function save(page, name) {
  await page.getByLabel("名称", { exact: true }).fill(name);
  await page.getByLabel("Access Key", { exact: true }).fill("fixture-ak");
  await page.getByLabel("Secret Key", { exact: true }).fill("fixture-sk");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
}
for (const [id, endpoint, region] of [
  ["oss", "https://oss-cn-shanghai.aliyuncs.com", "cn-shanghai"],
  ["obs", "https://obs.cn-north-4.myhuaweicloud.com", "cn-north-4"],
  ["cos-native", "https://cos.ap-guangzhou.myqcloud.com", "ap-guangzhou"],
  ["tos-native", "https://tos-cn-beijing.volces.com", "cn-beijing"],
])
  test(`native ${id} presets and native region labels save without credentials exposure`, async ({
    page,
  }) => {
    await open(page);
    await page.getByLabel("提供商", { exact: true }).selectOption(id);
    await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
      "http://127.0.0.1:9000",
    );
    await page
      .getByRole("button", { name: "应用提供商配置", exact: true })
      .click();
    await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
      endpoint,
    );
    await expect(page.getByLabel("区域", { exact: true })).toHaveValue(region);
    if (["obs", "cos-native"].includes(id)) {
      await expect(page.getByLabel("Path style 寻址")).toBeDisabled();
      await expect(page.getByLabel("Path style 寻址")).not.toBeChecked();
    }
    await save(page, `Native ${id}`);
    await page.getByRole("button", { name: "编辑连接", exact: true }).click();
    await expect(page.getByLabel("提供商", { exact: true })).toHaveValue(id);
    await expect(page.getByLabel("Secret Key", { exact: true })).toHaveValue(
      "",
    );
    await page.keyboard.press("Escape");
    await page.getByLabel("已知桶", { exact: true }).fill("known");
    await page.getByRole("button", { name: "打开桶", exact: true }).click();
    await page.getByRole("button", { name: "fast.txt", exact: true }).click();
    if (
      await page.getByRole("button", { name: "展开详情", exact: true }).count()
    )
      await page.getByRole("button", { name: "展开详情", exact: true }).click();
    const tags = page.getByRole("region", { name: "对象标签" });
    await tags.getByRole("button", { name: "读取标签", exact: true }).click();
    expect(
      await page.evaluate(() => window.__tagCalls.map((c) => c.method)),
    ).toEqual(["getObjectTags"]);
  });

for (const canonical of [true, false])
  test(`legacy aliyun explicit native migration ${canonical ? "canonical" : "custom"} only takes effect on save`, async ({
    page,
  }) => {
    const old = canonical
      ? "https://s3.oss-cn-shanghai.aliyuncs.com"
      : "https://custom.example.invalid";
    await openLegacy(page, "aliyun", old, "cn-shanghai");
    await expect(
      page.getByLabel("提供商", { exact: true }).locator("option:checked"),
    ).toContainText("当前旧版连接");
    await expect(
      page.getByLabel("提供商", { exact: true }).locator("option:checked"),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "迁移为原生 OSS", exact: true })
      .click();
    await expect(page.getByLabel("提供商", { exact: true })).toHaveValue("oss");
    await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
      canonical ? "https://oss-cn-shanghai.aliyuncs.com" : old,
    );
    await expect(
      page.getByRole("status").filter({ hasText: "保存后" }),
    ).toContainText("保存后");
    if (!canonical)
      await expect(
        page.getByRole("status").filter({ hasText: "核对" }),
      ).toContainText("核对");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "编辑连接", exact: true }).click();
    await expect(page.getByLabel("提供商", { exact: true })).toHaveValue(
      "aliyun",
    );
    await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(old);
    await page
      .getByRole("button", { name: "迁移为原生 OSS", exact: true })
      .click();
    await page.getByRole("button", { name: "保存连接", exact: true }).click();
    await page.getByRole("button", { name: "编辑连接", exact: true }).click();
    await expect(page.getByLabel("提供商", { exact: true })).toHaveValue("oss");
  });

for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`native provider layout ${theme}/${large}/${collapsed}/${width}`, async ({
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
          const dialog = page.getByRole("dialog");
          for (const id of ["oss", "obs", "cos-native", "tos-native"]) {
            await page.getByLabel("提供商", { exact: true }).selectOption(id);
            await page
              .getByRole("button", { name: "应用提供商配置", exact: true })
              .click();
            await expect(dialog.locator("header")).toBeInViewport();
            await expect(dialog.locator("footer")).toBeInViewport();
            expect(
              await dialog.evaluate(
                (el) => el.scrollWidth <= el.clientWidth + 1,
              ),
            ).toBe(true);
            const footer = await dialog.locator("footer").boundingBox();
            await page
              .getByLabel("区域", { exact: true })
              .scrollIntoViewIfNeeded();
            await expect(
              page.getByLabel("区域", { exact: true }),
            ).toBeInViewport({ ratio: 1 });
            await page.screenshot({ path: info.outputPath(`${id}-form.png`) });
            await page
              .getByLabel("Session Token", { exact: true })
              .fill("fixture-token");
            await page
              .getByLabel("公开 Base URL", { exact: true })
              .fill("https://files.example.invalid");
            await expect(dialog.locator("header")).toBeInViewport();
            expect(await dialog.locator("footer").boundingBox()).toEqual(
              footer,
            );
          }
          await page.keyboard.press("Escape");
          await expect(
            page.getByRole("button", { name: "新建连接", exact: true }),
          ).toBeFocused();
        });

test("native OSS rejects a legacy S3 endpoint before saving", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("提供商", { exact: true }).selectOption("oss");
  await page.getByLabel("区域", { exact: true }).fill("cn-shanghai");
  await page
    .getByLabel("Endpoint", { exact: true })
    .fill("https://s3.oss-cn-shanghai.aliyuncs.com");
  await save(page, "invalid OSS");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("不能使用S3兼容域名");
});

for (const [legacy, native, name, oldEndpoint, endpoint, region] of [
  [
    "cos",
    "cos-native",
    "COS",
    "https://cos.ap-shanghai.myqcloud.com",
    "https://cos.ap-shanghai.myqcloud.com",
    "ap-shanghai",
  ],
  [
    "tos",
    "tos-native",
    "TOS",
    "https://tos-s3-cn-shanghai.volces.com",
    "https://tos-cn-shanghai.volces.com",
    "cn-shanghai",
  ],
])
  for (const canonical of [true, false])
    test(`legacy ${legacy} migration ${canonical ? "canonical" : "custom"} is explicit and cancellable`, async ({
      page,
    }) => {
      const old = canonical ? oldEndpoint : "https://custom.example.invalid";
      await openLegacy(page, legacy, old, region);
      const select = page.getByLabel("提供商", { exact: true });
      await expect(select.locator(`option[value="${legacy}"]`)).toBeDisabled();
      const vendor = legacy === "cos" ? "腾讯云 COS" : "火山引擎 TOS";
      await expect(select.locator(`option[value="${legacy}"]`)).toHaveText(
        `${vendor}（旧版/S3兼容）（当前旧版连接）`,
      );
      await expect(select.locator(`option[value="${native}"]`)).toHaveText(
        `${vendor}（原生）`,
      );
      const ids = await select
        .locator("option")
        .evaluateAll((options) => options.map((o) => o.value));
      expect(ids.filter((id) => ["aliyun", "cos", "tos"].includes(id))).toEqual(
        [legacy],
      );
      await page
        .getByRole("button", { name: `迁移为原生 ${name}`, exact: true })
        .click();
      await expect(select).toHaveValue(native);
      await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
        canonical ? endpoint : old,
      );
      await expect(page.getByLabel("区域", { exact: true })).toHaveValue(
        region,
      );
      await expect(
        page.getByRole("status").filter({ hasText: "保存后" }),
      ).toContainText(canonical ? "保存后" : "核对");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: "编辑连接", exact: true }).click();
      await expect(select).toHaveValue(legacy);
      await expect(page.getByLabel("Endpoint", { exact: true })).toHaveValue(
        old,
      );
      await page
        .getByRole("button", { name: `迁移为原生 ${name}`, exact: true })
        .click();
      await page.getByRole("button", { name: "保存连接", exact: true }).click();
      await page.getByRole("button", { name: "编辑连接", exact: true }).click();
      await expect(select).toHaveValue(native);
      await expect(page.getByLabel("区域", { exact: true })).toHaveValue(
        region,
      );
      await expect(page.getByLabel("Secret Key", { exact: true })).toHaveValue(
        "",
      );
    });

test("native TOS rejects a legacy S3 endpoint before saving", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("提供商", { exact: true }).selectOption("tos-native");
  await page.getByLabel("区域", { exact: true }).fill("cn-beijing");
  await page
    .getByLabel("Endpoint", { exact: true })
    .fill("https://tos-s3-cn-beijing.volces.com");
  await save(page, "invalid TOS");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("不能使用S3兼容域名");
});
