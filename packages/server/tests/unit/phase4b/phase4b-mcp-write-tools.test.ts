import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { encodeMcp20260728ParamValue } from '@know-n/colp/mcp';
import { COLLECTION_KINDS } from '../../../src/modules/collections/index.js';
import {
  PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES,
  PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS,
  Phase4bMcpLowRiskNodeCreateError,
} from '../../../src/modules/mcp/index.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  READ_SCOPES,
  WRITE_SCOPES,
  authFixture,
  closeWriteToolApps,
  mcpEnv,
  modernBody,
  nodeCreateArguments,
  parseJsonRpc,
  postJson,
  startApi,
} from '../../support/phase4b-mcp-write-tools-http.js';

afterEach(async () => {
  await closeWriteToolApps();
});

test('anonymous, read-only scope, and write scope produce deterministic Write Tool visibility', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const readAuth = await authFixture(READ_SCOPES);
  const readServer = await startApi(mcpEnv(READ_SCOPES), readAuth, fixture);

  const anonymous = parseJsonRpc(await (await postJson(readServer, 'tools/list', 1)).text());
  assert.deepEqual(anonymous.result?.tools, []);

  const readOnly = await postJson(readServer, 'tools/list', 2, {
    headers: { authorization: `Bearer ${readAuth.token}` },
  });
  const readOnlyTools = parseJsonRpc(await readOnly.text());
  assert.deepEqual(readOnlyTools.result?.tools, []);

  const writeAuth = await authFixture(WRITE_SCOPES);
  const writeServer = await startApi(mcpEnv(WRITE_SCOPES), writeAuth, fixture);
  const writeList = await postJson(writeServer, 'tools/list', 3, {
    headers: { authorization: `Bearer ${writeAuth.token}` },
  });
  const writeTools = parseJsonRpc(await writeList.text()).result?.tools as
    ReadonlyArray<{ readonly name: string }>;
  assert.deepEqual(
    writeTools.map((tool) => tool.name),
    [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort(),
  );
  assert.equal(writeTools.some((tool) => tool.name === 'nodes.set_visibility'), false);
  const writeOnlyAuth = await authFixture(WRITE_SCOPES.slice(2));
  const writeOnlyServer = await startApi(mcpEnv(WRITE_SCOPES.slice(2)), writeOnlyAuth, fixture);
  const writeOnlyList = await postJson(writeOnlyServer, 'tools/list', 5, {
    headers: { authorization: `Bearer ${writeOnlyAuth.token}` },
  });
  const writeOnlyTools = parseJsonRpc(await writeOnlyList.text()).result?.tools as
    ReadonlyArray<{ readonly name: string }>;
  assert.deepEqual(
    writeOnlyTools.map((tool) => tool.name),
    [...PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES].sort(),
  );
  assert.equal(writeOnlyTools.some((tool) => tool.name === 'nodes.set_visibility'), false);
  const denied = await postJson(readServer, 'tools/call', 6, {
    headers: {
      authorization: `Bearer ${readAuth.token}`,
      'mcp-name': 'nodes.create',
    },
    body: modernBody('tools/call', 4, {
      name: 'nodes.create',
      arguments: {},
    }),
  });
  assert.equal(parseJsonRpc(await denied.text()).error?.code, -32602);

  const directSetVisibility = await postJson(writeServer, 'tools/call', 7, {
    headers: {
      authorization: `Bearer ${writeAuth.token}`,
      'mcp-name': 'nodes.set_visibility',
    },
    body: modernBody('tools/call', 7, {
      name: 'nodes.set_visibility',
      arguments: {},
    }),
  });
  assert.equal(parseJsonRpc(await directSetVisibility.text()).error?.code, -32602);
});

test('write Tool constants expose no direct nodes.set_visibility surface', () => {
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
  assert.deepEqual(Object.keys(PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES), [
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
  assert.deepEqual(PHASE4B_MCP_WRITE_TOOL_PARAM_DECLARATIONS, [
    Object.freeze({
      path: Object.freeze(['collectionId']),
      headerName: 'X-Collection-Id',
      type: 'string',
    }),
  ]);
});

test('collections.create returns a private collectionId and rootNodeId', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const response = await postJson(server, 'tools/call', 8, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'collections.create',
    },
    body: modernBody('tools/call', 8, {
      name: 'collections.create',
      arguments: { title: '测试收藏夹', idempotencyKey: crypto.randomUUID() },
    }),
  });
  assert.equal(response.status, 200);
  const payload = parseJsonRpc(await response.text());
  assert.equal(payload.error, undefined);
  const content = payload.result?.structuredContent as {
    readonly collectionId?: string;
    readonly rootNodeId?: string;
    readonly visibility?: string;
    readonly title?: string;
    readonly revision?: string;
    readonly contentRevision?: string;
    readonly policyRevision?: string;
    readonly rootRevision?: string;
    readonly childrenRevision?: string;
  };
  assert.equal(content.collectionId, 'col-w06-created');
  assert.equal(content.rootNodeId, 'root-w06-created');
  assert.equal(content.visibility, 'private');
  assert.equal(content.title, '测试收藏夹');
  assert.equal(content.revision, 'res-w06-created');
  assert.equal(content.contentRevision, 'cnt-w06-created');
  assert.equal(content.policyRevision, 'pol-w06-created');
  assert.equal(content.rootRevision, 'root-res-w06-created');
  assert.equal(content.childrenRevision, 'ch-w06-created');
});


