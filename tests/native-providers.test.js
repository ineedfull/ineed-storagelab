import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "../electron/providers/client.js";
import { createS3Operations } from "../electron/s3/operations.js";

const credentials = {
  accessKeyId: "fixture-key",
  secretAccessKey: "fixture-secret",
};
const settings = { timeoutSeconds: 5 };

test("native provider factory selects native signing while legacy profiles keep S3", () => {
  for (const provider of [
    "oss",
    "obs",
    "cos-native",
    "tos-native",
    "aliyun",
    "cos",
    "tos",
    "minio",
    "s3",
  ]) {
    const endpoints = {
      "cos-native": ["https://cos.ap-guangzhou.myqcloud.com", "ap-guangzhou"],
      "tos-native": ["https://tos-cn-beijing.volces.com", "cn-beijing"],
      obs: ["https://obs.cn-north-4.myhuaweicloud.com", "cn-north-4"],
    };
    const [endpoint, region] = endpoints[provider] ?? [
      "https://oss-cn-shanghai.aliyuncs.com",
      "cn-shanghai",
    ];
    const client = createProviderClient(
      {
        provider,
        endpoint,
        region,
        forcePathStyle: false,
      },
      credentials,
      settings,
    );
    try {
      assert.equal(typeof client.send, "function");
      assert.equal(
        typeof client.signGet,
        ["oss", "obs", "cos-native", "tos-native"].includes(provider)
          ? "function"
          : "undefined",
      );
    } finally {
      client.destroy();
    }
  }
});

test("shared sharing flow uses provider signing and preserves raw key and expiry", async () => {
  const calls = [];
  const api = createS3Operations({
    connection: { provider: "oss" },
    client: {
      signGet: async (input) => {
        calls.push(input);
        return "https://fixture.invalid/native-signed";
      },
    },
  });
  const key = " 中文/+%?#\\.txt ";
  const result = await api.shareObject({
    bucket: "fixture-bucket",
    key,
    kind: "signed",
    expiresIn: 600,
  });
  assert.deepEqual(calls, [{ bucket: "fixture-bucket", key, expiresIn: 600 }]);
  assert.equal(result.url, "https://fixture.invalid/native-signed");
  assert.ok(Date.parse(result.expiresAt) > Date.now());
});

test("provider signing failures are sanitized before leaving the service layer", async () => {
  const api = createS3Operations({
    connection: { provider: "obs" },
    client: {
      signGet: async () => {
        throw Object.assign(new Error("fixture-secret signed-query"), {
          name: "AccessDenied",
        });
      },
    },
  });
  await assert.rejects(
    api.shareObject({
      bucket: "fixture-bucket",
      key: "a",
      kind: "signed",
      expiresIn: 60,
    }),
    (error) =>
      error.code === "ACCESS_DENIED" &&
      !error.message.includes("fixture-secret"),
  );
});
