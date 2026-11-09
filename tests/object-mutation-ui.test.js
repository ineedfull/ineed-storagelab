import test from "node:test";
import assert from "node:assert/strict";
import { createObjectMutation } from "../src/composables/useObjectMutation.js";
const context = {
  connectionId: "c",
  bucket: "b",
  key: " source/+%?.txt ",
  kind: "copy",
};
const source = {
  key: context.key,
  size: 3,
  etag: '"e"',
  contentType: "text/plain",
  cacheControl: "no-cache",
  metadata: { env: "old" },
  capabilities: { conditionalCopy: true, conditionalDelete: true },
};

test("management captures native snapshot and raw target, reports partial rename without resubmitting", async () => {
  const calls = [];
  let resolve;
  const model = createObjectMutation(
    {
      invoke: async (method, p) => {
        calls.push({ method, p });
        if (method === "prepareObjectMutation") return structuredClone(source);
        return new Promise((r) => (resolve = r));
      },
    },
    { ...context, kind: "rename" },
  );
  await model.load();
  model.targetKey.value = " dest/+%?#.txt ";
  const running = model.save();
  await model.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].p.targetKey, " dest/+%?#.txt ");
  assert.equal(calls[1].p.overwrite, false);
  assert.deepEqual(calls[1].p.original, source);
  resolve({
    copied: true,
    sourceRetained: true,
    warning: "源已变化，复制完成，源保留",
  });
  await running;
  assert.match(model.notice.value, /源保留/);
  assert.equal(model.finished.value, true);
  await model.save();
  assert.equal(calls.length, 2);
  model.dispose();
});
test("late source read cannot revive closed editor or replace edited metadata draft", async () => {
  let resolve;
  const model = createObjectMutation(
    { invoke: () => new Promise((r) => (resolve = r)) },
    { ...context, kind: "metadata" },
  );
  const pending = model.load();
  model.dispose();
  resolve(source);
  await pending;
  assert.equal(model.source.value, null);
  assert.equal(model.loading.value, false);
});
test("metadata edits preserve values, reject duplicate keys and cancellation leaves draft retryable", async () => {
  let executions = 0;
  const model = createObjectMutation(
    {
      invoke: async (method, p) => {
        if (method === "prepareObjectMutation") return structuredClone(source);
        executions++;
        assert.equal(p.metadata.env, " newer ");
        assert.equal(p.contentType, "application/json");
        return { cancelled: true };
      },
    },
    { ...context, kind: "metadata" },
  );
  await model.load();
  model.rows.value.push({ key: "env", value: "duplicate" });
  await model.save();
  assert.equal(executions, 0);
  assert.match(model.error.value, /重复/);
  model.rows.value.pop();
  model.rows.value[0].value = " newer ";
  model.contentType.value = "application/json";
  await model.save();
  assert.equal(executions, 1);
  assert.equal(model.finished.value, false);
  assert.equal(model.rows.value[0].value, " newer ");
  assert.match(model.notice.value, /取消/);
  model.dispose();
});
