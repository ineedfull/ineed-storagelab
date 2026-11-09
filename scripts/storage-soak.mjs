// Explicit, isolated desktop load gate. Never part of routine unit/native tests.
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareElectronExecutable } from "./dev-electron.mjs";
if (
  !process.env.STORAGELAB_TEST_CONFIG &&
  !process.env.STORAGELAB_TEST_ENDPOINT
)
  throw new Error("Explicit private loopback test config required");
const seconds = Number(
  process.argv.find((a) => a.startsWith("--seconds="))?.split("=")[1] ?? 1200,
);
const idleSeconds = Number(
  process.argv.find((a) => a.startsWith("--idle="))?.split("=")[1] ?? 60,
);
if (
  !Number.isFinite(seconds) ||
  seconds < 1 ||
  seconds > 7200 ||
  !Number.isFinite(idleSeconds) ||
  idleSeconds < 0 ||
  idleSeconds > 600
)
  throw new Error("Invalid bounded test duration");
const output = resolve("artifacts/object-management-soak");
await mkdir(output, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  requestedLoadSeconds: seconds,
  requestedIdleSeconds: idleSeconds,
  cycles: 0,
  recoveries: 0,
  verifiedBytes: 0,
  samples: [],
  errors: [],
  completed: false,
};
const save = () =>
  writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
