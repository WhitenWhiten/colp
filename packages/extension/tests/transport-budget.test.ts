import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  encodeSyncTransportBudgetHeader,
  jsonFitsTransportBudget,
  LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  legacySyncTransportBudget,
  parseSyncTransportBudget,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
  utf8JsonByteLength,
} from '@know-n/colp/sync';
import {
  declaredClientTransportBudget,
  parseSyncTransportBudgetHeader,
  sessionTransportBudget,
} from '../src/colp-transport-budget-browser.js';
import { createSyncSession, parseSyncSessionResult } from '../src/session-client.js';
import { readServiceWorkerGraph } from './service-worker-graph.js';

const NOW = Date.parse('2026-08-30T00:00:00.000Z');
const budgetBoundaries = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/transport-budget-boundaries.json'), 'utf8'),
) as {
  readonly boundaries: ReadonlyArray<{
    readonly id: string;
    readonly pullResponseBytes: number;
    readonly snapshotPageBytes: number;
    readonly effectPageBytes: number;
    readonly effectAggregateBytes: number;
  }>;
};

describe('SYNC-Q-003 Extension transport budget', () => {
  test('reads the shared 2/5/8 MiB fixture including UTF-8 envelope overhead', () => {
    assert.deepEqual(budgetBoundaries.boundaries.map((row) => row.id), [
      'legacy-2mib', 'mid-5mib', 'high-8mib',
    ]);
    assert.equal(budgetBoundaries.boundaries[0]?.pullResponseBytes, LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    for (const row of budgetBoundaries.boundaries) {
      const budget = parseSyncTransportBudget({
        pullResponseBytes: row.pullResponseBytes,
        snapshotPageBytes: row.snapshotPageBytes,
        effectPageBytes: row.effectPageBytes,
        effectAggregateBytes: row.effectAggregateBytes,
      });
      assert.equal(sessionTransportBudget({ transportBudget: budget }).pullResponseBytes, row.pullResponseBytes);
      assert.equal(jsonFitsTransportBudget({ t: 'x'.repeat(16) }, row.pullResponseBytes), true);
      assert.equal(utf8JsonByteLength({ t: 'x'.repeat(row.pullResponseBytes) }) > row.pullResponseBytes, true);
      assert.equal(jsonFitsTransportBudget({ t: 'x'.repeat(row.pullResponseBytes) }, row.pullResponseBytes), false);
    }
  });

  test('browser copy and COLP share the same extension, header and legacy 2 MiB fallback', () => {
    assert.equal(SYNC_TRANSPORT_BUDGET_EXTENSION,
      'https://know-n.com/colp/extensions/sync-transport-budget');
    assert.equal(SYNC_TRANSPORT_BUDGET_HEADER, 'Known-Sync-Transport-Budget');
    assert.deepEqual(declaredClientTransportBudget(), legacySyncTransportBudget());
    assert.equal(sessionTransportBudget({}).pullResponseBytes, LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    assert.equal(sessionTransportBudget({
      transportBudget: { ...legacySyncTransportBudget(), pullResponseBytes: 64 * 1024 },
    }).pullResponseBytes, 64 * 1024);
    assert.throws(() => parseSyncTransportBudgetHeader('{'), /invalid/i);
  });

  test('Session parse stores the negotiated header and treats a missing header as legacy', async () => {
    const request = sessionRequest();
    const digest = 'a'.repeat(64);
    const missing = parseSyncSessionResult(sessionResult(), request, digest);
    assert.deepEqual(missing.transportBudget, legacySyncTransportBudget());
    const tighter = {
      pullResponseBytes: 64 * 1024,
      snapshotPageBytes: 64 * 1024,
      effectPageBytes: 32 * 1024,
      effectAggregateBytes: 64 * 1024,
    };
    const stored = parseSyncSessionResult(sessionResult(), request, digest, tighter);
    assert.deepEqual(stored.transportBudget, tighter);
    await assert.rejects(createSyncSession({
      endpoints: { syncSessions: 'https://known.example/session' } as never,
      credential: { accessToken: 'token' } as never,
      request,
      fetch: async () => new Response(JSON.stringify(sessionResult()), {
        status: 201,
        headers: { 'content-type': 'application/json', [SYNC_TRANSPORT_BUDGET_HEADER]: '{' },
      }),
    }), /session_invalid/);
    const created = await createSyncSession({
      endpoints: { syncSessions: 'https://known.example/session' } as never,
      credential: { accessToken: 'token' } as never,
      request,
      fetch: async () => new Response(JSON.stringify(sessionResult()), {
        status: 201,
        headers: {
          'content-type': 'application/json',
          [SYNC_TRANSPORT_BUDGET_HEADER]: encodeSyncTransportBudgetHeader(tighter),
        },
      }),
    });
    assert.deepEqual(created.transportBudget, tighter);

    const largerThanDeclared = parseSyncTransportBudget({
      pullResponseBytes: budgetBoundaries.boundaries[2]!.pullResponseBytes,
      snapshotPageBytes: budgetBoundaries.boundaries[2]!.snapshotPageBytes,
      effectPageBytes: budgetBoundaries.boundaries[2]!.effectPageBytes,
      effectAggregateBytes: budgetBoundaries.boundaries[2]!.effectAggregateBytes,
    });
    await assert.rejects(createSyncSession({
      endpoints: { syncSessions: 'https://known.example/session' } as never,
      credential: { accessToken: 'token' } as never,
      request,
      fetch: async () => new Response(JSON.stringify(sessionResult()), {
        status: 201,
        headers: {
          'content-type': 'application/json',
          [SYNC_TRANSPORT_BUDGET_HEADER]: encodeSyncTransportBudgetHeader(largerThanDeclared),
        },
      }),
    }), /session_invalid/);
  });

  test('bounded readers and Session request take budget from Session authority', async () => {
    const worker = await readServiceWorkerGraph();
    const stager = await readFile(resolve('src/pull-page-stager.ts'), 'utf8');
    const codec = await readFile(resolve('src/pull-codec.ts'), 'utf8');
    const engine = await readFile(resolve('src/durable-sync-engine.ts'), 'utf8');
    const session = await readFile(resolve('src/session-client.ts'), 'utf8');
    assert.match(worker, /SYNC_TRANSPORT_BUDGET_EXTENSION/);
    assert.match(worker, /declaredClientTransportBudget/);
    assert.match(stager, /sessionTransportBudget/);
    assert.match(codec, /byteLength/);
    assert.doesNotMatch(stager, /const MAX_PULL_BYTES = 2 \* 1024 \* 1024/);
    assert.match(engine, /sessionTransportBudget/);
    assert.match(engine, /payload_too_large/);
    assert.doesNotMatch(engine, /const RESPONSE_MAX_BYTES = 2 \* 1024 \* 1024/);
    assert.match(session, /Known-Sync-Transport-Budget|SYNC_TRANSPORT_BUDGET_HEADER/);
  });
});

function sessionRequest() {
  return {
    protocolVersion: '0.2',
    replica: { replicaId: 'replica-budget', name: 'Chromium', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: false, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'profile-budget', mountMode: 'mounted-folder',
        mountNativeId: 'unconfigured', generation: '1' }, extensions: {} },
    scope: 'collection',
    collection: { collectionId: 'collection-budget', lastCursor: null, lastRevision: null,
      bootstrapMode: 'download' },
    clientTime: new Date(NOW).toISOString(),
  };
}

function sessionResult() {
  return {
    sessionId: 'session-budget', expiresAt: new Date(NOW + 300_000).toISOString(),
    serverTime: new Date(NOW).toISOString(), clockSkewMilliseconds: 0,
    acceptedProtocolVersion: '0.2', scope: 'collection', maxBatchOperations: 1,
    tombstoneRetentionSeconds: 86_400,
    collection: { collectionId: 'collection-budget', snapshotRequired: false,
      serverCursor: 'cursor-budget', serverRevision: 'revision-budget' },
    replicaLease: { leaseId: 'lease-budget', generation: '1', state: 'active',
      lastSeenAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 600_000).toISOString(),
      acknowledgedCursor: null },
    conversionPolicy: { alias: 'duplicate', separator: 'preserve_remote', unknownExtensions: 'sidecar' },
  };
}
