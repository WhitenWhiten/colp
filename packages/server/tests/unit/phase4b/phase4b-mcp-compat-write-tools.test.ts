/**
 * T-06: legacy `/collections/-/mcp-compat` write-tool catalog, low-risk
 * complete, initialize instructions, and scope gates. Approval lifecycle is
 * in `phase4b-mcp-compat-write-approval.test.ts`.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_INITIALIZE_INSTRUCTIONS,
  PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
} from '../../../src/modules/mcp/index.js';
import {
  compatListedToolInputSchema,
  mapLegacyCallToolResult,
} from '../../../src/transport/mcp/mcp-compat-write-adapter.js';
import { modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  mcpCompatInitializeBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  assertCompatCallToolEnvelope,
  compatJsonRpc,
  injectCompatLegacyPost,
  injectStrictPost,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  COMPAT_READ_SCOPES,
  COMPAT_REVISION,
  assertNoMrtrOrElicitation,
  createWriteFixture,
  listedTool,
  listedToolNames,
  mintCompatWriteToken,
  nodeCreateArguments,
  signedCompatWriteClient,
  startCompatWriteApp,
} from '../../support/phase4b-mcp-compat-write.js';
import {
  listedNodesCreateInputSchema,
  minimalNodesCreateArgumentsFromListedSchema,
} from '../../support/phase4b-mcp-node-create-catalog.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function assertJsonTextContentMatchesStructured(result: Record<string, unknown>): void {
  const block = Array.isArray(result.content)
    ? result.content[0] as { readonly type?: string; readonly text?: string } | undefined
    : undefined;
  assert.equal(block?.type, 'text');
  assert.deepEqual(JSON.parse(block?.text ?? 'null'), result.structuredContent);
}

function jsonSchemaFromCompatListed(
  compiled: ReturnType<typeof compatListedToolInputSchema>,
): Record<string, unknown> {
  const json = (compiled as {
    readonly '~standard': { readonly jsonSchema: { readonly input: () => unknown } };
  })['~standard'].jsonSchema.input();
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('expected JSON Schema object from compatListedToolInputSchema');
  }
  return json as Record<string, unknown>;
}

test('initialize instructions constant is self-contained in 512 chars and pinned on the wire', async () => {
  assert.equal(
    MCP_COMPAT_INITIALIZE_INSTRUCTIONS,
    [
      'Create: collections.create(title,idempotencyKey). New UUID v4 per intent; reuse on retry.',
      'Save: nodes.create(collectionId,node.kind/title; bookmarks need node.url).',
      'Do not call changes.plan to save links.',
      'Parent defaults to root. dryRun:true or confirmApply:false previews; omit both to apply.',
      'changes.plan dryRun:true stores a pending plan; open approvalUri then changes.commit.',
      'Publish with collections.get revision.',
      'No elicitation, sampling, requestState or inputResponses.',
    ].join(' '),
  );
  const head = MCP_COMPAT_INITIALIZE_INSTRUCTIONS.slice(0, 512);
  assert.match(head, /collections\.create/u);
  assert.match(head, /nodes\.create/u);
  assert.match(head, /Do not call changes\.plan to save links/u);
  assert.match(head, /approvalUri/u);
  assert.match(head, /changes\.commit/u);
  assert.doesNotMatch(MCP_COMPAT_INITIALIZE_INSTRUCTIONS, /https?:\/\/|Bearer |eyJ|tenant|webhook/iu);
  assert.ok(MCP_COMPAT_INITIALIZE_INSTRUCTIONS.length <= 512);

  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({
    writeFixture: createWriteFixture(),
    verifier: auth.verifier,
  }));
  const initialize = await injectCompatLegacyPost(
    server.app,
    mcpCompatInitializeBody(COMPAT_REVISION, { name: 'claude-code', version: '2.1.250' }),
  );
  assert.equal(initialize.statusCode, 200);
  const rpc = compatJsonRpc(initialize);
  assert.equal(rpc.result?.instructions, MCP_COMPAT_INITIALIZE_INSTRUCTIONS);
  const capabilities = rpc.result?.capabilities as {
    readonly elicitation?: unknown;
    readonly sampling?: unknown;
    readonly prompts?: unknown;
    readonly tools?: { readonly listChanged?: boolean };
  };
  assert.equal(capabilities?.elicitation, undefined);
  assert.equal(capabilities?.sampling, undefined);
  assert.equal(capabilities?.prompts, undefined);
  assert.notEqual(capabilities?.tools?.listChanged, true);
});

test('legacy mapper emits awaiting_approval in both text and structuredContent without bindingSummary', () => {
  const mapped = mapLegacyCallToolResult({
    kind: 'awaiting_approval',
    planId: 'plan-t06',
    approvalUri: 'https://approve.example/approvals/plan-t06',
    expiresAt: '2026-08-06T08:01:00.000Z',
    bindingSummary: 'authenticated principal leaked',
  });
  assert.equal('isError' in mapped && mapped.isError === true, false);
  const structured = mapped.structuredContent as Record<string, unknown>;
  assert.deepEqual(structured, {
    status: 'awaiting_approval',
    planId: 'plan-t06',
    approvalUri: 'https://approve.example/approvals/plan-t06',
    expiresAt: '2026-08-06T08:01:00.000Z',
  });
  assert.deepEqual(JSON.parse(mapped.content[0] && 'text' in mapped.content[0] ? mapped.content[0].text : '{}'), structured);
  assert.doesNotMatch(JSON.stringify(mapped), /bindingSummary|leaked/u);
});

test('compatListedToolInputSchema compiles COLP $ref write schemas', () => {
  assert.doesNotThrow(() => compatListedToolInputSchema({
    name: 'changes.commit',
    description: 'commit',
    requiredScopes: Object.freeze([]),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        planId: Object.freeze({
          $ref: 'https://know-n.com/colp/schema/0.1#/$defs/opaqueId',
        }),
        idempotencyKey: Object.freeze({ type: 'string', minLength: 1 }),
      }),
      required: Object.freeze(['planId', 'idempotencyKey']),
    }),
  }));
  assert.doesNotThrow(() => compatListedToolInputSchema({
    name: 'changes.plan',
    description: 'plan',
    requiredScopes: Object.freeze([]),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        operations: Object.freeze({
          type: 'array',
          minItems: 1,
          items: Object.freeze({
            $ref: 'https://know-n.com/colp/schema/0.1#/$defs/changePlanOperation',
          }),
        }),
        reason: Object.freeze({ type: 'string', minLength: 1 }),
        dryRun: Object.freeze({ const: true }),
      }),
      required: Object.freeze(['operations', 'reason', 'dryRun']),
    }),
  }));
});

test('compatListedToolInputSchema strips x-mcp-header without mutating the facade schema', () => {
  const collectionId = Object.freeze({
    type: 'string',
    minLength: 1,
    'x-mcp-header': PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  });
  const inputSchema = Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({
      collectionId,
      nested: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          inner: Object.freeze({ type: 'string', 'x-mcp-header': 'X-Inner' }),
        }),
      }),
      list: Object.freeze({
        type: 'array',
        items: Object.freeze({ type: 'string', 'x-mcp-header': 'X-Item' }),
      }),
      choice: Object.freeze({
        oneOf: Object.freeze([
          Object.freeze({ type: 'string', 'x-mcp-header': 'X-One' }),
          Object.freeze({ type: 'integer' }),
        ]),
      }),
      union: Object.freeze({
        anyOf: Object.freeze([
          Object.freeze({ type: 'boolean', 'x-mcp-header': 'X-Any' }),
        ]),
      }),
      combo: Object.freeze({
        allOf: Object.freeze([
          Object.freeze({ type: 'string', minLength: 1, 'x-mcp-header': 'X-All' }),
        ]),
      }),
      refd: Object.freeze({
        $ref: 'https://know-n.com/colp/schema/0.1#/$defs/opaqueId',
      }),
    }),
    required: Object.freeze(['collectionId']),
  });
  const compiled = compatListedToolInputSchema({
    name: 'nodes.create',
    description: 'probe',
    requiredScopes: Object.freeze([]),
    inputSchema,
  });
  const json = jsonSchemaFromCompatListed(compiled);
  assert.doesNotMatch(JSON.stringify(json), /"x-mcp-header"/u);
  assert.ok(Array.isArray(json.required) && json.required.includes('collectionId'));
  assert.equal(collectionId['x-mcp-header'], PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER);
  assert.equal(
    (inputSchema.properties as { readonly collectionId: { readonly 'x-mcp-header'?: string } })
      .collectionId['x-mcp-header'],
    PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER,
  );
});

test('compat tools/list advertises real write input schemas without outputSchema or 07-28 keys', async () => {
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({
    writeFixture: createWriteFixture(),
    verifier: auth.verifier,
  }));
  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(listed.statusCode, 200);
  const names = listedToolNames(listed);
  for (const name of PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES) {
    assert.ok(names.includes(name), name);
    const tool = listedTool(listed, name);
    assert.equal(tool?.inputSchema?.type, 'object');
    assert.notEqual(tool?.inputSchema?.additionalProperties, true);
    assert.equal(tool?.outputSchema, undefined);
  }
  const create = listedTool(listed, 'nodes.create');
  assert.ok(create?.inputSchema?.required?.includes('collectionId'));
  assert.equal(
    (create?.inputSchema?.properties?.collectionId as { readonly 'x-mcp-header'?: string } | undefined)
      ?.['x-mcp-header'],
    undefined,
  );
  const collectionsCreate = listedTool(listed, 'collections.create');
  assert.equal(
    (collectionsCreate?.inputSchema?.properties?.collectionId as { readonly 'x-mcp-header'?: string } | undefined)
      ?.['x-mcp-header'],
    undefined,
  );
  for (const name of ['nodes.update', 'collections.update', 'annotations.create', 'annotations.update'] as const) {
    assert.ok(names.includes(name), name);
    const tool = listedTool(listed, name);
    assert.equal(
      (tool?.inputSchema?.properties?.collectionId as { readonly 'x-mcp-header'?: string } | undefined)
        ?.['x-mcp-header'],
      undefined,
    );
  }
  assert.doesNotMatch(listed.payload, /"x-mcp-header"/u);
  const changeGet = listedTool(listed, 'changes.get');
  assert.ok(changeGet, 'changes.get');
  assert.deepEqual(changeGet?.inputSchema?.required, ['planId']);
  assert.equal(
    (changeGet?.inputSchema?.properties?.planId as { readonly 'x-mcp-header'?: string } | undefined)
      ?.['x-mcp-header'],
    undefined,
  );
  const commit = listedTool(listed, 'changes.commit');
  assert.deepEqual(commit?.inputSchema?.required, ['planId', 'idempotencyKey']);
  assert.equal(names.includes('nodes.set_visibility'), false);
  assert.doesNotMatch(listed.payload, /"\$ref"\s*:\s*"https:\/\/collectionprotocol\.org/u);
  assertNoMrtrOrElicitation(listed.payload);
});

test('anonymous and read-only scope cannot list or call write tools', async () => {
  const writeAuth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({
    writeFixture: createWriteFixture(),
    verifier: writeAuth.verifier,
  }));
  const anonymous = await injectCompatLegacyPost(server.app, mcpCompatToolsListBody(2), COMPAT_REVISION);
  assert.equal(listedToolNames(anonymous).some((name) => name.startsWith('changes.')), false);
  assert.equal(listedToolNames(anonymous).includes('nodes.create'), false);

  const readList = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(3),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintCompatWriteToken({
      key: writeAuth.key.privateKey,
      kid: writeAuth.key.kid,
      scopes: COMPAT_READ_SCOPES,
      jti: 't06-read-only',
    })}` },
  );
  assert.equal(listedToolNames(readList).includes('nodes.create'), false);

  const denied = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 4, nodeCreateArguments()),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintCompatWriteToken({
      key: writeAuth.key.privateKey,
      kid: writeAuth.key.kid,
      scopes: COMPAT_READ_SCOPES,
      jti: 't06-read-call',
    })}` },
  );
  assert.equal(denied.statusCode, 200);
  const deniedResult = compatJsonRpc(denied).result ?? {};
  assert.equal(deniedResult.isError, true);
  assert.match(JSON.stringify(deniedResult.content), /Unknown tool/u);
  assert.doesNotMatch(denied.payload, /nodes\.create/u);
});

test('low-risk nodes.create confirmApply completes without awaiting_approval or 07-28 envelope keys', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 10, nodeCreateArguments()),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(called.statusCode, 200);
  const result = compatJsonRpc(called).result ?? {};
  assertCompatCallToolEnvelope(result);
  assert.equal(result.isError === true, false);
  assert.equal(
    (result.structuredContent as { node?: { id?: string } } | undefined)?.node?.id,
    'node-w06-1',
  );
  assertJsonTextContentMatchesStructured(result);
  assert.doesNotMatch(JSON.stringify(result), /awaiting_approval/u);
  assertNoMrtrOrElicitation(called.payload);
  assert.equal(fixture.nodeCreateCalls.length, 1);
});

test('low-risk collections.create complete result includes JSON text content matching structuredContent', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('collections.create', 11, { title: '测试收藏夹', idempotencyKey: crypto.randomUUID() }),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(called.statusCode, 200);
  const result = compatJsonRpc(called).result ?? {};
  assertCompatCallToolEnvelope(result);
  assert.equal(result.isError === true, false);
  assert.equal(
    (result.structuredContent as { collectionId?: string } | undefined)?.collectionId,
    'col-w06-created',
  );
  assertJsonTextContentMatchesStructured(result);
});

test('compat tools/list schema yields minimal legal folder and bookmark calls; invalid node shapes fail before write', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));
  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(20),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(listed.statusCode, 200);
  const schema = listedNodesCreateInputSchema(
    (compatJsonRpc(listed).result?.tools ?? []) as readonly Readonly<Record<string, unknown>>[],
  );
  const folderArgs = minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'preview');
  const bookmarkArgs = minimalNodesCreateArgumentsFromListedSchema(schema, 'bookmark', 'apply');
  const folder = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 21, folderArgs),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(folder.statusCode, 200);
  const folderResult = compatJsonRpc(folder).result ?? {};
  assertCompatCallToolEnvelope(folderResult);
  assert.equal(folderResult.isError === true, false);
  assert.equal(
    (folderResult.structuredContent as { resultType?: string } | undefined)?.resultType,
    'preview',
  );
  assertJsonTextContentMatchesStructured(folderResult);
  const bookmark = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 22, bookmarkArgs),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(bookmark.statusCode, 200);
  const bookmarkResult = compatJsonRpc(bookmark).result ?? {};
  assertCompatCallToolEnvelope(bookmarkResult);
  assert.equal(bookmarkResult.isError === true, false);
  assert.equal(
    (bookmarkResult.structuredContent as { node?: { id?: string } } | undefined)?.node?.id,
    'node-w06-1',
  );
  assertJsonTextContentMatchesStructured(bookmarkResult);
  const accepted = fixture.nodeCreateCalls.length;
  const missingUrl = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('nodes.create', 23, {
      collectionId: 'collection-1',
      parentId: 'root-1',
      node: {
        kind: 'bookmark',
        title: 'n',
        description: null,
        tags: [],
        visibility: 'private',
      },
      reason: 'create',
      confirmApply: true,
    }),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(missingUrl.statusCode, 200);
  const missingResult = compatJsonRpc(missingUrl).result ?? {};
  assert.equal(missingResult.isError, true);
  assert.match(JSON.stringify(missingResult.content), /Invalid MCP write Tool arguments|Invalid/u);
  assert.equal(fixture.nodeCreateCalls.length, accepted);
});

test('compat write tools/call keeps unknown-tool name redaction and rejects elicitation/create', async () => {
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({
    writeFixture: createWriteFixture(),
    verifier: auth.verifier,
  }));
  const unknown = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('not.a.write.tool', 5, {}),
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(compatJsonRpc(unknown).result?.isError, true);
  assert.match(JSON.stringify(compatJsonRpc(unknown).result?.content), /Unknown tool/u);
  assert.doesNotMatch(unknown.payload, /not\.a\.write\.tool/u);

  const elicitation = await injectCompatLegacyPost(
    server.app,
    { jsonrpc: '2.0', id: 6, method: 'elicitation/create', params: {} },
    COMPAT_REVISION,
    { authorization: `Bearer ${auth.token}` },
  );
  assert.equal(compatJsonRpc(elicitation).error?.code, -32_601);
});

test('strict write Plan still uses MRTR input_required and requestState', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));
  const planned = await injectStrictPost(server.app, 'tools/call', 20, {
    authorization: `Bearer ${auth.strictToken}`,
    'mcp-name': 'changes.plan',
  }, modernBody('tools/call', 20, {
    name: 'changes.plan',
    arguments: {
      operations: [{
        type: 'set_visibility',
        collectionId: 'collection-1',
        baseRevision: 'resource-r1',
        input: { visibility: 'protected' },
      }],
      reason: 'publish this node',
      dryRun: true,
    },
  }));
  assert.equal(planned.statusCode, 200);
  const payload = JSON.parse(planned.payload) as { readonly result?: Record<string, unknown> };
  assert.equal(payload.result?.resultType, 'input_required');
  assert.equal(typeof payload.result?.requestState, 'string');
  assert.deepEqual(payload.result?.inputRequests, {});
});
