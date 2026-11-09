import { test, expect } from "@playwright/test";
import { installFixture } from "./fixture.js";
async function open(page) {
  await installFixture(page);
  await page.addInitScript(() => {
    const invoke = window.storageLab.invoke;
    let jobs = [
      {
        id: "new",
        key: "folder/result.txt",
        direction: "download",
        state: "success",
        hasLocalFile: true,
        canRemove: true,
      },
      {
        id: "source",
        key: "source.txt",
        direction: "upload",
        state: "failed",
        hasLocalFile: true,
        canRemove: true,
      },
      {
        id: "missing",
        key: "missing.txt",
        direction: "download",
        state: "success",
        hasLocalFile: false,
        localFileState: "missing",
        canRemove: true,
      },
      {
        id: "legacy",
        key: "old.txt",
        direction: "download",
        state: "success",
        canRemove: true,
      },
      {
        id: "running",
        key: "active.txt",
        direction: "upload",
        state: "running",
        hasLocalFile: true,
        canRemove: false,
      },
      {
        id: "resume",
        key: "resume.txt",
        direction: "upload",
        state: "cancelled",
        resumable: true,
        resumeAvailable: true,
        canRemove: false,
      },
    ].map((j) => ({
      connectionName: "隔离存储",
      bucket: "demo",
      bytesTransferred: 123,
      totalBytes: 123,
      updatedAt: 0,
      ...j,
    }));
    window.__taskCalls = [];
    window.__taskCancelled = true;
    window.storageLab.invoke = async (method, payload) => {
      if (["openJobFile", "revealJobFile", "removeJob"].includes(method)) {
        window.__taskCalls.push({ method, payload });
        if (window.__taskFailure)
          return {
            ok: false,
            error: {
              code: "LOCAL_FILE_CHANGED",
              message: "本地文件已变化，任务记录保留。",
            },
          };
        if (method === "removeJob") {
          if (window.__taskCancelled)
            return { ok: true, value: { cancelled: true } };
          jobs = jobs.filter((j) => j.id !== payload.id);
          return {
            ok: true,
            value: { removed: true, localFileTrashed: false },
          };
        }
        return { ok: true, value: true };
      }
      const r = await invoke(method, payload);
      if (method === "bootstrap") r.value.jobs = jobs;
      if (method === "listJobs") r.value = jobs;
      return r;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
}
test("task local actions use IDs; cancel and failure retain task, record-only removal refreshes", async ({
  page,
}) => {
  await open(page);
  const card = page.locator(".job").filter({ hasText: "result.txt" });
  await card.getByRole("button", { name: "打开本地文件", exact: true }).click();
  await card.getByRole("button", { name: "打开所在目录", exact: true }).click();
  await card.getByRole("button", { name: "删除任务记录", exact: true }).click();
  await expect(card).toHaveCount(1);
  expect(await page.evaluate(() => window.__taskCalls)).toEqual([
    { method: "openJobFile", payload: { id: "new" } },
    { method: "revealJobFile", payload: { id: "new" } },
    { method: "removeJob", payload: { id: "new" } },
  ]);
  await page.evaluate(() => {
    window.__taskCancelled = false;
    window.__taskFailure = true;
  });
  await card.getByRole("button", { name: "删除任务记录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("本地文件已变化");
  await expect(card).toHaveCount(1);
  await page.evaluate(() => {
    window.__taskFailure = false;
  });
  await card.getByRole("button", { name: "删除任务记录", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("本地文件已保留");
});
test("legacy, active and resumable cards expose only supported operations", async ({
  page,
}) => {
  await open(page);
  const legacy = page.locator(".job").filter({ hasText: "old.txt" });
  await expect(
    legacy.getByRole("button", { name: "打开本地文件", exact: true }),
  ).toHaveCount(0);
  await expect(
    legacy.getByRole("button", { name: "删除任务记录", exact: true }),
  ).toBeEnabled();
  const active = page.locator(".job").filter({ hasText: "active.txt" });
  await expect(
    active.getByRole("button", { name: "删除任务记录", exact: true }),
  ).toHaveCount(0);
  await expect(
    active.getByRole("button", { name: "打开本地文件", exact: true }),
  ).toHaveCount(0);
  const resume = page.locator(".job").filter({ hasText: "resume.txt" });
  await expect(
    resume.getByRole("button", { name: "删除任务记录", exact: true }),
  ).toBeDisabled();
  await expect(
    resume.getByRole("button", { name: "放弃续传并清理分片", exact: true }),
  ).toBeEnabled();
});
for (const theme of ["light", "dark"])
  for (const largeText of [false, true])
    for (const sidebarCollapsed of [false, true])
      for (const width of [1440, 920])
        test(`task actions layout ${theme}/${largeText}/${sidebarCollapsed}/${width}`, async ({
          page,
        }) => {
          await page.setViewportSize({
            width,
            height: width === 1440 ? 900 : 620,
          });
          await open(page);
          await page.evaluate(
            ({ theme, largeText, sidebarCollapsed }) => {
              document.documentElement.dataset.theme = theme;
              document.documentElement.dataset.large = String(largeText);
            },
            { theme, largeText, sidebarCollapsed },
          );
          if (sidebarCollapsed)
            await page
              .getByRole("button", { name: "折叠侧栏", exact: true })
              .click();
          const card = page.locator(".job").first();
          const bounds = await card.boundingBox();
          for (const b of await card.getByRole("button").all()) {
            const box = await b.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(bounds.x);
            expect(box.x + box.width).toBeLessThanOrEqual(
              bounds.x + bounds.width,
            );
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        });

test("a download whose recorded file is missing disables local open actions and explains its state", async ({
  page,
}) => {
  await open(page);
  const card = page.locator(".job").filter({ hasText: "missing.txt" });
  await expect(card).toContainText("本地文件已不存在");
  await expect(
    card.getByRole("button", { name: "打开本地文件", exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "打开所在目录", exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "删除任务记录", exact: true }),
  ).toBeEnabled();
});
