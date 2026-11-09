import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";

test.beforeEach(async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  await page.evaluate(() => {
    const invoke = window.storageLab.invoke;
    window.__connectionSaves = [];
    window.storageLab.invoke = async (method, payload) => {
      if (method === "saveConnection") {
        window.__connectionSaves.push(payload);
        if (window.__holdConnectionSave) {
          await new Promise(
            (resolve) => (window.__releaseConnectionSave = resolve),
          );
          return { ok: false, error: { message: "模拟连接保存失败" } };
        }
      }
      return invoke(method, payload);
    };
  });
});

test("new connections leave signing region blank until explicitly configured and retain saved regions", async ({
  page,
}) => {
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  const region = page.getByLabel("签名区域", { exact: true });
  await expect(region).toHaveValue("");
  await page.getByLabel("提供商", { exact: true }).selectOption("aws");
  await expect(region).toHaveValue("");
  await page
    .getByRole("button", { name: "应用提供商配置", exact: true })
    .click();
  await expect(region).toHaveValue("us-east-1");
  await region.fill("ap-southeast-1");
  await page.getByLabel("名称", { exact: true }).fill("明确配置区域");
  await page.getByLabel("Access Key", { exact: true }).fill("fixture-ak");
  await page.getByLabel("Secret Key", { exact: true }).fill("fixture-sk");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  await expect(region).toHaveValue("ap-southeast-1");
});

test("connection actions stay visible while fields scroll and Enter submits an edit without replacing credentials", async ({
  page,
}) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("header")).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "保存连接", exact: true }),
  ).toBeInViewport();
  await page
    .getByLabel("公开 Base URL", { exact: true })
    .fill("https://files.example.invalid");
  await expect(dialog.locator("header")).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "保存连接", exact: true }),
  ).toBeInViewport();
  await page.getByLabel("名称", { exact: true }).fill("重命名连接");
  await page.getByLabel("名称", { exact: true }).press("Enter");
  await expect(dialog).toHaveCount(0);
  const [saved] = await page.evaluate(() => window.__connectionSaves);
  expect(saved.connection.name).toBe("重命名连接");
  expect(saved.connection.publicBaseUrl).toBe("https://files.example.invalid");
  expect(saved).not.toHaveProperty("credentials");
});

test("saving locks form and dismissal, then displays failures beside actions and retains draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("保留草稿");
  await page.evaluate(() => (window.__holdConnectionSave = true));
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByLabel("名称", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "关闭弹窗", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("dialog")).toBeFocused();
  await page.evaluate(() => window.__releaseConnectionSave());
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "模拟连接保存失败",
  );
  await expect(page.getByRole("dialog").getByRole("alert")).toBeInViewport();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue(
    "保留草稿",
  );
  await expect(page.getByLabel("名称", { exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__connectionSaves.length)).toBe(1);
});

test("partial credential replacement is rejected and a complete temporary credential can be saved", async ({
  page,
}) => {
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  await expect(page.getByLabel("Access Key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Secret Key", { exact: true })).toHaveValue("");
  await page.getByLabel("Session Token", { exact: true }).fill("fixture-token");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Access Key",
  );
  expect(await page.evaluate(() => window.__connectionSaves.length)).toBe(0);
  await page.getByLabel("Access Key", { exact: true }).fill("fixture-ak");
  await page.getByLabel("Secret Key", { exact: true }).fill("fixture-sk");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const [saved] = await page.evaluate(() => window.__connectionSaves);
  expect(saved.credentials).toEqual({
    accessKeyId: "fixture-ak",
    secretAccessKey: "fixture-sk",
    sessionToken: "fixture-token",
  });
});
