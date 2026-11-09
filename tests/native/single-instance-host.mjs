// Test-only entry: production main with a shared, explicitly isolated appData.
import { app } from "electron";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
app.setPath("appData", process.env.STORAGELAB_INSTANCE_TEST_DIRECTORY);
function withDatabase(fn) {
  const db = new DatabaseSync(
    join(app.getPath("userData"), "storagelab.sqlite"),
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
globalThis.seedRunningJob = () =>
  withDatabase((db) =>
    db.prepare("INSERT INTO jobs(id,data) VALUES(?,?)").run(
      "active-fixture",
      JSON.stringify({
        id: "active-fixture",
        state: "running",
        bytesTransferred: 123,
      }),
    ),
  );
globalThis.runningJobState = () =>
  withDatabase(
    (db) =>
      JSON.parse(
        db.prepare("SELECT data FROM jobs WHERE id=?").get("active-fixture")
          .data,
      ).state,
  );
await import("../../electron/main.js");
