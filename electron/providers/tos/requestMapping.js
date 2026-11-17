// Convert internal commands into native wire parameters; no requests are started here.
import { unsupported, metadataHeaders } from "./schema.js";

export function buildRequest(name, i, { timeout, region }) {
  const p = {
    method: "GET",
    bucket: i.Bucket,
    object: i.Key,
    headers: {},
    query: {},
    successStatuses: [200],
    timeout,
  };
  let root;
  const query = (k, v) => {
    if (v !== undefined) p.query[k] = v;
  };
  const doc = (r, v) => {
    p.content = v;
    p.headers["content-type"] = "application/json";
  };
  query("versionId", i.VersionId);
  for (const [k, h] of Object.entries(metadataHeaders))
    if (
      i[k] !== undefined &&
      (k !== "ContentLength" ||
        ["PutObject", "UploadPart"].includes(name))
    )
      p.headers[h] = i[k] instanceof Date ? i[k].toUTCString() : i[k];
  for (const [k, v] of Object.entries(i.Metadata ?? {}))
    p.headers[`x-tos-meta-${k}`] = v;
  if (i.Tagging !== undefined && typeof i.Tagging === "string")
    p.headers["x-tos-tagging"] = i.Tagging;
  for (const k of [
    "IfMatch",
    "IfNoneMatch",
    "IfModifiedSince",
    "IfUnmodifiedSince",
  ])
    if (i[k] !== undefined)
      p.headers[k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()] =
        i[k] instanceof Date ? i[k].toUTCString() : i[k];
  switch (name) {
    case "ListBuckets":
      query("max-keys", i.MaxBuckets);
      query("marker", i.ContinuationToken);
      query("prefix", i.Prefix);
      root = true;
      break;
    case "ListObjectsV2":
      query("list-type", 2);
      for (const [k, v] of Object.entries({
        prefix: i.Prefix,
        delimiter: i.Delimiter,
        "max-keys": i.MaxKeys,
        "continuation-token": i.ContinuationToken,
        "start-after": i.StartAfter,
      }))
        query(k, v);
      root = true;
      break;
    case "HeadObject":
      p.method = "HEAD";
      break;
    case "GetObject":
      p.customResponse = true;
      p.successStatuses = [200, 206];
      if (i.Range) p.headers.range = i.Range;
      break;
    case "GetBucketVersioning":
      query("versioning", "");
      root = true;
      break;
    case "ListObjectVersions":
      query("versions", "");
      for (const [k, v] of Object.entries({
        prefix: i.Prefix,
        delimiter: i.Delimiter,
        "max-keys": i.MaxKeys,
        "key-marker": i.KeyMarker,
        "version-id-marker": i.VersionIdMarker,
      }))
        query(k, v);
      root = true;
      break;
    case "GetObjectTagging":
      query("tagging", "");
      root = true;
      break;
    case "PutObjectTagging":
      p.method = "PUT";
      query("tagging", "");
      doc("Tagging", { TagSet: { Tags: i.Tagging?.TagSet ?? [] } });
      break;
    case "DeleteObjectTagging":
      p.method = "DELETE";
      query("tagging", "");
      p.successStatuses = [200, 204];
      break;
    case "DeleteObjects":
      p.method = "POST";
      query("delete", "");
      if (
        Object.keys(i.Delete ?? {}).some(
          (k) => !["Objects", "Quiet"].includes(k),
        )
      )
        throw unsupported("Delete fields");
      for (const o of i.Delete?.Objects ?? [])
        if (
          Object.keys(o).some(
            (k) => !["Key", "VersionId"].includes(k),
          )
        )
          throw unsupported("conditional deletion");
      doc("Delete", {
        Quiet: !!i.Delete?.Quiet,
        Objects: i.Delete?.Objects ?? [],
      });
      root = true;
      break;
    case "CopyObject":
      if (
        typeof i.CopySource !== "string" ||
        /[\r\n]/.test(i.CopySource) ||
        (i.CopySource.includes("?") &&
          !/^[^?]+\?versionId=[^?&]*$/.test(i.CopySource))
      )
        throw unsupported("ambiguous CopySource");
      p.method = "PUT";
      p.headers["x-tos-copy-source"] = i.CopySource?.startsWith("/")
        ? i.CopySource
        : `/${i.CopySource}`;
      for (const k of [
        "IfMatch",
        "IfNoneMatch",
        "IfModifiedSince",
        "IfUnmodifiedSince",
      ]) {
        const v = i[`CopySource${k}`];
        if (v !== undefined)
          p.headers[
            `x-tos-copy-source-${k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`
          ] = v instanceof Date ? v.toUTCString() : v;
      }
      if (i.MetadataDirective)
        p.headers["x-tos-metadata-directive"] = i.MetadataDirective;
      if (i.TaggingDirective) {
        // Native TOS directive values retain the uppercase protocol form.
        const directive = { COPY: "COPY", REPLACE: "REPLACE" }[
          i.TaggingDirective
        ];
        if (!directive) throw unsupported("TaggingDirective");
        p.headers["x-tos-tagging-directive"] = directive;
      }
      root = true;
      break;
    case "DeleteObject":
      p.method = "DELETE";
      p.successStatuses = [200, 204];
      break;
    case "PutObject":
      p.method = "PUT";
      if (i.Body?.pipe) p.stream = i.Body;
      else
        p.content =
          typeof i.Body === "string" ? Buffer.from(i.Body) : i.Body;
      break;
    case "CreateMultipartUpload":
      p.method = "POST";
      query("uploads", "");
      root = true;
      break;
    case "UploadPart":
      p.method = "PUT";
      query("uploadId", i.UploadId);
      query("partNumber", i.PartNumber);
      if (i.Body?.pipe) p.stream = i.Body;
      else
        p.content =
          typeof i.Body === "string" ? Buffer.from(i.Body) : i.Body;
      break;
    case "ListParts":
      query("uploadId", i.UploadId);
      query("part-number-marker", i.PartNumberMarker);
      query("max-parts", i.MaxParts);
      root = true;
      break;
    case "CompleteMultipartUpload":
      p.method = "POST";
      query("uploadId", i.UploadId);
      doc("CompleteMultipartUpload", {
        Parts: i.MultipartUpload?.Parts ?? [],
      });
      root = true;
      break;
    case "AbortMultipartUpload":
      p.method = "DELETE";
      query("uploadId", i.UploadId);
      p.successStatuses = [200, 204];
      break;
  }
  p.xmlResponse = !!root;
    return p;
}
