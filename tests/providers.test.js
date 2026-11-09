import test from "node:test";
import assert from "node:assert/strict";
import { validateConnection } from "../src/domain/connection.js";
import { createS3Operations } from "../electron/s3/operations.js";
import * as providers from "../src/domain/providers.js";
import { createS3Client } from "../electron/s3/client.js";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createStore } from "../electron/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../electron/service.js";

const cloud = [
  "aws",
  "aliyun",
  "cos",
  "tos",
  "qiniu",
  "r2",
  "b2",
  "spaces",
  "wasabi",
];
test("provider templates build exact API endpoints and signing regions without bucket or credentials", () => {
  const cases = [
    [
      "aws",
      "eu-west-1",
      "https://s3.eu-west-1.amazonaws.com",
      "eu-west-1",
      false,
    ],
    [
      "aws",
      "cn-north-1",
      "https://s3.cn-north-1.amazonaws.com.cn",
      "cn-north-1",
      false,
    ],
    [
      "aliyun",
      "cn-hangzhou",
      "https://s3.oss-cn-hangzhou.aliyuncs.com",
      "cn-hangzhou",
      false,
    ],
    [
      "cos",
      "ap-guangzhou",
      "https://cos.ap-guangzhou.myqcloud.com",
      "ap-guangzhou",
      false,
    ],
    [
      "tos",
      "cn-beijing",
      "https://tos-s3-cn-beijing.volces.com",
      "cn-beijing",
      false,
    ],
    [
      "qiniu",
      "cn-east-1",
      "https://s3.cn-east-1.qiniucs.com",
      "cn-east-1",
      true,
    ],
    [
      "r2",
      "auto",
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
      "auto",
      true,
    ],
    [
      "b2",
      "us-west-004",
      "https://s3.us-west-004.backblazeb2.com",
      "us-west-004",
      true,
    ],
    [
      "spaces",
      "sgp1",
      "https://sgp1.digitaloceanspaces.com",
      "us-east-1",
      false,
    ],
    [
      "wasabi",
      "us-east-1",
      "https://s3.us-east-1.wasabisys.com",
      "us-east-1",
      true,
    ],
  ];
  for (const [id, location, endpoint, region, forcePathStyle] of cases)
    assert.deepEqual(
      providers.buildProviderConfig(id, {
        location,
        accountId: "a".repeat(32),
      }),
      { endpoint, region, forcePathStyle },
    );
  for (const params of [
    { location: "cn-hangzhou.evil" },
    { location: "x/path" },
    { location: "https://url" },
    { location: "" },
  ])
    assert.throws(() => providers.buildProviderConfig("aliyun", params), {
      code: "INVALID_INPUT",
    });
  assert.throws(
    () => providers.buildProviderConfig("r2", { accountId: "user@evil" }),
    { code: "INVALID_INPUT" },
  );
  assert.throws(
    () => providers.buildProviderConfig("s3", { location: "us-east-1" }),
    { code: "MANUAL_ENDPOINT_REQUIRED" },
  );
});
test("cloud identities survive native validation, retaining manual endpoints and old MinIO/S3 profiles", () => {
  for (const provider of ["minio", "s3", ...cloud]) {
    const c = validateConnection({
      provider,
      name: "test",
      endpoint: "http://127.0.0.1:9876",
      region: "custom-region",
      forcePathStyle: true,
    });
    assert.equal(c.provider, provider);
    assert.equal(c.endpoint, "http://127.0.0.1:9876");
    assert.equal(c.region, "custom-region");
  }
});
test("known unsupported object tags fail locally for R2/B2/OSS instead of empty success", async () => {
  for (const provider of ["r2", "b2", "aliyun"]) {
    let calls = 0;
    const s = createS3Operations({
      client: {
        send: async () => {
          calls++;
          return {};
        },
      },
      connection: { provider },
    });
    await assert.rejects(s.getObjectTags({ bucket: "b", key: "a" }), {
      code: "UNSUPPORTED",
    });
    await assert.rejects(
      s.saveObjectTags({ bucket: "b", key: "a", tags: [] }),
      { code: "UNSUPPORTED" },
    );
    assert.equal(calls, 0);
  }
});
test("unverified cloud conditional writes cannot silently turn default no-overwrite into overwrites", async () => {
  for (const provider of cloud.filter((p) => p !== "aws")) {
    let picks = 0;
    const service = createService({
      store: {
        snapshot: () => ({ jobs: [], settings: { concurrency: 2 } }),
        listJobs: () => [],
        getConnection: () => ({ provider }),
        getCredentials: () => ({
          accessKeyId: "test",
          secretAccessKey: "test",
        }),
      },
      dialog: {
        showOpenDialog: async () => {
          picks++;
          return { canceled: true };
        },
      },
    });
    try {
      await assert.rejects(
        service.invoke("uploadFiles", {
          connectionId: "c",
          bucket: "b",
          prefix: "",
          overwrite: false,
        }),
        { code: "NO_OVERWRITE_UNVERIFIED" },
      );
      assert.equal(picks, 0);
      assert.equal(
        (
          await service.invoke("uploadFiles", {
            connectionId: "c",
            bucket: "b",
            prefix: "",
            overwrite: true,
          })
        ).cancelled,
        true,
      );
    } finally {
      await service.dispose();
    }
  }
});
test("real AWS SDK serializes each cloud host, raw key, V4 signing region and temporary token without cloud requests", async () => {
  for (const provider of cloud) {
    const config = providers.buildProviderConfig(provider, {
      accountId: "a".repeat(32),
    });
    const client = createS3Client(
      config,
      {
        accessKeyId: "test-key",
        secretAccessKey: "test-secret",
        sessionToken: "test-token",
      },
      { timeoutSeconds: 5 },
    );
    const requests = [];
    client.config.requestHandler.handle = async (request) => {
      requests.push(request);
      return {
        response: {
          statusCode: 200,
          headers: { "content-length": "0", etag: '"test"' },
        },
      };
    };
    try {
      await client.send(
        new HeadObjectCommand({ Bucket: "storage-lab", Key: "中文 +%?#.txt" }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: "storage-lab",
          Key: "中文 +%?#.txt",
          Body: Buffer.from("test"),
          IfNoneMatch: "*",
        }),
      );
      for (const r of requests) {
        const host = new URL(config.endpoint).hostname;
        assert.equal(
          r.hostname,
          config.forcePathStyle ? host : `storage-lab.${host}`,
        );
        assert.ok(r.path.endsWith("%E4%B8%AD%E6%96%87%20%2B%25%3F%23.txt"));
        assert.ok(
          r.headers.authorization.includes(`/${config.region}/s3/aws4_request`),
        );
        assert.equal(r.headers["x-amz-security-token"], "test-token");
        assert.equal(r.headers["transfer-encoding"], undefined);
      }
      assert.equal(requests[1].headers["if-none-match"], "*");
    } finally {
      client.destroy();
    }
  }
});
test("cloud profile identity persists alongside existing schema1 MinIO profiles without persisting session secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storagelab-providers-"));
  let store;
  try {
    store = createStore({ directory, vault: {} });
    const profiles = [];
    for (const provider of ["minio", "s3", ...cloud])
      profiles.push(
        store.saveConnection({
          connection: {
            provider,
            name: provider,
            endpoint: "http://127.0.0.1:9000",
          },
          credentials: {
            accessKeyId: "test-key",
            secretAccessKey: "test-secret",
          },
          credentialStorage: "session",
        }),
      );
    store.close();
    store = createStore({ directory, vault: {} });
    assert.deepEqual(
      store.snapshot().connections.map((c) => c.provider),
      ["minio", "s3", ...cloud],
    );
    for (const p of profiles)
      assert.equal(store.getCredentials(p.id), undefined);
    assert.ok(!JSON.stringify(store.snapshot()).includes("test-secret"));
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native OSS/OBS presets advertise native tags, unknown versions and guarded overwrite; legacy aliyun stays S3", () => {
  for (const [id, endpoint, region] of [
    ["oss", "https://oss-cn-shanghai.aliyuncs.com", "cn-shanghai"],
    ["obs", "https://obs.cn-north-4.myhuaweicloud.com", "cn-north-4"],
  ]) {
    assert.deepEqual(providers.buildProviderConfig(id), {
      endpoint,
      region,
      forcePathStyle: false,
    });
    assert.equal(providers.getProvider(id).tags, "available");
    assert.equal(providers.getProvider(id).versions, "unknown");
    assert.throws(() => providers.assertUploadPolicy(id, false), {
      code: "NO_OVERWRITE_UNVERIFIED",
    });
    providers.assertObjectTagsSupported(id);
  }
  assert.match(providers.getProvider("aliyun").name, /旧版/);
  assert.match(providers.getProvider("aliyun").name, /S3/);
  assert.equal(
    providers.buildProviderConfig("aliyun").endpoint,
    "https://s3.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.throws(() => providers.assertObjectTagsSupported("aliyun"), {
    code: "UNSUPPORTED",
  });
});