const app = await electron.launch({
  executablePath: await prepareElectronExecutable(),
  args: ["tests/native/host.mjs"],
  env: { ...process.env },
});
let nextSample = 0;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => report.errors.push(e.message));
  const expected = await app.evaluate(() => globalThis.prepareResumableFile());
  const p = await app.evaluate(() => ({
    connectionId: globalThis.fixture.profile.id,
    bucket: globalThis.fixture.bucket,
  }));
  const invoke = async (method, payload = {}) => {
    const r = await page.evaluate(
      ({ method, payload }) => window.storageLab.invoke(method, payload),
      { method, payload },
    );
    if (!r.ok)
      throw new Error(`${method}: ${r.error.code}: ${r.error.message}`);
    return r.value;
  };
  async function waitJobs(ids) {
    let jobs;
    await expect
      .poll(
        async () => {
          jobs = (await invoke("listJobs")).filter((j) => ids.includes(j.id));
          return (
            jobs.length === ids.length &&
            jobs.every(
              (j) => !["queued", "running", "cancelling"].includes(j.state),
            )
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    return jobs;
  }
  async function verify(key, local = false) {
    const actual = await app.evaluate(
      (_, { key, local }) =>
        local
          ? globalThis.readLocalDigest(key)
          : globalThis.readObjectDigest(key),
      { key, local },
    );
    expect(actual).toEqual(expected);
    report.verifiedBytes += actual.size;
  }
  async function sample(phase) {
    const metrics = await app.evaluate(async ({ app, BrowserWindow }) => ({
      main: process.memoryUsage(),
      processes: app
        .getAppMetrics()
        .map((m) => ({ pid: m.pid, type: m.type, memory: m.memory })),
      window: BrowserWindow.getAllWindows().map((w) => ({
        visible: w.isVisible(),
        minimized: w.isMinimized(),
        size: w.getSize(),
      })),
    }));
    report.samples.push({
      elapsedMs: Date.now() - start,
      phase,
      cycles: report.cycles,
      ...metrics,
    });
    await save();
    console.log(
      JSON.stringify({
        phase,
        cycles: report.cycles,
        elapsedSeconds: Math.round((Date.now() - start) / 1000),
        recoveries: report.recoveries,
        mainRssMiB: Math.round(metrics.main.rss / 1024 ** 2),
      }),
    );
  }
  await page
    .getByRole("button", { name: "Isolated MinIO", exact: true })
    .click();
  await page.getByRole("button", { name: /任务中心 \(/ }).click();
  const start = Date.now();
  await sample("baseline");
  while (Date.now() - start < seconds * 1000) {
    const interrupted = report.cycles % 10 === 9;
    if (interrupted) await app.evaluate(() => globalThis.armResumePart());
    let jobs = (
      await invoke("uploadFiles", {
        ...p,
        prefix: "stress/",
        overwrite: true,
        resumable: report.cycles % 2 === 0 || interrupted,
      })
    ).jobs;
    if (interrupted) {
      await expect
        .poll(() => app.evaluate(() => globalThis.resumePartPaused === true), {
          timeout: 30000,
        })
        .toBe(true);
      await invoke("cancelJob", { id: jobs[0].id });
      await waitJobs(jobs.map((j) => j.id));
      await app.evaluate(() => {
        globalThis.releaseResumePart();
        globalThis.pickResumableFile();
      });
      jobs = (await invoke("resumeUpload", { id: jobs[0].id })).jobs;
      report.recoveries++;
    }
    const completed = await waitJobs(jobs.map((j) => j.id));
    expect(
      completed.every((j) => j.state === "success"),
      JSON.stringify(completed),
    ).toBe(true);
    await verify("stress/resume.bin");
    const ctx = { ...p, key: "stress/resume.bin" };
    let original = await invoke("prepareObjectMutation", ctx);
    await invoke("executeObjectMutation", {
      ...ctx,
      original,
      kind: "copy",
      targetKey: "stress/copy.bin",
      overwrite: true,
    });
    await verify("stress/copy.bin");
    await invoke("executeObjectMutation", {
      ...ctx,
      original,
      kind: "metadata",
      contentType: "application/octet-stream",
      cacheControl: "no-cache",
      metadata: { cycle: String(report.cycles) },
    });
    original = await invoke("prepareObjectMutation", ctx);
    const rename = await invoke("executeObjectMutation", {
      ...ctx,
      original,
      kind: "rename",
      targetKey: "stress/renamed.bin",
      overwrite: true,
    });
    expect(rename.sourceRetained).toBe(true);
    await verify("stress/resume.bin");
    await verify("stress/renamed.bin");
    const downloaded = (
      await invoke("downloadFiles", {
        ...p,
        keys: ["stress/copy.bin"],
        overwrite: true,
      })
    ).jobs;
    expect(
      (await waitJobs(downloaded.map((j) => j.id))).every(
        (j) => j.state === "success",
      ),
    ).toBe(true);
    await verify("stress/copy.bin", true);
    // Native boundary must reject malformed mutation input without changing source.
    const invalid = await page.evaluate(
      ({ ctx, original }) =>
        window.storageLab.invoke("executeObjectMutation", {
          ...ctx,
          original,
          kind: "copy",
          targetKey: ctx.key,
          overwrite: true,
        }),
      { ctx, original },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe("INVALID_INPUT");
    report.cycles++;
    if (Date.now() >= nextSample) {
      nextSample = Date.now() + 30000;
      await sample("load");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  report.loadElapsedMs = Date.now() - start;
  await sample("load-end");
  await page.screenshot({ path: join(output, "load-end.png") });
  const idleStart = Date.now();
  while (Date.now() - idleStart < idleSeconds * 1000) {
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(10000, idleSeconds * 1000 - (Date.now() - idleStart)),
      ),
    );
    await sample("idle");
  }
  report.idleElapsedMs = Date.now() - idleStart;
  expect(report.errors).toEqual([]);
  report.completed = true;
  await page.screenshot({ path: join(output, "idle-end.png") });
} catch (e) {
  report.errors.push(e.stack ?? String(e));
  process.exitCode = 1;
} finally {
  await app.close();
  report.finishedAt = new Date().toISOString();
  report.fixtureClosed = true;
  await save();
  console.log(
    JSON.stringify({
      completed: report.completed,
      cycles: report.cycles,
      recoveries: report.recoveries,
      loadElapsedMs: report.loadElapsedMs,
      errors: report.errors,
    }),
  );
}
