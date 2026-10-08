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
  type NodesSearchPorts,
  type NodesSearchResult,
} from '../../../src/modules/mcp/nodes-search.js';
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

    const notesHidden = await searchAs('account-owner', 'subject-owner', ['nodes:read']);
    assert.deepEqual(notesHidden.nodes.map((node) => node.id).sort(), [
      'n-desc', 'n-tag', 'n-title', 'n-url',
    ]);

    const denied = await searchAs('account-outsider', 'subject-outsider', ['nodes:read', 'annotations:read']);
    assert.deepEqual(denied.nodes, []);
  }, 60_000);

  async function searchAs(
    accountId: string,
    subjectId: string,
    scopes: readonly string[],
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
    }), { query: QUERY, limit: 100 });
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
      ('a-note','annotation')`);
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
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
