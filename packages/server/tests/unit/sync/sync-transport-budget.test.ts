import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, test } from 'vitest';
import {
  defaultServerTransportBudget,
  encodeSyncTransportBudgetHeader,
  jsonFitsTransportBudget,
  LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  legacySyncTransportBudget,
  negotiateSyncTransportBudget,
  parseSyncTransportBudget,
  readDeclaredTransportBudget,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
  utf8JsonByteLength,
} from '@know-n/colp/sync';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  registerSyncSessionRoutes,
  SyncSessionHttpError,
  type SyncSessionHttpApplication,
} from '../../../src/transport/colp-sync/sync-session-routes.js';
import {
  bindSessionTransportBudget,
  resolvePullResponseBudget,
  snapshotByteCap,
  transportBudgetFromBindingJson,
} from '../../../src/infrastructure/sync/sync-transport-budget.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/unit-of-work.js';
import type { SyncSessionRequest } from '@know-n/colp/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const apps: FastifyInstance[] = [];
const budgetBoundaries = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../fixtures/sync/transport-budget-boundaries.json'),
    'utf8',
  ),
) as {
  readonly boundaries: ReadonlyArray<{
    readonly id: string;
    readonly pullResponseBytes: number;
    readonly snapshotPageBytes: number;
    readonly effectPageBytes: number;
    readonly effectAggregateBytes: number;
  }>;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('SYNC-Q-003 negotiated transport budget', () => {
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
      assert.equal(budget.pullResponseBytes, row.pullResponseBytes);
      assert.equal(jsonFitsTransportBudget({ t: 'x'.repeat(16) }, row.pullResponseBytes), true);
      assert.equal(utf8JsonByteLength({ t: 'x'.repeat(row.pullResponseBytes) }) > row.pullResponseBytes, true);
      assert.equal(jsonFitsTransportBudget({ t: 'x'.repeat(row.pullResponseBytes) }, row.pullResponseBytes), false);
    }
  });

  test('missing or tampered Session binding fails closed to the legacy 2 MiB cap', () => {
    const legacy = legacySyncTransportBudget();
    assert.deepEqual(transportBudgetFromBindingJson(undefined), legacy);
    assert.deepEqual(transportBudgetFromBindingJson({}), legacy);
    assert.deepEqual(transportBudgetFromBindingJson({ transportBudget: { pullResponseBytes: 1 } }), legacy);
    assert.equal(resolvePullResponseBudget({}, 5 * 1024 * 1024), LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
    assert.equal(resolvePullResponseBudget({
      transportBudget: { ...legacy, pullResponseBytes: 64 * 1024 },
    }, 5 * 1024 * 1024), 64 * 1024);
    assert.equal(snapshotByteCap(8 * 1024 * 1024, {}), LEGACY_SYNC_TRANSPORT_BUDGET_BYTES);
  });

  test('Session replay keeps the first issued budget and ignores a later declaration', async () => {
    const first = {
      ...legacySyncTransportBudget(),
      pullResponseBytes: 64 * 1024,
      snapshotPageBytes: 64 * 1024,
    };
    const later = {
      ...legacySyncTransportBudget(),
      pullResponseBytes: 16 * 1024,
      snapshotPageBytes: 16 * 1024,
    };
    const store = { json: {} as Record<string, unknown> };
    assert.deepEqual(await bindSessionTransportBudget(bindingTx(store), 'session-1', 'issued', first), first);
    assert.deepEqual(store.json.transportBudget, first);
    assert.deepEqual(await bindSessionTransportBudget(bindingTx(store), 'session-1', 'replayed', later), first);
    assert.deepEqual(await bindSessionTransportBudget(bindingTx({ json: {} }), 'session-1', 'replayed', later),
      legacySyncTransportBudget());
  });

  test('Session response echoes negotiated budget and rejects a tampered declaration', async () => {
    const missing = await start();
    const missingResponse = await post(missing.origin, sessionRequest());
    assert.equal(missingResponse.status, 201);
    assert.equal(missingResponse.headers.get(SYNC_TRANSPORT_BUDGET_HEADER),
      encodeSyncTransportBudgetHeader(negotiateSyncTransportBudget(undefined, defaultServerTransportBudget())));

    const declared = await start();
    const declaredBudget = {
      pullResponseBytes: 64 * 1024,
      snapshotPageBytes: 64 * 1024,
      effectPageBytes: 32 * 1024,
      effectAggregateBytes: 64 * 1024,
    };
    const declaredResponse = await post(declared.origin, sessionRequest({
      replica: {
        ...sessionRequest().replica,
        extensions: { [SYNC_TRANSPORT_BUDGET_EXTENSION]: declaredBudget },
      },
    }));
    assert.equal(declaredResponse.status, 201);
    assert.equal(declaredResponse.headers.get(SYNC_TRANSPORT_BUDGET_HEADER),
      encodeSyncTransportBudgetHeader(declaredBudget));

    const tampered = await start();
    const denied = await post(tampered.origin, sessionRequest({
      replica: {
        ...sessionRequest().replica,
        extensions: { [SYNC_TRANSPORT_BUDGET_EXTENSION]: { pullResponseBytes: 8 } },
      },
    }));
    assert.equal(denied.status, 422);
    assert.equal((await denied.json() as { readonly code: string }).code, 'invalid_document');
  });

  test('production compose and Snapshot defaults stay at the legacy 2 MiB fallback', async () => {
    const compose = await readFile(new URL('../../../../devops/docker-compose.yml', import.meta.url), 'utf8');
    const snapshot = await readFile(new URL('../../../src/infrastructure/sync/sync-bootstrap-snapshot-postgres.ts',
      import.meta.url), 'utf8');
    const config = await readFile(new URL('../../../src/bootstrap/config-sync.ts', import.meta.url), 'utf8');
    assert.match(compose, /SYNC_PULL_RESPONSE_BUDGET_BYTES:.*:-2097152\}/u);
    assert.match(compose, /SYNC_SNAPSHOT_MAX_BYTES:.*:-2097152\}/u);
    assert.doesNotMatch(compose, /SYNC_PULL_RESPONSE_BUDGET_BYTES:.*:-5242880\}/u);
    // T-10: the production default is still 2 MiB, now derived from the one
    // shared aggregate capacity constant instead of a second literal.
    assert.match(snapshot, /DEFAULT_MAX_SNAPSHOT_BYTES: number = SNAPSHOT_TREE_CAPACITY\.maxAggregateBytes;/u);
    assert.match(snapshot, /DEFAULT_MAX_SNAPSHOT_NODES: number = SNAPSHOT_TREE_CAPACITY\.maxNodes;/u);
    assert.match(config, /SYNC_SNAPSHOT_MAX_BYTES, 2_097_152/u);
  });
});

