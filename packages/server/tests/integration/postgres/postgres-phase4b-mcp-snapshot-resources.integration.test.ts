import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpResourceNotFoundError,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import {
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPhase4bMcpSnapshotResourceProjection,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
} from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const OWNER = 'owner-fixture';
const MEMBER = 'member-fixture';
const TEN_K = 10_000;
const SIDECAR_SECRET = 'sidecar-secret-content';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
  OIDC_ISSUER: 'https://issuer.example.test/realms/known',
  OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  } as Record<string, string>;
}

describeWithPostgres('Phase 4B R09 MCP Snapshot Resource PostgreSQL projection', () => {
  let isolated: IsolatedPostgresRuntime;
  let projection: Phase4bMcpSnapshotResourceProjection;
  let destroyProjection: () => void;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_snapshot_resources', {
      maxConnections: 8,
      applicationName: 'known-phase4b-mcp-snapshot-resources',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedSnapshotFixture(isolated);
    const built = buildProjection(isolated);
    projection = built.projection;
    destroyProjection = built.destroy;
  }, 300_000);

  afterAll(async () => {
    destroyProjection?.();
    await isolated?.close();
  });

  test('small public snapshot returns complete COLP Snapshot JSON and public cache scope', async () => {
    const result = await projection.readResource(snapshotInput('empty-collection'), trustedContext());
    const text = result.contents[0]!.text;
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(result.contents[0]!.mimeType, PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE);
    assert.deepEqual(result.contents[0]!.provenance, { origin: 'internal' });
    assert.equal(body.complete, true);
    assert.equal((body.nodes as unknown[]).length, 1);
    assert.deepEqual(body.annotations, []);
    assert.deepEqual(body.relations, []);
    assert.deepEqual(body.attachments, []);
    assert.doesNotMatch(text, /ownerSubjectId|membershipRole|"policyRevision"|subjectId/iu);
    assert.deepEqual(
      await projection.cacheForRead(snapshotInput('empty-collection'), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );
  });

  test('10k-node snapshot is delivered as a bounded Resource Link summary', async () => {
    const result = await projection.readResource(snapshotInput('large-collection'), trustedContext());
    const text = result.contents[0]!.text;
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.type, 'collection_snapshot_summary');
    assert.equal(body.complete, false);
    assert.equal(body.bounded, true);
    assert.equal(body.reason, 'continuation_available');
    assert.equal(Array.isArray(body.nodes), false);
    assert.ok((body.counts as Record<string, number>).nodes! <= 250);
    assert.equal(
      (body.resourceLink as Record<string, unknown>).uri,
      `colp://${SERVER_UUID}/collections/large-collection/snapshot`,
    );
    assert.ok((body.page as Record<string, unknown>).nextCursor);
    assert.ok((body.continuation as Record<string, unknown>).cursor);
    assert.ok(Buffer.byteLength(text, 'utf8') <= DEFAULT_MCP_RESOURCE_READ_BUDGET.maxTextBytes);
    assert.doesNotMatch(text, /ownerSubjectId|membershipRole|policyRevision/iu);
    assert.deepEqual(
      await projection.cacheForRead(snapshotInput('large-collection'), trustedContext()),
      { ttlMs: 0, cacheScope: 'private' },
    );
  });

  test('sidecar rows are omitted unless their safe Publication port is requested', async () => {
    const result = await projection.readResource(snapshotInput('sidecar-collection'), trustedContext());
    const body = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
    assert.deepEqual(body.annotations, []);
    assert.deepEqual(body.relations, []);
    assert.deepEqual(body.attachments, []);
    assert.doesNotMatch(result.contents[0]!.text, /sidecar-secret-content|sidecar-relation-label|ownerSubjectId/iu);
  });

  test('private collection is concealed anonymously and readable by the owner with private cache', async () => {
    await assert.rejects(
      () => projection.readResource(snapshotInput('private-collection'), trustedContext()),
      McpResourceNotFoundError,
    );
    const owner = await projection.readResource(
      snapshotInput('private-collection'),
      authenticatedContext(OWNER),
    );
    const body = JSON.parse(owner.contents[0]!.text) as Record<string, unknown>;
    assert.equal(body.complete, true);
    assert.equal((body.collection as Record<string, unknown>).visibility, 'private');
    assert.deepEqual(
      await projection.cacheForRead(snapshotInput('private-collection'), authenticatedContext(OWNER)),
      { ttlMs: 0, cacheScope: 'private' },
    );
  });

  test('continuation mutation expires and never returns a mixed revision tree', async () => {
    const first = await projection.readResource(snapshotInput('large-collection'), trustedContext());
    const firstBody = JSON.parse(first.contents[0]!.text) as Record<string, unknown>;
    const cursor = (firstBody.page as Record<string, unknown>).nextCursor as string;
    assert.ok(cursor);

    await isolated.runtime.pool.query(
      `update collections
          set content_revision = 'content-after-mutation',
              resource_revision = 'resource-after-mutation',
              updated_at = '2026-08-06T00:00:00Z'
        where id = 'large-collection'`,
    );
    await assert.rejects(
      () => projection.readPage(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-snapshot', collectionId: 'large-collection' }),
          pageCursor: cursor,
        }),
        trustedContext(),
      ),
      McpResourceNotFoundError,
    );

    const fresh = await projection.readResource(snapshotInput('large-collection'), trustedContext());
    const freshBody = JSON.parse(fresh.contents[0]!.text) as Record<string, unknown>;
    assert.equal((freshBody.collection as Record<string, unknown>).revision, 'content-after-mutation.p1');
    assert.notEqual(freshBody.revision, firstBody.revision);
  });


});

