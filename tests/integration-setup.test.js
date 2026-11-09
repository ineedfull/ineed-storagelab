import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntegrationFixture } from "./integration/setup.js";
const fixtureDirectories = async (root) =>
  new Set(
    (await readdir(root)).filter((name) =>
      name.startsWith("storagelab-integration-"),
    ),
  );
for (const stage of ["bucket-create", "after-profile"])
  test(`fixture setup rollback after ${stage} failure removes bucket and temporary directory`, async () => {
    const root = await mkdtemp(join(tmpdir(), "storagelab-setup-test-"));
    const before = await fixtureDirectories(root);
    const buckets = new Set();
    let deleted = 0;
    const failure = new Error("injected dialog construction failure");
    const server = createServer((req, res) => {
      const key = new URL(req.url, "http://localhost").pathname;
      if (req.method === "PUT") {
        if (stage === "bucket-create") {
          res.writeHead(403, { "content-type": "application/xml" });
          res.end("<Error><Code>AccessDenied</Code></Error>");
          return;
        }
        buckets.add(key);
        res.end();
        return;
      }
      if (req.method === "DELETE") {
        buckets.delete(key);
        deleted++;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/xml");
      res.end(
        req.url.includes("uploads")
          ? "<ListMultipartUploadsResult/>"
          : "<ListBucketResult/>",
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config = {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        accessKeyId: "testkey",
        secretAccessKey: "testsecret",
      };
      const dialog = {
        get showMessageBox() {
          throw failure;
        },
      };
      await assert.rejects(
        createIntegrationFixture(config, { dialog, temporaryRoot: root }),
        stage === "bucket-create"
          ? { name: "AccessDenied" }
          : (e) => e === failure,
      );
      assert.equal(
        buckets.size,
        0,
        "created bucket must be removed on setup failure",
      );
      assert.equal(deleted, stage === "bucket-create" ? 0 : 1);
      const leaked = [...(await fixtureDirectories(root))].filter(
        (name) => !before.has(name),
      );
      assert.deepEqual(
        leaked,
        [],
        "setup must remove its isolated directory before rejecting",
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
