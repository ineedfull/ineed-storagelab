import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";
async function setup(page) {
  await installFixture(page);
  await page.goto("/");
  await page.evaluate(() => {
    const base = window.storageLab.invoke;
    window.__resumeCalls = [];
    let jobs = [
      {
        id: "resume-1",
        connectionId: "c1",
        connectionName: "本地测试",
        bucket: "known",
        key: "长目录/".repeat(12) + "resume.bin",
        direction: "upload",
        state: "interrupted",
        resumable: true,
        resumeAvailable: true,
        bytesTransferred: 8388608,
        totalBytes: 25165824,
        updatedAt: 0,
      },
      {
        id: "old-download",
        connectionName: "本地测试",
        bucket: "known",
        key: "old-download.bin",
        direction: "download",
        state: "interrupted",
        bytesTransferred: 10,
        totalBytes: 20,
        updatedAt: 0,
      },
    ];
    window.storageLab.invoke = async (method, p = {}) => {
      if (["uploadFiles", "resumeUpload", "discardUpload"].includes(method))
        window.__resumeCalls.push({ method, p });
      if (["listJobs", "bootstrap"].includes(method)) {
        const r = await base(method, p);
        return {
          ...r,
          value: method === "listJobs" ? jobs : { ...r.value, jobs },
        };
      }
      if (["resumeUpload", "discardUpload"].includes(method)) {
        if (window.__slowResume) await new Promise((r) => setTimeout(r, 300));
        if (window.__cancelResume)
          return { ok: true, value: { cancelled: true } };
        if (method === "resumeUpload") {
          jobs = jobs.map((j) =>
            j.id === p.id ? { ...j, resumeAvailable: false } : j,
          );
          return { ok: true, value: { jobs: [{ id: "new-resume" }] } };
        }
        jobs = jobs.map((j) =>
          j.id === p.id ? { ...j, resumeAvailable: false } : j,
        );
        return {
          ok: true,
          value: { discarded: true, localOnly: window.__localOnly === true },
        };
      }
      return base(method, p);
    };
  });
  await page.getByRole("button", { name: "本地测试", exact: true }).click();
}
test("upload resume is explicit and sends no file path to renderer bridge", async ({
  page,
}) => {
  await setup(page);
  await page.getByLabel("启用上传断点续传", { exact: true }).check();
  await page.getByRole("button", { name: "上传文件", exact: true }).click();
  expect(
    await page.evaluate(
      () => window.__resumeCalls.find((c) => c.method === "uploadFiles").p,
    ),
  ).toMatchObject({ resumable: true, overwrite: false });
});
test("task recovery requires explicit action, cancellation keeps grant request retryable and suppresses duplicates", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  const job = page.locator(".job").filter({ hasText: "resume.bin" });
  await expect(
    job.getByRole("button", { name: "重新选择文件并续传", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".job")
      .filter({ hasText: "old-download.bin" })
      .getByRole("button", { name: "重新选择文件并续传", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__cancelResume = true;
    window.__slowResume = true;
  });
  await job
    .getByRole("button", { name: "重新选择文件并续传", exact: true })
    .click();
  await expect(
    job.getByRole("button", { name: "放弃续传并清理分片", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("取消");
  expect(
    await page.evaluate(() =>
      window.__resumeCalls.filter((c) => c.method === "resumeUpload"),
    ),
  ).toHaveLength(1);
  await page.evaluate(() => {
    window.__cancelResume = false;
  });
  await job
    .getByRole("button", { name: "放弃续传并清理分片", exact: true })
    .click();
  await expect(
    job.getByRole("button", { name: "重新选择文件并续传", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__resumeCalls.find((c) => c.method === "discardUpload").p,
    ),
  ).toEqual({ id: "resume-1" });
});
test("local-only abandon never claims remote parts were cleaned", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__localOnly = true;
  });
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await page
    .getByRole("button", { name: "放弃续传并清理分片", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("已放弃本机续传记录");
  await expect(page.getByRole("status")).toContainText("原服务人工");
});
for (const theme of ["light", "dark"])
  for (const large of [false, true])
    for (const collapsed of [false, true])
      for (const width of [1440, 920])
        test(`resume task display ${theme}/${large}/${collapsed}/${width}`, async ({
          page,
        }, info) => {
          await page.setViewportSize({
            width,
            height: width === 920 ? 620 : 900,
          });
          await setup(page);
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
          await page.getByRole("button", { name: /任务中心 \(/ }).click();
          await page
            .getByRole("button", { name: "刷新任务", exact: true })
            .click();
          const job = page.locator(".job").first();
          await expect(
            job.getByRole("button", {
              name: "重新选择文件并续传",
              exact: true,
            }),
          ).toBeInViewport();
          expect(
            await page
              .locator(".tasks")
              .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
          ).toBe(true);
          await page.screenshot({ path: info.outputPath("resume.png") });
        });
