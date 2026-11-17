import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createStore } from "../electron/store.js";
import { createService } from "../electron/service.js";

async function fixture(
  t,
  { count = 2, corrupt = false, delay = 0, denyList = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sl-delivery-"));
  const source = join(root, "source"),
    dest = join(root, "dest");
  await mkdir(source);
  await mkdir(dest);
  await mkdir(join(source, "中文"));
  await writeFile(join(source, "中文", "empty.txt"), "");
  await writeFile(join(source, "a.txt"), "abc");
  const store = createStore({ directory: join(root, "data"), vault: {} });
  const connection = store.saveConnection({
    connection: {
      name: "isolated",
      provider: "s3",
      endpoint: "http://127.0.0.1:9000",
      publicBaseUrl: "https://example.org/files",
    },
    credentialStorage: "session",
    credentials: { accessKeyId: "test", secretAccessKey: "never-export" },
  });
  let picker = source;
  const objects = new Map(
    Array.from({ length: count }, (_, i) => [
      `p/${i}.txt`,
      Buffer.from(`${i}`),
    ]),
  );
  const clientFactory = () => ({
    config: { requestChecksumCalculation: async () => "WHEN_REQUIRED" },
    destroy() {},
    async send(command, options) {
      const p = command.input;
      switch (command.constructor.name) {
        case "ListObjectsV2Command": {
          if (denyList)
            throw Object.assign(new Error("private details"), {
              name: "AccessDenied",
            });
          const all = [...objects.entries()].filter(([k]) =>
              k.startsWith(p.Prefix),
            ),
            from = Number(p.ContinuationToken || 0),
            items = all.slice(from, from + 100);
          return {
            Contents: items.map(([Key, b]) => ({
              Key,
              Size: b.length,
              ETag: '"same"',
            })),
            ...(from + 100 < all.length
              ? { NextContinuationToken: String(from + 100), IsTruncated: true }
              : {}),
          };
        }
        case "HeadObjectCommand": {
          const data = objects.get(p.Key);
          if (!data) throw Object.assign(new Error(), { name: "NotFound" });
          return { ContentLength: data.length, ETag: '"same"' };
        }
        case "GetObjectCommand": {
          if (delay)
            await pause(delay, undefined, { signal: options?.abortSignal });
          options?.abortSignal?.throwIfAborted();
          const data = objects.get(p.Key);
          return {
            ContentLength: data.length,
            ETag: '"same"',
            Body: (async function* () {
              yield corrupt ? Buffer.alloc(data.length, 88) : data;
            })(),
          };
        }
        case "PutObjectCommand": {
          const chunks = [];
          if (Buffer.isBuffer(p.Body)) chunks.push(p.Body);
          else
            for await (const chunk of p.Body) chunks.push(Buffer.from(chunk));
          objects.set(p.Key, Buffer.concat(chunks));
          return { ETag: '"same"' };
        }
        default:
          throw new Error(command.constructor.name);
      }
    },
  });
  const service = createService({
    store,
    clientFactory,
    dialog: {
      showOpenDialog: async () => ({ filePaths: [picker] }),
      showSaveDialog: async () => ({ filePath: join(root, "manifest.json") }),
    },
    app: {
      getName: () => "StorageLab",
      getVersion: () => "1.0.0",
      getPath: (name) => name === "userData" ? join(root, "data") : root,
    },
  });
  t.after(async () => {
    await service.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    dest,
    store,
    service,
    objects,
    connection,
    pick(path) {
      picker = path;
    },
  };
}
async function waitBatch(service, id) {
  for (let i = 0; i < 400; i++) {
    const row = await service.invoke("getDirectoryBatch", { id });
    if (!["running", "cancelling"].includes(row.state)) return row;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail("directory batch did not reach terminal state");
}
test("native directory upload/download verifies contents, exports no private grants, and persists all results", async (t) => {
  const f = await fixture(t);
  const base = {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "release/",
    direction: "upload",
    conflict: "overwrite",
  };
  const plan = await f.service.invoke("prepareDirectory", base);
  assert.equal(plan.entries.length, 2);
  assert.equal(JSON.stringify(plan).includes(f.root), false);
  const batch = await f.service.invoke("startDirectory", { token: plan.token });
  const done = await waitBatch(f.service, batch.id);
  assert.equal(done.state, "completed");
  assert.equal(
    done.entries.every(
      (x) => x.verification === "verified" && x.sha256?.length === 64,
    ),
    true,
  );
  await assert.rejects(
    f.service.invoke("startDirectory", { token: plan.token }),
    { code: "PLAN_EXPIRED" },
  );
  await f.service.invoke("exportDirectory", { id: done.id });
  const exported = await readFile(join(f.root, "manifest.json"), "utf8");
  assert.equal(exported.includes("never-export"), false);
  assert.equal(exported.includes(f.root), false);
  assert.equal(
    JSON.parse(exported).entries[0].url.startsWith(
      "https://example.org/files/",
    ),
    true,
  );
  f.store.saveConnection({
    connection: {
      ...f.connection,
      publicBaseUrl: "https://different.example/new",
    },
    credentialStorage: "session",
  });
  await f.service.invoke("exportDirectory", { id: done.id });
  assert.equal(
    JSON.parse(
      await readFile(join(f.root, "manifest.json"), "utf8"),
    ).entries[0].url.startsWith("https://example.org/files/"),
    true,
    "historical manifest uses the batch URL snapshot",
  );
  f.pick(f.dest);
  const download = await f.service.invoke("prepareDirectory", {
    ...base,
    direction: "download",
    conflict: "skip",
  });
  const downloaded = await waitBatch(
    f.service,
    (await f.service.invoke("startDirectory", { token: download.token })).id,
  );
  assert.equal(
    downloaded.entries.every((x) => x.verification === "verified"),
    true,
  );
  assert.equal(await readFile(join(f.dest, "a.txt"), "utf8"), "abc");
});
test("directory prepare maps provider permission errors at the native service boundary", async (t) => {
  const f = await fixture(t, { denyList: true });
  f.pick(f.dest);
  await assert.rejects(
    f.service.invoke("prepareDirectory", {
      connectionId: f.connection.id,
      bucket: "b",
      prefix: "",
      direction: "download",
      conflict: "skip",
    }),
    { code: "ACCESS_DENIED" },
  );
});
test("a batch retains every verified item after ordinary job history passes its 200-row cap", async (t) => {
  const f = await fixture(t, { count: 205 });
  f.pick(f.dest);
  const plan = await f.service.invoke("prepareDirectory", {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "p/",
    direction: "download",
    conflict: "skip",
  });
  const batch = await waitBatch(
    f.service,
    (await f.service.invoke("startDirectory", { token: plan.token })).id,
  );
  assert.equal(batch.state, "completed");
  assert.equal(batch.entries.length, 205);
  assert.equal(
    batch.entries.every((x) => x.verification === "verified"),
    true,
  );
  assert.equal(f.store.listJobs().length, 200);
});
test("upload digest mismatch is retained as failed verification even after remote commit", async (t) => {
  const f = await fixture(t, { corrupt: true });
  const plan = await f.service.invoke("prepareDirectory", {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "upload/",
    direction: "upload",
    conflict: "overwrite",
  });
  const done = await waitBatch(
    f.service,
    (await f.service.invoke("startDirectory", { token: plan.token })).id,
  );
  assert.equal(done.state, "failed");
  const bad = done.entries.find((x) => x.relativePath === "a.txt");
  assert.equal(bad.transferState, "success");
  assert.equal(bad.verification, "failed");
});
test("batch cancellation preserves finished work, cancels unstarted items and never exceeds a small queue window", async (t) => {
  const f = await fixture(t, { count: 220, delay: 20 });
  f.pick(f.dest);
  const plan = await f.service.invoke("prepareDirectory", {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "p/",
    direction: "download",
    conflict: "skip",
  });
  const batch = await f.service.invoke("startDirectory", { token: plan.token });
  assert.ok(f.store.listJobs().length <= 8);
  await f.service.invoke("cancelDirectory", { id: batch.id });
  const done = await waitBatch(f.service, batch.id);
  assert.equal(done.state, "cancelled");
  assert.equal(done.entries.length, 220);
  assert.equal(
    done.entries.every((x) => ["cancelled", "success"].includes(x.state)),
    true,
  );
});
test("batch store survives restart without losing finished entries", async (t) => {
  const f = await fixture(t);
  assert.equal(
    typeof f.store.saveDirectoryBatch,
    "function",
    "versioned batch persistence required",
  );
  f.store.saveDirectoryBatch({
    id: "test-batch",
    state: "running",
    entries: [
      { key: "k", state: "ready" },
      { key: "done", state: "success", verification: "verified" },
    ],
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(f.root, "data", "storagelab.sqlite"));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  db.close();
  const reopened = createStore({ directory: join(f.root, "data"), vault: {} });
  try {
    const batch = reopened.getDirectoryBatch("test-batch");
    assert.equal(batch.state, "interrupted");
    assert.equal(batch.entries[0].state, "interrupted");
    assert.equal(batch.entries[1].state, "success");
    assert.equal(reopened.snapshot().connections[0].id, f.connection.id);
  } finally {
    reopened.close();
  }
});
test("restart normalizes unfinished entries of an already interrupted directory batch", async (t) => {
  const f = await fixture(t);
  f.store.saveDirectoryBatch({
    id: "settled-interruption",
    state: "interrupted",
    updatedAt: "2020-01-01T00:00:00.000Z",
    entries: [{ key: "past", state: "interrupted" }],
  });
  f.store.saveDirectoryBatch({
    id: "shutdown-in-progress",
    state: "interrupted",
    entries: [
      { key: "ready", state: "ready" },
      { key: "queued", state: "queued" },
      {
        key: "committed",
        state: "running",
        transferState: "success",
        verification: "pending",
      },
      {
        key: "done",
        state: "success",
        verification: "verified",
        sha256: "a".repeat(64),
      },
    ],
  });
  const reopened = createStore({ directory: join(f.root, "data"), vault: {} });
  try {
    const batch = reopened.getDirectoryBatch("shutdown-in-progress");
    assert.equal(batch.state, "interrupted");
    assert.deepEqual(
      batch.entries.map((entry) => entry.state),
      ["interrupted", "interrupted", "interrupted", "success"],
    );
    assert.equal(batch.entries[2].transferState, "success");
    assert.equal(batch.entries[3].sha256, "a".repeat(64));
    assert.equal(
      reopened.getDirectoryBatch("settled-interruption").updatedAt,
      "2020-01-01T00:00:00.000Z",
    );
  } finally {
    reopened.close();
  }
});
test("schema2 upgrades additively and preserve connections and job file records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sl-schema2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, "storagelab.sqlite"));
  db.exec(`CREATE TABLE connections(id TEXT PRIMARY KEY, public TEXT NOT NULL);
    CREATE TABLE credentials(connection_id TEXT PRIMARY KEY REFERENCES connections(id), blob BLOB NOT NULL);
    CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE job_files(job_id TEXT PRIMARY KEY REFERENCES jobs(id),data TEXT NOT NULL);
    PRAGMA user_version=2;`);
  db.prepare("INSERT INTO connections VALUES(?,?)").run(
    "old",
    JSON.stringify({
      id: "old",
      name: "existing",
      provider: "s3",
      endpoint: "http://127.0.0.1:9000",
    }),
  );
  db.prepare("INSERT INTO jobs VALUES(?,?)").run(
    "old-job",
    JSON.stringify({ id: "old-job", state: "success" }),
  );
  db.prepare("INSERT INTO job_files VALUES(?,?)").run(
    "old-job",
    JSON.stringify({ path: "/private/test/kept" }),
  );
  db.close();
  const store = createStore({ directory: root, vault: {} });
  try {
    assert.equal(store.snapshot().connections[0].id, "old");
    assert.equal(store.listJobs()[0].id, "old-job");
    assert.deepEqual(store.listDirectoryBatches(), []);
    const upgraded = new DatabaseSync(join(root, "storagelab.sqlite"));
    try {
      assert.equal(
        upgraded.prepare("PRAGMA user_version").get().user_version,
        3,
      );
      assert.equal(
        JSON.parse(
          upgraded
            .prepare("SELECT data FROM job_files WHERE job_id=?")
            .get("old-job").data,
        ).path,
        "/private/test/kept",
      );
    } finally {
      upgraded.close();
    }
  } finally {
    store.close();
  }
});
test("active batches remain discoverable when twenty newer completed batches exist", async (t) => {
  const f = await fixture(t, { delay: 1000 });
  f.pick(f.dest);
  const plan = await f.service.invoke("prepareDirectory", {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "p/",
    direction: "download",
    conflict: "skip",
  });
  const batch = await f.service.invoke("startDirectory", { token: plan.token });
  for (let i = 0; i < 20; i++)
    f.store.saveDirectoryBatch({
      id: `newer-${i}`,
      state: "completed",
      createdAt: new Date(Date.now() + 1000 + i).toISOString(),
      entries: [],
    });
  assert.equal(
    (await f.service.invoke("listDirectoryBatches", {})).some(
      (x) => x.id === batch.id,
    ),
    true,
  );
  await f.service.invoke("cancelDirectory", { id: batch.id });
});
test("terminal persistence failure preserves actual results and warning for in-session export", async (t) => {
  const f = await fixture(t);
  f.pick(f.dest);
  const save = f.store.saveDirectoryBatch;
  let failedSave = false;
  f.store.saveDirectoryBatch = (batch) => {
    if (batch.state === "completed") {
      failedSave = true;
      throw Error("simulated disk failure");
    }
    return save(batch);
  };
  const plan = await f.service.invoke("prepareDirectory", {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "p/",
    direction: "download",
    conflict: "skip",
  });
  const batch = await f.service.invoke("startDirectory", { token: plan.token });
  for (let i = 0; i < 100 && !failedSave; i++) await pause(10);
  assert.equal(failedSave, true);
  const current = await f.service.invoke("getDirectoryBatch", { id: batch.id });
  assert.equal(current.state, "completed");
  assert.match(current.warning, /本地记录保存失败/);
  assert.equal(
    current.entries.every((x) => x.verification === "verified"),
    true,
  );
  assert.equal(
    (await f.service.invoke("listDirectoryBatches", {})).find(
      (x) => x.id === batch.id,
    ).state,
    "completed",
  );
  await f.service.invoke("exportDirectory", { id: batch.id });
  const manifest = JSON.parse(
    await readFile(join(f.root, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.state, "completed");
  assert.equal(
    manifest.entries.every((x) => x.verification === "verified"),
    true,
  );
});
test("cancel interrupts post-commit remote verification and preserves committed transfer evidence", async (t) => {
  const f = await fixture(t, { delay: 2000 });
  const plan = await f.service.invoke("prepareDirectory", {
    connectionId: f.connection.id,
    bucket: "b",
    prefix: "uploaded/",
    direction: "upload",
    conflict: "overwrite",
  });
  const batch = await f.service.invoke("startDirectory", { token: plan.token });
  for (let i = 0; i < 100 && !f.objects.has("uploaded/a.txt"); i++)
    await pause(10);
  assert.equal(f.objects.has("uploaded/a.txt"), true);
  const began = performance.now();
  await f.service.invoke("cancelDirectory", { id: batch.id });
  const stopped = await waitBatch(f.service, batch.id);
  assert.ok(
    performance.now() - began < 1000,
    "cancel must abort the verification read rather than wait for its normal completion",
  );
  assert.equal(stopped.state, "cancelled");
  const row = stopped.entries.find((x) => x.relativePath === "a.txt");
  assert.equal(row.transferState, "success");
  assert.equal(row.state, "cancelled");
  assert.notEqual(row.verification, "verified");
});
