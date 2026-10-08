import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpToolOutputUnavailableError,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  type Mcp20260728RequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresMcpOwnedCollectionReadPort } from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresPublicationDirectoryReadPort,
  createPostgresPublicationMetadataReadPort,
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpNodeResourceProjection,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpRequestContext,
  createPhase4bMcpSnapshotResourceProjection,
  type Phase4bMcpReadToolAdapterBundle,
} from '../../../src/modules/mcp/index.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const OWNER = 'owner-fixture';
const OUTSIDER = 'outsider-fixture';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const INJECTION_TITLE = 'Injected <script>alert("tool")</script>';

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

describeWithPostgres('Phase 4B R12 MCP Read Tools PostgreSQL projection composition', () => {
  let isolated: IsolatedPostgresRuntime;
  let surface: Phase4bMcpReadToolAdapterBundle;
  let destroy: () => void;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_read_tools', {
      maxConnections: 8,
      applicationName: 'known-phase4b-mcp-read-tools',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedFixture(isolated);
    const built = buildSurface(isolated);
    surface = built.surface;
    destroy = built.destroy;
  }, 300_000);

  afterAll(async () => {
    destroy?.();
    await isolated?.close();
  });

  test('collections.get returns authorized structured Collection metadata from R08', async () => {
    const result = await surface.adapter.callTool(
      toolContext('collections.get', 'public-collection', anonymousBinding()),
      { name: 'collections.get', arguments: { collectionId: 'public-collection' } },
    );
    const collection = (result.structuredContent as { collection?: Record<string, unknown> }).collection!;
    assert.equal(collection.id, 'public-collection');
    assert.equal(collection.title, INJECTION_TITLE);
    assert.equal(collection.visibility, 'public');
    const text = (result.content as ReadonlyArray<{ readonly type?: string; readonly text?: string }>)[0];
    assert.equal(text?.type, 'text');
    assert.equal(JSON.parse(text?.text ?? '{}').collection.id, 'public-collection');
    assert.doesNotMatch(JSON.stringify(result), /ownerSubjectId|membershipRole|policyRevision/iu);
  });

  test('collections.get_snapshot returns a stable Resource Link from R09', async () => {
    const result = await surface.adapter.callTool(
      toolContext('collections.get_snapshot', 'public-collection', anonymousBinding()),
      { name: 'collections.get_snapshot', arguments: { collectionId: 'public-collection' } },
    );
    const blocks = result.content as ReadonlyArray<Record<string, unknown>>;
    assert.equal(blocks[0]?.type, 'text');
    const link = blocks[1]!;
    assert.equal(link.type, 'resource_link');
    assert.equal(
      link.uri,
      `colp://${SERVER_UUID}/collections/public-collection/snapshot`,
    );
    assert.equal(link.mimeType, 'application/vnd.collection-protocol.snapshot+json');
    assert.equal(
      (link.annotations as Record<string, unknown>).lastModified,
      '2026-08-05T08:00:00.000Z',
    );
  });

  test('collections.get_snapshot consumes its opaque continuation over the Tool wire', async () => {
    const first = await surface.adapter.callTool(
      toolContext('collections.get_snapshot', 'paged-collection', anonymousBinding()),
      { name: 'collections.get_snapshot', arguments: { collectionId: 'paged-collection' } },
    );
    const firstPage = first.structuredContent as Readonly<Record<string, unknown>>;
    const cursor = (firstPage.continuation as Readonly<Record<string, unknown>>).cursor;
    const firstSequence = (firstPage.page as Readonly<Record<string, unknown>>).sequence as number;
    assert.equal(typeof cursor, 'string');

    const second = await surface.adapter.callTool(
      toolContext('collections.get_snapshot', 'paged-collection', anonymousBinding(), cursor as string),
      {
        name: 'collections.get_snapshot',
        arguments: { collectionId: 'paged-collection', cursor },
      },
    );
    const secondPage = second.structuredContent as Readonly<Record<string, unknown>>;
    assert.ok(
      ((secondPage.page as Readonly<Record<string, unknown>>).sequence as number) > firstSequence,
    );
    assert.equal((secondPage.collection as Readonly<Record<string, unknown>>).revision, 'c1.p1');
  });

  test('private targets are concealed anonymously and readable by the owner', async () => {
    await assert.rejects(
      () => surface.adapter.callTool(
        toolContext('collections.get', 'private-collection', anonymousBinding()),
        { name: 'collections.get', arguments: { collectionId: 'private-collection' } },
      ),
      McpToolOutputUnavailableError,
    );

    const owner = await surface.adapter.callTool(
      toolContext('collections.get', 'private-collection', authenticatedBinding(OWNER)),
      { name: 'collections.get', arguments: { collectionId: 'private-collection' } },
    );
    const owned = (owner.structuredContent as {
      collection?: { visibility?: string; revision?: string; contentRevision?: string; policyRevision?: string };
    }).collection;
    assert.equal(owned?.visibility, 'private');
    assert.equal(owned?.revision, 'r1');
    assert.equal(owned?.contentRevision, 'c1');
    assert.equal(owned?.policyRevision, 'p1');

    const snapshot = await surface.adapter.callTool(
      toolContext('collections.get_snapshot', 'private-collection', authenticatedBinding(OWNER)),
      { name: 'collections.get_snapshot', arguments: { collectionId: 'private-collection' } },
    );
    assert.equal(
      (snapshot.structuredContent as { collection?: { revision?: string } }).collection?.revision,
      'r1',
    );

    const node = await surface.adapter.callTool(
      toolContext('nodes.get', 'private-collection', authenticatedBinding(OWNER), undefined, 'private-collection-root'),
      {
        name: 'nodes.get',
        arguments: { collectionId: 'private-collection', nodeId: 'private-collection-root' },
      },
    );
    assert.equal((node.structuredContent as { revision?: string }).revision, 'r1');
  });

  test('owned snapshot continuation rejects content changes with an unchanged resource revision', async () => {
    const db = isolated.runtime.db;
    const port = createPostgresMcpOwnedCollectionReadPort({ db, accessPolicy: createPostgresAccessPolicyFactsPort(db) });
    const first = await port.readSnapshot({ collectionId: 'paged-collection', actorSubjectId: OWNER, limit: 1 });
    assert.equal(first?.consistency, 'version-fenced');
    assert.ok(first?.nextAfter);
    await db.updateTable('collections').set({ content_revision: 'content-after-edit' }).where('id', '=', 'paged-collection').execute();
    try {
      await assert.rejects(() => port.readSnapshot({ collectionId: 'paged-collection', actorSubjectId: OWNER, limit: 1, after: first.nextAfter! }), /Snapshot changed/u);
    } finally {
      await db.updateTable('collections').set({ content_revision: first.collection.contentRevision }).where('id', '=', 'paged-collection').execute();
    }
  });

  test('owned snapshot metadata and nodes stay in one database snapshot during a concurrent edit', async () => {
    const db = isolated.runtime.db;
    const before = await db.selectFrom('nodes').select('title').where('id', '=', 'paged-node-01').executeTakeFirstOrThrow();
    let edited = false;
    const observed = db.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (!edited && result.rows.some(row => Object.hasOwn(row, 'content_revision'))) {
          edited = true;
          await db.transaction().execute(async tx => {
            await tx.updateTable('nodes').set({ title: 'concurrent edit' }).where('id', '=', 'paged-node-01').execute();
            await tx.updateTable('collections').set({ content_revision: 'concurrent-content' }).where('id', '=', 'paged-collection').execute();
          });
        }
        return result;
      },
    });
    const port = createPostgresMcpOwnedCollectionReadPort({ db: observed, accessPolicy: createPostgresAccessPolicyFactsPort(db) });
    try {
      const snapshot = await port.readSnapshot({ collectionId: 'paged-collection', actorSubjectId: OWNER, limit: 100 });
      assert.equal(edited, true);
      assert.equal(snapshot?.collection.contentRevision, 'c1');
      assert.equal(snapshot?.nodes.find(node => node.id === 'paged-node-01')?.title, before.title);
    } finally {
      await db.updateTable('nodes').set({ title: before.title }).where('id', '=', 'paged-node-01').execute();
      await db.updateTable('collections').set({ content_revision: 'c1' }).where('id', '=', 'paged-collection').execute();
    }
  });

  test('mcp:read:own still reads someone else\'s published public Collection via Publication', async () => {
    const outsiderPublic = await surface.adapter.callTool(
      toolContext('collections.get', 'public-collection', authenticatedBinding(OUTSIDER)),
      { name: 'collections.get', arguments: { collectionId: 'public-collection' } },
    );
    const published = (outsiderPublic.structuredContent as {
      collection?: { visibility?: string; revision?: string };
    }).collection;
    assert.equal(published?.visibility, 'public');
    assert.equal(published?.revision, 'c1.p1');

    await assert.rejects(
      () => surface.adapter.callTool(
        toolContext('collections.get', 'private-collection', authenticatedBinding(OUTSIDER)),
        { name: 'collections.get', arguments: { collectionId: 'private-collection' } },
      ),
      McpToolOutputUnavailableError,
    );
  });

  test('dynamic untrusted content stays in structured content, never in fixed Tool descriptions', async () => {
    const list = await surface.adapter.listTools(
      listContext(authenticatedBinding(OWNER)),
      {},
    );
    const tools = list.tools as ReadonlyArray<{ readonly description: string }>;
    for (const tool of tools) {
      assert.doesNotMatch(tool.description, /<script>|alert\("tool"\)/iu);
    }

    const result = await surface.adapter.callTool(
      toolContext('collections.get', 'public-collection', anonymousBinding()),
      { name: 'collections.get', arguments: { collectionId: 'public-collection' } },
    );
    assert.equal(
      (result.structuredContent as { collection?: { title?: string } }).collection?.title,
      INJECTION_TITLE,
    );
  });

  test('nodes.get returns an authorized public node including its resource revision', async () => {
    const result = await surface.adapter.callTool(
      toolContext('nodes.get', 'public-collection', anonymousBinding(), undefined, 'public-collection-root'),
      {
        name: 'nodes.get',
        arguments: { collectionId: 'public-collection', nodeId: 'public-collection-root' },
      },
    );
    const structured = result.structuredContent as {
      readonly id?: string;
      readonly collectionId?: string;
      readonly revision?: string;
    };
    assert.equal(structured.id, 'public-collection-root');
    assert.equal(structured.collectionId, 'public-collection');
    assert.equal(typeof structured.revision, 'string');
    assert.ok((structured.revision ?? '').length > 0);
    const text = (result.content as ReadonlyArray<{ readonly type?: string; readonly text?: string }>)[0];
    assert.equal(text?.type, 'text');
    assert.deepEqual(JSON.parse(text?.text ?? '{}'), structured);
  });

  test('nodes.get conceals private targets from anonymous callers', async () => {
    await assert.rejects(
      () => surface.adapter.callTool(
        toolContext('nodes.get', 'private-collection', anonymousBinding(), undefined, 'private-collection-root'),
        {
          name: 'nodes.get',
          arguments: { collectionId: 'private-collection', nodeId: 'private-collection-root' },
        },
      ),
      McpToolOutputUnavailableError,
    );
  });
});

