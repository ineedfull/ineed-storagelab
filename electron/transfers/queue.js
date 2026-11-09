import { randomUUID } from "node:crypto";
import { fail } from "../../src/domain/errors.js";
import { storageError } from "../s3/errors.js";
export function createQueue({ store, onChange = () => {} }) {
  const contexts = new Map(),
    active = new Set();
  let disposed = false;
  const visible = new Map();
  const removals = new Set();
  let fileRemoval = false;
  function isBusy(id) {
    const ctx = contexts.get(id);
    return Boolean(
      ctx &&
      (active.has(ctx) ||
        ["queued", "running", "cancelling"].includes(ctx.job.state)),
    );
  }
  function persist(ctx) {
    ctx.job.updatedAt = new Date().toISOString();
    try {
      store.saveJob({ ...ctx.job });
    } catch {
      ctx.job.warning = "任务实际结果已保留，但历史记录保存失败。";
    }
    visible.set(ctx.job.id, { ...ctx.job });
    onChange();
  }
  function prune() {
    const terminal = [...contexts.values()].filter(
      (c) => !["queued", "running", "cancelling"].includes(c.job.state),
    );
    for (const c of terminal.slice(0, Math.max(0, contexts.size - 200))) {
      contexts.delete(c.job.id);
      visible.delete(c.job.id);
    }
  }
  function release(ctx) {
    ctx.release?.();
    ctx.release = undefined;
  }
  function pump() {
    if (disposed) return;
    const concurrency = store.snapshot().settings.concurrency;
    for (const ctx of contexts.values()) {
      if (active.size >= concurrency) break;
      if (ctx.job.state !== "queued") continue;
      active.add(ctx);
      ctx.job.state = "running";
      ctx.controller = new AbortController();
      ctx.started = Date.now();
      persist(ctx);
      ctx.promise = Promise.resolve()
        .then(() =>
          ctx.run({
            jobId: ctx.job.id,
            signal: ctx.controller.signal,
            progress(bytes, total) {
              ctx.job.bytesTransferred = bytes;
              ctx.job.totalBytes = total;
              ctx.job.rate =
                bytes / Math.max((Date.now() - ctx.started) / 1000, 0.001);
              const now = Date.now();
              if (!ctx.lastProgressSave || now - ctx.lastProgressSave >= 100) {
                ctx.lastProgressSave = now;
                persist(ctx);
              } else {
                visible.set(ctx.job.id, { ...ctx.job });
                onChange();
              }
            },
            committed() {
              ctx.committed = true;
            },
          }),
        )
        .then(
          (result) => {
            ctx.committed = true;
            if (result) Object.assign(ctx.job, result);
            ctx.job.state = "success";
            delete ctx.job.error;
          },
          (error) => {
            if (ctx.committed) {
              ctx.job.state = "success";
              ctx.job.warning =
                error?.code === "LOCAL_FILE_BINDING_FAILED"
                  ? "操作已完成，但本地文件关联保存失败；打开文件及移到回收站不可用。"
                  : "操作已完成，后续清理未完成。";
            } else {
              ctx.job.state = ctx.controller.signal.aborted
                ? "cancelled"
                : "failed";
              if (
                ["MULTIPART_CLEANUP_FAILED", "LOCAL_CLEANUP_FAILED"].includes(
                  error?.code,
                )
              )
                ctx.job.warning = storageError(error).message;
              if (ctx.job.state === "failed")
                ctx.job.error = storageError(error).message;
            }
          },
        )
        .finally(() => {
          ctx.job.rate = 0;
          persist(ctx);
          release(ctx);
          active.delete(ctx);
          ctx.controller = undefined;
          prune();
          pump();
        });
    }
  }
  function add(fields, run, { localFile } = {}) {
    if (disposed) fail("SERVICE_CLOSED", "服务已关闭。");
    if (fileRemoval)
      fail("LOCAL_FILE_BUSY", "正在处理本地文件，请稍后再添加任务。");
    if (
      [...contexts.values()].filter((c) => c.job.state === "queued").length >=
      100
    )
      fail("QUEUE_FULL", "排队任务达到100个上限。");
    const now = new Date().toISOString();
    const ctx = {
      job: {
        ...fields,
        id: fields.id ?? randomUUID(),
        state: "queued",
        bytesTransferred: 0,
        totalBytes: fields.totalBytes ?? 0,
        rate: 0,
        createdAt: now,
        updatedAt: now,
      },
      run,
      localFile,
      release: store.lockConnection(fields.connectionId),
    };
    try {
      store.saveJob(ctx.job, { localFile });
    } catch (e) {
      release(ctx);
      throw e;
    }
    contexts.set(ctx.job.id, ctx);
    visible.set(ctx.job.id, { ...ctx.job });
    prune();
    onChange();
    queueMicrotask(pump);
    return { ...ctx.job };
  }
  function cancel(id) {
    const ctx = contexts.get(id);
    if (!ctx)
      fail("RESELECT_REQUIRED", "请重新选择文件，历史任务不保留文件授权。");
    if (ctx.committed) return { ...ctx.job };
    if (ctx.job.state === "queued") {
      ctx.job.state = "cancelled";
      persist(ctx);
      release(ctx);
      prune();
    } else if (ctx.job.state === "running") {
      ctx.job.state = "cancelling";
      persist(ctx);
      ctx.controller.abort();
    }
    return { ...ctx.job };
  }
  return {
    add,
    cancel,
    pump,
    isBusy,
    reserveRemoval(id) {
      if (isBusy(id) || removals.has(id))
        fail("JOB_BUSY", "任务仍在处理，请稍后再删除。");
      removals.add(id);
      return () => removals.delete(id);
    },
    reserveFileRemoval() {
      if (fileRemoval || active.size || [...contexts.keys()].some(isBusy))
        fail(
          "LOCAL_FILE_BUSY",
          "仍有传输任务，请等待传输停止后再移除本地文件。",
        );
      fileRemoval = true;
      return () => {
        fileRemoval = false;
      };
    },
    remove(id) {
      if (isBusy(id)) fail("JOB_BUSY", "请先停止任务，再删除记录。");
      store.removeJob(id);
      contexts.delete(id);
      visible.delete(id);
      onChange();
    },
    list() {
      const rows = store.listJobs();
      const merged = rows.map((j) => visible.get(j.id) ?? j);
      for (const j of visible.values())
        if (!merged.some((x) => x.id === j.id)) merged.unshift(j);
      return merged.slice(0, 200);
    },
    revokeConnection(id) {
      // Drop private runner/file grants, retaining public history and active contexts.
      for (const ctx of contexts.values()) {
        if (
          ctx.job.connectionId === id &&
          !["queued", "running", "cancelling"].includes(ctx.job.state)
        ) {
          ctx.run = undefined;
        }
      }
    },
    retry(id) {
      if (removals.has(id)) fail("JOB_BUSY", "此任务正在处理删除确认。");
      const ctx = contexts.get(id);
      if (ctx?.job.batchId)
        fail(
          "RESELECT_REQUIRED",
          "目录批次请重新选择目录并预览，不能单独重试旧批次任务。",
        );
      if (ctx?.job.resumable)
        fail("RESELECT_REQUIRED", "断点续传需重新授权文件，请使用恢复上传。");
      if (!ctx?.run || !["failed", "cancelled"].includes(ctx.job.state))
        fail(
          "RESELECT_REQUIRED",
          "请重新选择文件，只有本会话失败或取消任务可重试。",
        );
      return add(
        {
          connectionId: ctx.job.connectionId,
          connectionName: ctx.job.connectionName,
          bucket: ctx.job.bucket,
          key: ctx.job.key,
          direction: ctx.job.direction,
          ...(ctx.job.versionId !== undefined
            ? { versionId: ctx.job.versionId }
            : {}),
          totalBytes: ctx.job.totalBytes,
        },
        ctx.run,
        { localFile: ctx.localFile },
      );
    },
    async dispose() {
      disposed = true;
      for (const c of contexts.values())
        if (["queued", "running"].includes(c.job.state)) cancel(c.job.id);
      await Promise.allSettled([...active].map((c) => c.promise));
      contexts.clear();
    },
  };
}