test('collections.create catalog reject on the wire names field and retries collections.create', async () => {
  const fixture = createInMemoryWriteToolFixture({
    collectionCreateService: Object.freeze({
      execute: async () => {
        throw new Phase4bMcpLowRiskNodeCreateError(
          'invalid_catalog_input',
          'collections.create title must be a non-empty string.',
          { field: 'title', nextTool: 'collections.create' },
        );
      },
    }),
  });
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const response = await postJson(server, 'tools/call', 9, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'collections.create',
    },
    body: modernBody('tools/call', 9, {
      name: 'collections.create',
      arguments: { title: '测试收藏夹', idempotencyKey: crypto.randomUUID() },
    }),
  });
  assert.equal(response.status, 200);
  const payload = parseJsonRpc(await response.text());
  assert.equal(payload.error?.code, -32602);
  assert.deepEqual(payload.error?.data, {
    code: 'invalid_params',
    field: 'title',
    allowedKinds: COLLECTION_KINDS,
    allowedVisibilities: ['private'],
    nextTool: 'collections.create',
  });
});

test('low-risk nodes.create executes with encoded custom Mcp-Name/Param headers and secret-safe output', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const collectionId = 'collection-1 公共';
  const param = encodeMcp20260728ParamValue(collectionId);
  const args = {
    collectionId,
    parentId: 'root-1',
    node: {
      kind: 'bookmark',
      title: 'W06 bookmark',
      url: 'https://example.test/w06',
      description: null,
      tags: ['w06'],
      visibility: 'private',
    },
    reason: 'create bookmark',
    confirmApply: true,
  };
  const response = await postJson(server, 'tools/call', 10, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': '=?base64?bm9kZXMuY3JlYXRl?=',
      [`mcp-param-${PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER}`]: param,
    },
    body: modernBody('tools/call', 10, { name: 'nodes.create', arguments: args }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = parseJsonRpc(text);
  assert.equal(payload.result?.resultType, 'complete');
  assert.equal(
    (payload.result?.structuredContent as { node?: { id?: string } }).node?.id,
    'node-w06-1',
  );
  const content = payload.result?.content as readonly { readonly type?: string; readonly text?: string }[];
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, 'text');
  assert.deepEqual(JSON.parse(content[0]?.text ?? ''), payload.result?.structuredContent);
  assert.equal(payload.result?.requestState, undefined);
  assert.equal(payload.result?.inputRequests, undefined);
  assert.doesNotMatch(text, /Bearer |eyJ/u);
  assert.equal(fixture.nodeCreateCalls.length, 1);
  assert.equal(
    fixture.nodeCreateCalls[0]?.request.input.tool,
    'nodes.create',
  );
  assert.equal(fixture.nodeCreateCalls[0]?.request.input.confirmApply, true);
  assert.equal(Object.hasOwn(fixture.nodeCreateCalls[0]?.request.input ?? {}, 'dryRun'), false);
  assert.match(
    fixture.nodeCreateCalls[0]?.request.idempotencyKey ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test('nodes.create preview is distinct from complete and either no-write flag previews', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const previewArgs = {
    ...nodeCreateArguments('preview bookmark'),
    dryRun: true,
    confirmApply: false,
  };
  const preview = await postJson(server, 'tools/call', 11, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: modernBody('tools/call', 11, { name: 'nodes.create', arguments: previewArgs }),
  });
  assert.equal(preview.status, 200);
  const previewPayload = parseJsonRpc(await preview.text());
  assert.equal(previewPayload.result?.resultType, 'complete');
  assert.equal(
    (previewPayload.result?.structuredContent as { resultType?: string }).resultType,
    'preview',
  );
  assert.equal(
    Object.hasOwn(previewPayload.result?.structuredContent as object, 'receipt'),
    false,
  );
  const { confirmApply: _confirmApply, ...legacyArgs } = nodeCreateArguments('legacy dryRun');
  void _confirmApply;
  const legacy = await postJson(server, 'tools/call', 12, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: modernBody('tools/call', 12, {
      name: 'nodes.create',
      arguments: { ...legacyArgs, dryRun: true },
    }),
  });
  assert.equal(legacy.status, 200);
  const legacyPayload = parseJsonRpc(await legacy.text());
  assert.equal(legacyPayload.error, undefined);
  assert.equal(
    (legacyPayload.result?.structuredContent as { resultType?: string }).resultType,
    'preview',
  );
  const confirmFalseArgs = {
    ...nodeCreateArguments('explicit confirmApply false'),
    confirmApply: false,
  };
  const confirmFalse = await postJson(server, 'tools/call', 13, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: modernBody('tools/call', 13, {
      name: 'nodes.create',
      arguments: confirmFalseArgs,
    }),
  });
  assert.equal(confirmFalse.status, 200);
  const confirmFalsePayload = parseJsonRpc(await confirmFalse.text());
  assert.equal(confirmFalsePayload.error, undefined);
  assert.equal(
    (confirmFalsePayload.result?.structuredContent as { resultType?: string }).resultType,
    'preview',
  );
  assert.equal(fixture.nodeCreateCalls.at(-1)?.request.input.dryRun, true);
  assert.equal(fixture.nodeCreateCalls.at(-1)?.request.input.confirmApply, false);
});

