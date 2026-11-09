import test from "node:test";
import assert from "node:assert/strict";
import { METHODS, validatePayload } from "../electron/ipc.js";
import { createService } from "../electron/service.js";
import { createWorkbench } from "../src/composables/useWorkbench.js";
import { storageError } from "../electron/s3/errors.js";
import { sameObjectTags } from "../src/domain/object-tags.js";

const target = { connectionId: "c", bucket: "bucket", key: " 中文/+%?#.txt " };
const tags = [
  { key: "环境", value: " 开发 " },
  { key: "empty", value: "" },
];
test("duplicate-key edits stay dirty so validation and revert remain available", () => {
  assert.equal(
    sameObjectTags(
      [
        { key: "first", value: "v" },
        { key: "first", value: "v" },
      ],
      [
        { key: "first", value: "v" },
        { key: "second", value: "v" },
      ],
    ),
    false,
  );
});
test("provider tag validation errors are useful and never expose raw SDK messages", () => {
  const e = storageError({ name: "InvalidTag", message: "secret headers" });
  assert.equal(e.code, "INVALID_TAGS");
  assert.ok(!e.message.includes("secret"));
});
function fixture({
  readOnly = false,
  response = 0,
  remote = [],
  versionId,
  deny = false,
  onConfirm,
} = {}) {
  const calls = [];
  let locked = 0,
    destroyed = 0,
    confirmations = 0;
  const store = {
    snapshot: () => ({ jobs: [], settings: { concurrency: 2 } }),
    listJobs: () => [],
    getConnection: () => ({ id: "c", name: "test", readOnly }),
    getCredentials: () => ({
      accessKeyId: "private",
      secretAccessKey: "secret",
    }),
    lockConnection: () => {
      locked++;
      return () => locked--;
    },
  };
  const service = createService({
    store,
    clientFactory: () => ({
      destroy() {
        destroyed++;
      },
      async send(command) {
        calls.push(command);
        if (deny)
          throw Object.assign(new Error("secret headers"), {
            name: "AccessDenied",
          });
        if (command.constructor.name === "GetObjectTaggingCommand")
          return {
            TagSet: remote.map((t) => ({ Key: t.key, Value: t.value })),
            VersionId: versionId,
          };
        if (command.constructor.name === "PutObjectTaggingCommand")
          remote = command.input.Tagging.TagSet.map((t) => ({
            key: t.Key,
            value: t.Value,
          }));
        if (command.constructor.name === "DeleteObjectTaggingCommand")
          remote = [];
        return {};
      },
    }),
    dialog: {
      async showMessageBox(options) {
        confirmations++;
        await onConfirm?.(options);
        return { response };
      },
    },
  });
  return {
    service,
    calls,
    remote: () => remote,
    state: () => ({ locked, destroyed, confirmations }),
  };
}
test("tag bridge validates raw keys, complete sets, duplicates, lengths and reserved characters", () => {
  assert.ok(METHODS.includes("getObjectTags"));
  assert.ok(METHODS.includes("saveObjectTags"));
  const p = { ...target, tags, originalTags: [], versionId: "raw+/version" };
  assert.deepEqual(validatePayload("saveObjectTags", p), p);
  for (const change of [
    {
      tags: Array.from({ length: 11 }, (_, i) => ({
        key: String(i),
        value: "",
      })),
    },
    {
      tags: [
        { key: "x", value: "a" },
        { key: "x", value: "b" },
      ],
    },
    { tags: [{ key: "", value: "" }] },
    { tags: [{ key: "a".repeat(129), value: "" }] },
    { tags: [{ key: "x", value: "a".repeat(257) }] },
    { tags: [{ key: "AWS:reserved", value: "" }] },
    { tags: [{ key: "x", value: "line\nbreak" }] },
    { tags: [{ key: "x", value: "<&>" }] },
    { tags: [{ key: "x", value: 1 }] },
    { originalTags: undefined },
    { versionId: "" },
    { key: "" },
  ])
    assert.throws(
      () => validatePayload("saveObjectTags", { ...p, ...change }),
      { code: "INVALID_INPUT" },
    );
});
test("tag save preserves raw key, binds version, holds connection lock through confirmation and writes full set", async () => {
  const f = fixture({
    versionId: "v+/1",
    onConfirm: () => assert.equal(f.state().locked, 1),
  });
  try {
    assert.deepEqual(await f.service.invoke("getObjectTags", target), {
      tags: [],
      versionId: "v+/1",
    });
    const r = await f.service.invoke("saveObjectTags", {
      ...target,
      tags,
      originalTags: [],
      versionId: "v+/1",
    });
    assert.equal(r.saved, true);
    assert.deepEqual(f.remote(), tags);
    const put = f.calls.find(
      (c) => c.constructor.name === "PutObjectTaggingCommand",
    );
    assert.equal(put.input.Key, target.key);
    assert.equal(put.input.VersionId, "v+/1");
    assert.equal(f.state().locked, 0);
    assert.equal(f.state().destroyed, 2);
  } finally {
    await f.service.dispose();
  }
});
test("clearing tags uses DeleteObjectTagging and stale originals block writes", async () => {
  const f = fixture({ remote: tags });
  try {
    await assert.rejects(
      f.service.invoke("saveObjectTags", {
        ...target,
        tags: [],
        originalTags: [],
      }),
      { code: "CONFLICT" },
    );
    assert.deepEqual(f.remote(), tags);
    await f.service.invoke("saveObjectTags", {
      ...target,
      tags: [],
      originalTags: [...tags].reverse(),
    });
    assert.deepEqual(f.remote(), []);
    assert.ok(
      f.calls.some((c) => c.constructor.name === "DeleteObjectTaggingCommand"),
    );
  } finally {
    await f.service.dispose();
  }
});
test("native read-only/cancel/permissions never become successful empty tag lists", async () => {
  for (const mode of ["readOnly", "cancel", "deny"]) {
    const f = fixture({
      readOnly: mode === "readOnly",
      response: mode === "cancel" ? 1 : 0,
      deny: mode === "deny",
    });
    try {
      if (mode === "deny")
        await assert.rejects(f.service.invoke("getObjectTags", target), {
          code: "ACCESS_DENIED",
        });
      const call = () =>
        f.service.invoke("saveObjectTags", {
          ...target,
          tags,
          originalTags: [],
        });
      if (mode === "cancel") assert.equal((await call()).cancelled, true);
      else
        await assert.rejects(call(), {
          code: mode === "readOnly" ? "READ_ONLY" : "ACCESS_DENIED",
        });
      assert.ok(!f.calls.some((c) => /^(Put|Delete)/.test(c.constructor.name)));
      assert.equal(f.state().locked, 0);
    } finally {
      await f.service.dispose();
    }
  }
});
test("late tag reads cannot populate a new object's editor", async () => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const model = createWorkbench({
    invoke: async (method) =>
      method === "getObjectTags" ? pending : { key: "next" },
  });
  assert.ok(model.objectTags, "workbench must expose an isolated tag editor");
  model.connectionId.value = "c";
  model.bucket.value = "bucket";
  await model.focus({ key: "old" });
  const reading = model.objectTags.load();
  await model.focus({ key: "next" });
  resolve({ tags, versionId: "old-version" });
  await reading;
  assert.equal(model.objectTags.loaded.value, false);
  assert.deepEqual(model.objectTags.draft.value, []);
  model.dispose();
});
test("pending tag saves keep original target and stale failures stay out of the new editor", async () => {
  let resolve, reject, submitted;
  const pending = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const model = createWorkbench({
    invoke: async (method, p) => {
      if (method === "getObjectTags")
        return { tags: [], versionId: "version-a" };
      if (method === "saveObjectTags") {
        submitted = p;
        return pending;
      }
      return { key: p.key };
    },
  });
  model.connectionId.value = "c";
  model.bucket.value = "old-bucket";
  await model.focus({ key: "old" });
  const editor = model.objectTags;
  await editor.load();
  editor.draft.value = tags;
  const saving = editor.save();
  assert.equal(editor.busy.value, true);
  model.bucket.value = "new-bucket";
  await model.focus({ key: "next" });
  await editor.load();
  reject(Object.assign(new Error("obsolete error"), { code: "CONFLICT" }));
  await saving;
  assert.equal(submitted.key, "old");
  assert.equal(submitted.bucket, "old-bucket");
  assert.equal(submitted.versionId, "version-a");
  assert.equal(editor.error.value, "");
  assert.deepEqual(editor.draft.value, []);
  assert.equal(editor.busy.value, false);
  model.dispose();
});
