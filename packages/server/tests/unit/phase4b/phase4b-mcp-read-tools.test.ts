import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpReadRequestAbortedError,
  McpResourceNotFoundError,
  McpSchemaBudgetError,
  McpToolOutputUnavailableError,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  createMcp20260728ReadToolAdapter,
  createMcpStatelessToolCore,
  type Mcp20260728RequestContext,
  type McpToolDefinition,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  canAccessPhase4bMcpReadTools,
  collectionsGetDefinition,
  collectionsGetSnapshotDefinition,
  nodesGetDefinition,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpRequestContext,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';

const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const ANONYMOUS = createAnonymousPublicBinding({
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});
const AUTHENTICATED = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});

function meta(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
  });
}

function callContext(
  name: string,
  args: Readonly<Record<string, unknown>>,
  binding = AUTHENTICATED,
  scope: readonly string[] = ['mcp:read:public'],
  authorization: Readonly<Record<string, unknown>> = Object.freeze({}),
): Mcp20260728RequestContext {
  const headers: Array<{ readonly name: string; readonly value: string }> = [
    Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
    Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
    Object.freeze({ name: 'Mcp-Name', value: name }),
    Object.freeze({ name: `Mcp-Param-${PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER}`, value: String(args.collectionId) }),
  ];
  return createPhase4bMcpRequestContext({
    headers,
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: meta(),
        name,
        arguments: args,
      }),
    }),
    binding,
    scope,
    authorization,
    paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  });
}

function listContext(
  binding = AUTHENTICATED,
  scope: readonly string[] = ['mcp:read:public'],
): Mcp20260728RequestContext {
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
    scope,
    authorization: Object.freeze({}),
  });
}

