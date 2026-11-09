import {
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { fail } from "../../src/domain/errors.js";
import { getProvider } from "../../src/domain/providers.js";
import { validateMutation } from "../../src/domain/object-mutations.js";
import { storageError } from "./errors.js";
const fields = {
  contentType: "ContentType",
  cacheControl: "CacheControl",
  contentDisposition: "ContentDisposition",
  contentEncoding: "ContentEncoding",
  contentLanguage: "ContentLanguage",
  expires: "Expires",
  websiteRedirectLocation: "WebsiteRedirectLocation",
};
const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const encode = (v) =>
  encodeURIComponent(v).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function isOfficialAwsS3(connection) {
  if (connection.provider !== "aws") return false;
  try {
    const url = new URL(connection.endpoint);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      /^(?:s3\.amazonaws\.com|s3\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com(?:\.cn)?)$/.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
export function createMutationOperations({ client, connection }) {
  // Local MinIO RELEASE.2025-09-07 ignores both destination Copy IfNoneMatch
  // and Delete IfMatch. Keep it conservative; AWS documents both conditions.
  const capabilities = {
    conditionalCopy: isOfficialAwsS3(connection),
    conditionalDelete: isOfficialAwsS3(connection),
  };
  async function head(bucket, key) {
    const h = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      key,
      size: h.ContentLength,
      etag: h.ETag,
      lastModified: iso(h.LastModified),
      versionId: h.VersionId,
      metadata: h.Metadata ?? {},
      ...Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, iso(h[v])]),
      ),
    };
  }
  async function prepareObjectMutation({ bucket, key }) {
    const h = await head(bucket, key);
    if (
      !Number.isSafeInteger(h.size) ||
      h.size < 0 ||
      h.size > 5 * 1024 ** 3 ||
      !h.etag
    )
      fail("COPY_TOO_LARGE", "仅支持已知大小且不超过5GiB并有ETag的对象。");
    return { ...h, capabilities };
  }
  function same(a, b) {
    return (
      [
        "key",
        "size",
        "etag",
        "lastModified",
        "versionId",
        ...Object.keys(fields),
      ].every((k) => a[k] === b[k]) &&
      JSON.stringify(Object.entries(a.metadata ?? {}).sort()) ===
        JSON.stringify(Object.entries(b.metadata ?? {}).sort())
    );
  }
  async function verifyObjectMutation(p) {
    validateMutation(p);
    const h = await prepareObjectMutation(p);
    if (!same(h, p.original))
      fail("CONFLICT", "源对象已变化，请重新读取后编辑。");
    if (p.kind !== "metadata" && !p.overwrite && !capabilities.conditionalCopy)
      fail(
        "NO_OVERWRITE_UNVERIFIED",
        "此提供商尚未验证复制原子不覆盖，请明确允许覆盖。",
      );
    return h;
  }
  async function executeObjectMutation(p) {
    const h = await verifyObjectMutation(p),
      targetKey = p.kind === "metadata" ? p.key : p.targetKey;
    const input = {
      Bucket: p.bucket,
      Key: targetKey,
      CopySource: `${encode(p.bucket)}/${p.key.split("/").map(encode).join("/")}${h.versionId !== undefined ? "?versionId=" + encode(h.versionId) : ""}`,
      CopySourceIfMatch: h.etag,
      MetadataDirective: p.kind === "metadata" ? "REPLACE" : "COPY",
    };
    if (h.websiteRedirectLocation !== undefined)
      input.WebsiteRedirectLocation = h.websiteRedirectLocation;
    if (getProvider(connection.provider).tags !== "unsupported")
      input.TaggingDirective = "COPY";
    if (p.kind !== "metadata" && !p.overwrite) input.IfNoneMatch = "*";
    if (p.kind === "metadata") {
      if (capabilities.conditionalCopy) input.IfMatch = h.etag;
      for (const [k, v] of Object.entries(fields))
        if (h[k] !== undefined)
          input[v] = k === "expires" ? new Date(h[k]) : h[k];
      Object.assign(input, {
        ContentType: p.contentType,
        CacheControl: p.cacheControl,
        Metadata: p.metadata,
      });
    }
    let r;
    try {
      r = await client.send(new CopyObjectCommand(input));
    } catch (e) {
      if (
        e?.$metadata?.httpStatusCode === 412 ||
        e?.name === "PreconditionFailed"
      )
        fail("CONFLICT", "源或目标条件不满足；请刷新核实。");
      const error = storageError(e);
      if (["NETWORK_ERROR", "STORAGE_ERROR"].includes(error.code))
        fail(
          "MUTATION_UNCERTAIN",
          "复制结果不明确，可能已写入。请先刷新核实源和目标，勿盲目重试。",
        );
      throw error;
    }
    const result = {
      copied: true,
      updated: p.kind === "metadata",
      targetKey,
      versionId: r.VersionId,
      warning:
        "非事务操作；ETag不能隔离同正文并发变更。ACL、加密和保留规则遵循桶默认值；请刷新核实。",
    };
    if (p.kind !== "rename") return result;
    result.sourceRetained = true;
    if (!capabilities.conditionalDelete) {
      result.warning += " 此提供商条件删除未验证，复制成功，源保留。";
      return result;
    }
    let deleteAttempted = false;
    try {
      const target = await head(p.bucket, targetKey);
      if (
        target.size !== h.size ||
        target.etag !== r.CopyObjectResult?.ETag ||
        (r.VersionId !== undefined && target.versionId !== r.VersionId)
      )
        fail("CONFLICT", "目标核验失败");
      await verifyObjectMutation(p);
      deleteAttempted = true;
      await client.send(
        new DeleteObjectCommand({
          Bucket: p.bucket,
          Key: p.key,
          IfMatch: h.etag,
        }),
      );
      result.renamed = true;
      result.sourceRetained = false;
    } catch {
      if (deleteAttempted) {
        delete result.sourceRetained;
        result.sourceDeletionUncertain = true;
      }
      result.warning +=
        " 复制成功，但源删除失败或核验冲突；源可能保留，请分别刷新源与目标，勿重试整个重命名。";
    }
    return result;
  }
  return { prepareObjectMutation, verifyObjectMutation, executeObjectMutation };
}