function snapshotInput(collectionId: string): Readonly<{ resource: { kind: 'collection-snapshot'; collectionId: string } }> {
  return Object.freeze({
    resource: Object.freeze({ kind: 'collection-snapshot', collectionId }),
  });
}

function trustedContext(overrides: Partial<McpTrustedReadRequestContext> = {}): McpTrustedReadRequestContext {
  return Object.freeze({
    binding: Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze([]),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
    ...overrides,
  });
}

function authenticatedContext(principalId: string): McpTrustedReadRequestContext {
  return trustedContext({
    binding: Object.freeze({
      kind: 'authenticated',
      principalId,
      clientId: 'mcp-client',
      credentialBindingId: 'credential-1',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    authorization: Object.freeze({ accountSubjectId: principalId }),
  });
}

function buildProjection(isolatedRuntime: IsolatedPostgresRuntime): {
  readonly projection: Phase4bMcpSnapshotResourceProjection;
  readonly destroy: () => void;
} {
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'snapshot-pg-v1', secret: Buffer.alloc(32, 101).toString('base64') },
    retained: [],
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
  const projection = createPhase4bMcpSnapshotResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    snapshotQuery,
    now: () => NOW,
    pageSize: 250,
  });
  return {
    projection,
    destroy() {
      publicationCursors.destroy();
    },
  };
}

async function seedSnapshotFixture(
  isolatedRuntime: IsolatedPostgresRuntime,
): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await seedSimpleCollection(client, 'empty-collection', 'public');
    await seedLargeCollection(client);
    await seedSidecarCollection(client);
    await seedPrivateCollection(client);
    await client.query('commit');
    await isolatedRuntime.runtime.pool.query('analyze nodes');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedSimpleCollection(
  client: import('pg').PoolClient,
  id: string,
  visibility: 'public' | 'private',
): Promise<void> {
  const rootId = `${id}-root`;
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
    [id, rootId],
  );
  await client.query(
    `insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id,
       resource_revision, content_revision, policy_revision, publication_slug,
       published_at, updated_at)
     values ($1, $2, $1, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $5,
             '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz)`,
    [id, OWNER, visibility, rootId, id],
  );
  await client.query(
    `insert into nodes(id, collection_id, kind, is_root, title,
                       resource_revision, children_revision)
     values ($1, $2, 'folder', true, $3, 'r1', 'ch1')`,
    [rootId, id, `Root ${id}`],
  );
}

