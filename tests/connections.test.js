import test from "node:test";
import assert from "node:assert/strict";
import { validateConnection } from "../src/domain/connection.js";
import { validateSettings } from "../src/domain/settings.js";
test("connection rejects unsafe endpoints and supplies provider defaults", () => {
  for (const endpoint of [
    "ftp://a",
    "https://u:p@a",
    "https://a?q=1",
    "https://a/#x",
  ])
    assert.throws(() =>
      validateConnection({ name: "A", endpoint, provider: "minio" }),
    );
  assert.equal(
    validateConnection({
      name: "A",
      endpoint: "http://localhost:9000",
      provider: "minio",
    }).forcePathStyle,
    true,
  );
});
test("settings enforce exact supported ranges", () => {
  for (const value of [0, 5, 1.5])
    assert.throws(() => validateSettings({ concurrency: value }));
  for (const value of [4, 121])
    assert.throws(() => validateSettings({ timeoutSeconds: value }));
  assert.equal(validateSettings({}).concurrency, 2);
});
test("empty userinfo, query and fragment markers are still rejected", () => {
  for (const endpoint of [
    "https://@example.com",
    "https://example.com?",
    "https://example.com#",
  ])
    assert.throws(() =>
      validateConnection({ name: "A", endpoint, provider: "s3" }),
    );
});

test("native provider validation blocks OBS path style and OSS S3-only endpoints without changing legacy S3 profiles", () => {
  const base = { name: "native", region: "cn-shanghai" };
  assert.equal(
    validateConnection({
      ...base,
      provider: "oss",
      endpoint: "https://oss-cn-shanghai.aliyuncs.com",
    }).forcePathStyle,
    false,
  );
  assert.equal(
    validateConnection({
      ...base,
      provider: "obs",
      endpoint: "https://obs.cn-north-4.myhuaweicloud.com",
    }).forcePathStyle,
    false,
  );
  assert.throws(
    () =>
      validateConnection({
        ...base,
        provider: "obs",
        endpoint: "https://obs.cn-north-4.myhuaweicloud.com",
        forcePathStyle: true,
      }),
    { code: "INVALID_INPUT" },
  );
  for (const host of [
    "s3.oss-cn-shanghai.aliyuncs.com",
    "bucket.s3.oss-cn-shanghai.aliyuncs.com",
    "s3.oss-cn-shanghai-internal.aliyuncs.com",
    "s3.oss-cn-shanghai.aliyuncs.com.",
  ])
    assert.throws(
      () =>
        validateConnection({
          ...base,
          provider: "oss",
          endpoint: "https://" + host,
        }),
      { code: "INVALID_INPUT" },
    );
  const endpoint = "https://s3.oss-cn-shanghai.aliyuncs.com";
  assert.equal(
    validateConnection({ ...base, provider: "aliyun", endpoint }).endpoint,
    endpoint,
  );
  assert.equal(
    validateConnection({
      ...base,
      provider: "oss",
      endpoint: "https://custom.example.com",
    }).endpoint,
    "https://custom.example.com",
  );
});

test("native COS/TOS defaults use actual provider regions and TOS rejects S3-specific hosts", () => {
  for (const [provider, endpoint, region] of [
    ["cos-native", "https://cos.ap-guangzhou.myqcloud.com", "ap-guangzhou"],
    ["tos-native", "https://tos-cn-beijing.volces.com", "cn-beijing"],
  ]) {
    const config = validateConnection({ name: "native", provider, endpoint });
    assert.equal(config.region, region);
    assert.equal(config.forcePathStyle, false);
  }
  for (const host of [
    "tos-s3-cn-beijing.volces.com",
    "bucket.tos-s3-cn-beijing.volces.com",
    "tos-s3-cn-beijing.volces.com.",
  ])
    assert.throws(
      () =>
        validateConnection({
          name: "bad",
          provider: "tos-native",
          endpoint: `https://${host}`,
        }),
      { code: "INVALID_INPUT" },
    );
  assert.equal(
    validateConnection({
      name: "legacy",
      provider: "tos",
      endpoint: "https://tos-s3-cn-beijing.volces.com",
    }).provider,
    "tos",
  );
});

test("COS native rejects unsupported path style without restricting legacy COS", () => {
  const base = {
    name: "COS",
    endpoint: "https://cos.ap-guangzhou.myqcloud.com",
    forcePathStyle: true,
  };
  assert.throws(() => validateConnection({ ...base, provider: "cos-native" }), {
    code: "INVALID_INPUT",
  });
  assert.equal(
    validateConnection({ ...base, provider: "cos" }).forcePathStyle,
    true,
  );
});
