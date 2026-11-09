import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCheckpointStore,
  connectionFingerprint,
} from "../electron/transfers/checkpoints.js";

test("private checkpoint is atomic mode0600, validates schema and never persists file grants or credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-resume-"));
  try {
    const store = createCheckpointStore(dir);
    const record = {
      version: 1,
      id: "test",
      jobId: "job",
      connectionId: "conn",
      connectionFingerprint: connectionFingerprint({
        id: "conn",
        endpoint: "http://127.0.0.1:9000",
      }),
      bucket: "bucket",
      key: "key",
      overwrite: true,
      size: 8388608,
      sha256: "a".repeat(64),
      token: "b".repeat(64),
      parts: [],
      phase: "ready",
      contentType: "text/plain",
    };
    await store.save(record);
    if (process.platform !== "win32")
      assert.equal((await stat(join(dir, "test.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await store.get("test"), record);
    await assert.rejects(store.save({ ...record, path: "/private/file" }));
    await assert.rejects(
      store.save({ ...record, credentials: { secretAccessKey: "secret" } }),
    );
    assert.ok(
      !(await readFile(join(dir, "test.json"), "utf8")).includes("secret"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createStore } from "../electron/store.js";
import { createVault } from "../electron/vault.js";
import { createService } from "../electron/service.js";
import {
  verifyRemoteParts,
  PART_SIZE,
  openFingerprint,
  resumableUpload,
} from "../electron/transfers/resumable-upload.js";
import { validatePayload } from "../electron/ipc.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "storage-resume-service-"));
  const path = join(directory, "file.bin");
  await writeFile(path, Buffer.alloc(PART_SIZE * 2 + 19, 71));
  const vault = createVault({
    safeStorage: { isEncryptionAvailable: () => false },
  });
  let store = createStore({ directory: join(directory, "data"), vault });
  let profile = store.saveConnection({
    connection: {
      name: "resume",
      provider: "minio",
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      forcePathStyle: true,
    },
    credentialStorage: "session",
    credentials: { accessKeyId: "access", secretAccessKey: "secret" },
  });
  let selected = path,
    confirm = 0,
    failPart = 2,
    failComplete = false,
    headMatches = true,
    metadata,
    total;
  const sent = [],
    remote = new Map();
  const client = {
    destroy() {},
    async send(command) {
      const kind = command.constructor.name,
        p = command.input;
      sent.push({ kind, number: p.PartNumber });
      if (kind === "CreateMultipartUploadCommand") {
        metadata = p.Metadata;
        return { UploadId: "private-upload-id" };
      }
      if (kind === "UploadPartCommand") {
        if (p.PartNumber === failPart) throw new Error("injected disconnect");
        remote.set(p.PartNumber, {
          PartNumber: p.PartNumber,
          Size: p.ContentLength,
          ETag: `etag-${p.PartNumber}`,
        });
        return { ETag: `etag-${p.PartNumber}` };
      }
      if (kind === "ListPartsCommand") return { Parts: [...remote.values()] };
      if (kind === "CompleteMultipartUploadCommand") {
        total = PART_SIZE * 2 + 19;
        if (failComplete) throw new Error("lost completion response");
        return {};
      }
      if (kind === "HeadObjectCommand")
        return { ContentLength: total, Metadata: headMatches ? metadata : {} };
      if (kind === "AbortMultipartUploadCommand") {
        remote.clear();
        return {};
      }
      throw new Error("Unexpected command");
    },
  };
  const dialog = {
    showOpenDialog: async () => ({
      canceled: !selected,
      filePaths: selected ? [selected] : [],
    }),
    showMessageBox: async () => ({ response: confirm }),
    showSaveDialog: async () => ({ canceled: true }),
  };
  const app = {
    getPath: () => join(directory, "data"),
    getName: () => "test",
    getVersion: () => "test",
  };
  const makeService = () =>
    createService({ store, app, dialog, clientFactory: () => client });
  let service = makeService();
  async function wait(id) {
    for (let i = 0; i < 300; i++) {
      const j = (await service.invoke("listJobs")).find((j) => j.id === id);
      if (j && !["queued", "running", "cancelling"].includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("job timeout");
  }
  return {
    directory,
    path,
    profile,
    remote,
    sent,
    client,
    dialog,
    get service() {
      return service;
    },
    get store() {
      return store;
    },
    set selected(v) {
      selected = v;
    },
    set confirm(v) {
      confirm = v;
    },
    set failPart(v) {
      failPart = v;
    },
    set failComplete(v) {
      failComplete = v;
    },
    set headMatches(v) {
      headMatches = v;
    },
    wait,
    async upload() {
      const { jobs } = await service.invoke("uploadFiles", {
        connectionId: profile.id,
        bucket: "bucket",
        resumable: true,
        overwrite: true,
      });
      return wait(jobs[0].id);
    },
    async restart() {
      await service.dispose();
      store.close();
      store = createStore({ directory: join(directory, "data"), vault });
      service = makeService();
    },
    credentials() {
      profile = store.saveConnection({
        connection: store.getConnection(profile.id),
        credentialStorage: "session",
        credentials: { accessKeyId: "access", secretAccessKey: "secret" },
      });
    },
    async cleanup() {
      await service.dispose();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("restart requires current credentials and complete file fingerprint; same body at new path resumes without resending part1", async () => {
  const f = await fixture();
  try {
    const old = await f.upload();
    assert.equal(old.state, "failed");
    assert.equal(old.resumable, true);
    assert.equal(old.resumeAvailable, true);
    assert.equal(old.hasLocalFile, true);
    assert.equal(old.canRemove, false);
    await assert.rejects(f.service.invoke("removeJob", { id: old.id }), {
      code: "RESUME_PROTECTED",
    });
    const checkpointStore = createCheckpointStore(
      join(f.directory, "data", "upload-checkpoints"),
    );
    const [cp] = await checkpointStore.list();
    assert.deepEqual(cp.parts, [
      { number: 1, size: PART_SIZE, etag: "etag-1" },
    ]);
    const json = JSON.stringify({
      jobs: await f.service.invoke("listJobs"),
      bootstrap: await f.service.invoke("bootstrap"),
    });
    assert.ok(!json.includes("private-upload-id"));
    assert.ok(!json.includes(f.path));
    assert.ok(!json.includes("secret"));
    await assert.rejects(f.service.invoke("retryJob", { id: old.id }), {
      code: "RESELECT_REQUIRED",
    });
    await f.restart();
    assert.equal((await f.service.invoke("listJobs"))[0].resumeAvailable, true);
    await assert.rejects(f.service.invoke("resumeUpload", { id: old.id }), {
      code: "CREDENTIALS_REQUIRED",
    });
    f.credentials();
    const changed = join(f.directory, "wrong.bin");
    await writeFile(changed, Buffer.alloc(PART_SIZE * 2 + 19, 72));
    f.selected = changed;
    await assert.rejects(f.service.invoke("resumeUpload", { id: old.id }), {
      code: "FILE_MISMATCH",
    });
    f.selected = undefined;
    assert.deepEqual(await f.service.invoke("resumeUpload", { id: old.id }), {
      jobs: [],
      cancelled: true,
    });
    const moved = join(f.directory, "moved.bin");
    await writeFile(moved, Buffer.alloc(PART_SIZE * 2 + 19, 71));
    f.selected = moved;
    f.failPart = 0;
    const { jobs } = await f.service.invoke("resumeUpload", { id: old.id });
    assert.equal((await f.wait(jobs[0].id)).state, "success");
    assert.equal(f.store.getJobFile(jobs[0].id).kind, "upload");
    assert.ok(f.store.getJobFile(jobs[0].id).path.endsWith("moved.bin"));
    assert.equal(
      f.sent.filter((c) => c.kind === "UploadPartCommand" && c.number === 1)
        .length,
      1,
    );
    assert.equal(
      (await f.service.invoke("listJobs")).find((j) => j.id === old.id)
        .resumeAvailable,
      false,
    );
    assert.deepEqual(await checkpointStore.list(), []);
  } finally {
    await f.cleanup();
  }
});

test("changed connection blocks resume and remote abort; explicit discard cancellation preserves record", async () => {
  const f = await fixture();
  try {
    const job = await f.upload();
    const original = f.store.getConnection(f.profile.id);
    f.store.saveConnection({
      connection: { ...original, endpoint: "http://127.0.0.1:9001" },
      credentialStorage: "session",
    });
    await assert.rejects(f.service.invoke("resumeUpload", { id: job.id }), {
      code: "CONNECTION_CHANGED",
    });
    f.confirm = 1;
    assert.deepEqual(await f.service.invoke("discardUpload", { id: job.id }), {
      cancelled: true,
    });
    assert.equal(
      f.sent.filter((c) => c.kind === "AbortMultipartUploadCommand").length,
      0,
    );
    f.store.saveConnection({
      connection: original,
      credentialStorage: "session",
    });
    f.confirm = 1;
    assert.deepEqual(await f.service.invoke("discardUpload", { id: job.id }), {
      cancelled: true,
    });
    assert.equal((await f.service.invoke("listJobs"))[0].resumeAvailable, true);
    f.confirm = 0;
    assert.deepEqual(await f.service.invoke("discardUpload", { id: job.id }), {
      discarded: true,
    });
    assert.equal(f.remote.size, 0);
    assert.equal(
      (await f.service.invoke("listJobs"))[0].resumeAvailable,
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("ListParts pagination must exactly match checkpoint numbers sizes and ETags", async () => {
  const record = {
    bucket: "b",
    key: "k",
    uploadId: "u",
    parts: [
      { number: 1, size: PART_SIZE, etag: "one" },
      { number: 2, size: 19, etag: "two" },
    ],
  };
  let count = 0;
  await verifyRemoteParts(
    {
      async send() {
        return ++count === 1
          ? {
              Parts: [{ PartNumber: 1, Size: PART_SIZE, ETag: "one" }],
              IsTruncated: true,
              NextPartNumberMarker: "1",
            }
          : { Parts: [{ PartNumber: 2, Size: 19, ETag: "two" }] };
      },
    },
    record,
    new AbortController().signal,
  );
  assert.equal(count, 2);
  await assert.rejects(
    verifyRemoteParts(
      {
        async send() {
          return {
            Parts: [{ PartNumber: 1, Size: PART_SIZE, ETag: "changed" }],
          };
        },
      },
      record,
    ),
    { code: "PARTS_MISMATCH" },
  );
});

test("lost Complete response is recognized by private token; unverified outcome never repeats Complete", async () => {
  for (const matches of [true, false]) {
    const f = await fixture();
    try {
      f.failPart = 0;
      f.failComplete = true;
      f.headMatches = matches;
      const job = await f.upload();
      assert.equal(job.state, matches ? "success" : "failed");
      if (!matches) {
        const { jobs } = await f.service.invoke("resumeUpload", { id: job.id });
        assert.equal((await f.wait(jobs[0].id)).state, "failed");
      }
      assert.equal(
        f.sent.filter((c) => c.kind === "CompleteMultipartUploadCommand")
          .length,
        1,
      );
      assert.equal(
        f.sent.filter((c) => c.kind === "CreateMultipartUploadCommand").length,
        1,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("resume IPC only accepts job id, resumable flag must be boolean", () => {
  assert.throws(
    () => validatePayload("resumeUpload", { id: "job", uploadId: "injected" }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () =>
      validatePayload("uploadFiles", {
        connectionId: "conn",
        bucket: "b",
        resumable: "yes",
      }),
    { code: "INVALID_INPUT" },
  );
});

test("small resumable upload rejection does not create a checkpoint or multipart upload", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, "tiny");
    await assert.rejects(f.upload(), { code: "SIZE_LIMIT" });
    assert.equal(f.sent.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("native file content changed during upload blocks Complete despite equal byte size", async () => {
  const f = await fixture();
  try {
    const original = f.client.send.bind(f.client);
    f.failPart = 0;
    f.client.send = async (command) => {
      const r = await original(command);
      if (
        command.constructor.name === "UploadPartCommand" &&
        command.input.PartNumber === 1
      )
        await writeFile(f.path, Buffer.alloc(PART_SIZE * 2 + 19, 73));
      return r;
    };
    const job = await f.upload();
    assert.equal(job.state, "failed");
    assert.equal(
      f.sent.filter((c) => c.kind === "CompleteMultipartUploadCommand").length,
      0,
    );
    assert.equal(job.resumeAvailable, true);
  } finally {
    await f.cleanup();
  }
});

test("private resumable records remain recoverable after public history pruning", async () => {
  const f = await fixture();
  try {
    const job = await f.upload();
    for (let n = 0; n < 205; n++)
      f.store.saveJob({
        id: `history-${n}`,
        connectionId: f.profile.id,
        state: "success",
        direction: "download",
        key: "history",
        bucket: "bucket",
      });
    await f.restart();
    f.credentials();
    const row = (await f.service.invoke("listJobs")).find(
      (j) => j.id === job.id,
    );
    assert.equal(row?.resumeAvailable, true);
    assert.deepEqual(await f.service.invoke("discardUpload", { id: job.id }), {
      discarded: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("one checkpoint has one active owner; failed abort retains record and can retry", async () => {
  const f = await fixture();
  try {
    const job = await f.upload();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    f.dialog.showOpenDialog = async () => {
      await gate;
      return { filePaths: [f.path] };
    };
    const pending = f.service.invoke("resumeUpload", { id: job.id });
    await assert.rejects(f.service.invoke("resumeUpload", { id: job.id }), {
      code: "UPLOAD_BUSY",
    });
    await assert.rejects(f.service.invoke("discardUpload", { id: job.id }), {
      code: "UPLOAD_BUSY",
    });
    release();
    const { jobs } = await pending;
    await f.wait(jobs[0].id);
    assert.equal(
      (await f.service.invoke("listJobs")).find((j) => j.id === job.id)
        .resumeAvailable,
      false,
    );
    const send = f.client.send.bind(f.client);
    let abortFailure = true;
    f.client.send = async (command) => {
      if (
        command.constructor.name === "AbortMultipartUploadCommand" &&
        abortFailure
      )
        throw new Error("disconnect");
      return send(command);
    };
    await assert.rejects(
      f.service.invoke("discardUpload", { id: jobs[0].id }),
      { code: "MULTIPART_CLEANUP_FAILED" },
    );
    assert.equal(
      (await f.service.invoke("listJobs")).find((j) => j.id === jobs[0].id)
        .resumeAvailable,
      true,
    );
    abortFailure = false;
    assert.deepEqual(
      await f.service.invoke("discardUpload", { id: jobs[0].id }),
      { discarded: true },
    );
  } finally {
    await f.cleanup();
  }
});

test("cancel and service exit retain saved resumable parts without automatic Abort", async () => {
  for (const exit of [false, true]) {
    const f = await fixture();
    try {
      f.failPart = 0;
      const send = f.client.send.bind(f.client);
      let blocked;
      const waiting = new Promise((r) => {
        blocked = r;
      });
      f.client.send = async (command, options) => {
        if (
          command.constructor.name === "UploadPartCommand" &&
          command.input.PartNumber === 2
        ) {
          blocked();
          await new Promise((_resolve, reject) => {
            if (options.abortSignal.aborted) reject(options.abortSignal.reason);
            else
              options.abortSignal.addEventListener(
                "abort",
                () => reject(options.abortSignal.reason),
                { once: true },
              );
          });
        }
        return send(command, options);
      };
      const { jobs } = await f.service.invoke("uploadFiles", {
        connectionId: f.profile.id,
        bucket: "bucket",
        overwrite: true,
        resumable: true,
      });
      await waiting;
      if (exit) await f.service.dispose();
      else await f.service.invoke("cancelJob", { id: jobs[0].id });
      if (!exit) assert.equal((await f.wait(jobs[0].id)).state, "cancelled");
      const [r] = await createCheckpointStore(
        join(f.directory, "data", "upload-checkpoints"),
      ).list();
      assert.equal(r.parts.length, 1);
      assert.equal(r.parts[0].size, PART_SIZE);
      assert.equal(
        f.sent.filter((c) => c.kind === "AbortMultipartUploadCommand").length,
        0,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("Create response uncertainty never retries Create on resume; explicit abandon remains available", async () => {
  const f = await fixture();
  try {
    const send = f.client.send.bind(f.client);
    f.client.send = async (command, ...options) => {
      const result = await send(command, ...options);
      if (command.constructor.name === "CreateMultipartUploadCommand")
        throw new Error("lost create response");
      return result;
    };
    const job = await f.upload();
    assert.equal(job.state, "failed");
    const { jobs } = await f.service.invoke("resumeUpload", { id: job.id });
    assert.equal((await f.wait(jobs[0].id)).state, "failed");
    assert.equal(
      f.sent.filter((c) => c.kind === "CreateMultipartUploadCommand").length,
      1,
    );
    assert.deepEqual(
      await f.service.invoke("discardUpload", { id: jobs[0].id }),
      { discarded: true, localOnly: true },
    );
  } finally {
    await f.cleanup();
  }
});

test(
  "batch file preparation failures settle under the connection lock and surface every accepted or failed job",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const f = await fixture();
    let unlock;
    const gate = new Promise((resolve) => {
      unlock = resolve;
    });
    const { chmod, open } = await import("node:fs/promises");
    const denied = join(f.directory, "denied.bin"),
      good = join(f.directory, "good.bin");
    try {
      const deniedHandle = await open(denied, "w");
      await deniedHandle.truncate(PART_SIZE);
      await deniedHandle.close();
      await chmod(denied, 0);
      const goodHandle = await open(good, "w");
      await goodHandle.truncate(64 * 1024 * 1024);
      await goodHandle.close();
      f.dialog.showOpenDialog = async () => ({ filePaths: [denied, good] });
      const send = f.client.send.bind(f.client);
      f.client.send = async (command, ...options) => {
        if (command.constructor.name === "CreateMultipartUploadCommand")
          await gate;
        return send(command, ...options);
      };
      const result = await f.service.invoke("uploadFiles", {
        connectionId: f.profile.id,
        bucket: "bucket",
        overwrite: true,
        resumable: true,
      });
      assert.equal(
        result.jobs.length,
        2,
        "partial file failures must remain visible alongside accepted siblings",
      );
      await assert.rejects(
        f.service.invoke("removeConnection", { id: f.profile.id }),
        { code: "CONNECTION_BUSY" },
      );
      unlock();
      const completed = await Promise.all(
        result.jobs.map((job) => f.wait(job.id)),
      );
      const failed = completed.find((job) => job.key === "denied.bin");
      assert.equal(failed.state, "failed");
      assert.equal(failed.resumeAvailable, false);
      assert.equal(
        f.sent.filter((c) => c.kind === "CreateMultipartUploadCommand").length,
        1,
      );
    } finally {
      unlock();
      await chmod(denied, 0o600).catch(() => {});
      await f.cleanup();
    }
  },
);

test("changed or removed configuration supports explicit local-only abandonment, never creates a client or Abort", async () => {
  for (const removed of [false, true]) {
    const f = await fixture();
    try {
      const job = await f.upload();
      if (removed) f.store.removeConnection(f.profile.id);
      else
        f.store.saveConnection({
          connection: {
            ...f.store.getConnection(f.profile.id),
            endpoint: "http://127.0.0.1:9001",
          },
          credentialStorage: "session",
        });
      let confirmation;
      f.dialog.showMessageBox = async (options) => {
        confirmation = options;
        return { response: 1 };
      };
      const before = f.sent.length;
      assert.deepEqual(
        await f.service.invoke("discardUpload", { id: job.id }),
        { cancelled: true },
      );
      assert.match(confirmation.detail, /本机|本地/);
      assert.match(confirmation.detail, /人工/);
      assert.equal(
        (await f.service.invoke("listJobs")).find((j) => j.id === job.id)
          .resumeAvailable,
        true,
      );
      f.dialog.showMessageBox = async () => ({ response: 0 });
      assert.deepEqual(
        await f.service.invoke("discardUpload", { id: job.id }),
        { discarded: true, localOnly: true },
      );
      assert.equal(f.sent.length, before);
      assert.equal(f.remote.size, 1);
      assert.equal(
        (await f.service.invoke("listJobs")).find((j) => j.id === job.id)
          .resumeAvailable,
        false,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("checkpoint permission validation respects Windows ACL profiles and rejects wide POSIX modes", async () => {
  const { checkpointPermissionsSafe } =
    await import("../electron/transfers/checkpoints.js");
  assert.equal(typeof checkpointPermissionsSafe, "function");
  assert.equal(checkpointPermissionsSafe(0o666, "win32"), true);
  assert.equal(checkpointPermissionsSafe(0o600, "darwin"), true);
  assert.equal(checkpointPermissionsSafe(0o640, "darwin"), false);
  assert.equal(checkpointPermissionsSafe(0o666, "linux"), false);
});

test("remote multipart pagination rejects cycles, nonnumeric markers and empty truncated pages promptly", async () => {
  for (const markers of [
    ["1", "2", "1"],
    ["opaque"],
    [0],
    [10001],
    [true],
    ["1.5"],
  ]) {
    let calls = 0;
    await assert.rejects(
      verifyRemoteParts(
        {
          async send() {
            if (++calls > 10) throw new Error("test pagination guard");
            return {
              Parts: [],
              IsTruncated: true,
              NextPartNumberMarker: markers[(calls - 1) % markers.length],
            };
          },
        },
        { bucket: "bucket", key: "key", uploadId: "upload", parts: [] },
      ),
      { code: "PARTS_MISMATCH" },
    );
    assert.ok(calls <= 3);
  }
});

test("remote multipart pagination accepts numeric and decimal-string markers and respects cancellation", async () => {
  for (const next of [1, "1"]) {
    const seen = [];
    await verifyRemoteParts(
      {
        async send(command) {
          seen.push(command.input.PartNumberMarker);
          return seen.length === 1
            ? {
                Parts: [{ PartNumber: 1, Size: 8, ETag: "one" }],
                IsTruncated: true,
                NextPartNumberMarker: next,
              }
            : {
                Parts: [{ PartNumber: 2, Size: 5, ETag: "two" }],
                IsTruncated: false,
              };
        },
      },
      {
        bucket: "bucket",
        key: "key",
        uploadId: "upload",
        parts: [
          { number: 1, size: 8, etag: "one" },
          { number: 2, size: 5, etag: "two" },
        ],
      },
    );
    assert.deepEqual(seen, [undefined, next]);
  }
  const controller = new AbortController();
  controller.abort(new Error("cancelled before paging"));
  let calls = 0;
  await assert.rejects(
    verifyRemoteParts(
      {
        async send() {
          calls++;
          return {};
        },
      },
      { parts: [] },
      controller.signal,
    ),
    /cancelled before paging/,
  );
  assert.equal(calls, 0);
});

test("multipart cursors must be valid and increasing even when every page contains parts", async () => {
  for (const markers of [
    ["1", "2", "1"],
    ["opaque"],
    [0],
    [10001],
    [true],
    [1.5],
  ]) {
    let calls = 0;
    await assert.rejects(
      verifyRemoteParts(
        {
          async send() {
            if (++calls > 5) throw new Error("test guard");
            return {
              Parts: [{ PartNumber: calls, Size: 8, ETag: "part" }],
              IsTruncated: true,
              NextPartNumberMarker: markers[(calls - 1) % markers.length],
            };
          },
        },
        { parts: [] },
      ),
      { code: "PARTS_MISMATCH" },
    );
    assert.equal(calls, markers.length);
  }
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    verifyRemoteParts(
      {
        async send() {
          calls++;
          controller.abort(new Error("cancelled during page"));
          return { Parts: [], IsTruncated: true, NextPartNumberMarker: 1 };
        },
      },
      { parts: [] },
      controller.signal,
    ),
    /cancelled during page/,
  );
  assert.equal(calls, 1);
});

test("invalid multipart pagination releases the task slot and retains a checkpoint that can resume later", async () => {
  const f = await fixture();
  try {
    const original = await f.upload();
    const send = f.client.send.bind(f.client);
    let pages = 0;
    f.client.send = async (command, options) => {
      if (command.constructor.name === "ListPartsCommand") {
        if (++pages > 5) throw new Error("test pagination guard");
        return {
          Parts: [],
          IsTruncated: true,
          NextPartNumberMarker: pages % 2 ? "1" : "2",
        };
      }
      return send(command, options);
    };
    const failed = await f.service.invoke("resumeUpload", { id: original.id });
    const job = await f.wait(failed.jobs[0].id);
    assert.equal(job.state, "failed");
    assert.equal(job.resumeAvailable, true);
    assert.equal(pages, 1);
    f.client.send = send;
    f.failPart = 0;
    const retry = await f.service.invoke("resumeUpload", { id: job.id });
    assert.equal((await f.wait(retry.jobs[0].id)).state, "success");
    assert.equal(
      f.sent.filter((c) => c.kind === "CreateMultipartUploadCommand").length,
      1,
    );
    assert.equal(
      f.sent.filter((c) => c.kind === "AbortMultipartUploadCommand").length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
