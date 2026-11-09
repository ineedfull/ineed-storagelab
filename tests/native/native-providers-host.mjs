import "./production-host.mjs";
import http from "node:http";
import ObsClient from "esdk-obs-nodejs";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createProviderClient } from "../../electron/providers/client.js";

// Runs in the real Electron main process. Every request is routed to loopback;
// generated fixture credentials never reach renderer or a cloud service.
globalThis.verifyNativeProviders = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization, path: req.url });
    res.writeHead(200, { "content-length": "7", etag: '"fixture"' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const credentials = {
    accessKeyId: "fixture-key",
    secretAccessKey: "fixture-secret",
  };
  const agent = new http.Agent({
    lookup: (_hostname, options, callback) =>
      callback(
        null,
        options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1",
        4,
      ),
  });
  const clients = [];
  try {
    const results = [];
    for (const provider of ["oss", "obs", "cos-native", "tos-native"]) {
      const client = createProviderClient(
        {
          provider,
          endpoint: ["oss", "tos-native"].includes(provider)
            ? `http://127.0.0.1:${port}`
            : provider === "cos-native"
              ? `http://cos.ap-guangzhou.myqcloud.com:${port}`
              : `http://obs.cn-north-4.myhuaweicloud.com:${port}`,
          region: {
            oss: "cn-shanghai",
            obs: "cn-north-4",
            "cos-native": "ap-guangzhou",
            "tos-native": "cn-beijing",
          }[provider],
          forcePathStyle: ["oss", "tos-native"].includes(provider),
        },
        credentials,
        { timeoutSeconds: 5 },
        provider === "obs"
          ? {
              sdkFactory: (config) =>
                new ObsClient({
                  ...config,
                  http_agent: agent,
                  third_http_lib: {
                    request: (options) => http.request({ ...options, agent }),
                  },
                }),
            }
          : provider === "cos-native"
            ? {
                lookup: (_host, _options, callback) =>
                  callback(null, [{ address: "127.0.0.1", family: 4 }]),
              }
            : undefined,
      );
      clients.push(client);
      const bucket =
        provider === "cos-native"
          ? "fixture-bucket-1250000000"
          : "fixture-bucket";
      const response = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: " 中文 +%.txt ",
        }),
      );
      const url = await client.signGet({
        bucket,
        key: " 中文 +%.txt ",
        expiresIn: 60,
      });
      results.push({
        provider,
        size: response.ContentLength,
        etag: response.ETag,
        signature:
          provider === "oss"
            ? new URL(url).searchParams.get("x-oss-signature-version")
            : provider === "obs"
              ? new URL(url).searchParams.has("AccessKeyId")
              : provider === "cos-native"
                ? new URL(url).searchParams.get("q-sign-algorithm")
                : new URL(url).searchParams.get("X-Tos-Algorithm"),
      });
    }
    return { results, requests };
  } finally {
    for (const client of clients) client.destroy();
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};
