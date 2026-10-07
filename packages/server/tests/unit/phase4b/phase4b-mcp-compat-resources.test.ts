/**
 * T-05: legacy resources list/templates/read mapping through the shared facade.
 * Wire envelope does not include 07-28 fields. Privacy lives in the sibling
 * `phase4b-mcp-compat-resource-privacy` file.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  McpToolOutputUnavailableError,
} from '@know-n/colp/mcp';
import {
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
  type McpApplicationFacade,
} from '../../../src/modules/mcp/index.js';
import {
  assertNo0728WireFields,
  compatJsonRpc,
  injectCompatLegacyPost,
  injectStrictPost,
  pingMcpApplicationFacade,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatResourceTemplatesListBody,
  mcpCompatResourcesListBody,
  mcpCompatResourcesReadBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  collectionResourceUri,
  countProjectionListCalls,
  createCompatVisibilityProjection,
  listedCollectionIds,
} from '../../support/phase4b-mcp-compat-visibility.js';
import {
  SERVER_UUID,
  emptyNodeResourceProjection,
  emptySnapshotResourceProjection,
  modernBody,
  toolSnapshotProjection,
} from '../../support/phase4b-mcp-transport-scaffold.js';

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

function startProjectionApp(
  projection: ReturnType<typeof createCompatVisibilityProjection>['projection'],
  snapshot = emptySnapshotResourceProjection(),
) {
  return track(startCompatApp({
    mcpReadResourceProjection: projection,
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: snapshot,
  }));
}

function resultServerInfo(result: Record<string, unknown> | undefined): unknown {
  return (result?._meta as Readonly<Record<string, unknown>> | undefined)
    ?.['io.modelcontextprotocol/serverInfo'];
}

function capturingReadFacade(options: {
  readonly list?: McpApplicationFacade['listResources'];
  readonly read?: McpApplicationFacade['readResource'];
  readonly templates?: McpApplicationFacade['listResourceTemplates'];
} = {}): { readonly facade: McpApplicationFacade; readonly lists: Array<string | undefined> } {
  const lists: Array<string | undefined> = [];
  const base = pingMcpApplicationFacade();
  const facade: McpApplicationFacade = Object.freeze({
    ...base,
    async listResources(context, cursor) {
      lists.push(cursor);
      if (options.list !== undefined) return options.list(context, cursor);
      return Object.freeze({
        resources: Object.freeze([
          Object.freeze({
            uri: collectionResourceUri('public-a'),
            name: 'Public A',
            mimeType: PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
            description: 'A public collection',
          }),
        ]),
        ...(cursor === undefined ? { nextCursor: 'page-2' } : {}),
      });
    },
    async listResourceTemplates(context, cursor) {
      if (options.templates !== undefined) return options.templates(context, cursor);
      return base.listResourceTemplates(context, cursor);
    },
    async readResource(context, uri) {
      if (options.read !== undefined) return options.read(context, uri);
      return base.readResource(context, uri);
    },
  });
  return { facade, lists };
}

test('resources/list calls the facade once and round-trips nextCursor', async () => {
  const { facade, lists } = capturingReadFacade();
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: facade },
  }));
  const first = await injectCompatLegacyPost(server.app, mcpCompatResourcesListBody(10), COMPAT_REVISION);
  assert.equal(first.statusCode, 200);
  const firstResult = compatJsonRpc(first).result ?? {};
  assert.equal(firstResult.nextCursor, 'page-2');
  assert.deepEqual(listedCollectionIds(first), ['public-a']);
  assertNo0728WireFields(firstResult);
  assert.equal(lists.length, 1);
  assert.equal(lists[0], undefined);

  const second = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(11, { cursor: 'page-2' }),
    COMPAT_REVISION,
  );
  assert.equal(second.statusCode, 200);
  assert.equal(compatJsonRpc(second).result?.nextCursor, undefined);
  assert.equal(lists.length, 2);
  assert.equal(lists[1], 'page-2');
});

test('resources/list paginates through the signed projection cursor once per request', async () => {
  const fixture = createCompatVisibilityProjection(1);
  fixtures.push(fixture);
  const counted = countProjectionListCalls(fixture.projection);
  const server = startProjectionApp(counted.projection);
  const first = await injectCompatLegacyPost(server.app, mcpCompatResourcesListBody(12), COMPAT_REVISION);
  assert.equal(first.statusCode, 200);
  const firstIds = listedCollectionIds(first);
  assert.deepEqual(firstIds, ['public-b']);
  const nextCursor = compatJsonRpc(first).result?.nextCursor;
  assert.equal(typeof nextCursor, 'string');
  assert.match(String(nextCursor), /^mcr1\./u);
  assert.doesNotMatch(String(nextCursor), /public-a|public-b|subject-owner|subject-member/u);
  assertNo0728WireFields(compatJsonRpc(first).result);
  assert.equal(counted.lists.count, 1);

  const second = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(13, { cursor: String(nextCursor) }),
    COMPAT_REVISION,
  );
  assert.equal(second.statusCode, 200);
  const secondIds = listedCollectionIds(second);
  assert.deepEqual(secondIds, ['public-a']);
  assert.equal(compatJsonRpc(second).result?.nextCursor, undefined);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 2);
  assert.equal(counted.lists.count, 2);
});

test('resources/templates/list reuses identity templates and omits 07-28 fields', async () => {
  const fixture = createCompatVisibilityProjection();
  fixtures.push(fixture);
  const listed = await injectCompatLegacyPost(
    startProjectionApp(fixture.projection).app,
    mcpCompatResourceTemplatesListBody(30),
    COMPAT_REVISION,
  );
  assert.equal(listed.statusCode, 200);
  const templates = compatJsonRpc(listed).result?.resourceTemplates as
    | readonly { readonly name?: string; readonly uriTemplate?: string }[]
    | undefined;
  assert.deepEqual(templates?.map((entry) => entry.name), ['collection', 'collection-node']);
  assert.equal(templates?.[0]?.uriTemplate, `colp://${SERVER_UUID}/collections/{collectionId}`);
  assertNo0728WireFields(compatJsonRpc(listed).result);
});

test('resources/read of public collection and snapshot omits 07-28 fields', async () => {
  const fixture = createCompatVisibilityProjection();
  fixtures.push(fixture);
  const server = startProjectionApp(fixture.projection, toolSnapshotProjection());
  const read = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(collectionResourceUri('public-a'), 40),
    COMPAT_REVISION,
  );
  assert.equal(read.statusCode, 200);
  const result = compatJsonRpc(read).result ?? {};
  const text = (result.contents as readonly { readonly text?: string }[] | undefined)?.[0]?.text;
  assert.equal(JSON.parse(text ?? '{}').collection.id, 'public-a');
  assertNo0728WireFields(result);

  const snapshot = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(`${collectionResourceUri('public-a')}/snapshot`, 41),
    COMPAT_REVISION,
  );
  assert.equal(snapshot.statusCode, 200);
  assertNo0728WireFields(compatJsonRpc(snapshot).result);
});

test('unknown and invalid URIs return a stable error without crashing or leaking internals', async () => {
  const fixture = createCompatVisibilityProjection();
  fixtures.push(fixture);
  const server = startProjectionApp(fixture.projection);
  const unknown = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(collectionResourceUri('missing'), 50),
    COMPAT_REVISION,
  );
  const unknownRpc = compatJsonRpc(unknown);
  assert.equal(unknownRpc.error?.code, -32_602);
  assert.match(unknownRpc.error?.message ?? '', /Resource not found/u);
  assert.doesNotMatch(unknown.payload, /relation |SELECT /u);

  const invalid = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody('https://example.test/not-colp', 51),
    COMPAT_REVISION,
  );
  const invalidRpc = compatJsonRpc(invalid);
  assert.equal(invalidRpc.error?.code, -32_602);
  assert.match(invalidRpc.error?.message ?? '', /Invalid Resource URI/u);
  assert.doesNotMatch(invalid.payload, /serverUuid|opaqueId/u);

  const { facade } = capturingReadFacade({
    async read() {
      throw new Error('relation "collections" does not exist');
    },
  });
  const leaky = await injectCompatLegacyPost(
    track(startCompatApp({ mcpReadTransport: { applicationFacade: facade } })).app,
    mcpCompatResourcesReadBody(collectionResourceUri('public-a'), 52),
    COMPAT_REVISION,
  );
  assert.ok(leaky.statusCode >= 400 || compatJsonRpc(leaky).error !== undefined);
  assert.doesNotMatch(leaky.payload, /relation "collections"/u);
});

test('abort, invalid cursor, and over-budget read map to stable errors', async () => {
  const aborting = capturingReadFacade({
    async read() {
      throw new McpReadRequestAbortedError();
    },
    async list() {
      throw new McpReadRequestAbortedError();
    },
  });
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: aborting.facade },
  }));
  const read = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(collectionResourceUri('public-a'), 60),
    COMPAT_REVISION,
  );
  assert.ok(compatJsonRpc(read).error);
  assert.match(compatJsonRpc(read).error?.message ?? '', /cancelled/iu);
  assert.doesNotMatch(read.payload, /McpReadRequestAbortedError/u);

  const listed = await injectCompatLegacyPost(server.app, mcpCompatResourcesListBody(61), COMPAT_REVISION);
  assert.ok(compatJsonRpc(listed).error);
  assert.match(compatJsonRpc(listed).error?.message ?? '', /cancelled/iu);

  const cursoring = capturingReadFacade({
    async list() {
      throw new McpReadRequestContextError();
    },
  });
  const badCursor = await injectCompatLegacyPost(
    track(startCompatApp({ mcpReadTransport: { applicationFacade: cursoring.facade } })).app,
    mcpCompatResourcesListBody(62, { cursor: 'not-a-cursor' }),
    COMPAT_REVISION,
  );
  assert.equal(compatJsonRpc(badCursor).error?.code, -32_602);
  assert.match(compatJsonRpc(badCursor).error?.message ?? '', /cursor/iu);

  const overBudget = capturingReadFacade({
    async read() {
      throw new McpToolOutputUnavailableError();
    },
  });
  const over = await injectCompatLegacyPost(
    track(startCompatApp({ mcpReadTransport: { applicationFacade: overBudget.facade } })).app,
    mcpCompatResourcesReadBody(collectionResourceUri('public-a'), 63),
    COMPAT_REVISION,
  );
  assert.equal(compatJsonRpc(over).error?.code, -32_602);
  assert.match(compatJsonRpc(over).error?.message ?? '', /unavailable/iu);
  assert.doesNotMatch(over.payload, /McpToolOutputUnavailableError|relation /u);
});

test('compat does not claim prompts or resource subscriptions', async () => {
  const server = track(startCompatApp({
    mcpReadTransport: { applicationFacade: pingMcpApplicationFacade() },
  }));
  const subscribe = await injectCompatLegacyPost(
    server.app,
    { jsonrpc: '2.0', id: 70, method: 'resources/subscribe', params: { uri: 'compat://ping' } },
    COMPAT_REVISION,
  );
  assert.equal(compatJsonRpc(subscribe).error?.code, -32_601);
  const prompts = await injectCompatLegacyPost(
    server.app,
    { jsonrpc: '2.0', id: 71, method: 'prompts/list', params: {} },
    COMPAT_REVISION,
  );
  assert.equal(compatJsonRpc(prompts).error?.code, -32_601);
});

test('strict resources/list still includes 07-28 resultType, cache, and item _meta', async () => {
  const fixture = createCompatVisibilityProjection();
  fixtures.push(fixture);
  const server = startProjectionApp(fixture.projection);
  const listed = await injectStrictPost(server.app, 'resources/list', 80);
  assert.equal(listed.statusCode, 200);
  const payload = JSON.parse(listed.payload) as { readonly result?: Record<string, unknown> };
  assert.equal(payload.result?.resultType, 'complete');
  assert.equal(typeof payload.result?.cacheScope, 'string');
  const items = payload.result?.resources as readonly { readonly _meta?: unknown }[] | undefined;
  assert.equal(typeof items?.[0]?._meta, 'object');
  assert.equal(typeof resultServerInfo(payload.result), 'object');

  const uri = collectionResourceUri('public-a');
  const read = await injectStrictPost(server.app, 'resources/read', 81, {
    'mcp-name': uri,
  }, modernBody('resources/read', 81, { uri }));
  assert.equal(read.statusCode, 200);
  const readPayload = JSON.parse(read.payload) as { readonly result?: Record<string, unknown> };
  assert.equal(readPayload.result?.resultType, 'complete');
});
