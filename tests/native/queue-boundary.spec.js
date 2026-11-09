import { test, expect, _electron as electron } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";

test("real desktop queue rejects overflow atomically and releases connection locks after cancellation", async () => {
  test.skip(
    !process.env.STORAGELAB_TEST_CONFIG &&
      !process.env.STORAGELAB_TEST_ENDPOINT,
    "Requires explicit private local MinIO config",
  );
  const app = await electron.launch({
    executablePath: await prepareElectronExecutable(),
    args: ["tests/native/host.mjs"],
    env: { ...process.env, STORAGELAB_NATIVE_RESUME: "1" },
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const f = await app.evaluate(() => ({
      directory: globalThis.fixture.directory,
      connection: globalThis.fixture.profile,
      bucket: globalThis.fixture.bucket,
    }));
    const params = { connectionId: f.connection.id, bucket: f.bucket };
    const result = (method, payload = {}) =>
      page.evaluate(
        ({ method, payload }) => window.storageLab.invoke(method, payload),
        { method, payload },
      );
    async function invoke(method, payload = {}) {
      const response = await result(method, payload);
      expect(response.ok, response.error?.message).toBe(true);
      return response.value;
    }
    await invoke("saveSettings", { concurrency: 1 });
    await app.evaluate(() => globalThis.prepareResumableFile());
    const held = (await invoke("uploadFiles", { ...params, resumable: true }))
      .jobs[0];
    await expect
      .poll(() => app.evaluate(() => globalThis.resumePartPaused === true))
      .toBe(true);

    const paths = Array.from({ length: 100 }, (_, i) =>
      join(f.directory, `queued-${i}.bin`),
    );
    await Promise.all(paths.map((path) => writeFile(path, Buffer.alloc(4096))));
    await app.evaluate(
      (_, paths) => globalThis.fixture.selectUploads(paths),
      paths,
    );
    const queued = (
      await invoke("uploadFiles", { ...params, prefix: "queued/" })
    ).jobs;
    expect(queued).toHaveLength(100);
    const before = await invoke("listJobs");
    expect(before).toHaveLength(101);
    expect(before.filter((job) => job.state === "queued")).toHaveLength(100);

    await app.evaluate(
      (_, path) => globalThis.fixture.selectUploads([path]),
      paths[0],
    );
    const overflow = await result("uploadFiles", {
      ...params,
      prefix: "overflow/",
    });
    expect(overflow).toMatchObject({
      ok: false,
      error: { code: "QUEUE_FULL" },
    });
    expect((await invoke("listJobs")).map((job) => job.id).sort()).toEqual(
      before.map((job) => job.id).sort(),
    );
    const edit = {
      connection: { ...f.connection, name: "Recovered queue" },
      credentialStorage: "session",
    };
    expect(await result("saveConnection", edit)).toMatchObject({
      ok: false,
      error: { code: "CONNECTION_BUSY" },
    });

    await Promise.all(queued.map((job) => invoke("cancelJob", { id: job.id })));
    await invoke("cancelJob", { id: held.id });
    await expect
      .poll(async () =>
        (await invoke("listJobs")).every((job) => job.state === "cancelled"),
      )
      .toBe(true);
    await app.evaluate(() => globalThis.releaseResumePart());
    expect(await invoke("discardUpload", { id: held.id })).toMatchObject({
      discarded: true,
    });
    await invoke("saveConnection", edit);
    const recovered = (
      await invoke("uploadFiles", { ...params, prefix: "recovered/" })
    ).jobs[0];
    await expect
      .poll(
        async () =>
          (await invoke("listJobs")).find((job) => job.id === recovered.id)
            ?.state,
      )
      .toBe("success");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