function anonymousBinding() {
  return createAnonymousPublicBinding({
    resourceAudience: AUDIENCE,
    securityEpoch: 'epoch-1',
  });
}

function authenticatedBinding(principalId: string) {
  return createAuthenticatedBinding({
    credentialKind: 'oauth',
    principalId,
    clientId: 'known-mcp-oauth-client',
    credentialBindingId: 'credential-1',
    resourceAudience: AUDIENCE,
    securityEpoch: 'epoch-1',
  });
}

function meta(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': Object.freeze({
      tools: Object.freeze({ call: true }),
    }),
  });
}

function toolContext(
  name: string,
  collectionId: string,
  binding: ReturnType<typeof anonymousBinding> | ReturnType<typeof authenticatedBinding>,
  cursor?: string,
  nodeId?: string,
): Mcp20260728RequestContext {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: name }),
      Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: collectionId }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: meta(),
        name,
        arguments: Object.freeze({
          collectionId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(nodeId === undefined ? {} : { nodeId }),
        }),
      }),
    }),
    binding,
    scope: ['mcp:read:public', 'mcp:read:own'],
    authorization: Object.freeze(
      binding.kind === 'authenticated'
        ? { accountSubjectId: binding.principalId }
        : {},
    ),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  });
}

function listContext(binding: ReturnType<typeof authenticatedBinding>): Mcp20260728RequestContext {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/list' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/list',
      params: Object.freeze({ _meta: meta() }),
    }),
    binding,
    scope: ['mcp:read:public', 'mcp:read:own'],
    authorization: Object.freeze(
      binding.kind === 'authenticated'
        ? { accountSubjectId: binding.principalId }
        : {},
    ),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

