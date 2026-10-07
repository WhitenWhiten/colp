import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, test, vi } from 'vitest';
import { composeApiAttachments } from '../../../src/bootstrap/api-attachments-composition.js';
import { composeApiMcpSurface } from '../../../src/bootstrap/api-mcp-surface-composition.js';
import { loadConfig } from '../../support/test-config.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createLogger, InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import type { IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { testEnv } from '../../support/http-security-config-env.js';
import { phase4bMcpOnEnv } from '../../support/phase4b-mcp-config-env.js';
import { deliveryProcessEnv } from '../../support/phase4a-l049-delivery-rate-limit.js';

const OWNED_ENV_KEYS = [
  'ATTACHMENTS_R2_RW_ACCESS_KEY_ID',
  'ATTACHMENTS_R2_RW_SECRET_ACCESS_KEY',
  'ATTACHMENTS_R2_RO_ACCESS_KEY_ID',
  'ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY',
  'ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY',
  'AVATAR_R2_ENDPOINT',
  'AVATAR_R2_BUCKET',
  'AVATAR_R2_ACCESS_KEY_ID',
  'AVATAR_R2_SECRET_ACCESS_KEY',
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of OWNED_ENV_KEYS) delete process.env[key];
});

class ListeningClient extends EventEmitter {
  readonly statements: string[] = [];
  readonly releases: boolean[] = [];

  async query(statement: string): Promise<{ readonly rows: readonly unknown[] }> {
    this.statements.push(statement);
    return { rows: [] };
  }

  release(destroy = false): void {
    this.releases.push(destroy);
  }
}

function listeningDatabase(): DatabaseRuntime & {
  readonly listener: ListeningClient;
  readonly closeCalls: string[];
  readonly policyQueries: string[];
} {
  const listener = new ListeningClient();
  const closeCalls: string[] = [];
  const policyQueries: string[] = [];
  return {
    db: Object.freeze({}) as DatabaseRuntime['db'],
    pool: {
      async connect() { return listener; },
      async query(statement: string) {
        policyQueries.push(statement);
        return { rows: [{ authority: '0:none:none' }] };
      },
    } as unknown as DatabaseRuntime['pool'],
    async cancelBackend() { return false; },
    async verifyReady() {},
    async close() { closeCalls.push('close'); },
    listener,
    closeCalls,
    policyQueries,
  };
}

function identityUnitOfWork(): IdentityUnitOfWork {
  return {
    async execute<Result>(work: (ports: never) => Promise<Result>): Promise<Result> {
      return work({
        accounts: { async findBySubjectId() { return null; } },
      } as never);
    },
  };
}

function mcpInput(
  config: ReturnType<typeof loadConfig>,
  database: DatabaseRuntime,
  publicationCursorKeys: ReturnType<typeof createPublicationCursorKeyring>,
) {
  return {
    config,
    database,
    identityUnitOfWork: identityUnitOfWork(),
    metrics: new InMemoryMetrics(),
    publicationDirectoryReads: Object.freeze({
      async loadPage() { return Object.freeze([]); },
    }),
    publicationMetadataReads: Object.freeze({
      async load() { return null; },
    }),
    publicationCursorKeys,
    accessPolicyFacts: Object.freeze({
      async loadCollectionFacts() { return null; },
    }),
    publicationSnapshotQuery: Object.freeze({}),
  } as unknown as Parameters<typeof composeApiMcpSurface>[0];
}

function anonymousMcpContext() {
  return Object.freeze({
    binding: Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: 'https://collections.example.test/collections/-/mcp',
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze([]),
    budget: Object.freeze({ maxItems: 100, maxBytes: 1_000_000 }),
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
  });
}

