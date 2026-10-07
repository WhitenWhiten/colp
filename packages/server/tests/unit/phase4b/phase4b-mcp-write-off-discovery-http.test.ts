import assert from 'node:assert/strict';
import { afterAll, afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_READ_PROFILE_CLAIMS,
  createPhase4bMcpChangeSignalSource,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryQueryPorts,
  type PublicationMetadataQueryPorts,
  type PublicationSnapshotQueryPorts,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import {
  emptyNodeResourceProjection,
  emptyResourceProjection,
  emptySnapshotResourceProjection,
  mcpEnv,
  type TestServer,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const apps: FastifyInstance[] = [];
const cursors = createPublicationCursorKeyring({
  active: { id: 'write-off-http-v1', secret: Buffer.alloc(32, 41).toString('base64') },
  retained: [],
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

afterAll(() => cursors.destroy());

function writeOffEnv(): Record<string, string> {
  return mcpEnv({
    KNOWN_FEATURE_MCP_WRITE: undefined,
  });
}

function publicationQueries(): {
  readonly publicationDirectoryQuery: PublicationDirectoryQueryPorts;
  readonly publicationMetadataQuery: PublicationMetadataQueryPorts;
  readonly publicationSnapshotQuery: PublicationSnapshotQueryPorts;
} {
  const origin = 'https://collections.example.test';
  return {
    publicationDirectoryQuery: {
      cursors,
      origin,
      reads: {
        async loadPage() {
          return [];
        },
      },
    },
    publicationMetadataQuery: {
      origin,
      reads: {
        async load() {
          return null;
        },
      },
    },
    publicationSnapshotQuery: {
      cursors,
      origin,
      sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
      accessPolicy: {
        async loadCollectionFacts() {
          return null;
        },
      },
      reads: {
        async loadPage() {
          return {
            isolation: 'repeatable read' as const,
            comparatorVersion: 'parent-position-id-v1' as const,
            collection: null,
            root: null,
            candidates: [],
          };
        },
      },
    },
  };
}

async function startWriteOffApi(): Promise<TestServer> {
  const config = loadConfig(writeOffEnv());
  assert.equal(config.mcp !== undefined, true);
  assert.equal(config.mcpWriteEnabled, false);
  const toolAdapter = emptyReadToolAdapterBundle();
  const app = buildApiApp({
    config,
    ...publicationQueries(),
    exploreDirectoryRateLimiter: createMemorySearchRateLimiter({
      anonymousMaxRequests: 10_000,
      accountMaxRequests: 10_000,
      windowMs: 60_000,
    }),
    mcpReadTransport: {
      changeSignalSource: createPhase4bMcpChangeSignalSource(),
      readToolAdapter: toolAdapter.adapter,
      readToolParamDeclarations: toolAdapter.paramDeclarations,
    },
    mcpReadResourceProjection: emptyResourceProjection(),
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(app);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return { app, config, origin: `http://127.0.0.1:${address.port}` };
}

test('write-off HTTP discovery advertises mcp-read and omits mcp-write', async () => {
  const server = await startWriteOffApi();

  const live = await server.app.inject({
    method: 'GET',
    url: '/.well-known/collection-protocol',
  });
  assert.equal(live.statusCode, 200);
  const manifest = live.json<{
    readonly mounts: ReadonlyArray<{ readonly id: string; readonly profiles: readonly string[] }>;
  }>();
  const mcpMount = manifest.mounts.find((mount) => mount.id === 'mcp');
  assert.ok(mcpMount);
  assert.equal(mcpMount.profiles.includes('mcp-read'), true);
  assert.equal(mcpMount.profiles.includes('mcp-write'), false);
  assert.deepEqual(mcpMount.profiles, [...PHASE4B_MCP_READ_PROFILE_CLAIMS]);
});
