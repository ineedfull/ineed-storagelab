#!/usr/bin/env node
// Kept identical across tools; product identity and source layout are data.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const platforms = { darwin: 'macos', win32: 'windows', linux: 'linux' };
const targets = {
  macos: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  windows: { x64: 'x86_64-pc-windows-msvc' },
  linux: { x64: 'x86_64-unknown-linux-gnu' },
};
const formats = { macos: ['dmg'], windows: ['nsis'], linux: ['deb', 'AppImage'] };
const extensions = { dmg: '.dmg', nsis: '.exe', deb: '.deb', AppImage: '.AppImage' };
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function runtimeDirectories(projectRoot = root) {
  const product = JSON.parse(readFileSync(path.join(projectRoot, 'scripts/release-product.json'), 'utf8'));
  // Older product descriptors use the original dual-runtime layout.
  const directories = product.runtimeDirectories ?? { electron: 'apps/electron', tauri: 'apps/tauri' };
  assert.ok(Object.keys(directories).length > 0, 'Empty runtime configuration');
  for (const [runtime, directory] of Object.entries(directories)) {
    assert.ok(['electron', 'tauri'].includes(runtime), `Invalid runtime: ${runtime}`);
    assert.ok(typeof directory === 'string' && (directory === '.' || /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(directory)), 'Runtime directory must stay within the source tree');
  }
  return directories;
}

export function selectJobs(options = {}, host = process.platform, hostArch = process.arch, availableRuntimes = Object.keys(runtimeDirectories())) {
  const platform = options.platform ?? platforms[host];
  assert.ok(Object.hasOwn(targets, platform), `Unsupported platform: ${platform}`);
  const architecture = options.arch ?? (platform === 'macos' && host === 'darwin' ? hostArch : 'x64');
  const architectures = architecture === 'all' ? Object.keys(targets[platform]) : [architecture];
  assert.ok(availableRuntimes.length > 0 && availableRuntimes.every(runtime => ['electron', 'tauri'].includes(runtime)), 'Invalid runtime configuration');
  const runtimes = !options.runtime || options.runtime === 'all' ? availableRuntimes : [options.runtime];
  assert.ok(runtimes.every(runtime => availableRuntimes.includes(runtime)), 'Invalid or unavailable runtime');
  return architectures.flatMap((arch) => {
    assert.ok(Object.hasOwn(targets[platform], arch), `Unsupported architecture: ${platform}-${arch}`);
    return runtimes.map((runtime) => ({ platform, arch, runtime, rustTarget: targets[platform][arch], formats: [...formats[platform]] }));
  });
}

export function parseOptions(args) {
  const options = {};
  for (const argument of args) {
    const match = /^--(platform|arch|runtime|dir)=(.+)$/u.exec(argument);
    assert.ok(match && !Object.hasOwn(options, match[1]), `Unknown, duplicate or empty option: ${argument}`);
    options[match[1]] = match[2];
  }
  return options;
}

export function resolveCli(projectRoot, runtime, packageName, binName) {
  const directories = runtimeDirectories(projectRoot);
  assert.ok(Object.hasOwn(directories, runtime), `Unavailable runtime: ${runtime}`);
  const require = createRequire(path.join(projectRoot, directories[runtime], 'package.json'));
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  assert.ok(typeof relative === 'string', `Missing CLI entrypoint: ${packageName}`);
  // Invoke JavaScript directly: no .cmd shim and no shell interpolation on Windows.
  return path.resolve(path.dirname(manifestPath), relative);
}

