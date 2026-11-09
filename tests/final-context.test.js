import test from "node:test";
import assert from "node:assert/strict";
import { createWorkbench } from "../src/composables/useWorkbench.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../electron/service.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("bucket draft cannot retarget visible object download/share/delete; opening clears rows and stale details", async () => {
  const calls = [],
    head = deferred(),
    preview = deferred(),
    list = deferred();
  const m = createWorkbench({
    invoke: async (method, p) => {
      calls.push({ method, p });
      if (method === "headObject") return head.promise;
      if (method === "previewObject") return preview.promise;
      if (method === "listObjects")
        return p.bucket === "a"
          ? { objects: [{ key: "same.txt" }], prefixes: ["raw/"] }
          : list.promise;
      return { jobs: [] };
    },
    onChange: () => () => {},
  });
  m.connectionId.value = "c";
  m.bucket.value = "a";
  await m.browse();
  m.selected.value = ["same.txt"];
  const h = m.focus({ key: "same.txt" }),
    v = m.loadPreview();
  assert.ok(m.bucketDraft, "editable bucket draft is independent");
  m.bucketDraft.value = "b";
  await m.transfer("downloadFiles", false);
  for (const method of ["shareObject", "deleteObjects"])
    await m.action(method, {
      ...m.payload(),
      key: "same.txt",
      keys: [...m.selected.value],
    });
  assert.deepEqual(
    calls
      .filter((c) =>
        ["downloadFiles", "shareObject", "deleteObjects"].includes(c.method),
      )
      .map((c) => c.p.bucket),
    ["a", "a", "a"],
  );
  const opening = m.openBucket("b");
  assert.deepEqual(m.objects.value, []);
  assert.deepEqual(m.selected.value, []);
  assert.deepEqual(m.prefixes.value, []);
  head.resolve({ key: "same.txt" });
  preview.resolve({ content: "obsolete" });
  await Promise.all([h, v]);
  assert.equal(m.detail.value, null);
  assert.equal(m.preview.value, null);
  list.resolve({ objects: [{ key: "b.txt" }], prefixes: [] });
  await opening;
  assert.deepEqual(m.objects.value, [{ key: "b.txt" }]);
});
test("enumeration permission error is contextual, retires on known bucket success, preserves other errors", async () => {
  const m = createWorkbench({
    invoke: async (method) => {
      if (method === "listBuckets")
        throw Object.assign(new Error("denied"), { code: "ACCESS_DENIED" });
      return { objects: [], prefixes: [] };
    },
    onChange: () => () => {},
  });
  m.connections.value = [{ id: "c", defaultBucket: "" }];
  await m.selectConnection("c");
  assert.match(m.error.value, /列桶权限/);
  m.bucket.value = "known";
  await m.browse();
  assert.equal(m.error.value, "");
  m.error.value = "unresolved deletion";
  await m.browse();
  assert.equal(m.error.value, "unresolved deletion");
  await m.selectConnection("c");
  assert.equal(m.error.value, "unresolved deletion");
  m.error.value = "";
  await m.selectConnection("c");
  assert.match(m.error.value, /列桶权限/);
  await m.selectConnection("");
  assert.equal(m.error.value, "");
});
for (const direction of ["upload", "download"])
  for (const mutation of [
    "edit",
    "remove",
    "failed-edit",
    "failed-remove",
    "unchanged",
  ])
    test(`terminal ${direction} retry grants: ${mutation}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "storagelab-retry-"));
      if (direction === "upload")
        await writeFile(join(directory, "same.txt"), "test");
      let conn = { id: "c", name: "c", endpoint: "http://old.invalid" },
        credentials = { accessKeyId: "old", secretAccessKey: "old-secret" };
      const rows = new Map(),
        attempts = [];
      const store = {
        snapshot: () => ({ settings: { concurrency: 1 } }),
        getConnection: () => conn,
        getCredentials: () => credentials,
        lockConnection: () => () => {},
        saveJob: (j) => rows.set(j.id, { ...j }),
        listJobs: () => [...rows.values()],
        saveConnection: (p) => {
          if (mutation === "failed-edit") throw new Error("save failed");
          conn = { ...conn, ...p.connection };
          credentials = p.credentials;
          return conn;
        },
        removeConnection: () => {
          if (mutation === "failed-remove") throw new Error("remove failed");
          conn = undefined;
          return true;
        },
      };
      const service = createService({
        store,
        dialog: {
          showOpenDialog: async () => ({
            filePaths: [
              direction === "upload" ? join(directory, "same.txt") : directory,
            ],
            canceled: false,
          }),
        },
        app: {},
        clientFactory: (c, creds) => ({
          destroy() {},
          send: async () => {
            attempts.push({
              endpoint: c.endpoint,
              accessKeyId: creds.accessKeyId,
            });
            throw new Error("offline");
          },
        }),
      });
      try {
        const {
          jobs: [job],
        } = await service.invoke(
          direction === "upload" ? "uploadFiles" : "downloadFiles",
          {
            connectionId: "c",
            bucket: "bucket",
            keys: ["same.txt"],
            overwrite: false,
          },
        );
        const terminal = async (id) => {
          for (let i = 0; i < 100; i++) {
            const jobs = await service.invoke("listJobs");
            if (jobs.find((j) => j.id === id)?.state === "failed") {
              await new Promise((r) => setImmediate(r));
              return;
            }
            await new Promise((r) => setImmediate(r));
          }
          assert.fail("job did not terminate");
        };
        await terminal(job.id);
        if (mutation.includes("edit")) {
          const save = service.invoke("saveConnection", {
            connection: {
              id: "c",
              name: "c",
              provider: "s3",
              endpoint: "http://new.invalid",
              region: "us-east-1",
              forcePathStyle: true,
              defaultBucket: "",
              readOnly: false,
              publicBaseUrl: "",
            },
            credentials: { accessKeyId: "new", secretAccessKey: "new-secret" },
            credentialStorage: "session",
          });
          if (mutation.startsWith("failed")) await assert.rejects(save);
          else await save;
        }
        if (mutation.includes("remove")) {
          const remove = service.invoke("removeConnection", { id: "c" });
          if (mutation.startsWith("failed")) await assert.rejects(remove);
          else await remove;
        }
        if (["edit", "remove"].includes(mutation)) {
          await assert.rejects(service.invoke("retryJob", { id: job.id }), {
            code: "RESELECT_REQUIRED",
          });
          assert.equal(attempts.length, 1);
          assert.equal((await service.invoke("listJobs")).length, 1);
        } else {
          const retry = await service.invoke("retryJob", { id: job.id });
          await terminal(retry.id);
          assert.equal(attempts.length, 2);
        }
        assert.ok(
          attempts.every(
            (a) =>
              a.endpoint === "http://old.invalid" && a.accessKeyId === "old",
          ),
        );
      } finally {
        await service.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    });

test("delayed sidebar bucket response cannot replace current rows or cursor", async () => {
  const old = deferred();
  const m = createWorkbench({
    invoke: async (method, p) =>
      p.bucket === "old"
        ? old.promise
        : { objects: [{ key: "new.txt" }], prefixes: [], nextCursor: "new" },
    onChange: () => () => {},
  });
  m.connectionId.value = "c";
  const pending = m.openBucket("old");
  await m.openBucket("new");
  old.resolve({
    objects: [{ key: "old.txt" }],
    prefixes: ["old/"],
    nextCursor: "old",
  });
  await pending;
  assert.equal(m.bucket.value, "new");
  assert.deepEqual(m.objects.value, [{ key: "new.txt" }]);
  assert.equal(m.nextCursor.value, "new");
});