function collectionProjection(overrides: {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reject?: ReadonlySet<string>;
} = {}): Phase4bMcpCollectionResourceProjection {
  const metadata = overrides.metadata ?? Object.freeze({
    collection: Object.freeze({
      id: 'collection-1',
      title: 'Public <script>alert(1)</script>',
      visibility: 'public',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }),
  });
  const reject = overrides.reject ?? new Set<string>();
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource(input) {
      if (reject.has(input.resource.collectionId)) throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.collection+json',
            text: JSON.stringify(metadata),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function snapshotProjection(overrides: {
  readonly large?: boolean;
  readonly reject?: ReadonlySet<string>;
} = {}): Phase4bMcpSnapshotResourceProjection {
  const reject = overrides.reject ?? new Set<string>();
  const large = overrides.large === true;
  const collection = Object.freeze({
    id: 'collection-1',
    title: 'Snapshot 1',
    visibility: 'public',
    updatedAt: '2026-08-05T00:00:00.000Z',
  });
  const body = large
    ? Object.freeze({
        type: 'collection_snapshot_summary',
        complete: false,
        bounded: true,
        reason: 'continuation_available',
        resourceLink: Object.freeze({
          type: 'resource_link',
          uri: `colp://${SERVER_UUID}/collections/collection-1/snapshot`,
          name: 'Collection snapshot',
          mimeType: 'application/vnd.collection-protocol.snapshot+json',
        }),
        collection,
        page: Object.freeze({ sequence: 0, hasMore: true, nextCursor: 'cursor-page-2', complete: false }),
        continuation: Object.freeze({ cursor: 'cursor-page-2', sequence: 1 }),
      })
    : Object.freeze({
        complete: true,
        collection,
        revision: 'content-1.policy-1',
      });
  return Object.freeze({
    async readResource(input) {
      if (reject.has(input.resource.collectionId)) throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.snapshot+json',
            text: JSON.stringify(body),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async readPage(input) {
      if (reject.has(input.resource.collectionId)) throw new McpResourceNotFoundError();
      if (input.pageCursor !== 'cursor-page-2') throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.snapshot+json',
            text: JSON.stringify(Object.freeze({
              complete: true,
              collection,
              revision: 'content-1.policy-1',
              page: Object.freeze({ sequence: 1, hasMore: false, nextCursor: null, complete: true }),
            })),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function nodeProjection(overrides: {
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly reject?: boolean;
} = {}): Phase4bMcpNodeResourceProjection {
  const payload = overrides.payload ?? Object.freeze({
    id: 'node-1',
    collectionId: 'collection-1',
    kind: 'bookmark',
    title: 'Example node',
    revision: 'content-1',
  });
  return Object.freeze({
    async readResource() {
      if (overrides.reject === true) throw new McpResourceNotFoundError();
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.node+json',
            text: JSON.stringify(payload),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

test('the host Tool surface lists three deterministic read-only Tools with 2020-12 schemas', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const result = await surface.adapter.listTools(listContext(), {});
  const tools = result.tools as ReadonlyArray<Readonly<Record<string, unknown>>>;

  assert.equal(result.resultType, 'complete');
  assert.equal(result.ttlMs, 0);
  assert.equal(result.cacheScope, 'private');
  assert.deepEqual(tools.map((tool) => tool.name), ['collections.get', 'collections.get_snapshot', 'nodes.get']);
  assert.equal(tools[0]?.description, collectionsGetDefinition.description);
  assert.equal(tools[1]?.description, collectionsGetSnapshotDefinition.description);
  assert.equal(tools[2]?.description, nodesGetDefinition.description);
  for (const tool of tools) {
    const inputSchema = tool.inputSchema as Readonly<Record<string, unknown>>;
    const outputSchema = tool.outputSchema as Readonly<Record<string, unknown>>;
    assert.equal(inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(outputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(typeof tool.description, 'string');
    assert.equal('title' in tool, false);
    assert.equal('annotations' in tool, false);
  }
  assert.equal(
    (tools[0]?.inputSchema as { properties?: { collectionId?: { 'x-mcp-header'?: string } } })
      .properties?.collectionId?.['x-mcp-header'],
    PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  );
  assert.deepEqual(PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS, [
    Object.freeze({ path: Object.freeze(['collectionId']), headerName: 'X-Collection-Id', type: 'string' }),
  ]);
  assert.deepEqual(
    tools.map((tool) => String(tool.name)),
    ['collections.get', 'collections.get_snapshot', 'nodes.get'],
  );
  const nodesGetInput = tools[2]?.inputSchema as {
    readonly additionalProperties?: unknown;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const nodesGetOutput = tools[2]?.outputSchema as {
    readonly required?: readonly string[];
  };
  assert.equal(nodesGetInput.additionalProperties, false);
  assert.deepEqual(nodesGetInput.required, ['collectionId', 'nodeId']);
  assert.deepEqual(Object.keys(nodesGetInput.properties ?? {}).sort(), ['collectionId', 'nodeId']);
  assert.equal(
    (nodesGetInput.properties?.collectionId as { readonly 'x-mcp-header'?: string } | undefined)
      ?.['x-mcp-header'],
    PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  );
  assert.equal(
    'x-mcp-header' in ((nodesGetInput.properties?.nodeId as object | undefined) ?? {}),
    false,
  );
  assert.equal(nodesGetOutput.type, 'object');
  assert.equal(
    tools.some((tool) => /write|plan|commit|feed|sync|audit|search/iu.test(String(tool.name))),
    false,
  );
});

test('collections.get returns R08 structured content and never trusts dynamic description text', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const context = callContext('collections.get', Object.freeze({ collectionId: 'collection-1' }));
  const result = await surface.adapter.callTool(context, {
    name: 'collections.get',
    arguments: Object.freeze({ collectionId: 'collection-1' }),
  });
  const content = result.structuredContent as {
    readonly collection?: { readonly title?: string; readonly visibility?: string };
  };
  assert.equal(content.collection?.visibility, 'public');
  assert.match(String(content.collection?.title), /<script>/u);
  const text = (result.content as ReadonlyArray<{ readonly type?: string; readonly text?: string }>)[0];
  assert.equal(text?.type, 'text');
  assert.equal(JSON.parse(text?.text ?? '{}').collection.visibility, 'public');
  const listed = await surface.adapter.listTools(listContext(), {});
  const collectionTool = (listed.tools as ReadonlyArray<{ readonly description: string }>)[0]!;
  assert.doesNotMatch(collectionTool.description, /<script>|alert\(1\)/u);
});

test('public-only authenticated Tool calls use the anonymous Publication projection', async () => {
  const seenBindings: string[] = [];
  const projection = Object.freeze({
    ...collectionProjection(),
    async readResource(_input: unknown, context: { readonly binding: { readonly kind: string } }) {
      seenBindings.push(context.binding.kind);
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            mimeType: 'application/vnd.collection-protocol.collection+json',
            text: JSON.stringify(Object.freeze({
              collection: Object.freeze({
                id: 'public-collection',
                title: 'Public collection',
                visibility: 'public',
                updatedAt: '2026-08-05T00:00:00.000Z',
              }),
            })),
            provenance: Object.freeze({ origin: 'internal' }),
          }),
        ]),
      });
    },
  }) as Phase4bMcpCollectionResourceProjection;
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: projection,
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const args = Object.freeze({ collectionId: 'public-collection' });
  await surface.adapter.callTool(
    callContext('collections.get', args, AUTHENTICATED, ['mcp:read:public']),
    { name: 'collections.get', arguments: args },
  );
  await surface.adapter.callTool(
    callContext('collections.get', args, AUTHENTICATED, ['mcp:read:own']),
    { name: 'collections.get', arguments: args },
  );
  assert.deepEqual(seenBindings, ['anonymous', 'authenticated']);
});

test('collections.get_snapshot returns a bounded COLP Resource Link result', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection({ large: true }),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const context = callContext('collections.get_snapshot', Object.freeze({ collectionId: 'collection-1' }));
  const result = await surface.adapter.callTool(context, {
    name: 'collections.get_snapshot',
    arguments: Object.freeze({ collectionId: 'collection-1' }),
  });
  const blocks = result.content as ReadonlyArray<Readonly<Record<string, unknown>>>;
  assert.equal(blocks[0]?.type, 'text');
  assert.equal(JSON.parse(String(blocks[0]?.text)).collection.title, 'Snapshot 1');
  const link = blocks[1]!;
  assert.equal(link.type, 'resource_link');
  assert.equal(link.uri, `colp://${SERVER_UUID}/collections/collection-1/snapshot`);
  assert.equal(link.mimeType, 'application/vnd.collection-protocol.snapshot+json');
  assert.equal(
    (link.annotations as { readonly lastModified?: string }).lastModified,
    '2026-08-05T00:00:00.000Z',
  );
  const firstPage = result.structuredContent as Readonly<Record<string, unknown>>;
  assert.equal((firstPage.continuation as Readonly<Record<string, unknown>>).cursor, 'cursor-page-2');

  const continuation = await surface.adapter.callTool(
    callContext('collections.get_snapshot', Object.freeze({
      collectionId: 'collection-1',
      cursor: 'cursor-page-2',
    })),
    {
      name: 'collections.get_snapshot',
      arguments: Object.freeze({ collectionId: 'collection-1', cursor: 'cursor-page-2' }),
    },
  );
  const secondPage = continuation.structuredContent as Readonly<Record<string, unknown>>;
  assert.equal(secondPage.complete, true);
  assert.deepEqual(secondPage.page, {
    sequence: 1,
    hasMore: false,
    nextCursor: null,
    complete: true,
  });
});

test('private targets and unknown Tools fail without leaking the target', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection({ reject: new Set(['private-collection']) }),
    snapshotProjection: snapshotProjection({ reject: new Set(['private-collection']) }),
    nodeProjection: nodeProjection({ reject: true }),
    serverUuid: SERVER_UUID,
  });
  const context = callContext('collections.get', Object.freeze({ collectionId: 'private-collection' }));
  await assert.rejects(
    () => surface.adapter.callTool(context, {
      name: 'collections.get',
      arguments: Object.freeze({ collectionId: 'private-collection' }),
    }),
    McpToolOutputUnavailableError,
  );

  const unknownContext = callContext('collections.unknown', Object.freeze({ collectionId: 'collection-1' }));
  await assert.rejects(
    () => surface.adapter.callTool(unknownContext, {
      name: 'collections.unknown',
      arguments: Object.freeze({ collectionId: 'collection-1' }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-collection/u);
      return true;
    },
  );
});

test('nodes.get returns JSON text content plus structuredContent including revision', async () => {
  const payload = Object.freeze({
    id: 'node-1',
    collectionId: 'collection-1',
    kind: 'bookmark',
    title: 'Example node',
    revision: 'content-1',
    url: 'https://example.test/node',
  });
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection({ payload }),
    serverUuid: SERVER_UUID,
  });
  const args = Object.freeze({ collectionId: 'collection-1', nodeId: 'node-1' });
  const result = await surface.adapter.callTool(
    callContext('nodes.get', args),
    { name: 'nodes.get', arguments: args },
  );
  const structured = result.structuredContent as Readonly<Record<string, unknown>>;
  const text = (result.content as ReadonlyArray<{ readonly type?: string; readonly text?: string }>)[0];
  assert.equal(text?.type, 'text');
  assert.deepEqual(JSON.parse(text?.text ?? '{}'), structured);
  assert.equal(structured.revision, 'content-1');
  assert.equal(structured.id, 'node-1');
  assert.equal(structured.collectionId, 'collection-1');
  assert.equal(structured.kind, 'bookmark');
});

test('nodes.get conceals missing and private targets the same way as collections.get', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection({ reject: true }),
    serverUuid: SERVER_UUID,
  });
  const args = Object.freeze({ collectionId: 'private-collection', nodeId: 'private-node' });
  await assert.rejects(
    () => surface.adapter.callTool(
      callContext('nodes.get', args),
      { name: 'nodes.get', arguments: args },
    ),
    McpToolOutputUnavailableError,
  );
});

