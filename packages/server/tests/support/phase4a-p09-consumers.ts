/**
 * P4A-P09 consumer runners (not a vitest test file: matches no vitest test
 * pattern and is never listed in a focused config).
 *
 * The six P4A-P09 consumer runners (publication / sync / mcp / search /
 * profile / manifest / shared_link) over the REAL Product fixture from
 * `phase4a-p09-test-helpers.ts`, each with a visible CONTROL resource in the
 * same fixture and a JSON-safe output that the suites scan for every private
 * marker. Consumers only depend on the approved eligibility-port symbols and
 * the infrastructure shared-exposure facts port; no leg ever touches a
 * physical key or body.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DEFAULT_MCP_RESOURCE_READ_BUDGET } from '@know-n/colp/mcp';
import { loadConfig } from './test-config.js';
import { createPostgresAccessPolicyFactsPort } from '../../src/infrastructure/access-policy/index.js';
import { createPostgresSharedExposureFactsPort, createAttachmentExposurePolicyAdapter } from '../../src/infrastructure/database/index.js';
import {
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../src/infrastructure/publication/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../src/infrastructure/identity/index.js';
import {
  createPostgresSearchAuthorityPort,
  createPostgresSearchCandidatePort,
} from '../../src/infrastructure/search/index.js';
import {
  createPostgresSyncBootstrapSnapshotApplication,
  createSyncPullCursorKeyring,
} from '../../src/infrastructure/sync/index.js';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
  getPublicationCollectionMetadata,
  getPublicationDirectoryPage,
  getPublicationSnapshotPage,
  type PublicationPrincipal,
} from '../../src/modules/publication/index.js';
import { createSearchCursorSigner, executeSearchQuery } from '../../src/modules/search/index.js';
import {
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpSnapshotResourceProjection,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../src/modules/mcp/index.js';
import {
  assessSharedExposureEligibility,
  SHARED_EXPOSURE_PROJECTION_KINDS,
  type SharedExposureBlobFacts,
} from '../../src/modules/attachments/index.js';
import { getPublicProfileProjection } from '../../src/bootstrap/public-profile-projection.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';
import {
  P09_MCP_AUDIENCE,
  P09_MCP_OAUTH_ISSUER,
  P09_MCP_SERVER_UUID,
  P09_NOW,
  type P09ProductFixture,
} from './phase4a-p09-test-helpers.js';

export interface P09ConsumerRunner {
  readonly kind: 'publication' | 'sync' | 'mcp' | 'search' | 'profile' | 'manifest' | 'shared_link';
  run(): Promise<{ readonly controlVisible: boolean; readonly output: unknown }>;
}

export interface P09ConsumerSet {
  readonly consumers: readonly P09ConsumerRunner[];
  readonly privateMarkers: readonly string[];
}

export function p09PublicationOrigin(): string {
  return 'https://known.example';
}

export function p09PublicationPorts(runtime: I07MigrationRuntime['runtime']) {
  const cursors = createPublicationCursorKeyring({
    active: { id: `p09-pub-${randomUUID()}`, secret: Buffer.alloc(32, 71).toString('base64') },
    retained: [],
  });
  const origin = p09PublicationOrigin();
  return {
    cursors,
    snapshot: {
      reads: createPostgresPublicationSnapshotReadPort(runtime),
      annotations: createPostgresPublicationAnnotationReadPort(runtime, { origin }),
      relations: createPostgresPublicationRelationReadPort(runtime),
      accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
      cursors,
      origin,
      sharedExposure: createPostgresSharedExposureFactsPort(runtime),
    },
    directory: {
      reads: createPostgresPublicationDirectoryReadPort(runtime),
      cursors,
      origin,
      maxPageSize: 100,
    },
    metadata: {
      reads: createPostgresPublicationMetadataReadPort(runtime),
      origin,
      now: () => P09_NOW,
    },
  };
}

function p09McpConfig(databaseUrl: string) {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: P09_MCP_SERVER_UUID,
    LOG_LEVEL: 'silent',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: P09_MCP_SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: P09_MCP_OAUTH_ISSUER,
    MCP_OAUTH_AUDIENCE: P09_MCP_AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  });
  assert.ok(config.mcp, 'MCP read feature config must parse');
  return config.mcp!;
}

export function buildP09McpProjections(
  runtime: I07MigrationRuntime['runtime'],
  databaseUrl: string,
  fixture: P09ProductFixture,
  pageSize = 10,
): {
  readonly config: ReturnType<typeof p09McpConfig>;
  readonly collectionProjection: Phase4bMcpCollectionResourceProjection;
  readonly snapshotProjection: Phase4bMcpSnapshotResourceProjection;
  readonly nodeProjection: Phase4bMcpNodeResourceProjection;
  readonly destroy: () => void;
} {
  const config = p09McpConfig(databaseUrl);
  const publication = p09PublicationPorts(runtime);
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: `p09-mcp-${randomUUID()}`, secret: Buffer.alloc(32, 72).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => P09_NOW,
  });
  const collectionProjection = createPhase4bMcpCollectionResourceProjection({
    config,
    directoryQuery: publication.directory,
    metadataQuery: publication.metadata,
    accessPolicy: createPostgresAccessPolicyFactsPort(runtime.db),
    cursorKeys: mcpCursors,
    now: () => P09_NOW,
    pageSize,
    policyRevisionFor: async () => 'authority-1',
    sharedExposure: createPostgresSharedExposureFactsPort(runtime),
  });
  const snapshotProjection = createPhase4bMcpSnapshotResourceProjection({
    config,
    snapshotQuery: publication.snapshot,
    now: () => P09_NOW,
    pageSize,
  });
  const nodeProjection = createPhase4bMcpNodeResourceProjection({
    config,
    snapshotQuery: publication.snapshot,
    now: () => P09_NOW,
  });
  return {
    config,
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    destroy() {
      mcpCursors.destroy();
      publication.cursors.destroy();
    },
  };
}

function p09AnonymousPrincipal(): PublicationPrincipal {
  return Object.freeze({ kind: 'anonymous' as const });
}

export function p09BuildConsumers(input: {
  readonly runtime: I07MigrationRuntime;
  readonly databaseUrl: string;
  readonly fixture: P09ProductFixture;
}): P09ConsumerSet {
  const { runtime, databaseUrl, fixture } = input;
  const privateMarkers = Object.values(fixture.markers);
  const mcp = buildP09McpProjections(runtime.runtime, databaseUrl, fixture);

  const consumers: readonly P09ConsumerRunner[] = Object.freeze([
    Object.freeze({
      kind: 'publication' as const,
      async run() {
        const ports = p09PublicationPorts(runtime.runtime);
        try {
          const snapshot = await getPublicationSnapshotPage(ports.snapshot, {
            collectionId: fixture.collectionId,
            principal: p09AnonymousPrincipal(),
            query: { include: ['attachments'], limit: 100 },
          });
          const directory = await getPublicationDirectoryPage(ports.directory, {
            principal: p09AnonymousPrincipal(),
            query: { limit: 100 },
          });
          const metadata = await getPublicationCollectionMetadata(ports.metadata, {
            collectionId: fixture.collectionId,
            principal: p09AnonymousPrincipal(),
          });
          const directoryJson = JSON.stringify(directory.directory);
          const controlVisible = snapshot.snapshot.nodes.some((node) => node.title === fixture.controlNodeTitle)
            && directoryJson.includes(fixture.collectionId)
            && metadata.kind === 'metadata'
            && metadata.metadata.collection.id === fixture.collectionId;
          return Object.freeze({
            controlVisible,
            output: { snapshot: snapshot.snapshot, directory: directory.directory, metadata },
          });
        } finally {
          ports.cursors.destroy();
        }
      },
    }),
    Object.freeze({
      kind: 'sync' as const,
      async run() {
        const pullKeys = createSyncPullCursorKeyring({
          active: { id: `p09-sync-pull-${randomUUID()}`, secret: Buffer.alloc(32, 73).toString('base64') },
          retained: [],
          ttlMs: 300_000,
        });
        try {
          const application = createPostgresSyncBootstrapSnapshotApplication(runtime.runtime, {
            cursorSecret: Buffer.alloc(32, 74), cursorKeyId: 'p09-sync-v1', cursorTtlMs: 300_000,
            pullCursorKeyring: pullKeys,
            attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(runtime.runtime)),
          });
          const snapshot = await application.query({
            credential: fixture.session.credential,
            request: { sessionId: fixture.session.sessionId, limit: 100 },
          }) as { collection: { id: string }; nodes: Array<{ title: string }> };
          return Object.freeze({
            controlVisible: snapshot.collection.id === fixture.collectionId
              && snapshot.nodes.some((node) => node.title === fixture.controlNodeTitle),
            output: snapshot,
          });
        } finally {
          pullKeys.destroy();
        }
      },
    }),
    Object.freeze({
      kind: 'mcp' as const,
      async run() {
        const context = Object.freeze({
          binding: Object.freeze({
            kind: 'anonymous', principalId: 'public',
            resourceAudience: P09_MCP_AUDIENCE, securityEpoch: 'epoch-1',
          }),
          scope: Object.freeze([]),
          budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
          abortSignal: new AbortController().signal,
          authorization: Object.freeze({}),
        });
        const list = await mcp.collectionProjection.listResources(Object.freeze({}), context);
        const read = await mcp.collectionProjection.readResource(
          Object.freeze({
            resource: Object.freeze({ kind: 'collection-metadata', collectionId: fixture.collectionId }),
          }),
          context,
        );
        const snapshot = await mcp.snapshotProjection.readResource(
          Object.freeze({
            resource: Object.freeze({ kind: 'collection-snapshot', collectionId: fixture.collectionId }),
          }),
          context,
        );
        const listJson = JSON.stringify(list);
        const snapshotJson = JSON.stringify(snapshot);
        return Object.freeze({
          controlVisible: listJson.includes(fixture.collectionId)
            && snapshotJson.includes(fixture.collectionId),
          output: { list, read, snapshot },
        });
      },
    }),
    Object.freeze({
      kind: 'search' as const,
      async run() {
        const ports = {
          candidates: createPostgresSearchCandidatePort(runtime.runtime.db),
          authority: createPostgresSearchAuthorityPort(runtime.runtime.db),
          cursors: createSearchCursorSigner({
            current: { id: `p09-search-${randomUUID()}`, key: Buffer.alloc(32, 75).toString('base64') },
          }),
          clock: { now: () => P09_NOW },
          sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
        };
        const control = await executeSearchQuery(ports, {
          principal: Object.freeze({ kind: 'anonymous' }),
          query: fixture.controlNodeTitle,
          pageSize: 100,
        });
        return Object.freeze({
          controlVisible: control.items.length > 0,
          output: { items: control.items, page: control.page },
        });
      },
    }),
    Object.freeze({
      kind: 'profile' as const,
      async run() {
        const key = createPublicationCursorKeyring({
          active: { id: `p09-profile-${randomUUID()}`, secret: Buffer.alloc(32, 76).toString('base64') },
          retained: [],
        });
        try {
          const projection = await getPublicProfileProjection({
            profiles: createPostgresPublicProfileFactsReadPort(runtime.runtime),
            collections: createPostgresPublicationDirectoryReadPort(runtime.runtime),
            cursors: key,
            sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
          }, { handle: fixture.profileHandle, limit: 100 });
          return Object.freeze({
            controlVisible: projection.profile.handle === fixture.profileHandle
              && projection.collections.some((entry) => entry.id === fixture.profileCollectionId),
            output: projection,
          });
        } finally {
          key.destroy();
        }
      },
    }),
    Object.freeze({
      kind: 'manifest' as const,
      async run() {
        const candidate = createPublicationManifestCandidate({
          origin: p09PublicationOrigin(),
          mountPath: '/colp/v0.1/',
          serverUuid: P09_MCP_SERVER_UUID,
          title: 'P09 Manifest',
          maxPageSize: 100,
          maxSnapshotNodes: 200,
          endpoints: {
            directory: `${p09PublicationOrigin()}/colp/v0.1/directory`,
            collection: `${p09PublicationOrigin()}/colp/v0.1/collections/{collectionId}`,
            snapshot: `${p09PublicationOrigin()}/colp/v0.1/collections/{collectionId}/snapshot`,
          },
        }, ['directory', 'collection', 'snapshot']);
        return Object.freeze({
          controlVisible: JSON.stringify(candidate.manifest).includes('P09 Manifest'),
          output: candidate.manifest,
        });
      },
    }),
    Object.freeze({
      kind: 'shared_link' as const,
      async run() {
        // The shared-link consumer surface has no production registry yet; the
        // standing control is the deny-by-default creation contract (gate
        // verdict for the shared_link projection kind) plus the fact that no
        // shared-link record table exists (zero records is never fabricated as
        // safety) and that the REAL Product attachments rows are never
        // readable through any shared-link surface.
        const blobs = await sql<{ blob_id: string; logical_state: string; generation_state: string | null }>`
          select distinct b.blob_id, b.logical_state, g.generation_state
            from blob_records b
            join upload_intents u on u.blob_id = b.blob_id
            left join blob_generations g on g.generation_id = b.current_generation_id
           where u.collection_id = ${fixture.collectionId}
        `.execute(runtime.runtime.db);
        const denied = blobs.rows.length >= 5 && blobs.rows.every((row) => {
          const facts: SharedExposureBlobFacts = Object.freeze({
            blobId: row.blob_id,
            logicalState: row.logical_state as SharedExposureBlobFacts['logicalState'],
            currentGenerationState: row.generation_state as SharedExposureBlobFacts['currentGenerationState'],
          });
          const verdict = assessSharedExposureEligibility(facts);
          return verdict.eligible === false && verdict.reason === 'no_content_safety_evidence';
        });
        const attachments = await sql<{ attachment_id: string; logical_state: string }>`
          select attachment_id, logical_state from attachments
           where collection_id = ${fixture.collectionId}
           order by attachment_id
        `.execute(runtime.runtime.db);
        const tables = await sql<{ table_name: string }>`
          select table_name from information_schema.tables
           where table_schema = current_schema()
             and (
               table_name like '%share%link%'
               or (
                 table_name like '%shared%'
                 and table_name not in ('favicon_shared_domains', 'favicon_shared_objects')
               )
             )
        `.execute(runtime.runtime.db);
        return Object.freeze({
          controlVisible: denied
            && attachments.rows.length >= 5
            && tables.rows.length === 0
            && SHARED_EXPOSURE_PROJECTION_KINDS.includes('shared_link'),
          output: {
            gateKind: SHARED_EXPOSURE_PROJECTION_KINDS.includes('shared_link'),
            assessedBlobs: blobs.rows.length,
            productAttachmentRows: attachments.rows.length,
            registryTables: tables.rows.length,
          },
        });
      },
    }),
  ]);
  return { consumers, privateMarkers };
}
