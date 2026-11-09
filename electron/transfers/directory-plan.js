import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { fail } from "../../src/domain/errors.js";
import { storageError } from "../s3/errors.js";
import { validateDownloadKeys, MAX_FILE_BYTES } from "./download.js";

export const DIRECTORY_LIMITS = Object.freeze({
  files: 1000,
  visited: 10000,
  depth: 32,
});
function limit(rows) {
  if (rows.length > DIRECTORY_LIMITS.files)
    fail("DIRECTORY_LIMIT", "目录超过1000个文件，请选择较小的子目录。");
}
function portable(rows) {
  for (const row of rows) {
    try {
      validateDownloadKeys([row.relativePath]);
    } catch {
      row.state = "blocked";
      row.error = "此路径不能安全映射为可移植文件名。";
    }
    if (
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size > MAX_FILE_BYTES
    ) {
      row.state = "blocked";
      row.error = "文件大小未知或超过64GiB。";
    }
    if (Buffer.byteLength(row.key) > 1024) {
      row.state = "blocked";
      row.error = "完整Key超过1024字节。";
    }
  }
  // Mark both sides; choosing only the first alias would silently lose a file.
  const sorted = rows
    .map((row) => ({
      row,
      name: row.relativePath.normalize("NFC").toLowerCase(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i],
        b = sorted[j];
      if (
        a.name === b.name ||
        a.name.startsWith(b.name + "/") ||
        b.name.startsWith(a.name + "/")
      ) {
        for (const { row } of [a, b]) {
          row.state = "blocked";
          row.error = "存在大小写、Unicode或文件/目录路径冲突。";
        }
      }
    }
  }
  return rows;
}
export async function checkedRoot(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("UNSAFE_DOWNLOAD_PATH", "请选择真实目录，不能使用符号链接。");
  return realpath(directory);
}
export async function planUpload(directory, prefix) {
  const root = await checkedRoot(directory),
    rows = [];
  let visited = 0;
  async function visit(parent, relative, depth) {
    if (depth > DIRECTORY_LIMITS.depth)
      fail("DIRECTORY_LIMIT", "目录深度超过32层。");
    for await (const entry of await opendir(parent)) {
      if (++visited > DIRECTORY_LIMITS.visited)
        fail("DIRECTORY_LIMIT", "目录遍历超过10000项。");
      const path = join(parent, entry.name),
        relativePath = relative + entry.name;
      const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        await visit(path, relativePath + "/", depth + 1);
      else {
        rows.push({
          path,
          relativePath,
          key: prefix + relativePath,
          size: stat.size,
          identity: Object.fromEntries(
            ["dev", "ino", "size", "mtimeMs"].map((k) => [k, stat[k]]),
          ),
          state: stat.isFile() && !stat.isSymbolicLink() ? "ready" : "blocked",
          ...(!stat.isFile() || stat.isSymbolicLink()
            ? { error: "符号链接与特殊文件不参与传输。" }
            : {}),
        });
        limit(rows);
      }
    }
  }
  await visit(root, "", 0);
  return portable(rows);
}
export async function inspectTarget(directory, relativePath) {
  let parent = directory;
  const segments = relativePath.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    let children;
    try {
      children = await opendir(parent);
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    let visited = 0;
    for await (const child of children) {
      if (++visited > DIRECTORY_LIMITS.visited)
        fail("DIRECTORY_LIMIT", "本地目标目录超过10000项，请选择较小的目录。");
      const n = child.name;
      if (
        n !== segment &&
        n.normalize("NFC").toLowerCase() ===
          segment.normalize("NFC").toLowerCase()
      )
        fail("DOWNLOAD_COLLISION", "本地目录存在大小写或Unicode名称冲突。");
    }
    parent = join(parent, segment);
    let stat;
    try {
      stat = await lstat(parent);
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    if (
      stat.isSymbolicLink() ||
      (i < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())
    )
      fail("UNSAFE_DOWNLOAD_PATH", "本地映射包含符号链接或文件/目录冲突。");
  }
  return true;
}
export async function planDownload(client, bucket, prefix, directory) {
  const root = await checkedRoot(directory),
    rows = [],
    seen = new Set();
  let cursor,
    visited = 0;
  for (let page = 0; page < 100; page++) {
    const r = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 200,
        ContinuationToken: cursor,
      }),
    );
    for (const object of r.Contents ?? []) {
      if (++visited > DIRECTORY_LIMITS.visited)
        fail("DIRECTORY_LIMIT", "远端枚举超过10000项。");
      if (typeof object.Key !== "string" || !object.Key.startsWith(prefix))
        fail("DIRECTORY_INCOMPLETE", "服务返回了不属于当前前缀的对象。");
      if (object.Key.endsWith("/") && object.Size === 0) continue;
      rows.push({
        key: object.Key,
        relativePath: object.Key.slice(prefix.length),
        size: object.Size,
        etag: object.ETag,
        state: "ready",
      });
      limit(rows);
    }
    cursor = r.NextContinuationToken;
    if (!cursor) {
      if (r.IsTruncated)
        fail("DIRECTORY_INCOMPLETE", "远端枚举缺少下一页游标。");
      portable(rows);
      for (const row of rows.filter((x) => x.state === "ready")) {
        try {
          row.exists = await inspectTarget(root, row.relativePath);
        } catch (e) {
          row.state = "blocked";
          row.error = storageError(e).message;
        }
      }
      return rows;
    }
    if (typeof cursor !== "string" || seen.has(cursor))
      fail("DIRECTORY_INCOMPLETE", "远端分页游标重复或无效。");
    seen.add(cursor);
  }
  fail("DIRECTORY_INCOMPLETE", "远端分页超过安全读取上限。");
}