describe('partial API composition resource cleanup', () => {
  test('MCP Read starts one LISTEN source, serves a list, and closes it with UNLISTEN', async () => {
    const config = loadConfig(phase4bMcpOnEnv());
    const database = listeningDatabase();
    const publicationCursorKeys = createPublicationCursorKeyring(config.publication.cursorKeys);
    const composed = await composeApiMcpSurface(mcpInput(config, database, publicationCursorKeys));
    assert.ok(composed.mcpChangeSignalSource);
    assert.ok(composed.mcpReadResourceProjection);
    assert.ok(composed.mcpCollectionResourceCursorKeys);
    assert.ok(composed.mcpRateLimiter);
    assert.ok(composed.mcpApplicationFacade);
    const page = await composed.mcpReadResourceProjection.listResources(
      Object.freeze({}),
      anonymousMcpContext() as never,
    );
    assert.deepEqual(page.resources, []);
    assert.equal(database.policyQueries.length, 1);

    await composed.mcpRateLimiter.close();
    await composed.mcpChangeSignalSource.close();
    composed.mcpCollectionResourceCursorKeys.destroy();
    publicationCursorKeys.destroy();
    assert.match(database.listener.statements[0] ?? '', /^LISTEN mcp_sig_/u);
    assert.match(database.listener.statements[1] ?? '', /^UNLISTEN mcp_sig_/u);
    assert.deepEqual(database.listener.releases, [false]);
    assert.deepEqual(database.closeCalls, [], 'successful composition does not transfer database ownership');
  });

  test('MCP closes the started LISTEN source and database when a downstream guard fails', async () => {
    const valid = loadConfig(phase4bMcpOnEnv());
    const config = {
      ...valid,
      mcpRateLimit: {
        ...valid.mcpRateLimit,
        enabled: true,
        redisUrl: null,
        keySecret: null,
      },
    } as typeof valid;
    const database = listeningDatabase();
    const publicationCursorKeys = createPublicationCursorKeyring(config.publication.cursorKeys);
    await assert.rejects(
      composeApiMcpSurface(mcpInput(config, database, publicationCursorKeys)),
      /MCP_RATE_LIMIT_SHARED=true requires MCP_RATE_LIMIT_REDIS_URL and MCP_RATE_LIMIT_KEY_SECRET/u,
    );
    publicationCursorKeys.destroy();
    assert.match(database.listener.statements[0] ?? '', /^LISTEN mcp_sig_/u);
    assert.match(database.listener.statements[1] ?? '', /^UNLISTEN mcp_sig_/u);
    assert.deepEqual(database.listener.releases, [false]);
    assert.deepEqual(database.closeCalls, ['close']);
  });

  test('Attachments closes all six acquired S3 clients when delivery-secret resolution fails', async () => {
    process.env.ATTACHMENTS_R2_RW_ACCESS_KEY_ID = 'attachments-write-access-id';
    process.env.ATTACHMENTS_R2_RW_SECRET_ACCESS_KEY = 'attachments-write-access-secret';
    process.env.ATTACHMENTS_R2_RO_ACCESS_KEY_ID = 'attachments-read-access-id';
    process.env.ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY = 'attachments-read-access-secret';
    delete process.env.ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY;
    const destroy = vi.spyOn(S3Client.prototype, 'destroy');
    destroy.mockImplementationOnce(() => { throw new Error('first close failed'); });
    const config = loadConfig({
      ...testEnv(),
      ...deliveryProcessEnv({
        ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw',
        ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro',
      }),
    } as Record<string, string>);
    const database = listeningDatabase();

    await assert.rejects(
      composeApiAttachments({
        config,
        database,
        identityUnitOfWork: identityUnitOfWork(),
        metrics: new InMemoryMetrics(),
        metricsLogger: createLogger('silent'),
      }),
      /ATTACHMENTS_DELIVERY_CAPABILITY_PRIMARY is required/u,
    );
    assert.equal(destroy.mock.calls.length, 6, 'best-effort cleanup must attempt every acquired S3 client');
    assert.deepEqual(database.closeCalls, [], 'Attachments does not own the shared database runtime');
  });

  test('avatar-only R2 stores close both clients exactly once', async () => {
    process.env.AVATAR_R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
    process.env.AVATAR_R2_BUCKET = 'known-public-profile-media';
    process.env.AVATAR_R2_ACCESS_KEY_ID = 'avatar-access-id';
    process.env.AVATAR_R2_SECRET_ACCESS_KEY = 'avatar-access-secret';
    const destroy = vi.spyOn(S3Client.prototype, 'destroy');
    const composed = await composeApiAttachments({
      config: loadConfig(testEnv()),
      database: listeningDatabase(),
      identityUnitOfWork: identityUnitOfWork(),
      metrics: new InMemoryMetrics(),
      metricsLogger: createLogger('silent'),
    });
    assert.ok(composed.avatarStore?.close);
    assert.ok(composed.faviconStore?.close);
    await composed.avatarStore.close();
    await composed.faviconStore.close();
    await composed.avatarStore.close();
    await composed.faviconStore.close();
    assert.equal(destroy.mock.calls.length, 4);
  });
});
