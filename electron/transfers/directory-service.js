import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createSafeExportWriter } from "../safe-export.js";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { fail } from "../../src/domain/errors.js";
import { assertUploadPolicy } from "../../src/domain/providers.js";
import { storageError } from "../s3/errors.js";
import { captureLocalFile } from "../task-files.js";
import { planUpload, planDownload, checkedRoot } from "./directory-plan.js";
import { uploadObject } from "./upload.js";
import { downloadObject } from "./download.js";
import { hashFile, hashRemote } from "./integrity.js";

const terminal = (state) => !["ready", "queued", "running"].includes(state);
const publicEntry = ({ path, identity, directory, ...row }) =>
  structuredClone(row);
function summary(batch) {
  const { entries, ...rest } = batch;
  return {
    ...rest,
    count: entries.length,
    verified: entries.filter((x) => x.verification === "verified").length,
    skipped: entries.filter((x) => x.state === "skipped").length,
    failed: entries.filter((x) => ["failed", "blocked"].includes(x.state))
      .length,
    totalBytes: entries.reduce(
      (n, x) => n + (Number.isSafeInteger(x.size) ? x.size : 0),
      0,
    ),
  };
}
export function createDirectoryService({
  store,
  queue,
  dialog,
  capture,
  client,
  app,
  notify,
}) {
  const plans = new Map(),
    active = new Map(),
    unsavedResults = new Map();
  let timer,
    disposed = false,
    preparing = 0;
  function persist(ctx) {
    ctx.batch.updatedAt = new Date().toISOString();
    try {
      delete ctx.batch.warning;
      store.saveDirectoryBatch(ctx.batch);
      unsavedResults.delete(ctx.batch.id);
    } catch {
      ctx.batch.warning =
        "批次实际结果仍在本会话中，但本地记录保存失败，请立即导出清单。";
      if (!["running", "cancelling"].includes(ctx.batch.state)) {
        unsavedResults.set(ctx.batch.id, ctx.batch);
        if (unsavedResults.size > 20)
          unsavedResults.delete(unsavedResults.keys().next().value);
      }
    }
    notify();
  }
  function expire() {
    for (const [token, plan] of plans)
      if (plan.expiresAt < Date.now()) {
        clearTimeout(plan.expiry);
        plan.release?.();
        plans.delete(token);
      }
  }
  async function prepare(p) {
    expire();
    if (disposed) fail("SERVICE_CLOSED", "服务已关闭。");
    if (preparing || plans.size >= 2)
      fail("DIRECTORY_BUSY", "请先关闭当前预览后再选择目录。");
    preparing++;
    let release;
    try {
      const ctx = capture(p.connectionId);
      if (p.direction === "upload" && ctx.connection.readOnly)
        fail("READ_ONLY", "只读连接不能上传目录。");
      release = store.lockConnection(p.connectionId);
      const picked = await dialog.showOpenDialog({
        title: p.direction === "upload" ? "选择上传目录" : "选择目录下载位置",
        properties: [
          "openDirectory",
          ...(p.direction === "download" ? ["createDirectory"] : []),
        ],
      });
      if (picked.canceled || !picked.filePaths?.length)
        return { cancelled: true };
      const root = await checkedRoot(picked.filePaths[0]);
      const c = client(ctx);
      let entries;
      try {
        entries =
          p.direction === "upload"
            ? await planUpload(root, p.prefix)
            : await planDownload(c, p.bucket, p.prefix, root);
        if (p.direction === "upload")
          for (const entry of entries.filter((x) => x.state === "ready")) {
            try {
              await c.send(
                new HeadObjectCommand({ Bucket: p.bucket, Key: entry.key }),
              );
              entry.exists = true;
            } catch (e) {
              if (storageError(e).code !== "NOT_FOUND") throw e;
              entry.exists = false;
            }
          }
      } finally {
        c.destroy?.();
      }
      if (disposed) fail("SERVICE_CLOSED", "服务已关闭。");
      for (const entry of entries)
        if (entry.state === "ready" && entry.exists && p.conflict === "skip")
          entry.state = "skipped";
      const token = randomUUID(),
        expiresAt = Date.now() + 600000;
      const plan = { ctx, p: { ...p }, root, entries, release, expiresAt };
      plan.expiry = setTimeout(() => {
        plan.release?.();
        plans.delete(token);
      }, 600000);
      plan.expiry.unref?.();
      plans.set(token, plan);
      release = undefined;
      return {
        token,
        expiresAt,
        entries: entries.map(publicEntry),
        count: entries.length,
        totalBytes: entries.reduce(
          (n, x) => n + (Number.isSafeInteger(x.size) ? x.size : 0),
          0,
        ),
      };
    } finally {
      preparing--;
      release?.();
    }
  }
  function changed() {
    if (disposed || timer || !active.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      pump();
    }, 25);
  }
  async function runEntry(ctx, row, item, hooks) {
    const signal = AbortSignal.any([hooks.signal, ctx.controller.signal]);
    row.state = "running";
    row.verification = "pending";
    persist(ctx);
    const c = client(ctx.plan.ctx),
      { p, root } = ctx.plan;
    let transferDone = false;
    const committed = () => {
      transferDone = true;
      row.transferState = "success";
      hooks.committed();
    };
    try {
      if (p.direction === "upload") {
        store.saveJobFile(
          hooks.jobId,
          await captureLocalFile(item.path, "upload", item.identity),
        );
        const localDigest = await hashFile(item.path, {
          identity: item.identity,
          signal: signal,
        });
        await uploadObject({
          client: c,
          bucket: p.bucket,
          key: item.key,
          path: item.path,
          identity: item.identity,
          overwrite: p.conflict === "overwrite",
          signal: signal,
          onProgress: hooks.progress,
          committed,
        });
        const head = await c.send(
          new HeadObjectCommand({ Bucket: p.bucket, Key: item.key }),
          { abortSignal: signal },
        );
        row.etag = head.ETag;
        if (head.VersionId !== undefined) row.versionId = head.VersionId;
        row.localSha256 = localDigest;
        row.remoteSha256 = await hashRemote(c, {
          bucket: p.bucket,
          key: item.key,
          size: item.size,
          etag: head.ETag,
          versionId: head.VersionId,
          signal: signal,
        });
        if (row.remoteSha256 !== localDigest)
          fail(
            "INTEGRITY_MISMATCH",
            "上传已完成，但远端完整SHA-256与源文件不一致。",
          );
        row.sha256 = localDigest;
        row.checksumSource = "local-file-and-remote-full-read";
      } else {
        const head = await c.send(
          new HeadObjectCommand({ Bucket: p.bucket, Key: item.key }),
          { abortSignal: signal },
        );
        if (
          head.ContentLength !== item.size ||
          (item.etag && head.ETag !== item.etag)
        )
          fail("REMOTE_CHANGED", "远端对象在预览后发生变化，请重新选择目录。");
        row.etag = head.ETag;
        let localPath, localIdentity;
        const result = await downloadObject({
          client: c,
          bucket: p.bucket,
          key: item.key,
          localKey: item.relativePath,
          ifMatch: head.ETag,
          ...(head.VersionId !== undefined
            ? { versionId: head.VersionId }
            : {}),
          verifyIntegrity: true,
          directory: root,
          overwrite: p.conflict === "overwrite",
          signal: signal,
          onProgress: hooks.progress,
          committed,
          onLocalFile: async (path, identity) => {
            localPath = path;
            localIdentity = identity;
            store.saveJobFile(
              hooks.jobId,
              await captureLocalFile(path, "download", identity),
            );
          },
        });
        row.remoteSha256 = result.sha256;
        row.localSha256 = await hashFile(localPath, {
          identity: localIdentity,
          signal: signal,
        });
        if (row.localSha256 !== row.remoteSha256)
          fail(
            "INTEGRITY_MISMATCH",
            "文件已下载，但磁盘SHA-256与接收流不一致。",
          );
        row.sha256 = row.localSha256;
        if (result.versionId !== undefined) row.versionId = result.versionId;
        row.checksumSource = "remote-response-and-local-full-read";
      }
      row.verification = "verified";
      row.state = "success";
      return { verification: "verified", sha256: row.sha256 };
    } catch (e) {
      row.state = signal.aborted ? "cancelled" : "failed";
      row.verification = "failed";
      row.error = storageError(e).message;
      if (transferDone)
        return {
          verification: "failed",
          warning: `传输已完成，内容核验未通过：${row.error}`,
        };
      throw e;
    } finally {
      c.destroy?.();
      persist(ctx);
      changed();
    }
  }
  function pump() {
    if (disposed) return;
    for (const [id, ctx] of active) {
      const jobs = queue.list(),
        byId = new Map(jobs.map((x) => [x.id, x]));
      let dirty = false;
      for (const row of ctx.batch.entries.filter((x) => x.state === "queued")) {
        const job = byId.get(row.jobId);
        if (job && !["queued", "running", "cancelling"].includes(job.state)) {
          row.state = job.state === "success" ? "failed" : job.state;
          row.error = job.error ?? "此项未完成内容核验。";
          dirty = true;
        }
      }
      if (ctx.batch.state === "running") {
        let inFlight = ctx.batch.entries.filter((x) =>
          ["queued", "running"].includes(x.state),
        ).length;
        for (let i = 0; i < ctx.batch.entries.length && inFlight < 8; i++) {
          const row = ctx.batch.entries[i],
            item = ctx.plan.entries[i];
          if (row.state !== "ready") continue;
          try {
            const job = queue.add(
              {
                connectionId: ctx.plan.ctx.connection.id,
                connectionName: ctx.plan.ctx.connection.name,
                bucket: ctx.plan.p.bucket,
                key: item.key,
                direction: ctx.plan.p.direction,
                batchId: id,
                totalBytes: item.size,
              },
              (hooks) => runEntry(ctx, row, item, hooks),
            );
            row.jobId = job.id;
            row.state = "queued";
            inFlight++;
            dirty = true;
          } catch (e) {
            if (
              ["QUEUE_FULL", "LIMIT_REACHED", "LOCAL_FILE_BUSY"].includes(
                e.code,
              )
            )
              break;
            row.state = "failed";
            row.error = storageError(e).message;
            dirty = true;
          }
        }
      }
      if (ctx.batch.entries.every((x) => terminal(x.state))) {
        ctx.batch.state =
          ctx.batch.state === "cancelling"
            ? "cancelled"
            : ctx.batch.entries.some((x) =>
                  ["failed", "blocked", "cancelled"].includes(x.state),
                )
              ? "failed"
              : "completed";
        ctx.plan.release?.();
        ctx.plan.release = undefined;
        active.delete(id);
        dirty = true;
      }
      if (dirty) persist(ctx);
    }
  }
  return {
    prepare,
    changed,
    start({ token }) {
      expire();
      if (disposed) fail("SERVICE_CLOSED", "服务已关闭。");
      const plan = plans.get(token);
      if (!plan) fail("PLAN_EXPIRED", "预览已失效，请重新选择目录。");
      if (active.size >= 2) fail("DIRECTORY_BUSY", "最多同时运行2个目录批次。");
      if (plan.p.direction === "upload")
        assertUploadPolicy(
          plan.ctx.connection.provider,
          plan.p.conflict === "overwrite",
        );
      const batch = {
        id: randomUUID(),
        connectionId: plan.ctx.connection.id,
        connectionName: plan.ctx.connection.name,
        publicBaseUrl: plan.ctx.connection.publicBaseUrl,
        bucket: plan.p.bucket,
        prefix: plan.p.prefix,
        direction: plan.p.direction,
        conflict: plan.p.conflict,
        state: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries: plan.entries.map(publicEntry),
      };
      store.saveDirectoryBatch(batch);
      clearTimeout(plan.expiry);
      plans.delete(token);
      active.set(batch.id, { plan, batch, controller: new AbortController() });
      pump();
      return summary(batch);
    },
    discard({ token }) {
      const plan = plans.get(token);
      clearTimeout(plan?.expiry);
      plan?.release?.();
      plans.delete(token);
      return true;
    },
    list() {
      expire();
      const all = new Map(
        (store.listDirectoryBatches?.() ?? []).map((x) => [x.id, x]),
      );
      for (const [id, batch] of unsavedResults) all.set(id, batch);
      for (const [id, ctx] of active) all.set(id, ctx.batch);
      let terminalCount = 0;
      return [...all.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .filter((batch) => active.has(batch.id) || terminalCount++ < 20)
        .map(summary);
    },
    get({ id }) {
      const batch =
        active.get(id)?.batch ??
        unsavedResults.get(id) ??
        store.getDirectoryBatch?.(id);
      if (!batch) fail("NOT_FOUND", "目录批次不存在。");
      return structuredClone(batch);
    },
    cancel({ id }) {
      const ctx = active.get(id);
      if (!ctx) fail("NOT_FOUND", "目录批次已结束。");
      ctx.batch.state = "cancelling";
      ctx.controller.abort();
      for (const row of ctx.batch.entries) {
        if (row.state === "ready") row.state = "cancelled";
        if (["queued", "running"].includes(row.state)) queue.cancel(row.jobId);
      }
      persist(ctx);
      changed();
      return summary(ctx.batch);
    },
    async export(p) {
      const batch = this.get(p);
      const manifest = {
        schemaVersion: 1,
        product: "StorageLab",
        productVersion: app.getVersion(),
        ...batch,
        urlStatus: "generated-not-access-verified",
        entries: batch.entries.map((entry) => {
          const row = { ...entry };
          delete row.jobId;
          if (
            batch.publicBaseUrl &&
            !row.key.includes("\\") &&
            !row.key.split("/").some((s) => [".", ".."].includes(s))
          )
            row.url =
              batch.publicBaseUrl.replace(/\/$/, "") +
              "/" +
              row.key.split("/").map(encodeURIComponent).join("/");
          return row;
        }),
      };
      const picked = await dialog.showSaveDialog({
        title: "导出目录交付清单",
        defaultPath: "storagelab-delivery.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePath) return { cancelled: true };
      const writeExport = createSafeExportWriter({ protectedDirectories: [app.getPath("userData")] });
      await writeExport(picked.filePath, JSON.stringify(manifest, null, 2));
      return { path: picked.filePath };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const plan of plans.values()) {
        clearTimeout(plan.expiry);
        plan.release?.();
      }
      plans.clear();
      for (const ctx of active.values()) {
        ctx.controller.abort();
        for (const row of ctx.batch.entries)
          if (["ready", "queued", "running"].includes(row.state))
            row.state = "interrupted";
        ctx.batch.state = "interrupted";
        persist(ctx);
        ctx.plan.release?.();
      }
      active.clear();
    },
  };
}
