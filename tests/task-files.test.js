import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../electron/store.js";
import { createQueue } from "../electron/transfers/queue.js";
import { createTaskActions, captureLocalFile } from "../electron/task-files.js";
import { validatePayload } from "../electron/ipc.js";
const flush = () => new Promise((r) => setImmediate(r));
async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "storage-task-files-")),
  );
  let store = createStore({ directory, vault: {} });
  const queue = createQueue({ store });
  const file = join(directory, "sample.txt");
  await writeFile(file, "sample");
  let answer = { response: 0, checkboxChecked: false };
  let protectedJob = false;
  const calls = [];
  const shell = {
    async openPath(path) {
      calls.push(["open", path]);
      return "";
    },
    showItemInFolder(path) {
      calls.push(["reveal", path]);
    },
    async trashItem(path) {
      calls.push(["trash", path]);
      await rename(path, path + ".trashed");
    },
  };
  const dialog = {
    async showMessageBox(options) {
      calls.push(["confirm", options]);
      return answer;
    },
  };
  const actions = createTaskActions({
    store,
    queue,
    shell,
    dialog,
    assertRemovable: async () => {
      if (protectedJob)
        throw Object.assign(new Error("先放弃续传"), {
          code: "RESUME_PROTECTED",
        });
    },
  });
  const job = queue.add(
    { connectionId: "c1", direction: "download", key: "sample.txt" },
    async () => ({}),
    { localFile: await captureLocalFile(file, "download") },
  );
  await flush();
  t.after(async () => {
    await queue.dispose();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    queue,
    file,
    job,
    actions,
    calls,
    shell,
    answer: (value) => {
      answer = value;
    },
    protect: () => {
      protectedJob = true;
    },
    reopen: () => {
      store.close();
      store = createStore({ directory, vault: {} });
      return store;
    },
  };
}
test("private file reference survives restart, never enters public job, and cascades with deletion", async (t) => {
  const f = await fixture(t);
  assert.equal(JSON.stringify(f.store.snapshot()).includes(f.file), false);
  assert.equal(f.store.getJobFile(f.job.id).path, f.file);
  const s = f.reopen();
  assert.equal(s.getJobFile(f.job.id).path, f.file);
  s.removeJob(f.job.id);
  assert.equal(s.getJobFile(f.job.id), undefined);
});
test("open and reveal use only native task binding; default removal keeps file and does not resurrect", async (t) => {
  const f = await fixture(t);
  await f.actions.open(f.job.id);
  await f.actions.reveal(f.job.id);
  assert.deepEqual(f.calls.slice(0, 2), [
    ["open", f.file],
    ["reveal", f.file],
  ]);
  await f.actions.remove(f.job.id);
  assert.equal(await readFile(f.file, "utf8"), "sample");
  assert.equal(f.queue.list().length, 0);
  assert.throws(() => f.queue.retry(f.job.id), { code: "RESELECT_REQUIRED" });
  assert.equal(
    f.calls.find(([c]) => c === "confirm")[1].checkboxChecked,
    false,
  );
});
test("explicit local removal trashes downloaded file; cancelled confirmation preserves both", async (t) => {
  const f = await fixture(t);
  f.answer({ response: 1, checkboxChecked: true });
  assert.equal((await f.actions.remove(f.job.id)).cancelled, true);
  assert.equal(f.queue.list().length, 1);
  f.answer({ response: 0, checkboxChecked: true });
  assert.equal((await f.actions.remove(f.job.id)).localFileTrashed, true);
  assert.equal(await readFile(f.file + ".trashed", "utf8"), "sample");
  assert.equal(f.queue.list().length, 0);
});
test("recorded location opens a regular replacement, while missing/unsafe locations only remove history", async (t) => {
  for (const kind of ["missing", "replaced", "symlink"]) {
    const f = await fixture(t);
    await rename(f.file, f.file + ".old");
    if (kind === "replaced") await writeFile(f.file, "replacement");
    if (kind === "symlink") await symlink(f.file + ".old", f.file);
    if (kind === "replaced") await f.actions.open(f.job.id);
    else
      await assert.rejects(f.actions.open(f.job.id), {
        code: kind === "missing" ? "LOCAL_FILE_MISSING" : "LOCAL_FILE_CHANGED",
      });
    f.answer({ response: 0, checkboxChecked: true });
    if (kind === "replaced") {
      await assert.rejects(f.actions.remove(f.job.id), {
        code: "LOCAL_FILE_CHANGED",
      });
      assert.equal(f.queue.list().length, 1);
      f.answer({ response: 0, checkboxChecked: false });
    }
    await f.actions.remove(f.job.id);
    assert.equal(
      f.calls.some(([c]) => c === "trash"),
      false,
    );
    assert.equal(f.queue.list().length, 0);
  }
});
test("active jobs, live transfers and resumable records are guarded; failed trash retains history", async (t) => {
  const f = await fixture(t);
  const pending = f.queue.add(
    { connectionId: "c1", key: "pending", direction: "download" },
    async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  );
  await flush();
  await assert.rejects(f.actions.remove(pending.id), { code: "JOB_BUSY" });
  f.answer({ response: 0, checkboxChecked: true });
  await assert.rejects(f.actions.remove(f.job.id), { code: "LOCAL_FILE_BUSY" });
  f.queue.cancel(pending.id);
  await flush();
  f.shell.trashItem = async () => {
    throw new Error("private path");
  };
  await assert.rejects(f.actions.remove(f.job.id), {
    code: "LOCAL_TRASH_FAILED",
  });
  assert.equal(
    f.queue.list().some((j) => j.id === f.job.id),
    true,
  );
  f.protect();
  await assert.rejects(f.actions.remove(f.job.id), {
    code: "RESUME_PROTECTED",
  });
});
test("legacy jobs remove records only; renderer cannot supply paths or options", async (t) => {
  const f = await fixture(t);
  f.store.saveJob({ id: "legacy", state: "interrupted" });
  await assert.rejects(f.actions.open("legacy"), {
    code: "LOCAL_FILE_UNAVAILABLE",
  });
  await f.actions.remove("legacy");
  assert.equal(
    f.store.listJobs().some((j) => j.id === "legacy"),
    false,
  );
  for (const method of ["openJobFile", "revealJobFile", "removeJob"])
    for (const payload of [
      { id: f.job.id, path: f.file },
      { id: f.job.id, deleteLocalFile: true },
      { id: "" },
    ])
      assert.throws(() => validatePayload(method, payload));
});

