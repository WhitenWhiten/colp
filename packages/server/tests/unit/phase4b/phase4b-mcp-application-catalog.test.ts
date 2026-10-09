/**
 * T-01 characterization: freeze the era-neutral MCP application catalog
 * (tool/resource descriptors and anonymous vs authenticated list branches)
 * against the current strict 2026-07-28 host, before facade extraction.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import ts from 'typescript';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  createMcpResourceTemplates,
  type Mcp20260728RequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_READ_TOOL_CATALOG,
  PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
  PHASE4B_MCP_READ_TOOL_NAMES,
  PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES,
  PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS,
  PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS,
  PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES,
  PHASE4B_MCP_CHANGES_PLAN_DESCRIPTION,
  canAccessPhase4bMcpReadTools,
  canAccessPhase4bMcpWriteTools,
  canCallPhase4bMcpWriteTool,
  collectionsGetDefinition,
  collectionsGetSnapshotDefinition,
  nodesGetDefinition,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpRequestContext,
  createPhase4bMcpResourceIdentity,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import { mcpEnv } from '../../support/phase4b-mcp-transport-scaffold.js';

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

const READ_SCOPES = Object.freeze(['mcp:read:public'] as const);
const WRITE_SCOPES = Object.freeze([
  'mcp:read:public',
  'nodes:write',
  'collections:create',
  'collections:write',
  'annotations:write',
  'access:write',
  'changes:commit',
  'changes:cancel',
] as const);

function meta(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
  });
}

function listContext(
  binding = AUTHENTICATED,
  scope: readonly string[] = READ_SCOPES,
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
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

function emptyCollectionProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new Error('unused');
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function emptySnapshotProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('unused');
    },
    async readPage() {
      throw new Error('unused');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}

function emptyNodeProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('unused');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });
    },
  });
}


function forbiddenImportSpecifiers(relativePath: string): string[] {
  const sourceText = readFileSync(resolve(import.meta.dirname, '../../../', relativePath), 'utf8');
  const source = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const module = node.moduleSpecifier;
      if (module !== undefined && ts.isStringLiteral(module)) specifiers.push(module.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers.filter((specifier) => (
    specifier === 'fastify'
    || specifier.startsWith('fastify/')
    || specifier === '@know-n/colp/mcp'
    || specifier.startsWith('@know-n/colp/mcp/')
    || specifier.startsWith('@modelcontextprotocol/')
  ));
}

function listedToolKeys(tool: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(tool).sort();
}

test('read Tool list freezes names, descriptions, schemas, scopes, and absent title/annotations', async () => {
  const surface = createPhase4bMcpReadToolAdapter({
    collectionProjection: emptyCollectionProjection(),
    snapshotProjection: emptySnapshotProjection(),
    nodeProjection: emptyNodeProjection(),
    serverUuid: SERVER_UUID,
  });
  const result = await surface.adapter.listTools(listContext(), {});
  const tools = result.tools as ReadonlyArray<Readonly<Record<string, unknown>>>;

  assert.deepEqual(PHASE4B_MCP_READ_TOOL_NAMES, ['collections.get', 'collections.get_snapshot', 'nodes.get']);
  assert.deepEqual(PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES, [
    'collections:read',
    'nodes:read',
    'snapshots:read',
  ]);
  assert.deepEqual(tools.map((tool) => tool.name), [...PHASE4B_MCP_READ_TOOL_NAMES]);
  assert.equal(tools[0]?.description, collectionsGetDefinition.description);
  assert.equal(tools[1]?.description, collectionsGetSnapshotDefinition.description);
  assert.equal(tools[2]?.description, nodesGetDefinition.description);
  for (const tool of tools) {
    assert.deepEqual(listedToolKeys(tool), ['description', 'inputSchema', 'name', 'outputSchema']);
    assert.equal('title' in tool, false);
    assert.equal('annotations' in tool, false);
    const inputSchema = tool.inputSchema as Readonly<Record<string, unknown>>;
    const outputSchema = tool.outputSchema as Readonly<Record<string, unknown>>;
    assert.equal(inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(outputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(inputSchema.additionalProperties, false);
    assert.equal(outputSchema.type, 'object');
    assert.equal(
      (inputSchema.properties as { collectionId?: { 'x-mcp-header'?: string } })
        .collectionId?.['x-mcp-header'],
      PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
    );
  }
  const getInput = tools[0]?.inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const snapshotInput = tools[1]?.inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  const nodesGetInput = tools[2]?.inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.deepEqual(getInput.required, ['collectionId']);
  assert.deepEqual(Object.keys(getInput.properties ?? {}), ['collectionId']);
  assert.deepEqual(snapshotInput.required, ['collectionId']);
  assert.deepEqual(Object.keys(snapshotInput.properties ?? {}).sort(), ['collectionId', 'cursor']);
  assert.deepEqual(nodesGetInput.required, ['collectionId', 'nodeId']);
  assert.deepEqual(Object.keys(nodesGetInput.properties ?? {}).sort(), ['collectionId', 'nodeId']);
  const getOutput = tools[0]?.outputSchema as { readonly required?: readonly string[] };
  const snapshotOutput = tools[1]?.outputSchema as { readonly required?: readonly string[] };
  const nodesGetOutput = tools[2]?.outputSchema as { readonly required?: readonly string[] };
  assert.equal(getOutput.required, undefined);
  assert.equal(snapshotOutput.required, undefined);
  assert.equal(nodesGetOutput.required, undefined);
});

test('write Tool list freezes mounted names, descriptions, schemas, scopes, and header annotations', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const result = await fixture.bundle.adapter.listTools(listContext(AUTHENTICATED, WRITE_SCOPES), {});
  const tools = result.tools as ReadonlyArray<Readonly<Record<string, unknown>>>;
  const byName = new Map(tools.map((tool) => [String(tool.name), tool]));

  assert.deepEqual(PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES, [
    'collections.create',
    'collections.update',
    'nodes.create',
    'nodes.move',
    'nodes.delete_subtree',
    'nodes.update',
    'annotations.create',
    'annotations.update',
    'changes.plan',
    'changes.commit',
    'changes.cancel',
    'changes.get',
  ]);
  assert.deepEqual(PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES, {
    'collections.create': ['collections:create'],
    'collections.update': ['collections:write'],
    'nodes.create': ['nodes:write'],
    'nodes.move': ['nodes:write'],
    'nodes.delete_subtree': ['nodes:write'],
    'nodes.update': ['nodes:write'],
    'annotations.create': ['annotations:write'],
    'annotations.update': ['annotations:write'],
    'changes.plan': ['nodes:write', 'access:write'],
    'changes.commit': ['nodes:write', 'access:write', 'changes:commit'],
    'changes.cancel': ['changes:cancel'],
    'changes.get': ['nodes:write'],
  });
  assert.deepEqual(
    tools.map((tool) => String(tool.name)).sort(),
    [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort(),
  );
  assert.equal(byName.has('nodes.set_visibility'), false);
  assert.equal(byName.get('nodes.create')?.description, 'Write tool nodes.create');
  assert.equal(
    byName.get('changes.plan')?.description,
    PHASE4B_MCP_CHANGES_PLAN_DESCRIPTION,
  );
  assert.equal(
    byName.get('changes.commit')?.description,
    'Commit an approved Change Plan. Revalidates binding, digest, revisions, scope, and impact.',
  );
  assert.equal(
    byName.get('changes.cancel')?.description,
    'Cancel a pending Change Plan bound to the current Subject / Client / Session.',
  );
  for (const name of PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES) {
    const tool = byName.get(name);
    assert.ok(tool, name);
    assert.deepEqual(listedToolKeys(tool!), ['description', 'inputSchema', 'name', 'outputSchema']);
    assert.equal('title' in tool!, false);
    assert.equal('annotations' in tool!, false);
    const inputSchema = tool!.inputSchema as Readonly<Record<string, unknown>>;
    const outputSchema = tool!.outputSchema as Readonly<Record<string, unknown>>;
    assert.equal(typeof inputSchema, 'object');
    assert.equal(typeof outputSchema, 'object');
    assert.equal(inputSchema.additionalProperties, false);
  }
  const createInput = byName.get('nodes.create')?.inputSchema as {
    readonly required?: readonly string[];
    readonly oneOf?: readonly Readonly<Record<string, unknown>>[];
    readonly properties?: {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
      readonly node?: {
        readonly required?: readonly string[];
        readonly oneOf?: readonly {
          readonly required?: readonly string[];
          readonly properties?: {
            readonly kind?: { readonly const?: string };
            readonly url?: unknown;
          };
        }[];
      };
      readonly dryRun?: unknown;
      readonly confirmApply?: { readonly description?: string };
    };
  };
  assert.deepEqual(
    [...(createInput.required ?? [])].sort(),
    ['collectionId', 'node'],
  );
  assert.equal(createInput.oneOf, undefined);
  assert.equal(createInput.properties?.dryRun !== undefined, true);
  assert.equal(createInput.properties?.confirmApply !== undefined, true);
  assert.match(
    createInput.properties?.confirmApply?.description ?? '',
    /false to preview without writing/u,
  );
  assert.equal(createInput.properties?.collectionId?.['x-mcp-header'], PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER);
  assert.equal(createInput.properties?.node?.required, undefined);
  assert.equal(createInput.properties?.node?.oneOf?.length, 2);
  const folderNode = createInput.properties?.node?.oneOf?.find(
    (branch) => branch.properties?.kind?.const === 'folder',
  );
  const bookmarkNode = createInput.properties?.node?.oneOf?.find(
    (branch) => branch.properties?.kind?.const === 'bookmark',
  );
  assert.ok(folderNode, 'nodes.create node schema must include a folder branch');
  assert.ok(bookmarkNode, 'nodes.create node schema must include a bookmark branch');
  assert.deepEqual(
    [...(folderNode.required ?? [])].sort(),
    [...PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS].sort(),
  );
  assert.deepEqual(
    [...(bookmarkNode.required ?? [])].sort(),
    [...PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS].sort(),
  );
  assert.equal(Object.hasOwn(folderNode.properties ?? {}, 'url'), false);
  assert.equal(Object.hasOwn(bookmarkNode.properties ?? {}, 'url'), true);
  const planInput = byName.get('changes.plan')?.inputSchema as {
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.deepEqual(planInput.required, ['operations', 'reason', 'dryRun']);
  const commitInput = byName.get('changes.commit')?.inputSchema as { readonly required?: readonly string[] };
  assert.deepEqual(commitInput.required, ['planId', 'idempotencyKey']);
  const cancelInput = byName.get('changes.cancel')?.inputSchema as { readonly required?: readonly string[] };
  assert.deepEqual(cancelInput.required, ['planId']);
  const changeGetInput = byName.get('changes.get')?.inputSchema as {
    readonly additionalProperties?: boolean;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  assert.equal(changeGetInput.additionalProperties, false);
  assert.deepEqual(changeGetInput.required, ['planId']);
  assert.deepEqual(Object.keys(changeGetInput.properties ?? {}), ['planId']);
  assert.equal(JSON.stringify(changeGetInput).includes('x-mcp-header'), false);
  assert.equal(byName.get('changes.get')?.description, 'Write tool changes.get');
  const nodesUpdateInput = byName.get('nodes.update')?.inputSchema as {
    readonly additionalProperties?: boolean;
    readonly required?: readonly string[];
    readonly properties?: {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
      readonly patch?: {
        readonly additionalProperties?: boolean;
        readonly properties?: Readonly<Record<string, unknown>>;
      };
    };
  };
  assert.equal(nodesUpdateInput.additionalProperties, false);
  assert.deepEqual(
    [...(nodesUpdateInput.required ?? [])].sort(),
    ['collectionId', 'nodeId', 'patch'],
  );
  assert.equal(
    nodesUpdateInput.properties?.collectionId?.['x-mcp-header'],
    PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  );
  assert.equal(nodesUpdateInput.properties?.patch?.additionalProperties, false);
  assert.deepEqual(
    Object.keys(nodesUpdateInput.properties?.patch?.properties ?? {}),
    ['title', 'url', 'description', 'tags'],
  );
  const collectionsUpdateInput = byName.get('collections.update')?.inputSchema as {
    readonly additionalProperties?: boolean;
    readonly required?: readonly string[];
    readonly properties?: {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
      readonly patch?: {
        readonly additionalProperties?: boolean;
        readonly properties?: Readonly<Record<string, unknown>>;
      };
    };
  };
  assert.equal(collectionsUpdateInput.additionalProperties, false);
  assert.deepEqual(
    [...(collectionsUpdateInput.required ?? [])].sort(),
    ['collectionId', 'patch'],
  );
  assert.equal(
    collectionsUpdateInput.properties?.collectionId?.['x-mcp-header'],
    PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  );
  assert.equal(collectionsUpdateInput.properties?.patch?.additionalProperties, false);
  assert.deepEqual(
    Object.keys(collectionsUpdateInput.properties?.patch?.properties ?? {}).sort(),
    ['summary', 'title'],
  );
  const annotationsCreateInput = byName.get('annotations.create')?.inputSchema as {
    readonly additionalProperties?: boolean;
    readonly required?: readonly string[];
    readonly properties?: {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
      readonly type?: { readonly enum?: readonly string[] };
      readonly visibility?: { readonly enum?: readonly string[] };
    };
  };
  assert.equal(annotationsCreateInput.additionalProperties, false);
  assert.deepEqual(
    [...(annotationsCreateInput.required ?? [])].sort(),
    ['collectionId', 'nodeId', 'value'],
  );
  assert.equal(
    annotationsCreateInput.properties?.collectionId?.['x-mcp-header'],
    PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  );
  assert.deepEqual(annotationsCreateInput.properties?.type?.enum, ['note', 'tldr', 'summary']);
  assert.deepEqual(annotationsCreateInput.properties?.visibility?.enum, ['private', 'protected']);
  const annotationsUpdateInput = byName.get('annotations.update')?.inputSchema as {
    readonly additionalProperties?: boolean;
    readonly required?: readonly string[];
    readonly properties?: {
      readonly collectionId?: { readonly 'x-mcp-header'?: string };
      readonly patch?: {
        readonly additionalProperties?: boolean;
        readonly properties?: Readonly<Record<string, unknown>>;
      };
    };
  };
  assert.equal(annotationsUpdateInput.additionalProperties, false);
  assert.deepEqual(
    [...(annotationsUpdateInput.required ?? [])].sort(),
    ['annotationId', 'collectionId', 'patch'],
  );
  assert.equal(
    annotationsUpdateInput.properties?.collectionId?.['x-mcp-header'],
    PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  );
  assert.equal(annotationsUpdateInput.properties?.patch?.additionalProperties, false);
  assert.deepEqual(
    Object.keys(annotationsUpdateInput.properties?.patch?.properties ?? {}).sort(),
    ['format', 'value', 'visibility'],
  );
});

test('strict list/templates resource descriptors stay the COLP two-template set plus collection MIME types', () => {
  const config = loadConfig(mcpEnv()).mcp!;
  const identity = createPhase4bMcpResourceIdentity(config);
  const expected = createMcpResourceTemplates({ serverUuid: SERVER_UUID });
  assert.deepEqual(identity.templates, expected);
  assert.deepEqual(identity.templates, [
    {
      uriTemplate: `colp://${SERVER_UUID}/collections/{collectionId}`,
      name: 'collection',
      title: 'Collection metadata',
      mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
    },
    {
      uriTemplate: `colp://${SERVER_UUID}/collections/{collectionId}/nodes/{nodeId}`,
      name: 'collection-node',
      title: 'Collection node',
      mimeType: PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
    },
  ]);
  for (const template of identity.templates) {
    assert.equal('description' in template, false);
    assert.equal('annotations' in template, false);
  }
  assert.equal(PHASE4B_MCP_SNAPSHOT_RESOURCE_MIME_TYPE, 'application/vnd.collection-protocol.snapshot+json');
  assert.equal(
    identity.collectionSnapshot('collection-1'),
    `colp://${SERVER_UUID}/collections/collection-1/snapshot`,
  );
});

test('anonymous vs authenticated list/call branches stay scope-gated without weakening', () => {
  assert.equal(canAccessPhase4bMcpReadTools(listContext(ANONYMOUS, [])), true);
  assert.equal(canAccessPhase4bMcpWriteTools(listContext(ANONYMOUS, [])), false);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(ANONYMOUS, []), 'nodes.create'), false);
  assert.equal(canAccessPhase4bMcpReadTools(listContext(AUTHENTICATED, [])), false);
  assert.equal(canAccessPhase4bMcpWriteTools(listContext(AUTHENTICATED, [])), false);
  assert.equal(canAccessPhase4bMcpReadTools(listContext(AUTHENTICATED, READ_SCOPES)), true);
  assert.equal(canAccessPhase4bMcpWriteTools(listContext(AUTHENTICATED, READ_SCOPES)), false);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, READ_SCOPES), 'nodes.create'), false);
  assert.equal(canAccessPhase4bMcpReadTools(listContext(AUTHENTICATED, WRITE_SCOPES)), true);
  assert.equal(canAccessPhase4bMcpWriteTools(listContext(AUTHENTICATED, WRITE_SCOPES)), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'collections.create'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'collections.update'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'nodes.create'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'nodes.update'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'annotations.create'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'annotations.update'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'changes.plan'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'changes.commit'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'changes.cancel'), true);
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'changes.get'), true);
  assert.equal(
    canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, ['nodes:write']), 'changes.get'),
    true,
  );
  assert.equal(
    canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, ['nodes:write']), 'changes.plan'),
    false,
  );
  assert.equal(canCallPhase4bMcpWriteTool(listContext(AUTHENTICATED, WRITE_SCOPES), 'nodes.set_visibility'), false);
});

test('read catalog descriptors reuse the frozen read-tool schema objects', () => {
  assert.equal(PHASE4B_MCP_READ_TOOL_CATALOG[0]?.inputSchema, collectionsGetDefinition.inputSchema);
  assert.equal(PHASE4B_MCP_READ_TOOL_CATALOG[0]?.outputSchema, collectionsGetDefinition.outputSchema);
  assert.equal(PHASE4B_MCP_READ_TOOL_CATALOG[1]?.inputSchema, collectionsGetSnapshotDefinition.inputSchema);
  assert.equal(PHASE4B_MCP_READ_TOOL_CATALOG[1]?.outputSchema, collectionsGetSnapshotDefinition.outputSchema);
  assert.equal(PHASE4B_MCP_READ_TOOL_CATALOG[2]?.inputSchema, nodesGetDefinition.inputSchema);
  assert.equal(PHASE4B_MCP_READ_TOOL_CATALOG[2]?.outputSchema, nodesGetDefinition.outputSchema);
});


test('application interface files do not import COLP MCP, Fastify, or official SDK wire types', () => {
  const files = [
    'src/modules/mcp/application-context.ts',
    'src/modules/mcp/application-catalog.ts',
    'src/modules/mcp/application-results.ts',
    'src/modules/mcp/application-ports.ts',
    'src/modules/mcp/application-facade.ts',
  ];
  for (const relativePath of files) {
    assert.deepEqual(forbiddenImportSpecifiers(relativePath), [], relativePath);
  }
});

test('application catalog does not ship a parallel nodes.create descriptor', async () => {
  const catalog = await import('../../../src/modules/mcp/application-catalog.js');
  assert.equal('PHASE4B_MCP_NODES_CREATE_TOOL_CATALOG' in catalog, false);
});
