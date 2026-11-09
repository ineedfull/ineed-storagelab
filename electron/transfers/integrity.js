import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { fail } from "../../src/domain/errors.js";
import { MAX_FILE_BYTES } from "./download.js";

export async function hashFile(path, { identity, signal } = {}) {
  signal?.throwIfAborted();
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES)
      fail("UNSAFE_LOCAL_FILE", "校验仅支持不超过64GiB的普通文件。");
    if (
      identity &&
      ["dev", "ino", "size", "mtimeMs"].some((k) => identity[k] !== before[k])
    )
      fail("FILE_CHANGED", "文件已变化，请重新选择目录。");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      digest.update(chunk);
    }
    const after = await file.stat();
    if (["size", "mtimeMs", "ctimeMs"].some((k) => before[k] !== after[k]))
      fail("FILE_CHANGED", "文件在内容校验过程中发生变化。");
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

export async function hashRemote(
  client,
  { bucket, key, size, etag, versionId, signal },
) {
  signal?.throwIfAborted();
  const result = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(etag ? { IfMatch: etag } : {}),
      ...(versionId !== undefined ? { VersionId: versionId } : {}),
    }),
    { abortSignal: signal },
  );
  try {
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_FILE_BYTES ||
      result.ContentLength !== size
    )
      fail("INTEGRITY_MISMATCH", "远端读取长度与校验快照不一致。");
    if (versionId !== undefined && result.VersionId !== versionId)
      fail("INTEGRITY_MISMATCH", "远端读取版本与校验快照不一致。");
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of result.Body) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > size)
        fail("INTEGRITY_MISMATCH", "远端校验内容超出预期长度。");
      digest.update(chunk);
    }
    if (bytes !== size) fail("INTEGRITY_MISMATCH", "远端校验内容不完整。");
    return digest.digest("hex");
  } finally {
    result.Body?.destroy?.();
  }
}
