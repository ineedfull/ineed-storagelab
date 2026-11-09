#!/usr/bin/env node
// Kept identical across tools; each product descriptor owns its upload prefix.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyCollection } from './desktop-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sshHost = '222.71.62.146';
const bucket = 'ineed-downloads';
const productSlug = JSON.parse(readFileSync(path.join(root, 'scripts/release-product.json'), 'utf8')).slug;
const alias = 'myminio';
const safePart = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function objectKey(manifest, artifact) {
  assert.match(manifest.product.version, safePart, 'Unsafe release version');
  assert.match(manifest.buildId, safePart, 'Unsafe build ID');
  assert.match(artifact.name, safePart, 'Unsafe artifact name');
  assert.equal(manifest.product.slug, productSlug, 'Wrong release product');
  return `${productSlug}/${manifest.product.version}/${manifest.buildId}/${artifact.name}`;
}

export async function uploadCollection(directory, transport) {
  await verifyCollection(directory);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.product.slug, productSlug, 'Wrong release product');
  for (const artifact of manifest.artifacts) objectKey(manifest, artifact);

  const artifacts = [];
  for (const artifact of manifest.artifacts) {
    const key = objectKey(manifest, artifact);
    const file = path.join(directory, artifact.name);
    const existing = await transport.stat(key);
    if (existing === null) await transport.put(file, key);
    const remote = existing ?? await transport.stat(key);
    assert.equal(remote?.size, artifact.size, `Remote size mismatch: ${key}`);
    assert.equal(await transport.sha256(key), artifact.sha256, `Remote SHA-256 mismatch: ${key}`);
    artifacts.push({ ...artifact, key });
  }

  return {
    schemaVersion: 1,
    product: manifest.product,
    buildId: manifest.buildId,
    sourceCommit: manifest.sourceCommit ?? null,
    sourceDirty: manifest.sourceDirty ?? null,
    bucket,
    visibility: 'private',
    artifacts,
  };
}

function remoteTarget(key) {
  assert.match(key, /^[A-Za-z0-9._/-]+$/u);
  return `${alias}/${bucket}/${key}`;
}

function ssh(command, inputFile) {
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65_536) child.kill(); });
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 65_536) child.kill(); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  if (inputFile) {
    const transfer = pipeline(createReadStream(inputFile), child.stdin).catch(error => {
      child.kill();
      throw error;
    });
    return Promise.allSettled([done, transfer]).then(([processResult, streamResult]) => {
      if (processResult.status === 'rejected') throw processResult.reason;
      if (streamResult.status === 'rejected') throw streamResult.reason;
      return processResult.value;
    });
  } else child.stdin.end();
  return done;
}

function requireSuccess(result, operation) {
  if (result.code !== 0) throw new Error(`${operation} failed: ${result.stderr || result.stdout || result.signal}`);
  return result.stdout;
}

export function createSshTransport() {
  return {
    async stat(key) {
      const result = await ssh(`mc stat --json ${remoteTarget(key)}`);
      const response = JSON.parse(result.stdout.trim());
      if (result.code !== 0) {
        if (response.error?.cause?.message === 'Object does not exist') return null;
        throw new Error(`MinIO stat failed: ${response.error?.message || result.stderr}`);
      }
      assert.ok(Number.isSafeInteger(response.size) && response.size >= 0, 'Invalid remote object size');
      return { size: response.size };
    },
    async put(file, key) {
      requireSuccess(await ssh(`mc pipe --quiet --part-size 16MiB ${remoteTarget(key)}`, file), 'MinIO upload');
    },
    async sha256(key) {
      const target = remoteTarget(key);
      const output = requireSuccess(await ssh(`bash -o pipefail -c 'mc cat ${target} | sha256sum'`), 'MinIO digest');
      const digest = /^([0-9a-f]{64})\s/iu.exec(output)?.[1];
      assert.ok(digest, 'Invalid remote SHA-256 response');
      return digest.toLowerCase();
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 1, 'Usage: release:upload -- --dir=/absolute/release/directory');
    const match = /^--dir=(.+)$/u.exec(args[0]);
    assert.ok(match && path.isAbsolute(match[1]), 'Release directory must be absolute');
    const receipt = await uploadCollection(match[1], createSshTransport());
    const output = path.join(root, 'release', 'uploads', bucket);
    await mkdir(output, { recursive: true });
    const receiptFile = path.join(output, `${receipt.buildId}.json`);
    try {
      await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = JSON.parse(await readFile(receiptFile, 'utf8'));
      assert.deepEqual(previous, receipt, 'Existing upload receipt differs');
    }
    console.log(`UPLOAD_RECEIPT=${receiptFile}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
