import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { DEFAULT_MCP_RESOURCE_READ_BUDGET } from '@know-n/colp/mcp';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import { createPostgresNodesSearchPorts } from '../../../src/infrastructure/search/index.js';
import {
  NODES_SEARCH_TOOL_DESCRIPTOR,
} from '../../../src/modules/mcp/application-catalog.js';
import {
  NODES_SEARCH_DESCRIPTION,
  NODES_SEARCH_PROFILE_CLAIM,
  PHASE4B_MCP_OPTIONAL_READ_TOOL_NAMES,
} from '../../../src/modules/mcp/read-tools.js';
import { createMcpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import {
  callNodesSearchTool,
  executeNodesSearch,
  nodesSearchOutputSchema,
  type NodesSearchPorts,
  type NodesSearchResult,
} from '../../../src/modules/mcp/nodes-search.js';
import { createMcpToolInputValidator } from '../../support/mcp-tool-schema-validator.js';
import { createSearchCursorSigner } from '../../../src/modules/search/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const KEYS = { current: { id: 'nodes-search', key: 'nodes-search-cursor-key-material' } } as const;
const QUERY = 'zephyr';

test('nodes.search is an optional mcp-read tool with nodes:read and annotations:read', () => {
  assert.deepEqual(PHASE4B_MCP_OPTIONAL_READ_TOOL_NAMES, ['nodes.search']);
  assert.equal(NODES_SEARCH_TOOL_DESCRIPTOR.name, 'nodes.search');
  assert.equal(NODES_SEARCH_TOOL_DESCRIPTOR.optional, true);
  assert.equal(NODES_SEARCH_TOOL_DESCRIPTOR.risk, 'none');
  assert.deepEqual([...NODES_SEARCH_TOOL_DESCRIPTOR.requiredScopes], ['nodes:read']);
  assert.deepEqual(NODES_SEARCH_TOOL_DESCRIPTOR.profileClaim, NODES_SEARCH_PROFILE_CLAIM);
  assert.equal(NODES_SEARCH_PROFILE_CLAIM.profile, 'mcp-read');
  assert.equal(NODES_SEARCH_PROFILE_CLAIM.optional, true);
  assert.equal(NODES_SEARCH_PROFILE_CLAIM.scope, 'nodes:read');
  assert.equal(NODES_SEARCH_PROFILE_CLAIM.annotationScope, 'annotations:read');
  assert.equal(NODES_SEARCH_TOOL_DESCRIPTOR.description, NODES_SEARCH_DESCRIPTION);
  assert.match(NODES_SEARCH_DESCRIPTION, /titles/);
  assert.match(NODES_SEARCH_DESCRIPTION, /annotations:read/);
  const input = NODES_SEARCH_TOOL_DESCRIPTOR.inputSchema;
  assert.deepEqual(input.required, ['query']);
  const properties = input.properties as {
    readonly query: object;
    readonly collectionId: object;
    readonly cursor: object;
    readonly limit: { readonly maximum: number };
  };
  assert.ok(properties.query);
  assert.ok(properties.collectionId);
  assert.ok(properties.cursor);
  assert.equal(properties.limit.maximum, 100);
  const output = NODES_SEARCH_TOOL_DESCRIPTOR.outputSchema;
  assert.ok(output);
  assert.deepEqual(output.required, ['nodes', 'cursor']);
});

test('nodes.search rejects a limit above 100 before searching', async () => {
  const ports = new Proxy({}, {
    get() {
      throw new Error('search must not run when limit is invalid');
    },
  }) as NodesSearchPorts;
  await assert.rejects(
    () => executeNodesSearch(ports, {
      principal: { kind: 'anonymous' },
      scopes: ['nodes:read'],
      query: QUERY,
      limit: 101,
    }),
    /limit/i,
  );
});

describeWithPostgres('nodes.search matches bookmark fields and hides unreadable collections', () => {
  let isolated: IsolatedPostgresRuntime;
  let ports: NodesSearchPorts;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('nodes_search', {
      maxConnections: 4,
      applicationName: 'known-nodes-search',
    });
    const migrated = await createMigrator(isolated.runtime.db, undefined, isolated.schema).migrateToLatest();
    if (migrated.error) throw migrated.error;
    await seedCorpus(isolated);
    ports = createPostgresNodesSearchPorts({
      db: isolated.runtime.db,
      sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      cursors: createSearchCursorSigner(KEYS),
      clock: { now: () => new Date('2026-10-07T00:00:00.000Z') },
    });
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('matches title, URL, description, tag, and note for a reader, and none for an outsider', async () => {
    const readable = await searchAs('account-owner', 'subject-owner', ['nodes:read', 'annotations:read']);
    assert.deepEqual(readable.nodes.map((node) => node.id).sort(), [
      'n-desc', 'n-note', 'n-tag', 'n-title', 'n-url',
    ]);
    for (const node of readable.nodes) {
      assert.equal(node.collectionId, 'e3-col');
      assert.equal(node.folderPath, '/Reading');
    }
    assert.equal(readable.nodes.find((node) => node.id === 'n-title')?.linkHealth, 'broken');
    assert.equal(readable.cursor, null);
    assert.deepEqual(readable.page, { hasMore: false, nextCursor: null });
    assert.equal(readable.nodes.find((node) => node.id === 'n-title')?.title, 'Zephyr Protocol');
    assert.equal(readable.nodes.find((node) => node.id === 'n-url')?.url, 'https://example.com/zephyr-docs');
    assert.ok(readable.nodes.every((node) => node.kind === 'bookmark'));

    const notesHidden = await searchAs('account-owner', 'subject-owner', ['nodes:read']);
    assert.deepEqual(notesHidden.nodes.map((node) => node.id).sort(), [
      'n-desc', 'n-tag', 'n-title', 'n-url',
    ]);

    const denied = await searchAs('account-outsider', 'subject-outsider', ['nodes:read', 'annotations:read']);
    assert.deepEqual(denied.nodes, []);
  }, 60_000);

  test('an annotation hit on a synchronized separator satisfies the published output schema', async () => {
    const result = await searchAs('account-owner', 'subject-owner', ['nodes:read', 'annotations:read'], 'divider-hit');
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0]?.id, 'n-separator');
    assert.equal(result.nodes[0]?.kind, 'separator');
    assert.equal(result.nodes[0]?.title, null);
    const validate = createMcpToolInputValidator(nodesSearchOutputSchema);
    assert.doesNotThrow(() => validate(result));
  });

  test('summary hydration cannot reveal a URL written after the reader lost access', async () => {
    const db = isolated.runtime.db;
    const original = await db.selectFrom('nodes').select(['url', 'visibility']).where('id', '=', 'n-title').executeTakeFirstOrThrow();
    await db.insertInto('collection_members').values({ collection_id: 'e3-col', subject_id: 'subject-outsider', role: 'viewer' }).execute();
    const withConcurrentChange = (readPorts: NodesSearchPorts): NodesSearchPorts => ({ ...readPorts, cards: {
      async load(nodes) {
        await db.deleteFrom('collection_members').where('collection_id', '=', 'e3-col').where('subject_id', '=', 'subject-outsider').execute();
        await db.updateTable('nodes').set({ url: 'https://private.example/secret-after-revocation', visibility: 'private' }).where('id', '=', 'n-title').execute();
        return readPorts.cards.load(nodes);
      },
    } });
    try {
      const testedPorts = ports.withReadSnapshot === undefined ? withConcurrentChange(ports) : {
        ...ports,
        withReadSnapshot: <Result>(read: (readPorts: NodesSearchPorts) => Promise<Result>) =>
          ports.withReadSnapshot!((snapshot) => read(withConcurrentChange(snapshot))),
      };
      const result = await executeNodesSearch(testedPorts, {
        principal: { kind: 'account', accountId: 'account-outsider', principalId: 'account-outsider', subjectId: 'subject-outsider', securityEpoch: '1' },
        scopes: ['nodes:read'], query: 'Zephyr Protocol',
      });
      assert.equal(result.nodes[0]?.url, original.url);
      const afterRevocation = await executeNodesSearch(ports, {
        principal: { kind: 'account', accountId: 'account-outsider', principalId: 'account-outsider', subjectId: 'subject-outsider', securityEpoch: '1' },
        scopes: ['nodes:read'], query: 'Zephyr Protocol',
      });
      assert.deepEqual(afterRevocation.nodes, []);
    } finally {
      await db.updateTable('nodes').set(original).where('id', '=', 'n-title').execute();
      await db.deleteFrom('collection_members').where('collection_id', '=', 'e3-col').where('subject_id', '=', 'subject-outsider').execute();
    }
  });

  test('page metadata follows non-empty cursors and collection-scoped continuation', async () => {
    const principal = { kind: 'account' as const, accountId: 'account-owner', principalId: 'account-owner', subjectId: 'subject-owner', securityEpoch: '1' };
    const first = await executeNodesSearch(ports, { principal, scopes: ['nodes:read', 'annotations:read'], query: QUERY, collectionId: 'e3-col', limit: 2 });
    assert.equal(first.page.hasMore, true);
    assert.equal(first.page.nextCursor, first.cursor);
    assert.ok(first.cursor);
    await assert.rejects(executeNodesSearch(ports, { principal, scopes: ['nodes:read', 'annotations:read'], query: QUERY,
      collectionId: 'another-collection', cursor: first.cursor }), { code: 'invalid_cursor' });
    const found = first.nodes.map((node) => node.id);
    let page = first;
    let rounds = 0;
    while (page.cursor !== null) {
      assert.ok(++rounds <= 5, 'pagination must terminate');
      page = await executeNodesSearch(ports, { principal, scopes: ['nodes:read', 'annotations:read'], query: QUERY,
        collectionId: 'e3-col', cursor: page.cursor });
      assert.equal(page.page.nextCursor, page.cursor);
      assert.equal(page.page.hasMore, page.cursor !== null);
      found.push(...page.nodes.map((node) => node.id));
    }
    assert.deepEqual(found.sort(), ['n-desc', 'n-note', 'n-tag', 'n-title', 'n-url']);
  });

  async function searchAs(
    accountId: string,
    subjectId: string,
    scopes: readonly string[],
    query = QUERY,
  ): Promise<NodesSearchResult> {
    const result = await callNodesSearchTool(ports, createMcpApplicationContext({
      principal: {
        kind: 'authenticated',
        principalId: accountId,
        clientId: `client-${accountId}`,
        credentialBindingId: `binding-${accountId}`,
        resourceAudience: 'https://known.test/mcp',
        securityEpoch: '1',
      },
      scopes,
      abortSignal: new AbortController().signal,
      budgets: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      correlationId: 'nodes-search',
      authorization: { accountSubjectId: subjectId },
    }), { query, limit: 100 });
    assert.equal(result.kind, 'complete', result.kind === 'rejected' ? result.safeMessage : result.kind);
    if (result.kind !== 'complete') throw new Error('unreachable');
    return result.structuredContent as NodesSearchResult;
  }
});

