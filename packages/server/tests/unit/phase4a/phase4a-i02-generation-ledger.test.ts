import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import {
  GenerationLedger,
  LEDGER_SCHEMA_VERSION,
  NodeGenerationLedgerIO,
  validateLedgerRecord,
} from '../../../scripts/evidence/phase4a-i02-generation-ledger.js';
import type { GenerationLedgerRecord, LedgerCommitHandle, GenerationLedgerIO } from '../../../scripts/evidence/phase4a-i02-generation-ledger.js';

const KEY_PREFIX = 'capability-probes/deployment-01/';

function uuid(suffix: string): string {
  return `018f6f7a-8f2a-7a3d-a123-123456789${suffix.padStart(3, '0')}`;
}

function recordOverrides(overrides: Partial<GenerationLedgerRecord> = {}): GenerationLedgerRecord {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    intentId: uuid('001'),
    generationId: uuid('002'),
    blobId: uuid('003'),
    bucket: 'known-quarantine-production',
    key: `${KEY_PREFIX}${uuid('004')}`,
    fingerprint: 'a'.repeat(64),
    createdAtIso: '2026-08-08T00:00:00.000Z',
    committedAtIso: '2026-08-08T00:00:01.000Z',
    ...overrides,
  };
}

function commitShape(overrides: Partial<GenerationLedgerRecord> = {}): Omit<GenerationLedgerRecord, 'committedAtIso'> {
  const { committedAtIso: _omitted, ...rest } = recordOverrides(overrides);
  return rest;
}

/**
 * Mirrors NodeGenerationLedgerIO but records every fsync so the test can pin
 * the durable-write contract (write + fsync per appended record).
 */
class FsyncRecordingIO implements GenerationLedgerIO {
  syncCalls = 0;
  appendCalls = 0;

  async openForAppend(path: string): Promise<LedgerCommitHandle> {
    const handle = await open(path, 'a');
    return {
      appendLine: async (line: string) => {
        await handle.appendFile(`${line}\n`, 'utf8');
        await handle.sync();
        this.syncCalls += 1;
        this.appendCalls += 1;
      },
      close: async () => { await handle.close(); },
    };
  }

  async readText(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

async function tempLedgerPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'known-phase4a-i02-ledger-'));
  return { dir, path: join(dir, 'ledger.jsonl') };
}

/**
 * Monotonic injected clock starting after the fixed fixture timestamps
 * (createdAtIso '2026-08-08T00:00:00.000Z'), so ledger tests never depend on
 * the host wall clock (plan §5.4: explicit injected monotonic test clock).
 */
function injectedClock(startIso = '2026-08-08T02:00:00.000Z'): () => Date {
  let t = Date.parse(startIso);
  return () => new Date((t += 1000));
}

