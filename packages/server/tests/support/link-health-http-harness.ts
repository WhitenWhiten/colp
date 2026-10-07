import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { loadConfig } from './test-config.js';
import {
  createProductLinkHealthCursorSigner,
  getMyLinkHealthPage,
  LinkHealthCursorError,
  LinkHealthInputError,
  type LinkHealthBookmarkUrlFact,
  type LinkHealthMembership,
  type LinkHealthRow,
  type LinkHealthScope,
  type LinkHealthStatus,
} from '../../src/modules/collections/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../src/transport/http-security.js';

export {
  createFixedWindowRateLimiter,
  createProductLinkHealthCursorSigner,
  getMyLinkHealthPage,
  LinkHealthCursorError,
  LinkHealthInputError,
};
export type { LinkHealthBookmarkUrlFact };
import { createInMemoryBetterAuthTestFactory } from './better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  issueTestSession,
} from './product-http-harness.js';

export const NOW = new Date('2026-08-22T08:00:00.000Z');
export const baseEnv = {
  DATABASE_URL: 'postgres://localhost/link_health_http_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example/realms/known',
  OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};

export const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

interface SeedRow {
  readonly owner: ActorName;
  readonly row: LinkHealthRow;
  readonly members?: ReadonlyArray<{ readonly who: ActorName; readonly role: 'editor' | 'viewer' }>;
}

type ActorName = 'owner' | 'outsider' | 'editor' | 'viewer' | 'stranger';

type MutableHealthRow = {
  -readonly [K in keyof LinkHealthRow]: LinkHealthRow[K];
} & {
  ownerSubjectId: string;
  members: Array<{ subjectId: string; role: 'editor' | 'viewer' }>;
};

export function row(
  nodeId: string,
  collectionId: string,
  url: string,
  overrides: Partial<LinkHealthRow> = {},
): LinkHealthRow {
  return {
    nodeId, collectionId, collectionTitle: `Collection ${collectionId}`,
    title: `Title ${nodeId}`, url, resourceRevision: `rev-${nodeId}`,
    createdAt: NOW, status: 'pending', httpStatus: null, finalUrl: null, checkedAt: null,
    membership: 'owner', errorClass: null, duplicateRelationId: null, duplicateRelationRevision: null,
    ...overrides,
  };
}

