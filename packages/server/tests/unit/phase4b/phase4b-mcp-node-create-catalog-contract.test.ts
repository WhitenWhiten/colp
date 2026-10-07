/**
 * MCP-CQ-02: tools/list `nodes.create` node schema and the runtime parser
 * share one frozen kind/required-key source. Schema-accepted input is
 * parser-accepted. Invalid node shapes fail as catalog invalid params before
 * mutation UoW or inspect.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  Mcp20260728RequestError,
  createAuthenticatedBinding,
  type McpAuthenticatedAuthorizationBinding,
} from '@know-n/colp/mcp';
import { createMcpToolInputValidator, McpToolInputError } from '../../support/mcp-tool-schema-validator.js';
import type {
  ProductCollectionCanonicalPorts,
  ProductCollectionMutationUnitOfWork,
} from '../../../src/modules/collections/index.js';
import {
  PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS,
  PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS,
  PHASE4B_MCP_NODE_CREATE_NODE_SCHEMA,
  PHASE4B_MCP_NODES_CREATE_INPUT_SCHEMA,
  Phase4bMcpLowRiskNodeCreateError,
  createPhase4bMcpLowRiskNodeCreateService,
  createPhase4bMcpRequestContext,
  type Phase4bMcpLowRiskNodeCreateContext,
  type Phase4bMcpLowRiskNodeCreateInspectPorts,
} from '../../../src/modules/mcp/index.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  listedNodesCreateInputSchema,
  minimalNodesCreateArgumentsFromListedSchema,
} from '../../support/phase4b-mcp-node-create-catalog.js';

const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-1',
  clientId: 'client-1',
  credentialBindingId: 'credential-1',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-1',
});

const LIST_BINDING = createAuthenticatedBinding({
  credentialKind: 'oauth',
  principalId: 'urn:known:subject:alice',
  clientId: 'known-mcp-oauth-client',
  credentialBindingId: 'credential-1',
  resourceAudience: 'https://collections.example.test/collections/-/mcp',
  securityEpoch: 'epoch-1',
});

const WRITE_SCOPES = Object.freeze([
  'mcp:read:public',
  'nodes:write',
  'access:write',
  'changes:commit',
  'changes:cancel',
] as const);

const PARSER_CONTEXT: Phase4bMcpLowRiskNodeCreateContext = Object.freeze({
  binding: BINDING,
  accountSubjectId: BINDING.principalId,
  scope: Object.freeze(['nodes:write']),
});

const IDEMPOTENCY_KEY = '11111111-1111-4111-8111-111111111111';

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const validateListedInput = createMcpToolInputValidator(PHASE4B_MCP_NODES_CREATE_INPUT_SCHEMA);

interface CatalogCase {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expectAccept: boolean;
}

function envelope(node: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    collectionId: 'collection-1',
    parentId: 'root-1',
    afterId: null,
    beforeId: null,
    node: Object.freeze(node),
    reason: 'create',
    confirmApply: true,
  });
}

const LEGAL_FOLDER_NODE = Object.freeze({
  kind: 'folder',
  title: 'n',
  description: null,
  tags: Object.freeze([]),
  visibility: 'private',
});

const LEGAL_BOOKMARK_NODE = Object.freeze({
  kind: 'bookmark',
  title: 'n',
  url: 'https://example.test/n',
  description: null,
  tags: Object.freeze([]),
  visibility: 'private',
});

const CATALOG_CASES: readonly CatalogCase[] = Object.freeze([
  Object.freeze({
    name: 'minimal folder apply',
    args: envelope(LEGAL_FOLDER_NODE),
    expectAccept: true,
  }),
  Object.freeze({
    name: 'minimal bookmark apply',
    args: envelope(LEGAL_BOOKMARK_NODE),
    expectAccept: true,
  }),
  Object.freeze({
    name: 'minimal folder preview',
    args: Object.freeze({
      ...envelope(LEGAL_FOLDER_NODE),
      dryRun: true,
      confirmApply: false,
    }),
    expectAccept: true,
  }),
  Object.freeze({
    name: 'minimal bookmark preview',
    args: Object.freeze({
      ...envelope(LEGAL_BOOKMARK_NODE),
      dryRun: true,
      confirmApply: false,
    }),
    expectAccept: true,
  }),
  Object.freeze({
    name: 'bookmark missing url',
    args: envelope(Object.freeze({
      kind: 'bookmark',
      title: 'n',
      description: null,
      tags: Object.freeze([]),
      visibility: 'private',
    })),
    expectAccept: false,
  }),
  Object.freeze({
    name: 'bookmark url null',
    args: envelope(Object.freeze({ ...LEGAL_BOOKMARK_NODE, url: null })),
    expectAccept: false,
  }),
  Object.freeze({
    name: 'bookmark missing description',
    args: envelope(Object.freeze({
      kind: 'bookmark',
      title: 'n',
      url: 'https://example.test/n',
      tags: Object.freeze([]),
      visibility: 'private',
    })),
    expectAccept: true,
  }),
  Object.freeze({
    name: 'folder missing description',
    args: envelope(Object.freeze({
      kind: 'folder',
      title: 'n',
      tags: Object.freeze([]),
      visibility: 'private',
    })),
    expectAccept: true,
  }),
  Object.freeze({
    name: 'folder with url',
    args: envelope(Object.freeze({ ...LEGAL_FOLDER_NODE, url: 'https://example.test/n' })),
    expectAccept: false,
  }),
  Object.freeze({
    name: 'folder with null url',
    args: envelope(Object.freeze({ ...LEGAL_FOLDER_NODE, url: null })),
    expectAccept: false,
  }),
]);

function schemaAccepts(args: Readonly<Record<string, unknown>>): boolean {
  try {
    validateListedInput(args);
    return true;
  } catch (error) {
    if (error instanceof McpToolInputError) return false;
    throw error;
  }
}

function meta(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: Object.freeze({ tools: Object.freeze({ call: true }) }),
  });
}

function listContext() {
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
    binding: LIST_BINDING,
    scope: WRITE_SCOPES,
    authorization: Object.freeze({ accountSubjectId: LIST_BINDING.principalId }),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

function callContext() {
  return createPhase4bMcpRequestContext({
    headers: Object.freeze([
      Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
      Object.freeze({ name: 'Mcp-Method', value: 'tools/call' }),
      Object.freeze({ name: 'Mcp-Name', value: 'nodes.create' }),
    ]),
    httpMethod: 'POST',
    body: Object.freeze({
      method: 'tools/call',
      params: Object.freeze({
        _meta: meta(),
        name: 'nodes.create',
      }),
    }),
    binding: LIST_BINDING,
    scope: WRITE_SCOPES,
    authorization: Object.freeze({ accountSubjectId: LIST_BINDING.principalId }),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
  });
}

function unusedPort(name: string) {
  return async () => {
    throw new Error(`${name} is unused by the MCP-CQ-02 parser probe`);
  };
}

function parserRequest(args: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    input: Object.freeze({
      tool: 'nodes.create',
      ...args,
    }),
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedBaseRevisions: Object.freeze({}),
  });
}

interface ParserProbe {
  callbackInvoked: boolean;
  lockCalls: number;
}

function createParserService(): {
  readonly execute: ReturnType<typeof createPhase4bMcpLowRiskNodeCreateService>['execute'];
  readonly probe: ParserProbe;
} {
  const probe: ParserProbe = { callbackInvoked: false, lockCalls: 0 };
  const now = new Date('2026-08-05T12:00:00.000Z');
  const ports: ProductCollectionCanonicalPorts = {
    receipts: {
      claim: async () => ({ kind: 'claimed' as const }),
      complete: async () => undefined,
    },
    clock: { now: async () => now },
    collections: {
      lockForUpdate: async () => {
        probe.lockCalls += 1;
        return {
          id: 'collection-1',
          ownerSubjectId: BINDING.principalId,
          title: 'Collection',
          summary: null,
          kind: 'bookmarks',
          visibility: 'private',
          rootNodeId: 'root-1',
          resourceRevision: 'resource-r1',
          contentRevision: 'content-r1',
          policyRevision: 'policy-r1',
          commitOrdinal: 1n,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
      },
    },
    nodes: {
      getNode: async () => ({
        id: 'root-1',
        collectionId: 'collection-1',
        parentId: null,
        kind: 'folder',
        isRoot: true,
        title: 'Root',
        url: null,
        description: null,
        tags: [],
        visibility: 'inherit',
        positionToken: 'A',
        resourceRevision: 'resource-r1',
        childrenRevision: 'children-r1',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }),
      listLiveSiblingPositions: unusedPort('nodes.listLiveSiblingPositions'),
    },
    accessPolicy: {
      loadCollectionFacts: async () => ({
        collectionId: 'collection-1',
        ownerSubjectId: BINDING.principalId,
        visibility: 'private',
        policyRevision: 'policy-r1',
        membershipRole: 'owner',
        deleted: false,
      }),
    },
    canonical: {
      execute: async () => {
        throw new Error('canonical.execute must not run in catalog contract tests');
      },
      bootstrapOwnedCollection: async () => {
        throw new Error('unused');
      },
    },
  };
  const unitOfWork: ProductCollectionMutationUnitOfWork = Object.freeze({
    execute: async (work) => {
      probe.callbackInvoked = true;
      return work(ports);
    },
  });
  const service = createPhase4bMcpLowRiskNodeCreateService({
    unitOfWork,
    inspect: Object.freeze({
      execute: <Result>(
        work: (inspectPorts: Phase4bMcpLowRiskNodeCreateInspectPorts) => Promise<Result>,
      ) => work(Object.freeze({
        getCollection: (collectionId: string) => ports.collections.lockForUpdate(collectionId),
        getNode: (collectionId: string, nodeId: string) => ports.nodes.getNode(collectionId, nodeId),
        accessPolicy: ports.accessPolicy,
      })),
    }),
  });
  return Object.freeze({ execute: service.execute, probe });
}

async function parserAcceptsNode(
  execute: ReturnType<typeof createPhase4bMcpLowRiskNodeCreateService>['execute'],
  args: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const previewArgs = Object.freeze({
    collectionId: args.collectionId,
    parentId: args.parentId,
    afterId: Object.hasOwn(args, 'afterId') ? args.afterId : null,
    beforeId: Object.hasOwn(args, 'beforeId') ? args.beforeId : null,
    node: args.node,
    reason: args.reason,
    dryRun: true as const,
    confirmApply: false as const,
  });
  try {
    await execute(parserRequest(previewArgs), PARSER_CONTEXT);
    return true;
  } catch (error) {
    if (
      error instanceof Phase4bMcpLowRiskNodeCreateError
      && (error.code === 'invalid_catalog_input' || error.code === 'open_payload_rejected')
    ) {
      return false;
    }
    throw error;
  }
}

test('nodes.create schema oneOf required arrays are the shared frozen key lists', () => {
  assert.equal(
    PHASE4B_MCP_NODE_CREATE_NODE_SCHEMA.oneOf[0]?.required,
    PHASE4B_MCP_NODE_CREATE_FOLDER_REQUIRED_KEYS,
  );
  assert.equal(
    PHASE4B_MCP_NODE_CREATE_NODE_SCHEMA.oneOf[1]?.required,
    PHASE4B_MCP_NODE_CREATE_BOOKMARK_REQUIRED_KEYS,
  );
});

test('tools/list minimal folder and bookmark payloads are accepted by schema, adapter, and parser', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const listed = await fixture.bundle.adapter.listTools(listContext(), {});
  const schema = listedNodesCreateInputSchema(
    listed.tools as readonly Readonly<Record<string, unknown>>[],
  );
  const parser = createParserService();
  const cases = Object.freeze([
    Object.freeze({ kind: 'folder' as const, mode: 'preview' as const }),
    Object.freeze({ kind: 'folder' as const, mode: 'apply' as const }),
    Object.freeze({ kind: 'bookmark' as const, mode: 'preview' as const }),
    Object.freeze({ kind: 'bookmark' as const, mode: 'apply' as const }),
  ]);
  for (const row of cases) {
    const args = minimalNodesCreateArgumentsFromListedSchema(schema, row.kind, row.mode);
    assert.equal(schemaAccepts(args), true, row.kind + ' ' + row.mode);
    const result = await fixture.bundle.adapter.callTool(callContext(), {
      name: 'nodes.create',
      arguments: args,
    });
    assert.equal((result as { readonly resultType?: string }).resultType, 'complete', row.kind + ' ' + row.mode);
    assert.equal(
      (result as { readonly structuredContent?: { readonly resultType?: string } }).structuredContent?.resultType,
      row.mode === 'preview' ? 'preview' : 'complete',
      row.kind + ' ' + row.mode,
    );
    parser.probe.callbackInvoked = false;
    parser.probe.lockCalls = 0;
    assert.equal(
      await parserAcceptsNode(parser.execute, args),
      true,
      row.kind + ' ' + row.mode,
    );
    if (row.mode === 'preview') {
      assert.equal(parser.probe.callbackInvoked, false, row.kind + ' preview must not open UoW');
    }
  }
});

test('validator accept-set vs parser accept-set: schema-accepted input is parser-accepted', async () => {
  const parser = createParserService();
  for (const row of CATALOG_CASES) {
    const schemaOk = schemaAccepts(row.args);
    parser.probe.callbackInvoked = false;
    parser.probe.lockCalls = 0;
    const parserOk = await parserAcceptsNode(parser.execute, row.args);
    assert.equal(schemaOk, row.expectAccept, `schema ${row.name}`);
    assert.equal(parserOk, row.expectAccept, `parser ${row.name}`);
    if (schemaOk) {
      assert.equal(parserOk, true, `schema-accepted ${row.name} must be parser-accepted`);
    }
    if (row.expectAccept === false) {
      parser.probe.callbackInvoked = false;
      parser.probe.lockCalls = 0;
      await assert.rejects(
        parser.execute(parserRequest(row.args), PARSER_CONTEXT),
        (error: unknown) => {
          assert.ok(error instanceof Phase4bMcpLowRiskNodeCreateError);
          assert.equal(error.code, 'invalid_catalog_input');
          return true;
        },
        row.name,
      );
      assert.equal(parser.probe.callbackInvoked, false, row.name);
      assert.equal(parser.probe.lockCalls, 0, row.name);
    }
  }
});

test('invalid node catalog shapes fail tools/call as invalid_params before the write service', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const rejected = CATALOG_CASES.filter((row) => row.expectAccept === false);
  for (const row of rejected) {
    const before = fixture.nodeCreateCalls.length;
    await assert.rejects(
      fixture.bundle.adapter.callTool(callContext(), {
        name: 'nodes.create',
        arguments: row.args,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Mcp20260728RequestError);
        assert.equal(error.kind, 'invalid_params');
        assert.equal(error.message, 'Invalid MCP write Tool arguments.');
        return true;
      },
      row.name,
    );
    assert.equal(fixture.nodeCreateCalls.length, before, row.name);
  }
});