test("service associates completed downloads and uploads without exposing paths, and removes via task ID", async (t) => {
  const { createService } = await import("../electron/service.js");
  const { Readable } = await import("node:stream");
  const f = await fixture(t);
  const c = f.store.saveConnection({
    connection: {
      name: "local",
      provider: "minio",
      endpoint: "http://127.0.0.1:1",
    },
    credentialStorage: "session",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  let upload = false;
  const service = createService({
    store: f.store,
    dialog: {
      showOpenDialog: async () => ({
        filePaths: [upload ? f.file : f.directory],
      }),
      showMessageBox: async () => ({ response: 0 }),
    },
    shell: f.shell,
    app: { getPath: () => f.directory },
    clientFactory: () => ({
      send: async (command) => {
        if (command.constructor.name === "GetObjectCommand")
          return { Body: Readable.from(["downloaded"]), ContentLength: 10 };
        return {};
      },
      destroy() {},
    }),
  });
  t.after(() => service.dispose());
  const {
    jobs: [download],
  } = await service.invoke("downloadFiles", {
    connectionId: c.id,
    bucket: "test",
    keys: ["result.txt"],
  });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (
      (await service.invoke("listJobs")).find((j) => j.id === download.id)
        ?.state === "success"
    )
      break;
  }
  let rows = await service.invoke("listJobs");
  assert.equal(rows.find((j) => j.id === download.id).hasLocalFile, true);
  assert.equal(
    f.store.getJobFile(download.id).path,
    join(f.directory, "result.txt"),
  );
  assert.equal(JSON.stringify(rows).includes(f.directory), false);
  await service.invoke("revealJobFile", { id: download.id });
  upload = true;
  const {
    jobs: [source],
  } = await service.invoke("uploadFiles", {
    connectionId: c.id,
    bucket: "test",
    overwrite: true,
  });
  assert.equal(f.store.getJobFile(source.id).kind, "upload");
  await service.dispose();
});

test("schema1 upgrade retains jobs, private bindings stay bounded with history", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(join(tmpdir(), "storage-task-schema-"));
  const path = join(directory, "storagelab.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1;",
  );
  db.prepare("INSERT INTO jobs VALUES (?,?)").run(
    "legacy",
    JSON.stringify({ id: "legacy", state: "success", key: "原始/../ Key" }),
  );
  db.close();
  const store = createStore({ directory, vault: {} });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(store.listJobs()[0].key, "原始/../ Key");
  assert.equal(store.getJobFile("legacy"), undefined);
  store.saveJobFile("legacy", { path: "/native-only", kind: "download" });
  for (let i = 0; i < 201; i++)
    store.saveJob({ id: `history${i}`, state: "success" });
  assert.equal(store.getJobFile("legacy"), undefined);
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(
    inspect.prepare("SELECT COUNT(*) AS n FROM job_files").get().n,
    0,
  );
  inspect.close();
});