test('scope-aware discovery allows anonymous public read and authenticated read scopes', () => {
  assert.equal(canAccessPhase4bMcpReadTools(listContext(ANONYMOUS, [])), true);
  assert.equal(canAccessPhase4bMcpReadTools(listContext(AUTHENTICATED, [])), false);
  for (const scope of [
    ['mcp:read:public'],
    ['mcp:read:own'],
    ['mcp:read:public', 'access:write'],
  ] as const) {
    assert.equal(canAccessPhase4bMcpReadTools(listContext(AUTHENTICATED, scope)), true);
  }
  for (const scope of [
    ['collections:read'],
    ['nodes:read'],
    ['snapshots:read'],
    ['mcp:read:'],
    ['access:write'],
    ['nodes:write'],
    ['changes:plan'],
    ['changes:commit'],
    ['changes:cancel'],
    ['access:write', 'nodes:write', 'changes:commit'],
    ['mcp:read'],
  ] as const) {
    assert.equal(canAccessPhase4bMcpReadTools(listContext(AUTHENTICATED, scope)), false);
  }
});

test('core Read Tool discovery hides the surface from unrelated scopes', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection(),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const listed = await surface.adapter.listTools(
    listContext(AUTHENTICATED, ['nodes:read']),
    {},
  );
  assert.deepEqual(listed.tools, []);
});