test("explicit aliyun migration only converts canonical S3 OSS endpoint and never mutates existing config", () => {
  const old = {
    id: "legacy",
    name: "legacy",
    provider: "aliyun",
    endpoint: "http://s3.oss-cn-shanghai.aliyuncs.com",
    region: "cn-shanghai",
    forcePathStyle: false,
    defaultBucket: "bucket",
  };
  const migrated = providers.migrateAliyunConnection(old);
  assert.equal(migrated.connection.provider, "oss");
  assert.equal(
    migrated.connection.endpoint,
    "http://oss-cn-shanghai.aliyuncs.com",
  );
  assert.equal(migrated.connection.region, "cn-shanghai");
  assert.equal(migrated.converted, true);
  assert.equal(old.provider, "aliyun");
  assert.equal(old.endpoint, "http://s3.oss-cn-shanghai.aliyuncs.com");
  for (const endpoint of [
    "https://files.example.com",
    "https://s3.oss-cn-shanghai.aliyuncs.com/custom",
    "https://s3.oss-cn-shanghai.aliyuncs.com:8443",
    "https://my-bucket.s3.oss-cn-shanghai.aliyuncs.com",
  ]) {
    const custom = providers.migrateAliyunConnection({ ...old, endpoint });
    assert.equal(custom.connection.endpoint, endpoint);
    assert.equal(custom.converted, false);
    assert.match(custom.notice, /核对/);
  }
  assert.throws(
    () => providers.migrateAliyunConnection({ ...old, provider: "s3" }),
    { code: "INVALID_INPUT" },
  );
});

