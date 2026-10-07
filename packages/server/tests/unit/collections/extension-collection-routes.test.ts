import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, test } from 'vitest';
import {
  createProductOwnedCollectionsCursorSigner,
  type OwnedCollectionFact,
} from '../../../src/modules/collections/index.js';
import {
  createSessionBackedExtensionCredentialVerifier,
  parseExtensionAuthConfig,
  type ExtensionSessionActor,
} from '../../../src/modules/identity/extension-auth.js';
import {
  EXTENSION_COLLECTIONS_PATH,
  registerExtensionCollectionRoutes,
  type ExtensionCollectionRouteDependencies,
} from '../../../src/transport/colp-sync/extension-collection-routes.js';

const NOW = new Date('2026-08-18T00:00:00.000Z');
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SESSION_COOKIE = 'baSessionToken.dGVzdHNpZw==';
const OWNED_COLLECTION_ID = 'library-one';
const SHARED_MEMBER_COLLECTION_ID = 'shared-member-only';

function config() {
  return parseExtensionAuthConfig({
    issuer: 'https://issuer.example.test/',
    clientId: 'known-chromium-extension',
    audience: 'known-sync-api',
    authorizationEndpoint: 'https://issuer.example.test/oauth2/authorize',
    tokenEndpoint: 'https://issuer.example.test/oauth2/token',
    jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
    redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2',
    extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
    redirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
    scopes: ['openid', 'known.sync'],
    algorithms: ['RS256'],
    clockSkewSeconds: 30,
    evidenceTtlSeconds: 60,
  });
}

const liveActor: ExtensionSessionActor = {
  accountId: 'account-1',
  subjectId: 'subject-1',
  sessionId: 'session-1',
  issuedAt: new Date('2026-08-17T23:00:00.000Z'),
  expiresAt: new Date('2026-08-19T00:00:00.000Z'),
};