test('arbitrary structured JSON is passed through the stateless Tool core', async () => {
  const definition: McpToolDefinition = Object.freeze({
    name: 'custom.echo',
    description: 'Echo structured data.',
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({}),
    }),
  });
  const structuredContent = Object.freeze({
    values: Object.freeze([1, true, null, 'x', Object.freeze({ nested: Object.freeze([2]) })]),
  });
  const core = createMcpStatelessToolCore({
    tools: [Object.freeze({
      definition,
      invoke: async () => Object.freeze({ structuredContent }),
    })],
  });
  const adapter = createMcp20260728ReadToolAdapter({
    toolCore: core,
    serverInfo: Object.freeze({ name: 'structured-test', version: '0.0.0' }),
  });
  const context = createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'custom.echo' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({ _meta: meta(), name: 'custom.echo', arguments: Object.freeze({}) }),
    }),
    binding: AUTHENTICATED,
    scope: ['mcp:read:public'],
    authorization: Object.freeze({}),
  });
  const result = await adapter.callTool(context, { name: 'custom.echo', arguments: {} });
  assert.deepEqual(result.structuredContent, structuredContent);
});

test('output budget failures are bounded and aborts fail before projection', async () => {
  const hugeMetadata = Object.freeze({
    collection: Object.freeze({
      id: 'collection-1',
      title: 'Large',
      visibility: 'public',
      items: Array.from({ length: DEFAULT_MCP_RESOURCE_READ_BUDGET.maxNodes + 1 }, () => 'x'),
    }),
  });
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: collectionProjection({ metadata: hugeMetadata }),
    snapshotProjection: snapshotProjection(),
    nodeProjection: nodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const context = callContext('collections.get', Object.freeze({ collectionId: 'collection-1' }));
  await assert.rejects(
    () => surface.adapter.callTool(context, {
      name: 'collections.get',
      arguments: Object.freeze({ collectionId: 'collection-1' }),
    }),
    McpToolOutputUnavailableError,
  );

  const controller = new AbortController();
  controller.abort();
  const abortedContext = createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'collections.get' }),
      Object.freeze({ name: 'Mcp-Param-X-Collection-Id', value: 'collection-1' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: meta(),
        name: 'collections.get',
        arguments: Object.freeze({ collectionId: 'collection-1' }),
      }),
    }),
    binding: AUTHENTICATED,
    scope: ['mcp:read:public'],
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    abortSignal: controller.signal,
    authorization: Object.freeze({}),
    paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  });
  await assert.rejects(
    () => surface.adapter.callTool(abortedContext, {
      name: 'collections.get',
      arguments: Object.freeze({ collectionId: 'collection-1' }),
    }),
    McpReadRequestAbortedError,
  );
});
