import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS, validatePayload } from "../electron/ipc.js";
import { createS3Operations } from "../electron/s3/operations.js";
import { createService } from "../electron/service.js";
import { downloadObject } from "../electron/transfers/download.js";
import { createQueue } from "../electron/transfers/queue.js";
import { createStore } from "../electron/store.js";

const target = { connectionId: "c", bucket: "bucket", key: " 中文/+%?#.txt " };
function fixture({
  readOnly = false,
  response = 0,
  versioning = "Enabled",
  versionId = "v+/1",
  size = 12,
  failCopy = false,
} = {}) {
  const commands = [];
  let locked = 0,
    confirms = 0;
  const client = {
    destroy() {},
    async send(c) {
      commands.push(c);
      switch (c.constructor.name) {
        case "GetBucketVersioningCommand":
          return { Status: versioning };
        case "HeadObjectCommand":
          return {
            VersionId: versionId,
            ContentLength: size,
            ETag: '"etag"',
            ContentType: "text/plain",
            Metadata: { purpose: "old" },
            ObjectLockMode: "GOVERNANCE",
            ObjectLockRetainUntilDate: new Date(0),
            ObjectLockLegalHoldStatus: "ON",
          };
        case "CopyObjectCommand":
          if (failCopy)
            throw Object.assign(new Error("secret raw headers"), {
              name: "PreconditionFailed",
              $metadata: { httpStatusCode: 412 },
            });
          return {
            VersionId: "restored",
            CopyObjectResult: { ETag: '"restored"' },
          };
        default:
          return {};
      }
    },
  };
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
    clientFactory: () => client,
    dialog: {
      showMessageBox: async (options) => {
        confirms++;
        assert.equal(locked, 1);
        assert.ok(options.detail.includes(target.key));
        assert.ok(options.detail.includes("v+/1"));
        return { response };
      },
    },
  });
  return { client, service, commands, state: () => ({ locked, confirms }) };
}
test("version bridge requires explicit version identity and complete opaque pagination markers", () => {
  for (const method of [
    "listObjectVersions",
    "headObjectVersion",
    "restoreObjectVersion",
    "downloadObjectVersion",
  ])
    assert.ok(METHODS.includes(method), method);
  for (const method of [
    "headObjectVersion",
    "restoreObjectVersion",
    "downloadObjectVersion",
  ]) {
    assert.doesNotThrow(() =>
      validatePayload(method, { ...target, versionId: "raw+/ ?%" }),
    );
    for (const versionId of [undefined, "", 1])
      assert.throws(() => validatePayload(method, { ...target, versionId }), {
        code: "INVALID_INPUT",
      });
  }
  assert.doesNotThrow(() =>
    validatePayload("listObjectVersions", {
      ...target,
      keyMarker: "raw-key",
      versionIdMarker: "raw+/marker",
    }),
  );
  assert.throws(
    () =>
      validatePayload("listObjectVersions", {
        ...target,
        versionIdMarker: "v",
      }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () => validatePayload("listObjectVersions", { ...target, keyMarker: 1 }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      validatePayload("downloadObjectVersion", {
        ...target,
        versionId: "v",
        directory: "/tmp",
      }),
    { code: "INVALID_INPUT" },
  );
});
test("whitespace raw Key history can follow a returned version pagination marker", () => {
  const payload = {
    ...target,
    key: " ",
    keyMarker: " ",
    versionIdMarker: "raw+/next",
  };
  assert.deepEqual(validatePayload("listObjectVersions", payload), payload);
});
test("opaque version key markers can include service suffixes beyond the raw Key limit", () => {
  const p = {
    ...target,
    keyMarker: "k".repeat(1024) + " [minio_cache:v2,return:]",
    versionIdMarker: "next-version",
  };
  assert.deepEqual(validatePayload("listObjectVersions", p), p);
  assert.throws(
    () =>
      validatePayload("listObjectVersions", {
        ...p,
        keyMarker: "x".repeat(16385),
      }),
    { code: "INVALID_INPUT" },
  );
});
test("history filters exact raw Key, preserves double markers and does not merge neighboring prefix versions", async () => {
  const sent = [];
  const s = createS3Operations({
    connection: { provider: "minio" },
    client: {
      async send(c) {
        sent.push(c);
        if (c.constructor.name === "GetBucketVersioningCommand")
          return { Status: "Enabled" };
        return {
          Versions: [
            {
              Key: target.key,
              VersionId: "old+/id",
              IsLatest: false,
              Size: 3,
              LastModified: new Date(0),
            },
            { Key: target.key + "other", VersionId: "neighbor" },
          ],
          DeleteMarkers: [
            {
              Key: target.key,
              VersionId: "deleted",
              IsLatest: true,
              LastModified: new Date(1000),
            },
          ],
          IsTruncated: true,
          NextKeyMarker: target.key,
          NextVersionIdMarker: "next+/id",
        };
      },
    },
  });
  const result = await s.listObjectVersions({
    ...target,
    keyMarker: target.key,
    versionIdMarker: "previous",
  });
  assert.deepEqual(
    result.entries.map((v) => [v.versionId, v.deleteMarker]),
    [
      ["deleted", true],
      ["old+/id", false],
    ],
  );
  assert.equal(result.versioning, "enabled");
  assert.deepEqual(result.nextPage, {
    keyMarker: target.key,
    versionIdMarker: "next+/id",
  });
  assert.equal(result.entries[1].lastModified, "1970-01-01T00:00:00.000Z");
  const c = sent.find(
    (c) => c.constructor.name === "ListObjectVersionsCommand",
  );
  assert.deepEqual(c.input, {
    Bucket: target.bucket,
    Prefix: target.key,
    MaxKeys: 200,
    KeyMarker: target.key,
    VersionIdMarker: "previous",
  });
});
test("version property reads bind exact version, expose retention headers without claiming absent protection", async () => {
  const f = fixture();
  try {
    const h = await f.service.invoke("headObjectVersion", {
      ...target,
      versionId: "v+/1",
    });
    assert.equal(h.versionId, "v+/1");
    assert.deepEqual(h.retention, {
      mode: "GOVERNANCE",
      retainUntil: "1970-01-01T00:00:00.000Z",
      legalHold: "ON",
    });
    assert.equal(f.commands[0].input.VersionId, "v+/1");
  } finally {
    await f.service.dispose();
  }
});
test("restore locks context, confirms overwrite then copies fixed source with safe raw encoding and preserves history", async () => {
  const f = fixture();
  try {
    const r = await f.service.invoke("restoreObjectVersion", {
      ...target,
      versionId: "v+/1",
    });
    assert.equal(r.restored, true);
    assert.equal(r.versionId, "restored");
    const copy = f.commands.find(
      (c) => c.constructor.name === "CopyObjectCommand",
    );
    assert.deepEqual(copy.input, {
      Bucket: target.bucket,
      Key: target.key,
      CopySource:
        "bucket/%20%E4%B8%AD%E6%96%87/%2B%25%3F%23.txt%20?versionId=v%2B%2F1",
      CopySourceIfMatch: '"etag"',
      MetadataDirective: "COPY",
      TaggingDirective: "COPY",
    });
    assert.equal(f.state().locked, 0);
    assert.equal(f.state().confirms, 1);
    assert.ok(!f.commands.some((c) => c.constructor.name.startsWith("Delete")));
  } finally {
    await f.service.dispose();
  }
});
test("read-only, cancelled, mutable/null, wrong version, unknown versioning and oversized restore never copy", async () => {
  const cases = [
    [{ readOnly: true }, "READ_ONLY"],
    [{ response: 1 }, null],
    [{}, "IMMUTABLE_VERSION_REQUIRED", "null"],
    [{ versionId: "different" }, "VERSION_MISMATCH"],
    [{ versioning: undefined }, "VERSIONING_REQUIRED"],
    [{ versioning: "Suspended" }, "VERSIONING_REQUIRED"],
    [{ size: 5 * 1024 ** 3 + 1 }, "COPY_TOO_LARGE"],
  ];
  for (const [options, code, versionId = "v+/1"] of cases) {
    // Omit Status to simulate a service that has never enabled versioning.
    const f = fixture(
      options.versioning === undefined && "versioning" in options
        ? { ...options, versioning: "" }
        : options,
    );
    try {
      const call = () =>
        f.service.invoke("restoreObjectVersion", { ...target, versionId });
      if (code) await assert.rejects(call(), { code });
      else assert.equal((await call()).cancelled, true);
      assert.ok(
        !f.commands.some((c) => c.constructor.name === "CopyObjectCommand"),
      );
      assert.equal(f.state().locked, 0);
    } finally {
      await f.service.dispose();
    }
  }
});
test("restore source preconditions produce conflict errors instead of no-overwrite success wording", async () => {
  const f = fixture({ failCopy: true });
  try {
    await assert.rejects(
      f.service.invoke("restoreObjectVersion", {
        ...target,
        versionId: "v+/1",
      }),
      { code: "CONFLICT" },
    );
  } finally {
    await f.service.dispose();
  }
});
test("known unsupported versions and access failures do not appear as empty histories", async () => {
  const denied = createS3Operations({
    connection: { provider: "s3" },
    client: {
      send: async () => {
        throw { name: "AccessDenied", message: "secret" };
      },
    },
  });
  await assert.rejects(denied.listObjectVersions(target), {
    code: "ACCESS_DENIED",
  });
  const r2 = createS3Operations({
    connection: { provider: "r2" },
    client: {
      send: async () => {
        throw new Error("must not send");
      },
    },
  });
  await assert.rejects(r2.listObjectVersions(target), { code: "UNSUPPORTED" });
});
test("version download sends exact VersionId, streams selected bytes and keeps default local no-overwrite", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "storagelab-version-download-"),
  );
  const client = {
    async send(c) {
      assert.equal(c.input.VersionId, "raw+/v");
      return {
        Body: Readable.from(["old"]),
        ContentLength: 3,
        VersionId: "raw+/v",
      };
    },
  };
  try {
    const args = {
      client,
      bucket: "bucket",
      key: "old.txt",
      versionId: "raw+/v",
      directory,
      overwrite: false,
      signal: new AbortController().signal,
      onProgress() {},
    };
    await downloadObject(args);
    assert.equal(await readFile(join(directory, "old.txt"), "utf8"), "old");
    await assert.rejects(downloadObject(args), { code: "ALREADY_EXISTS" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("a server ignoring requested download version cannot save current bytes as historical content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-wrong-version-"));
  const body = Readable.from(["new"]);
  try {
    await assert.rejects(
      downloadObject({
        client: {
          send: async () => ({
            Body: body,
            ContentLength: 3,
            VersionId: "current",
          }),
        },
        bucket: "bucket",
        key: "old.txt",
        versionId: "historical",
        directory,
        overwrite: false,
        signal: new AbortController().signal,
        onProgress() {},
      }),
      { code: "VERSION_MISMATCH" },
    );
    await assert.rejects(readFile(join(directory, "old.txt")), {
      code: "ENOENT",
    });
    assert.equal(body.destroyed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("download retries retain the historical version in persisted public job identity", async () => {
  const jobs = [];
  const q = createQueue({
    store: {
      snapshot: () => ({ settings: { concurrency: 1 } }),
      listJobs: () => jobs,
      lockConnection: () => () => {},
      saveJob: (j) => {
        const i = jobs.findIndex((x) => x.id === j.id);
        if (i < 0) jobs.push(j);
        else jobs[i] = j;
      },
    },
  });
  try {
    const first = q.add(
      {
        connectionId: "c",
        bucket: "bucket",
        key: "old",
        direction: "download",
        versionId: "fixed-v",
      },
      async () => {
        throw new Error("fail");
      },
    );
    for (let i = 0; i < 30 && q.list()[0].state !== "failed"; i++)
      await new Promise((r) => setTimeout(r, 5));
    const retry = q.retry(first.id);
    assert.equal(retry.versionId, "fixed-v");
  } finally {
    await q.dispose();
  }
});
test("version task identity survives SQLite restart without changing old task records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-version-store-"));
  let store;
  try {
    store = createStore({ directory, vault: {} });
    store.saveJob({
      id: "old",
      direction: "download",
      key: "current.txt",
      state: "success",
    });
    store.saveJob({
      id: "historical",
      direction: "download",
      key: "current.txt",
      versionId: "v+/specific",
      state: "success",
    });
    store.close();
    store = createStore({ directory, vault: {} });
    assert.equal(
      store.listJobs().find((j) => j.id === "historical").versionId,
      "v+/specific",
    );
    assert.equal(
      store.listJobs().find((j) => j.id === "old").versionId,
      undefined,
    );
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
