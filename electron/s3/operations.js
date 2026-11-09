import {
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  GetBucketVersioningCommand,
  DeleteObjectsCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  DeleteObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fail } from "../../src/domain/errors.js";
import { storageError } from "./errors.js";
import { validateObjectTags } from "../../src/domain/object-tags.js";
import { assertObjectTagsSupported } from "../../src/domain/providers.js";
import { createVersionOperations } from "./versions.js";
import { createMutationOperations } from "./mutations.js";
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
export function createS3Operations({ client, connection }) {
  async function send(command) {
    try {
      return await client.send(command);
    } catch (e) {
      throw storageError(e);
    }
  }
  const api = {
    async getObjectTags({ bucket, key, versionId }) {
      assertObjectTagsSupported(connection.provider);
      // Some S3 implementations omit x-amz-version-id on tagging responses.
      // Resolve the current version with HEAD, then read that exact version.
      const resolved =
        versionId ??
        (await send(new HeadObjectCommand({ Bucket: bucket, Key: key })))
          .VersionId;
      const r = await send(
        new GetObjectTaggingCommand({
          Bucket: bucket,
          Key: key,
          VersionId: resolved,
        }),
      );
      const binding = resolved ?? r.VersionId;
      return {
        tags: (r.TagSet ?? []).map((t) => ({ key: t.Key, value: t.Value })),
        ...(binding !== undefined ? { versionId: binding } : {}),
      };
    },
    async saveObjectTags({ bucket, key, versionId, tags }) {
      assertObjectTagsSupported(connection.provider);
      const checked = validateObjectTags(tags);
      const target = { Bucket: bucket, Key: key, VersionId: versionId };
      await send(
        checked.length
          ? new PutObjectTaggingCommand({
              ...target,
              Tagging: {
                TagSet: checked.map((t) => ({ Key: t.key, Value: t.value })),
              },
            })
          : new DeleteObjectTaggingCommand(target),
      );
      return {
        saved: true,
        tags: checked,
        ...(versionId !== undefined ? { versionId } : {}),
      };
    },
    async listBuckets() {
      const buckets = [],
        cursors = new Set();
      let cursor;
      for (let page = 0; page < 100; page++) {
        // Do not add S3-only page-size fields to native providers that list all
        // buckets in one response. Each adapter maps its own returned cursor.
        const r = await send(
          new ListBucketsCommand(
            cursor === undefined ? {} : { ContinuationToken: cursor },
          ),
        );
        if (buckets.length + (r.Buckets ?? []).length > 10000)
          fail(
            "BUCKET_LIST_INCOMPLETE",
            "桶数量超过安全读取上限，请打开已知桶。",
          );
        buckets.push(
          ...(r.Buckets ?? []).map((b) => ({
            name: b.Name,
            creationDate: iso(b.CreationDate),
          })),
        );
        cursor = r.ContinuationToken;
        if (cursor === undefined || cursor === null || cursor === "") {
          if (r.IsTruncated === true)
            fail(
              "BUCKET_LIST_INCOMPLETE",
              "服务未返回后续桶游标，请打开已知桶。",
            );
          return { buckets };
        }
        if (typeof cursor !== "string" || cursors.has(cursor))
          fail("BUCKET_LIST_INCOMPLETE", "桶分页游标异常，请打开已知桶。");
        cursors.add(cursor);
      }
      fail("BUCKET_LIST_INCOMPLETE", "桶分页超过安全读取上限，请打开已知桶。");
    },
    async listObjects({ bucket, prefix = "", cursor }) {
      const r = await send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: "/",
          MaxKeys: 200,
          ContinuationToken: cursor,
        }),
      );
      return {
        objects: (r.Contents ?? []).map((o) => ({
          key: o.Key,
          size: o.Size,
          lastModified: iso(o.LastModified),
          etag: o.ETag,
          storageClass: o.StorageClass,
        })),
        prefixes: (r.CommonPrefixes ?? []).map((o) => o.Prefix),
        nextCursor: r.NextContinuationToken,
      };
    },
    async headObject({ bucket, key }) {
      const r = await send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key,
        size: r.ContentLength,
        lastModified: iso(r.LastModified),
        contentType: r.ContentType ?? "application/octet-stream",
        etag: r.ETag,
        metadata: r.Metadata ?? {},
        versionId: r.VersionId,
        checksum: r.ChecksumSHA256 ?? r.ChecksumCRC32C ?? r.ChecksumCRC32,
      };
    },
    async previewObject(p) {
      const h = await api.headObject(p),
        type = h.contentType.split(";")[0].trim().toLowerCase();
      const image = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
      ].includes(type);
      const text =
        (type.startsWith("text/") &&
          !["text/html", "text/xml"].includes(type)) ||
        ["application/json", "application/x-ndjson"].includes(type);
      if (!image && !text)
        fail("PREVIEW_UNSUPPORTED", "此类型不支持安全预览。");
      const limit = (image ? 8 : 2) * 1024 * 1024;
      if (h.size > limit) fail("PREVIEW_TOO_LARGE", "对象超过预览大小限制。");
      const r = await send(
        new GetObjectCommand({ Bucket: p.bucket, Key: p.key }),
      );
      const parts = [];
      let bytes = 0;
      try {
        for await (const part of r.Body) {
          bytes += part.length;
          if (bytes > limit)
            fail("PREVIEW_TOO_LARGE", "对象超过预览大小限制。");
          parts.push(Buffer.from(part));
        }
      } catch (e) {
        r.Body?.destroy?.();
        throw storageError(e);
      }
      const body = Buffer.concat(parts);
      return {
        kind: image ? "image" : "text",
        content: image
          ? `data:${type};base64,${body.toString("base64")}`
          : body.toString("utf8"),
        contentType: h.contentType,
      };
    },
    async shareObject({ bucket, key, kind, expiresIn }) {
      const warning = "生成链接不代表可访问；临时凭证可能使链接提前失效。";
      if (kind === "public") {
        if (!connection.publicBaseUrl)
          fail("PUBLIC_URL_REQUIRED", "请先配置公开基础URL。");
        if (
          key.split("/").some((s) => s === "." || s === "..") ||
          key.includes("\\")
        )
          fail("UNSAFE_PUBLIC_KEY", "此Key无法安全表示为公开URL。");
        return {
          url:
            connection.publicBaseUrl.replace(/\/$/, "") +
            "/" +
            key.split("/").map(encodeURIComponent).join("/"),
          warning: "公开链接的可访问性取决于桶策略；生成不代表可访问。",
        };
      }
      try {
        return {
          url: client.signGet
            ? await client.signGet({ bucket, key, expiresIn })
            : await getSignedUrl(
                client,
                new GetObjectCommand({ Bucket: bucket, Key: key }),
                { expiresIn },
              ),
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          warning,
        };
      } catch (e) {
        throw storageError(e);
      }
    },
    async versioning(bucket) {
      try {
        const r = await send(
          new GetBucketVersioningCommand({ Bucket: bucket }),
        );
        return r.Status === "Enabled"
          ? "enabled"
          : r.Status === "Suspended"
            ? "suspended"
            : "disabled";
      } catch {
        return "unknown";
      }
    },
    async deleteObjects({ bucket, keys }, versioning) {
      const r = await send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: false },
        }),
      );
      return {
        deleted: (r.Deleted ?? []).map((o) => o.Key),
        errors: (r.Errors ?? []).map((o) => {
          const e = storageError({ name: o.Code });
          return { key: o.Key, code: e.code, message: e.message };
        }),
        versioning,
      };
    },
  };
  return {
    ...api,
    ...createMutationOperations({ client, connection }),
    ...createVersionOperations({
      client,
      connection,
      versioning: api.versioning,
    }),
  };
}
