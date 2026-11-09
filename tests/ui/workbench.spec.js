import { test, expect } from "@playwright/test";
test("browser clearly disables native operations and supports accessible settings", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "新建连接", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
});
test("native connection dialog keeps credentials out of edit drafts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.storageLab = {
      invoke: async (method, payload) => ({
        ok: true,
        value:
          method === "bootstrap"
            ? {
                connections: [
                  {
                    id: "c1",
                    name: "本地测试",
                    group: "测试",
                    provider: "minio",
                    endpoint: "http://127.0.0.1:9000",
                    region: "us-east-1",
                    forcePathStyle: true,
                    defaultBucket: "test",
                    hasCredentials: true,
                    credentialStorage: "session",
                  },
                ],
                settings: {
                  theme: "light",
                  largeText: false,
                  sidebarCollapsed: false,
                  concurrency: 2,
                  timeoutSeconds: 30,
                },
                jobs: [],
                app: {
                  native: true,
                  vaultAvailable: false,
                  version: "1.0.0",
                  runtime: "test",
                  dataDirectory: "isolated",
                },
              }
            : method === "listBuckets"
              ? { buckets: [] }
              : method === "listObjects"
                ? { objects: [], prefixes: [] }
                : true,
      }),
      onChange: () => () => {},
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "新建连接", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "新建连接", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
  await page.getByRole("button", { name: "编辑连接" }).click();
  await expect(page.getByLabel("Secret Key")).toHaveValue("");
  await expect(page.getByText("留空保留现有凭证")).toBeVisible();
});
