import test from "node:test";
import assert from "node:assert/strict";
import { createWorkbench } from "../src/composables/useWorkbench.js";
import { createS3Operations } from "../electron/s3/operations.js";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
for (const latest of [
  [{ id: "job", state: "success", bytesTransferred: 100 }],
  [{ id: "job", state: "cancelled", bytesTransferred: 10 }],
  [],
])
  test(`newest job snapshot wins over late running response (${latest[0]?.state ?? "deleted"})`, async () => {
    const reads = [deferred(), deferred()];
    let n = 0;
    const model = createWorkbench({ invoke: () => reads[n++].promise });
    const older = model.refreshJobs(),
      newer = model.refreshJobs();
    reads[1].resolve(latest);
    await newer;
    reads[0].resolve([{ id: "job", state: "running", bytesTransferred: 1 }]);
    await older;
    assert.deepEqual(model.jobs.value, latest);
  });
test("obsolete job errors cannot replace current feedback", async () => {
  const reads = [deferred(), deferred()];
  let n = 0;
  const model = createWorkbench({ invoke: () => reads[n++].promise });
  const older = model.refreshJobs(),
    newer = model.refreshJobs();
  reads[1].resolve([]);
  await newer;
  model.error.value = "Current action error";
  reads[0].reject(Object.assign(new Error("stale"), { code: "NETWORK_ERROR" }));
  await older;
  assert.equal(model.error.value, "Current action error");
});
for (const rejected of [false, true])
  test(`dispose invalidates outstanding job ${rejected ? "errors" : "snapshots"}`, async () => {
    const read = deferred();
    const model = createWorkbench({ invoke: () => read.promise });
    const refresh = model.refreshJobs();
    model.dispose();
    if (rejected) read.reject(new Error("late"));
    else read.resolve([{ id: "late" }]);
    await refresh;
    assert.deepEqual(model.jobs.value, []);
    assert.equal(model.error.value, "");
  });
test("current job read errors remain visible", async () => {
  const model = createWorkbench({
    invoke: async () => {
      throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
    },
  });
  await model.refreshJobs();
  assert.match(model.error.value, /NETWORK_ERROR: offline/);
});
const bucketApi = (send) =>
  createS3Operations({ client: { send }, connection: { provider: "s3" } });
test("bucket listing aggregates pages with opaque cursors and preserves single-page behavior", async () => {
  const inputs = [];
  const api = bucketApi(async (c) => {
    inputs.push(c.input);
    return inputs.length === 1
      ? { Buckets: [{ Name: "one" }], ContinuationToken: " /+雪=opaque" }
      : { Buckets: [{ Name: "two" }] };
  });
  assert.deepEqual(
    (await api.listBuckets()).buckets.map((b) => b.name),
    ["one", "two"],
  );
  assert.equal(inputs[1].ContinuationToken, " /+雪=opaque");
  assert.equal(
    (await bucketApi(async () => ({ Buckets: [] })).listBuckets()).buckets
      .length,
    0,
  );
});
test("bucket enumeration fails visibly on repeated cursors instead of looping or returning incomplete results", async () => {
  let calls = 0;
  const api = bucketApi(async () => {
    calls++;
    return { Buckets: [{ Name: "one" }], ContinuationToken: "same" };
  });
  await assert.rejects(api.listBuckets(), { code: "BUCKET_LIST_INCOMPLETE" });
  assert.equal(calls, 2);
});
test("later bucket page failure is not published as a complete list", async () => {
  let calls = 0;
  const api = bucketApi(async () => {
    if (++calls === 1)
      return { Buckets: [{ Name: "one" }], ContinuationToken: "next" };
    throw { name: "AccessDenied" };
  });
  await assert.rejects(api.listBuckets(), { code: "ACCESS_DENIED" });
});
test("bucket enumeration has a bounded page budget", async () => {
  let calls = 0;
  const api = bucketApi(async () => ({
    Buckets: [],
    ContinuationToken: String(++calls),
  }));
  await assert.rejects(api.listBuckets(), { code: "BUCKET_LIST_INCOMPLETE" });
  assert.ok(calls <= 100);
});
test("truncated bucket response without a cursor fails visibly", async () => {
  await assert.rejects(
    bucketApi(async () => ({ Buckets: [], IsTruncated: true })).listBuckets(),
    { code: "BUCKET_LIST_INCOMPLETE" },
  );
});
test("bucket enumeration rejects invalid cursors and excessive aggregate rows", async () => {
  await assert.rejects(
    bucketApi(async () => ({
      Buckets: [],
      ContinuationToken: 42,
    })).listBuckets(),
    { code: "BUCKET_LIST_INCOMPLETE" },
  );
  let calls = 0;
  const api = bucketApi(async () => ({
    Buckets: Array.from({ length: 6000 }, (_, n) => ({
      Name: `bucket-${calls}-${n}`,
    })),
    ContinuationToken: String(++calls),
  }));
  await assert.rejects(api.listBuckets(), { code: "BUCKET_LIST_INCOMPLETE" });
  assert.equal(calls, 2);
});
