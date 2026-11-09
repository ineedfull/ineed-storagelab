import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../electron/service.js";
function fixture({ readOnly = false, confirm = true } = {}) {
  let deletes = 0;
  const conn = {
    id: "c",
    name: "test",
    readOnly,
    endpoint: "http://localhost:9000",
  };
  const store = {
    snapshot: () => ({
      connections: [conn],
      jobs: [],
      settings: { concurrency: 2 },
    }),
    getConnection: () => conn,
    getCredentials: () => ({
      accessKeyId: "private",
      secretAccessKey: "never-return",
    }),
    listJobs: () => [],
  };
  const clientFactory = () => ({
    destroy() {},
    send: async (c) => {
      if (c.constructor.name === "ListBucketsCommand")
        throw Object.assign(new Error("secret"), { name: "AccessDenied" });
      if (c.constructor.name === "GetBucketVersioningCommand")
        throw Object.assign(new Error(), { name: "AccessDenied" });
      if (c.constructor.name === "DeleteObjectsCommand") {
        deletes++;
        return {
          Deleted: [{ Key: "a" }],
          Errors: [{ Key: "b", Code: "AccessDenied", Message: "secret" }],
        };
      }
      return { Contents: [] };
    },
  });
  return {
    service: createService({
      store,
      clientFactory,
      dialog: { showMessageBox: async () => ({ response: confirm ? 0 : 1 }) },
      app: { getName: () => "", getVersion: () => "", getPath: () => "" },
    }),
    deletes: () => deletes,
  };
}
test("denied list buckets does not prevent known bucket check; deletes preserve partial errors and unknown version", async () => {
  const { service } = fixture();
  await assert.rejects(service.invoke("listBuckets", { connectionId: "c" }), {
    code: "ACCESS_DENIED",
  });
  assert.equal(
    (
      await service.invoke("checkConnection", {
        connectionId: "c",
        bucket: "known",
      })
    ).status,
    "success",
  );
  const result = await service.invoke("deleteObjects", {
    connectionId: "c",
    bucket: "known",
    keys: ["a", "b"],
  });
  assert.deepEqual(
    result.errors.map((e) => e.key),
    ["b"],
  );
  assert.equal(result.errors[0].message.includes("secret"), false);
  assert.equal(result.versioning, "unknown");
  await service.dispose();
});
test("readOnly denies native mutations and cancelled confirm sends no delete", async () => {
  const a = fixture({ readOnly: true });
  await assert.rejects(
    a.service.invoke("deleteObjects", {
      connectionId: "c",
      bucket: "b",
      keys: ["a"],
    }),
    { code: "READ_ONLY" },
  );
  const b = fixture({ confirm: false });
  assert.equal(
    (
      await b.service.invoke("deleteObjects", {
        connectionId: "c",
        bucket: "b",
        keys: ["a"],
      })
    ).cancelled,
    true,
  );
  assert.equal(b.deletes(), 0);
  await a.service.dispose();
  await b.service.dispose();
});
test("raw UTF-8 keys are limited by bytes, never trimmed or normalized", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.invoke("headObject", {
      connectionId: "c",
      bucket: "b",
      key: "中".repeat(400),
    }),
    { code: "INVALID_INPUT" },
  );
  await service.dispose();
});
