import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  rename,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../../src/domain/errors.js";
const fields = new Set([
  "version",
  "id",
  "jobId",
  "connectionId",
  "connectionFingerprint",
  "bucket",
  "key",
  "overwrite",
  "size",
  "sha256",
  "token",
  "parts",
  "phase",
  "contentType",
  "uploadId",
]);
const validId = (v) =>
  typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
export function connectionFingerprint(connection) {
  // Bind every public configuration field, including profile identity; never credentials.
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(connection)
            .filter(
              ([key]) => !["hasCredentials", "credentialStorage"].includes(key),
            )
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .digest("hex");
}
export function validateCheckpoint(r) {
  if (
    !r ||
    Object.keys(r).some((k) => !fields.has(k)) ||
    r.version !== 1 ||
    !validId(r.id) ||
    !validId(r.jobId) ||
    !validId(r.connectionId) ||
    !/^[a-f0-9]{64}$/.test(r.connectionFingerprint) ||
    !/^[a-f0-9]{64}$/.test(r.sha256) ||
    !/^[a-f0-9]{64}$/.test(r.token) ||
    typeof r.bucket !== "string" ||
    !r.bucket ||
    r.bucket.length > 255 ||
    typeof r.key !== "string" ||
    !r.key ||
    Buffer.byteLength(r.key) > 1024 ||
    typeof r.overwrite !== "boolean" ||
    !Number.isSafeInteger(r.size) ||
    r.size < 8388608 ||
    r.size > 64 * 1024 ** 3 ||
    typeof r.contentType !== "string" ||
    r.contentType.length > 255 ||
    !["ready", "uploading", "creating", "completing"].includes(r.phase) ||
    (r.uploadId !== undefined &&
      (typeof r.uploadId !== "string" ||
        !r.uploadId ||
        r.uploadId.length > 4096)) ||
    !Array.isArray(r.parts) ||
    r.parts.length > 8192
  )
    fail("CHECKPOINT_INVALID", "续传记录无效，已拒绝使用。");
  const seen = new Set();
  for (const p of r.parts) {
    const expected = Math.min(8388608, r.size - (p.number - 1) * 8388608);
    if (
      Object.keys(p).sort().join(",") !== "etag,number,size" ||
      !Number.isInteger(p.number) ||
      p.number < 1 ||
      expected <= 0 ||
      p.size !== expected ||
      typeof p.etag !== "string" ||
      !p.etag ||
      p.etag.length > 1024 ||
      seen.has(p.number)
    )
      fail("CHECKPOINT_INVALID", "续传分片记录无效。");
    seen.add(p.number);
  }
  if (r.parts.length && !r.uploadId)
    fail("CHECKPOINT_INVALID", "续传分片缺少上传标识。");
  return r;
}
// Windows libuv modes do not encode profile ACLs: writable files commonly
// stat as 0666 even when created with 0600. Protection there is the OS userData
// profile ACL; POSIX keeps the strict owner-only mode check.
export function checkpointPermissionsSafe(mode, platform = process.platform) {
  return platform === "win32" || (mode & 0o077) === 0;
}
export function createCheckpointStore(directory) {
  const file = (id) => {
    if (!validId(id)) fail("CHECKPOINT_INVALID", "续传记录标识无效。");
    return join(directory, `${id}.json`);
  };
  return {
    async save(record) {
      validateCheckpoint(record);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = file(record.id),
        temporary = join(directory, `.${record.id}-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
      } finally {
        await handle?.close();
        await unlink(temporary).catch(() => {});
      }
    },
    async get(id) {
      let handle;
      try {
        handle = await open(
          file(id),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.size > 4 * 1024 * 1024 ||
          !checkpointPermissionsSafe(info.mode)
        )
          fail("CHECKPOINT_INVALID", "续传记录权限或大小无效。");
        const record = validateCheckpoint(
          JSON.parse(await handle.readFile("utf8")),
        );
        if (record.id !== id)
          fail("CHECKPOINT_INVALID", "续传记录标识不一致。");
        return record;
      } catch (e) {
        if (e.code === "ENOENT") return undefined;
        if (e.code === "CHECKPOINT_INVALID") throw e;
        fail("CHECKPOINT_INVALID", "续传记录无法读取。");
      } finally {
        await handle?.close();
      }
    },
    async list() {
      let names;
      try {
        names = await readdir(directory);
      } catch (e) {
        if (e.code === "ENOENT") return [];
        throw e;
      }
      const records = [];
      for (const name of names.filter((n) =>
        /^[a-zA-Z0-9_-]+\.json$/.test(n),
      )) {
        try {
          const r = await this.get(name.slice(0, -5));
          if (r) records.push(r);
        } catch {
          /* corrupt records cannot become resume grants */
        }
      }
      return records;
    },
    async remove(id) {
      await unlink(file(id)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    },
  };
}
