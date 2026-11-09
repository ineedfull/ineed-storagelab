import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const api = await import("../electron/transfers/directory-plan.js").catch(
  () => ({}),
);
test("directory upload preserves nested Unicode and empty files without following symlinks", async () => {
  assert.equal(
    typeof api.planUpload,
    "function",
    "native directory planner is required",
  );
  const root = await mkdtemp(join(tmpdir(), "sl-dir-"));
  try {
    await mkdir(join(root, "资料"));
    await writeFile(join(root, "资料", "空.txt"), "");
    await writeFile(join(root, "a.txt"), "abc");
    const items = await api.planUpload(root, "release/");
    assert.deepEqual(items.map((x) => [x.key, x.size]).sort(), [
      ["release/a.txt", 3],
      ["release/资料/空.txt", 0],
    ]);
    await symlink(join(root, "a.txt"), join(root, "alias"));
    const blocked = await api.planUpload(root, "");
    assert.equal(
      blocked.find((x) => x.relativePath === "alias").state,
      "blocked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("flat remote pagination strips only exact prefix and refuses looping or incomplete enumeration", async () => {
  assert.equal(
    typeof api.planDownload,
    "function",
    "native prefix planner is required",
  );
  const root = await mkdtemp(join(tmpdir(), "sl-prefix-"));
  try {
    let calls = 0;
    const client = {
      send: async (command) => {
        assert.equal(command.input.Delimiter, undefined);
        return ++calls === 1
          ? {
              Contents: [{ Key: "p/a", Size: 1 }],
              IsTruncated: true,
              NextContinuationToken: "next",
            }
          : { Contents: [{ Key: "p/中文/b", Size: 0 }] };
      },
    };
    const rows = await api.planDownload(client, "b", "p/", root);
    assert.deepEqual(
      rows.map((x) => x.relativePath),
      ["a", "中文/b"],
    );
    client.send = async () => ({
      Contents: [],
      IsTruncated: true,
      NextContinuationToken: "same",
    });
    await assert.rejects(api.planDownload(client, "b", "p/", root), {
      code: "DIRECTORY_INCOMPLETE",
    });
    client.send = async () => ({ Contents: [{ Key: "other/x", Size: 1 }] });
    await assert.rejects(api.planDownload(client, "b", "p/", root), {
      code: "DIRECTORY_INCOMPLETE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("preflight marks unsafe and case-colliding mappings and refuses oversized listings", async () => {
  assert.equal(typeof api.planDownload, "function");
  const root = await mkdtemp(join(tmpdir(), "sl-conflict-"));
  try {
    const client = {
      send: async () => ({
        Contents: [
          { Key: "A", Size: 1 },
          { Key: "a", Size: 1 },
          { Key: "../x", Size: 1 },
        ],
      }),
    };
    const rows = await api.planDownload(client, "b", "", root);
    assert.equal(
      rows.every((x) => x.state === "blocked"),
      true,
    );
    client.send = async () => ({
      Contents: Array.from({ length: 1001 }, (_, i) => ({
        Key: `${i}`,
        Size: 1,
      })),
    });
    await assert.rejects(api.planDownload(client, "b", "", root), {
      code: "DIRECTORY_LIMIT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
