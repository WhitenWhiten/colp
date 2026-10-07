import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { classifyLedgerArchiveFailure } from '../../../src/bootstrap/ledger-archive-worker-composition.js';
import {
  reclaimLedgerArchiveSpoolSync,
} from '../../../src/infrastructure/ledger-archive/spool-reclaim.js';

test('reclaim deletes orphan jsonl and skips in-flight or foreign files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'known-archive-spool-'));
  const orphan = join(root, 'seg.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');
  const inflight = join(root, 'seg.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
  const other = join(root, 'keep.txt');
  await writeFile(orphan, 'orphan');
  await writeFile(inflight, 'live');
  await writeFile(other, 'meta');
  const now = Date.now();
  await utimes(orphan, now / 1000 - 400, now / 1000 - 400);
  await utimes(inflight, now / 1000, now / 1000);
  const result = reclaimLedgerArchiveSpoolSync(root, { now, maxAgeMs: 300_000 });
  assert.deepEqual(result, { removed: 1, skipped: 2 });
  await assert.rejects(() => access(orphan, fsConstants.F_OK), /ENOENT/u);
  await access(inflight, fsConstants.F_OK);
  await access(other, fsConstants.F_OK);
});

test('readonly spool and disk-full errors stay bounded and retryable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'known-archive-spool-ro-'));
  await writeFile(join(root, 'old.jsonl'), 'x');
  const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  assert.throws(() => reclaimLedgerArchiveSpoolSync(root, {
    now: Date.now() + 400_000, maxAgeMs: 300_000,
    unlink() { throw eacces; },
  }), /archive_spool_unavailable/u);
  const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
  const erofs = Object.assign(new Error('read only'), { code: 'EROFS' });
  assert.deepEqual(classifyLedgerArchiveFailure(enospc), {
    errorClass: 'archive_spool_unavailable', retryable: true,
  });
  assert.deepEqual(classifyLedgerArchiveFailure(erofs), {
    errorClass: 'archive_spool_unavailable', retryable: true,
  });
  assert.equal(reclaimLedgerArchiveSpoolSync(join(root, 'missing')).removed, 0);
  await mkdir(join(root, 'restart'), { recursive: true });
  assert.deepEqual(reclaimLedgerArchiveSpoolSync(join(root, 'restart')), { removed: 0, skipped: 0 });
});
