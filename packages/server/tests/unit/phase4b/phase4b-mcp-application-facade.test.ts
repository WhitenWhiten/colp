/**
 * T-01 / MCP-CQ-08: era-neutral facade methods.
 * Neutral tests construct {@link createMcpApplicationContext} only — no wire
 * headers or `_meta`. COLP wrap mapping lives on the strict adapter.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import ts from 'typescript';
import { DEFAULT_MCP_RESOURCE_READ_BUDGET, type Mcp20260728WriteToolAdapter } from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_READ_TOOL_CATALOG,
  PHASE4B_MCP_READ_TOOL_NAMES,
  createMcpApplicationContext,
  createPhase4bMcpApplicationFacade,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpResourceIdentity,
  type McpApplicationContext,
  type McpApplicationWritePort,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../../src/modules/mcp/index.js';
import { mcpEnv } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  createPhase4bMcpApplicationFacadeFromColpAdapters,
  toNeutralReadPort,
  toNeutralWritePort,
} from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';

const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const COLLECTION_URI = `colp://${SERVER_UUID}/collections/collection-1`;
const COLLECTION_JSON = JSON.stringify({ id: 'collection-1', title: 'Demo' });
const COLLECTION_BLOB = 'YmxvYg==';

const ANONYMOUS_PRINCIPAL = Object.freeze({
  kind: 'anonymous' as const,
  principalId: 'public' as const,
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});
const AUTHENTICATED_PRINCIPAL = Object.freeze({
  kind: 'authenticated' as const,
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: AUDIENCE,
  securityEpoch: 'epoch-1',
});
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

function listingProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({
        resources: Object.freeze([
          Object.freeze({
            uri: COLLECTION_URI,
            name: 'Demo',
            mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
            description: 'A collection',
            provenance: Object.freeze({ origin: 'internal' as const }),
            _meta: Object.freeze({
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              nodeCount: 3,
              updatedAt: '2026-08-28T00:00:00.000Z',
            }),
          }),
        ]),
      });
    },
    async readResource() {
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            uri: COLLECTION_URI,
            mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
            text: COLLECTION_JSON,
            blob: COLLECTION_BLOB,
            provenance: Object.freeze({ origin: 'internal' as const }),
          }),
        ]),
      }) as Awaited<ReturnType<Phase4bMcpCollectionResourceProjection['readResource']>>;
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

function createFacade(writeAdapter?: Mcp20260728WriteToolAdapter) {
  const config = loadConfig(mcpEnv()).mcp!;
  const collectionProjection = listingProjection();
  const snapshotProjection = emptySnapshotProjection();
  const nodeProjection = emptyNodeProjection();
  const readSurface = createPhase4bMcpReadToolAdapter({
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    serverUuid: SERVER_UUID,
  });
  return createPhase4bMcpApplicationFacadeFromColpAdapters({
    resourceIdentity: createPhase4bMcpResourceIdentity(config),
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    readToolAdapter: readSurface.adapter,
    ...(writeAdapter === undefined ? {} : { writeToolAdapter: writeAdapter }),
  });
}

function createFacadeWithWritePort(writePort: McpApplicationWritePort) {
  const config = loadConfig(mcpEnv()).mcp!;
  const collectionProjection = listingProjection();
  const snapshotProjection = emptySnapshotProjection();
  const nodeProjection = emptyNodeProjection();
  const readSurface = createPhase4bMcpReadToolAdapter({
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    serverUuid: SERVER_UUID,
  });
  return createPhase4bMcpApplicationFacade({
    resourceIdentity: createPhase4bMcpResourceIdentity(config),
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    readPort: toNeutralReadPort(readSurface.adapter),
    writePort,
  });
}

function appContext(
  principal: typeof ANONYMOUS_PRINCIPAL | typeof AUTHENTICATED_PRINCIPAL,
  scopes: readonly string[],
  authorization?: Readonly<Record<string, unknown>>,
): McpApplicationContext {
  return createMcpApplicationContext({
    principal,
    scopes,
    abortSignal: new AbortController().signal,
    budgets: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    correlationId: 'facade-test',
    ...(authorization === undefined ? {} : { authorization }),
  });
}

function writeAppContext(): McpApplicationContext {
  return appContext(
    AUTHENTICATED_PRINCIPAL,
    WRITE_SCOPES,
    Object.freeze({ accountSubjectId: AUTHENTICATED_PRINCIPAL.principalId }),
  );
}

function nodeCreateArgs(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: 'collection-1',
    parentId: 'root-1',
    node: Object.freeze({
      kind: 'bookmark',
      title: 'W06 bookmark',
      url: 'https://example.test/w06',
      description: null,
      tags: Object.freeze(['w06']),
      visibility: 'private',
    }),
    reason: 'create bookmark',
    confirmApply: true,
  });
}

function assertNoEraWireFields(value: object): void {
  assert.equal('_meta' in value, false);
  assert.equal('resultType' in value, false);
  for (const key of Object.keys(value)) {
    assert.equal(key.startsWith('io.modelcontextprotocol'), false, key);
  }
  const annotations = (value as { readonly annotations?: unknown }).annotations;
  if (typeof annotations !== 'object' || annotations === null) return;
  for (const key of Object.keys(annotations)) {
    assert.equal(key.startsWith('io.modelcontextprotocol'), false, key);
  }
}

const WRITE_ADAPTER_TRANSPORT = Object.freeze({
  enforceBeforeJsonParsing: true as const,
  maxRequestBodyBytes: 65_536,
});

function writeAdapter(
  callTool: Mcp20260728WriteToolAdapter['callTool'],
): Mcp20260728WriteToolAdapter {
  return Object.freeze({
    async listTools() {
      return Object.freeze({ resultType: 'complete' as const, tools: Object.freeze([]) });
    },
    callTool,
    async recordOutOfBandApproval() {},
    transportRequirements: WRITE_ADAPTER_TRANSPORT,
  });
}

function awaitingApprovalWriteAdapter(): Mcp20260728WriteToolAdapter {
  return writeAdapter(async () => Object.freeze({
    resultType: 'input_required' as const,
    plan: Object.freeze({
      planId: 'plan-1',
      approvalUri: 'https://example.test/approvals/plan-1',
      expiresAt: '2026-08-28T12:00:00.000Z',
    }),
  }));
}

function completeWriteAdapter(fields: {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}): Mcp20260728WriteToolAdapter {
  return writeAdapter(async () => Object.freeze({
    resultType: 'complete' as const,
    ...(fields.content === undefined ? {} : { content: fields.content }),
    ...(fields.structuredContent === undefined ? {} : { structuredContent: fields.structuredContent }),
    ...(typeof fields.isError === 'boolean' ? { isError: fields.isError } : {}),
  }));
}

function assertJsonTextContentMatchesStructured(result: {
  readonly kind: string;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}): void {
  assert.equal(result.kind, 'complete');
  const content = result.content as readonly { readonly type?: unknown; readonly text?: unknown }[] | undefined;
  assert.ok(Array.isArray(content) && content.length >= 1);
  assert.equal(content[0]?.type, 'text');
  assert.equal(typeof content[0]?.text, 'string');
  assert.deepEqual(JSON.parse(String(content[0]?.text)), result.structuredContent);
}

function awaitingApprovalWritePort(): McpApplicationWritePort {
  return Object.freeze({
    async listTools() {
      return Object.freeze([]);
    },
    async callTool() {
      return Object.freeze({
        kind: 'awaiting_approval' as const,
        planId: 'plan-1',
        approvalUri: 'https://example.test/approvals/plan-1',
        expiresAt: '2026-08-28T12:00:00.000Z',
        bindingSummary: 'authenticated',
      });
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

test('listResources returns era-neutral descriptors without _meta or protocol annotation keys', async () => {
  const listed = await createFacade().listResources(appContext(ANONYMOUS_PRINCIPAL, []));
  assert.equal(listed.resources.length, 1);
  const resource = listed.resources[0]!;
  assert.equal(resource.uri, COLLECTION_URI);
  assert.equal(resource.name, 'Demo');
  assert.equal(resource.mimeType, PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE);
  assert.equal(resource.description, 'A collection');
  assertNoEraWireFields(resource);
});

test('readResource preserves uri, mimeType, text, and blob from the projection', async () => {
  const read = await createFacade().readResource(
    appContext(ANONYMOUS_PRINCIPAL, []),
    COLLECTION_URI,
  );
  assert.equal(read.contents.length, 1);
  const content = read.contents[0]!;
  assert.equal(content.uri, COLLECTION_URI);
  assert.equal(content.mimeType, PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE);
  assert.equal(content.text, COLLECTION_JSON);
  assert.equal(content.blob, COLLECTION_BLOB);
  assertNoEraWireFields(content);
});

test('callTool for collections.get maps to complete without era wire fields', async () => {
  const result = await createFacade().callTool(
    appContext(ANONYMOUS_PRINCIPAL, []),
    'collections.get',
    { collectionId: 'collection-1' },
  );
  assert.equal(result.kind, 'complete');
  if (result.kind !== 'complete') return;
  assert.equal(typeof result.structuredContent, 'object');
  assertNoEraWireFields(result);
});

test('callTool for an unknown tool maps to rejected with a stableCode', async () => {
  const result = await createFacade().callTool(
    appContext(ANONYMOUS_PRINCIPAL, []),
    'not.a.tool',
    {},
  );
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') return;
  assert.equal(typeof result.stableCode, 'string');
  assert.notEqual(result.stableCode.length, 0);
  assert.equal(result.retryable, false);
  assertNoEraWireFields(result);
});

test('callTool for input_required write maps to awaiting_approval with plan fields', async () => {
  const result = await createFacade(awaitingApprovalWriteAdapter()).callTool(
    appContext(AUTHENTICATED_PRINCIPAL, WRITE_SCOPES),
    'changes.plan',
    {
      operations: [],
      reason: 'plan',
      dryRun: true,
    },
  );
  assert.equal(result.kind, 'awaiting_approval');
  if (result.kind !== 'awaiting_approval') return;
  assert.equal(result.planId, 'plan-1');
  assert.equal(result.approvalUri, 'https://example.test/approvals/plan-1');
  assert.equal(result.expiresAt, '2026-08-28T12:00:00.000Z');
  assertNoEraWireFields(result);
});

test('neutral write port awaiting_approval matches COLP wrap mapping without headers or _meta', async () => {
  const args = Object.freeze({
    operations: Object.freeze([]),
    reason: 'plan',
    dryRun: true,
  });
  const context = appContext(AUTHENTICATED_PRINCIPAL, WRITE_SCOPES);
  assert.equal('_meta' in context, false);
  const fromPort = await createFacadeWithWritePort(awaitingApprovalWritePort()).callTool(
    context,
    'changes.plan',
    args,
  );
  const fromWrap = await toNeutralWritePort(awaitingApprovalWriteAdapter()).callTool(
    context,
    'changes.plan',
    args,
  );
  assert.deepEqual(fromPort, fromWrap);
  assertNoEraWireFields(fromPort);
});

test('mapStrictCallResult fills JSON text content from structuredContent when complete content is empty', async () => {
  const structuredContent = Object.freeze({ collectionId: 'col-1', rootNodeId: 'root-1' });
  const context = writeAppContext();
  const args = Object.freeze({ title: '测试收藏夹', idempotencyKey: 'b24c31fe-e58c-40fa-8c80-2a9438d5ecc1' });
  for (const fields of [
    { structuredContent },
    { structuredContent, content: Object.freeze([]) },
    { structuredContent, isError: true },
  ]) {
    const result = await toNeutralWritePort(completeWriteAdapter(fields)).callTool(
      context,
      'collections.create',
      args,
    );
    assertJsonTextContentMatchesStructured(result);
    if (result.kind !== 'complete') return;
    assert.equal(result.isError, fields.isError);
    assert.ok(Object.isFrozen(result.content));
    assertNoEraWireFields(result);
  }
});

test('mapStrictCallResult keeps a non-empty complete content array', async () => {
  const structuredContent = Object.freeze({ node: Object.freeze({ id: 'node-1' }) });
  const content = Object.freeze([
    Object.freeze({ type: 'text', text: 'keep-me' }),
  ]);
  const result = await toNeutralWritePort(completeWriteAdapter({
    content,
    structuredContent,
    isError: true,
  })).callTool(
    writeAppContext(),
    'nodes.create',
    nodeCreateArgs(),
  );
  assert.equal(result.kind, 'complete');
  if (result.kind !== 'complete') return;
  assert.equal(result.isError, true);
  assert.equal(result.content, content);
  assert.deepEqual(result.structuredContent, structuredContent);
  assertNoEraWireFields(result);
});

test('collections.create and nodes.create complete results expose JSON text content equal to structuredContent', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const facade = createFacade(fixture.bundle.adapter);
  const context = writeAppContext();
  const missingIntent = await facade.callTool(context, 'collections.create', Object.freeze({ title: '测试收藏夹' }));
  assert.equal(missingIntent.kind, 'rejected', 'new-intent key is required at the application facade');
  const created = await facade.callTool(context, 'collections.create', Object.freeze({ title: '测试收藏夹', idempotencyKey: 'b24c31fe-e58c-40fa-8c80-2a9438d5ecc1' }));
  assertJsonTextContentMatchesStructured(created);
  if (created.kind !== 'complete') return;
  const createdBody = created.structuredContent as {
    readonly collectionId?: string;
    readonly rootNodeId?: string;
    readonly revision?: string;
    readonly childrenRevision?: string;
  };
  assert.equal(createdBody.collectionId, 'col-w06-created');
  assert.equal(createdBody.rootNodeId, 'root-w06-created');
  assert.equal(createdBody.revision, 'res-w06-created');
  assert.equal(createdBody.childrenRevision, 'ch-w06-created');
  assertNoEraWireFields(created);

  const node = await facade.callTool(context, 'nodes.create', nodeCreateArgs());
  assertJsonTextContentMatchesStructured(node);
  if (node.kind !== 'complete') return;
  assert.equal(
    (node.structuredContent as { readonly node?: { readonly id?: string } }).node?.id,
    'node-w06-1',
  );
  assertNoEraWireFields(node);
});

test('facade listTools read names match the catalog without constructing protocol headers', async () => {
  const listed = await createFacade().listTools(appContext(ANONYMOUS_PRINCIPAL, []));
  assert.deepEqual(listed.tools.map((tool) => tool.name), [...PHASE4B_MCP_READ_TOOL_NAMES]);
  assert.equal(listed.tools[0]?.inputSchema, PHASE4B_MCP_READ_TOOL_CATALOG[0]?.inputSchema);
  for (const tool of listed.tools) assertNoEraWireFields(tool);
});

test('application facade and ports files do not import COLP MCP, Fastify, or official SDK wire types', () => {
  const files = [
    'src/modules/mcp/application-facade.ts',
    'src/modules/mcp/application-ports.ts',
    'src/modules/mcp/application-context.ts',
    'src/modules/mcp/application-catalog.ts',
    'src/modules/mcp/application-results.ts',
  ];
  for (const relativePath of files) {
    assert.deepEqual(forbiddenImportSpecifiers(relativePath), [], relativePath);
  }
});
