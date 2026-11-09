import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  access,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const appDirectory = projectRoot;

// macOS reads the application menu title from the executable's .app bundle.
// app.setName only changes Electron's internal name. Keep node_modules intact
// and cache a local, ad-hoc-signed development host with the release branding.
export async function prepareElectronExecutable() {
  const executable = require("electron");
  if (process.platform !== "darwin") return executable;

  const manifest = JSON.parse(
    await readFile(path.join(appDirectory, "package.json"), "utf8"),
  );
  const branding = {
    CFBundleDisplayName: "StorageLab",
    CFBundleName: "StorageLab",
  };
  const displayName = branding.CFBundleDisplayName;
  const appId = "com.ineedfull.storagelab";
  const version = require("electron/package.json").version;
  const icon = await readFile(path.join(appDirectory, "build/icon.icns"));
  const brandHash = createHash("sha256")
    .update(JSON.stringify([branding, appId]))
    .update(icon)
    .digest("hex")
    .slice(0, 12);
  const cache = path.join(
    projectRoot,
    "artifacts/electron-dev",
    `${version}-${process.arch}-${brandHash}`,
  );
  const bundle = path.join(cache, `${displayName}.app`);
  const marker = path.join(cache, "ready");
  const brandedExecutable = path.join(bundle, "Contents/MacOS/Electron");
  try {
    await access(marker);
    await access(brandedExecutable);
    return brandedExecutable;
  } catch {
    /* Prepare the host after install or a branding/version change. */
  }

  await mkdir(cache, { recursive: true });
  await cp(path.resolve(executable, "../../.."), bundle, {
    recursive: true,
    verbatimSymlinks: true,
  });
  await copyFile(
    path.join(appDirectory, "build/icon.icns"),
    path.join(bundle, "Contents/Resources/icon.icns"),
  );
  const plist = path.join(bundle, "Contents/Info.plist");
  for (const [key, value] of Object.entries({
    ...branding,
    CFBundleIdentifier: appId,
    CFBundleIconFile: "icon.icns",
  })) {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }
  // Changing Info.plist invalidates the host signature. Ad-hoc signing is local
  // development only and does not require a Developer ID certificate.
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    bundle,
  ]);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  await writeFile(marker, `${version}\n`);
  return brandedExecutable;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const executable = await prepareElectronExecutable();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--prepare") {
    console.log(executable);
  } else {
    const child = spawn(executable, args.length ? args : ["."], {
      cwd: appDirectory,
      stdio: "inherit",
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
    child.on("error", (error) => {
      console.error(error);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
