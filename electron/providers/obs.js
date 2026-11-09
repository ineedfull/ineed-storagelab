import ObsClient from "esdk-obs-nodejs";
import model from "esdk-obs-nodejs/lib/obsModel.js";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";
import { watchDownloadIdle } from "./download-idle.js";

const methods = {
  ListBuckets: "ListBuckets",
  ListObjectsV2: "ListObjects",
  HeadObject: "GetObjectMetadata",
  GetObject: "GetObject",
  GetBucketVersioning: "GetBucketVersioningConfiguration",
  DeleteObjects: "DeleteObjects",
  GetObjectTagging: "GetObjectTagging",
  PutObjectTagging: "SetObjectTagging",
  DeleteObjectTagging: "DeleteObjectTagging",
  ListObjectVersions: "ListVersions",
  CopyObject: "CopyObject",
  DeleteObject: "DeleteObject",
  PutObject: "PutObject",
  CreateMultipartUpload: "InitiateMultipartUpload",
  UploadPart: "UploadPart",
  ListParts: "ListParts",
  CompleteMultipartUpload: "CompleteMultipartUpload",
  AbortMultipartUpload: "AbortMultipartUpload",
};
function failure(code = "ObsError", status) {
  const e = new Error(
    code === "AbortError"
      ? "Request aborted"
      : code === "NotSupported"
        ? "Unsupported OBS operation or field"
        : "OBS request failed",
  );
  e.name = e.code = /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code)
    ? code
    : "ObsError";
  e.$metadata = { httpStatusCode: status };
  return e;
}
// OBS 3.26.2 buildXml escapes ampersands/quotes but leaves angle brackets
// verbatim. XML also normalizes CR, so reject it even though XML permits it.
// Keep LF/tab and paired Unicode scalar characters exact; undefined is absent.
function assertSafeXml(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) assertSafeXml(nested);
  } else if (
    value !== undefined &&
    /[<>\x00-\x08\x0b-\x1f]|\p{Surrogate}|\p{Noncharacter_Code_Point}/u.test(
      String(value),
    )
  ) {
    throw failure("NotSupported");
  }
}
function parameters(name, input, uploads) {
  const p = { ...input };
  if (name === "ListBuckets") {
    if (p.ContinuationToken !== undefined) {
      p.Marker = p.ContinuationToken;
      delete p.ContinuationToken;
    }
    if (p.MaxBuckets !== undefined) {
      p.MaxKeys = p.MaxBuckets;
      delete p.MaxBuckets;
    }
  }
  if (name === "ListObjectsV2") {
    if (p.ContinuationToken !== undefined) {
      p.Marker = p.ContinuationToken;
      delete p.ContinuationToken;
    }
    if (p.StartAfter !== undefined) {
      if (p.Marker !== undefined) throw failure("NotSupported");
      p.Marker = p.StartAfter;
      delete p.StartAfter;
    }
  }
  if (name === "DeleteObjects") {
    const d = p.Delete;
    delete p.Delete;
    if (d) {
      if (
        Object.keys(d).some((k) => !["Objects", "Quiet"].includes(k)) ||
        d.Objects?.some((o) =>
          Object.keys(o).some((k) => !["Key", "VersionId"].includes(k)),
        )
      )
        throw failure("NotSupported");
      Object.assign(p, d);
    }
  }
  if (name === "PutObjectTagging") {
    if (p.Tagging && Object.keys(p.Tagging).some((k) => k !== "TagSet"))
      throw failure("NotSupported");
    p.Tags = p.Tagging?.TagSet;
    delete p.Tagging;
  }
  if (name === "CompleteMultipartUpload") {
    if (
      p.MultipartUpload &&
      Object.keys(p.MultipartUpload).some((k) => k !== "Parts")
    )
      throw failure("NotSupported");
    p.Parts = p.MultipartUpload?.Parts;
    delete p.MultipartUpload;
    if (
      p.Parts?.some((o) =>
        Object.keys(o).some((k) => !["PartNumber", "ETag"].includes(k)),
      )
    )
      throw failure("NotSupported");
  }
  if (name === "CopyObject" && p.CopySource !== undefined) {
    const index = p.CopySource.lastIndexOf("?versionId=");
    try {
      p.CopySource =
        index < 0
          ? decodeURIComponent(p.CopySource)
          : decodeURIComponent(p.CopySource.slice(0, index)) +
            p.CopySource.slice(index);
      // Native SDK reparses this delimiter after decoding. Without a real
      // version suffix it would reinterpret a literal key as a version request.
      if (index < 0 && p.CopySource.includes("?versionId="))
        throw failure("NotSupported");
    } catch {
      throw failure("NotSupported");
    }
  }
  if (p.Tagging !== undefined) {
    p.Tags = p.Tagging;
    delete p.Tagging;
  }
  if (p.TaggingDirective !== undefined) {
    p.TagDirective = p.TaggingDirective;
    delete p.TaggingDirective;
  }
  if (name === "UploadPart" && p.ContentLength !== undefined) {
    p.PartSize = p.ContentLength;
    delete p.ContentLength;
  }
  // lib-storage carries the total object length into initiation, which has no payload.
  if (name === "CreateMultipartUpload") delete p.ContentLength;
  if (["UploadPart", "CompleteMultipartUpload"].includes(name)) {
    const initial = uploads.get(JSON.stringify([p.Bucket, p.Key, p.UploadId]));
    for (const field of Object.keys(p)) {
      if (
        !Object.hasOwn(model[methods[name]].parameters, field) &&
        p[field] !== undefined &&
        initial &&
        JSON.stringify(initial[field]) === JSON.stringify(p[field])
      )
        delete p[field];
    }
  }
  const allowed = model[methods[name]]?.parameters;
  if (
    !allowed ||
    Object.keys(p).some((k) => p[k] !== undefined && !Object.hasOwn(allowed, k))
  )
    throw failure("NotSupported");
  for (const [field, value] of Object.entries(p))
    if (allowed[field]?.location === "xml") assertSafeXml(value);
  for (const k of Object.keys(p)) {
    if (p[k] === undefined) delete p[k];
    else if (p[k] instanceof Date) p[k] = p[k].toUTCString();
  }
  if (name === "GetObject") p.SaveAsStream = true;
  return p;
}
function response(name, r) {
  const common = r?.CommonMsg || {};
  const status = Number(common.Status || 200);
  if (status >= 300 || common.Code)
    throw failure(common.Code || "ObsError", status);
  const out = {
    ...(r?.InterfaceResult || {}),
    $metadata: { httpStatusCode: status },
  };
  for (const key of Object.keys(out)) {
    if (key.endsWith("Obs")) {
      out[key.slice(0, -3)] = out[key];
      delete out[key];
    }
  }
  if (name === "DeleteObjects") {
    out.Deleted = out.Deleteds || [];
    delete out.Deleteds;
    if (out.Errors)
      out.Errors = out.Errors.map(({ Key, VersionId, Code }) => ({
        Key,
        VersionId,
        Code,
        Message: "OBS request failed",
      }));
  }
  if (name === "GetObject") {
    out.Body = out.Content;
    delete out.Content;
  }
  if (name === "ListBuckets") {
    out.Buckets = (out.Buckets ?? []).map(({ BucketName, ...bucket }) => ({
      ...bucket,
      Name: BucketName ?? bucket.Name,
    }));
    out.ContinuationToken = out.NextMarker;
    out.IsTruncated = out.IsTruncated === true || out.IsTruncated === "true";
  }
  if (["ListObjectsV2", "ListObjectVersions", "ListParts"].includes(name)) {
    if (out.IsTruncated !== undefined)
      out.IsTruncated = out.IsTruncated === true || out.IsTruncated === "true";
    for (const field of ["Contents", "Versions", "DeleteMarkers", "Parts"]) {
      if (out[field])
        out[field] = out[field].map((entry) => {
          const item = { ...entry };
          for (const key of ["Size", "PartNumber"])
            if (item[key] !== undefined) item[key] = Number(item[key]);
          if (item.IsLatest !== undefined)
            item.IsLatest = item.IsLatest === true || item.IsLatest === "true";
          return item;
        });
    }
    // Part numbers are numeric protocol fields; object/version cursors stay opaque.
    if (name === "ListParts")
      for (const field of [
        "PartNumberMarker",
        "NextPartNumberMarker",
        "MaxParts",
      ])
        if (out[field] !== undefined) out[field] = Number(out[field]);
  }
  if (name === "ListObjectsV2") {
    out.NextContinuationToken = out.NextMarker;
    out.KeyCount = out.Contents?.length || 0;
  }
  if (name === "GetObjectTagging") {
    out.TagSet = out.Tags || [];
    delete out.Tags;
  }
  if (name === "CopyObject")
    out.CopyObjectResult = { ETag: out.ETag, LastModified: out.LastModified };
  if (name === "ListObjectVersions") {
    out.Versions = out.Versions || [];
    out.DeleteMarkers = out.DeleteMarkers || [];
  }
  if (name === "HeadObject" || name === "GetObject") {
    out.Metadata = out.Metadata || out.MetadataObs || {};
    if (out.ContentLength !== undefined)
      out.ContentLength = Number(out.ContentLength);
  }
  return out;
}
export function createObsClient(
  connection,
  credentials = {},
  settings = {},
  { sdkFactory = (config) => new ObsClient(config) } = {},
) {
  if (connection.forcePathStyle || connection.pathStyle)
    throw new Error("OBS native path style is unsupported");
  const endpoint = new URL(connection.endpoint);
  if (isIP(endpoint.hostname.replace(/^\[|\]$/g, "")))
    throw failure("NotSupported");
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw failure("InvalidEndpoint");
  const uploads = new Map();
  const clients = new Map(),
    active = new Set(),
    agents = new Set();
  let closed = false;
  const timeout = Number(
    settings.requestTimeoutMs ||
      settings.timeoutMs ||
      (settings.timeoutSeconds || 30) * 1000,
  );
  function client(bucket = "") {
    if (closed) throw failure("ClientClosed");
    if (!clients.has(bucket)) {
      const httpAgent = new http.Agent({ keepAlive: true }),
        httpsAgent = new https.Agent({
          keepAlive: true,
          rejectUnauthorized: true,
        });
      agents.add(httpAgent);
      agents.add(httpsAgent);
      clients.set(
        bucket,
        sdkFactory({
          http_agent: httpAgent,
          https_agent: httpsAgent,
          access_key_id: credentials.accessKeyId,
          secret_access_key: credentials.secretAccessKey,
          security_token: credentials.sessionToken,
          server: endpoint.origin,
          is_secure: endpoint.protocol === "https:",
          signature: "obs",
          is_signature_negotiation: false,
          path_style: false,
          max_retry_count: 0,
          ssl_verify: true,
          timeout: Math.max(1, timeout / 1000),
          third_http_lib: {
            request(options) {
              return (endpoint.protocol === "https:" ? https : http).request({
                ...options,
                checkServerIdentity: tls.checkServerIdentity,
                rejectUnauthorized: true,
              });
            },
          },
        }),
      );
    }
    return clients.get(bucket);
  }
  return {
    config: {
      endpoint: async () => ({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : undefined,
        path: "/",
      }),
      forcePathStyle: false,
      requestChecksumCalculation: async () => "WHEN_REQUIRED",
    },
    async send(command, { abortSignal } = {}) {
      const name = command.constructor.name.replace(/Command$/, "");
      const p = parameters(name, command.input || {}, uploads);
      if (abortSignal?.aborted) throw failure("AbortError");
      const sdk = client(p.Bucket);
      return new Promise((resolve, reject) => {
        let done = false,
          req,
          body,
          timer,
          idleCleanup;
        const cleanup = () => {
          clearTimeout(timer);
          idleCleanup?.();
          abortSignal?.removeEventListener("abort", abort);
          active.delete(abort);
        };
        const abort = (reason) => {
          const e = failure(
            reason === "timeout" ? "TimeoutError" : "AbortError",
          );
          req?.destroy(e);
          body?.destroy(e);
          if (!done) {
            done = true;
            reject(e);
          }
          cleanup();
        };
        active.add(abort);
        abortSignal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => abort("timeout"), timeout);
        timer.unref?.();
        p.RequestHook = (request) => {
          req = request;
          if (done) req.destroy();
        };
        const callback = (err, result) => {
          if (done) {
            result?.InterfaceResult?.Content?.destroy?.();
            return;
          }
          if (err) {
            done = true;
            cleanup();
            reject(
              failure(
                err.code === "ETIMEDOUT" ? "TimeoutError" : "NetworkingError",
              ),
            );
            return;
          }
          try {
            const out = response(name, result);
            if (name === "CreateMultipartUpload")
              uploads.set(JSON.stringify([p.Bucket, p.Key, out.UploadId]), {
                ...command.input,
              });
            if (
              ["CompleteMultipartUpload", "AbortMultipartUpload"].includes(name)
            )
              uploads.delete(JSON.stringify([p.Bucket, p.Key, p.UploadId]));
            body = out.Body;
            done = true;
            if (body?.once) {
              idleCleanup = watchDownloadIdle(body, timeout, () =>
                abort("timeout"),
              );
              if (idleCleanup) clearTimeout(timer);
              body.once("end", cleanup);
              body.once("close", cleanup);
              body.once("error", cleanup);
            } else cleanup();
            resolve(out);
          } catch (e) {
            done = true;
            cleanup();
            result?.InterfaceResult?.Content?.destroy?.();
            reject(e);
          }
        };
        try {
          sdk[methods[name][0].toLowerCase() + methods[name].slice(1)](
            p,
            callback,
          );
        } catch {
          callback(failure());
        }
      });
    },
    signGet({ bucket, key, expiresIn }) {
      // Browser URL consumers normalize literal dot path components.
      if (/(^|\/)\.{1,2}(\/|$)/.test(key)) throw failure("NotSupported");
      return client(bucket).createSignedUrlSync({
        Method: "GET",
        Bucket: bucket,
        Key: key,
        Expires: expiresIn,
      }).SignedUrl;
    },
    destroy() {
      if (closed) return;
      closed = true;
      for (const abort of [...active]) abort();
      for (const sdk of clients.values()) sdk.close?.();
      clients.clear();
      uploads.clear();
      for (const agent of agents) agent.destroy();
      agents.clear();
    },
  };
}
