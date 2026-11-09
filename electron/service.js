import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import { lstat, writeFile } from "node:fs/promises";
import { METHODS, validatePayload } from "./ipc.js";
import { fail, AppError } from "../src/domain/errors.js";
import { createProviderClient } from "./providers/client.js";
import { createS3Operations } from "./s3/operations.js";
import { storageError } from "./s3/errors.js";
import { sameObjectTags } from "../src/domain/object-tags.js";
import {
  assertObjectTagsSupported,
  assertUploadPolicy,
  assertObjectVersionsSupported,
} from "../src/domain/providers.js";
import { createQueue } from "./transfers/queue.js";
import { createDirectoryService } from "./transfers/directory-service.js";
import { createResumeService } from "./transfers/resume-service.js";
import {
  captureLocalFile,
  createTaskActions,
  localFileState,
} from "./task-files.js";
import { uploadObject } from "./transfers/upload.js";
import {
  downloadObject,
  validateDownloadKeys,
  MAX_FILE_BYTES,
} from "./transfers/download.js";
export function createService({
  store,
  dialog,
  clipboard,
  shell,
  app,
  vaultAvailable = false,
  clientFactory = createProviderClient,
}) {
  const events = new EventEmitter();
  let directories;
  const notify = () => {
    events.emit("change");
    directories?.changed();
  };
  const queue = createQueue({ store, onChange: notify });
  let closed = false;
  function capture(id) {
    const connection = store.getConnection(id);
    if (!connection) fail("NOT_FOUND", "连接不存在。");
    const credentials = store.getCredentials(id);
    if (!credentials) fail("CREDENTIALS_REQUIRED", "请重新填写连接凭证。");
    return {
      connection: { ...connection },
      credentials: { ...credentials },
      settings: { ...store.snapshot().settings },
    };
  }
  function client(ctx, options) {
    return clientFactory(
      ctx.connection,
      ctx.credentials,
      ctx.settings,
      options,
    );
  }
  async function operation(p, callback, options) {
    const ctx = capture(p.connectionId),
      c = client(ctx, options);
    const release = store.lockConnection?.(p.connectionId);
    try {
      return await callback(
        createS3Operations({ client: c, connection: ctx.connection }),
        ctx,
      );
    } finally {
      c.destroy?.();
      release?.();
    }
  }
  function writable(ctx) {
    if (ctx.connection.readOnly)
      fail("READ_ONLY", "此连接为只读，已阻止写入操作。");
  }
  const resumable = createResumeService({
    app,
    queue,
    store,
    dialog,
    capture,
    client,
    notify,
  });
  const taskActions = createTaskActions({
    store,
    queue,
    shell,
    dialog,
    assertRemovable: (id) => resumable.assertRemovable(id),
  });
  directories = createDirectoryService({
    store,
    queue,
    dialog,
    capture,
    client,
    app,
    notify,
  });
  async function jobRows() {
    const jobs = await resumable.rows();
    return Promise.all(
      jobs.map(async (job) => {
        const state = await localFileState(store.getJobFile?.(job.id));
        return {
          ...job,
          hasLocalFile: state === "available",
          localFileState: state,
        };
      }),
    );
  }
  async function transfer(p, direction) {
    const ctx = capture(p.connectionId);
    if (p.versionId !== undefined)
      assertObjectVersionsSupported(ctx.connection.provider);
    if (direction === "upload") {
      writable(ctx);
      assertUploadPolicy(ctx.connection.provider, p.overwrite);
    }
    const release = store.lockConnection?.(p.connectionId);
    try {
      const picked = await dialog.showOpenDialog({
        title: direction === "upload" ? "选择要上传的文件" : "选择下载目录",
        properties:
          direction === "upload"
            ? ["openFile", "multiSelections"]
            : ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths?.length)
        return { jobs: [], cancelled: true };
      const items = [];
      if (direction === "upload") {
        for (const path of picked.filePaths) {
          const stat = await lstat(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > MAX_FILE_BYTES
          )
            fail("SIZE_LIMIT", "请选择不超过64GiB的普通文件。");
          if (p.resumable && stat.size < 8 * 1024 * 1024)
            fail(
              "SIZE_LIMIT",
              "断点续传仅支持8MiB至64GiB普通文件；小文件请使用普通上传。",
            );
          const key = (p.prefix ?? "") + basename(path);
          if (Buffer.byteLength(key) > 1024)
            fail("INVALID_INPUT", "Key超过1024字节限制。");
          items.push({
            path,
            key,
            identity: {
              dev: stat.dev,
              ino: stat.ino,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            },
            size: stat.size,
          });
        }
        if (new Set(items.map((i) => i.key)).size !== items.length)
          fail("UPLOAD_COLLISION", "所选文件生成相同Key，请分别选择。");
      } else {
        validateDownloadKeys(p.keys);
        for (const key of p.keys)
          items.push({
            key,
            directory: picked.filePaths[0],
            ...(p.versionId !== undefined ? { versionId: p.versionId } : {}),
          });
      }
      const queued = queue.list().filter((j) => j.state === "queued").length;
      if (queued + items.length > 100)
        fail("QUEUE_FULL", "排队任务不能超过100个。");
      for (const item of items)
        if (direction === "upload")
          item.localFile = await captureLocalFile(
            item.path,
            "upload",
            item.identity,
          );
      const prepared = await Promise.allSettled(
        items.map(async (item) =>
          direction === "upload" && p.resumable
            ? resumable.create(ctx, item, p)
            : queue.add(
                {
                  connectionId: ctx.connection.id,
                  connectionName: ctx.connection.name,
                  bucket: p.bucket,
                  key: item.key,
                  direction,
                  ...(item.versionId !== undefined
                    ? { versionId: item.versionId }
                    : {}),
                  totalBytes: item.size ?? 0,
                },
                async (hooks) => {
                  const c = client(ctx);
                  try {
                    return await (
                      direction === "upload" ? uploadObject : downloadObject
                    )({
                      client: c,
                      bucket: p.bucket,
                      ...item,
                      overwrite: p.overwrite === true,
                      signal: hooks.signal,
                      onProgress: hooks.progress,
                      committed: hooks.committed,
                      onLocalFile: async (path, identity) => {
                        try {
                          store.saveJobFile(
                            hooks.jobId,
                            await captureLocalFile(path, "download", identity),
                          );
                        } catch {
                          fail(
                            "LOCAL_FILE_BINDING_FAILED",
                            "本地文件关联保存失败。",
                          );
                        }
                      },
                    });
                  } finally {
                    c.destroy?.();
                  }
                },
                { localFile: item.localFile },
              ),
        ),
      );
      // Keep the batch connection grant until every native file preparation has
      // settled. A failed picker file must not release it while a sibling hashes.
      // Represent per-file preparation failures in task history so accepted jobs
      // are always returned, instead of hiding a partially accepted batch.
      const jobs = prepared.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        if (!(direction === "upload" && p.resumable)) throw result.reason;
        const item = items[index];
        return queue.add(
          {
            connectionId: ctx.connection.id,
            connectionName: ctx.connection.name,
            bucket: p.bucket,
            key: item.key,
            direction,
            resumable: true,
            resumeAvailable: false,
            totalBytes: item.size,
          },
          async () => {
            throw result.reason;
          },
        );
      });
      return { jobs };
    } finally {
      release?.();
    }
  }
  async function invoke(method, p = {}) {
    if (closed) fail("SERVICE_CLOSED", "服务已关闭。");
    if (!METHODS.includes(method)) fail("UNKNOWN_METHOD", "未知操作。");
    validatePayload(method, p);
    for (const key of [p.key, p.prefix, ...(p.keys ?? [])])
      if (typeof key === "string" && Buffer.byteLength(key, "utf8") > 1024)
        fail("INVALID_INPUT", "Key或Prefix超过1024字节限制。");
    try {
      let result;
      switch (method) {
        case "prepareDirectory":
          return await directories.prepare(p);
        case "startDirectory":
          return directories.start(p);
        case "discardDirectoryPlan":
          return directories.discard(p);
        case "listDirectoryBatches":
          return directories.list();
        case "getDirectoryBatch":
          return directories.get(p);
        case "cancelDirectory":
          return directories.cancel(p);
        case "exportDirectory":
          return await directories.export(p);
        case "bootstrap":
          return {
            ...store.snapshot(),
            jobs: await jobRows(),
            app: {
              name: app.getName(),
              version: app.getVersion(),
              runtime: `Electron ${process.versions.electron ?? "test"} / Node ${process.versions.node}`,
              dataDirectory: app.getPath("userData"),
              native: true,
              vaultAvailable:
                typeof vaultAvailable === "function"
                  ? vaultAvailable()
                  : vaultAvailable,
            },
          };
        case "saveConnection":
          result = store.saveConnection(p);
          if (p.connection.id) queue.revokeConnection(p.connection.id);
          break;
        case "removeConnection":
          result = store.removeConnection(p.id);
          queue.revokeConnection(p.id);
          break;
        case "saveSettings":
          result = store.saveSettings(p);
          queue.pump();
          break;
        case "listJobs":
          return jobRows();
        case "removeJob":
          return taskActions.remove(p.id);
        case "openJobFile":
          return taskActions.open(p.id);
        case "revealJobFile":
          return taskActions.reveal(p.id);
        case "cancelJob":
          return queue.cancel(p.id);
        case "retryJob":
          // A successful profile save/removal revokes both upload and download grants.
          return queue.retry(p.id);
        case "copyText":
          clipboard.writeText(p.text);
          return true;
        case "openWebsite":
          try {
            await shell.openExternal("https://www.ineedfull.com");
            return true;
          } catch {
            fail("OPEN_FAILED", "无法打开官网。");
          }
          break;
        case "exportJobs": {
          const picked = await dialog.showSaveDialog({
            title: "导出任务记录",
            defaultPath: "storagelab-jobs.json",
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (picked.canceled || !picked.filePath) return { cancelled: true };
          await writeFile(
            picked.filePath,
            JSON.stringify(await jobRows(), null, 2),
            { mode: 0o600 },
          );
          return { path: picked.filePath };
        }
        case "checkConnection":
          return operation(p, async (s) => {
            const bucket =
              p.bucket ?? store.getConnection(p.connectionId).defaultBucket;
            if (bucket) {
              await s.listObjects({ bucket });
              return {
                scope: "bucket",
                status: "success",
                message: "指定桶的对象列表可访问。",
              };
            }
            await s.listBuckets();
            return {
              scope: "account",
              status: "success",
              message: "桶列表可访问；列桶权限不代表对象读写权限。",
            };
          });
        case "listBuckets":
        case "listObjects":
        case "headObject":
        case "listObjectVersions":
        case "headObjectVersion":
        case "getObjectTags":
        case "previewObject":
        case "shareObject":
          return operation(p, (s) => s[method](p));
        case "prepareObjectMutation":
          return operation(p, (s) => s.prepareObjectMutation(p), {
            maxAttempts: 1,
          });
        case "executeObjectMutation":
          return operation(
            p,
            async (s, ctx) => {
              writable(ctx);
              await s.verifyObjectMutation(p);
              const { response } = await dialog.showMessageBox({
                type: "warning",
                title: "确认对象变更",
                message: `${ctx.connection.name} / ${p.bucket}：${p.kind}`,
                detail: `源Key：${p.key}\n目标Key：${p.kind === "metadata" ? p.key : p.targetKey}\n允许覆盖：${p.overwrite === true ? "是" : "否"}\n\n此操作不是事务；重命名为复制后条件删除，失败可能保留两个对象。ETag不能隔离同正文并发更新。新对象ACL、加密和保留规则遵循桶默认配置。网络错误可能发生在写入之后；先刷新核实，勿盲目重试。`,
                buttons: ["执行变更", "取消"],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
              });
              if (response !== 0) return { cancelled: true };
              return s.executeObjectMutation(p);
            },
            { maxAttempts: 1 },
          );
        case "restoreObjectVersion":
          return operation(
            p,
            async (s, ctx) => {
              writable(ctx);
              await s.prepareVersionRestore(p);
              const { response } = await dialog.showMessageBox({
                type: "warning",
                title: "确认恢复历史版本",
                message: `${ctx.connection.name} / ${p.bucket}：将历史内容恢复为当前对象？`,
                detail: `Key：${p.key}\n源版本：${p.versionId}\n\n此操作将覆盖当前可见内容并创建新版本，保留已有历史及删除标记。没有目标原子条件写保护，并发写入仍可能成为最新。复制内容、Metadata与标签；ACL、加密、保留规则采用桶默认配置，不继承旧规则。网络错误可能发生在写入后，请重新读取核实，勿盲目重复恢复。`,
                buttons: ["恢复为当前对象", "取消"],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
              });
              if (response !== 0) return { cancelled: true };
              return s.restoreObjectVersion(p);
            },
            { maxAttempts: 1 },
          );
        case "saveObjectTags":
          return operation(p, async (s, ctx) => {
            writable(ctx);
            assertObjectTagsSupported(ctx.connection.provider);
            const { response } = await dialog.showMessageBox({
              type: "warning",
              title: p.tags.length ? "确认替换对象标签" : "确认清空对象标签",
              message: `${ctx.connection.name} / ${p.bucket}：${p.tags.length ? `替换为${p.tags.length}个标签` : "清空全部标签"}？`,
              detail: `Key：${p.key}\n版本：${p.versionId ?? "当前对象（未绑定版本）"}\n\n保存会替换整组标签。保存前检查远端标签变化，但S3标签接口不提供原子条件写；检查后仍可能发生并发修改。`,
              buttons: [p.tags.length ? "替换标签" : "清空标签", "取消"],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            });
            if (response !== 0) return { cancelled: true };
            const current = await s.getObjectTags(p);
            if (
              !sameObjectTags(current.tags, p.originalTags) ||
              (p.versionId === undefined &&
                current.versionId !== undefined &&
                current.versionId !== "null")
            )
              fail(
                "CONFLICT",
                "远端标签或对象版本已变化，请重新读取标签后再编辑。",
              );
            return s.saveObjectTags(p);
          });
        case "deleteObjects":
          return operation(p, async (s, ctx) => {
            writable(ctx);
            const versioning = await s.versioning(p.bucket);
            const { response } = await dialog.showMessageBox({
              type: "warning",
              title: "确认删除当前对象",
              message: `桶 ${p.bucket}：删除 ${p.keys.length} 个当前对象？`,
              detail: `版本状态：${versioning}。可能生成删除标记；本操作不保证永久删除历史版本。\n\n${p.keys.join("\n")}`,
              buttons: ["删除当前对象", "取消"],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            });
            if (response !== 0)
              return { deleted: [], errors: [], versioning, cancelled: true };
            return s.deleteObjects(p, versioning);
          });
        case "resumeUpload":
          return resumable.resume(p.id);
        case "discardUpload":
          return resumable.discard(p.id);
        case "uploadFiles":
          return transfer(p, "upload");
        case "downloadFiles":
          return transfer(p, "download");
        case "downloadObjectVersion":
          return transfer({ ...p, keys: [p.key] }, "download");
      }
      notify();
      return result;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw storageError(e);
    }
  }
  return {
    invoke,
    onChange(callback) {
      events.on("change", callback);
      return () => events.off("change", callback);
    },
    async dispose() {
      closed = true;
      directories.dispose();
      await queue.dispose();
      events.removeAllListeners();
    },
  };
}