test("retry has its own file reference and job ID, removal confirmation excludes duplicate retry", async (t) => {
  const f = await fixture(t);
  const ids = [];
  const source = f.queue.add(
    { connectionId: "c1", direction: "upload" },
    async ({ jobId }) => {
      ids.push(jobId);
      throw new Error("offline");
    },
    { localFile: await captureLocalFile(f.file, "upload") },
  );
  await flush();
  const retry = f.queue.retry(source.id);
  await flush();
  assert.notEqual(retry.id, source.id);
  assert.deepEqual(ids, [source.id, retry.id]);
  assert.equal(f.store.getJobFile(retry.id).path, f.file);
  const release = f.queue.reserveRemoval(source.id);
  assert.throws(() => f.queue.retry(source.id), { code: "JOB_BUSY" });
  assert.throws(() => f.queue.reserveRemoval(source.id), { code: "JOB_BUSY" });
  release();
  const releaseFiles = f.queue.reserveFileRemoval();
  assert.throws(() => f.queue.retry(source.id), { code: "LOCAL_FILE_BUSY" });
  releaseFiles();
});

test("open failures and partial record deletion errors are visible and never claim both succeeded", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  f.shell.openPath = async () => "OS error containing private details";
  await assert.rejects(f.actions.open(f.job.id), { code: "LOCAL_OPEN_FAILED" });
  const db = new DatabaseSync(join(f.directory, "storagelab.sqlite"));
  db.exec(
    "CREATE TRIGGER reject_job_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'private SQL'); END;",
  );
  f.answer({ response: 0, checkboxChecked: true });
  await assert.rejects(f.actions.remove(f.job.id), {
    code: "LOCAL_RECORD_DELETE_FAILED",
  });
  assert.equal(await readFile(f.file + ".trashed", "utf8"), "sample");
  assert.equal(f.queue.list().length, 1);
  db.exec("DROP TRIGGER reject_job_delete;");
  db.close();
  f.answer({ response: 0, checkboxChecked: false });
  await f.actions.remove(f.job.id);
  assert.equal(f.queue.list().length, 0);
});

test("download viewing reference must match the installed file, never a later same-name replacement", async (t) => {
  const { downloadObject } = await import("../electron/transfers/download.js");
  const { Readable } = await import("node:stream");
  const f = await fixture(t);
  let committed = false;
  await assert.rejects(
    downloadObject({
      client: {
        send: async () => ({
          Body: Readable.from(["result"]),
          ContentLength: 6,
        }),
      },
      bucket: "test",
      key: "installed.txt",
      directory: f.directory,
      signal: new AbortController().signal,
      onProgress() {},
      committed() {
        committed = true;
      },
      onLocalFile: async (path, identity) => {
        await rename(path, path + ".original");
        await writeFile(path, "result");
        await captureLocalFile(path, "download", identity);
      },
    }),
    { code: "LOCAL_FILE_CHANGED" },
  );
  assert.equal(committed, true);
  assert.equal(
    await readFile(join(f.directory, "installed.txt.original"), "utf8"),
    "result",
  );
});

