import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactName, buildCommands, checkContainer, collectArtifacts, parseOptions, readProduct, resolveCli, selectJobs, sha256, verifyCollection, buildRelease } from './desktop-release.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const descriptor = JSON.parse(await readFile(path.join(root, 'scripts/release-product.json'), 'utf8'));
const directories = descriptor.runtimeDirectories ?? { electron: 'apps/electron', tauri: 'apps/tauri' };
const availableRuntimes = Object.keys(directories);
const product = { slug: 'test-app', version: '1.2.3' };
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ineed-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function fakeContainer(format) {
  const bytes = Buffer.alloc(1024);
  if (format === 'dmg') bytes.write('koly', 512);
  if (format === 'deb') bytes.write('!<arch>\n');
  if (format === 'AppImage') { bytes.write('7f454c46', 0, 'hex'); bytes.write('414902', 8, 'hex'); }
  if (format === 'nsis') { bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('50450000', 128, 'hex'); }
  return bytes;
}
async function collection(t) {
  const directory = await fixture(t);
  const jobs = selectJobs({ platform: 'linux', runtime: 'electron' });
  const artifacts = [];
  for (const format of jobs[0].formats) {
    const name = artifactName(product, jobs[0], format);
    const bytes = fakeContainer(format);
    await writeFile(path.join(directory, name), bytes);
    artifacts.push({ runtime: 'electron', platform: 'linux', arch: 'x64', format, name, size: bytes.length, sha256: await sha256(path.join(directory, name)) });
  }
  const manifest = { schemaVersion: 2, product, jobs, artifacts };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest };
}

test('host matrix uses Windows installers, two Linux formats and both Mac architectures', () => {
  assert.deepEqual(selectJobs({}, 'win32', 'x64').map((job) => job.formats), availableRuntimes.map(() => ['nsis']));
  assert.equal(selectJobs({ platform: 'macos', arch: 'all' }).length, availableRuntimes.length * 2);
  assert.deepEqual(selectJobs({ platform: 'linux' })[0].formats, ['deb', 'AppImage']);
  assert.throws(() => selectJobs({ platform: 'windows', arch: 'arm64' }), /Unsupported architecture/);
  assert.throws(() => selectJobs({ platform: 'unknown' }), /Unsupported platform/);
  assert.throws(() => parseOptions(['--arch=x64', '--arch=arm64']), /duplicate/);
  assert.throws(() => parseOptions(['--shell=anything']), /Unknown/);
});
test('commands build renderer before Electron and preserve paths as arguments without cmd shims', async t => {
  const [job] = selectJobs({ platform: 'windows', runtime: 'electron' });
  const directory = path.join(await fixture(t), '中文 workspace & release');
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await writeFile(path.join(directory, 'scripts/release-product.json'), JSON.stringify(descriptor));
  const commands = buildCommands(directory, job, path.join(directory, 'output'), (_root, _runtime, name) => path.join(directory, name, 'cli.js'));
  assert.equal(commands[0].args[1], 'build');
  assert.ok(commands[0].args[0].includes('vite'));
  assert.ok(commands[1].args.includes('nsis'));
  assert.ok(!commands[1].args.includes('portable'));
  assert.ok(commands.every((command) => command.command === process.execPath));
  assert.equal(commands[1].args.at(-1), `--config.directories.output=${path.join(directory, 'output')}`);
  assert.ok(commands.every(command => command.cwd === path.join(directory, directories.electron)));
  if (availableRuntimes.includes('tauri')) {
    const tauriJob = selectJobs({ platform: 'linux', runtime: 'tauri' })[0];
    const [tauri] = buildCommands(directory, tauriJob, directory, () => 'tauri.js');
    assert.ok(tauri.args.includes('deb,appimage'));
    assert.deepEqual(tauri.args.slice(-2), ['--', '--locked']);
    assert.equal(tauri.env.CARGO_TARGET_DIR, directory);
  }
});
test('real CLI resolution and all product version / identity checks succeed', async () => {
  await readProduct(root);
  for (const [runtime, name, bin] of [['electron', 'vite', 'vite'], ['electron', 'electron-builder', 'electron-builder'], ...(availableRuntimes.includes('tauri') ? [['tauri', '@tauri-apps/cli', 'tauri']] : [])]) {
    assert.match(resolveCli(root, runtime, name, bin), /\.js$/u);
  }
});
test('Tauri uses a per-user wizard with offline WebView2, icons exist', { skip: !availableRuntimes.includes('tauri') }, async () => {
  const config = JSON.parse(await readFile(path.join(root, 'apps/tauri/src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
  assert.equal(config.bundle.windows.allowDowngrades, false);
  for (const icon of config.bundle.icon) assert.ok((await readFile(path.join(root, 'apps/tauri/src-tauri', icon))).length > 0);
});
test('all container checks reject renamed text and truncated executables', async (t) => {
  const directory = await fixture(t);
  const file = path.join(directory, 'artifact');
  for (const format of ['deb', 'dmg', 'nsis', 'AppImage']) {
    await writeFile(file, fakeContainer(format));
    assert.equal(await checkContainer(file, format), 1024);
    await writeFile(file, Buffer.alloc(1024, 65));
    await assert.rejects(checkContainer(file, format));
  }
});
test('collection validates both Linux formats but never claims installation or signing acceptance', async (t) => {
  const { directory } = await collection(t);
  assert.deepEqual(await verifyCollection(directory), { artifacts: 2, integrity: 'passed', installation: 'not-verified', runtime: 'not-verified', signing: 'not-verified' });
});
test('changed artifact bytes are rejected even when file size is unchanged', async (t) => {
  const { directory, manifest } = await collection(t);
  const file = path.join(directory, manifest.artifacts[0].name);
  const bytes = await readFile(file); bytes[200] = 7;
  await writeFile(file, bytes);
  await assert.rejects(verifyCollection(directory), /hash changed/);
});
test('missing formats, duplicate entries and unexpected files fail closed', async (t) => {
  const { directory, manifest } = await collection(t);
  const save = () => writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const original = [...manifest.artifacts];
  manifest.artifacts.pop(); await save();
  await assert.rejects(verifyCollection(directory), /Incomplete/);
  manifest.artifacts = [original[0], original[0]]; await save();
  await assert.rejects(verifyCollection(directory), /duplicate artifact/);
  manifest.artifacts = original; await save();
  await writeFile(path.join(directory, 'old-package.exe'), 'stale');
  await assert.rejects(verifyCollection(directory), /Unexpected collection/);
});
test('artifact traversal and symlinks cannot redirect verification', async (t) => {
  const { directory, manifest } = await collection(t);
  manifest.artifacts[0].name = '../outside.deb';
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyCollection(directory), /Unsafe artifact path/);
  if (process.platform !== 'win32') {
    const file = path.join(directory, 'real.deb');
    await writeFile(file, fakeContainer('deb'));
    const link = path.join(directory, 'link.deb');
    await symlink(file, link);
    await assert.rejects(checkContainer(link, 'deb'), /Invalid or empty/);
  }
});
test('collector uses final bundle directories, excludes unpacked apps and refuses duplicate outputs', async (t) => {
  const directory = await fixture(t);
  const native = path.join(directory, 'native'); const out = path.join(directory, 'out');
  await mkdir(native); await mkdir(out);
  const [job] = selectJobs({ platform: 'windows', runtime: 'electron' });
  await writeFile(path.join(native, 'setup.exe'), fakeContainer('nsis'));
  await mkdir(path.join(native, 'win-unpacked'));
  await writeFile(path.join(native, 'win-unpacked', 'app.exe'), fakeContainer('nsis'));
  const artifacts = await collectArtifacts(product, job, native, out);
  assert.equal(artifacts.length, 1);
  assert.equal((await readdir(out)).length, 1);
  await writeFile(path.join(native, 'stale-setup.exe'), fakeContainer('nsis'));
  await assert.rejects(collectArtifacts(product, job, native, out), /exactly one/);
});

test('Electron installer keeps user data and offers a non-admin directory-selection wizard', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, directories.electron, 'package.json'), 'utf8'));
  const require = createRequire(import.meta.url);
  const config = manifest.build ?? require('js-yaml').load(await readFile(path.join(root, directories.electron, 'electron-builder.yml'), 'utf8'));
  assert.equal(config.win.target, 'nsis');
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.deepEqual(config.linux.target, ['deb', 'AppImage']);
});