export async function harness(input: {
  readonly enabled: boolean;
  readonly seeds: readonly SeedRow[];
  readonly rateLimiter?: ReturnType<typeof createFixedWindowRateLimiter>;
}) {
  const config = loadConfig({
    ...baseEnv,
    KNOWN_FEATURE_LINK_HEALTH: input.enabled ? 'true' : 'false',
  });
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'lhowner',
  });
  const outsider = await issueTestSession({
    factory, subject: 'outsider-subject', displayName: 'Outsider', handle: 'lhout',
  });
  const editor = await issueTestSession({
    factory, subject: 'editor-subject', displayName: 'Editor', handle: 'lheditor',
  });
  const viewer = await issueTestSession({
    factory, subject: 'viewer-subject', displayName: 'Viewer', handle: 'lhviewer',
  });
  const stranger = await issueTestSession({
    factory, subject: 'stranger-subject', displayName: 'Stranger', handle: 'lhstranger',
  });
  const actors: Record<ActorName, { subjectId: string; cookie: string; csrfToken: string }> = {
    owner, outsider, editor, viewer, stranger,
  };
  const subjectOf = (who: ActorName) => actors[who].subjectId;
  const healthRows: MutableHealthRow[] = input.seeds.map((seed) => ({
    ...seed.row,
    ownerSubjectId: subjectOf(seed.owner),
    members: (seed.members ?? []).map((member) => ({
      subjectId: subjectOf(member.who), role: member.role,
    })),
  }));
  const signer = createProductLinkHealthCursorSigner({
    current: { id: 'lh-http-v1', key: 'link-health-http-cursor-secret-material' },
  });
  const authorized = (item: MutableHealthRow, actorId: string, scope: LinkHealthScope) => {
    const isOwner = item.ownerSubjectId === actorId;
    const member = item.members.find((entry) => entry.subjectId === actorId);
    const isShared = !isOwner && member !== undefined;
    if (scope === 'owned') return isOwner;
    if (scope === 'shared') return isShared;
    return isOwner || isShared;
  };
  const membershipOf = (item: MutableHealthRow, actorId: string): LinkHealthMembership | undefined => {
    if (item.ownerSubjectId === actorId) return 'owner';
    return item.members.find((entry) => entry.subjectId === actorId)?.role;
  };
  const receipts = new Map();
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    ...(input.rateLimiter === undefined ? {} : { linkHealthRateLimiter: input.rateLimiter }),
    linkHealthEnqueue: {
      execute: async (work) => work({
        receipts: createMemoryProductCommandReceiptPort(receipts),
        checks: {
          async markOwnedPending(filter) {
            let queued = 0;
            for (const item of healthRows) {
              if (filter.collectionId === undefined) {
                if (item.ownerSubjectId !== filter.ownerSubjectId) continue;
              } else {
                if (item.collectionId !== filter.collectionId) continue;
                const isOwner = item.ownerSubjectId === filter.ownerSubjectId;
                const isEditor = item.members.some((entry) =>
                  entry.subjectId === filter.ownerSubjectId && entry.role === 'editor');
                if (!isOwner && !isEditor) continue;
              }
              if (filter.nodeIds !== undefined && !filter.nodeIds.includes(item.nodeId)) continue;
              item.status = 'pending';
              item.httpStatus = null;
              item.finalUrl = null;
              item.checkedAt = null;
              queued += 1;
            }
            return queued;
          },
        },
      }),
    },
    linkHealthQuery: {
      reads: {
        async listOwnedBookmarkUrlFacts(query) {
          const scope = query.scope ?? 'owned';
          return healthRows.filter((item) => authorized(item, query.ownerSubjectId, scope))
            .filter((item) => !query.collectionId || item.collectionId === query.collectionId)
            .map((item) => ({
              nodeId: item.nodeId, collectionId: item.collectionId, url: item.url, createdAt: item.createdAt,
            }));
        },
        async listLinkHealth(query) {
          const scope = query.scope ?? 'owned';
          return healthRows.filter((item) => authorized(item, query.ownerSubjectId, scope))
            .filter((item) => !query.status || item.status === query.status)
            .filter((item) => !query.collectionId || item.collectionId === query.collectionId)
            .filter((item) => !query.nodeIds || query.nodeIds.includes(item.nodeId))
            .filter((item) => {
              if (!query.after) return true;
              if (query.after.checkedAt === null) {
                return (item.checkedAt === null && item.nodeId > query.after.nodeId)
                  || item.checkedAt !== null;
              }
              if (item.checkedAt === null) return false;
              return item.checkedAt > query.after.checkedAt
                || (item.checkedAt.getTime() === query.after.checkedAt.getTime()
                  && item.nodeId > query.after.nodeId);
            })
            .sort((left, right) => {
              if (left.checkedAt === null && right.checkedAt !== null) return -1;
              if (left.checkedAt !== null && right.checkedAt === null) return 1;
              if (left.checkedAt && right.checkedAt) {
                const time = left.checkedAt.getTime() - right.checkedAt.getTime();
                if (time !== 0) return time;
              }
              return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
            })
            .slice(0, query.limit + 1)
            .map((item) => {
              const { ownerSubjectId: _owner, members: _members, ...rest } = item;
              return { ...rest, membership: membershipOf(item, query.ownerSubjectId) ?? rest.membership };
            });
        },
      },
      cursors: signer,
      clock: { now: async () => NOW },
    },
  });
  app.addHook('onClose', async () => signer.destroy());
  apps.push(app);
  return { app, owner, outsider, editor, viewer, stranger, healthRows, signer };
}

export function mutationHeaders(
  client: { cookie: string; csrfToken: string },
  commandId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: 'https://app.example.test',
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
    ...extra,
  };
}