export async function readProduct(projectRoot = root) {
  const json = async (file) => JSON.parse(await readFile(path.join(projectRoot, file), 'utf8'));
  const [product, rootPackage, lock] = await Promise.all([
    json('scripts/release-product.json'), json('package.json'), json('package-lock.json'),
  ]);
  const directories = runtimeDirectories(projectRoot);
  const version = rootPackage.version;
  assert.match(version, versionPattern, 'Release version must be a filename-safe semantic version');
  assert.match(product.slug, /^[a-z0-9-]+$/u);
  const versions = [version];
  const lockKeys = [''];
  for (const [runtime, directory] of Object.entries(directories)) {
    const manifest = await json(path.join(directory, 'package.json'));
    versions.push(manifest.version);
    lockKeys.push(directory === '.' ? '' : directory);
    if (runtime === 'electron') {
      if (manifest.build) assert.equal(manifest.build.appId, product.identifiers.electron, 'Electron installation identity changed');
      else {
        const config = await readFile(path.join(projectRoot, directory, 'electron-builder.yml'), 'utf8');
        assert.equal(/^appId:\s*(.+)$/mu.exec(config)?.[1].trim(), product.identifiers.electron, 'Electron installation identity changed');
      }
    } else {
      const [tauri, cargo] = await Promise.all([
        json(path.join(directory, 'src-tauri/tauri.conf.json')),
        readFile(path.join(projectRoot, directory, 'src-tauri/Cargo.toml'), 'utf8'),
      ]);
      versions.push(tauri.version, /^version\s*=\s*"([^"]+)"/mu.exec(cargo)?.[1]);
      assert.equal(tauri.identifier, product.identifiers.tauri, 'Tauri installation identity changed');
    }
  }
  assert.ok(versions.every(item => item === version), 'Root and configured runtime versions must match');
  assert.ok(lockKeys.every(key => lock.packages?.[key]?.version === version), 'npm lockfile versions must match');
  return { ...product, version };
}

