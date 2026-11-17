import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSafeExportWriter } from '../electron/safe-export.js';

for (const stage of ['write', 'sync', 'rename']) {
  test(`export ${stage} failure preserves the previous file and cleans temporary files`, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'export-failure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const destination = join(root, 'report.json'); await fs.writeFile(destination, 'old evidence');
    const injected = { ...fs,
      rename: async (...args) => { if (stage === 'rename') throw Error('injected failure'); return fs.rename(...args); },
      open: async (...args) => {
        const handle = await fs.open(...args);
        return {
          stat: () => handle.stat(), close: () => handle.close(),
          writeFile: async value => { await handle.writeFile(value); if (stage === 'write') throw Error('injected failure'); },
          sync: async () => { if (stage === 'sync') throw Error('injected failure'); await handle.sync(); },
        };
      },
    };
    await assert.rejects(createSafeExportWriter({ files: injected })(destination, 'new evidence'), /injected failure/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'old evidence');
    assert.deepEqual(await fs.readdir(root), ['report.json']);
  });
}

test('target substitution during streaming never follows a link or overwrites an unconfirmed file', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'export-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = join(root, 'report'), protectedFile = join(root, 'database');
  await fs.writeFile(protectedFile, 'database');
  await fs.writeFile(destination, 'old');
  const writer = createSafeExportWriter();
  await assert.rejects(writer(destination, async handle => {
    await handle.writeFile('part 1');
    await fs.unlink(destination); await fs.symlink(protectedFile, destination);
    await handle.writeFile('part 2');
  }));
  assert.equal(await fs.readFile(protectedFile, 'utf8'), 'database');
  assert((await fs.lstat(destination)).isSymbolicLink());
  await fs.unlink(destination);
  await assert.rejects(writer(destination, async handle => {
    await handle.writeFile('new'); await fs.writeFile(destination, 'external update');
  }));
  assert.equal(await fs.readFile(destination, 'utf8'), 'external update');
  assert.equal((await fs.readdir(root)).some(name => name.endsWith('.tmp')), false);
});
