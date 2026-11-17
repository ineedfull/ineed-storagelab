import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../electron/store.js";
import { createService } from "../electron/service.js";

for (const method of ["exportJobs", "exportDirectory"]) {
  test(`${method} protects live data, links and aliases, but permits normal exports`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "storagelab-export-"));
    const directory = join(root, "data");
    const store = createStore({ directory, vault: {} });
    store.saveDirectoryBatch({ id: "batch", state: "completed", entries: [] });
    let selected;
    const service = createService({ store,
      app: { getVersion: () => "test", getPath: () => directory },
      dialog: { showSaveDialog: async () => ({ filePath: selected }) },
    });
    t.after(async () => { await service.dispose(); store.close(); await fs.rm(root, { recursive: true, force: true }); });
    const database = join(directory, "storagelab.sqlite");
    const before = await fs.readFile(database);
    await fs.symlink(database, join(root, "linked.json"));
    await fs.link(database, join(root, "hardlinked.json"));
    await fs.symlink(directory, join(root, "alias"));
    for (selected of [join(root, "linked.json"), join(root, "hardlinked.json"), database,
      join(directory, "new.json"), join(root, "alias", "report.json"), directory]) {
      await assert.rejects(service.invoke(method, method === "exportDirectory" ? { id: "batch" } : {}));
      assert.deepEqual(await fs.readFile(database), before);
    }
    selected = join(root, "normal.json");
    await fs.writeFile(selected, "old export");
    assert.deepEqual(await service.invoke(method, method === "exportDirectory" ? { id: "batch" } : {}), { path: selected });
    JSON.parse(await fs.readFile(selected, "utf8"));
    assert.deepEqual(await fs.readFile(database), before);
    assert.equal((await fs.readdir(root)).some(name => name.endsWith(".tmp")), false);
  });
}
