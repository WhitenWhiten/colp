/**
 * T-05: legacy resources list/read authorization matches the shared projection.
 * Discoverability (list) is not the same as exact-URI read.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  type McpOauthVerifier,
} from '../../../src/modules/mcp/index.js';
import {
  assertNo0728WireFields,
  compatJsonRpc,
  injectCompatLegacyPost,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatResourcesListBody,
  mcpCompatResourcesReadBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  COMPAT_VISIBILITY_MEMBER,
  COMPAT_VISIBILITY_OUTSIDER,
  COMPAT_VISIBILITY_OWNER,
  collectionResourceUri,
  createCompatVisibilityProjection,
  listedCollectionIds,
  mintVisibilityToken,
  signedCompatVisibilityClient,
} from '../../support/phase4b-mcp-compat-visibility.js';
import {
  emptyNodeResourceProjection,
  emptySnapshotResourceProjection,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const apps: FastifyInstance[] = [];
const fixtures: Array<{ destroy(): void }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  for (const fixture of fixtures.splice(0)) fixture.destroy();
});

function startPrivacyApp(oauthVerifier?: McpOauthVerifier) {
  const fixture = createCompatVisibilityProjection();
  fixtures.push(fixture);
  const server = startCompatApp({
    mcpReadResourceProjection: fixture.projection,
    mcpNodeResourceProjection: emptyNodeResourceProjection(),
    mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
    ...(oauthVerifier === undefined ? {} : { mcpReadTransport: { oauthVerifier } }),
  });
  apps.push(server.app);
  return server;
}

function assertConcealedNotFound(
  response: { readonly payload: string },
  forbidden: RegExp,
): void {
  const rpc = compatJsonRpc(response);
  assert.equal(rpc.error?.code, -32_602);
  assert.match(rpc.error?.message ?? '', /Resource not found/u);
  assert.doesNotMatch(response.payload, forbidden);
}

test('anonymous public vs OAuth owner/member/outsider list the same URIs as the projection', async () => {
  const { key, verifier } = await signedCompatVisibilityClient();
  const server = startPrivacyApp(verifier);
  const anonymous = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(20),
    COMPAT_REVISION,
  );
  assert.deepEqual(listedCollectionIds(anonymous), ['public-b', 'public-a']);
  assertNo0728WireFields(compatJsonRpc(anonymous).result);
  assert.doesNotMatch(anonymous.payload, /unlisted|private|protected-owner|protected-member|ownerSubjectId/u);

  const owner = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(21),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_OWNER, 't05-owner')}` },
  );
  assert.deepEqual(listedCollectionIds(owner), ['public-b', 'public-a', 'protected-owner']);
  assert.doesNotMatch(owner.payload, /unlisted|"private"|protected-member/u);

  const member = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(22),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_MEMBER, 't05-member')}` },
  );
  assert.deepEqual(listedCollectionIds(member), ['public-b', 'public-a', 'protected-member']);

  const outsider = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesListBody(23),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_OUTSIDER, 't05-outsider')}` },
  );
  assert.deepEqual(listedCollectionIds(outsider), ['public-b', 'public-a']);
});

test('exact URI read separates unlisted discoverability from private and protected concealment', async () => {
  const { key, verifier } = await signedCompatVisibilityClient();
  const server = startPrivacyApp(verifier);
  const unlisted = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(collectionResourceUri('unlisted'), 40),
    COMPAT_REVISION,
  );
  assert.equal(unlisted.statusCode, 200);
  const unlistedText = (compatJsonRpc(unlisted).result?.contents as readonly { readonly text?: string }[])
    ?.[0]?.text;
  assert.equal(JSON.parse(unlistedText ?? '{}').collection.visibility, 'unlisted');
  assertNo0728WireFields(compatJsonRpc(unlisted).result);

  for (const [id, rpcId] of [['private', 41], ['protected-owner', 42], ['protected-member', 43]] as const) {
    const hidden = await injectCompatLegacyPost(
      server.app,
      mcpCompatResourcesReadBody(collectionResourceUri(id), rpcId),
      COMPAT_REVISION,
    );
    assertConcealedNotFound(hidden, new RegExp(`${id}|visibility|ownerSubjectId`, 'u'));
  }

  const ownerAuth = {
    authorization: `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_OWNER, 't05-read-owner')}`,
  };
  for (const id of ['private', 'protected-owner'] as const) {
    const read = await injectCompatLegacyPost(
      server.app,
      mcpCompatResourcesReadBody(collectionResourceUri(id), 50),
      COMPAT_REVISION,
      ownerAuth,
    );
    assert.equal(read.statusCode, 200);
    const text = (compatJsonRpc(read).result?.contents as readonly { readonly text?: string }[])?.[0]?.text;
    assert.equal(JSON.parse(text ?? '{}').collection.id, id);
    assertNo0728WireFields(compatJsonRpc(read).result);
  }

  const memberRead = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(collectionResourceUri('protected-member'), 51),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_MEMBER, 't05-read-member')}` },
  );
  const memberText = (compatJsonRpc(memberRead).result?.contents as readonly { readonly text?: string }[])
    ?.[0]?.text;
  assert.equal(JSON.parse(memberText ?? '{}').collection.id, 'protected-member');

  const outsiderHidden = await injectCompatLegacyPost(
    server.app,
    mcpCompatResourcesReadBody(collectionResourceUri('protected-member'), 52),
    COMPAT_REVISION,
    { authorization: `Bearer ${await mintVisibilityToken(key, COMPAT_VISIBILITY_OUTSIDER, 't05-read-out')}` },
  );
  assertConcealedNotFound(outsiderHidden, /protected-member|visibility|ownerSubjectId/u);
});
