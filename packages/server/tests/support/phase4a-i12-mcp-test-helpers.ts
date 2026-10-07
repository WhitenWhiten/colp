/**
 * Shared MCP surface factory for P4A-I12 postgres suites. Not a test file.
 */
import { loadConfig } from './test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort } from '../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../src/infrastructure/publication/index.js';
import {
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpSnapshotResourceProjection,
  type Phase4bMcpReadToolAdapterBundle,
} from '../../src/modules/mcp/index.js';
import { createPublicationCursorKeyring } from '../../src/modules/publication/index.js';
import { type I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export const I12_MCP_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
export const I12_MCP_AUDIENCE = 'https://collections.example.test/collections/-/mcp';
export const I12_MCP_NOW = new Date('2026-08-08T12:00:00.000Z');

export function i12McpEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: I12_MCP_SERVER_UUID,
    LOG_LEVEL: 'silent',
    OIDC_ISSUER: 'https://issuer.example.test/realms/known',
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: I12_MCP_SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://app.example.test/api/v1/auth',
    MCP_OAUTH_AUDIENCE: I12_MCP_AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
    MCP_OAUTH_JWKS_URI: 'https://app.example.test/api/v1/auth/jwks',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  };
}

export function buildI12McpSurface(isolatedRuntime: I07MigrationRuntime): {
  readonly surface: Phase4bMcpReadToolAdapterBundle;
  readonly collectionProjection: ReturnType<typeof createPhase4bMcpCollectionResourceProjection>;
  readonly snapshotProjection: ReturnType<typeof createPhase4bMcpSnapshotResourceProjection>;
  readonly destroy: () => void;
} {
  const config = loadConfig(i12McpEnv()).mcp!;
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'i12-mcp-pub-v1', secret: Buffer.alloc(32, 121).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'i12-mcp-v1', secret: Buffer.alloc(32, 123).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => I12_MCP_NOW,
  });
  const collectionProjection = createPhase4bMcpCollectionResourceProjection({
    config,
    directoryQuery: {
      reads: createPostgresPublicationDirectoryReadPort(isolatedRuntime.runtime),
      cursors: publicationCursors,
      origin: 'https://known.example',
      maxPageSize: 100,
    },
    metadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(isolatedRuntime.runtime),
      origin: 'https://known.example',
      now: () => I12_MCP_NOW,
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(isolatedRuntime.runtime.db),
    cursorKeys: mcpCursors,
    now: () => I12_MCP_NOW,
    pageSize: 10,
    policyRevisionFor: async () => 'authority-1',
    sharedExposure: createPostgresSharedExposureFactsPort(isolatedRuntime.runtime),
  });
  const snapshotQuery = {
    reads: createPostgresPublicationSnapshotReadPort(isolatedRuntime.runtime),
    annotations: createPostgresPublicationAnnotationReadPort(isolatedRuntime.runtime, {
      origin: 'https://known.example',
    }),
    relations: createPostgresPublicationRelationReadPort(isolatedRuntime.runtime),
    accessPolicy: createPostgresAccessPolicyFactsPort(isolatedRuntime.runtime.db),
    cursors: publicationCursors,
    origin: 'https://known.example',
    now: () => I12_MCP_NOW,
    sharedExposure: createPostgresSharedExposureFactsPort(isolatedRuntime.runtime),
  };
  const snapshotProjection = createPhase4bMcpSnapshotResourceProjection({
    config,
    snapshotQuery,
    now: () => I12_MCP_NOW,
    pageSize: 10,
  });
  const nodeProjection = createPhase4bMcpNodeResourceProjection({
    config,
    snapshotQuery,
    now: () => I12_MCP_NOW,
  });
  return {
    collectionProjection,
    snapshotProjection,
    surface: createPhase4bMcpReadToolAdapter({
      collectionProjection,
      snapshotProjection,
      nodeProjection,
      serverUuid: I12_MCP_SERVER_UUID,
    }),
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}
