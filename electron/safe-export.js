import * as defaultFiles from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../src/domain/errors.js";

/**
 * Write a native-dialog export without truncating the selected inode.
 * Resolve directory aliases, protect application data, and commit only complete
 * files. This is not a sandbox against a process replacing ancestor directories.
 * Directory fsync is best effort; file fsync and atomic rename are required.
 */
export function createSafeExportWriter({ files = defaultFiles, protectedDirectories = [] } = {}) {
  const unsafe = () => new AppError('UNSAFE_EXPORT', '导出位置不安全：请选择应用数据目录以外的普通文件（不支持链接）');
  const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
  async function targetState(destination) {
    try {
      const info = await files.lstat(destination);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw unsafe();
      return info;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  return async function writeExport(selectedPath, contents) {
    const selected = path.resolve(selectedPath);
    const parent = await files.realpath(path.dirname(selected));
    const parentInfo = await files.lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw unsafe();
    const destination = path.join(parent, path.basename(selected));
    for (const directory of protectedDirectories) {
      // Host-owned data roots must exist. Fail closed if their identity is unknown.
      if (typeof directory !== 'string' || !directory) throw unsafe();
      const root = await files.realpath(directory);
      const relative = path.relative(root, destination);
      const insideData = relative === '' || (
        !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
      );
      if (insideData) throw unsafe();
    }
    const original = await targetState(destination);
    const temporary = path.join(parent, `.ineed-export-${randomUUID()}.tmp`);
    let handle;
    let temporaryInfo;
    let committed = false;
    try {
      handle = await files.open(temporary, 'wx', 0o600);
      temporaryInfo = await handle.stat();
      if (typeof contents === 'function') await contents(handle);
      else await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      // Recheck after potentially slow serialization/streaming. Never replace a
      // file that appeared/changed while exporting, or a substituted temp inode.
      const current = await targetState(destination);
      const targetChanged = original
        ? !sameIdentity(original, current) || original.mtimeMs !== current.mtimeMs || original.size !== current.size
        : current !== null;
      if (targetChanged) throw unsafe();
      if (await files.realpath(parent) !== parent || !sameIdentity(parentInfo, await files.lstat(parent))) throw unsafe();
      const written = await files.lstat(temporary);
      if (written.isSymbolicLink() || !written.isFile() || written.nlink !== 1 || !sameIdentity(temporaryInfo, written)) throw unsafe();
      await files.rename(temporary, destination);
      committed = true;
      let directory;
      try {
        directory = await files.open(parent, 'r');
        await directory.sync();
      } catch {
        // Some platforms/filesystems cannot fsync directories. The completed
        // export is already committed; do not report a false write failure.
      } finally {
        await directory?.close().catch(() => {});
      }
    } finally {
      await handle?.close().catch(() => {});
      if (!committed) await files.unlink(temporary).catch(() => {});
    }
  };
}
