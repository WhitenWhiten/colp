/**
 * Plan/commit protocol, requestState binding, timeout, and catalog-schema
 * Write Tool contracts. Companion to phase4b-mcp-write-tools.test.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { createMcpOauthVerifier } from '../../../src/modules/mcp/index.js';
import {
  listedNodesCreateInputSchema,
  minimalNodesCreateArgumentsFromListedSchema,
} from '../../support/phase4b-mcp-node-create-catalog.js';
import { createInMemoryWriteToolFixture } from '../../support/phase4b-mcp-write-tools-fixture.js';
import {
  AUDIENCE,
  ISSUER,
  NOW,
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

test('pending Plan and Commit use MRTR input_required, and a new request retry commits after out-of-band approval', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const authorization = `Bearer ${auth.token}`;

  const planResponse = await postJson(server, 'tools/call', 20, {
    headers: { authorization, 'mcp-name': 'changes.plan' },
    body: modernBody('tools/call', 20, { name: 'changes.plan', arguments: planArguments() }),
  });
  const planPayload = parseJsonRpc(await planResponse.text());
  assert.equal(planPayload.result?.resultType, 'input_required');
  assert.deepEqual(planPayload.result?.inputRequests, {});
  assert.equal(typeof planPayload.result?.requestState, 'string');
  const planId = (planPayload.result?.plan as { planId?: string }).planId;
  assert.ok(planId);
  assert.equal(planPayload.result?.elicitationId, undefined);
  assert.equal(planPayload.result?.completion, undefined);
  assert.doesNotMatch(JSON.stringify(planPayload), /notifications|roots|sampling/iu);

  const commitWait = await postJson(server, 'tools/call', 21, {
    headers: { authorization, 'mcp-name': 'changes.commit' },
    body: modernBody('tools/call', 21, {
      name: 'changes.commit',
      arguments: commitArguments(planId!),
    }),
  });
  const waitPayload = parseJsonRpc(await commitWait.text());
  assert.equal(waitPayload.result?.resultType, 'input_required');
  const commitState = waitPayload.result?.requestState as string;
  assert.ok(commitState);

  const binding = await verifiedBinding(auth);
  await fixture.bundle.adapter.recordOutOfBandApproval(planId!, directContext(binding, WRITE_SCOPES));

  const retry = await postJson(server, 'tools/call', 22, {
    headers: { authorization, 'mcp-name': 'changes.commit' },
    body: modernBody('tools/call', 22, {
      name: 'changes.commit',
      arguments: commitArguments(planId!),
      requestState: commitState,
      inputResponses: { approval: { action: 'accept' } },
    }),
  });
  const retryPayload = parseJsonRpc(await retry.text());
  assert.equal(retryPayload.result?.resultType, 'complete');
  assert.equal(
    (retryPayload.result?.structuredContent as { planId?: string }).planId,
    planId,
  );
  assert.equal(retryPayload.result?.requestState, undefined);
  assert.equal(retryPayload.result?.inputRequests, undefined);
});

test('requestState is binding-bound and malformed inputResponses or legacy elicitation fields fail closed', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const key = await createKeyFixture('key-1');
  const token = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scopes: WRITE_SCOPES,
    jti: 'w06-credential-jti-1',
  });
  const otherToken = await mintCredential({
    key: key.privateKey,
    kid: key.kid,
    scopes: WRITE_SCOPES,
    subject: 'urn:known:subject:bob',
    jti: 'w06-credential-jti-2',
  });
  const verifier = createMcpOauthVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedScopes: [...WRITE_SCOPES],
    jwks: staticJwksProvider([key.jwk]),
    isRevoked: async () => false,
    securityEpoch: async () => 'epoch-1',
    now: () => NOW,
    clockToleranceSeconds: 0,
    resolveAccountBySubject: async (sub) => ({
      id: `account:${sub}`,
      subjectId: sub,
      status: 'active',
    }),
  });
  const server = await startApi(mcpEnv(WRITE_SCOPES), { verifier }, fixture);

  const plan = parseJsonRpc(await (await postJson(server, 'tools/call', 30, {
    headers: { authorization: `Bearer ${token}`, 'mcp-name': 'changes.plan' },
    body: modernBody('tools/call', 30, { name: 'changes.plan', arguments: planArguments() }),
  })).text());
  const state = plan.result?.requestState as string;

  const tampered = await postJson(server, 'tools/call', 31, {
    headers: { authorization: `Bearer ${token}`, 'mcp-name': 'changes.plan' },
    body: modernBody('tools/call', 31, {
      name: 'changes.plan',
      arguments: planArguments(),
      // Append, do not substitute the last base64url character: decoding ignores
      // its padding bits, so `…x` can still verify (COLP mcp.mrtr-contract).
      requestState: `${state}A`,
    }),
  });
  const tamperedPayload = parseJsonRpc(await tampered.text());
  assert.equal(tamperedPayload.error?.code, -32602);
  assert.equal(
    (tamperedPayload.error?.data as { code?: string }).code,
    'invalid_request_state',
  );

  const otherPrincipal = await postJson(server, 'tools/call', 32, {
    headers: { authorization: `Bearer ${otherToken}`, 'mcp-name': 'changes.plan' },
    body: modernBody('tools/call', 32, {
      name: 'changes.plan',
      arguments: planArguments(),
      requestState: state,
    }),
  });
  const otherPayload = parseJsonRpc(await otherPrincipal.text());
  assert.equal(otherPayload.error?.code, -32602);
  assert.equal(
    (otherPayload.error?.data as { code?: string }).code,
    'request_state_binding_mismatch',
  );

  const malformedResponses = await postJson(server, 'tools/call', 33, {
    headers: { authorization: `Bearer ${token}`, 'mcp-name': 'changes.plan' },
    body: modernBody('tools/call', 33, {
      name: 'changes.plan',
      arguments: planArguments(),
      requestState: state,
      inputResponses: { approval: 42 },
    }),
  });
  const responsePayload = parseJsonRpc(await malformedResponses.text());
  assert.equal(responsePayload.error?.code, -32602);
  assert.equal(
    (responsePayload.error?.data as { code?: string }).code,
    'invalid_input_responses',
  );

  const elicitation = await postJson(server, 'tools/call', 34, {
    headers: { authorization: `Bearer ${token}`, 'mcp-name': 'changes.plan' },
    body: modernBody('tools/call', 34, {
      name: 'changes.plan',
      arguments: planArguments(),
      elicitationId: 'legacy-elicitation',
    }),
  });
  const elicitationPayload = parseJsonRpc(await elicitation.text());
  assert.equal(elicitationPayload.error?.code, -32602);
});

test('Write Tool calls honor per-request timeout and concurrent POST slots', async () => {
  const slowFixture = createInMemoryWriteToolFixture({ nodeCreateDelayMs: 200 });
  const slowAuth = await authFixture(WRITE_SCOPES);
  const slowServer = await startApi(
    mcpEnv(WRITE_SCOPES),
    slowAuth,
    slowFixture,
    { requestTimeoutMs: 30 },
  );
  const timeout = await postJson(slowServer, 'tools/call', 40, {
    headers: {
      authorization: `Bearer ${slowAuth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: modernBody('tools/call', 40, {
      name: 'nodes.create',
      arguments: nodeCreateArguments(),
    }),
  });
  assert.equal(timeout.status, 408);

  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const [first, second] = await Promise.all([
    postJson(server, 'tools/call', 41, {
      headers: {
        authorization: `Bearer ${auth.token}`,
        'mcp-name': 'nodes.create',
        'mcp-param-X-Collection-Id': 'collection-1',
      },
      body: modernBody('tools/call', 41, {
        name: 'nodes.create',
        arguments: nodeCreateArguments('one'),
      }),
    }),
    postJson(server, 'tools/call', 42, {
      headers: {
        authorization: `Bearer ${auth.token}`,
        'mcp-name': 'nodes.create',
        'mcp-param-X-Collection-Id': 'collection-1',
      },
      body: modernBody('tools/call', 42, {
        name: 'nodes.create',
        arguments: nodeCreateArguments('two'),
      }),
    }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fixture.nodeCreateCalls.length, 2);
});

test('tools/list schema yields minimal legal folder and bookmark calls; invalid node shapes fail before write', async () => {
  const fixture = createInMemoryWriteToolFixture();
  const auth = await authFixture(WRITE_SCOPES);
  const server = await startApi(mcpEnv(WRITE_SCOPES), auth, fixture);
  const listed = parseJsonRpc(await (await postJson(server, 'tools/list', 50, {
    headers: { authorization: `Bearer ${auth.token}` },
  })).text());
  const schema = listedNodesCreateInputSchema(
    (listed.result?.tools ?? []) as readonly Readonly<Record<string, unknown>>[],
  );
  const folderArgs = minimalNodesCreateArgumentsFromListedSchema(schema, 'folder', 'preview');
  const bookmarkArgs = minimalNodesCreateArgumentsFromListedSchema(schema, 'bookmark', 'apply');
  const folder = await postJson(server, 'tools/call', 51, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: modernBody('tools/call', 51, { name: 'nodes.create', arguments: folderArgs }),
  });
  assert.equal(folder.status, 200);
  const folderPayload = parseJsonRpc(await folder.text());
  assert.equal(folderPayload.result?.resultType, 'complete');
  assert.equal(
    (folderPayload.result?.structuredContent as { resultType?: string } | undefined)?.resultType,
    'preview',
  );
  const bookmark = await postJson(server, 'tools/call', 52, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'mcp-name': 'nodes.create',
      'mcp-param-X-Collection-Id': 'collection-1',
    },
    body: modernBody('tools/call', 52, { name: 'nodes.create', arguments: bookmarkArgs }),
  });
  assert.equal(bookmark.status, 200);
  assert.equal(parseJsonRpc(await bookmark.text()).result?.resultType, 'complete');
  const accepted = fixture.nodeCreateCalls.length;
  const invalidNodes = Object.freeze([
    Object.freeze({ kind: 'bookmark', title: 'n', description: null, tags: Object.freeze([]), visibility: 'private' }),
    Object.freeze({ ...bookmarkArgs.node as object, url: null }),
    Object.freeze({ kind: 'folder', title: 'n', description: null, tags: Object.freeze([]), visibility: 'private', url: 'https://example.test/n' }),
  ]);
  let rpcId = 53;
  for (const node of invalidNodes) {
    const response = await postJson(server, 'tools/call', rpcId, {
      headers: {
        authorization: `Bearer ${auth.token}`,
        'mcp-name': 'nodes.create',
        'mcp-param-X-Collection-Id': 'collection-1',
      },
      body: modernBody('tools/call', rpcId, {
        name: 'nodes.create',
        arguments: {
          collectionId: 'collection-1',
          parentId: 'root-1',
          node,
          reason: 'create',
          confirmApply: true,
        },
      }),
    });
    rpcId += 1;
    assert.equal(response.status, 200, JSON.stringify(node));
    assert.equal(parseJsonRpc(await response.text()).error?.code, -32602, JSON.stringify(node));
  }
  assert.equal(fixture.nodeCreateCalls.length, accepted);
});