export function buildCommands(projectRoot, job, output, cli = resolveCli) {
  const directories = runtimeDirectories(projectRoot);
  assert.ok(Object.hasOwn(directories, job.runtime), `Unavailable runtime: ${job.runtime}`);
  const cwd = path.join(projectRoot, directories[job.runtime]);
  const commands = [];
  if (job.runtime === 'electron') {
    commands.push({ command: process.execPath, args: [cli(projectRoot, 'electron', 'vite', 'vite'), 'build'], cwd });
    const platformFlag = { macos: '--mac', windows: '--win', linux: '--linux' }[job.platform];
    commands.push({ command: process.execPath, args: [cli(projectRoot, 'electron', 'electron-builder', 'electron-builder'), platformFlag,
      ...job.formats, `--${job.arch}`, `--config.directories.output=${output}`,
      ...(process.env.INEED_ELECTRON_DIST ? [`--config.electronDist=${path.resolve(process.env.INEED_ELECTRON_DIST)}`] : [])], cwd,
    env: { ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/' } });
  } else {
    commands.push({ command: process.execPath, args: [cli(projectRoot, 'tauri', '@tauri-apps/cli', 'tauri'), 'build', '--target', job.rustTarget,
      '--bundles', job.formats.map((format) => format === 'AppImage' ? 'appimage' : format).join(','), '--ci', '--', '--locked'], cwd,
    env: { CARGO_TARGET_DIR: output } });
  }
  return commands;
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function artifactName(product, job, format) {
  assert.ok(job.formats.includes(format), 'Format is not in this job');
  const arch = format === 'deb' && job.arch === 'x64' ? 'amd64' : job.arch;
  const suffix = format === 'nsis' ? '-setup' : '';
  return `${product.slug}-${product.version}-${job.runtime}-${job.platform}-${arch}${suffix}${extensions[format]}`;
}

export async function checkContainer(file, format) {
  const meta = await lstat(file);
  assert.ok(meta.isFile() && !meta.isSymbolicLink() && meta.size > 64, `Invalid or empty artifact: ${file}`);
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(512);
    await handle.read(header, 0, header.length, 0);
    if (format === 'deb') assert.equal(header.subarray(0, 8).toString(), '!<arch>\n', 'Invalid Debian archive');
    else if (format === 'AppImage') {
      assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', 'Invalid AppImage ELF');
      assert.equal(header.subarray(8, 11).toString('hex'), '414902', 'Expected type-2 AppImage');
    } else if (format === 'nsis') {
      assert.equal(header.subarray(0, 2).toString(), 'MZ', 'Invalid Windows executable');
      const offset = header.readUInt32LE(60);
      assert.ok(offset >= 64 && offset + 24 <= meta.size, 'Invalid PE header offset');
      const pe = Buffer.alloc(24);
      await handle.read(pe, 0, pe.length, offset);
      assert.equal(pe.subarray(0, 4).toString('hex'), '50450000', 'Missing PE signature');
      // NSIS bootstrapper machine type need not equal the installed app architecture.
    } else if (format === 'dmg') {
      assert.ok(meta.size >= 512, 'Truncated DMG');
      const trailer = Buffer.alloc(4);
      await handle.read(trailer, 0, 4, meta.size - 512);
      assert.equal(trailer.toString(), 'koly', 'Missing UDIF trailer');
    } else throw new Error(`Unsupported format: ${format}`);
    return meta.size;
  } finally { await handle.close(); }
}

export async function collectArtifacts(product, job, nativeRoot, destination) {
  const artifacts = [];
  for (const format of job.formats) {
    const directory = job.runtime === 'electron' ? nativeRoot : path.join(nativeRoot, job.rustTarget, 'release', 'bundle', format.toLowerCase());
    const candidates = (await readdir(directory)).filter((name) => name.endsWith(extensions[format]));
    assert.equal(candidates.length, 1, `Expected exactly one ${format} in ${directory}`);
    const source = path.join(directory, candidates[0]);
    const size = await checkContainer(source, format);
    const name = artifactName(product, job, format);
    await copyFile(source, path.join(destination, name));
    artifacts.push({ runtime: job.runtime, platform: job.platform, arch: job.arch, format, name, size,
      sha256: await sha256(path.join(destination, name)) });
  }
  return artifacts;
}

function runCommand(spec, logPath) {
  console.log(`Running ${path.basename(spec.args[0])} ${spec.args.slice(1).join(' ')}`);
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    log.on('error', (error) => { child.kill(); reject(error); });
    child.on('error', (error) => { log.end(); reject(error); });
    child.on('close', (code) => log.end(() => code === 0 ? resolve() : reject(new Error(`Build exited ${code}. See ${logPath}`))));
  });
}

async function outputRoot(projectRoot) {
  const canonicalRoot = await realpath(projectRoot);
  let directory = canonicalRoot;
  for (const part of ['release', 'desktop']) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Output parent must be a real directory: ${directory}`);
  }
  return directory;
}

export async function verifyCollection(directory) {
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Collection must be a real directory');
  const manifestInfo = await lstat(path.join(directory, 'manifest.json'));
  assert.ok(manifestInfo.isFile() && !manifestInfo.isSymbolicLink(), 'Manifest must be a regular file');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2, 'Unsupported release manifest version');
  assert.match(manifest.product.slug, /^[a-z0-9-]+$/u);
  assert.match(manifest.product.version, versionPattern);
  assert.ok(manifest.jobs?.length && manifest.artifacts?.length, 'Empty release matrix');
  const expected = new Map();
  for (const job of manifest.jobs) {
    const [known] = selectJobs({ platform: job.platform, arch: job.arch, runtime: job.runtime });
    assert.deepEqual(job, known, 'Invalid matrix job');
    for (const format of known.formats) {
      const name = artifactName(manifest.product, known, format);
      assert.ok(!expected.has(name), 'Duplicate matrix job');
      expected.set(name, { runtime: known.runtime, platform: known.platform, arch: known.arch, format });
    }
  }
  assert.equal(manifest.artifacts.length, expected.size, 'Incomplete artifact set');
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    assert.ok(typeof artifact.name === 'string' && path.basename(artifact.name) === artifact.name && !artifact.name.includes('\\'), 'Unsafe artifact path');
    assert.ok(expected.has(artifact.name) && !seen.has(artifact.name), 'Unexpected or duplicate artifact');
    seen.add(artifact.name);
    for (const [key, value] of Object.entries(expected.get(artifact.name))) assert.equal(artifact[key], value, `Wrong artifact ${key}`);
    const file = path.join(directory, artifact.name);
    assert.equal(await checkContainer(file, artifact.format), artifact.size, 'Artifact size changed');
    assert.equal(await sha256(file), artifact.sha256, 'Artifact hash changed');
  }
  const entries = (await readdir(directory)).filter((name) => name !== 'manifest.json' && name !== 'build-logs');
  assert.deepEqual(entries.sort(), [...expected.keys()].sort(), 'Unexpected collection files');
  return { artifacts: expected.size, integrity: 'passed', installation: 'not-verified', runtime: 'not-verified', signing: 'not-verified' };
}

export async function buildRelease(options, projectRoot = root) {
  const product = await readProduct(projectRoot);
  const jobs = selectJobs(options, process.platform, process.arch, Object.keys(runtimeDirectories(projectRoot)));
  assert.ok(jobs.every((job) => job.platform === platforms[process.platform]), 'Build on the matching OS; use release:plan to inspect another platform');
  const output = await outputRoot(projectRoot);
  const lock = path.join(output, '.build-lock');
  try { await mkdir(lock); } catch (error) { throw new Error(`Another release build may be using this source tree: ${lock}`, { cause: error }); }
  const id = `${product.version}-${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomUUID().slice(0, 8)}`;
  const stage = path.join(output, `.stage-${id}`);
  const native = path.join(stage, 'native');
  const collection = path.join(stage, 'collection');
  try {
    await mkdir(path.join(collection, 'build-logs'), { recursive: true });
    const artifacts = [];
    for (const job of jobs) {
      const key = `${job.runtime}-${job.platform}-${job.arch}`;
      const nativeRoot = path.join(native, key);
      await mkdir(nativeRoot, { recursive: true });
      for (const command of buildCommands(projectRoot, job, nativeRoot)) await runCommand(command, path.join(collection, 'build-logs', `${key}.log`));
      artifacts.push(...await collectArtifacts(product, job, nativeRoot, collection));
    }
    let sourceCommit = null;
    let sourceDirty = null;
    try {
      sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
      sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).trim());
    } catch { /* A source archive is also a valid local build input; provenance stays unknown. */ }
    await writeFile(path.join(collection, 'manifest.json'), `${JSON.stringify({ schemaVersion: 2, product, buildId: id, sourceCommit, sourceDirty,
      jobs, artifacts, verification: { installation: 'pending', runtime: 'pending', signing: 'not-verified' } }, null, 2)}\n`);
    await verifyCollection(collection);
    const destination = path.join(output, id);
    await rename(collection, destination);
    await rm(stage, { recursive: true, force: true });
    return destination;
  } catch (error) {
    throw new Error(`Release incomplete; diagnostic files retained in ${stage}. ${error.message}`, { cause: error });
  } finally { await rmdir(lock); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [action, ...args] = process.argv.slice(2);
    assert.ok(['plan', 'build', 'verify'].includes(action), 'Usage: desktop-release.mjs plan|build|verify [--key=value]');
    const options = parseOptions(args);
    if (action === 'verify') {
      assert.ok(options.dir && Object.keys(options).length === 1, 'verify requires --dir=<collection> only');
      console.log(JSON.stringify(await verifyCollection(path.resolve(options.dir)), null, 2));
    } else {
      assert.ok(!options.dir, '--dir is only valid for verify');
      if (action === 'build') console.log(`RELEASE_DIRECTORY=${await buildRelease(options)}`);
      else {
        const product = await readProduct();
        const jobs = selectJobs(options);
        console.log(JSON.stringify({ product, hostPlatform: platforms[process.platform], jobs: jobs.map((job) => ({ ...job,
          commands: buildCommands(root, job, path.join(root, 'release/desktop/<build-id>/native', `${job.runtime}-${job.platform}-${job.arch}`)),
        })) }, null, 2));
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
