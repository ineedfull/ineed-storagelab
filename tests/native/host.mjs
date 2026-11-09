// Test-only native composition: production renderer, preload, IPC, service and real provider.
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createS3Client } from "../../electron/s3/client.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import {
  integrationConfig,
  createIntegrationFixture,
  createListDeniedProxy,
} from "../integration/setup.js";
import {
  registerIpc,
  createChangeNotifier,
  CHANGE_CHANNEL,
} from "../../electron/ipc.js";
import {
  seedVersionHistory,
  readVersionContent,
  readVersionHistory,
} from "../integration/version-fixture.js";
app.setName("StorageLab");
app
  .whenReady()
  .then(async () => {
    const config = await integrationConfig();
    const proxy = await createListDeniedProxy(config);
    let resumePause = process.env.STORAGELAB_NATIVE_RESUME === "1";
    const fixture = await createIntegrationFixture(proxy.config, {
      clientFactory: (...args) => {
        const client = createS3Client(...args);
        return {
          config: client.config,
          middlewareStack: client.middlewareStack,
          destroy: () => client.destroy(),
          send: async (command, options = {}) => {
            if (
              resumePause &&
              command.constructor.name === "UploadPartCommand" &&
              command.input.PartNumber === 2
            ) {
              globalThis.resumePartPaused = true;
              await new Promise((resolve, reject) => {
                const timer = setInterval(() => {
                  if (!resumePause) {
                    clearInterval(timer);
                    options.abortSignal?.removeEventListener("abort", abort);
                    resolve();
                  }
                }, 20);
                function abort() {
                  clearInterval(timer);
                  reject(
                    Object.assign(new Error("test part gate cancelled"), {
                      name: "AbortError",
                    }),
                  );
                }
                options.abortSignal?.addEventListener("abort", abort, {
                  once: true,
                });
                if (options.abortSignal?.aborted) abort();
              });
            }
            return client.send(command, options);
          },
        };
      },
    });
    globalThis.releaseResumePart = () => {
      resumePause = false;
    };
    globalThis.armResumePart = () => {
      resumePause = true;
      globalThis.resumePartPaused = false;
    };
    const { PutObjectCommand, GetObjectTaggingCommand, GetObjectCommand } =
      await import("@aws-sdk/client-s3");
    await fixture.client.send(
      new PutObjectCommand({
        Bucket: fixture.bucket,
        Key: "preview.txt",
        Body: "StorageLab native roundtrip\n",
        ContentType: "text/plain",
      }),
    );
    const upload = join(fixture.directory, "sample.txt");
    await writeFile(upload, "StorageLab native roundtrip\n");
    const download = join(fixture.directory, "downloads");
    await mkdir(download);
    fixture.selectUploads([upload]);
    fixture.selectDownloadDirectory(download);
    fixture.confirmDelete(true);
    globalThis.fixture = fixture;
    globalThis.readObject = async (key) => {
      const r = await fixture.client.send(
        new GetObjectCommand({ Bucket: fixture.bucket, Key: key }),
      );
      return {
        content: await r.Body.transformToString(),
        metadata: r.Metadata,
        contentType: r.ContentType,
        cacheControl: r.CacheControl,
      };
    };
    let versionHistory;
    globalThis.prepareVersionHistory = async () =>
      (versionHistory = await seedVersionHistory(fixture));
    globalThis.readVersionContent = (versionId) =>
      readVersionContent(fixture, versionHistory.key, versionId);
    globalThis.readVersionHistory = () =>
      readVersionHistory(fixture, versionHistory.key);
    globalThis.readHistoricalDownload = () =>
      readFile(join(download, versionHistory.key), "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    globalThis.readTags = async (key) =>
      (
        await fixture.client.send(
          new GetObjectTaggingCommand({ Bucket: fixture.bucket, Key: key }),
        )
      ).TagSet;
    globalThis.prepareResumableFile = async () => {
      const path = join(fixture.directory, "resume.bin");
      const bytes = Buffer.alloc(24 * 1024 * 1024, 73);
      await writeFile(path, bytes);
      fixture.selectUploads([path]);
      globalThis.resumablePath = path;
      return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    };
    globalThis.pickResumableFile = () =>
      fixture.selectUploads([globalThis.resumablePath]);
    globalThis.readObjectDigest = async (key) => {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const r = await fixture.client.send(
        new GetObjectCommand({ Bucket: fixture.bucket, Key: key }),
      );
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of r.Body) {
        size += chunk.length;
        hash.update(chunk);
      }
      return { sha256: hash.digest("hex"), size };
    };
    globalThis.readLocalDigest = async (key) => {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(join(download, key))) {
        size += chunk.length;
        hash.update(chunk);
      }
      return { sha256: hash.digest("hex"), size };
    };
    globalThis.prepareCancelFile = async () => {
      const path = join(fixture.directory, "cancel.bin");
      await writeFile(path, Buffer.alloc(96 * 1024 * 1024, 7));
      fixture.selectUploads([path]);
    };
    globalThis.readDownloaded = () =>
      readFile(join(download, "sample.txt"), "utf8");
    globalThis.readExportedJobs = () =>
      readFile(join(fixture.directory, "jobs.json"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const url = pathToFileURL(join(root, "dist/index.html")).href;
    const window = new BrowserWindow({
      title: "StorageLab",
      width: 1440,
      height: 900,
      minWidth: 920,
      minHeight: 620,
      webPreferences: {
        preload: join(root, "electron/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const notify = createChangeNotifier(() =>
      window.webContents.send(CHANGE_CHANNEL),
    );
    fixture.service.onChange(() => notify.notify());
    const off = registerIpc({
      ipcMain,
      trustedUrl: url,
      getWebContents: () => window.webContents,
      dispatch: fixture.service.invoke,
    });
    await window.loadURL(url);
    let closing = false;
    app.on("before-quit", (e) => {
      if (closing) return;
      e.preventDefault();
      closing = true;
      notify.dispose();
      off();
      fixture
        .cleanup()
        .finally(() => proxy.close())
        .finally(() => app.quit());
    });
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
