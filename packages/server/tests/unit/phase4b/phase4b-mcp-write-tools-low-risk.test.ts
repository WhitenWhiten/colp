/**
 * Low-risk nodes.update / collections.update / annotations.* complete through
 * the in-memory write fixture. Companion to phase4b-mcp-write-tools.test.ts.
 */
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
  createMcpOauthVerifier,
} from '../../../src/modules/mcp/index.js';
import {
  listedNodesCreateInputSchema,
  minimalNodesCreateArgumentsFromListedSchema,
} from '../../support/phase4b-mcp-node-create-catalog.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  AUDIENCE,
  ISSUER,
  NOW,
  READ_SCOPES,
  WRITE_SCOPES,
  authFixture,
  closeWriteToolApps,
  commitArguments,
  createKeyFixture,
  directContext,
  mcpEnv,
  mintCredential,
  modernBody,
  nodeCreateArguments,
  parseJsonRpc,
  planArguments,
  postJson,
  startApi,
  staticJwksProvider,
  verifiedBinding,
} from '../../support/phase4b-mcp-write-tools-http.js';

afterEach(async () => {
  await closeWriteToolApps();
});

test('nodes.update and collections.update complete through the in-memory write fixture', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const collectionId = 'col-1';
  const param = encodeMcp20260728ParamValue(collectionId);
  const nodeResponse = await postJson(server, 'tools/call', 18, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.update',
      [`mcp-param-${PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER}`]: param,
    },
    body: modernBody('tools/call', 18, {
      name: 'nodes.update',
      arguments: {
        collectionId,
        nodeId: 'node-1',
        baseRevision: 'rev-1',
        patch: { title: 'Updated title' },
      },
    }),
  });
  assert.equal(nodeResponse.status, 200);
  const nodePayload = parseJsonRpc(await nodeResponse.text());
  assert.equal(nodePayload.error, undefined);
  const nodeContent = nodePayload.result?.structuredContent as {
    readonly resultType?: string;
    readonly nodeId?: string;
    readonly revision?: string;
  };
  assert.equal(nodeContent.resultType, 'complete');
  assert.equal(nodeContent.nodeId, 'node-1');
  assert.equal(nodeContent.revision, 'revision-w06-updated');

  const collectionResponse = await postJson(server, 'tools/call', 19, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'collections.update',
      [`mcp-param-${PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER}`]: param,
    },
    body: modernBody('tools/call', 19, {
      name: 'collections.update',
      arguments: {
        collectionId,
        baseRevision: 'rev-1',
        patch: { title: 'Updated library' },
      },
    }),
  });
  assert.equal(collectionResponse.status, 200);
  const collectionPayload = parseJsonRpc(await collectionResponse.text());
  assert.equal(collectionPayload.error, undefined);
  const collectionContent = collectionPayload.result?.structuredContent as {
    readonly resultType?: string;
    readonly title?: string;
    readonly revision?: string;
  };
  assert.equal(collectionContent.resultType, 'complete');
  assert.equal(collectionContent.title, 'Updated library');
  assert.equal(collectionContent.revision, 'revision-w06-collection');
});

test('annotations.create and annotations.update complete through the in-memory write fixture', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const collectionId = 'col-1';
  const param = encodeMcp20260728ParamValue(collectionId);
  const createResponse = await postJson(server, 'tools/call', 20, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'annotations.create',
      [`mcp-param-${PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER}`]: param,
    },
    body: modernBody('tools/call', 20, {
      name: 'annotations.create',
      arguments: {
        collectionId,
        nodeId: 'node-1',
        value: 'A useful note',
      },
    }),
  });
  assert.equal(createResponse.status, 200);
  const createPayload = parseJsonRpc(await createResponse.text());
  assert.equal(createPayload.error, undefined);
  const createContent = createPayload.result?.structuredContent as {
    readonly resultType?: string;
    readonly annotationId?: string;
    readonly type?: string;
    readonly revision?: string;
  };
  assert.equal(createContent.resultType, 'complete');
  assert.equal(createContent.annotationId, 'ann-w06-1');
  assert.equal(createContent.type, 'note');
  assert.equal(createContent.revision, 'revision-w06-annotation');

  const updateResponse = await postJson(server, 'tools/call', 21, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'annotations.update',
      [`mcp-param-${PHASE4B_MCP_WRITE_COLLECTION_ID_HEADER}`]: param,
    },
    body: modernBody('tools/call', 21, {
      name: 'annotations.update',
      arguments: {
        collectionId,
        annotationId: 'ann-w06-1',
        baseRevision: 'rev-1',
        patch: { value: 'Updated note' },
      },
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updatePayload = parseJsonRpc(await updateResponse.text());
  assert.equal(updatePayload.error, undefined);
  const updateContent = updatePayload.result?.structuredContent as {
    readonly resultType?: string;
    readonly annotationId?: string;
    readonly revision?: string;
  };
  assert.equal(updateContent.resultType, 'complete');
  assert.equal(updateContent.annotationId, 'ann-w06-1');
  assert.equal(updateContent.revision, 'revision-w06-annotation-updated');
});