async function seedCorpus(isolated: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolated.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(`insert into accounts(id, subject_id, status, security_epoch) values
      ('account-owner','subject-owner','active',1),
      ('account-outsider','subject-outsider','active',1)`);
    await client.query(`insert into resource_id_ledger(resource_id, resource_type) values
      ('e3-col','collection'),('e3-root','node'),('e3-folder','node'),
      ('n-title','node'),('n-url','node'),('n-desc','node'),('n-tag','node'),('n-note','node'),
      ('a-note','annotation'),('n-separator','node'),('a-separator','annotation')`);
    await client.query(`insert into collections(id, owner_subject_id, title, summary, kind, visibility,
      allow_search_indexing, root_node_id, resource_revision, content_revision, policy_revision)
      values ('e3-col','subject-owner','Library','Library','bookmarks','private',true,
        'e3-root','r1','c1','p1')`);
    await client.query(`insert into nodes(id, collection_id, kind, is_root, title, visibility,
      resource_revision, children_revision)
      values ('e3-root','e3-col','folder',true,'Library','inherit','r1','ch1')`);
    await client.query(`insert into nodes(id, collection_id, parent_id, kind, is_root, title, visibility,
      position_token, resource_revision, children_revision)
      values ('e3-folder','e3-col','e3-root','folder',false,'Reading','inherit','p-folder','r1','ch1')`);
    await client.query(`insert into nodes(id, collection_id, parent_id, kind, title, url, description, tags,
      visibility, position_token, resource_revision, children_revision) values
      ('n-title','e3-col','e3-folder','bookmark','Zephyr Protocol','https://example.com/title',
        'plain','[]'::jsonb,'inherit','p-title','r1','ch1'),
      ('n-url','e3-col','e3-folder','bookmark','Plain link','https://example.com/zephyr-docs',
        'plain','[]'::jsonb,'inherit','p-url','r1','ch1'),
      ('n-desc','e3-col','e3-folder','bookmark','Notes','https://example.com/desc',
        'discusses zephyr handoff','[]'::jsonb,'inherit','p-desc','r1','ch1'),
      ('n-tag','e3-col','e3-folder','bookmark','Tagged','https://example.com/tag',
        'plain','["zephyr"]'::jsonb,'inherit','p-tag','r1','ch1'),
      ('n-note','e3-col','e3-folder','bookmark','Annotated','https://example.com/note',
        'plain','[]'::jsonb,'inherit','p-note','r1','ch1')`);
    await client.query(`insert into nodes(id, collection_id, parent_id, kind, visibility,
      position_token, resource_revision, children_revision) values ('n-separator','e3-col','e3-folder','separator','inherit','p-separator','r1','ch1')`);
    const note = 'remember the zephyr cutoff';
    const timestamp = '2026-10-07T00:00:00.000Z';
    const payload = {
      id: 'a-note',
      collectionId: 'e3-col',
      subject: { type: 'node', id: 'n-note' },
      creator: { id: 'https://known.test/profiles/owner', name: 'Owner' },
      type: 'note',
      format: 'plain',
      value: note,
      visibility: 'protected',
      revision: 'r1',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await client.query(`insert into annotations(id, collection_id, subject_type, subject_id,
      creator_principal_id, type, format, value_json, visibility, resource_revision,
      created_at, updated_at, payload_json)
      values ('a-note','e3-col','node','n-note','account-owner','note','plain',
        $1::jsonb,'protected','r1',$2,$2,$3::jsonb)`,
    [JSON.stringify(note), timestamp, JSON.stringify(payload)]);
    await client.query(`insert into collection_link_health(node_id, collection_id, status)
      values ('n-title','e3-col','broken')`);
    await client.query(`insert into annotations(id, collection_id, subject_type, subject_id,
      creator_principal_id, type, format, value_json, visibility, resource_revision,
      created_at, updated_at, payload_json)
      values ('a-separator','e3-col','node','n-separator','account-owner','note','plain',
        '"divider-hit"'::jsonb,'protected','r1',$1,$1,$2::jsonb)`,
    [timestamp, JSON.stringify({ ...payload, id: 'a-separator', subject: { type: 'node', id: 'n-separator' }, value: 'divider-hit' })]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
