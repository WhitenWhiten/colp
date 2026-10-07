import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  type Phase4bMcpCollectionResourceProjection,
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
const OUTSIDER = 'outsider-fixture';
const TEN_K = 10_000;

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
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
  } as Record<string, string>;
}

describeWithPostgres('Phase 4B R08 MCP Collection Resource PostgreSQL projection', () => {
  let isolated: IsolatedPostgresRuntime;
  let projection: Phase4bMcpCollectionResourceProjection;
  let destroyProjection: () => void;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_collection_resources', {
      maxConnections: 8,
      applicationName: 'known-phase4b-mcp-collection-resources',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollectionResourceFixture(isolated);
    const built = buildProjection(isolated);
    projection = built.projection;
    destroyProjection = built.destroy;
  }, 240_000);

  afterAll(async () => {
    destroyProjection?.();
    await isolated?.close();
  });

  test('anonymous, member, owner, and revoked principals see no duplicates or permission bleed', async () => {
    const anonymous = await collectList(projection, trustedContext());
    assert.equal(anonymous.length, TEN_K + 1);
    assert.equal(new Set(anonymous).size, anonymous.length);
    assert.equal(anonymous.includes('fixture-public'), true);
    assert.equal(anonymous.includes('fixture-protected-member'), false);
    assert.equal(anonymous.includes('fixture-unlisted'), false);
    assert.equal(anonymous.includes('fixture-private'), false);
    assert.equal(anonymous.includes('fixture-deleted'), false);

    const member = await collectList(projection, authenticatedContext(MEMBER));
    assert.equal(member.length, TEN_K + 2);
    assert.equal(member.includes('fixture-protected-member'), true);

    const owner = await collectList(projection, authenticatedContext(OWNER));
    assert.equal(owner.includes('fixture-protected-owner'), true);
    assert.equal(owner.includes('fixture-private'), false);

    const outsider = await collectList(projection, authenticatedContext(OUTSIDER));
    assert.equal(outsider.includes('fixture-protected-member'), false);
    assert.equal(outsider.includes('fixture-protected-owner'), false);
    assert.equal(new Set(outsider).size, outsider.length);

    await isolated.runtime.pool.query(
      `delete from collection_members where collection_id = 'fixture-protected-member'
         and subject_id = $1`,
      [MEMBER],
    );
    const revoked = await collectList(projection, authenticatedContext(MEMBER));
    assert.equal(revoked.includes('fixture-protected-member'), false);
    await assert.rejects(
      () => projection.readResource(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'fixture-protected-member' }),
        }),
        authenticatedContext(MEMBER),
      ),
      McpResourceNotFoundError,
    );
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ('fixture-protected-member', $1, 'viewer')`,
      [MEMBER],
    );
  });

  test('traverses the 10k public Directory projection with stable MCP cursors', async () => {
    const ids = await collectList(projection, trustedContext());
    assert.equal(ids.length, TEN_K + 1);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.filter((id) => id.startsWith('collection-')).length, TEN_K);
    assert.equal(ids[0], 'fixture-public');
  });

  test('exact metadata read allows unlisted but conceals private, protected, deleted, and unpublished', async () => {
    const publicRead = await projection.readResource(
      metadataInput('fixture-public'),
      trustedContext(),
    );
    assert.equal(JSON.parse(publicRead.contents[0]!.text).collection.visibility, 'public');
    assert.deepEqual(
      await projection.cacheForRead(metadataInput('fixture-public'), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );

    const unlisted = await projection.readResource(metadataInput('fixture-unlisted'), trustedContext());
    assert.equal(JSON.parse(unlisted.contents[0]!.text).collection.visibility, 'unlisted');
    assert.deepEqual(
      await projection.cacheForRead(metadataInput('fixture-unlisted'), trustedContext()),
      { ttlMs: 0, cacheScope: 'private' },
    );

    for (const id of ['fixture-protected-member', 'fixture-private', 'fixture-deleted', 'fixture-unpublished']) {
      await assert.rejects(
        () => projection.readResource(metadataInput(id), trustedContext()),
        McpResourceNotFoundError,
        id,
      );
    }

    const member = await projection.readResource(
      metadataInput('fixture-protected-member'),
      authenticatedContext(MEMBER),
    );
    assert.equal(JSON.parse(member.contents[0]!.text).collection.id, 'fixture-protected-member');
    assert.deepEqual(
      await projection.cacheForRead(
        metadataInput('fixture-protected-member'),
        authenticatedContext(MEMBER),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );

    await assert.rejects(
      () => projection.readResource(metadataInput('fixture-private'), authenticatedContext(OUTSIDER)),
      McpResourceNotFoundError,
    );
  });

  test('list items expose only the MCP allowlist and cache declarations never exceed authority', async () => {
    const page = await projection.listResources(Object.freeze({}), trustedContext());
    const keys = Object.keys(page.resources[0]!).sort();
    assert.ok(keys.includes('_meta'));
    assert.deepEqual(
      keys.filter((key) => key !== 'description'),
      ['_meta', 'mimeType', 'name', 'provenance', 'uri'],
    );
    const serialized = JSON.stringify(page.resources[0]);
    assert.doesNotMatch(serialized, /ownerSubjectId|membershipRole|policyRevision|subjectId|orderingUpdatedAtMicros/iu);
    assert.deepEqual(
      await projection.cacheForList(Object.freeze({}), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );
    assert.deepEqual(
      await projection.cacheForList(Object.freeze({}), authenticatedContext(MEMBER)),
      { ttlMs: 0, cacheScope: 'private' },
    );
  });

  test('visibility and deletion policy changes are reflected by list and exact read', async () => {
    const firstPage = await projection.listResources(Object.freeze({}), trustedContext());
    assert.ok(firstPage.nextCursor);
    await isolated.runtime.pool.query(
      `update collections
          set visibility = 'private', policy_revision = 'p9',
              updated_at = '2026-08-06T00:00:00Z'
        where id = 'fixture-public'`,
    );
    await assert.rejects(
      () => projection.listResources(
        Object.freeze({ cursor: firstPage.nextCursor! }),
        trustedContext(),
      ),
      McpReadRequestContextError,
    );
    const anonymous = await collectList(projection, trustedContext());
    assert.equal(anonymous.includes('fixture-public'), false);
    await assert.rejects(
      () => projection.readResource(metadataInput('fixture-public'), trustedContext()),
      McpResourceNotFoundError,
    );
    const owner = await projection.readResource(metadataInput('fixture-public'), authenticatedContext(OWNER));
    assert.equal(JSON.parse(owner.contents[0]!.text).collection.visibility, 'private');
    await isolated.runtime.pool.query(
      `update collections
          set visibility = 'public', policy_revision = 'p1',
              updated_at = '2026-01-01T00:00:00Z'
        where id = 'fixture-public'`,
    );

    const deletionClient = await isolated.runtime.pool.connect();
    try {
      await deletionClient.query('begin');
      await deletionClient.query(
        `update nodes set deleted_at = '2026-08-01T00:00:00Z'
         where collection_id = 'fixture-public' and id = 'fixture-public-root'`,
      );
      await deletionClient.query(
        `update collections set deleted_at = '2026-08-01T00:00:00Z'
         where id = 'fixture-public'`,
      );
      await deletionClient.query('commit');
    } catch (error) {
      await deletionClient.query('rollback');
      throw error;
    } finally {
      deletionClient.release();
    }
    const deletedList = await collectList(projection, trustedContext());
    assert.equal(deletedList.includes('fixture-public'), false);
    await assert.rejects(
      () => projection.readResource(metadataInput('fixture-public'), authenticatedContext(OWNER)),
      McpResourceNotFoundError,
    );
    const restoreClient = await isolated.runtime.pool.connect();
    try {
      await restoreClient.query('begin');
      await restoreClient.query(
        `update nodes set deleted_at = null
         where collection_id = 'fixture-public' and id = 'fixture-public-root'`,
      );
      await restoreClient.query(
        `update collections set deleted_at = null where id = 'fixture-public'`,
      );
      await restoreClient.query('commit');
    } catch (error) {
      await restoreClient.query('rollback');
      throw error;
    } finally {
      restoreClient.release();
    }
  });
});

function metadataInput(collectionId: string): Readonly<{ resource: { kind: 'collection-metadata'; collectionId: string } }> {
  return Object.freeze({
    resource: Object.freeze({ kind: 'collection-metadata', collectionId }),
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

function authenticatedContext(principalId: string, overrides: Partial<McpTrustedReadRequestContext> = {}): McpTrustedReadRequestContext {
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
    ...overrides,
  });
}

async function collectList(
  target: Phase4bMcpCollectionResourceProjection,
  context: McpTrustedReadRequestContext,
): Promise<readonly string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await target.listResources(
      cursor === undefined ? Object.freeze({}) : Object.freeze({ cursor }),
      context,
    );
    ids.push(...page.resources.map((entry) => entry.uri.split('/').at(-1)!));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return Object.freeze(ids);
}

function buildProjection(isolatedRuntime: IsolatedPostgresRuntime): {
  readonly projection: Phase4bMcpCollectionResourceProjection;
  readonly destroy: () => void;
} {
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'publication-pg-v1', secret: Buffer.alloc(32, 71).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-pg-v1', secret: Buffer.alloc(32, 73).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const projection = createPhase4bMcpCollectionResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    directoryQuery: {
      reads: createPostgresPublicationDirectoryReadPort(isolatedRuntime.runtime),
      cursors: publicationCursors,
      origin: 'https://known.example',
      maxPageSize: 500,
    },
    metadataQuery: {
      reads: createPostgresPublicationMetadataReadPort(isolatedRuntime.runtime),
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: createPostgresAccessPolicyFactsPort(isolatedRuntime.runtime.db),
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize: 250,
    sharedExposure: createPostgresSharedExposureFactsPort(isolatedRuntime.runtime),
    policyRevisionFor: async () => {
      const result = await isolatedRuntime.runtime.pool.query<{ authority: string }>(
        `select count(*)::text || ':' || coalesce(max(policy_revision), 'none')
                || ':' || coalesce(max(updated_at)::text, 'none') as authority
           from collections`,
      );
      return result.rows[0]?.authority ?? 'none';
    },
  });
  return {
    projection,
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

async function seedCollectionResourceFixture(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await seedTenKCollections(client);
    await seedVisibilityFixtures(client);
    await client.query('commit');
    await isolatedRuntime.runtime.pool.query('analyze collections');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedTenKCollections(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    with generated as (
      select 'collection-' || lpad(n::text, 5, '0') as id,
             'collection-root-' || lpad(n::text, 5, '0') as root_id
        from generate_series(1, ${TEN_K}) n
    )
    insert into resource_id_ledger(resource_id, resource_type)
    select id, 'collection' from generated
    union all
    select root_id, 'node' from generated
  `);
  await client.query(`
    with generated as (
      select 'collection-' || lpad(n::text, 5, '0') as id,
             'collection-root-' || lpad(n::text, 5, '0') as root_id,
             n
        from generate_series(1, ${TEN_K}) n
    )
    insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id,
       resource_revision, content_revision, policy_revision, publication_slug,
       published_at, updated_at)
    select id, $1, 'Collection ' || n, 'bookmarks', 'public', root_id,
           'r1', 'c1', 'p1', id,
           '2026-01-01T00:00:00Z'::timestamptz,
           '2026-01-01T00:00:00Z'::timestamptz - n * interval '1 second'
      from generated
  `, ['owner-10k']);
  await client.query(`
    with generated as (
      select 'collection-' || lpad(n::text, 5, '0') as id,
             'collection-root-' || lpad(n::text, 5, '0') as root_id
        from generate_series(1, ${TEN_K}) n
    )
    insert into nodes(id, collection_id, kind, is_root, title,
                      resource_revision, children_revision)
    select root_id, id, 'folder', true, 'Root ' || id, 'r1', 'ch1'
      from generated
  `);
}