async function seedLargeCollection(client: import('pg').PoolClient): Promise<void> {
  const rootId = 'large-collection-root';
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ('large-collection', 'collection'), ($1, 'node')`,
    [rootId],
  );
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type)
     select 'large-node-' || lpad(n::text, 5, '0'), 'node' from generate_series(1, $1) n`,
    [TEN_K],
  );
  await client.query(
    `insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id,
       resource_revision, content_revision, policy_revision, publication_slug,
       published_at, updated_at)
     values ('large-collection', $1, 'Large', 'bookmarks', 'public', $2,
             'r1', 'c1', 'p1', 'large-collection',
             '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz)`,
    [OWNER, rootId],
  );
  await client.query(
    `insert into nodes(id, collection_id, kind, is_root, title,
                       resource_revision, children_revision)
     values ($1, 'large-collection', 'folder', true, 'Large Root', 'r1', 'ch1')`,
    [rootId],
  );
  await client.query(
    `insert into nodes(
       id, collection_id, parent_id, kind, is_root, title, url, tags,
       visibility, position_token, resource_revision, children_revision)
     select 'large-node-' || lpad(n::text, 5, '0'),
            'large-collection', $1, 'bookmark', false,
            'Large node ' || n,
            'https://example.test/large/' || n,
            '[]'::jsonb, 'inherit',
            lpad(n::text, 20, '0'),
            'r1', 'ch1'
       from generate_series(1, $2) n`,
    [rootId, TEN_K],
  );
}

async function seedSidecarCollection(client: import('pg').PoolClient): Promise<void> {
  const rootId = 'sidecar-collection-root';
  const nodeId = 'sidecar-node';
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type)
     values ('sidecar-collection', 'collection'), ($1, 'node'), ($2, 'node'),
            ('sidecar-annotation', 'annotation'), ('sidecar-relation', 'relation')`,
    [rootId, nodeId],
  );
  await client.query(
    `insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id,
       resource_revision, content_revision, policy_revision, publication_slug,
       published_at, updated_at)
     values ('sidecar-collection', $1, 'Sidecars', 'mixed', 'public', $2,
             'r1', 'c1', 'p1', 'sidecar-collection',
             '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz)`,
    [OWNER, rootId],
  );
  await client.query(
    `insert into nodes(id, collection_id, kind, is_root, title,
                       resource_revision, children_revision)
     values ($1, 'sidecar-collection', 'folder', true, 'Sidecar Root', 'r1', 'ch1')`,
    [rootId],
  );
  await client.query(
    `insert into nodes(
       id, collection_id, parent_id, kind, is_root, title, url, tags,
       visibility, position_token, resource_revision, children_revision)
     values ($1, 'sidecar-collection', $2, 'bookmark', false, 'Sidecar Node',
             'https://example.test/sidecar', '[]'::jsonb, 'inherit', 'A', 'r1', 'ch1')`,
    [nodeId, rootId],
  );
  const instant = '2026-07-25T00:00:00Z';
  await client.query(
    `insert into annotations(
       id, collection_id, subject_type, subject_id, creator_principal_id,
       type, format, value_json, visibility, resource_revision, created_at,
       updated_at, payload_json)
     values (
       'sidecar-annotation', 'sidecar-collection', 'node', $1::text, $2::text,
       'note', 'plain', to_jsonb($3::text), 'public', 'r1',
       $4::timestamptz, $4::timestamptz,
       jsonb_build_object(
         'id', 'sidecar-annotation',
         'collectionId', 'sidecar-collection',
          'subject', jsonb_build_object('type', 'node', 'id', $1::text),
         'creator', jsonb_build_object('id', 'https://known.example/profiles/sidecar-owner', 'name', 'Sidecar Owner'),
         'type', 'note', 'format', 'plain', 'value', to_jsonb($3::text),
         'visibility', 'public', 'revision', 'r1',
          'createdAt', $4::timestamptz, 'updatedAt', $4::timestamptz))`,
    [nodeId, OWNER, SIDECAR_SECRET, instant],
  );
  await client.query(
    `insert into relations(
       id, collection_id, from_node_id, to_node_id, type, label, visibility,
       resource_revision, created_at, updated_at, payload_json)
     values (
       'sidecar-relation', 'sidecar-collection', $1, $2, 'related',
       'sidecar-relation-label', 'public', 'r1',
       $3::timestamptz, $3::timestamptz,
       jsonb_build_object(
         'id', 'sidecar-relation',
         'collectionId', 'sidecar-collection',
         'type', 'related',
          'fromNodeId', $1::text,
          'toNodeId', $2::text,
         'label', 'sidecar-relation-label',
         'visibility', 'public',
         'revision', 'r1',
          'createdAt', $3::timestamptz, 'updatedAt', $3::timestamptz))`,
    [rootId, nodeId, instant],
  );
}

async function seedPrivateCollection(client: import('pg').PoolClient): Promise<void> {
  await seedSimpleCollection(client, 'private-collection', 'private');
  await client.query(
    `insert into collection_members(collection_id, subject_id, role)
     values ('private-collection', $1, 'viewer')`,
    [MEMBER],
  );
}
