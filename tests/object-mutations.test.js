import test from "node:test";
import assert from "node:assert/strict";
import { validatePayload } from "../electron/ipc.js";
import { createMutationOperations } from "../electron/s3/mutations.js";
const h = {
  ContentLength: 3,
  ETag: '"e"',
  LastModified: new Date(0),
  ContentType: "text/plain",
  Metadata: { a: "b" },
  ContentDisposition: "inline",
  ContentLanguage: "en",
  ContentEncoding: "identity",
  CacheControl: "no-cache",
  WebsiteRedirectLocation: "/landing",
};
const context = { bucket: "bucket", key: " /中文?# " };
function fixture(
  provider = "aws",
  override = () => undefined,
  endpoint = "https://s3.us-east-1.amazonaws.com",
) {
  const calls = [];
  const client = {
    send: async (c) => {
      calls.push(c);
      const result = override(c, calls);
      if (result !== undefined) return result;
      if (c.constructor.name === "HeadObjectCommand") return { ...h };
      return { CopyObjectResult: { ETag: h.ETag } };
    },
  };
  return {
    calls,
    api: createMutationOperations({
      client,
      connection: { provider, endpoint },
    }),
  };
}
test("mutation IPC preserves raw keys and rejects invalid metadata/snapshot", () => {
  assert.equal(
    validatePayload("prepareObjectMutation", {
      connectionId: "connection-1",
      ...context,
    }).key,
    context.key,
  );
  assert.throws(() =>
    validatePayload("executeObjectMutation", {
      connectionId: "connection-1",
      ...context,
      kind: "metadata",
      original: {},
      metadata: { a: "中文" },
    }),
  );
});
test("copy binds source and conditional target, encoded source and preserves metadata", async () => {
  const { api, calls } = fixture();
  const original = await api.prepareObjectMutation(context);
  assert.equal(original.contentDisposition, "inline");
  await api.executeObjectMutation({
    ...context,
    kind: "copy",
    original,
    targetKey: " target ",
    overwrite: false,
  });
  const c = calls.find((c) => c.constructor.name === "CopyObjectCommand").input;
  assert.equal(c.IfNoneMatch, "*");
  assert.equal(c.CopySourceIfMatch, h.ETag);
  assert.match(c.CopySource, /%E4%B8%AD/);
  assert.equal(c.MetadataDirective, "COPY");
  assert.equal(c.WebsiteRedirectLocation, "/landing");
});
test("metadata replacement preserves unedited standard properties", async () => {
  const { api, calls } = fixture();
  const original = await api.prepareObjectMutation(context);
  await api.executeObjectMutation({
    ...context,
    kind: "metadata",
    original,
    contentType: "application/json",
    cacheControl: "max-age=1",
    metadata: { new: "value" },
  });
  const c = calls.find((c) => c.constructor.name === "CopyObjectCommand").input;
  assert.equal(c.ContentDisposition, "inline");
  assert.equal(c.ContentLanguage, "en");
  assert.equal(c.ContentEncoding, "identity");
  assert.equal(c.TaggingDirective, "COPY");
  assert.equal(c.MetadataDirective, "REPLACE");
  assert.equal(c.IfMatch, h.ETag);
});
test("source changes refuse copy; unknown provider needs overwrite and retains rename source", async () => {
  const { api, calls } = fixture("s3");
  const original = await api.prepareObjectMutation(context);
  await assert.rejects(
    api.executeObjectMutation({
      ...context,
      kind: "copy",
      original,
      targetKey: "target",
    }),
    { code: "NO_OVERWRITE_UNVERIFIED" },
  );
  const r = await api.executeObjectMutation({
    ...context,
    kind: "rename",
    original,
    targetKey: "target",
    overwrite: true,
  });
  assert.equal(r.sourceRetained, true);
  assert.equal(
    calls.some((c) => c.constructor.name === "DeleteObjectCommand"),
    false,
  );
  const f = fixture("aws", (c) =>
    c.constructor.name === "HeadObjectCommand"
      ? { ...h, ETag: "changed" }
      : undefined,
  );
  await assert.rejects(
    f.api.executeObjectMutation({
      ...context,
      kind: "copy",
      original,
      targetKey: "target",
    }),
    { code: "CONFLICT" },
  );
});
test("rename delete failure returns copy success without retry or permanent version deletion", async () => {
  const { api, calls } = fixture("aws", (c) => {
    if (c.constructor.name === "DeleteObjectCommand")
      throw new Error("network secret");
  });
  const original = await api.prepareObjectMutation(context);
  const r = await api.executeObjectMutation({
    ...context,
    kind: "rename",
    original,
    targetKey: "target",
  });
  assert.equal(r.copied, true);
  assert.equal(r.sourceDeletionUncertain, true);
  assert.equal(
    calls.find((c) => c.constructor.name === "CopyObjectCommand").input
      .WebsiteRedirectLocation,
    "/landing",
  );
  const deletes = calls.filter(
    (c) => c.constructor.name === "DeleteObjectCommand",
  );
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].input.IfMatch, h.ETag);
  assert.equal(deletes[0].input.VersionId, undefined);
});
test("native service read-only, cancellation and post-confirmation source checks", async () => {
  const { createService } = await import("../electron/service.js");
  let response = 1,
    readOnly = false,
    changed = false,
    locks = 0;
  const calls = [];
  const store = {
    getConnection: () => ({
      id: "connection-1",
      name: "test",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      readOnly,
    }),
    getCredentials: () => ({ accessKeyId: "x", secretAccessKey: "x" }),
    snapshot: () => ({ settings: {} }),
    lockConnection: () => {
      locks++;
      return () => locks--;
    },
    listJobs: () => [],
    saveJob() {},
  };
  const service = createService({
    store,
    dialog: {
      showMessageBox: async () => {
        if (response === 0) changed = true;
        return { response };
      },
    },
    clientFactory: (_a, _b, _c, options) => {
      assert.equal(options.maxAttempts, 1);
      return {
        send: async (c) => {
          calls.push(c);
          return { ...h, ...(changed ? { ETag: "changed" } : {}) };
        },
        destroy() {},
      };
    },
  });
  try {
    const p = { connectionId: "connection-1", ...context };
    const original = await service.invoke("prepareObjectMutation", p);
    readOnly = true;
    await assert.rejects(
      service.invoke("executeObjectMutation", {
        ...p,
        original,
        kind: "copy",
        targetKey: "target",
      }),
      { code: "READ_ONLY" },
    );
    readOnly = false;
    assert.equal(
      (
        await service.invoke("executeObjectMutation", {
          ...p,
          original,
          kind: "copy",
          targetKey: "target",
        })
      ).cancelled,
      true,
    );
    response = 0;
    await assert.rejects(
      service.invoke("executeObjectMutation", {
        ...p,
        original,
        kind: "copy",
        targetKey: "target",
      }),
      { code: "CONFLICT" },
    );
    assert.equal(
      calls.some((c) => c.constructor.name === "CopyObjectCommand"),
      false,
    );
    assert.equal(locks, 0);
  } finally {
    await service.dispose();
  }
});
test("copy errors never encourage blind retry; unsupported tag providers omit directive", async () => {
  const f = fixture("aws", (c) => {
    if (c.constructor.name === "CopyObjectCommand")
      throw { name: "TimeoutError" };
  });
  const original = await f.api.prepareObjectMutation(context);
  await assert.rejects(
    f.api.executeObjectMutation({
      ...context,
      original,
      kind: "copy",
      targetKey: "target",
    }),
    { code: "MUTATION_UNCERTAIN" },
  );
  const u = fixture("r2");
  const snapshot = await u.api.prepareObjectMutation(context);
  await u.api.executeObjectMutation({
    ...context,
    original: snapshot,
    kind: "copy",
    targetKey: "target",
    overwrite: true,
  });
  assert.equal(
    u.calls.find((c) => c.constructor.name === "CopyObjectCommand").input
      .TaggingDirective,
    undefined,
  );
});
test("verified MinIO ignoring conditions requires overwrite consent and never deletes rename source", async () => {
  const { api, calls } = fixture("minio");
  const original = await api.prepareObjectMutation(context);
  assert.deepEqual(original.capabilities, {
    conditionalCopy: false,
    conditionalDelete: false,
  });
  await assert.rejects(
    api.executeObjectMutation({
      ...context,
      original,
      kind: "rename",
      targetKey: "target",
    }),
    { code: "NO_OVERWRITE_UNVERIFIED" },
  );
  const r = await api.executeObjectMutation({
    ...context,
    original,
    kind: "rename",
    targetKey: "target",
    overwrite: true,
  });
  assert.equal(r.sourceRetained, true);
  assert.equal(
    calls.some((c) => c.constructor.name === "DeleteObjectCommand"),
    false,
  );
});