async function seedVisibilityFixtures(client: import('pg').PoolClient): Promise<void> {
  const fixtures = [
    ['fixture-public', 'public', OWNER, true, false],
    ['fixture-protected-owner', 'protected', OWNER, true, false],
    ['fixture-protected-member', 'protected', 'other-owner', true, false],
    ['fixture-unlisted', 'unlisted', OWNER, true, false],
    ['fixture-private', 'private', OWNER, true, false],
    ['fixture-deleted', 'public', OWNER, true, true],
    ['fixture-unpublished', 'protected', OWNER, false, false],
  ] as const;
  for (const [id, visibility, owner, published, deleted] of fixtures) {
    const rootId = `${id}-root`;
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
      [id, rootId],
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, publication_slug,
         published_at, deleted_at, updated_at)
       values ($1, $2, $1, 'bookmarks', $3, $4,
               'r1', 'c1', 'p1', $5,
               case when $6 then '2026-01-01T00:00:00Z'::timestamptz else null end,
               case when $7 then '2026-01-01T00:00:00Z'::timestamptz else null end,
               '2026-01-01T00:00:00Z'::timestamptz)`,
      [id, owner, visibility, rootId, published ? id : null, published, deleted],
    );
    await client.query(
      `insert into nodes(id, collection_id, kind, is_root, title,
                         resource_revision, children_revision, deleted_at)
       values ($1, $2, 'folder', true, $2, 'r1', 'ch1', $3::timestamptz)`,
      [rootId, id, deleted ? '2026-01-01T00:00:00Z' : null],
    );
  }
  await client.query(
    `insert into collection_members(collection_id, subject_id, role)
     values ('fixture-protected-member', $1, 'viewer')`,
    [MEMBER],
  );
}
