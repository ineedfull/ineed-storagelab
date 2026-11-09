import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { createCheckpointStore, connectionFingerprint } from "./checkpoints.js";
import { openFingerprint, resumableUpload } from "./resumable-upload.js";
import { inferUploadContentType } from "./upload.js";
import { fail } from "../../src/domain/errors.js";
import { assertUploadPolicy } from "../../src/domain/providers.js";
import { captureLocalFile } from "../task-files.js";
const activeState = (state) =>
  ["queued", "running", "cancelling"].includes(state);
export function createResumeService({
  app,
  queue,
  store,
  dialog,
  capture,
  client,
  notify,
}) {
  let privateStore;
  function getCheckpoints() {
    if (!privateStore) {
      const directory = app?.getPath?.("userData");
      if (!directory) fail("PERSISTENCE_ERROR", "原生续传数据目录不可用。");
      privateStore = createCheckpointStore(
        join(directory, "upload-checkpoints"),
      );
    }
    return privateStore;
  }
  const checkpoints = {
    save: (record) => getCheckpoints().save(record),
    list: () => getCheckpoints().list(),
    remove: (id) => getCheckpoints().remove(id),
  };
  const reservations = new Set();
  let pendingCreates = 0;
  async function rows() {
    const jobs = queue.list();
    if (!app?.getPath)
      return jobs.map((job) => ({
        ...job,
        canRemove: !activeState(job.state),
      }));
    const records = await checkpoints.list();
    // SQLite history is bounded independently of private resumable grants. Retain
    // a public recovery entry even after unrelated task history evicts the row.
    for (const r of records)
      if (!jobs.some((j) => j.id === r.jobId))
        jobs.unshift({
          id: r.jobId,
          connectionId: r.connectionId,
          connectionName:
            store.getConnection(r.connectionId)?.name ?? "原连接已删除",
          bucket: r.bucket,
          key: r.key,
          direction: "upload",
          state: "interrupted",
          resumable: true,
          bytesTransferred: r.parts.reduce((n, p) => n + p.size, 0),
          totalBytes: r.size,
          rate: 0,
          warning: "任务历史已归档；私有续传记录仍可恢复或放弃清理。",
        });
    return jobs.map((job) => ({
      ...job,
      canRemove:
        !activeState(job.state) &&
        !reservations.has(job.id) &&
        !records.some((r) => r.jobId === job.id),
      ...(job.resumable
        ? {
            resumeAvailable:
              !activeState(job.state) &&
              records.some((r) => r.jobId === job.id) &&
              !reservations.has(job.id),
          }
        : {}),
    }));
  }
  function verifyConfiguration(r) {
    const connection = store.getConnection(r.connectionId);
    if (
      !connection ||
      connectionFingerprint(connection) !== r.connectionFingerprint
    )
      fail(
        "CONNECTION_CHANGED",
        "连接配置已变化或删除，禁止向新服务恢复或清理旧分片。请在原服务人工核实清理。",
      );
    const ctx = capture(r.connectionId);
    if (ctx.connection.readOnly)
      fail("READ_ONLY", "只读连接不能恢复或清理上传。");
    assertUploadPolicy(ctx.connection.provider, r.overwrite);
    return ctx;
  }
  async function add(r, ctx, path, identity, resume) {
    const localFile = await captureLocalFile(path, "upload", identity);
    const id = randomUUID(),
      previous = r.jobId;
    r.jobId = id;
    await checkpoints.save(r);
    try {
      return queue.add(
        {
          id,
          connectionId: r.connectionId,
          connectionName: ctx.connection.name,
          bucket: r.bucket,
          key: r.key,
          direction: "upload",
          resumable: true,
          resumeAvailable: false,
          totalBytes: r.size,
          ...(!r.uploadId && resume
            ? {
                warning:
                  "尚未建立远端上传；文件核验通过后按原覆盖策略重新开始。",
              }
            : {}),
        },
        async (hooks) => {
          // Persisted viewing references never replace reauthorization for resume.
          const grant = await openFingerprint(path, identity, hooks.signal);
          let c;
          try {
            c = client(ctx, { maxAttempts: 1 });
            return await resumableUpload({
              client: c,
              record: r,
              checkpoints,
              grant,
              ...hooks,
              onProgress: hooks.progress,
              resume,
            });
          } finally {
            if (!c) await grant.file.close();
            c?.destroy?.();
          }
        },
        { localFile },
      );
    } catch (e) {
      r.jobId = previous;
      await checkpoints.save(r);
      throw e;
    }
  }
  return {
    rows,
    async assertRemovable(id) {
      if (
        reservations.has(id) ||
        (app?.getPath && (await checkpoints.list()).some((r) => r.jobId === id))
      )
        fail(
          "RESUME_PROTECTED",
          "此任务仍有续传记录，请先放弃续传并确认分片清理，再删除任务记录。",
        );
    },
    async create(ctx, item, p) {
      pendingCreates++;
      try {
        if ((await checkpoints.list()).length + pendingCreates > 100)
          fail(
            "LIMIT_REACHED",
            "最多保留100个续传记录，请先恢复或放弃已有记录。",
          );
        const grant = await openFingerprint(item.path, item.identity);
        const sha256 = grant.sha256;
        await grant.file.close();
        const r = {
          version: 1,
          id: randomUUID(),
          jobId: randomUUID(),
          connectionId: ctx.connection.id,
          connectionFingerprint: connectionFingerprint(ctx.connection),
          bucket: p.bucket,
          key: item.key,
          overwrite: p.overwrite === true,
          size: item.size,
          sha256,
          token: randomBytes(32).toString("hex"),
          parts: [],
          phase: "ready",
          contentType: inferUploadContentType(item.path),
        };
        return await add(r, ctx, item.path, item.identity, false);
      } finally {
        pendingCreates--;
      }
    },
    async resume(id) {
      if (reservations.has(id)) fail("UPLOAD_BUSY", "此续传记录正在处理。");
      reservations.add(id);
      let release;
      try {
        const job = (await rows()).find((j) => j.id === id);
        if (!job || activeState(job.state))
          fail("UPLOAD_BUSY", "仅可恢复已停止的任务。");
        const r = (await checkpoints.list()).find((r) => r.jobId === id);
        if (!r)
          fail("RESELECT_REQUIRED", "没有有效续传记录，请重新选择文件上传。");
        const ctx = verifyConfiguration(r);
        release = store.lockConnection(r.connectionId);
        const picked = await dialog.showOpenDialog({
          title: "重新选择原上传文件（核验完整SHA256）",
          properties: ["openFile"],
        });
        if (picked.canceled || !picked.filePaths?.length)
          return { jobs: [], cancelled: true };
        if (picked.filePaths.length !== 1)
          fail("INVALID_INPUT", "恢复时请选择一个文件。");
        const path = picked.filePaths[0],
          grant = await openFingerprint(path);
        const identity = Object.fromEntries(
          ["dev", "ino", "size", "mtimeMs"].map((k) => [k, grant.stat[k]]),
        );
        try {
          if (grant.stat.size !== r.size || grant.sha256 !== r.sha256)
            fail("FILE_MISMATCH", "所选文件与原上传完整SHA256不一致。");
        } finally {
          await grant.file.close();
        }
        return { jobs: [await add(r, ctx, path, identity, true)] };
      } finally {
        release?.();
        reservations.delete(id);
        notify();
      }
    },
    async discard(id) {
      if (reservations.has(id)) fail("UPLOAD_BUSY", "此续传记录正在处理。");
      reservations.add(id);
      let release;
      try {
        const job = (await rows()).find((j) => j.id === id);
        if (!job || activeState(job.state))
          fail("UPLOAD_BUSY", "请先停止任务后再放弃续传。");
        const r = (await checkpoints.list()).find((r) => r.jobId === id);
        if (!r) fail("RESELECT_REQUIRED", "没有有效续传记录。");
        const connection = store.getConnection(r.connectionId);
        const sameConfiguration =
          connection &&
          connectionFingerprint(connection) === r.connectionFingerprint;
        // An obsolete binding may only be forgotten locally. Never acquire
        // credentials/client from the replacement endpoint to abort old parts.
        const ctx = sameConfiguration ? verifyConfiguration(r) : undefined;
        if (connection) release = store.lockConnection(r.connectionId);
        const localOnly =
          !sameConfiguration || (r.phase === "creating" && !r.uploadId);
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "放弃断点续传",
          message: localOnly
            ? `仅放弃 ${r.bucket} / ${r.key} 的本机续传记录？`
            : `放弃 ${r.bucket} / ${r.key} 的续传并清理远端分片？`,
          detail: !sameConfiguration
            ? "原连接已删除或配置已变化。本操作仅删除本机续传记录，不连接新服务，也不会清理远端分片。请在原服务人工检查并清理未完成分片。"
            : r.phase === "creating" && !r.uploadId
              ? "创建上传的响应丢失，服务未返回UploadId，无法定位或自动清理远端分片。本操作仅删除本机记录，请人工检查原服务的未完成分片；不会重新创建上传。"
              : "已完成对象不会删除；完成结果不明时请先刷新核实。",
          buttons: [localOnly ? "仅放弃本机记录" : "放弃并清理", "取消"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return { cancelled: true };
        if (r.uploadId && !localOnly) {
          const c = client(ctx, { maxAttempts: 1 });
          try {
            await c.send(
              new AbortMultipartUploadCommand({
                Bucket: r.bucket,
                Key: r.key,
                UploadId: r.uploadId,
              }),
            );
          } catch (e) {
            if (e.name !== "NoSuchUpload" && e.Code !== "NoSuchUpload")
              fail(
                "MULTIPART_CLEANUP_FAILED",
                "远端未确认分片清理，已保留续传记录，请重试。",
              );
          } finally {
            c.destroy?.();
          }
        }
        await checkpoints.remove(r.id);
        return { discarded: true, ...(localOnly ? { localOnly: true } : {}) };
      } finally {
        release?.();
        reservations.delete(id);
        notify();
      }
    },
  };
}