function buildSurface(isolatedRuntime: IsolatedPostgresRuntime): {
  readonly surface: Phase4bMcpReadToolAdapterBundle;
  readonly destroy: () => void;
} {
  const config = loadConfig(mcpEnv()).mcp!;
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'read-tools-pg-v1', secret: Buffer.alloc(32, 121).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'read-tools-mcp-v1', secret: Buffer.alloc(32, 123).toString('base64') },
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
    now: () => NOW,
    sharedExposure: createPostgresSharedExposureFactsPort(isolatedRuntime.runtime),
  };
  const snapshotProjection = createPhase4bMcpSnapshotResourceProjection({
    config,
    snapshotQuery,
    now: () => NOW,
    pageSize: 10,
  });
  const nodeProjection = createPhase4bMcpNodeResourceProjection({
    config,
    snapshotQuery,
    now: () => NOW,
  });
  return {
    surface: createPhase4bMcpReadToolAdapter({
      collectionProjection,
      snapshotProjection,
      nodeProjection,
      serverUuid: SERVER_UUID,
      ownedRead: createPostgresMcpOwnedCollectionReadPort({
        db: isolatedRuntime.runtime.db,
        accessPolicy: snapshotQuery.accessPolicy,
      }),
    }),
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

async function seedFixture(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await seedCollection(client, 'public-collection', 'public', INJECTION_TITLE, OWNER);
    await seedCollection(client, 'private-collection', 'private', 'Private', OWNER);
    await seedPagedCollection(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function seedPagedCollection(client: import('pg').PoolClient): Promise<void> {
  await seedCollection(client, 'paged-collection', 'public', 'Paged', OWNER);
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type)
     select 'paged-node-' || lpad(n::text, 2, '0'), 'node' from generate_series(1, 12) n`,
  );
  await client.query(
    `insert into nodes(
       id, collection_id, parent_id, kind, is_root, title, url, tags,
       visibility, position_token, resource_revision, children_revision)
     select 'paged-node-' || lpad(n::text, 2, '0'),
            'paged-collection', 'paged-collection-root', 'bookmark', false,
            'Paged node ' || n, 'https://example.test/paged/' || n,
            '[]'::jsonb, 'inherit', lpad(n::text, 20, '0'), 'r1', 'ch1'
       from generate_series(1, 12) n`,
  );
}

async function seedCollection(
  client: import('pg').PoolClient,
  id: string,
  visibility: 'public' | 'private',
  title: string,
  owner: string,
): Promise<void> {
  const rootId = `${id}-root`;
  const published = visibility === 'public';
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
    [id, rootId],
  );
  await client.query(
    `insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id,
       resource_revision, content_revision, policy_revision, publication_slug,
       published_at, updated_at)
     values ($1, $2, $3, 'bookmarks', $4, $5,
             'r1', 'c1', 'p1', $6, $7,
             '2026-08-05T08:00:00Z'::timestamptz)`,
    [
      id,
      owner,
      title,
      visibility,
      rootId,
      published ? id : null,
      published ? '2026-01-01T00:00:00Z' : null,
    ],
  );
  await client.query(
    `insert into nodes(id, collection_id, kind, is_root, title,
                       resource_revision, children_revision)
     values ($1, $2, 'folder', true, $3, 'r1', 'ch1')`,
    [rootId, id, `Root ${id}`],
  );
}