describe('P4A-I02 durable generation ledger', () => {
  test('commits a file-backed append-only record and persists it to disk', async () => {
    const { dir, path } = await tempLedgerPath();
    try {
      const io = new NodeGenerationLedgerIO();
      const clock = (() => {
        let t = Date.parse('2026-08-08T01:00:00.000Z');
        return () => new Date((t += 1000));
      })();
      const ledger = await GenerationLedger.open(io, path, clock);
      assert.equal(ledger.list().length, 0);
      const committed = await ledger.commit(commitShape());
      assert.equal(committed.committedAtIso, '2026-08-08T01:00:01.000Z');
      assert.ok(ledger.hasGeneration(committed.generationId));
      assert.ok(ledger.hasKey(committed.key));
      assert.ok(ledger.hasFingerprint(committed.fingerprint));
      await ledger.close();

      const onDisk = await readFile(path, 'utf8');
      const lines = onDisk.trim().split('\n');
      assert.equal(lines.length, 1);
      assert.deepEqual(JSON.parse(lines[0]!), committed);

      // Append-only: a second commit must not rewrite the first line.
      const again = await GenerationLedger.open(io, path, clock);
      await again.commit(commitShape({
        intentId: uuid('010'), generationId: uuid('011'), blobId: uuid('012'),
        key: `${KEY_PREFIX}${uuid('013')}`, fingerprint: 'b'.repeat(64),
      }));
      await again.close();
      const after = (await readFile(path, 'utf8')).trim().split('\n');
      assert.equal(after.length, 2);
      assert.deepEqual(JSON.parse(after[0]!), committed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fsyncs every append so a committed record is durable before the grant is issued', async () => {
    const { dir, path } = await tempLedgerPath();
    try {
      const io = new FsyncRecordingIO();
      const ledger = await GenerationLedger.open(io, path, injectedClock());
      await ledger.commit(commitShape());
      await ledger.commit(commitShape({
        intentId: uuid('020'), generationId: uuid('021'), blobId: uuid('022'),
        key: `${KEY_PREFIX}${uuid('023')}`, fingerprint: 'c'.repeat(64),
      }));
      assert.equal(io.appendCalls, 2);
      assert.equal(io.syncCalls, 2);
      await ledger.close();
      // The bytes really hit disk: a fresh instance recovers both records.
      const reopened = await GenerationLedger.open(new NodeGenerationLedgerIO(), path);
      assert.equal(reopened.list().length, 2);
      await reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects duplicate generation, key, and fingerprint at commit time', async () => {
    const { dir, path } = await tempLedgerPath();
    try {
      const ledger = await GenerationLedger.open(new NodeGenerationLedgerIO(), path, injectedClock());
      const first = await ledger.commit(commitShape());
      await assert.rejects(
        ledger.commit(commitShape({ key: `${KEY_PREFIX}${uuid('030')}` })),
        /ledger_duplicate_generation/,
      );
      await assert.rejects(
        ledger.commit(commitShape({
          generationId: uuid('031'), blobId: uuid('032'), key: first.key,
        })),
        /ledger_duplicate_key/,
      );
      await assert.rejects(
        ledger.commit(commitShape({
          generationId: uuid('033'), blobId: uuid('034'), key: `${KEY_PREFIX}${uuid('035')}`,
          fingerprint: first.fingerprint,
        })),
        /ledger_duplicate_fingerprint/,
      );
      assert.equal(ledger.list().length, 1);
      await ledger.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('recovers every record after a restart and still rejects reuse from disk facts', async () => {
    const { dir, path } = await tempLedgerPath();
    try {
      const io = new NodeGenerationLedgerIO();
      const clock = (() => {
        let t = Date.parse('2026-08-08T02:00:00.000Z');
        return () => new Date((t += 1000));
      })();
      let ledger = await GenerationLedger.open(io, path, clock);
      const first = await ledger.commit(commitShape());
      const second = await ledger.commit(commitShape({
        intentId: uuid('040'), generationId: uuid('041'), blobId: uuid('042'),
        key: `${KEY_PREFIX}${uuid('043')}`, fingerprint: 'd'.repeat(64),
      }));
      await ledger.close();

      // Simulated process restart: a brand new instance reads the same file.
      ledger = await GenerationLedger.open(io, path, clock);
      assert.equal(ledger.list().length, 2);
      assert.deepEqual(ledger.findByGeneration(first.generationId), first);
      assert.deepEqual(ledger.findByKey(second.key), second);
      assert.ok(ledger.hasFingerprint(first.fingerprint));
      await assert.rejects(
        ledger.commit(commitShape({ key: first.key, generationId: uuid('050') })),
        /ledger_duplicate_key/,
      );
      await assert.rejects(
        ledger.commit(commitShape({ generationId: first.generationId })),
        /ledger_duplicate_generation/,
      );
      await ledger.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fails closed on corrupt ledger files and invalid records', async () => {
    const { dir, path } = await tempLedgerPath();
    try {
      const io = new NodeGenerationLedgerIO();
      const ledger = await GenerationLedger.open(io, path);
      await ledger.close();
      await io.remove(path);
      await import('node:fs/promises').then(({ writeFile }) => writeFile(path, '{"not":"a-record"}\n', 'utf8'));
      await assert.rejects(GenerationLedger.open(io, path), /ledger_corrupt/);
      await io.remove(path);
      await import('node:fs/promises').then(({ writeFile }) => writeFile(path, 'not-json\n', 'utf8'));
      await assert.rejects(GenerationLedger.open(io, path), /ledger_corrupt/);
      await io.remove(path);
      // Duplicate key on disk is corruption, never silently accepted.
      await import('node:fs/promises').then(({ writeFile }) => {
        const line = JSON.stringify(recordOverrides());
        return writeFile(path, `${line}\n${line}\n`, 'utf8');
      });
      await assert.rejects(GenerationLedger.open(io, path), /ledger_corrupt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('validates every ledger field with stable codes', () => {
    assert.doesNotThrow(() => validateLedgerRecord(recordOverrides()));
    assert.throws(() => validateLedgerRecord({ ...recordOverrides(), schemaVersion: 3 }), /ledger_record_invalid:schemaVersion/);
    for (const field of ['intentId', 'generationId', 'blobId'] as const) {
      assert.throws(() => validateLedgerRecord(recordOverrides({ [field]: 'not-a-uuid' })), new RegExp(`ledger_record_invalid:${field}`));
    }
    assert.throws(() => validateLedgerRecord(recordOverrides({ bucket: 'UPPER' })), /ledger_record_invalid:bucket/);
    assert.throws(() => validateLedgerRecord(recordOverrides({ key: 'user-supplied/name' })), /ledger_record_invalid:key/);
    assert.throws(() => validateLedgerRecord(recordOverrides({ key: `${KEY_PREFIX}not-a-uuid` })), /ledger_record_invalid:key/);
    assert.throws(() => validateLedgerRecord(recordOverrides({ fingerprint: 'xyz' })), /ledger_record_invalid:fingerprint/);
    assert.throws(() => validateLedgerRecord(recordOverrides({ createdAtIso: 'nope' })), /ledger_record_invalid:createdAtIso/);
    assert.throws(() => validateLedgerRecord(recordOverrides({ committedAtIso: '2026-08-07T23:59:59.000Z' })), /ledger_record_invalid:committedAtIso/);
    assert.throws(() => validateLedgerRecord(null), /ledger_record_invalid:shape/);
  });

  test('never persists URLs, query signatures, credentials, or bodies in the ledger', async () => {
    const { dir, path } = await tempLedgerPath();
    try {
      const ledger = await GenerationLedger.open(new NodeGenerationLedgerIO(), path, injectedClock());
      await ledger.commit(commitShape());
      await ledger.close();
      const onDisk = await readFile(path, 'utf8');
      for (const forbidden of [
        'X-Amz-', 'X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-SignedHeaders',
        'Signature=', 'Credential=', 'http://', 'https://',
        'write-access-key-marker', 'write-secret-marker',
        'phase4a-i02-body', 'Bucket=', 'Body=',
      ]) {
        assert.equal(onDisk.includes(forbidden), false, `ledger leaked ${forbidden}`);
      }
      assert.match(onDisk, /capability-probes\/[A-Za-z0-9._-]+\/[a-f0-9-]{36}/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
