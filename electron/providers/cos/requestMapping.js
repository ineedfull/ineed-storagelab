// Convert internal commands into native wire parameters; no requests are started here.
import { xml, unsupported, metadataHeaders } from "./schema.js";

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
    p.content = xml(r, v);
    p.mime = "application/xml";
    p.headers["content-type"] = "application/xml";
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
    p.headers[`x-cos-meta-${k}`] = v;
  if (i.Tagging !== undefined && typeof i.Tagging === "string")
    p.headers["x-cos-tagging"] = i.Tagging;
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
      if (
        i.ContinuationToken !== undefined &&
        i.StartAfter !== undefined
      )
        throw unsupported("ambiguous marker");
      for (const [k, v] of Object.entries({
        prefix: i.Prefix,
        delimiter: i.Delimiter,
        "max-keys": i.MaxKeys,
        marker: i.ContinuationToken ?? i.StartAfter,
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
      doc("Tagging", { TagSet: { Tag: i.Tagging?.TagSet ?? [] } });
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
        Object: i.Delete?.Objects ?? [],
      });
      root = true;
      break;
    case "CopyObject":
      p.method = "PUT";
      {
        const source = String(i.CopySource ?? "").replace(/^\//, "");
        const slash = source.indexOf("/");
        if (slash < 1) throw unsupported("CopySource");
        const sourceBucket = decodeURIComponent(
          source.slice(0, slash),
        );
        if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(sourceBucket))
          throw unsupported("CopySource bucket");
        p.headers["x-cos-copy-source"] =
          `${sourceBucket}.cos.${region}.myqcloud.com/${source.slice(slash + 1)}`;
      }
      for (const k of [
        "IfMatch",
        "IfNoneMatch",
        "IfModifiedSince",
        "IfUnmodifiedSince",
      ]) {
        const v = i[`CopySource${k}`];
        if (v !== undefined)
          p.headers[
            `x-cos-copy-source-${k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`
          ] = v instanceof Date ? v.toUTCString() : v;
      }
      if (i.MetadataDirective !== undefined) {
        const directive = { COPY: "Copy", REPLACE: "Replaced" }[
          i.MetadataDirective
        ];
        if (!directive) throw unsupported("MetadataDirective");
        p.headers["x-cos-metadata-directive"] = directive;
      }
      if (i.TaggingDirective !== undefined) {
        const directive = { COPY: "Copy", REPLACE: "Replaced" }[
          i.TaggingDirective
        ];
        if (!directive) throw unsupported("TaggingDirective");
        p.headers["x-cos-tagging-directive"] = directive;
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
        Part: i.MultipartUpload?.Parts ?? [],
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
  p.expectedRoot = {
    ListBuckets: "ListAllMyBucketsResult",
    ListObjectsV2: "ListBucketResult",
    GetBucketVersioning: "VersioningConfiguration",
    ListObjectVersions: "ListVersionsResult",
    GetObjectTagging: "Tagging",
    DeleteObjects: "DeleteResult",
    CopyObject: "CopyObjectResult",
    CreateMultipartUpload: "InitiateMultipartUploadResult",
    ListParts: "ListPartsResult",
    CompleteMultipartUpload: "CompleteMultipartUploadResult",
  }[name];
  p.requiredField = {
    CopyObject: "ETag",
    CompleteMultipartUpload: "ETag",
    CreateMultipartUpload: "UploadId",
  }[name];
    return p;
}
