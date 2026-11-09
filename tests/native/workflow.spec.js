import { test, expect, _electron as electron } from "@playwright/test";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";
test("production UI + native service + real local MinIO roundtrip", async ({}, info) => {
  test.skip(
    !process.env.STORAGELAB_TEST_CONFIG &&
      !process.env.STORAGELAB_TEST_ENDPOINT,
    "Requires explicit private local MinIO test config",
  );
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/host.mjs"],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page
      .getByRole("button", { name: "Isolated MinIO", exact: true })
      .click();
    // Successful known-bucket browsing retires the transient ListBuckets error.
    await expect(
      page.getByRole("button", { name: "preview.txt", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "检查连接", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "指定桶的对象列表可访问",
    );
    await page.getByRole("button", { name: "编辑连接", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("Native edited MinIO");
    await page.getByRole("button", { name: "保存连接" }).click();
    await expect(
      page.getByRole("button", { name: "Native edited MinIO", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    await expect(page.locator(".job")).toContainText("成功");
    await page.getByRole("button", { name: "对象浏览", exact: true }).click();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("button", { name: "sample.txt", exact: true }).click();
    await page.getByRole("button", { name: "安全预览", exact: true }).click();
    await expect(page.locator(".preview")).toHaveText(
      "StorageLab native roundtrip\n",
    );
    const tags = page.getByRole("region", { name: "对象标签" });
    await tags.getByRole("button", { name: "读取标签", exact: true }).click();
    await expect(tags).toContainText("当前无标签");
    await tags.getByRole("button", { name: "添加标签", exact: true }).click();
    await tags.getByLabel("标签1 Key", { exact: true }).fill("environment");
    await tags.getByLabel("标签1 Value", { exact: true }).fill(" native test ");
    await tags.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(tags.getByRole("status")).toHaveText("标签已保存");
    // Observe stored tags through real S3 independently of the editor result.
    expect(await app.evaluate(() => globalThis.readTags("sample.txt"))).toEqual(
      [{ Key: "environment", Value: " native test " }],
    );
    await page.screenshot({
      path: info.outputPath("native-loaded-details.png"),
    });
    for (const theme of ["light", "dark"])
      for (const large of [false, true])
        for (const collapsed of [false, true])
          for (const width of [1440, 920]) {
            await app.evaluate(
              ({ BrowserWindow }, { width, height }) =>
                BrowserWindow.getAllWindows()[0].setSize(width, height),
              { width, height: width === 1440 ? 900 : 620 },
            );
            await page
              .getByRole("button", { name: "设置", exact: true })
              .click();
            await page
              .getByRole("combobox", { name: "主题", exact: true })
              .selectOption(theme);
            await page
              .getByLabel("大字模式", { exact: true })
              .setChecked(large);
            await page.getByRole("button", { name: "保存设置" }).click();
            const isCollapsed = await page
              .locator(".workbench")
              .evaluate((el) => el.classList.contains("collapsed"));
            if (isCollapsed !== collapsed)
              await page
                .getByRole("button", {
                  name: isCollapsed ? "展开侧栏" : "折叠侧栏",
                  exact: true,
                })
                .click();
            await expect(
              page.getByRole("button", {
                name: collapsed ? "展开侧栏" : "折叠侧栏",
                exact: true,
              }),
            ).toHaveAttribute("aria-expanded", String(!collapsed));
            if (
              width === 920 &&
              (await page.getByRole("button", { name: "收起详情" }).count())
            )
              await page.getByRole("button", { name: "收起详情" }).click();
            await expect(
              page.getByRole("button", { name: "sample.txt", exact: true }),
            ).toBeInViewport({ ratio: 1 });
            await expect(
              page.getByRole("button", { name: "preview.txt", exact: true }),
            ).toBeInViewport({ ratio: 1 });
            await page.screenshot({
              path: info.outputPath(
                `native-${theme}-${large}-${collapsed}-${width}.png`,
              ),
            });
            if (
              await page
                .getByRole("button", { name: "展开详情", exact: true })
                .count()
            )
              await page
                .getByRole("button", { name: "展开详情", exact: true })
                .click();
            await tags
              .getByLabel("标签1 Key", { exact: true })
              .scrollIntoViewIfNeeded();
            await expect(
              tags.getByLabel("标签1 Key", { exact: true }),
            ).toHaveValue("environment");
            const fits = await tags.evaluate(
              (el) => el.scrollWidth <= el.clientWidth + 1,
            );
            expect(fits).toBe(true);
            await page.screenshot({
              path: info.outputPath(
                `native-tags-${theme}-${large}-${collapsed}-${width}.png`,
              ),
            });
          }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 900),
    );
    if (await page.getByRole("button", { name: "展开详情" }).count())
      await page.getByRole("button", { name: "展开详情" }).click();
    await tags.getByRole("button", { name: "移除标签1", exact: true }).click();
    await tags.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(tags.getByRole("status")).toHaveText("标签已保存");
    await tags
      .getByRole("button", { name: "重新读取标签", exact: true })
      .click();
    await expect(tags).toContainText("当前无标签");
    await page.getByLabel("选择 sample.txt", { exact: true }).check();
    await page.getByRole("button", { name: "下载选中" }).click();
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    await expect(page.locator(".job").filter({ hasText: "成功" })).toHaveCount(
      2,
    );
    expect(await app.evaluate(() => globalThis.readDownloaded())).toBe(
      "StorageLab native roundtrip\n",
    );
    await app.evaluate(() => {
      globalThis.fixture.dialog.showSaveDialog = async () => ({
        canceled: true,
      });
    });
    await page.getByRole("button", { name: "导出任务", exact: true }).click();
    await expect(page.locator(".job")).toHaveCount(2);
    await app.evaluate(() => {
      globalThis.fixture.dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: `${globalThis.fixture.directory}/jobs.json`,
      });
    });
    await page.getByRole("button", { name: "导出任务", exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(async () => {
          const f = globalThis.fixture;
          const raw = await globalThis.readExportedJobs();
          if (raw === null) return null;
          const rows = JSON.parse(raw);
          return {
            count: rows.length,
            directions: rows.map((row) => row.direction).sort(),
            allSuccessful: rows.every((row) => row.state === "success"),
            exposesPrivateData:
              raw.includes(f.directory) ||
              raw.includes(f.credentials.secretAccessKey),
          };
        }),
      )
      .toEqual({
        count: 2,
        directions: ["download", "upload"],
        allSuccessful: true,
        exposesPrivateData: false,
      });
    await page.getByRole("button", { name: "对象浏览", exact: true }).click();
    await page.getByRole("button", { name: "分享", exact: true }).click();
    await page.getByRole("button", { name: "生成链接" }).click();
    const url = await page.getByLabel("分享链接", { exact: true }).inputValue();
    expect(await (await fetch(url)).text()).toBe(
      "StorageLab native roundtrip\n",
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "删除选中" }).click();
    await expect(page.getByRole("status")).toContainText("删除 1 项");
    await app.evaluate(() => globalThis.prepareCancelFile());
    await page.getByRole("button", { name: "上传文件", exact: true }).click();
    await page.getByRole("button", { name: /任务中心 \(/ }).click();
    await page
      .locator(".job")
      .filter({ hasText: "cancel.bin" })
      .getByRole("button", { name: "取消任务" })
      .click();
    await expect(
      page.locator(".job").filter({ hasText: "cancel.bin" }),
    ).toContainText("已取消");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page
      .getByRole("combobox", { name: "主题", exact: true })
      .selectOption("dark");
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "关于", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("1.0.0");
    await page.keyboard.press("Escape");
    await page.screenshot({ path: info.outputPath("native-workbench.png") });
    expect(errors).toEqual([]);
    expect(await app.evaluate(({ app }) => app.getName())).toBe("StorageLab");
  } finally {
    await app.close();
  }
});