test("AWS label with custom, insecure or deceptive endpoint cannot enable mutation conditions", async () => {
  for (const endpoint of [
    "http://127.0.0.1:9000",
    "https://storage.example.com",
    "http://s3.us-east-1.amazonaws.com",
    "https://s3.us-east-1.amazonaws.com.attacker.test",
    "https://s3.us-east-1.amazonaws.com/custom",
    "https://s3.us-east-1.amazonaws.com:8443",
  ]) {
    const { api, calls } = fixture("aws", () => undefined, endpoint);
    const original = await api.prepareObjectMutation(context);
    assert.deepEqual(
      original.capabilities,
      { conditionalCopy: false, conditionalDelete: false },
      endpoint,
    );
    await assert.rejects(
      api.executeObjectMutation({
        ...context,
        original,
        kind: "rename",
        targetKey: "target",
      }),
      { code: "NO_OVERWRITE_UNVERIFIED" },
    );
    const r = await api.executeObjectMutation({
      ...context,
      original,
      kind: "rename",
      targetKey: "target",
      overwrite: true,
    });
    assert.equal(r.sourceRetained, true);
    assert.equal(
      calls.some((c) => c.constructor.name === "DeleteObjectCommand"),
      false,
    );
  }
  for (const endpoint of [
    "https://s3.amazonaws.com",
    "https://s3.us-west-2.amazonaws.com",
    "https://s3.cn-north-1.amazonaws.com.cn",
  ])
    assert.deepEqual(
      (
        await fixture(
          "aws",
          () => undefined,
          endpoint,
        ).api.prepareObjectMutation(context)
      ).capabilities,
      { conditionalCopy: true, conditionalDelete: true },
    );
});