async function start() {
  const app = Fastify({ logger: false });
  const application: SyncSessionHttpApplication = {
    async issue(input) {
      try {
        const client = readDeclaredTransportBudget(input.request.replica.extensions);
        return {
          state: 'issued',
          response: sessionResult(),
          transportBudget: negotiateSyncTransportBudget(client, defaultServerTransportBudget()),
        };
      } catch {
        throw new SyncSessionHttpError('invalid_document');
      }
    },
  };
  registerSyncSessionRoutes(app, {
    path: '/private-entry/session-negotiation',
    credentialVerifier: {
      async verify() {
        return mintVerifiedExtensionCredentialFixture({
          issuer: 'https://issuer.example.test', audience: 'known-sync-api',
          clientId: 'known-extension', subject: 'account-budget-1',
          credentialId: 'credential-budget-1',
        });
      },
    },
    application,
    rateLimit: { maxRequests: 20, windowMs: 60_000 },
    allowedOrigins: [EXTENSION_ORIGIN],
    allowInsecureLoopback: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return { origin: `http://127.0.0.1:${address.port}` };
}

async function post(origin: string, body: SyncSessionRequest): Promise<Response> {
  return fetch(`${origin}/private-entry/session-negotiation`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer budget-token',
      'idempotency-key': `budget-${crypto.randomUUID()}`,
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function sessionRequest(overrides: Record<string, unknown> = {}): SyncSessionRequest {
  return {
    protocolVersion: '0.1',
    replica: {
      replicaId: 'replica-budget-1', name: 'Chrome', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: {
        read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1,
      },
      binding: {
        browserProfileId: 'profile-budget-1', mountMode: 'mounted-folder',
        mountNativeId: 'mount-budget-1', generation: 'browser-generation-1',
      },
      extensions: {},
    },
    scope: 'collection',
    collection: {
      collectionId: 'collection-budget-1', lastCursor: null, lastRevision: null,
      bootstrapMode: 'download',
    },
    clientTime: '2026-07-25T10:00:00Z',
    ...overrides,
  } as SyncSessionRequest;
}

function bindingTx(store: { json: Record<string, unknown> }): DatabaseTransaction {
  return {
    selectFrom() {
      return {
        select() {
          return {
            where() {
              return { executeTakeFirst: async () => ({ binding_json: store.json }) };
            },
          };
        },
      };
    },
    updateTable() {
      return {
        set(patch: { binding_json: Record<string, unknown> }) {
          store.json = patch.binding_json;
          return { where() { return { execute: async () => undefined }; } };
        },
      };
    },
  } as unknown as DatabaseTransaction;
}

function sessionResult() {
  return Object.freeze({
    sessionId: 'session-budget-1', expiresAt: '2026-07-25T11:00:00Z',
    serverTime: '2026-07-25T10:00:01Z', clockSkewMilliseconds: 1_000,
    acceptedProtocolVersion: '0.1' as const, scope: 'collection' as const,
    maxBatchOperations: 1, tombstoneRetentionSeconds: 86_400,
    replicaLease: {
      leaseId: 'lease-budget-1', generation: '1', state: 'active' as const,
      lastSeenAt: '2026-07-25T10:00:01Z', expiresAt: '2026-08-25T10:00:01Z',
      acknowledgedCursor: null,
    },
    collection: {
      collectionId: 'collection-budget-1', snapshotRequired: true,
      serverCursor: 'sync-start', serverRevision: 'revision-budget-1',
    },
    conversionPolicy: {
      alias: 'duplicate' as const, separator: 'preserve_remote' as const,
      unknownExtensions: 'preserve_remote' as const,
    },
  });
}