function fact(id: string): OwnedCollectionFact {
  return {
    id, kind: 'bookmarks', title: `Owned ${id}`, summary: null, visibility: 'private',
    publicationSlug: null, allowSearchIndexing: false, publishedAt: null,
    rootNodeId: `root-${id}`, resourceRevision: `r-${id}`, contentRevision: `c-${id}`,
    policyRevision: `p-${id}`, createdAt: NOW, updatedAt: NOW,
  };
}

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function harness(options: {
  readonly listOwnedCollections?: (
    input: { readonly ownerSubjectId: string },
  ) => Promise<readonly OwnedCollectionFact[]> | readonly OwnedCollectionFact[];
  /** Identity subject the session verifier binds (defaults to the account subject). */
  readonly identitySubject?: string;
  readonly resolveOwnerSubject?: (
    identity: { readonly issuer: string; readonly subject: string },
  ) => Promise<string | null>;
  readonly resolveActiveAccount?: (
    identity: { readonly issuer: string; readonly subject: string },
  ) => Promise<{ readonly accountId: string; readonly subjectId: string } | null>;
  readonly collectionMutation?: ExtensionCollectionRouteDependencies['collectionMutation'];
} = {}) {
  const listCalls: string[] = [];
  const resolveCalls: Array<{ readonly issuer: string; readonly subject: string }> = [];
  const verifier = createSessionBackedExtensionCredentialVerifier({
    config: config(),
    identityIssuer: 'https://app.example.test',
    now: () => NOW,
    sessions: { authenticate: async () => liveActor },
    identities: {
      async ensure(input) {
        return { issuer: input.issuer, subject: options.identitySubject ?? input.subjectId };
      },
    },
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerExtensionCollectionRoutes(app, {
    credentialVerifier: verifier,
    allowedOrigins: [ORIGIN],
    ownerSubject: {
      async resolveOwnerSubject(identity) {
        resolveCalls.push(identity);
        if (options.resolveOwnerSubject !== undefined) return options.resolveOwnerSubject(identity);
        // Default account resolution: any known identity subject maps back to
        // the account owner subject, as account_identities does in postgres.
        return identity.subject === (options.identitySubject ?? liveActor.subjectId)
          ? liveActor.subjectId : null;
      },
    },
    ownedCollectionsQuery: {
      reads: {
        async listOwnedCollections(input) {
          listCalls.push(input.ownerSubjectId);
          if (options.listOwnedCollections !== undefined) {
            return options.listOwnedCollections(input);
          }
          // Dishonest catalog: includes a membership-only id. The route must
          // still only ask the owned query (C-11); postgres owned-only is
          // pinned in shared-collections-postgres.integration.test.ts.
          return [fact(OWNED_COLLECTION_ID), fact(SHARED_MEMBER_COLLECTION_ID)];
        },
      },
      cursors: createProductOwnedCollectionsCursorSigner({
        current: { id: 'owned-ext-v1', key: 'owned-ext-cursor-secret-material-32b' },
      }),
      clock: { now: async () => NOW },
    },
    ...(options.resolveActiveAccount || options.collectionMutation ? {
      ownerAccount: {
        resolveActiveAccount: options.resolveActiveAccount ?? (async () => ({
          accountId: liveActor.accountId, subjectId: liveActor.subjectId,
        })),
      },
      ...(options.collectionMutation ? { collectionMutation: options.collectionMutation } : {}),
    } : {}),
  });
  await app.ready();
  return { app, listCalls, resolveCalls };
}

describe('extension collection list route', () => {
  test('returns owned collections for a Better Auth cookie Bearer', async () => {
    const { app, listCalls } = await harness({
      listOwnedCollections: async () => [fact(OWNED_COLLECTION_ID)],
    });
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: { origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(listCalls, [liveActor.subjectId]);
    assert.deepEqual(response.json(), {
      items: [{
        id: OWNED_COLLECTION_ID, title: 'Owned library-one', kind: 'bookmarks', visibility: 'private',
        rootNodeId: `root-${OWNED_COLLECTION_ID}`,
      }],
    });
  });

  test('COLP list only queries the owned port for the session subject (C-11)', async () => {
    const { app, listCalls } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: { origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(listCalls, [liveActor.subjectId]);
    const routeSource = readFileSync(
      fileURLToPath(new URL('../../../src/transport/colp-sync/extension-collection-routes.ts', import.meta.url)),
      'utf8',
    );
    assert.match(routeSource, /getOwnedCollectionsPage/u);
    assert.doesNotMatch(routeSource, /getSharedCollectionsPage|listSharedCollections/u);
  });

  test('prefers a valid session cookie when Authorization is percent-encoded', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${encodeURIComponent(SESSION_COOKIE)}`,
        cookie: `__Host-known_session=${encodeURIComponent(SESSION_COOKIE)}`,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0]?.id, 'library-one');
  });

  test('accepts a percent-encoded Bearer cookie when Cookie is omitted', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${encodeURIComponent(SESSION_COOKIE)}`,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0]?.id, 'library-one');
  });

  test('accepts the session cookie when Authorization is omitted', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: `${ORIGIN}/`,
        cookie: `__Host-known_session=${encodeURIComponent(SESSION_COOKIE)}`,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().items[0]?.id, 'library-one');
  });

  test('resolves legacy identity subjects to the account owner subject', async () => {
    const { app, listCalls, resolveCalls } = await harness({
      identitySubject: 'legacy-oidc-subject',
      resolveOwnerSubject: async (identity) =>
        identity.subject === 'legacy-oidc-subject' ? liveActor.subjectId : null,
      listOwnedCollections: async () => [fact(OWNED_COLLECTION_ID)],
    });
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: { origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(resolveCalls, [{ issuer: 'https://app.example.test', subject: 'legacy-oidc-subject' }]);
    assert.deepEqual(listCalls, [liveActor.subjectId]);
    assert.equal(response.json().items[0]?.id, OWNED_COLLECTION_ID);
  });

  test('denies credentials that resolve to no active account', async () => {
    const { app, listCalls } = await harness({ resolveOwnerSubject: async () => null });
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: { origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}` },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'invalid_token');
    assert.deepEqual(listCalls, []);
  });

  test('rejects a disallowed origin', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
        authorization: `Bearer ${SESSION_COOKIE}`,
      },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'origin_not_allowed');
  });
});

describe('extension collection create route', () => {
  const created = {
    kind: 'created' as const,
    collection: {
      id: 'library-created', title: 'Morning reads', kind: 'bookmarks' as const, visibility: 'private' as const,
      rootNodeId: 'root-created', summary: null, allowSearchIndexing: false as const,
      revision: 'r1', etag: '"r1"', contentRevision: 'c1', contentEtag: '"c1"',
      policyRevision: 'p1', policyEtag: '"p1"', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
    root: { id: 'root-created' },
    operationId: 'op-created',
    commitOrdinal: 1n,
  };

  test('creates a private bookmarks Collection and replays the same Idempotency-Key', async () => {
    const { app } = await harness({
      collectionMutation: { async execute() { return created; } },
    });
    const headers = {
      origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}`,
      'content-type': 'application/json', 'idempotency-key': 'create-library-1',
    };
    const first = await app.inject({
      method: 'POST', url: EXTENSION_COLLECTIONS_PATH, headers, payload: { title: 'Morning reads' },
    });
    assert.equal(first.statusCode, 201);
    assert.deepEqual(first.json(), {
      id: 'library-created', title: 'Morning reads', kind: 'bookmarks', visibility: 'private',
      rootNodeId: 'root-created',
    });
    const replayHarness = await harness({
      collectionMutation: {
        async execute() {
          return {
            kind: 'replay' as const,
            body: Buffer.from(JSON.stringify({ collection: first.json() })),
          };
        },
      },
    });
    const replay = await replayHarness.app.inject({
      method: 'POST', url: EXTENSION_COLLECTIONS_PATH, headers, payload: { title: 'Morning reads' },
    });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), first.json());
  });

  test('rejects a missing Idempotency-Key and a non-title body', async () => {
    const { app } = await harness({
      collectionMutation: { async execute() { throw new Error('must not mutate'); } },
    });
    const missing = await app.inject({
      method: 'POST', url: EXTENSION_COLLECTIONS_PATH,
      headers: { origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}`, 'content-type': 'application/json' },
      payload: { title: 'Morning reads' },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error.code, 'invalid_json');
    const extra = await app.inject({
      method: 'POST', url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}`,
        'content-type': 'application/json', 'idempotency-key': 'create-library-2',
      },
      payload: { title: 'Morning reads', kind: 'library' },
    });
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.json().error.code, 'invalid_json');
  });

  test('rejects credentials that resolve to no active account', async () => {
    const { app } = await harness({
      resolveActiveAccount: async () => null,
      collectionMutation: { async execute() { throw new Error('must not mutate'); } },
    });
    const response = await app.inject({
      method: 'POST', url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: ORIGIN, authorization: `Bearer ${SESSION_COOKIE}`,
        'content-type': 'application/json', 'idempotency-key': 'create-library-3',
      },
      payload: { title: 'Morning reads' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'invalid_token');
  });
});
