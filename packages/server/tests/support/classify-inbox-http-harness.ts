import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { loadConfig } from './test-config.js';
import {
  CollectionPreconditionError,
  createProductClassifyInboxCursorSigner,
  isClassifyInboxEligible,
  ifMatchSatisfied,
  strongEntityTag,
  type ClassifyInboxBookmarkRow,
  type ClassifyInboxFolderRow,
  type ClassifyInboxAcceptInsertResult,
  type ClassifyInboxSkipInsertResult,
} from '../../src/modules/collections/index.js';
import { buildApiApp } from '../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from './better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  issueTestSession,
} from './product-http-harness.js';

export const NOW = new Date('2026-08-24T08:00:00.000Z');
export const ROUTE = '/api/v1/me/classify-inbox';
export const SKIP = (nodeId: string) => `/api/v1/me/classify-inbox/${nodeId}/skip`;
export const ACCEPT = (nodeId: string) => `/api/v1/me/classify-inbox/${nodeId}/accept`;
export const FOLDER_ID = 'fld-spacing';
export const ROOT_ID = 'root-1';
export const MATCH = (nodeId: string) => `"rev-${nodeId}"`;
export const PRODUCT_ORIGIN = 'https://app.example.test';
const baseEnv = {
  DATABASE_URL: 'postgres://localhost/classify_inbox_http_test',
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

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

type ActorName = 'owner' | 'outsider';
type SidecarStatus = 'skipped' | 'accepted';

interface SeedBookmark extends ClassifyInboxBookmarkRow {
  readonly owner: ActorName;
  sidecarStatus: SidecarStatus | null;
}

export function row(
  nodeId: string,
  overrides: Partial<SeedBookmark> = {},
): SeedBookmark {
  const sidecarStatus = overrides.sidecarStatus
    ?? (overrides.hasSidecar === true ? 'skipped' : null);
  const rest = { ...overrides };
  delete rest.sidecarStatus;
  delete rest.hasSidecar;
  return {
    owner: 'owner',
    nodeId,
    collectionId: 'col-1',
    collectionTitle: 'Inbox library',
    title: `Title ${nodeId}`,
    url: `https://system.example.com/${nodeId}`,
    resourceRevision: `rev-${nodeId}`,
    createdAt: NOW,
    isOwner: true,
    kind: 'bookmark',
    softDeleted: false,
    parentKind: 'root',
    parentId: ROOT_ID,
    ...rest,
    sidecarStatus,
    hasSidecar: sidecarStatus !== null,
  };
}

export function mutationHeaders(
  client: { cookie: string; csrfToken: string },
  commandId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: PRODUCT_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
    ...extra,
  };
}

