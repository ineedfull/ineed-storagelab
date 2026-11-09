// Explicit directory-specific native acceptance. Uses only generated local data.
import assert from "node:assert/strict";
import { _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareElectronExecutable } from "./dev-electron.mjs";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const seconds = Number(option("seconds", 1200));
const idle = Number(option("idle", 180));
assert(Number.isFinite(seconds) && seconds >= 1 && seconds <= 7200);
assert(Number.isFinite(idle) && idle >= 0 && idle <= 600);
const output = resolve(option("output", "artifacts/directory-soak"));
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "storagelab-directory-soak-"));
const source = join(root, "source"),
  target = join(root, "target");
await mkdir(join(source, "资料"), { recursive: true });
await mkdir(target, { recursive: true });
const files = new Map([
  ["empty.txt", Buffer.alloc(0)],
  ["资料/中文 空格.txt", Buffer.from("目录交付 / Unicode / full SHA-256\n")],
  [
    "资料/data.bin",
    Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251)),
  ],
  ["message.txt", Buffer.from("StorageLab native directory acceptance\n")],
]);
for (const [name, bytes] of files) await writeFile(join(source, name), bytes);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const etag = (bytes) => `"${createHash("md5").update(bytes).digest("hex")}"`;
const xml = (str) =>
  str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const objects = new Map();
let fault = "none",
  heldGets = 0;
