import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  mkdir,
  lstat,
  realpath,
  open,
  link,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fail } from "../../src/domain/errors.js";
export const MAX_FILE_BYTES = 64 * 1024 ** 3;
export function validateDownloadKeys(keys) {
  const seen = new Set();
  for (const key of keys) {
    const segments = key.split("/");
    if (
      segments.some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          /[<>:"\\|?*\x00-\x1f]/.test(s) ||
          /[. ]$/.test(s) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
      )
    )
      fail("UNSAFE_DOWNLOAD_KEY", "所选Key无法安全映射为本地文件名。");
    const normalized = key.normalize("NFC").toLowerCase();
    if (
      seen.has(normalized) ||
      [...seen].some(
        (s) => s.startsWith(normalized + "/") || normalized.startsWith(s + "/"),
      )
    )
      fail("DOWNLOAD_COLLISION", "所选Key存在本地文件名冲突。");
    seen.add(normalized);
  }
  return keys;
}
async function rejectAlias(parent, name) {
  const normalized = name.normalize("NFC").toLowerCase();
  if (
    (await readdir(parent)).some(
      (n) => n !== name && n.normalize("NFC").toLowerCase() === normalized,
    )
  )
    fail("DOWNLOAD_COLLISION", "目标路径存在大小写或Unicode同名冲突。");
}
async function parentDirectory(directory, key) {
  if ((await lstat(directory)).isSymbolicLink())
    fail("UNSAFE_DOWNLOAD_PATH", "不允许下载到符号链接目录。");
  const root = await realpath(directory);
  let parent = root;
  const segments = key.split("/");
  segments.pop();
  for (const segment of segments) {
    await rejectAlias(parent, segment);
    parent = join(parent, segment);
    await mkdir(parent, { recursive: false }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const stat = await lstat(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("UNSAFE_DOWNLOAD_PATH", "目标路径包含符号链接或非目录。");
  }
  return parent;
}
export async function downloadObject({
  client,
  bucket,
  key,
  localKey = key,
  ifMatch,
  verifyIntegrity = false,
  versionId,
  directory,
  overwrite,
  signal,
  onProgress,
  committed = () => {},
  onLocalFile = async () => {},
}) {
  validateDownloadKeys([localKey]);
  const parent = await parentDirectory(directory, localKey);
  const target = join(parent, localKey.split("/").at(-1));
  await rejectAlias(parent, localKey.split("/").at(-1));
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      fail("UNSAFE_DOWNLOAD_PATH", "目标不是普通文件。");
    if (!overwrite) fail("ALREADY_EXISTS", "目标文件已存在，未覆盖。");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const temporary = join(parent, `.storagelab-${randomUUID()}.part`);
  let body, handle;
  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
        ...(versionId !== undefined ? { VersionId: versionId } : {}),
      }),
      { abortSignal: signal },
    );
    body = result.Body;
    if (versionId !== undefined && result.VersionId !== versionId)
      fail(
        "VERSION_MISMATCH",
        "下载响应版本与所选版本不一致，未保存目标文件。",
      );
    const total = result.ContentLength;
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_FILE_BYTES)
      fail("SIZE_LIMIT", "对象大小未知或超过64GiB限制。");
    handle = await open(temporary, "wx", 0o600);
    let bytes = 0;
    const digest = verifyIntegrity ? createHash("sha256") : undefined;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > total || bytes > MAX_FILE_BYTES)
          return callback(
            Object.assign(new Error(), { code: "INVALID_LENGTH" }),
          );
        onProgress(bytes, total);
        digest?.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(body, meter, handle.createWriteStream({ autoClose: true }), {
      signal,
    });
    if (bytes !== total)
      fail("TRUNCATED_DOWNLOAD", "下载内容长度不完整，未保存目标文件。");
    handle = undefined;
    const syncHandle = await open(temporary, "r");
    let installedIdentity;
    try {
      await syncHandle.sync();
      const stat = await syncHandle.stat();
      installedIdentity = Object.fromEntries(
        ["dev", "ino", "size", "mtimeMs", "birthtimeMs"].map((k) => [
          k,
          stat[k],
        ]),
      );
    } finally {
      await syncHandle.close();
    }
    signal.throwIfAborted();
    // Hard-link creates the destination exclusively, even if another writer won after HEAD.
    if (overwrite) {
      const stat = await lstat(target).catch((e) => {
        if (e.code === "ENOENT") return;
        throw e;
      });
      if (stat && (stat.isSymbolicLink() || !stat.isFile()))
        fail("UNSAFE_DOWNLOAD_PATH", "目标不是普通文件。");
      await rename(temporary, target);
    } else {
      try {
        await link(temporary, target);
      } catch (e) {
        if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(e.code))
          fail(
            "NO_OVERWRITE_UNSUPPORTED",
            "此文件系统不支持可靠的排他完成，已拒绝保存；可明确选择允许覆盖。",
          );
        throw e;
      }
    }
    committed();
    await onLocalFile(target, installedIdentity);
    if (!overwrite) await unlink(temporary);
    return {
      bytesTransferred: bytes,
      totalBytes: total,
      ...(digest
        ? {
            sha256: digest.digest("hex"),
            ...(result.VersionId !== undefined
              ? { versionId: result.VersionId }
              : {}),
          }
        : {}),
    };
  } finally {
    body?.destroy?.();
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((e) => {
      if (e.code !== "ENOENT")
        fail(
          "LOCAL_CLEANUP_FAILED",
          "任务已停止，但临时文件清理失败，请检查目标目录。",
        );
    });
  }
}
