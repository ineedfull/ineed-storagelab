import { TosClient } from "@volcengine/tos-sdk";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { watchDownloadIdle } from "./download-idle.js";

import { unsupported, normalized, allowed, metadataHeaders } from "./tos/schema.js";
import { buildRequest } from "./tos/requestMapping.js";
import { normalizeResponse } from "./tos/responseMapping.js";

/** Native TOS V4 transport for the application's internal command bridge. */
export function createTosClient(
  connection,
  credentials,
  settings,
  { sdkFactory = (opts) => new TosClient(opts) } = {},
) {
  const endpoint = new URL(connection.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    /^tos-s3-/i.test(endpoint.hostname)
  )
    throw unsupported("native TOS endpoint");
  const scope = new AsyncLocalStorage(),
    clients = new Map(),
    uploads = new Map(),
    active = new Set();
  let closed = false;
  const timeout = (settings?.timeoutSeconds ?? 30) * 1000;
  const requestAdapter = (cfg) =>
    new Promise((resolve, reject) => {
      const state = scope.getStore();
      const target = new URL(cfg.baseURL);
      if (state.terminated) {
        reject(normalized(state.terminated));
        return;
      }
      const params = Object.entries(cfg.params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const transport = target.protocol === "https:" ? https : http;
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port,
          method: cfg.method,
          path: cfg.url + (params ? "?" + params : ""),
          headers: cfg.headers,
          agent:
            target.protocol === "https:" ? state.httpsAgent : state.httpAgent,
        },
        (res) => {
          const response = {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            config: cfg,
            request: req,
          };
          if (cfg.responseType === "stream" && res.statusCode < 300) {
            resolve({ ...response, data: res });
            return;
          }
          const chunks = [];
          let bytes = 0;
          res.on("data", (c) => {
            bytes += c.length;
            if (bytes > 16 * 1024 * 1024) {
              res.destroy(new Error("TOS response exceeds limit"));
              return;
            }
            chunks.push(c);
          });
          res.on("error", reject);
          res.on("end", () => {
            let data = Buffer.concat(chunks).toString();
            try {
              data = data.length ? JSON.parse(data) : {};
              if (!data || typeof data !== "object" || Array.isArray(data))
                throw new Error();
            } catch {
              reject(new Error("Invalid TOS JSON response"));
              return;
            }
            if (res.statusCode >= 300)
              reject(
                Object.assign(new Error("TOS request failed"), {
                  code:
                    data?.Code ||
                    {
                      403: "AccessDenied",
                      404: "NoSuchKey",
                      412: "PreconditionFailed",
                    }[res.statusCode],
                  statusCode: res.statusCode,
                }),
              );
            else resolve({ ...response, data });
          });
        },
      );
      state.request = req;
      req.on("error", reject);
      if (cfg.data?.pipe) {
        const sourceError = (e) => req.destroy(e);
        cfg.data.on("error", sourceError);
        const sourceCleanup = () => {
          cfg.data.removeListener("error", sourceError);
          cfg.data.unpipe(req);
          req.removeListener("close", sourceCleanup);
        };
        state.sourceCleanup = sourceCleanup;
        req.once("close", sourceCleanup);
        cfg.data.pipe(req);
      } else req.end(cfg.data);
    });
  const getClient = () => {
    if (closed) throw unsupported("closed client");
    if (!clients.has(""))
      clients.set(
        "",
        sdkFactory({
          endpoint: endpoint.host,
          region: connection.region,
          accessKeyId: credentials.accessKeyId,
          accessKeySecret: credentials.secretAccessKey,
          stsToken: credentials.sessionToken,
          secure: endpoint.protocol === "https:",
          enableVerifySSL: true,
          maxRetryCount: 0,
          requestTimeout: timeout,
          forcePathStyle: !!connection.forcePathStyle,
          requestAdapter,
        }),
      );
    return clients.get("");
  };
  const config = {
    endpoint: async () => ({
      hostname: new URL(connection.endpoint).hostname,
      protocol: new URL(connection.endpoint).protocol,
      port: new URL(connection.endpoint).port
        ? Number(new URL(connection.endpoint).port)
        : undefined,
      path: "/",
    }),
    forcePathStyle: !!connection.forcePathStyle,
    requestChecksumCalculation: async () => "WHEN_REQUIRED",
  };
  async function send(command, { abortSignal } = {}) {
    const name = command.constructor.name.replace(/Command$/, "");
    const i = command.input ?? {};
    try {
      if (!allowed[name]) throw unsupported(name);
      for (const [k, v] of Object.entries(i))
        if (v !== undefined && !["Bucket", "Key", ...allowed[name]].includes(k))
          throw unsupported(k);
      const checkFields = (obj, fields) => {
        for (const [k, v] of Object.entries(obj ?? {}))
          if (v !== undefined && !fields.includes(k)) throw unsupported(k);
      };
      if (
        i.Tagging !== undefined &&
        name !== "PutObjectTagging" &&
        typeof i.Tagging !== "string"
      )
        throw unsupported("Tagging");
      if (
        i.Metadata !== undefined &&
        (i.Metadata === null ||
          typeof i.Metadata !== "object" ||
          Array.isArray(i.Metadata) ||
          Object.values(i.Metadata).some((v) => typeof v !== "string"))
      )
        throw unsupported("Metadata");
      if (name === "PutObjectTagging") {
        checkFields(i.Tagging, ["TagSet"]);
        for (const tag of i.Tagging?.TagSet ?? [])
          checkFields(tag, ["Key", "Value"]);
      }
      if (name === "CompleteMultipartUpload") {
        checkFields(i.MultipartUpload, ["Parts"]);
        for (const part of i.MultipartUpload?.Parts ?? [])
          checkFields(part, ["PartNumber", "ETag"]);
      }
      const initializationFields = [
        "Metadata",
        "Tagging",
        ...Object.keys(metadataHeaders).filter((k) => k !== "ContentLength"),
      ];
      const uploadKey = JSON.stringify([i.Bucket, i.Key, i.UploadId]);
      const comparable = (v) =>
        JSON.stringify(
          v && typeof v === "object" && !(v instanceof Date)
            ? Object.fromEntries(
                Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
              )
            : v,
        );
      if (["UploadPart", "CompleteMultipartUpload"].includes(name))
        for (const field of initializationFields)
          if (
            i[field] !== undefined &&
            comparable(i[field]) !== comparable(uploads.get(uploadKey)?.[field])
          )
            throw unsupported("changed multipart initialization " + field);
      if (abortSignal?.aborted) throw { name: "AbortError" };
      const sdk = getClient(i.Bucket);
      const state = {
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({
          keepAlive: false,
          rejectUnauthorized: true,
        }),
        body: null,
      };
      let abortReject;
      const aborted = new Promise((_, reject) => {
        abortReject = reject;
      });
      let deadline;
      const clean = () => {
        state.sourceCleanup?.();
        clearTimeout(deadline);
        state.idleCleanup?.();
        abortSignal?.removeEventListener("abort", abort);
        state.httpAgent.destroy();
        state.httpsAgent.destroy();
        active.delete(abort);
      };
      const terminate = (reason) => {
        state.terminated = reason;
        state.body?.destroy(normalized(reason));
        state.request?.destroy(normalized(reason));
        i.Body?.destroy?.();
        state.httpAgent.destroy();
        state.httpsAgent.destroy();
        abortReject(reason);
      };
      const abort = () => terminate({ name: "AbortError" });
      deadline = setTimeout(() => terminate({ name: "TimeoutError" }), timeout);
      deadline.unref?.();
      active.add(abort);
      abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        return await Promise.race([
          scope.run(state, async () => {
            const p = buildRequest(name, i, { timeout, region: connection.region });
            const numericDns =
              !isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) &&
              /^(\d|:)/.test(endpoint.hostname) &&
              !connection.forcePathStyle &&
              p.bucket;
            const receiver = numericDns
              ? {
                  ...sdk,
                  opts: {
                    ...sdk.opts,
                    endpoint: `${p.bucket}.${endpoint.host}`,
                  },
                }
              : sdk;
            const r0 = await sdk.fetch.call(
              receiver,
              p.method,
              p.object === undefined ? "/" : "/" + encodeURIComponent(p.object),
              p.query,
              p.headers,
              p.stream ?? p.content,
              {
                subdomainBucket: numericDns ? undefined : p.bucket,
                axiosOpts: {
                  adapter: requestAdapter,
                  ...(p.customResponse ? { responseType: "stream" } : {}),
                },
              },
            );
            const r = {
              ...r0,
              status: r0.statusCode,
              res: p.customResponse ? r0.data : undefined,
            };
            const out = normalizeResponse(name, r);
            if (name === "GetObject") {
              out.Body = r.res;
              state.body = r.res;
              state.idleCleanup = watchDownloadIdle(state.body, timeout, () =>
                terminate({ name: "TimeoutError" }),
              );
              if (state.idleCleanup) clearTimeout(deadline);
              state.body.once("close", clean);
              state.body.once("end", clean);
              state.body.once("error", clean);
            }
            if (name === "CreateMultipartUpload") {
              const d = r.data ?? {};
              uploads.set(
                JSON.stringify([i.Bucket, i.Key, d.UploadId]),
                Object.fromEntries(
                  initializationFields
                    .filter((k) => i[k] !== undefined)
                    .map((k) => [k, structuredClone(i[k])]),
                ),
              );
            }
            if (
              ["AbortMultipartUpload", "CompleteMultipartUpload"].includes(name)
            )
              uploads.delete(uploadKey);
            return out;
          }),
          aborted,
        ]);
      } finally {
        if (!state.body) clean();
      }
    } catch (e) {
      throw normalized(e);
    }
  }
  return {
    config,
    send,
    async signGet({ bucket, key, expiresIn }) {
      try {
        // Browsers normalize dot path components even in an otherwise valid signed URL.
        if (/(^|\/)\.{1,2}(\/|$)/.test(key))
          throw unsupported("signed GET for dot-segment key");
        const sdk = getClient();
        const pathStyle =
          !!connection.forcePathStyle ||
          !!isIP(endpoint.hostname.replace(/^\[|\]$/g, ""));
        const host = pathStyle ? endpoint.host : `${bucket}.${endpoint.host}`;
        const path =
          (pathStyle ? "/" + bucket : "") + "/" + encodeURIComponent(key);
        // SDK 2.9.1's getSignatureQuery reads opts.endpoint as its region.
        // Bind only the signing call to the configured region; the request host is explicit.
        const query = sdk.getSignatureQuery.call(
          { ...sdk, opts: { ...sdk.opts, endpoint: connection.region } },
          {
            bucket: "",
            method: "GET",
            path,
            endpoint: host,
            subdomain: false,
            expires: expiresIn,
            query: {},
          },
        );
        return (
          endpoint.protocol +
          "//" +
          host +
          path +
          "?" +
          new URLSearchParams(query).toString()
        );
      } catch (e) {
        throw normalized(e);
      }
    },
    destroy() {
      closed = true;
      for (const abort of active) abort();
      active.clear();
      uploads.clear();
      for (const sdk of clients.values()) {
        sdk.httpAgent?.destroy();
        sdk.httpsAgent?.destroy();
      }
      clients.clear();
    },
  };
}
