import assert from 'node:assert/strict';
import { test } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  MCP_COMPAT_PROTOCOL_VERSIONS, createPhase4bMcpReadToolAdapter, createPhase4bMcpResourceIdentity,
  type Phase4bMcpOwnedCollectionReadPort, type Phase4bMcpOwnedCollectionRecord,
  type Phase4bMcpOwnedNodeRecord,
} from '../../../src/modules/mcp/index.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import { compatJsonRpc, injectCompatLegacyPost, startCompatApp } from '../../support/phase4b-mcp-compat-admission.js';
import { signedCompatWriteClient } from '../../support/phase4b-mcp-compat-write.js';
import {
  mcpCompatToolsCallBody, mcpCompatToolsListBody, postCompatLegacyFetch,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  emptyResourceProjection, emptySnapshotResourceProjection, emptyNodeResourceProjection,
  mcpEnv, NOW, SERVER_UUID, SUBJECT,
} from '../../support/phase4b-mcp-transport-scaffold.js';
import { loadConfig } from '../../support/test-config.js';
import { createMcpJsonProbeHandler } from '../../../scripts/mcp-json-probe.mjs';

test('owned library reads publish schemas and return inline JSON through the production compat HTTP adapter', async () => {
  const auth = await signedCompatWriteClient(['mcp:read:own']);
  const collection: Phase4bMcpOwnedCollectionRecord = {
    id: 'private-library', kind: 'bookmarks', title: 'Private bookmarks', summary: null,
    visibility: 'private', rootNodeId: 'root', publicationSlug: null,
    resourceRevision: 'res-1', contentRevision: 'cnt-1', policyRevision: 'pol-1',
    createdAt: NOW, updatedAt: NOW,
  };
  const root: Phase4bMcpOwnedNodeRecord = {
    id: 'root', collectionId: collection.id, parentId: null, kind: 'folder', isRoot: true,
    title: collection.title, url: null, description: null, visibility: 'inherit', positionToken: null,
    resourceRevision: 'node-1', childrenRevision: 'children-1', createdAt: NOW, updatedAt: NOW,
  };
  const firstNode = { ...root, id: 'bookmark-1', parentId: root.id, isRoot: false,
    kind: 'bookmark' as const, title: 'First bookmark', url: 'https://example.test/1' };
  const secondNode = { ...firstNode, id: 'bookmark-2', title: 'Second bookmark', url: 'https://example.test/2' };
  const ownedRead: Phase4bMcpOwnedCollectionReadPort = {
    async readCollection(input) {
      assert.equal(input.actorSubjectId, SUBJECT);
      return collection;
    },
    async readNode(input) {
      assert.equal(input.actorSubjectId, SUBJECT);
      return firstNode;
    },
    async readSnapshot(input) {
      assert.equal(input.actorSubjectId, SUBJECT);
      if (input.after) assert.equal(input.after.nodeId, firstNode.id);
      return { collection, root, nodes: input.after ? [secondNode] : [firstNode],
        hasMore: !input.after, nextAfter: input.after ? null : {
          contentRevision: 'cnt-1', policyRevision: 'pol-1', parentKey: root.id,
          positionKey: 'position-1', nodeId: firstNode.id,
        } };
    },
  };
  const collectionProjection = emptyResourceProjection();
  const snapshotProjection = emptySnapshotResourceProjection();
  const nodeProjection = emptyNodeResourceProjection();
  const tools = createPhase4bMcpReadToolAdapter({
    collectionProjection, snapshotProjection, nodeProjection, ownedRead, serverUuid: SERVER_UUID,
  });
  const facade = createPhase4bMcpApplicationFacadeFromColpAdapters({
    resourceIdentity: createPhase4bMcpResourceIdentity(loadConfig(mcpEnv()).mcp!),
    collectionProjection, snapshotProjection, nodeProjection, readToolAdapter: tools.adapter,
    ownedCollectionsQuery: {
      reads: { async listOwnedCollections(input) {
        assert.equal(input.ownerSubjectId, SUBJECT);
        return [{ ...collection, kind: 'bookmarks' as const, isLibrary: true,
          allowSearchIndexing: false, publishedAt: null }];
      } },
      cursors: { sign: () => { throw new Error('unexpected list cursor'); },
        verify: () => { throw new Error('unexpected list cursor'); }, destroy() {} },
      clock: { now: async () => NOW },
    },
  });
  const { app } = startCompatApp({ mcpReadTransport: {
    oauthVerifier: auth.verifier, applicationFacade: facade,
    readToolAdapter: tools.adapter, readToolParamDeclarations: tools.paramDeclarations,
  } });
  try {
    for (const version of MCP_COMPAT_PROTOCOL_VERSIONS) {
      const headers = { authorization: `Bearer ${auth.token}` };
      const list = await injectCompatLegacyPost(app, mcpCompatToolsListBody(), version, headers);
      assert.equal(list.statusCode, 200);
      const descriptors = compatJsonRpc(list).result?.tools as Record<string, unknown>[];
      const ajv = new Ajv2020({ strict: false });
      const call = async (name: string, args: Record<string, unknown>) => {
        const descriptor = descriptors.find(tool => tool.name === name);
        assert.ok(descriptor, name);
        assert.deepEqual(descriptor.annotations, {
          readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
        });
        assert.ok(descriptor.outputSchema, name);
        const response = await injectCompatLegacyPost(app, mcpCompatToolsCallBody(name, 3, args), version, headers);
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-disposition'], undefined);
        const rpc = compatJsonRpc(response);
        assert.equal(rpc.error, undefined);
        const result = rpc.result!;
        assert.deepEqual(Object.keys(result).sort(), ['content', 'structuredContent']);
        const blocks = result.content as { type: string; text: string }[];
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0]?.type, 'text');
        assert.deepEqual(JSON.parse(blocks[0]!.text), result.structuredContent);
        const validate = ajv.compile(descriptor.outputSchema);
        assert.equal(validate(result.structuredContent), true, JSON.stringify(validate.errors));
        return result.structuredContent as Record<string, unknown>;
      };
      const libraryList = await call('collections.list', {});
      assert.equal((libraryList.collections as { library: boolean }[])[0]?.library, true);
      await call('collections.get', { collectionId: collection.id });
      await call('nodes.get', { collectionId: collection.id, nodeId: firstNode.id });
      const first = await call('collections.get_snapshot', { collectionId: collection.id });
      const page = first.page as { hasMore: boolean; nextCursor: string };
      assert.equal(page.hasMore, true);
      assert.ok(page.nextCursor.startsWith('own2.'));
      const second = await call('collections.get_snapshot', { collectionId: collection.id, cursor: page.nextCursor });
      assert.equal((second.nodes as { id: string }[])[0]?.id, secondNode.id);
      assert.equal((second.page as { hasMore: boolean }).hasMore, false);
    }
  } finally {
    await app.close();
  }
});

for (const textOnly of [false, true]) {
  test(`isolated JSON probe has one read-only tool and fixed inline output (textOnly=${textOnly})`, async () => {
    const handler = createMcpJsonProbeHandler({ textOnly });
    for (const version of MCP_COMPAT_PROTOCOL_VERSIONS) {
      const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': version };
      const listed = await postCompatLegacyFetch(handler, mcpCompatToolsListBody(), headers);
      assert.equal(listed.status, 200);
      const tools = (listed.payload as { result: { tools: Record<string, unknown>[] } }).result.tools;
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.name, 'diagnostics.ping');
      assert.equal((tools[0]?.annotations as { readOnlyHint: boolean }).readOnlyHint, true);
      assert.equal(tools[0]?.outputSchema !== undefined, !textOnly);
      const called = await postCompatLegacyFetch(handler, mcpCompatToolsCallBody('diagnostics.ping'), headers);
      assert.equal(called.status, 200);
      assert.equal(called.headers.get('content-disposition'), null);
      const result = (called.payload as { result: Record<string, unknown> }).result;
      assert.deepEqual(result, {
        content: [{ type: 'text', text: '{"ok":true}' }],
        ...(!textOnly ? { structuredContent: { ok: true } } : {}),
      });
    }
  });
}
