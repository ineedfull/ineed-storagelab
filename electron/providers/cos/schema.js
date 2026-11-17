// Provider-specific command fields, encoding and error normalization.
const array = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const xmlEscape = (v) => {
  const text = String(v);
  for (const character of text) {
    const cp = character.codePointAt(0);
    if (!(
      cp === 9 ||
      cp === 10 ||
      cp === 13 ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff)
    ))
      throw unsupported("XML 1.0 character");
  }
  return text.replace(
    /[<>&"'\r]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
        "\r": "&#13;",
      })[c],
  );
};
const xml = (name, value) =>
  `<${name}>${
    Array.isArray(value)
      ? value.map((v) => xml(name, v)).join("")
      : value && typeof value === "object"
        ? Object.entries(value)
            .map(([k, v]) =>
              Array.isArray(v) ? v.map((x) => xml(k, x)).join("") : xml(k, v),
            )
            .join("")
        : xmlEscape(value ?? "")
  }</${name}>`;
const unsupported = (field) =>
  Object.assign(new Error(`COS does not support ${field}.`), {
    name: "NotImplemented",
    code: "NotImplemented",
  });
function normalized(e) {
  const status = e?.status || e?.statusCode || e?.$metadata?.httpStatusCode;
  const statusCode = {
    403: "AccessDenied",
    404: "NoSuchKey",
    412: "PreconditionFailed",
  }[status];
  const code =
    e?.name === "AbortError"
      ? "AbortError"
      : ["ResponseTimeoutError", "ConnectionTimeoutError"].includes(e?.name)
        ? "TimeoutError"
        : e?.name === "UnknownError" && statusCode
          ? statusCode
          : String(e?.code || e?.name || "StorageError");
  return Object.assign(
    new Error(
      code === "AbortError" ? "Request aborted." : "COS request failed.",
    ),
    {
      name: code,
      code,
      $metadata: {
        httpStatusCode:
          e?.status || e?.statusCode || e?.$metadata?.httpStatusCode,
      },
    },
  );
}
const metadataHeaders = {
  ContentType: "content-type",
  ContentLength: "content-length",
  CacheControl: "cache-control",
  ContentDisposition: "content-disposition",
  ContentEncoding: "content-encoding",
  ContentLanguage: "content-language",
  Expires: "expires",
};
const allowed = {
  ListBuckets: ["MaxBuckets", "ContinuationToken", "Prefix"],
  ListObjectsV2: [
    "Prefix",
    "Delimiter",
    "MaxKeys",
    "ContinuationToken",
    "StartAfter",
  ],
  HeadObject: [
    "VersionId",
    "IfMatch",
    "IfNoneMatch",
    "IfModifiedSince",
    "IfUnmodifiedSince",
  ],
  GetObject: [
    "VersionId",
    "Range",
    "IfMatch",
    "IfNoneMatch",
    "IfModifiedSince",
    "IfUnmodifiedSince",
  ],
  GetBucketVersioning: [],
  DeleteObjects: ["Delete"],
  GetObjectTagging: ["VersionId"],
  PutObjectTagging: ["VersionId", "Tagging"],
  DeleteObjectTagging: ["VersionId"],
  ListObjectVersions: [
    "Prefix",
    "Delimiter",
    "MaxKeys",
    "KeyMarker",
    "VersionIdMarker",
  ],
  CopyObject: [
    "CopySource",
    "CopySourceIfMatch",
    "CopySourceIfNoneMatch",
    "CopySourceIfModifiedSince",
    "CopySourceIfUnmodifiedSince",
    "MetadataDirective",
    "TaggingDirective",
    "Tagging",
    "Metadata",
    ...Object.keys(metadataHeaders),
  ],
  DeleteObject: ["VersionId"],
  PutObject: ["Body", "Metadata", "Tagging", ...Object.keys(metadataHeaders)],
  CreateMultipartUpload: [
    "Metadata",
    "Tagging",
    ...Object.keys(metadataHeaders),
  ],
  UploadPart: [
    "UploadId",
    "PartNumber",
    "Body",
    ...Object.keys(metadataHeaders),
  ],
  ListParts: ["UploadId", "PartNumberMarker", "MaxParts"],
  CompleteMultipartUpload: [
    "UploadId",
    "MultipartUpload",
    ...Object.keys(metadataHeaders),
  ],
  AbortMultipartUpload: ["UploadId"],
};


export { array, unsupported, normalized, metadataHeaders, allowed, xml };
