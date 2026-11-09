import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { uploadCollection } from './release-upload.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { slug, runtimeDirectories } = JSON.parse(await readFile(path.join(root, 'scripts/release-product.json'), 'utf8'));

const runtimes = Object.keys(runtimeDirectories ?? { electron: 'apps/electron', tauri: 'apps/tauri' });

async function fixture(t, runtime = 'electron') {
  const directory = await mkdtemp(path.join(tmpdir(), 'ineed-upload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = `${slug}-0.1.0-${runtime}-macos-arm64.dmg`;
  const bytes = Buffer.alloc(1024);
  bytes.write('koly', 512);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(directory, name), bytes);
  const manifest = {
    schemaVersion: 2,
    product: { slug, version: '0.1.0' },
    buildId: '0.1.0-20261001T000000000Z-aabbccdd',
    sourceCommit: 'abc123',
    sourceDirty: true,
    jobs: [{ platform: 'macos', arch: 'arm64', runtime, rustTarget: 'aarch64-apple-darwin', formats: ['dmg'] }],
    artifacts: [{ runtime, platform: 'macos', arch: 'arm64', format: 'dmg', name, size: bytes.length, sha256 }],
  };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest, bytes };
}

function memoryTransport() {
  const objects = new Map();
  const calls = [];
  return {
    calls,
    objects,
    async stat(key) {
      calls.push(['stat', key]);
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async put(file, key) {
      calls.push(['put', key]);
      objects.set(key, await readFile(file));
    },
    async sha256(key) {
      calls.push(['sha256', key]);
      return createHash('sha256').update(objects.get(key)).digest('hex');
    },
  };
}

for (const runtime of runtimes) {
  test(`uploads verified ${runtime} artifacts to immutable build keys and verifies remote bytes`, async t => {
    const { directory, manifest } = await fixture(t, runtime);
    const transport = memoryTransport();
    const receipt = await uploadCollection(directory, transport);
    const key = `${slug}/0.1.0/${manifest.buildId}/${manifest.artifacts[0].name}`;
    assert.deepEqual(transport.calls, [['stat', key], ['put', key], ['stat', key], ['sha256', key]]);
    assert.equal(receipt.artifacts[0].key, key);
    assert.equal(receipt.artifacts[0].sha256, manifest.artifacts[0].sha256);
    assert.equal(receipt.visibility, 'private');
    assert.equal(receipt.bucket, 'ineed-downloads');
    assert.equal(receipt.sourceDirty, true);
    assert.equal(transport.objects.get(key).length, manifest.artifacts[0].size);
  });

  test(`${runtime} retries skip identical objects and reject changed remote bytes`, async t => {
    const { directory } = await fixture(t, runtime);
    const transport = memoryTransport();
    await uploadCollection(directory, transport);
    transport.calls.length = 0;
    await uploadCollection(directory, transport);
    assert.deepEqual(transport.calls.map(([action]) => action), ['stat', 'sha256']);
    transport.objects.values().next().value[100] = 1;
    await assert.rejects(uploadCollection(directory, transport), /Remote SHA-256 mismatch/);
  });

}

test('rejects a tampered local collection before contacting MinIO', async t => {
  const { directory, manifest } = await fixture(t);
  const transport = memoryTransport();
  const tampered = Buffer.from((await readFile(path.join(directory, manifest.artifacts[0].name))));
  tampered[100] = 1;
  await writeFile(path.join(directory, manifest.artifacts[0].name), tampered);
  await assert.rejects(uploadCollection(directory, transport), /Artifact hash changed/);
  assert.equal(transport.calls.length, 0);
});

test('rejects unsafe build IDs before contacting MinIO', async t => {
  const { directory, manifest } = await fixture(t);
  manifest.buildId = '../wrong-bucket';
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const transport = memoryTransport();
  await assert.rejects(uploadCollection(directory, transport), /build ID/);
  assert.equal(transport.calls.length, 0);
});
