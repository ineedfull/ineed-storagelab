import {
  ListObjectVersionsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { fail } from "../../src/domain/errors.js";
import { assertObjectVersionsSupported } from "../../src/domain/providers.js";
import { storageError } from "./errors.js";

const iso = (value) => (value instanceof Date ? value.toISOString() : value);
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

/** Single-key history and version-bound operations. No version deletion or policy changes. */
export function createVersionOperations({ client, connection, versioning }) {
  async function send(command) {
    try {
      return await client.send(command);
    } catch (e) {
      throw storageError(e);
    }
  }
  const supported = () => assertObjectVersionsSupported(connection.provider);
  const api = {
    async listObjectVersions({ bucket, key, keyMarker, versionIdMarker }) {
      supported();
      const r = await send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          MaxKeys: 200,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      if (r.IsTruncated && !r.NextKeyMarker)
        fail(
          "INVALID_PAGINATION",
          "服务返回不完整的版本分页标记，请重新读取。",
        );
      const entries = [
        ...(r.Versions ?? []).map((v) => ({ ...v, deleteMarker: false })),
        ...(r.DeleteMarkers ?? []).map((v) => ({ ...v, deleteMarker: true })),
      ]
        .filter((v) => v.Key === key)
        .map((v) => ({
          key: v.Key,
          versionId: v.VersionId,
          latest: v.IsLatest === true,
          deleteMarker: v.deleteMarker,
          size: v.Size,
          etag: v.ETag,
          lastModified: iso(v.LastModified),
          storageClass: v.StorageClass,
        }))
        .sort(
          (a, b) =>
            Number(b.latest) - Number(a.latest) ||
            (Date.parse(b.lastModified) || 0) -
              (Date.parse(a.lastModified) || 0),
        );
      // Markers are opaque: MinIO may append an internal cache token to the key.
      // Preserve both verbatim; a marker unequal to Key must not truncate history.
      const nextPage = r.IsTruncated
        ? {
            keyMarker: r.NextKeyMarker,
            ...(r.NextVersionIdMarker !== undefined
              ? { versionIdMarker: r.NextVersionIdMarker }
              : {}),
          }
        : undefined;
      return { entries, nextPage, versioning: await versioning(bucket) };
    },
    async headObjectVersion({ bucket, key, versionId }) {
      supported();
      const h = await send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: versionId,
        }),
      );
      if (h.VersionId !== versionId)
        fail(
          "VERSION_MISMATCH",
          "服务返回的版本与所选版本不一致，已停止操作。",
        );
      return {
        key,
        versionId: h.VersionId,
        size: h.ContentLength,
        etag: h.ETag,
        lastModified: iso(h.LastModified),
        contentType: h.ContentType,
        metadata: h.Metadata ?? {},
        storageClass: h.StorageClass,
        retention: {
          mode: h.ObjectLockMode,
          retainUntil: iso(h.ObjectLockRetainUntilDate),
          legalHold: h.ObjectLockLegalHoldStatus,
        },
      };
    },
    async prepareVersionRestore(p) {
      supported();
      if (!p.versionId || p.versionId === "null")
        fail(
          "IMMUTABLE_VERSION_REQUIRED",
          "恢复只支持不可变的历史版本；null版本可能变化，请先下载核实。",
        );
      if ((await versioning(p.bucket)) !== "enabled")
        fail(
          "VERSIONING_REQUIRED",
          "恢复要求桶已开启版本控制；状态未知、暂停或未开启时已阻止写入。",
        );
      const h = await api.headObjectVersion(p);
      if (!Number.isSafeInteger(h.size) || h.size < 0 || h.size > 5 * 1024 ** 3)
        fail("COPY_TOO_LARGE", "恢复仅支持已知大小且不超过5GiB的数据版本。");
      if (!h.etag)
        fail("VERSION_MISMATCH", "源版本缺少ETag，无法安全确认复制条件。");
      return h;
    },
    async restoreObjectVersion(p) {
      const h = await api.prepareVersionRestore(p);
      let r;
      try {
        r = await client.send(
          new CopyObjectCommand({
            Bucket: p.bucket,
            Key: p.key,
            CopySource: `${encode(p.bucket)}/${p.key.split("/").map(encode).join("/")}?versionId=${encode(p.versionId)}`,
            CopySourceIfMatch: h.etag,
            MetadataDirective: "COPY",
            TaggingDirective: "COPY",
          }),
        );
      } catch (e) {
        if (
          e?.$metadata?.httpStatusCode === 412 ||
          e?.name === "PreconditionFailed"
        )
          fail("CONFLICT", "源版本发生变化，未完成恢复，请重新读取后核实。");
        throw storageError(e);
      }
      return {
        restored: true,
        versionId: r.VersionId,
        warning:
          "历史版本未删除。当前版本可能被并发写入再次改变；请刷新核实。新版本的ACL、加密和保留规则遵循桶默认策略。",
      };
    },
  };
  return api;
}
