import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';

const EXTENSION_PATH = resolve('scripts/evidence/phase3-indexeddb-entry-extension');
const FIXTURE_PATH = resolve('tests/fixtures/phase3/indexeddb-v1-state.json');

describe('P3-03 packaged MV3 IndexedDB entry contract', () => {
  test('ships a real MV3 worker and extension page without credential storage', async () => {
    const manifest = JSON.parse(await readFile(resolve(EXTENSION_PATH, 'manifest.json'), 'utf8')) as {
      manifest_version?: number;
      background?: { service_worker?: string };
      permissions?: string[];
    };
    const worker = await readFile(resolve(EXTENSION_PATH, 'service-worker.js'), 'utf8');
    const store = await readFile(resolve(EXTENSION_PATH, 'state-store.js'), 'utf8');
    const probe = await readFile(resolve(EXTENSION_PATH, 'probe.html'), 'utf8');

    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background?.service_worker, 'service-worker.js');
    assert.deepEqual(manifest.permissions, []);
    assert.match(worker, /importScripts\('state-store\.js'\)/);
    assert.match(worker, /known\.phase3\.indexeddb\.call/);
    assert.match(worker, /crypto\.randomUUID\(\)/);
    assert.match(worker, /workerInstance/);
    assert.match(worker, /return true/);
    assert.match(probe, /state-store\.js/);
    assert.doesNotMatch(worker + store + probe, /accessToken|refreshToken|authorizationCode|clientSecret/);
  });

  test('uses versioned IndexedDB stores whose keys include server, Collection and Replica', async () => {
    const source = await readFile(resolve(EXTENSION_PATH, 'state-store.js'), 'utf8');
    assert.match(source, /indexedDB\.open/);
    assert.match(source, /DATABASE_VERSION\s*=\s*2/);
    assert.match(source, /\['serverId', 'collectionId', 'replicaId'\]/);
    assert.match(source, /\['serverId', 'collectionId', 'replicaId', 'eventId'\]/);
    assert.match(source, /transaction\([^)]*'readwrite'/s);
    assert.match(source, /Number\.isSafeInteger/);
    assert.match(source, /validateSafeIntegers/);
    assert.doesNotMatch(source, /fake-indexeddb|localStorage|chrome\.storage/);
  });

  test('keeps one atomic replica record for queue, receipt, cursor, mapping and apply-intent', async () => {
    const source = await readFile(resolve(EXTENSION_PATH, 'state-store.js'), 'utf8');
    for (const fact of [
      'queuedOperation', 'nextSequence', 'receipt', 'cursor', 'nativeMapping', 'applyIntent',
    ]) assert.match(source, new RegExp(fact));
    assert.match(source, /receipt\.publishedCursor/);
    assert.match(source, /transaction\.abort\(\)/);
    assert.match(source, /QuotaExceededError/);
    assert.match(source, /upgrade_failed/);
    assert.match(source, /async function readLease/);
    assert.match(source, /readLease,/);
  });

  test('pins a fixed legacy schema fixture with the complete recovery boundary', async () => {
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as {
      schemaVersion: number;
      storeName: string;
      state: {
        generation: number;
        nextSequence: number;
        cursor: string;
        queuedOperation: { sequence: number; opId: string; acknowledged: boolean };
        receipt: { opId: string; publishedCursor: string };
        applyIntent: { status: string };
        nativeMapping: { nativeId: string };
      };
    };
    assert.equal(fixture.schemaVersion, 1);
    assert.equal(fixture.storeName, 'replica_state');
    assert.equal(fixture.state.generation, 7);
    assert.equal(fixture.state.nextSequence, 42);
    assert.equal(fixture.state.queuedOperation.sequence, 41);
    assert.equal(fixture.state.queuedOperation.acknowledged, false);
    assert.equal(fixture.state.queuedOperation.opId, fixture.state.receipt.opId);
    assert.notEqual(fixture.state.cursor, fixture.state.receipt.publishedCursor);
    assert.equal(fixture.state.applyIntent.status, 'pending');
    assert.ok(fixture.state.cursor);
    assert.ok(fixture.state.nativeMapping.nativeId);
  });
});
