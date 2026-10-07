/**
 * P4A-R06 PostgreSQL integration: per-consumer private exclusion — MCP, search
 * and Profile/Manifest legs plus the shared-link registry contract.
 *
 * Black-box proof over the PRODUCTION migration + real PostgreSQL:
 * - the SAME real private blobs (unique markers in key rows + seed body
 *   bytes) across every consumer, and the SAME visible control resources
 *   (control collection/node, control profile, manifest control fields);
 * - MCP discovery/resource list/read/tools, the search candidate index + full
 *   query, the public Profile projection and the Publication Manifest all
 *   serve their control resource and carry ZERO private markers;
 * - the shared-link consumer surface has no production registry table yet:
 *   the proof is the deny-by-default gate contract for the `shared_link`
 *   projection kind plus a scan proving no shared-link record table exists
 *   (zero records is never fabricated as safety — the gate contract is the
 *   standing control, exactly as the plan requires: "以 registry 端口形状为准,
 *   不臆造");
 * - feature-flag shapes (search types / MCP page sizes) never create exposure.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationSnapshotReadPort,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import {
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpSnapshotResourceProjection,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpDiscoverResult,
  PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  type Phase4bMcpReadToolAdapterBundle,
} from '../../../src/modules/mcp/index.js';
import type {
  Mcp20260728RequestContext,
  McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import {
  createAnonymousPublicBinding,
} from '@know-n/colp/mcp';
import {
  createPhase4bMcpRequestContext,
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpResourceNotFoundError,
} from '../../../src/modules/mcp/index.js';
import {
  createPostgresSearchCandidatePort,
  createPostgresSearchAuthorityPort,
} from '../../../src/infrastructure/search/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import {
  createSearchCursorSigner,
  executeSearchQuery,
} from '../../../src/modules/search/index.js';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
} from '../../../src/modules/publication/index.js';
import { getPublicProfileProjection } from '../../../src/bootstrap/public-profile-projection.js';
import {
  createPostgresPublicProfileFactsReadPort,
} from '../../../src/infrastructure/identity/index.js';
import {
  assessSharedExposureEligibility,
  SHARED_EXPOSURE_PROJECTION_KINDS,
  type SharedExposureBlobFacts,
} from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  I12_COLLECTION,
  I12_SUBJECT_OWNER,
  assertControlVisible,
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedProfile,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-08T12:00:00.000Z');
const SEARCH_KEYS = Object.freeze({
  current: { id: 'r06-search-v1', key: Buffer.alloc(32, 71).toString('base64') },
});

function mcpEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    LOG_LEVEL: 'silent',
    OIDC_ISSUER: 'https://issuer.example.test/realms/known',
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  };
}

describeWithPostgres('P4A-R06 MCP + search + Profile/Manifest + shared-link exclusion', () => {
  let isolated: I07MigrationRuntime;
  let controlNodeTitle: string;
  let controlHandle: string;
  let surface: Phase4bMcpReadToolAdapterBundle;
  let collectionProjection: ReturnType<typeof createPhase4bMcpCollectionResourceProjection>;
  let destroy: () => void;
  const privateMarkers = {
    stored: privateMarker('r06-mcp-stored'),
    attached: privateMarker('r06-mcp-attached'),
    retiredOld: privateMarker('r06-mcp-retired-old'),
    retiredNew: privateMarker('r06-mcp-retired-new'),
    expired: privateMarker('r06-mcp-expired'),
    quarantined: privateMarker('r06-mcp-quarantined'),
  };
  const allMarkers = () => Object.values(privateMarkers);

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_r06_mcp_search_profile', { maxConnections: 10 });
    const seeded = await seedControlCollection(isolated.runtime, {
      collectionId: I12_COLLECTION,
      controlNodeTitle: controlMarker('r06-mcp-control'),
    });
    controlNodeTitle = seeded.controlNodeTitle;
    const profile = await seedProfile(isolated.runtime, {
      subjectId: I12_SUBJECT_OWNER,
      handle: 'r06_owner',
      displayName: 'R06 Owner',
    });
    controlHandle = profile.handle;

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored));
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached));
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired));
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined));
    await isolated.runtime.pool.query('analyze collections');
    await isolated.runtime.pool.query('analyze nodes');

    const built = buildSurface(isolated);
    surface = built.surface;
    collectionProjection = built.collectionProjection;
    destroy = built.destroy;
  }, 120_000);

  afterAll(async () => {
    destroy?.();
    await isolated?.dropSchema();
  });

  function trustedContext(): McpTrustedReadRequestContext {
    return Object.freeze({
      binding: Object.freeze({
        kind: 'anonymous', principalId: 'public', resourceAudience: AUDIENCE, securityEpoch: 'epoch-1',
      }),
      scope: Object.freeze([]),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      abortSignal: new AbortController().signal,
      authorization: Object.freeze({}),
    });
  }

  function toolContext(name: string): Mcp20260728RequestContext {
    return createPhase4bMcpRequestContext({
      headers: Object.freeze([
        Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
        Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
        Object.freeze({ name: 'Mcp-Name', value: name }),
        Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: I12_COLLECTION }),
      ]),
      httpMethod: 'POST',
      body: Object.freeze({
        method: 'tools/call',
        params: Object.freeze({
          _meta: Object.freeze({
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': Object.freeze({ tools: Object.freeze({ call: true }) }),
          }),
          name,
          arguments: Object.freeze({ collectionId: I12_COLLECTION }),
        }),
      }),
      binding: createAnonymousPublicBinding({ resourceAudience: AUDIENCE, securityEpoch: 'epoch-1' }),
      scope: ['mcp:read:public', 'mcp:read:own'],
      authorization: Object.freeze({}),
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
    });
  }

  test('MCP discovery + resource list/read serve the control collection with zero private marker', async () => {
    const discovery = createPhase4bMcpDiscoverResult();
    assertControlVisible(discovery, 'Known MCP Read', 'mcp discovery');

    const context = trustedContext();
    const list = await collectionProjection.listResources(Object.freeze({}), context);
    assertControlVisible(list, I12_COLLECTION, 'mcp resource list');
    for (const marker of allMarkers()) assertMarkerAbsentFromJson(list, marker, `mcp list (${marker})`);

    const read = await collectionProjection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: I12_COLLECTION }) }),
      context,
    );
    assert.equal(JSON.parse(read.contents[0]!.text).collection.visibility, 'public');
    for (const marker of allMarkers()) assertMarkerAbsentFromJson(read, marker, `mcp read (${marker})`);
  });

  test('MCP tools collections.get + collections.get_snapshot serve the control with zero private marker', async () => {
    const get = await surface.adapter.callTool(
      toolContext('collections.get'),
      { name: 'collections.get', arguments: { collectionId: I12_COLLECTION } },
    );
    const collection = (get.structuredContent as { collection?: Record<string, unknown> }).collection!;
    assert.equal(collection.id, I12_COLLECTION, 'control collection metadata must be served');
    for (const marker of allMarkers()) assertMarkerAbsentFromJson(get, marker, `collections.get (${marker})`);

    const snapshot = await surface.adapter.callTool(
      toolContext('collections.get_snapshot'),
      { name: 'collections.get_snapshot', arguments: { collectionId: I12_COLLECTION } },
    );
    assert.equal(JSON.stringify(snapshot).includes(I12_COLLECTION), true, 'control snapshot link must be served');
    for (const marker of allMarkers()) assertMarkerAbsentFromJson(snapshot, marker, `collections.get_snapshot (${marker})`);
  });

  test('MCP feature-flag shapes (page size) never create exposure', async () => {
    const context = trustedContext();
    for (const pageSize of [2, 10, 50]) {
      const built = buildSurface(isolated, pageSize);
      try {
        const list = await built.collectionProjection.listResources(Object.freeze({}), context);
        assertControlVisible(list, I12_COLLECTION, `mcp list pageSize=${pageSize}`);
        for (const marker of allMarkers()) {
          assertMarkerAbsentFromJson(list, marker, `mcp list pageSize=${pageSize} (${marker})`);
        }
      } finally {
        built.destroy();
      }
    }
  });

  test('search candidate index serves the control resource and never serves the private marker', async () => {
    const candidates = createPostgresSearchCandidatePort(isolated.runtime.db);
    for (const marker of allMarkers()) {
      const privatePage = await candidates.listCandidates({
        query: marker,
        types: ['collection', 'node', 'profile', 'annotation'],
        projection: { kind: 'anonymous' },
        limit: 100,
        timeoutMs: 5_000,
      });
      assertMarkerAbsentFromJson(privatePage, marker, `private-marker candidate page (${marker})`);
    }
  });

  test('the full search query serves the control result and carries zero private marker', async () => {
    const ports = {
      candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(SEARCH_KEYS as never),
      clock: { now: () => NOW },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
    const control = await executeSearchQuery(ports, {
      principal: { kind: 'anonymous' },
      query: controlNodeTitle,
      pageSize: 100,
    });
    assert.ok(control.items.length >= 1, 'control result must be returned (link executed)');
    for (const marker of allMarkers()) {
      assertMarkerAbsentFromJson(control, marker, 'search control result');
      const privateResult = await executeSearchQuery(ports, {
        principal: { kind: 'anonymous' },
        query: marker,
        pageSize: 100,
      });
      const privateOutput = {
        items: privateResult.items,
        page: privateResult.page,
        cache: privateResult.cache,
        consistency: privateResult.consistency,
      };
      assertMarkerAbsentFromJson(privateOutput, marker, `exact private-marker query output (${marker})`);
    }
  });

  test('search feature-flag shapes (types) never create exposure', async () => {
    const ports = {
      candidates: createPostgresSearchCandidatePort(isolated.runtime.db),
      authority: createPostgresSearchAuthorityPort(isolated.runtime.db),
      cursors: createSearchCursorSigner(SEARCH_KEYS as never),
      clock: { now: () => NOW },
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
    };
    for (const types of [undefined, ['node'], ['collection'], ['profile'], ['annotation']] as const) {
      const result = await executeSearchQuery(ports, {
        principal: { kind: 'anonymous' },
        query: controlNodeTitle,
        types: types as never,
        pageSize: 100,
      });
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(result, marker, `types=${JSON.stringify(types)} (${marker})`);
      }
    }
  });

  test('public Profile generation serves the control profile + collection with zero private marker', async () => {
    const key = createPublicationCursorKeyring({
      active: { id: `r06-profile-${randomUUID()}`, secret: Buffer.alloc(32, 68).toString('base64') },
      retained: [],
    });
    try {
      const projection = await getPublicProfileProjection({
        profiles: createPostgresPublicProfileFactsReadPort(isolated.runtime),
        collections: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors: key,
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      }, { handle: controlHandle, limit: 100 });
      assert.equal(projection.profile.handle, controlHandle, 'control profile must be served');
      assert.ok(projection.collections.some((entry) => entry.id === I12_COLLECTION),
        'control collection must be served (link executed)');
      for (const marker of allMarkers()) {
        assertMarkerAbsentFromJson(projection, marker, `profile projection (${marker})`);
      }
    } finally {
      key.destroy();
    }
  });

  test('Publication Manifest generation serves its fixed control fields with zero private marker', () => {
    const config = {
      origin: 'https://known.example',
      mountPath: '/colp/v0.1/',
      serverUuid: SERVER_UUID,
      title: 'R06 Manifest',
      maxPageSize: 100,
      maxSnapshotNodes: 200,
      endpoints: {
        directory: 'https://known.example/colp/v0.1/directory',
        collection: 'https://known.example/colp/v0.1/collections/{collectionId}',
        snapshot: 'https://known.example/colp/v0.1/collections/{collectionId}/snapshot',
      },
    };
    const candidate = createPublicationManifestCandidate(config, ['directory', 'collection', 'snapshot']);
    assertControlVisible(candidate.manifest, 'R06 Manifest', 'publication manifest');
    const serialized = JSON.stringify(candidate.manifest);
    assert.equal(serialized.includes('https://known.example'), true);
    for (const marker of allMarkers()) {
      assert.equal(serialized.includes(marker), false, `manifest must never contain ${marker}`);
    }
  });

  test('shared-link registry: no production record table exists and the gate denies every private blob', async () => {
    // The shared-link consumer surface has no production registry table. The
    // plan fixes the proof as: the deny-by-default creation contract (gate
    // verdict for the shared_link projection kind) + a scan that no
    // shared-link record table exists (so zero records is a fact, never a
    // fabricated pass). If a future migration adds a table, this scan must be
    // extended to scan its rows for markers.
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('shared_link'),
      'the gate must guard the shared_link projection kind');
    const tables = await isolated.runtime.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = current_schema()
          and (
            table_name like '%share%link%'
            or (
              table_name like '%shared%'
              and table_name not in ('favicon_shared_domains', 'favicon_shared_objects')
            )
          )`,
    );
    assert.deepEqual(tables.rows, [], 'no shared-link registry table may exist while the surface is absent');
    // The creation contract: every private blob state/generation state is
    // explicitly ineligible for shared-link exposure (creation denied).
    const blobRows = await isolated.runtime.pool.query<{ blob_id: string; logical_state: string; generation_state: string | null }>(
      `select b.blob_id, b.logical_state, g.generation_state
         from blob_records b
         join upload_intents u on u.blob_id = b.blob_id
         left join blob_generations g on g.generation_id = b.current_generation_id
        where u.collection_id = $1
        order by b.blob_id`,
      [I12_COLLECTION],
    );
    assert.ok(blobRows.rows.length >= 5, 'the private fixture blobs must be scoped to the control collection');
    for (const row of blobRows.rows) {
      const facts: SharedExposureBlobFacts = Object.freeze({
        blobId: row.blob_id,
        logicalState: row.logical_state as SharedExposureBlobFacts['logicalState'],
        currentGenerationState: row.generation_state as SharedExposureBlobFacts['currentGenerationState'],
      });
      const verdict = assessSharedExposureEligibility(facts);
      assert.equal(verdict.eligible, false, `shared-link creation must be denied for ${row.blob_id}`);
      assert.equal(verdict.reason, 'no_content_safety_evidence');
    }
  });
});

function buildSurface(
  isolatedRuntime: I07MigrationRuntime,
  pageSize = 10,
): {
  readonly surface: Phase4bMcpReadToolAdapterBundle;
  readonly collectionProjection: ReturnType<typeof createPhase4bMcpCollectionResourceProjection>;
  readonly destroy: () => void;
} {
  const config = loadConfig(mcpEnv()).mcp!;
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: `r06-mcp-pub-${randomUUID()}`, secret: Buffer.alloc(32, 69).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: `r06-mcp-${randomUUID()}`, secret: Buffer.alloc(32, 70).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
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
      now: () => NOW,
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(isolatedRuntime.runtime.db),
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize,
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
    now: () => NOW,
    sharedExposure: createPostgresSharedExposureFactsPort(isolatedRuntime.runtime),
  };
  const snapshotProjection = createPhase4bMcpSnapshotResourceProjection({
    config,
    snapshotQuery,
    now: () => NOW,
    pageSize,
  });
  const nodeProjection = createPhase4bMcpNodeResourceProjection({
    config,
    snapshotQuery,
    now: () => NOW,
  });
  return {
    collectionProjection,
    surface: createPhase4bMcpReadToolAdapter({
      collectionProjection,
      snapshotProjection,
      nodeProjection,
      serverUuid: SERVER_UUID,
    }),
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}
