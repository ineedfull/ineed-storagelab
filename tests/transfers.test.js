import test from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../electron/transfers/queue.js";
const flush = () => new Promise((r) => setImmediate(r));
function fixture(concurrency = 1) {
  const jobs = new Map();
  const locks = new Set();
  const store = {
    snapshot: () => ({ settings: { concurrency } }),
    listJobs: () => [...jobs.values()],
    saveJob: (j) => {
      jobs.set(j.id, { ...j });
      return j;
    },
    lockConnection: (id) => {
      locks.add(id);
      return () => locks.delete(id);
    },
  };
  return { jobs, locks, queue: createQueue({ store, onChange() {} }) };
}
test("bounded queue cancels queued/running, retains grant only this session and releases locks", async () => {
  const { queue, jobs } = fixture();
  let running = 0,
    peak = 0;
  const run = async ({ signal, progress }) => {
    running++;
    peak = Math.max(peak, running);
    progress(3, 9);
    try {
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error(), { name: "AbortError" })),
          { once: true },
        ),
      );
    } finally {
      running--;
    }
  };
  const a = queue.add(
    {
      connectionId: "a",
      connectionName: "a",
      bucket: "b",
      key: "a",
      direction: "upload",
    },
    run,
  );
  const b = queue.add(
    {
      connectionId: "b",
      connectionName: "b",
      bucket: "b",
      key: "b",
      direction: "upload",
    },
    run,
  );
  await flush();
  assert.equal(peak, 1);
  queue.cancel(b.id);
  queue.cancel(a.id);
  await flush();
  assert.equal(jobs.get(a.id).state, "cancelled");
  assert.equal(jobs.get(b.id).state, "cancelled");
  await queue.dispose();
  assert.throws(() => fixture().queue.retry(a.id), {
    code: "RESELECT_REQUIRED",
  });
});
test("commit success beats late cancellation, history failure does not falsify remote success", async () => {
  const { queue, jobs } = fixture();
  const j = queue.add(
    {
      connectionId: "a",
      connectionName: "a",
      bucket: "b",
      key: "x",
      direction: "upload",
    },
    async ({ committed }) => {
      committed();
      queue.cancel(j.id);
    },
  );
  await flush();
  assert.equal(jobs.get(j.id).state, "success");
  await queue.dispose();
});
test("remote success survives a terminal persistence failure with visible warning", async () => {
  const rows = new Map();
  const store = {
    snapshot: () => ({ settings: { concurrency: 1 } }),
    listJobs: () => [...rows.values()],
    lockConnection: () => () => {},
    saveJob: (j) => {
      if (j.state === "success") throw new Error("private SQL failure");
      rows.set(j.id, { ...j });
    },
  };
  const q = createQueue({ store });
  const j = q.add(
    {
      connectionId: "a",
      connectionName: "a",
      bucket: "b",
      key: "x",
      direction: "upload",
    },
    async ({ committed }) => {
      committed();
    },
  );
  await flush();
  const result = q.list().find((x) => x.id === j.id);
  assert.equal(result.state, "success");
  assert.match(result.warning, /历史/);
  assert.equal(JSON.stringify(result).includes("private"), false);
  await q.dispose();
});
test("queue enforces 100 pending and 200 history/grants", async () => {
  const { queue } = fixture(1);
  const run = async ({ signal }) =>
    new Promise((resolve, reject) =>
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error(), { name: "AbortError" })),
      ),
    );
  for (let i = 0; i < 100; i++)
    queue.add(
      {
        connectionId: "a",
        connectionName: "a",
        bucket: "b",
        key: String(i),
        direction: "upload",
      },
      run,
    );
  assert.throws(() => queue.add({ connectionId: "a" }, run), {
    code: "QUEUE_FULL",
  });
  await queue.dispose();
});
test("terminal grants and public history are capped to 200 in a long session", async () => {
  const { queue } = fixture();
  let first;
  for (let i = 0; i < 205; i++) {
    const j = queue.add(
      {
        connectionId: "a",
        connectionName: "a",
        bucket: "b",
        key: String(i),
        direction: "upload",
      },
      async () => {},
    );
    first ??= j.id;
    await flush();
  }
  assert.equal(queue.list().length, 200);
  assert.throws(() => queue.retry(first), { code: "RESELECT_REQUIRED" });
  await queue.dispose();
});
test("concurrency setting two permits exactly two real running tasks", async () => {
  const { queue } = fixture(2);
  let count = 0,
    peak = 0;
  const run = async ({ signal }) => {
    count++;
    peak = Math.max(peak, count);
    try {
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error(), { name: "AbortError" })),
          { once: true },
        ),
      );
    } finally {
      count--;
    }
  };
  for (let i = 0; i < 5; i++)
    queue.add(
      {
        connectionId: "a",
        connectionName: "a",
        bucket: "b",
        key: String(i),
        direction: "upload",
      },
      run,
    );
  await flush();
  assert.equal(peak, 2);
  await queue.dispose();
});
