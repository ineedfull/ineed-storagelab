import { lstat, realpath } from "node:fs/promises";
import { AppError, fail } from "../src/domain/errors.js";

const IDENTITY_FIELDS = ["dev", "ino", "size", "mtimeMs", "birthtimeMs"];
const activeState = (state) =>
  ["queued", "running", "cancelling"].includes(state);

// Only native pickers and successfully installed downloads call this function.
// A viewing reference does not grant permission to resume an upload.
export async function captureLocalFile(path, kind, expectedIdentity) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("LOCAL_FILE_CHANGED", "本地文件已变化，请重新选择文件。");
  if (
    expectedIdentity &&
    Object.keys(expectedIdentity).some((k) => stat[k] !== expectedIdentity[k])
  )
    fail("LOCAL_FILE_CHANGED", "本地文件已变化，请重新选择文件。");
  const canonical = await realpath(path);
  const current = await lstat(canonical);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    IDENTITY_FIELDS.some((k) => current[k] !== stat[k])
  )
    fail("LOCAL_FILE_CHANGED", "本地文件已变化，请重新选择文件。");
  return {
    path: canonical,
    kind,
    identity: Object.fromEntries(IDENTITY_FIELDS.map((k) => [k, stat[k]])),
  };
}

// Presence is derived from the saved final location, never from the existence of
// the database row. Viewing an edited file is allowed; trashing still checks the
// original identity below so a changed/replaced file cannot be removed silently.
export async function localFileState(file) {
  if (!file) return "untracked";
  try {
    const stat = await lstat(file.path);
    return stat.isFile() &&
      !stat.isSymbolicLink() &&
      (await realpath(file.path)) === file.path
      ? "available"
      : "unsafe";
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes(error.code)
      ? "missing"
      : "unavailable";
  }
}

async function existingPath(file) {
  const state = await localFileState(file);
  if (state === "missing")
    fail(
      "LOCAL_FILE_MISSING",
      "下载时记录的位置已找不到本地文件，可能已被移动或删除。请刷新任务后查看。",
    );
  if (state !== "available")
    fail(
      "LOCAL_FILE_CHANGED",
      "记录的本地位置已不可访问或不是普通文件，请检查文件所在目录。",
    );
  return file.path;
}

async function checkedPath(file) {
  try {
    const stat = await lstat(file.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(file.path)) !== file.path ||
      IDENTITY_FIELDS.some((k) => stat[k] !== file.identity[k])
    )
      throw new Error("changed");
    return file.path;
  } catch {
    fail(
      "LOCAL_FILE_CHANGED",
      "本地文件已移动、删除或发生变化，已停止文件操作；仍可仅删除任务记录。",
    );
  }
}

export function createTaskActions({
  store,
  queue,
  shell,
  dialog,
  assertRemovable,
}) {
  function job(id) {
    const value = queue.list().find((j) => j.id === id);
    if (!value) fail("NOT_FOUND", "任务记录不存在，请刷新任务。");
    if (activeState(value.state) || queue.isBusy(id))
      fail("JOB_BUSY", "请等待任务停止后再操作本地文件或删除记录。");
    return value;
  }
  function binding(id) {
    const file = store.getJobFile(id);
    if (!file)
      fail(
        "LOCAL_FILE_UNAVAILABLE",
        "此任务未保存本地文件位置；可仅删除任务记录。",
      );
    return file;
  }
  async function open(id) {
    job(id);
    const path = await existingPath(binding(id));
    try {
      const error = await shell.openPath(path);
      if (error) throw new Error("open failed");
    } catch {
      fail(
        "LOCAL_OPEN_FAILED",
        "无法打开本地文件，请检查默认应用或使用打开所在目录。",
      );
    }
    return true;
  }
  async function reveal(id) {
    job(id);
    const path = await existingPath(binding(id));
    try {
      await shell.showItemInFolder(path);
    } catch {
      fail("LOCAL_OPEN_FAILED", "无法打开文件所在目录，请检查系统文件管理器。");
    }
    return true;
  }
  async function remove(id) {
    const release = queue.reserveRemoval(id);
    let releaseFiles;
    try {
      const value = job(id);
      await assertRemovable(id);
      const file = store.getJobFile(id);
      const fileState = await localFileState(file);
      const canTrash = fileState === "available";
      const kind = file?.kind === "upload" ? "上传源文件" : "下载文件";
      const { response, checkboxChecked } = await dialog.showMessageBox({
        type: "warning",
        title: "删除任务记录",
        message: `删除 ${value.key || "此任务"} 的记录？`,
        detail:
          fileState === "missing"
            ? `下载或上传时记录的位置已找不到本地文件，仅删除任务记录。\n${file.path}\n远端对象不会删除。`
            : file && !canTrash
              ? "记录的本地位置已不可访问或不是普通文件，仅删除任务记录。远端对象不会删除。"
              : file
                ? `默认保留本地${kind}。勾选后，该文件将移到系统回收站，远端对象不受影响。\n${file.path}${file.kind === "upload" ? "\n移除上传源文件也会影响本机其他使用它的程序。" : ""}`
                : "此任务未保存本地文件位置，仅删除任务记录。远端对象不会删除。",
        ...(canTrash
          ? {
              checkboxLabel: `同时将本地${kind}移到回收站`,
              checkboxChecked: false,
            }
          : {}),
        buttons: ["删除记录", "取消"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return { cancelled: true };
      job(id);
      await assertRemovable(id);
      let localFileTrashed = false;
      if (canTrash && checkboxChecked === true) {
        // Briefly exclude all new transfers. This also protects queued downloads
        // whose destination has not yet produced a local file reference.
        releaseFiles = queue.reserveFileRemoval();
        const path = await checkedPath(file);
        try {
          await shell.trashItem(path);
        } catch {
          fail(
            "LOCAL_TRASH_FAILED",
            "本地文件未能移到回收站，任务记录已保留；可重试或仅删除记录。",
          );
        }
        localFileTrashed = true;
      }
      try {
        queue.remove(id);
      } catch (error) {
        if (localFileTrashed)
          throw new AppError(
            "LOCAL_RECORD_DELETE_FAILED",
            "本地文件已移到回收站，但任务记录删除失败；请刷新后仅删除记录。",
          );
        throw error;
      }
      return {
        removed: true,
        localFileTrashed,
        ...(fileState === "missing" ? { localFileMissing: true } : {}),
      };
    } finally {
      releaseFiles?.();
      release();
    }
  }
  return { open, reveal, remove };
}
