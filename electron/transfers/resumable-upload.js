import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { fail } from "../../src/domain/errors.js";
export const PART_SIZE = 8 * 1024 * 1024;
export async function openFingerprint(path, identity, signal) {
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < PART_SIZE || stat.size > 64 * 1024 ** 3)
      fail(
        "SIZE_LIMIT",
        "断点续传仅支持8MiB至64GiB普通文件；小文件请使用普通上传。",
      );
    if (
      identity &&
      ["dev", "ino", "size", "mtimeMs"].some((k) => identity[k] !== stat[k])
    )
      fail("FILE_CHANGED", "所选文件已变化，请重新选择。");
    const sha256 = await hashFile(file, stat, signal);
    return { file, stat, sha256 };
  } catch (e) {
    await file.close();
    throw e;
  }
}
async function hashFile(file, original, signal) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  while (offset < original.size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, original.size - offset),
      offset,
    );
    if (!bytesRead) fail("FILE_CHANGED", "文件在读取时发生变化。");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await file.stat();
  if (
    ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(
      (k) => after[k] !== original[k],
    )
  )
    fail("FILE_CHANGED", "文件在读取时发生变化。");
  return hash.digest("hex");
}
export async function verifyRemoteParts(client, r, signal) {
  const actual = [];
  let marker;
  let pages = 0;
  do {
    signal?.throwIfAborted();
    if (++pages > 8192) fail("PARTS_MISMATCH", "服务端分片分页超出限制。");
    const page = await client.send(
      new ListPartsCommand({
        Bucket: r.bucket,
        Key: r.key,
        UploadId: r.uploadId,
        ...(marker ? { PartNumberMarker: marker } : {}),
      }),
      { abortSignal: signal },
    );
    signal?.throwIfAborted();
    for (const p of page.Parts ?? [])
      actual.push({ number: p.PartNumber, size: p.Size, etag: p.ETag });
    if (page.IsTruncated) {
      const next = page.NextPartNumberMarker;
      // S3/SDKs expose this numeric protocol cursor as a number or decimal string.
      const numeric =
        typeof next === "number" ||
        (typeof next === "string" && /^\d+$/.test(next));
      if (
        !numeric ||
        !Number.isInteger(Number(next)) ||
        Number(next) <= Number(marker ?? 0) ||
        Number(next) > 10000 ||
        !page.Parts?.length
      )
        fail("PARTS_MISMATCH", "服务端分片分页无效或没有进展。");
    }
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    if (actual.length > 8192) fail("PARTS_MISMATCH", "服务端分片数超出限制。");
  } while (marker);
  const expected = [...r.parts].sort((a, b) => a.number - b.number);
  actual.sort((a, b) => a.number - b.number);
  if (
    actual.length !== expected.length ||
    actual.some(
      (p, i) =>
        p.number !== expected[i].number ||
        p.size !== expected[i].size ||
        p.etag !== expected[i].etag,
    )
  )
    fail(
      "PARTS_MISMATCH",
      "服务端分片与本机记录不一致，不能安全续传。请放弃清理后重新上传。",
    );
}
async function resolveComplete(client, r, checkpoints, committed) {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: r.bucket, Key: r.key }),
    );
    if (
      head.ContentLength === r.size &&
      head.Metadata?.["storagelab-resume-token"] === r.token
    ) {
      committed();
      await checkpoints.remove(r.id);
      return { bytesTransferred: r.size, totalBytes: r.size };
    }
  } catch {
    /* Preserve uncertain outcome; never retry Complete or Create. */
  }
  fail(
    "UPLOAD_UNCERTAIN",
    "完成结果无法核实，已保留记录；恢复时仅核实远端结果，不会重复提交或盲目覆盖。",
  );
}
export async function resumableUpload({
  client,
  record: r,
  checkpoints,
  grant,
  signal,
  onProgress = () => {},
  committed = () => {},
  resume = false,
}) {
  try {
    if (r.phase === "completing")
      return await resolveComplete(client, r, checkpoints, committed);
    if (r.phase === "creating")
      fail(
        "UPLOAD_UNCERTAIN",
        "创建分片上传的结果不明，无法安全自动重试；请检查服务端未完成分片并放弃本机记录。",
      );
    if (grant.sha256 !== r.sha256 || grant.stat.size !== r.size)
      fail("FILE_MISMATCH", "所选文件与原上传完整指纹不一致。");
    if (r.uploadId && resume) await verifyRemoteParts(client, r, signal);
    if (!r.uploadId) {
      signal.throwIfAborted();
      r.phase = "creating";
      await checkpoints.save(r);
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: r.bucket,
          Key: r.key,
          ContentType: r.contentType,
          Metadata: { "storagelab-resume-token": r.token },
        }),
        { abortSignal: signal },
      );
      if (!created.UploadId)
        fail(
          "UPLOAD_UNCERTAIN",
          "服务未返回分片上传标识，请检查远端未完成分片。",
        );
      r.uploadId = created.UploadId;
      r.phase = "uploading";
      await checkpoints.save(r);
    }
    let bytes = r.parts.reduce((n, p) => n + p.size, 0);
    onProgress(bytes, r.size);
    for (let number = 1; number <= Math.ceil(r.size / PART_SIZE); number++) {
      signal.throwIfAborted();
      if (r.parts.some((p) => p.number === number)) continue;
      const size = Math.min(PART_SIZE, r.size - (number - 1) * PART_SIZE),
        body = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const result = await grant.file.read(
          body,
          read,
          size - read,
          (number - 1) * PART_SIZE + read,
        );
        if (!result.bytesRead) fail("FILE_CHANGED", "文件在上传时发生变化。");
        read += result.bytesRead;
      }
      const part = await client.send(
        new UploadPartCommand({
          Bucket: r.bucket,
          Key: r.key,
          UploadId: r.uploadId,
          PartNumber: number,
          Body: body,
          ContentLength: size,
        }),
        { abortSignal: signal },
      );
      if (!part.ETag) fail("PARTS_MISMATCH", "服务端未返回可靠分片标识。");
      r.parts.push({ number, size, etag: part.ETag });
      await checkpoints.save(r);
      bytes += size;
      onProgress(bytes, r.size);
    }
    signal.throwIfAborted();
    if ((await hashFile(grant.file, grant.stat, signal)) !== r.sha256)
      fail("FILE_CHANGED", "文件在上传时内容发生变化，已阻止完成。");
    r.phase = "completing";
    await checkpoints.save(r);
    try {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: r.bucket,
          Key: r.key,
          UploadId: r.uploadId,
          MultipartUpload: {
            Parts: [...r.parts]
              .sort((a, b) => a.number - b.number)
              .map((p) => ({ PartNumber: p.number, ETag: p.etag })),
          },
          ...(!r.overwrite ? { IfNoneMatch: "*" } : {}),
        }),
        { abortSignal: signal },
      );
    } catch {
      return await resolveComplete(client, r, checkpoints, committed);
    }
    committed();
    await checkpoints.remove(r.id);
    onProgress(r.size, r.size);
    return { bytesTransferred: r.size, totalBytes: r.size };
  } finally {
    await grant.file.close();
  }
}
