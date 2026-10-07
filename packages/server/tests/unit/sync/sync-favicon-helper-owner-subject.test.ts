/**
 * A known.sync subject that equals some account subject_id is not an owner
 * until ownerSubject resolves the issuer+subject binding. Missing binding is
 * 401 and must not read favicon state. A resolved binding still returns that
 * account as the actor.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type {
  BookmarkFaviconObjectStore,
  CollectionsUnitOfWork,
  CollectionsWritePorts,
} from '../../../src/modules/collections/index.js';
import type {
  Account,
  ExtensionOwnerSubjectPort,
  IdentityPorts,
  IdentityUnitOfWork,
  VerifiedExtensionCredential,
} from '../../../src/modules/identity/index.js';
import { registerSyncFaviconHelperRoutes } from '../../../src/transport/colp-sync/sync-favicon-helper-routes.js';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ISSUER = 'https://issuer.example/known';
const TOKEN_SUBJECT = 'acct-subject-id';
const OWNER_SUBJECT = 'owner-subject-id';
const POLICY_PATH = '/colp/v0.1/sync/favicon-policy';
const DECOY_CREATED_AT = new Date('2020-01-01T00:00:00.000Z');
const OWNER_CREATED_AT = new Date('2024-05-06T07:08:09.000Z');

const faviconStore: BookmarkFaviconObjectStore = {
  async put() {},
  async get() { return null; },
  async delete() {},
};

function account(id: string, subjectId: string, createdAt: Date): Account {
  return {
    id,
    subjectId,
    status: 'active',
    email: null,
    securityEpoch: 1n,
    createdAt,
    deletedAt: null,
  };
}

const accounts = new Map<string, Account>([
  [TOKEN_SUBJECT, account('decoy-account', TOKEN_SUBJECT, DECOY_CREATED_AT)],
  [OWNER_SUBJECT, account('owner-account', OWNER_SUBJECT, OWNER_CREATED_AT)],
]);

interface Probe {
  readonly app: FastifyInstance;
  readonly resolutions: Array<{ readonly issuer: string; readonly subject: string }>;
  readonly lookedUpSubjects: string[];
  readonly faviconAccountReads: string[];
  faviconStateReads: number;
}

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function build(resolvedSubjectId: string | null): Probe {
  const resolutions: Array<{ readonly issuer: string; readonly subject: string }> = [];
  const lookedUpSubjects: string[] = [];
  const faviconAccountReads: string[] = [];
  const probe: Probe = {
    app: Fastify(),
    resolutions,
    lookedUpSubjects,
    faviconAccountReads,
    faviconStateReads: 0,
  };
  const ownerSubject: ExtensionOwnerSubjectPort = {
    async resolveOwnerSubject(identity) {
      resolutions.push({ issuer: identity.issuer, subject: identity.subject });
      return resolvedSubjectId;
    },
  };
  const identityUnitOfWork: IdentityUnitOfWork = {
    async execute(work) {
      return work({
        accounts: {
          async findBySubjectId(subjectId: string) {
            lookedUpSubjects.push(subjectId);
            return accounts.get(subjectId) ?? null;
          },
        },
      } as unknown as IdentityPorts);
    },
  };
  const collectionsUnitOfWork: CollectionsUnitOfWork = {
    async execute(work) {
      probe.faviconStateReads += 1;
      return work({
        faviconPolicies: {
          async findByAccountId(accountId: string) {
            faviconAccountReads.push(accountId);
            return null;
          },
        },
        faviconSources: {},
        bookmarkIcons: {},
        faviconGc: {},
        faviconRestores: {},
      } as unknown as CollectionsWritePorts);
    },
  };
  apps.push(probe.app);
  registerSyncFaviconHelperRoutes(probe.app, {
    enabled: true,
    productOrigin: 'https://known.example',
    timeoutMs: 2_000,
    faviconStore,
    identityUnitOfWork,
    collectionsUnitOfWork,
    extensionCollectionRoutes: {
      credentialVerifier: {
        async verify() {
          return {
            kind: 'verified_extension_credential',
            issuer: ISSUER,
            subject: TOKEN_SUBJECT,
          } as VerifiedExtensionCredential;
        },
      },
      ownerSubject,
      allowedOrigins: [ORIGIN],
      ownedCollectionsQuery: {
        reads: { async listOwnedCollections() { return []; } },
        cursors: {
          sign() { return 'cursor'; },
          verify() { throw new Error('unused'); },
          destroy() {},
        },
        clock: { now: async () => OWNER_CREATED_AT },
      },
    },
  });
  return probe;
}

function injectPolicy(app: FastifyInstance) {
  return app.inject({
    method: 'GET',
    url: POLICY_PATH,
    headers: {
      origin: ORIGIN,
      authorization: 'Bearer compact-jws',
    },
  });
}

describe('favicon helper owner subject binding', () => {
  test('token subject equal to an account subject id without a binding is 401 and does not read favicon state', async () => {
    const probe = build(null);
    const response = await injectPolicy(probe.app);
    assert.equal(response.statusCode, 401);
    assert.equal((response.json() as { message: string }).message,
      'Authentication is required for this operation.');
    assert.deepEqual(probe.resolutions, [{ issuer: ISSUER, subject: TOKEN_SUBJECT }]);
    assert.deepEqual(probe.lookedUpSubjects, []);
    assert.equal(probe.faviconStateReads, 0);
    assert.deepEqual(probe.faviconAccountReads, []);
  });

  test('a resolved identity returns that account as the actor', async () => {
    const probe = build(OWNER_SUBJECT);
    const response = await injectPolicy(probe.app);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(probe.resolutions, [{ issuer: ISSUER, subject: TOKEN_SUBJECT }]);
    assert.deepEqual(probe.lookedUpSubjects, [OWNER_SUBJECT]);
    assert.equal(probe.faviconStateReads, 1);
    assert.deepEqual(probe.faviconAccountReads, ['owner-account']);
    const body = response.json() as { updatedAt: string };
    assert.equal(body.updatedAt, OWNER_CREATED_AT.toISOString());
    assert.notEqual(body.updatedAt, DECOY_CREATED_AT.toISOString());
  });
});