const held = new Set();
const report = {
  startedAt: new Date().toISOString(),
  seconds,
  idle,
  fixture:
    "local HTTP S3-compatible server / production AWS SDK and Electron IPC",
  cycles: 0,
  batches: 0,
  verifiedFiles: 0,
  verifiedBytes: 0,
  calls: {},
  checks: [],
  samples: [],
  errors: [],
  completed: false,
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    report.calls[req.method] = (report.calls[req.method] ?? 0) + 1;
    if (fault === "offline") {
      req.resume();
      res.writeHead(503, { "content-type": "application/xml" });
      res.end("<Error><Code>ServiceUnavailable</Code></Error>");
      return;
    }
    if (url.searchParams.has("list-type")) {
      const entries = [...objects].filter(([k]) =>
        k.startsWith(url.searchParams.get("prefix") || ""),
      );
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>known</Name><IsTruncated>false</IsTruncated>${entries.map(([k, v]) => `<Contents><Key>${xml(k)}</Key><Size>${v.length}</Size><ETag>${xml(etag(v))}</ETag></Contents>`).join("")}</ListBucketResult>`,
      );
      return;
    }
    if (req.method === "PUT") {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      const bytes = Buffer.concat(parts);
      objects.set(key, bytes);
      res.writeHead(200, { etag: etag(bytes) });
      res.end();
      return;
    }
    const bytes = objects.get(key);
    if (!bytes) {
      res.writeHead(404, { "content-type": "application/xml" });
      res.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    if (req.headers["if-match"] && req.headers["if-match"] !== etag(bytes)) {
      res.writeHead(412);
      res.end();
      return;
    }
    if (req.method === "GET" && fault === "hold") {
      heldGets++;
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    let body = bytes;
    if (req.method === "GET" && fault === "corrupt" && bytes.length) {
      body = Buffer.from(bytes);
      body[0] ^= 255;
    }
    res.writeHead(200, { "content-length": body.length, etag: etag(bytes) });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let app,
  page,
  connectionId,
  identity,
  started = Date.now();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const save = () =>
  writeFile(join(output, "result.json"), JSON.stringify(report, null, 2));
async function poll(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await fn();
    if (result) return result;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error("Native acceptance condition timed out");
}
async function invoke(method, payload = {}) {
  const result = await page.evaluate(
    ({ method, payload }) => window.storageLab.invoke(method, payload),
    { method, payload },
  );
  assert(result.ok, `${method}: ${JSON.stringify(result)}`);
  return result.value;
}
async function launch() {
  app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/directory-soak-host.mjs"],
    env: { ...process.env, STORAGELAB_DIRECTORY_SOAK_ROOT: root },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  page.on("pageerror", (e) => report.errors.push(e.message));
  identity = await app.evaluate(() => globalThis.directorySoakIdentity());
}
async function pick(path) {
  await app.evaluate((_electron, path) => {
    globalThis.directoryPickerPath = path;
  }, path);
}
const params = (direction, conflict = "overwrite") => ({
  connectionId,
  bucket: "known",
  prefix: "stress/",
  direction,
  conflict,
});
async function prepare(direction, conflict = "overwrite") {
  await pick(direction === "upload" ? source : target);
  return invoke("prepareDirectory", params(direction, conflict));
}
async function start(plan) {
  report.batches++;
  return invoke("startDirectory", { token: plan.token });
}
async function finish(batch) {
  return poll(async () => {
    const row = await invoke("getDirectoryBatch", { id: batch.id });
    return ["running", "cancelling"].includes(row.state) ? false : row;
  });
}
async function run(direction, conflict = "overwrite") {
  return finish(await start(await prepare(direction, conflict)));
}
function checkVerified(batch) {
  assert.equal(batch.state, "completed", JSON.stringify(batch));
  assert.equal(batch.entries.length, files.size);
  for (const row of batch.entries) {
    assert.equal(row.verification, "verified", JSON.stringify(row));
    assert.equal(row.sha256, digest(files.get(row.relativePath)));
    report.verifiedFiles++;
    report.verifiedBytes += row.size;
  }
}
async function sample(phase) {
  const metrics = await app.evaluate(({ app, BrowserWindow }) => ({
    pid: process.pid,
    main: process.memoryUsage(),
    processes: app
      .getAppMetrics()
      .map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu, memory: m.memory })),
    windows: BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      minimized: w.isMinimized(),
      size: w.getSize(),
    })),
  }));
  assert(
    metrics.windows.length &&
      metrics.windows.every((w) => w.visible && !w.minimized),
  );
  report.samples.push({
    phase,
    elapsedMs: Date.now() - started,
    cycles: report.cycles,
    ...metrics,
  });
  await save();
  console.log(
    JSON.stringify({
      phase,
      cycles: report.cycles,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      mainRssMiB: Math.round(metrics.main.rss / 1024 ** 2),
    }),
  );
}
try {
  await launch();
  const saved = await invoke("saveConnection", {
    connection: {
      name: "目录持续验收（隔离）",
      provider: "s3",
      endpoint: `http://127.0.0.1:${server.address().port}`,
      region: "us-east-1",
      forcePathStyle: true,
      defaultBucket: "known",
      publicBaseUrl: "https://example.org/files",
    },
    credentials: {
      accessKeyId: "generated-test",
      secretAccessKey: "generated-test-secret",
    },
    credentialStorage: "session",
  });
  connectionId = saved.id;
  report.pid = identity.pid;
  // First upload through actual desktop controls, then exercise native API repeatedly.
  await page.reload();
  await page
    .getByRole("button", { name: "目录持续验收（隔离）", exact: true })
    .click();
  await page.getByRole("button", { name: "目录交付", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "目录交付", exact: true });
  await dialog.getByLabel("目标已存在时").selectOption("overwrite");
  // The UI's current prefix is empty; use it for the complete first desktop flow.
  await dialog.getByRole("button", { name: "选择目录并预览" }).click();
  await dialog.getByRole("button", { name: "开始目录传输" }).click();
  await poll(async () => (await dialog.textContent()).includes("已核验 4"));
  await dialog.getByRole("button", { name: "导出交付清单" }).click();
  const nativeManifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  );
  checkVerified(nativeManifest);
  assert(!JSON.stringify(nativeManifest).includes(root));
  assert(!JSON.stringify(nativeManifest).includes("generated-test-secret"));
  report.checks.push("native-directory-picker-upload-export-json");
  await page.screenshot({ path: join(output, "native-upload.png") });
  started = Date.now();
  await sample("baseline");
  let nextSample = Date.now() + 30000;
  while (Date.now() - started < seconds * 1000) {
    const up = await run("upload");
    checkVerified(up);
    for (const [name, bytes] of files)
      assert.equal(digest(objects.get(`stress/${name}`)), digest(bytes));
    const down = await run("download");
    checkVerified(down);
    for (const [name, bytes] of files)
      assert.equal(digest(await readFile(join(target, name))), digest(bytes));
    if (report.cycles % 10 === 0) {
      const skipped = await run("download", "skip");
      assert.equal(skipped.state, "completed");
      assert(
        skipped.entries.every(
          (r) => r.state === "skipped" && r.verification !== "verified",
        ),
      );
      const plan = await prepare("upload");
      fault = "corrupt";
      const bad = await finish(await start(plan));
      fault = "none";
      assert.equal(bad.state, "failed");
      assert(
        bad.entries.some(
          (r) => r.verification === "failed" && r.transferState === "success",
        ),
      );
      report.checks.push("corrupt-upload-readback-rejected");
      checkVerified(await run("upload"));
    }
    if (report.cycles % 15 === 0) {
      const plan = await prepare("upload");
      heldGets = 0;
      fault = "hold";
      const batch = await start(plan);
      await poll(() => heldGets > 0);
      await invoke("cancelDirectory", { id: batch.id });
      const cancelled = await finish(batch);
      fault = "none";
      for (const res of held) res.destroy();
      held.clear();
      assert.equal(cancelled.state, "cancelled");
      assert(
        cancelled.entries.some(
          (r) => r.transferState === "success" && r.verification === "failed",
        ),
      );
      checkVerified(await run("upload"));
      report.checks.push("post-commit-verification-cancel-and-recovery");
    }
    if (report.cycles % 20 === 0) {
      const plan = await prepare("download");
      objects.set("stress/message.txt", Buffer.from("changed-after-preview"));
      const stale = await finish(await start(plan));
      assert.equal(stale.state, "failed");
      checkVerified(await run("upload"));
      report.checks.push("stale-download-preview-rejected");
      const offlinePlan = await prepare("upload");
      fault = "offline";
      const offline = await finish(await start(offlinePlan));
      fault = "none";
      assert.equal(offline.state, "failed");
      checkVerified(await run("upload"));
      report.checks.push("http-503-failure-and-recovery");
    }
    report.cycles++;
    if (report.cycles % 5 === 0) {
      await dialog.getByRole("button", { name: "刷新目录批次" }).click();
      const latest = (await invoke("listDirectoryBatches"))[0];
      await poll(() =>
        dialog
          .getByLabel("批次记录")
          .locator(`option[value="${latest.id}"]`)
          .count(),
      );
      await dialog.getByLabel("批次记录").selectOption(latest.id);
      await poll(
        async () =>
          (await dialog.getByLabel("批次记录").inputValue()) === latest.id,
      );
      assert.equal(await dialog.getByRole("alert").count(), 0);
    }
    if (Date.now() >= nextSample) {
      await sample("load");
      nextSample = Date.now() + 30000;
    }
    await delay(100);
  }
  report.loadElapsedMs = Date.now() - started;
  await sample("load-end");
  const idleStart = Date.now();
  while (Date.now() - idleStart < idle * 1000) {
    await delay(Math.min(10000, idle * 1000 - (Date.now() - idleStart)));
    await sample("idle");
  }
  report.idleElapsedMs = Date.now() - idleStart;
  assert(
    report.samples.every((s) => s.pid === report.pid),
    "Idle must use the same process",
  );
  assert((await invoke("listDirectoryBatches")).length <= 20);
  assert((await invoke("listJobs")).length <= 200);
  await page.screenshot({ path: join(output, "idle-end.png") });
  // Separate restart gate, after the measured same-process idle period.
  const plan = await prepare("upload");
  fault = "hold";
  heldGets = 0;
  const pending = await start(plan);
  await poll(() => heldGets > 0);
  await app.close();
  app = undefined;
  fault = "none";
  for (const res of held) res.destroy();
  held.clear();
  await launch();
  const interrupted = await invoke("getDirectoryBatch", { id: pending.id });
  assert.equal(interrupted.state, "interrupted");
  assert(
    interrupted.entries.every(
      (r) => !["ready", "queued", "running"].includes(r.state),
    ),
  );
  const db = new DatabaseSync(join(identity.userData, "storagelab.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    report.database = {
      batches: db.prepare("SELECT count(*) n FROM directory_batches").get().n,
      jobs: db.prepare("SELECT count(*) n FROM jobs").get().n,
      quickCheck: "ok",
    };
    assert(report.database.batches <= 20 && report.database.jobs <= 200);
  } finally {
    db.close();
  }
  report.checks.push("startup-marks-interrupted-and-sqlite-history-bounded");
  assert.deepEqual(report.errors, []);
  report.completed = true;
} catch (error) {
  report.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  fault = "none";
  for (const res of held) res.destroy();
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
  report.cleaned = true;
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      completed: report.completed,
      cycles: report.cycles,
      loadElapsedMs: report.loadElapsedMs,
      idleElapsedMs: report.idleElapsedMs,
      errors: report.errors,
    }),
  );
}
