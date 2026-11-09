import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareElectronExecutable } from "../../scripts/dev-electron.mjs";
const xml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
test("production Electron directory UI transfers through real S3 SDK to loopback HTTP, verifies disk and exports manifest", async ({}, info) => {
  const objects = new Map(),
    calls = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const key = decodeURIComponent(
        url.pathname.split("/").slice(2).join("/"),
      );
      calls.push({ method: req.method, key });
      if (url.searchParams.has("list-type")) {
        const contents = [...objects]
          .filter(([k]) => k.startsWith(url.searchParams.get("prefix") || ""))
          .map(
            ([k, v]) =>
              `<Contents><Key>${xml(k)}</Key><Size>${v.length}</Size><ETag>${xml('"' + createHash("md5").update(v).digest("hex") + '"')}</ETag></Contents>`,
          )
          .join("");
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>known</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
        return;
      }
      if (req.method === "PUT") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, {
          etag:
            '"' +
            createHash("md5").update(objects.get(key)).digest("hex") +
            '"',
        });
        res.end();
        return;
      }
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      const etag = '"' + createHash("md5").update(body).digest("hex") + '"';
      if (req.headers["if-match"] && req.headers["if-match"] !== etag) {
        res.writeHead(412);
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": body.length, etag });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let app, root;
  try {
    app = await electron.launch({
      executablePath: await prepareElectronExecutable(),
      args: ["tests/native/directory-host.mjs"],
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const dirs = await app.evaluate(() => globalThis.setupDirectoryFixture());
    root = dirs.root;
    await page.evaluate(async (endpoint) => {
      const r = await window.storageLab.invoke("saveConnection", {
        connection: {
          name: "目录交付隔离测试",
          provider: "s3",
          endpoint,
          region: "us-east-1",
          forcePathStyle: true,
          defaultBucket: "known",
          publicBaseUrl: "https://example.org/files",
        },
        credentials: {
          accessKeyId: "isolated",
          secretAccessKey: "isolated-secret",
        },
        credentialStorage: "session",
      });
      if (!r.ok) throw new Error(JSON.stringify(r));
    }, `http://127.0.0.1:${server.address().port}`);
    await page.reload();
    await page
      .getByRole("button", { name: "目录交付隔离测试", exact: true })
      .click();
    await page.getByRole("button", { name: "目录交付", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "目录交付" });
    await dialog.getByLabel("目标已存在时").selectOption("overwrite");
    await dialog.getByRole("button", { name: "选择目录并预览" }).click();
    await expect(dialog).toContainText("预览 2 个文件");
    await dialog.getByRole("button", { name: "开始目录传输" }).click();
    await expect(dialog).toContainText("已核验 2", { timeout: 15000 });
    await dialog.getByRole("button", { name: "导出交付清单" }).click();
    const manifest = JSON.parse(
      await readFile(join(root, "delivery.json"), "utf8"),
    );
    expect(
      manifest.entries.every(
        (x) => x.verification === "verified" && x.sha256?.length === 64,
      ),
    ).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(root);
    expect(JSON.stringify(manifest)).not.toContain("isolated-secret");
    await app.evaluate((_electron, target) => {
      globalThis.directoryPickerPath = target;
    }, dirs.target);
    await dialog.getByLabel("批次记录").selectOption("");
    await dialog.getByLabel("传输方向").selectOption("download");
    await dialog.getByLabel("目标已存在时").selectOption("skip");
    await dialog.getByRole("button", { name: "选择目录并预览" }).click();
    await expect(dialog).toContainText("预览 2 个文件");
    await dialog.getByRole("button", { name: "开始目录传输" }).click();
    await expect(dialog).toContainText("已核验 2", { timeout: 15000 });
    expect(await readFile(join(dirs.target, "message.txt"), "utf8")).toBe(
      "StorageLab directory real SDK / IPC / disk\n",
    );
    expect((await readFile(join(dirs.target, "资料/empty.txt"))).length).toBe(
      0,
    );
    expect(calls.filter((x) => x.method === "PUT")).toHaveLength(2);
    expect(calls.filter((x) => x.method === "GET" && x.key)).toHaveLength(4);
    await page.screenshot({ path: info.outputPath("native-directory.png") });
  } finally {
    await app?.close();
    await new Promise((r) => server.close(r));
    if (root) await rm(root, { recursive: true, force: true });
  }
});
