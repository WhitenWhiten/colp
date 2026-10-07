/**
 * T-05: legacy `/collections/-/mcp-compat` read-tool catalog and results.
 * Schema/result parity with the shared facade; no 07-28 wire envelope.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpReadRequestAbortedError } from '@know-n/colp/mcp';
import {
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  PHASE4B_MCP_READ_TOOL_CATALOG,
  PHASE4B_MCP_READ_TOOL_NAMES,
} from '../../../src/modules/mcp/index.js';
import { hostReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import {
  assertNo0728WireFields,
  compatJsonRpc,
  injectCompatLegacyPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  emptyNodeResourceProjection,
  emptySnapshotResourceProjection,
  modernBody,
  toolCollectionProjection,
  toolSnapshotProjection,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  COMPAT_VISIBILITY_MEMBER,
  COMPAT_VISIBILITY_OUTSIDER,
  COMPAT_VISIBILITY_OWNER,
  createCompatVisibilityProjection,
  mintVisibilityToken,
  signedCompatVisibilityClient,
} from '../../support/phase4b-mcp-compat-visibility.js';
import type { McpApplicationFacade } from '../../../src/modules/mcp/index.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const apps: FastifyInstance[] = [];
const fixtures: Array<{ destroy(): void }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  for (const fixture of fixtures.splice(0)) fixture.destroy();
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

function startHostReadApp() {
  const collection = toolCollectionProjection();
  const snapshot = toolSnapshotProjection();
  const tools = hostReadToolAdapterBundle(collection, snapshot);
  return track(startCompatApp({
    mcpReadResourceProjection: collection,
    mcpSnapshotResourceProjection: snapshot,
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpReadTransport: {
      readToolAdapter: tools.adapter,
      readToolParamDeclarations: tools.paramDeclarations,
    },
  }));
}

function listedTool(
  response: { readonly headers: Record<string, unknown>; readonly payload: string },
  name: string,
): {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: {
    readonly type?: string;
    readonly additionalProperties?: unknown;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, { readonly type?: string }>>;
  };
} | undefined {
  const tools = compatJsonRpc(response).result?.tools as
    | readonly Record<string, unknown>[]
    | undefined;
  return tools?.find((tool) => tool.name === name) as ReturnType<typeof listedTool>;
}

function resultServerInfo(result: Record<string, unknown> | undefined): unknown {
  return (result?._meta as Readonly<Record<string, unknown>> | undefined)
    ?.['io.modelcontextprotocol/serverInfo'];
}

test('compat tools/list advertises catalog names and required fields, not additionalProperties:true', async () => {
  const server = startHostReadApp();
  const listed = await injectCompatLegacyPost(server.app, mcpCompatToolsListBody(2), COMPAT_REVISION);
  assert.equal(listed.statusCode, 200);
  const names = (compatJsonRpc(listed).result?.tools as readonly { readonly name: string }[] | undefined)
    ?.map((tool) => tool.name);
  assert.deepEqual(names, [...PHASE4B_MCP_READ_TOOL_NAMES]);
  assertNo0728WireFields(compatJsonRpc(listed).result);

  for (const catalog of PHASE4B_MCP_READ_TOOL_CATALOG) {
    const tool = listedTool(listed, catalog.name);
    assert.equal(tool?.description, catalog.description);
    assert.equal(tool?.inputSchema?.type, 'object');
    assert.notEqual(tool?.inputSchema?.additionalProperties, true);
    assert.ok(tool?.inputSchema?.required?.includes('collectionId'));
    assert.equal(tool?.inputSchema?.properties?.collectionId?.type, 'string');
    assert.equal(
      (tool?.inputSchema?.properties?.collectionId as { readonly 'x-mcp-header'?: string } | undefined)
        ?.['x-mcp-header'],
      undefined,
    );
  }
  assert.doesNotMatch(listed.payload, /"x-mcp-header"/u);
});

test('compat tools/call collections.get matches facade structured content without 07-28 keys', async () => {
  const server = startHostReadApp();
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('collections.get', 3, { collectionId: 'collection-1' }),
    COMPAT_REVISION,
  );
  assert.equal(called.statusCode, 200);
  const rpc = compatJsonRpc(called);
  assert.equal(rpc.error, undefined);
  const result = rpc.result ?? {};
  assert.equal('isError' in result && result.isError === true, false);
  assert.equal(
    (result.structuredContent as { collection?: { id?: string } } | undefined)?.collection?.id,
    'collection-1',
  );
  const getText = result.content as readonly { readonly type?: string; readonly text?: string }[] | undefined;
  assert.equal(getText?.[0]?.type, 'text');
  assert.equal(JSON.parse(getText?.[0]?.text ?? '{}').collection.id, 'collection-1');
  assertNo0728WireFields(result);
});

test('compat tools/call collections.get_snapshot returns resource_link content without 07-28 keys', async () => {
  const server = startHostReadApp();
  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('collections.get_snapshot', 4, { collectionId: 'collection-1' }),
    COMPAT_REVISION,
  );
  assert.equal(called.statusCode, 200);
  const result = compatJsonRpc(called).result ?? {};
  const content = result.content as readonly { readonly type?: string; readonly uri?: string; readonly text?: string }[] | undefined;
  assert.equal(content?.[0]?.type, 'text');
  assert.equal(JSON.parse(content?.[0]?.text ?? '{}').collection.id, 'collection-1');
  assert.equal(content?.[1]?.type, 'resource_link');
  assert.match(content?.[1]?.uri ?? '', /\/collections\/collection-1\/snapshot$/u);
  assert.equal(
    (result.structuredContent as { collection?: { id?: string } } | undefined)?.collection?.id,
    'collection-1',
  );
  assertNo0728WireFields(result);
});

test('missing collectionId maps to a stable error via the facade catalog schema', async () => {
  const server = startHostReadApp();
  const missing = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('collections.get', 9, {}),
    COMPAT_REVISION,
  );
  assert.equal(missing.statusCode, 200);
  const result = compatJsonRpc(missing).result ?? {};
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Invalid tool arguments/u);
  assert.doesNotMatch(missing.payload, /McpToolInputError|instancePath|relation /u);
});

test('OAuth owner and member can call collections.get on authorized collections; outsider cannot', async () => {
  const fixture = createCompatVisibilityProjection();
  fixtures.push(fixture);
  const { key, verifier } = await signedCompatVisibilityClient();
  const tools = hostReadToolAdapterBundle(fixture.projection, emptySnapshotResourceProjection());
  const server = track(startCompatApp({
    mcpReadResourceProjection: fixture.projection,
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    mcpReadTransport: {
      oauthVerifier: verifier,
      readToolAdapter: tools.adapter,
      readToolParamDeclarations: tools.paramDeclarations,
    },
  }));
  const get = (id: number, collectionId: string, authorization?: string) =>
    injectCompatLegacyPost(
      server.app,
      mcpCompatToolsCallBody('collections.get', id, { collectionId }),
      COMPAT_REVISION,
      authorization === undefined ? {} : { authorization },
    );
  const collectionIdOf = (payload: { readonly headers: Record<string, unknown>; readonly payload: string }) =>
    (compatJsonRpc(payload).result?.structuredContent as { collection?: { id?: string } } | undefined)
      ?.collection?.id;

  const anonymousPublic = await get(30, 'public-a');
  assert.equal(collectionIdOf(anonymousPublic), 'public-a');
  assertNo0728WireFields(compatJsonRpc(anonymousPublic).result);
  const anonymousPrivate = await get(31, 'private');
  assert.equal(compatJsonRpc(anonymousPrivate).result?.isError, true);
  assert.match(JSON.stringify(compatJsonRpc(anonymousPrivate).result?.content), /Tool result unavailable/u);
  assert.doesNotMatch(anonymousPrivate.payload, /"private"|visibility|ownerSubjectId/u);

  const ownerAuth = `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_OWNER, 't05-tool-owner')}`;
  const ownerPrivate = await get(32, 'private', ownerAuth);
  assert.equal(collectionIdOf(ownerPrivate), 'private');
  assertNo0728WireFields(compatJsonRpc(ownerPrivate).result);
  const ownerProtected = await get(33, 'protected-owner', ownerAuth);
  assert.equal(collectionIdOf(ownerProtected), 'protected-owner');

  const memberAuth = `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_MEMBER, 't05-tool-member')}`;
  const memberProtected = await get(34, 'protected-member', memberAuth);
  assert.equal(collectionIdOf(memberProtected), 'protected-member');

  const outsiderAuth = `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_OUTSIDER, 't05-tool-out')}`;
  const outsiderPrivate = await get(35, 'private', outsiderAuth);
  assert.equal(compatJsonRpc(outsiderPrivate).result?.isError, true);
  assert.doesNotMatch(outsiderPrivate.payload, /"private"|protected-member|ownerSubjectId/u);
  const outsiderProtected = await get(36, 'protected-member', outsiderAuth);
  assert.equal(compatJsonRpc(outsiderProtected).result?.isError, true);
});

test('unknown and private tool calls map to stable errors without leaking targets or DB strings', async () => {
  const server = startHostReadApp();
  const unknown = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('not.a.tool', 5, { collectionId: 'collection-1' }),
    COMPAT_REVISION,
  );
  assert.equal(unknown.statusCode, 200);
  const unknownResult = compatJsonRpc(unknown).result ?? {};
  assert.equal(unknownResult.isError, true);
  assert.match(JSON.stringify(unknownResult.content), /Unknown tool/u);
  assert.doesNotMatch(unknown.payload, /not\.a\.tool|relation |SELECT /u);

  const privateCall = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('collections.get', 6, { collectionId: 'private-collection' }),
    COMPAT_REVISION,
  );
  assert.equal(privateCall.statusCode, 200);
  const privateResult = compatJsonRpc(privateCall).result ?? {};
  assert.equal(privateResult.isError, true);
  assert.match(JSON.stringify(privateResult.content), /Tool result unavailable/u);
  assert.doesNotMatch(privateCall.payload, /private-collection/u);
});

test('over-budget tool output and abort map to stable errors without leaking internals', async () => {
  const huge = toolCollectionProjection();
  const original = huge.readResource.bind(huge);
  const collection = Object.freeze({
    ...huge,
    async readResource(input: Parameters<typeof huge.readResource>[0], context: Parameters<typeof huge.readResource>[1]) {
      if (context.abortSignal.aborted) throw new McpReadRequestAbortedError();
      const read = await original(input, context);
      const parsed = JSON.parse(read.contents[0]!.text) as {
        readonly collection: Record<string, unknown>;
      };
      return Object.freeze({
        contents: Object.freeze([
          Object.freeze({
            ...read.contents[0]!,
            text: JSON.stringify({
              collection: {
                ...parsed.collection,
                items: Array.from({ length: 10_000 }, () => 'x'),
              },
            }),
          }),
        ]),
      });
    },
  });
  const tools = hostReadToolAdapterBundle(collection, toolSnapshotProjection());
  const server = track(startCompatApp({
    mcpReadResourceProjection: collection,
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    mcpReadTransport: {
      readToolAdapter: tools.adapter,
      readToolParamDeclarations: tools.paramDeclarations,
    },
  }));
  const overBudget = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('collections.get', 7, { collectionId: 'collection-1' }),
    COMPAT_REVISION,
  );
  assert.equal(overBudget.statusCode, 200);
  assert.equal(compatJsonRpc(overBudget).result?.isError, true);
  assert.match(JSON.stringify(compatJsonRpc(overBudget).result?.content), /Tool result unavailable/u);
  assert.doesNotMatch(overBudget.payload, /items|10_000|relation /u);

  const abortFacade: McpApplicationFacade = pingMcpApplicationFacade();
  const aborting: McpApplicationFacade = Object.freeze({
    ...abortFacade,
    async listTools() {
      return Object.freeze({
        tools: Object.freeze([
          Object.freeze({
            name: 'collections.get',
            description: 'Get metadata for one Collection.',
            inputSchema: PHASE4B_MCP_READ_TOOL_CATALOG[0]!.inputSchema,
            requiredScopes: Object.freeze([]),
          }),
        ]),
      });
    },
    async callTool() {
      throw new McpReadRequestAbortedError();
    },
  });
  const abortServer = track(startCompatApp({
    mcpReadTransport: { applicationFacade: aborting },
  }));
  const cancelled = await injectCompatLegacyPost(
    abortServer.app,
    mcpCompatToolsCallBody('collections.get', 8, { collectionId: 'collection-1' }),
    COMPAT_REVISION,
  );
  assert.equal(cancelled.statusCode, 200);
  const cancelledResult = compatJsonRpc(cancelled).result ?? {};
  assert.equal(cancelledResult.isError, true);
  assert.match(JSON.stringify(cancelledResult.content), /cancelled/iu);
  assert.doesNotMatch(cancelled.payload, /McpReadRequestAbortedError|AbortError/u);
});

test('strict tools/list and tools/call still carry 07-28 resultType, cache, and serverInfo', async () => {
  const server = startHostReadApp();
  const listed = await injectStrictPost(server.app, 'tools/list', 20);
  assert.equal(listed.statusCode, 200);
  const listPayload = JSON.parse(listed.payload) as {
    readonly result?: Record<string, unknown>;
  };
  assert.equal(listPayload.result?.resultType, 'complete');
  assert.equal(typeof listPayload.result?.cacheScope, 'string');
  assert.equal('ttlMs' in (listPayload.result ?? {}), true);
  assert.equal(typeof resultServerInfo(listPayload.result), 'object');

  const called = await injectStrictPost(server.app, 'tools/call', 21, {
    'mcp-name': 'collections.get',
    'mcp-param-x-collection-id': 'collection-1',
  }, modernBody('tools/call', 21, {
    name: 'collections.get',
    arguments: { collectionId: 'collection-1' },
  }));
  assert.equal(called.statusCode, 200);
  const callPayload = JSON.parse(called.payload) as { readonly result?: Record<string, unknown> };
  assert.equal(callPayload.result?.resultType, 'complete');
  assert.equal(typeof resultServerInfo(callPayload.result), 'object');
});
