import { Upload } from "@aws-sdk/lib-storage";
import {
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { fail } from "../../src/domain/errors.js";
import { MAX_FILE_BYTES } from "./download.js";
import { storageError } from "../s3/errors.js";
// Filename-inferred metadata only; preview still applies safe type and byte limits.
export function inferUploadContentType(name) {
  const extension = name.split(".").at(-1).toLowerCase();
  return (
    {
      txt: "text/plain",
      log: "text/plain",
      csv: "text/csv",
      json: "application/json",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    }[extension] ?? "application/octet-stream"
  );
}
export async function uploadObject({
  client,
  bucket,
  key,
  path,
  identity,
  overwrite,
  signal,
  onProgress,
  committed = () => {},
}) {
  // A native file grant refers to this regular file, never a later symlink replacement.
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let stream,
    uploadId,
    transferError,
    finished = false;
  const pending = new Set();
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      fail("SIZE_LIMIT", "上传只支持不超过64GiB的普通文件。");
    if (
      identity &&
      (stat.dev !== identity.dev ||
        stat.ino !== identity.ino ||
        stat.size !== identity.size ||
        stat.mtimeMs !== identity.mtimeMs)
    )
      fail("FILE_CHANGED", "所选文件已变更，请重新选择。");
    if (!overwrite) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal,
        });
        fail("ALREADY_EXISTS", "对象已存在，未覆盖。");
      } catch (e) {
        if (storageError(e).code !== "NOT_FOUND") throw e;
      }
    }
    stream = file.createReadStream({ autoClose: false });
    const tracked = {
      config: client.config,
      send(command) {
        const kind = command.constructor.name;
        const promise = client
          .send(
            command,
            kind === "AbortMultipartUploadCommand"
              ? {}
              : { abortSignal: signal },
          )
          .catch((error) => {
            if (
              kind === "AbortMultipartUploadCommand" &&
              (error?.name === "NoSuchUpload" || error?.Code === "NoSuchUpload")
            )
              return {};
            if (kind !== "AbortMultipartUploadCommand") transferError ??= error;
            throw error;
          })
          .then((result) => {
            if (
              kind === "AbortMultipartUploadCommand" &&
              command.input.UploadId === uploadId
            )
              uploadId = undefined;
            if (kind === "CreateMultipartUploadCommand")
              uploadId = result.UploadId;
            if (
              kind === "CompleteMultipartUploadCommand" ||
              kind === "PutObjectCommand"
            ) {
              finished = true;
              uploadId = undefined;
              committed();
            }
            return result;
          });
        pending.add(promise);
        promise.then(
          () => pending.delete(promise),
          () => pending.delete(promise),
        );
        return promise;
      },
    };
    const upload = new Upload({
      client: tracked,
      params: {
        Bucket: bucket,
        Key: key,
        Body: stream,
        ContentLength: stat.size,
        ContentType: inferUploadContentType(path),
        ...(!overwrite ? { IfNoneMatch: "*" } : {}),
      },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    upload.on("httpUploadProgress", (p) =>
      onProgress(p.loaded ?? 0, stat.size),
    );
    const abort = () => {
      stream.destroy(Object.assign(new Error(), { name: "AbortError" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await upload.done();
    } catch (e) {
      stream.destroy();
      await Promise.allSettled([...pending]);
      if (uploadId) {
        try {
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
            }),
          );
        } catch (cleanupError) {
          if (
            cleanupError?.name !== "NoSuchUpload" &&
            cleanupError?.Code !== "NoSuchUpload"
          )
            fail(
              "MULTIPART_CLEANUP_FAILED",
              "任务已停止，但服务未确认分片清理，请检查远端未完成分片。",
            );
        }
        uploadId = undefined;
      }
      if (!finished) {
        const failure = transferError ?? e;
        if (!overwrite && storageError(failure).code === "UNSUPPORTED")
          fail(
            "NO_OVERWRITE_UNSUPPORTED",
            "此服务不支持可靠的条件写入，已拒绝默认不覆盖上传。",
          );
        throw failure;
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
    onProgress(stat.size, stat.size);
    return { bytesTransferred: stat.size, totalBytes: stat.size };
  } finally {
    stream?.destroy();
    await file.close();
  }
}