export async function harness(input: {
  readonly enabled: boolean;
  readonly bookmarks?: readonly SeedBookmark[];
  readonly folders?: readonly ClassifyInboxFolderRow[];
}) {
  const config = loadConfig({
    ...baseEnv,
    KNOWN_FEATURE_CLASSIFY: input.enabled ? 'true' : 'false',
  });
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'ciowner',
  });
  const outsider = await issueTestSession({
    factory, subject: 'outsider-subject', displayName: 'Outsider', handle: 'ciout',
  });
  const actors: Record<ActorName, { subjectId: string; cookie: string; csrfToken: string }> = {
    owner, outsider,
  };
  const bookmarks = (input.bookmarks ?? []).map((item) => ({
    ...item,
    ownerSubjectId: actors[item.owner].subjectId,
  }));
  const sidecarWrites: string[] = [];
  const acceptWrites: string[] = [];
  const moveCalls: Array<{ newParentId: string; afterId: string | null; beforeId: string | null }> = [];
  const folders = input.folders ?? [{
    collectionId: 'col-1', folderId: 'fld-spacing', folderTitle: 'Spacing as a system',
  }];
  const signer = createProductClassifyInboxCursorSigner({
    current: { id: 'ci-http-v1', key: 'classify-inbox-http-cursor-secret-material' },
  });
  const receipts = new Map();
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    classifyInboxAccept: {
      execute: async (work) => work({
        receipts: createMemoryProductCommandReceiptPort(new Map()),
        inbox: {
          async loadEligibilitySnapshot(query) {
            const item = bookmarks.find((row) => (
              row.nodeId === query.nodeId && row.ownerSubjectId === query.ownerSubjectId
            ));
            if (!item) return null;
            return {
              nodeId: item.nodeId,
              collectionId: item.collectionId,
              isOwner: true,
              kind: item.kind,
              softDeleted: item.softDeleted,
              url: item.url,
              parentKind: item.parentKind,
              parentId: item.parentId ?? ROOT_ID,
              resourceRevision: item.resourceRevision,
              sidecarStatus: item.sidecarStatus,
            };
          },
          async insertAccepted(query) {
            const item = bookmarks.find((row) => (
              row.nodeId === query.nodeId && row.ownerSubjectId === query.accountSubjectId
            ));
            if (!item) return 'blocked' satisfies ClassifyInboxAcceptInsertResult;
            if (item.sidecarStatus === 'accepted') return 'already_accepted';
            if (item.sidecarStatus === 'skipped') return 'blocked';
            item.sidecarStatus = 'accepted';
            item.hasSidecar = true;
            item.parentId = query.suggestionId;
            item.parentKind = 'folder';
            acceptWrites.push(item.nodeId);
            return 'inserted';
          },
        },
        clock: { now: async () => NOW },
        collection: {
          receipts: createMemoryProductCommandReceiptPort(new Map()),
          clock: { now: async () => NOW },
          collections: {
            async lockForUpdate(collectionId) {
              return bookmarks.some((row) => row.collectionId === collectionId)
                ? { id: collectionId, deletedAt: null, ownerSubjectId: bookmarks.find(row => row.collectionId === collectionId)!.ownerSubjectId } as never
                : null;
            },
          },
          nodes: {
            async getNode(collectionId, nodeId) {
              if (nodeId === FOLDER_ID) {
                return {
                  id: FOLDER_ID, collectionId, parentId: ROOT_ID, kind: 'folder', isRoot: false,
                  resourceRevision: 'rev-folder', childrenRevision: 'cr-folder', deletedAt: null,
                } as never;
              }
              if (nodeId === ROOT_ID) {
                return {
                  id: ROOT_ID, collectionId, parentId: null, kind: 'folder', isRoot: true,
                  resourceRevision: 'rev-root', childrenRevision: 'cr-root', deletedAt: null,
                } as never;
              }
              const item = bookmarks.find((row) => row.nodeId === nodeId && row.collectionId === collectionId);
              if (!item) return null;
              return {
                id: item.nodeId, collectionId, parentId: item.parentId ?? ROOT_ID, kind: 'bookmark',
                isRoot: false, resourceRevision: item.resourceRevision, childrenRevision: 'cr-node',
                deletedAt: item.softDeleted ? NOW : null,
              } as never;
            },
            readParentAncestry: async () => [],
            listLiveSiblingPositions: async () => [],
          },
          accessPolicy: { loadCollectionFacts: async () => null },
          canonical: {
            execute: async () => { throw new Error('canonical.execute must not run'); },
            bootstrapOwnedCollection: async () => { throw new Error('bootstrap must not run'); },
          },
        },
        vocabulary: {existingTags: async () => []},
        move: async (_ports, input) => {
          const item = bookmarks.find((row) => row.nodeId === input.nodeId);
          if (item && !ifMatchSatisfied(input.ifMatch, item.resourceRevision)) {
            throw new CollectionPreconditionError({
              currentEtag: strongEntityTag(item.resourceRevision),
            });
          }
          moveCalls.push({
            newParentId: input.newParentId, afterId: input.afterId, beforeId: input.beforeId,
          });
          if (item) {
            item.parentId = input.newParentId;
            item.parentKind = 'folder';
          }
          return { kind: 'moved' } as never;
        },
      }),
    },
    classifyInboxSkip: {
      execute: async (work) => work({
        receipts: createMemoryProductCommandReceiptPort(receipts),
        inbox: {
          async loadEligibilitySnapshot(query) {
            const item = bookmarks.find((row) => (
              row.nodeId === query.nodeId && row.ownerSubjectId === query.ownerSubjectId
            ));
            if (!item) return null;
            return {
              nodeId: item.nodeId,
              collectionId: item.collectionId,
              isOwner: true,
              kind: item.kind,
              softDeleted: item.softDeleted,
              url: item.url,
              parentKind: item.parentKind,
              sidecarStatus: item.sidecarStatus,
            };
          },
          async insertSkipped(query) {
            const item = bookmarks.find((row) => (
              row.nodeId === query.nodeId && row.ownerSubjectId === query.accountSubjectId
            ));
            if (!item) return 'blocked' satisfies ClassifyInboxSkipInsertResult;
            if (item.sidecarStatus === 'skipped') return 'already_skipped';
            if (item.sidecarStatus === 'accepted') return 'blocked';
            item.sidecarStatus = 'skipped';
            item.hasSidecar = true;
            sidecarWrites.push(item.nodeId);
            return 'inserted';
          },
        },
        clock: { now: async () => NOW },
      }),
    },
    classifyInboxQuery: {
      reads: {
        async listInboxBookmarks(query) {
          return bookmarks.filter((item) => item.ownerSubjectId === query.ownerSubjectId)
            .filter((item) => isClassifyInboxEligible({
              isOwner: true,
              kind: item.kind,
              softDeleted: item.softDeleted,
              url: item.url,
              parentKind: item.parentKind,
              hasSidecar: item.hasSidecar,
            }))
            .sort((left, right) => {
              const time = right.createdAt.getTime() - left.createdAt.getTime();
              if (time !== 0) return time;
              return left.nodeId > right.nodeId ? -1 : left.nodeId < right.nodeId ? 1 : 0;
            })
            .filter((item) => {
              if (!query.after) return true;
              if (item.createdAt.getTime() < query.after.createdAt.getTime()) return true;
              return item.createdAt.getTime() === query.after.createdAt.getTime()
                && item.nodeId < query.after.nodeId;
            })
            .slice(0, query.limit + 1)
            .map((item) => {
              const { owner: _owner, ownerSubjectId: _subject, ...rest } = item;
              return rest;
            });
        },
        async listLiveFolders(query) {
          if (query.collectionIds.length === 0) return [];
          const allowed = new Set(query.collectionIds);
          return folders.filter((item) => allowed.has(item.collectionId));
        },
      },
      cursors: signer,
      clock: { now: async () => NOW },
    },
  });
  app.addHook('onClose', async () => signer.destroy());
  apps.push(app);
  return { app, owner, outsider, signer, sidecarWrites, acceptWrites, moveCalls };
}