test('single-runtime products reject absent runtimes and only select their existing host', () => {
  const jobs = selectJobs({ platform: 'macos', arch: 'all' }, 'darwin', 'arm64', ['electron']);
  assert.deepEqual(jobs.map(job => job.runtime), ['electron', 'electron']);
  assert.throws(() => selectJobs({ platform: 'linux', runtime: 'tauri' }, 'linux', 'x64', ['electron']), /runtime/);
});

test('root Electron products validate their existing identity and lockfile without Tauri files', async t => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/release-product.json'), JSON.stringify({
    slug: 'root-tool', identifiers: { electron: 'com.example.root-tool' }, runtimeDirectories: { electron: '.' },
  }));
  const manifest = { version: '1.2.3', build: { appId: 'com.example.root-tool' } };
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '1.2.3' } } }));
  assert.equal((await readProduct(directory)).version, '1.2.3');
  manifest.build.appId = 'com.example.wrong';
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(readProduct(directory), /identity/);
  manifest.build.appId = 'com.example.root-tool';
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '1.2.4' } } }));
  await assert.rejects(readProduct(directory), /lockfile/);
});

test('root Electron build commands run in the configured source directory', async t => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/release-product.json'), JSON.stringify({ runtimeDirectories: { electron: '.' } }));
  const [job] = selectJobs({ platform: 'windows', runtime: 'electron' });
  const commands = buildCommands(directory, job, path.join(directory, 'output'), () => 'test-cli.js');
  assert.ok(commands.every(command => command.cwd === directory));
});

test('release builds reject absent runtimes before creating output directories', async t => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts/release-product.json'), JSON.stringify({
    slug: 'root-tool', identifiers: { electron: 'com.example.root-tool' }, runtimeDirectories: { electron: '.' },
  }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2.3', build: { appId: 'com.example.root-tool' } }));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '1.2.3' } } }));
  await assert.rejects(buildRelease({ runtime: 'tauri' }, directory), /runtime/);
  await assert.rejects(readdir(path.join(directory, 'release')), { code: 'ENOENT' });
});
