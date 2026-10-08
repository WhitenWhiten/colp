/**
 * T-06: out-of-band write approval on `/collections/-/mcp-compat`.
 * Legacy clients retry `changes.commit` with the same planId only — no MRTR
 * `requestState` / `inputResponses`. A plan stays bound to the token audience,
 * so the sibling endpoint cannot commit it.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMcpOauthVerifier } from '../../../src/modules/mcp/index.js';
import { modernBody } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  mcpCompatToolsCallBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  assertCompatCallToolEnvelope,
  compatJsonRpc,
  injectCompatLegacyPost,
  injectStrictPost,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  COMPAT_REVISION,
  COMPAT_WRITE_SCOPES,
  assertAwaitingApproval,
  assertNoMrtrOrElicitation,
  assertRejectedWrite,
  commitArguments,
  createWriteFixture,
  mintCompatWriteToken,
  planArguments,
  signedCompatWriteClient,
  startCompatWriteApp,
  verifiedWriteBinding,
  writeApprovalContext,
} from '../../support/phase4b-mcp-compat-write.js';
import {
  AUDIENCE,
  staticJwksProvider,
  verifierOptions,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

async function callWrite(
  app: FastifyInstance,
  name: string,
  id: number,
  args: Readonly<Record<string, unknown>>,
  token: string,
) {
  return injectCompatLegacyPost(
    app,
    mcpCompatToolsCallBody(name, id, args),
    COMPAT_REVISION,
    { authorization: `Bearer ${token}` },
  );
}

test('changes.plan returns awaiting_approval; unapproved commit repeats it; approved commit uses planId only', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));
  const authorization = auth.token;

  const planned = await callWrite(server.app, 'changes.plan', 20, planArguments(), authorization);
  assert.equal(planned.statusCode, 200);
  const planFields = assertAwaitingApproval(compatJsonRpc(planned).result);
  assertNoMrtrOrElicitation(planned.payload);

  const waiting = await callWrite(
    server.app,
    'changes.commit',
    21,
    commitArguments(planFields.planId),
    authorization,
  );
  const waitFields = assertAwaitingApproval(compatJsonRpc(waiting).result, planFields.planId);
  assert.equal(waitFields.planId, planFields.planId);
  assertNoMrtrOrElicitation(waiting.payload);

  const binding = await verifiedWriteBinding(auth);
  await fixture.bundle.adapter.recordOutOfBandApproval(
    planFields.planId,
    writeApprovalContext(binding),
  );

  const committed = await callWrite(
    server.app,
    'changes.commit',
    22,
    commitArguments(planFields.planId),
    authorization,
  );
  assert.equal(committed.statusCode, 200);
  const result = compatJsonRpc(committed).result ?? {};
  assertCompatCallToolEnvelope(result);
  assert.equal(result.isError === true, false);
  assert.equal(
    (result.structuredContent as { planId?: string } | undefined)?.planId,
    planFields.planId,
  );
  assertNoMrtrOrElicitation(committed.payload);
});

test('duplicate commit with the same planId and idempotency key does not apply twice', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));
  const planned = await callWrite(server.app, 'changes.plan', 30, planArguments(), auth.token);
  const { planId } = assertAwaitingApproval(compatJsonRpc(planned).result);
  await fixture.bundle.adapter.recordOutOfBandApproval(
    planId,
    writeApprovalContext(await verifiedWriteBinding(auth)),
  );
  const first = await callWrite(server.app, 'changes.commit', 31, commitArguments(planId), auth.token);
  assert.equal(compatJsonRpc(first).result?.isError === true, false);
  const replay = await callWrite(server.app, 'changes.commit', 32, commitArguments(planId), auth.token);
  const replayResult = compatJsonRpc(replay).result ?? {};
  assertCompatCallToolEnvelope(replayResult);
  assert.equal(replayResult.isError === true, false);
  assert.equal((replayResult.structuredContent as { planId?: string })?.planId, planId);
  const otherKey = await callWrite(
    server.app,
    'changes.commit',
    33,
    commitArguments(planId, 'idem-t06-other'),
    auth.token,
  );
  assertRejectedWrite(compatJsonRpc(otherKey).result);
});

test('reject, expire, and revoked credential fail closed with a stable rejected result', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));

  const cancelledPlan = await callWrite(server.app, 'changes.plan', 40, planArguments(), auth.token);
  const cancelledId = assertAwaitingApproval(compatJsonRpc(cancelledPlan).result).planId;
  const cancelled = await callWrite(server.app, 'changes.cancel', 41, { planId: cancelledId }, auth.token);
  assert.equal(compatJsonRpc(cancelled).result?.isError === true, false);
  assertCompatCallToolEnvelope(compatJsonRpc(cancelled).result);
  const afterCancel = await callWrite(
    server.app,
    'changes.commit',
    42,
    commitArguments(cancelledId),
    auth.token,
  );
  assertRejectedWrite(compatJsonRpc(afterCancel).result);

  const expiring = await callWrite(server.app, 'changes.plan', 43, planArguments(), auth.token);
  const expiringId = assertAwaitingApproval(compatJsonRpc(expiring).result).planId;
  const stored = fixture.planStore.get(expiringId);
  assert.ok(stored);
  fixture.planStore.update(Object.freeze({
    ...stored,
    expiresAt: '2026-08-06T07:00:00.000Z',
  }));
  const expired = await callWrite(server.app, 'changes.commit', 44, commitArguments(expiringId), auth.token);
  assertRejectedWrite(compatJsonRpc(expired).result);

  let revoked = false;
  const revokedClient = await signedCompatWriteClient();
  const revokedVerifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...COMPAT_WRITE_SCOPES],
    jwks: staticJwksProvider([revokedClient.key.jwk]),
    audience: [AUDIENCE, `${AUDIENCE}-compat`],
    isRevoked: async () => revoked,
  }));
  const revokedFixture = createWriteFixture();
  const revokedServer = track(startCompatWriteApp({
    writeFixture: revokedFixture,
    verifier: revokedVerifier,
  }));
  const live = await callWrite(revokedServer.app, 'changes.plan', 45, planArguments(), revokedClient.token);
  assertAwaitingApproval(compatJsonRpc(live).result);
  revoked = true;
  const afterRevoke = await callWrite(
    revokedServer.app,
    'changes.commit',
    46,
    commitArguments('plan-ignored'),
    revokedClient.token,
  );
  assert.equal(afterRevoke.statusCode, 401);
});

test('cross principal, client, and resource binding reject; a sibling endpoint cannot commit the plan', async () => {
  const fixture = createWriteFixture();
  const auth = await signedCompatWriteClient();
  const server = track(startCompatWriteApp({ writeFixture: fixture, verifier: auth.verifier }));

  const planned = await callWrite(server.app, 'changes.plan', 50, planArguments(), auth.token);
  const { planId } = assertAwaitingApproval(compatJsonRpc(planned).result);
  await fixture.bundle.adapter.recordOutOfBandApproval(
    planId,
    writeApprovalContext(await verifiedWriteBinding(auth)),
  );

  const otherPrincipal = await mintCompatWriteToken({
    key: auth.key.privateKey,
    kid: auth.key.kid,
    subject: 'urn:known:subject:bob',
    jti: 't06-bob',
  });
  const crossPrincipal = await callWrite(
    server.app,
    'changes.commit',
    51,
    commitArguments(planId),
    otherPrincipal,
  );
  assertRejectedWrite(compatJsonRpc(crossPrincipal).result);

  const otherClient = await mintCompatWriteToken({
    key: auth.key.privateKey,
    kid: auth.key.kid,
    clientId: 'other-mcp-client',
    jti: 't06-other-client',
  });
  const crossClient = await callWrite(
    server.app,
    'changes.commit',
    52,
    commitArguments(planId),
    otherClient,
  );
  assertRejectedWrite(compatJsonRpc(crossClient).result);

  const stored = fixture.planStore.get(planId);
  assert.ok(stored);
  fixture.planStore.update(Object.freeze({
    ...stored,
    binding: Object.freeze({
      ...stored.binding,
      resourceAudience: 'https://other.example/collections/-/mcp',
    }),
  }));
  const crossResource = await callWrite(
    server.app,
    'changes.commit',
    53,
    commitArguments(planId),
    auth.token,
  );
  assertRejectedWrite(compatJsonRpc(crossResource).result);

  const retryFixture = createWriteFixture();
  const retryServer = track(startCompatWriteApp({ writeFixture: retryFixture, verifier: auth.verifier }));
  const compatPlan = await callWrite(retryServer.app, 'changes.plan', 60, planArguments(), auth.token);
  const compatPlanId = assertAwaitingApproval(compatJsonRpc(compatPlan).result).planId;
  await retryFixture.bundle.adapter.recordOutOfBandApproval(
    compatPlanId,
    writeApprovalContext(await verifiedWriteBinding(auth)),
  );
  const strictCommit = await injectStrictPost(retryServer.app, 'tools/call', 61, {
    authorization: `Bearer ${auth.strictToken}`,
    'mcp-name': 'changes.commit',
  }, modernBody('tools/call', 61, {
    name: 'changes.commit',
    arguments: commitArguments(compatPlanId),
  }));
  const strictPayload = JSON.parse(strictCommit.payload) as {
    readonly error?: { readonly code?: number; readonly data?: { readonly code?: string } };
  };
  assert.equal(strictCommit.statusCode, 200);
  assert.equal(strictPayload.error?.code, -32_602);
  assert.equal(
    (strictPayload.error?.data as { code?: string } | undefined)?.code,
    'plan_binding_mismatch',
  );

  const compatCommit = await callWrite(
    retryServer.app,
    'changes.commit',
    63,
    commitArguments(compatPlanId),
    auth.token,
  );
  const compatCommitResult = compatJsonRpc(compatCommit).result ?? {};
  assertCompatCallToolEnvelope(compatCommitResult);
  assert.equal(compatCommitResult.isError === true, false);
  assert.equal(
    (compatCommitResult.structuredContent as { planId?: string })?.planId,
    compatPlanId,
  );
  assertNoMrtrOrElicitation(compatCommit.payload);

  const strictPlan = await injectStrictPost(retryServer.app, 'tools/call', 62, {
    authorization: `Bearer ${auth.strictToken}`,
    'mcp-name': 'changes.plan',
  }, modernBody('tools/call', 62, {
    name: 'changes.plan',
    arguments: planArguments(),
  }));
  const strictPlanBody = JSON.parse(strictPlan.payload) as {
    readonly result?: { readonly resultType?: string; readonly requestState?: string; readonly plan?: { planId?: string } };
  };
  assert.equal(strictPlanBody.result?.resultType, 'input_required');
  assert.equal(typeof strictPlanBody.result?.requestState, 'string');
  const reversePlanId = strictPlanBody.result?.plan?.planId;
  assert.ok(reversePlanId);
  await retryFixture.bundle.adapter.recordOutOfBandApproval(
    reversePlanId,
    writeApprovalContext(await verifiedWriteBinding({
      verifier: auth.verifier,
      token: auth.strictToken,
    })),
  );
  const compatOfStrict = await callWrite(
    retryServer.app,
    'changes.commit',
    64,
    commitArguments(reversePlanId),
    auth.token,
  );
  assertRejectedWrite(compatJsonRpc(compatOfStrict).result);
  const strictOfStrict = await injectStrictPost(retryServer.app, 'tools/call', 65, {
    authorization: `Bearer ${auth.strictToken}`,
    'mcp-name': 'changes.commit',
  }, modernBody('tools/call', 65, {
    name: 'changes.commit',
    arguments: commitArguments(reversePlanId),
  }));
  const strictOfStrictBody = JSON.parse(strictOfStrict.payload) as {
    readonly result?: { readonly resultType?: string; readonly structuredContent?: { planId?: string } };
  };
  assert.equal(strictOfStrict.statusCode, 200);
  assert.equal(strictOfStrictBody.result?.resultType, 'complete');
  assert.equal(strictOfStrictBody.result?.structuredContent?.planId, reversePlanId);
});
