import test from "node:test";
import assert from "node:assert/strict";
import { createWorkbench } from "../src/composables/useWorkbench.js";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(handler) {
  const calls = [];
  const model = createWorkbench({
    invoke(method, payload) {
      calls.push({ method, payload });
      return handler(method, payload);
    },
    onChange: () => () => {},
  });
  model.connections.value = [
    { id: "a", defaultBucket: "bucket-a" },
    { id: "b", defaultBucket: "" },
    { id: "c", defaultBucket: "bucket-c" },
  ];
  return { model, calls };
}
function assertEmpty(model) {
  assert.equal(model.bucket.value, "");
  assert.deepEqual(model.objects.value, []);
  assert.deepEqual(model.prefixes.value, []);
  assert.deepEqual(model.selected.value, []);
  assert.equal(model.focused.value, null);
  assert.equal(model.detail.value, null);
  assert.equal(model.preview.value, null);
  assert.equal(model.nextCursor.value, undefined);
  assert.equal(model.prefix.value, "");
  assert.equal(model.loading.value, false);
}
test("switching connections preserves an outstanding cleanup warning", async () => {
  const { model } = setup(() => Promise.resolve({ buckets: [] }));
  model.notify("Remote parts still need manual cleanup", "warning");
  await model.selectConnection("b");
  assert.equal(model.notice.value, "Remote parts still need manual cleanup");
  model.notify("Connection checked");
  await model.selectConnection("b");
  assert.equal(model.notice.value, "");
});
test("same-directory refresh retains rows until replacement and retires its recovered read error", async () => {
  const pending = deferred();
  let reads = 0;
  const { model } = setup((method) => {
    if (method === "listBuckets") return Promise.resolve({ buckets: [] });
    reads++;
    if (reads === 1)
      return Promise.resolve({
        objects: [{ key: "existing.txt" }],
        prefixes: ["dir/"],
      });
    if (reads === 2) return pending.promise;
    if (reads === 3)
      return Promise.reject(
        Object.assign(new Error("temporarily offline"), {
          code: "NETWORK_ERROR",
        }),
      );
    return Promise.resolve({
      objects: [{ key: "recovered.txt" }],
      prefixes: [],
    });
  });
  await model.selectConnection("a");
  const refresh = model.browse();
  assert.deepEqual(model.objects.value, [{ key: "existing.txt" }]);
  assert.deepEqual(model.prefixes.value, ["dir/"]);
  assert.equal(model.loading.value, true);
  pending.resolve({ objects: [{ key: "replacement.txt" }], prefixes: [] });
  await refresh;
  assert.deepEqual(model.objects.value, [{ key: "replacement.txt" }]);
  await model.browse();
  assert.match(model.error.value, /temporarily offline/);
  await model.browse();
  assert.equal(model.error.value, "");
  assert.deepEqual(model.objects.value, [{ key: "recovered.txt" }]);
});
test("switch immediately discards A list, head, preview, selection and cursors when B has no default bucket", async () => {
  const list = deferred(),
    head = deferred(),
    preview = deferred(),
    bucketsB = deferred();
  const { model } = setup((method, p) =>
    method === "listBuckets"
      ? p.connectionId === "b"
        ? bucketsB.promise
        : Promise.resolve({ buckets: [] })
      : method === "listObjects"
        ? list.promise
        : method === "headObject"
          ? head.promise
          : preview.promise,
  );
  model.connectionId.value = "a";
  model.bucket.value = "bucket-a";
  const listing = model.browse("raw/");
  const heading = model.focus({ key: "old.txt" });
  const previewing = model.loadPreview();
  model.selected.value = ["old.txt"];
  model.prefixes.value = ["old/"];
  model.nextCursor.value = "old-cursor";
  model.detail.value = { key: "old.txt" };
  model.preview.value = { kind: "text", content: "old" };
  const switching = model.selectConnection("b");
  assert.equal(model.connectionId.value, "b");
  assertEmpty(model);
  list.resolve({
    objects: [{ key: "old.txt" }],
    prefixes: ["old/"],
    nextCursor: "stale",
  });
  head.resolve({ key: "old.txt" });
  preview.resolve({ kind: "text", content: "stale" });
  await Promise.all([listing, heading, previewing]);
  assertEmpty(model);
  bucketsB.resolve({ buckets: [] });
  await switching;
  assertEmpty(model);
});
test("outdated select flow neither restarts current browsing nor publishes stale bucket errors across A-B-A switches", async () => {
  const first = deferred(),
    second = deferred();
  let aCount = 0;
  const { model, calls } = setup((method, p) => {
    if (method === "listBuckets") {
      if (p.connectionId === "a" && aCount++ === 0) return first.promise;
      if (p.connectionId === "b") return second.promise;
      return Promise.resolve({ buckets: [{ name: "fresh-a" }] });
    }
    return Promise.resolve({ objects: [{ key: "fresh.txt" }], prefixes: [] });
  });
  const a = model.selectConnection("a");
  const b = model.selectConnection("b");
  await model.selectConnection("a");
  const before = calls.filter((c) => c.method === "listObjects").length;
  first.resolve({ buckets: [{ name: "stale-a" }] });
  second.reject(
    Object.assign(new Error("obsolete B error"), { code: "ACCESS_DENIED" }),
  );
  await Promise.all([a, b]);
  assert.equal(calls.filter((c) => c.method === "listObjects").length, before);
  assert.deepEqual(model.buckets.value, [{ name: "fresh-a" }]);
  assert.equal(model.error.value, "");
  assert.deepEqual(model.objects.value, [{ key: "fresh.txt" }]);
});
test("failed removal preserves the selected connection and object context", async () => {
  const { model } = setup(() => Promise.reject(new Error("remove denied")));
  model.connectionId.value = "a";
  model.bucket.value = model.bucketDraft.value = "custom-bucket";
  model.prefix.value = "folder/";
  model.objects.value = [{ key: "folder/a.txt" }];
  model.selected.value = ["folder/a.txt"];
  model.focused.value = { key: "folder/a.txt" };
  model.detail.value = { size: 4 };
  await assert.rejects(model.removeConnection(), /remove denied/);
  assert.equal(model.connectionId.value, "a");
  assert.equal(model.bucket.value, "custom-bucket");
  assert.equal(model.prefix.value, "folder/");
  assert.deepEqual(model.objects.value, [{ key: "folder/a.txt" }]);
  assert.deepEqual(model.selected.value, ["folder/a.txt"]);
  assert.deepEqual(model.detail.value, { size: 4 });
});
test("removal invalidates pending A reads immediately, retains context until confirmed and preserves newly selected C", async () => {
  const remove = deferred(),
    list = deferred(),
    head = deferred();
  const { model, calls } = setup((method, p) => {
    if (method === "removeConnection") return remove.promise;
    if (method === "listBuckets")
      return Promise.resolve({ buckets: [{ name: "c-bucket" }] });
    if (method === "headObject") return head.promise;
    if (p.connectionId === "a") return list.promise;
    return Promise.resolve({ objects: [{ key: "c.txt" }], prefixes: [] });
  });
  model.connectionId.value = "a";
  model.bucket.value = "bucket-a";
  const listing = model.browse();
  const heading = model.focus({ key: "a.txt" });
  model.selected.value = ["a.txt"];
  const removal = model.removeConnection();
  assert.equal(model.connectionId.value, "a");
  assert.deepEqual(model.selected.value, ["a.txt"]);
  await model.selectConnection("c");
  list.resolve({ objects: [{ key: "a.txt" }], prefixes: ["a/"] });
  head.resolve({ key: "a.txt" });
  remove.resolve(true);
  await Promise.all([listing, heading, removal]);
  assert.equal(model.connectionId.value, "c");
  assert.equal(model.bucket.value, "bucket-c");
  assert.deepEqual(model.objects.value, [{ key: "c.txt" }]);
  assert.equal(model.detail.value, null);
  assert.equal(
    model.connections.value.some((c) => c.id === "a"),
    false,
  );
  assert.deepEqual(calls.find((c) => c.method === "removeConnection").payload, {
    id: "a",
  });
});
test("remove completion clears a reselected deleted identity and invalidates its delayed bucket flow", async () => {
  const remove = deferred(),
    buckets = deferred();
  const { model, calls } = setup((method) =>
    method === "removeConnection"
      ? remove.promise
      : method === "listBuckets"
        ? buckets.promise
        : Promise.resolve({ objects: [{ key: "stale.txt" }], prefixes: [] }),
  );
  model.connectionId.value = "a";
  model.bucket.value = "bucket-a";
  const removal = model.removeConnection();
  const selecting = model.selectConnection("a");
  remove.resolve(true);
  await removal;
  assert.equal(model.connectionId.value, "");
  assertEmpty(model);
  buckets.resolve({ buckets: [{ name: "removed-bucket" }] });
  await selecting;
  assertEmpty(model);
  assert.deepEqual(model.buckets.value, []);
  assert.equal(
    calls.some((c) => c.method === "listObjects"),
    false,
  );
});