test("native identities persist beside legacy aliyun without schema changes and migration stays draft until saved", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "storagelab-native-provider-profiles-"),
  );
  let store;
  const { DatabaseSync } = await import("node:sqlite");
  function schemaVersion() {
    const db = new DatabaseSync(join(directory, "storagelab.sqlite"), {
      readOnly: true,
    });
    try {
      return db.prepare("PRAGMA user_version").get().user_version;
    } finally {
      db.close();
    }
  }
  try {
    store = createStore({ directory, vault: {} });
    const beforeVersion = schemaVersion();
    const legacy = store.saveConnection({
      connection: {
        provider: "aliyun",
        name: "legacy",
        endpoint: "https://s3.oss-cn-shanghai.aliyuncs.com",
        region: "cn-shanghai",
      },
      credentials: { accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk" },
      credentialStorage: "session",
    });
    const migrated = providers.migrateAliyunConnection(legacy);
    assert.equal(store.getConnection(legacy.id).provider, "aliyun");
    assert.equal(store.getConnection(legacy.id).endpoint, legacy.endpoint);
    for (const id of ["oss", "obs", "cos-native", "tos-native"])
      store.saveConnection({
        connection: {
          provider: id,
          name: id,
          ...providers.buildProviderConfig(id),
        },
        credentials: {
          accessKeyId: "fixture-ak",
          secretAccessKey: "fixture-sk",
        },
        credentialStorage: "session",
      });
    store.close();
    store = undefined;
    assert.equal(schemaVersion(), beforeVersion);
    store = createStore({ directory, vault: {} });
    assert.deepEqual(
      store.snapshot().connections.map((c) => c.provider),
      ["aliyun", "oss", "obs", "cos-native", "tos-native"],
    );
    assert.ok(!JSON.stringify(store.snapshot()).includes("fixture-sk"));
    store.saveConnection({
      connection: migrated.connection,
      credentialStorage: "session",
    });
    assert.equal(store.getConnection(legacy.id).provider, "oss");
    assert.equal(
      store.getConnection(legacy.id).endpoint,
      "https://oss-cn-shanghai.aliyuncs.com",
    );
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("COS/TOS native identities retain legacy endpoints and explicit migration preserves profile fields", () => {
  for (const [legacy, native, endpoint, oldEndpoint, region] of [
    [
      "cos",
      "cos-native",
      "https://cos.ap-guangzhou.myqcloud.com",
      "https://cos.ap-guangzhou.myqcloud.com",
      "ap-guangzhou",
    ],
    [
      "tos",
      "tos-native",
      "https://tos-cn-beijing.volces.com",
      "https://tos-s3-cn-beijing.volces.com",
      "cn-beijing",
    ],
  ]) {
    assert.deepEqual(providers.buildProviderConfig(native), {
      endpoint,
      region,
      forcePathStyle: false,
    });
    assert.equal(providers.buildProviderConfig(legacy).endpoint, oldEndpoint);
    assert.match(providers.getProvider(legacy).name, /旧版\/S3兼容/);
    assert.equal(providers.getProvider(native).versions, "unknown");
    assert.throws(() => providers.assertUploadPolicy(native, false), {
      code: "NO_OVERWRITE_UNVERIFIED",
    });
    assert.ok(
      providers.PROVIDERS.findIndex((p) => p.id === native) <
        providers.PROVIDERS.findIndex((p) => p.id === legacy),
    );
    const old = {
      id: "legacy",
      provider: legacy,
      endpoint: oldEndpoint,
      region: "actual-region",
      defaultBucket: "bucket",
      readOnly: true,
      forcePathStyle: true,
    };
    const migrated = providers.migrateLegacyConnection(old);
    assert.equal(migrated.connection.provider, native);
    assert.equal(migrated.connection.endpoint, endpoint);
    assert.equal(migrated.connection.region, "actual-region");
    assert.equal(migrated.connection.defaultBucket, "bucket");
    assert.equal(migrated.connection.readOnly, true);
    assert.equal(migrated.converted, true);
    assert.equal(old.provider, legacy);
    for (const custom of [
      "https://custom.example.invalid",
      oldEndpoint + "/custom",
      oldEndpoint + ":8443",
      oldEndpoint.replace("https://", "https://bucket."),
    ]) {
      const result = providers.migrateLegacyConnection({
        ...old,
        endpoint: custom,
      });
      assert.equal(result.connection.endpoint, custom);
      assert.equal(result.converted, false);
      assert.match(result.notice, /核对/);
    }
  }
});

test("selectable providers hide legacy aliases while keeping saved identities readable", () => {
  const current = providers.getSelectableProviders();
  assert.equal(current.length, 12);
  for (const legacy of ["aliyun", "cos", "tos"]) {
    assert.equal(
      current.some((p) => p.id === legacy),
      false,
    );
    assert.equal(providers.getProvider(legacy).id, legacy);
    assert.deepEqual(
      providers
        .getSelectableProviders(legacy)
        .filter((p) => ["aliyun", "cos", "tos"].includes(p.id))
        .map((p) => p.id),
      [legacy],
    );
  }
  assert.deepEqual(providers.getSelectableProviders("oss"), current);
});
