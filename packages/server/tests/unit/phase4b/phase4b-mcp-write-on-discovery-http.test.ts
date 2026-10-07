import assert from 'node:assert/strict';
import { afterAll, afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_WRITE_PROFILE_CLAIMS,
  PHASE4B_MCP_WRITE_SERVER_INFO,
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
  parseJsonRpc,
  postJson,
  type TestServer,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const WRITE_KEY = Buffer.alloc(32, 77).toString('base64');
const apps: FastifyInstance[] = [];
const cursors = createPublicationCursorKeyring({
  active: { id: 'write-on-http-v1', secret: Buffer.alloc(32, 41).toString('base64') },
  retained: [],
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

afterAll(() => cursors.destroy());

function writeOnEnv(): Record<string, string> {
  return mcpEnv({
    KNOWN_FEATURE_MCP_WRITE: 'true',
    MCP_WRITE_REQUEST_STATE_KEY: WRITE_KEY,
    PRODUCT_ORIGIN: 'https://app.example.test',
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

async function startWriteOnApi(): Promise<TestServer> {
  const config = loadConfig(writeOnEnv());
  assert.equal(config.mcpWriteEnabled, true);
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

test('write-on HTTP discovery advertises mcp-write and Known MCP', async () => {
  const server = await startWriteOnApi();

  const discover = parseJsonRpc(await (await postJson(server, 'server/discover', 2)).text());
  assert.deepEqual(
    (discover.result?._meta as { readonly 'io.modelcontextprotocol/serverInfo'?: unknown })
      ?.['io.modelcontextprotocol/serverInfo'],
    PHASE4B_MCP_WRITE_SERVER_INFO,
  );
  assert.equal(PHASE4B_MCP_WRITE_SERVER_INFO.name, 'Known MCP');

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
  assert.equal(mcpMount.profiles.includes('mcp-write'), true);
  assert.deepEqual(mcpMount.profiles, [...PHASE4B_MCP_WRITE_PROFILE_CLAIMS]);
});
