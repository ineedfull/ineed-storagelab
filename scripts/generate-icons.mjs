// Maintained source is the brand repository; no divergent SVG is authored here.
import { Resvg } from "@resvg/resvg-js";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const option = process.argv.find((a) => a.startsWith("--brand-root="));
const brand = resolve(
  option?.slice("--brand-root=".length) ??
    join(root, "../web/ineed-icon-concepts/current"),
);
const exportBrand = process.argv.includes("--export-brand");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const entries = [];
const pngs = new Map();
await mkdir(join(root, "build"), { recursive: true });
await mkdir(join(root, "public"), { recursive: true });
for (const [variant, sizes] of [
  ["standard", [48, 64, 128, 256, 512, 1024]],
  ["small", [16, 24, 32]],
]) {
  const source = `source/${variant === "small" ? "small/" : ""}storagelab.svg`;
  const bytes = await readFile(join(brand, source));
  entries.push({ file: source, variant, sha256: sha256(bytes) });
  if (variant === "standard")
    await writeFile(join(root, "public/icon.svg"), bytes);
  if (variant === "small")
    await writeFile(join(root, "public/icon-small.svg"), bytes);
  for (const size of sizes) {
    const svg = bytes
      .toString()
      .replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    const png = new Resvg(svg, { font: { loadSystemFonts: false } })
      .render()
      .asPng();
    pngs.set(size, png);
    const file = `exports/storagelab/${size}.png`;
    entries.push({
      file,
      source,
      size,
      sha256: sha256(png),
      renderer: "@resvg/resvg-js 2.6.2",
    });
    if (exportBrand) {
      await mkdir(join(brand, "exports/storagelab"), { recursive: true });
      await writeFile(join(brand, file), png);
    }
  }
}
await writeFile(join(root, "build/icon.png"), pngs.get(512));
// ICO directory embeds PNG frames, supported by current Windows and NSIS.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [i, size] of sizes.entries()) {
  const at = 6 + i * 16;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = header[at];
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(pngs.get(size).length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += pngs.get(size).length;
}
await writeFile(
  join(root, "build/icon.ico"),
  Buffer.concat([header, ...sizes.map((size) => pngs.get(size))]),
);
if (process.platform !== "darwin")
  throw new Error(
    "ICNS generation requires macOS iconutil; PNG/ICO generated, ICNS not verified.",
  );
const temporary = await mkdtemp(join(tmpdir(), "storagelab-icons-"));
try {
  const iconset = join(temporary, "StorageLab.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(join(iconset, `icon_${size}x${size}.png`), pngs.get(size));
    await writeFile(
      join(iconset, `icon_${size}x${size}@2x.png`),
      pngs.get(size * 2),
    );
  }
  execFileSync("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    join(root, "build/icon.icns"),
  ]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
const outputs = {};
for (const file of [
  "build/icon.png",
  "build/icon.ico",
  "build/icon.icns",
  "public/icon.svg",
  "public/icon-small.svg",
])
  outputs[file] = sha256(await readFile(join(root, file)));
await writeFile(
  join(root, "build/icon-provenance.json"),
  JSON.stringify(
    {
      source: "web/ineed-icon-concepts/current",
      product: "storagelab",
      renderer: "@resvg/resvg-js 2.6.2; CPU; transparent PNG",
      entries,
      outputs,
    },
    null,
    2,
  ) + "\n",
);
if (exportBrand) {
  for (const file of ["tokens.json", "manifest.json"]) {
    const data = JSON.parse(await readFile(join(brand, file), "utf8"));
    data.products.storagelab = "StorageLab";
    if (file === "manifest.json") {
      data.entries = data.entries.filter((e) => !e.file.includes("storagelab"));
      data.entries.push(...entries);
    }
    await writeFile(join(brand, file), JSON.stringify(data, null, 2) + "\n");
  }
}
console.log(
  "Generated StorageLab standard/small SVG copies, PNG, ICO, ICNS and SHA-256 provenance.",
);