test("file binding and task creation roll back together on SQLite failure", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.directory, "storagelab.sqlite"));
  db.exec(
    "CREATE TRIGGER reject_file_binding BEFORE INSERT ON job_files BEGIN SELECT RAISE(ABORT, 'private failure'); END;",
  );
  const ref = await captureLocalFile(f.file, "upload");
  assert.throws(
    () =>
      f.queue.add(
        { connectionId: "c1", direction: "upload", key: "rejected.txt" },
        async () => {},
        { localFile: ref },
      ),
    { code: "PERSISTENCE_ERROR" },
  );
  assert.equal(f.store.listJobs().length, 1);
  assert.equal(f.queue.list().length, 1);
  db.close();
});

test("opening a downloaded file uses its recorded location after local edits; removal still protects changed content", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "edited after download");
  await f.actions.open(f.job.id);
  await f.actions.reveal(f.job.id);
  assert.deepEqual(f.calls.slice(0, 2), [
    ["open", f.file],
    ["reveal", f.file],
  ]);
  f.answer({ response: 0, checkboxChecked: true });
  await assert.rejects(f.actions.remove(f.job.id), {
    code: "LOCAL_FILE_CHANGED",
  });
  assert.equal(await readFile(f.file, "utf8"), "edited after download");
});

test("download saves nested final location automatically, restart checks actual presence rather than the binding", async (t) => {
  const { createService } = await import("../electron/service.js");
  const { Readable } = await import("node:stream");
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "storage-download-presence-")),
  );
  const data = join(directory, "data");
  let store = createStore({ directory: data, vault: {} });
  const connection = store.saveConnection({
    connection: {
      name: "isolated",
      provider: "minio",
      endpoint: "http://127.0.0.1:1",
    },
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    credentialStorage: "session",
  });
  const nativeCalls = [];
  let confirmation;
  const makeService = () =>
    createService({
      store,
      app: { getPath: () => data },
      dialog: {
        showOpenDialog: async () => ({ filePaths: [directory] }),
        showMessageBox: async (options) => {
          confirmation = options;
          return { response: 0, checkboxChecked: true };
        },
      },
      shell: {
        openPath: async (path) => {
          nativeCalls.push(path);
          return "";
        },
        trashItem: async () => {
          throw new Error("must not trash a missing file");
        },
      },
      clientFactory: () => ({
        destroy() {},
        send: async () => ({
          Body: Readable.from(["content"]),
          ContentLength: 7,
          VersionId: "version-1",
        }),
      }),
    });
  let service = makeService();
  t.after(async () => {
    await service.dispose();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const jobs = [];
  for (const payload of [
    { keys: ["nested/normal.txt"] },
    { key: "nested/version.txt", versionId: "version-1" },
  ]) {
    const method = payload.versionId
      ? "downloadObjectVersion"
      : "downloadFiles";
    const result = await service.invoke(method, {
      connectionId: connection.id,
      bucket: "test",
      ...payload,
    });
    jobs.push(result.jobs[0]);
  }
  for (let i = 0; i < 100; i++) {
    if (
      (await service.invoke("listJobs")).filter((j) => j.state === "success")
        .length === 2
    )
      break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const target = join(directory, "nested", "normal.txt");
  assert.equal(store.getJobFile(jobs[0].id).path, target);
  assert.equal(
    store.getJobFile(jobs[1].id).path,
    join(directory, "nested", "version.txt"),
  );
  await service.dispose();
  store.close();
  store = createStore({ directory: data, vault: {} });
  service = makeService();
  let row = (await service.invoke("listJobs")).find((j) => j.id === jobs[0].id);
  assert.equal(row.localFileState, "available");
  assert.equal(row.hasLocalFile, true);
  await service.invoke("openJobFile", { id: jobs[0].id });
  assert.deepEqual(nativeCalls, [target]);
  await rm(target);
  row = (await service.invoke("listJobs")).find((j) => j.id === jobs[0].id);
  assert.equal(row.hasLocalFile, false);
  assert.equal(row.localFileState, "missing");
  assert.equal(store.getJobFile(jobs[0].id).path, target);
  await assert.rejects(service.invoke("openJobFile", { id: jobs[0].id }), {
    code: "LOCAL_FILE_MISSING",
  });
  const removed = await service.invoke("removeJob", { id: jobs[0].id });
  assert.equal(removed.localFileMissing, true);
  assert.equal(confirmation.checkboxLabel, undefined);
  assert.equal(
    (await service.invoke("listJobs")).some((j) => j.id === jobs[0].id),
    false,
  );
});
