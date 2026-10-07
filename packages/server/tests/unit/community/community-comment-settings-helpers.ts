import assert from 'node:assert/strict';
import {
  COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
  COMMUNITY_SETTINGS_VIRTUAL_REVISION,
  COMMUNITY_STATIC_GENERATION,
  CommunityCommentError,
  communityCommentEtag,
  communityCommentSettingsEtag,
  communityCurationEtag,
  parseCommunityCommentSettingsQuery,
  type CommunityCommentCommandPorts,
  type CommunityCommentManageAuditEvent,
  type CommunityCommentManagePorts,
  type CommunityCommentRecord,
  type CommunityCommentSettingsInput,
  type CommunityCommentSettingsQueryPorts,
  type CommunityCommentSettingsRecord,
  type CommunityTarget,
  type CommunityTargetIdentity,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import type { ProductCommandResult as ReceiptResult } from '../../../src/modules/commands/index.js';

export const CURATOR = 'account-owner';
export const CURATOR_SUBJECT = 'subject-owner';
export const AUTHOR = 'account-author';
export const AUTHOR_SUBJECT = 'subject-author';
export const READER = 'account-reader';
export const READER_SUBJECT = 'subject-reader';
export const COLLECTION = 'collection-target';
export const COLLECTION_B = 'collection-other';
export const NODE = 'node-bookmark';
export const GENERATION = 'bm-gen-0123456789abcdef';
export const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
export const HMAC_KEY = Buffer.alloc(32, 17);
export const NOW = new Date('2026-10-03T10:00:00.000Z');
export const TARGET_CREATED = new Date('2026-09-01T08:00:00.000Z');

export const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
export const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: NODE, collectionId: COLLECTION,
  seriesId: null, generation: GENERATION,
};
export const COLLECTION_IDENTITY: CommunityTargetIdentity = {
  kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null,
};

export const CURATOR_ACTOR = { principalId: CURATOR, subjectId: CURATOR_SUBJECT } as const;

export function resolved(target: CommunityTarget = COLLECTION_TARGET): ResolvedCommunityTarget {
  return { target, ownerSubjectId: CURATOR_SUBJECT, title: 'Target title', href: '/t/1' };
}

export function settingsRecord(overrides: Partial<CommunityCommentSettingsRecord> = {}): CommunityCommentSettingsRecord {
  return {
    target: COLLECTION_IDENTITY,
    locked: true,
    reason: 'brigading',
    revision: 2n,
    updatedByAccountId: CURATOR,
    updatedAt: NOW,
    ...overrides,
  };
}

export function settingsTag(revision: bigint | string, target: CommunityTarget = COLLECTION_TARGET): string {
  return communityCommentSettingsEtag({ target, revision: revision.toString() }, HMAC_KEY);
}

export function errorCheck(code: string, message?: string) {
  return (error: unknown) => error instanceof CommunityCommentError
    && error.code === code
    && (message === undefined || error.message === message);
}

export function settingsQueryPorts(options: {
  resolved?: ResolvedCommunityTarget | null;
  settings?: CommunityCommentSettingsRecord | null;
  createdAt?: Date | null;
  curatorSubjects?: readonly string[];
} = {}): CommunityCommentSettingsQueryPorts {
  const curators = options.curatorSubjects ?? [CURATOR_SUBJECT];
  return {
    targets: {
      async resolve(query) {
        if ('resolved' in options) return options.resolved ?? null;
        return resolved({
          kind: query.kind, id: query.id,
          collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null,
          generation: query.kind === 'bookmark' ? GENERATION : COMMUNITY_STATIC_GENERATION,
        } as CommunityTarget);
      },
      async createdAt() {
        return options.createdAt === undefined ? TARGET_CREATED : options.createdAt;
      },
    },
    curators: {
      async canCurate(_identity, subjectId) { return curators.includes(subjectId); },
    },
    settings: {
      async find() { return options.settings ?? null; },
    },
  };
}

export const settingsQuery = (overrides: Record<string, unknown> = {}) =>
  parseCommunityCommentSettingsQuery({
    kind: 'collection', id: COLLECTION, generation: COMMUNITY_STATIC_GENERATION, ...overrides,
  });

export interface SettingsEffects {
  accountLocks: string[];
  targetLocks: CommunityTargetIdentity[];
  claims: { principalId: string; commandScope: string; commandId: string; fingerprint: string }[];
  completions: ReceiptResult[];
  settingsLocks: CommunityTargetIdentity[];
  settingsUpserts: CommunityCommentSettingsRecord[];
  commentUpdates: number;
  audits: CommunityCommentManageAuditEvent[];
  canCurateCalls: { identity: CommunityTargetIdentity; subjectId: string }[];
}

export function managePorts(options: {
  claim?: Awaited<ReturnType<CommunityCommentManagePorts['receipts']['claim']>>;
  account?: { subjectId: string } | null;
  resolved?: ResolvedCommunityTarget | null;
  settings?: CommunityCommentSettingsRecord | null;
  settingsStore?: Map<string, CommunityCommentSettingsRecord>;
  curatorSubjects?: readonly string[];
} = {}): { ports: CommunityCommentManagePorts; effects: SettingsEffects } {
  const effects: SettingsEffects = {
    accountLocks: [], targetLocks: [], claims: [], completions: [],
    settingsLocks: [], settingsUpserts: [], commentUpdates: 0,
    audits: [], canCurateCalls: [],
  };
  const curators = options.curatorSubjects ?? [CURATOR_SUBJECT];
  let settingsLastUpsert: CommunityCommentSettingsRecord | null = null;
  return {
    effects,
    ports: {
      receipts: {
        async claim(binding, fingerprint) {
          effects.claims.push({ ...binding, fingerprint });
          return options.claim ?? { kind: 'claimed' };
        },
        async complete(_binding, _fingerprint, result) {
          effects.completions.push(result);
          assert.equal(result.contractVersion, COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION);
          assert.equal(result.status, 200);
          assert.match(
            String(result.stableHeaders.etag), /^"community-comment-settings:[A-Za-z0-9_-]{32}"$/u);
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      actor: {
        async lockActiveAccount(accountId) {
          effects.accountLocks.push(accountId);
          if (options.account === null) return null;
          if (options.account !== undefined) return options.account;
          if (accountId === CURATOR) return { subjectId: CURATOR_SUBJECT };
          if (accountId === AUTHOR) return { subjectId: AUTHOR_SUBJECT };
          if (accountId === READER) return { subjectId: READER_SUBJECT };
          return null;
        },
      },
      targets: {
        async lockResolved(identity) {
          effects.targetLocks.push(identity);
          if ('resolved' in options) return options.resolved ?? null;
          return resolved({
            kind: identity.kind, id: identity.id,
            collectionId: identity.collectionId, seriesId: identity.seriesId,
            generation: identity.kind === 'bookmark' ? GENERATION : COMMUNITY_STATIC_GENERATION,
          } as CommunityTarget);
        },
      },
      comments: {
        async findById() { return null; },
        async lockById() { return null; },
        async update() {
          effects.commentUpdates += 1;
          throw new Error('settings must never rewrite the comment row');
        },
        async countVisibleThreadReplies(ids) { return new Map(ids.map((id) => [id, 0])); },
        async countVisibleDirectReplies(ids) { return new Map(ids.map((id) => [id, 0])); },
      },
      curations: {
        async lockByCommentId() { return null; },
        async upsert(record) { return record; },
      },
      settings: {
        async lockByTarget(identity) {
          effects.settingsLocks.push(identity);
          if (options.settingsStore !== undefined) {
            return options.settingsStore.get(identityKey(identity)) ?? null;
          }
          // A re-read after upsert must reflect the write, exactly like the
          // Postgres row read (the settings command re-reads the effective
          // record for its response).
          return settingsLastUpsert ?? options.settings ?? null;
        },
        async upsert(record) {
          effects.settingsUpserts.push(record);
          settingsLastUpsert = record;
          options.settingsStore?.set(identityKey(record.target), record);
          return record;
        },
      },
      curators: {
        async canCurate(identity, subjectId) {
          effects.canCurateCalls.push({ identity, subjectId });
          return curators.includes(subjectId);
        },
      },
      authors: {
        async publicActors(ids) {
          return new Map(ids.map((id) => [id, { handle: 'alice', displayName: 'Alice', avatarUrl: null }]));
        },
      },
      etags: {
        for: (comment) => communityCommentEtag(comment, HMAC_KEY),
        curation: (curation) => communityCurationEtag(curation, HMAC_KEY),
        settings: (settings) => communityCommentSettingsEtag(settings, HMAC_KEY),
      },
      audit: { async append(event) { effects.audits.push(event); } },
      clock: { async now() { return NOW; } },
    },
  };
}

export function identityKey(identity: CommunityTargetIdentity): string {
  return [identity.kind, identity.id, identity.collectionId ?? '', identity.seriesId ?? ''].join('|');
}

export function settingsInput(overrides: Partial<CommunityCommentSettingsInput> = {}): CommunityCommentSettingsInput {
  return {
    actor: CURATOR_ACTOR,
    target: { ...COLLECTION_TARGET },
    locked: true,
    reason: 'brigading',
    ifMatch: settingsTag(COMMUNITY_SETTINGS_VIRTUAL_REVISION),
    commandId: COMMAND_ID,
    ...overrides,
  };
}

export function commentRecord(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-parent',
    target: COLLECTION_IDENTITY,
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-parent',
    replyToId: null,
    depth: 0,
    authorAccountId: 'account-other',
    body: 'parent',
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function commandPorts(options: {
  settings?: CommunityCommentSettingsRecord | null;
  settingsFind?: (identity: CommunityTargetIdentity) => CommunityCommentSettingsRecord | null;
} = {}): { ports: CommunityCommentCommandPorts; inserted: CommunityCommentRecord[]; parentLocks: string[] } {
  const inserted: CommunityCommentRecord[] = [];
  const parentLocks: string[] = [];
  return {
    inserted, parentLocks,
    ports: {
      receipts: {
        async claim() { return { kind: 'claimed' }; },
        async complete() { return undefined; },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      actor: {
        async lockActiveAccount(accountId) {
          return accountId === AUTHOR ? { subjectId: AUTHOR_SUBJECT } : null;
        },
      },
      targets: {
        async lockResolved(identity) {
          return resolved({
            kind: identity.kind, id: identity.id,
            collectionId: identity.collectionId, seriesId: identity.seriesId,
            generation: identity.kind === 'bookmark' ? GENERATION : COMMUNITY_STATIC_GENERATION,
          } as CommunityTarget);
        },
      },
      comments: {
        async lockReplyTarget(commentId) {
          parentLocks.push(commentId);
          return commentRecord({ id: commentId, rootId: commentId });
        },
        async insert(record) { inserted.push(record); },
      },
      authors: {
        async publicActors(ids) {
          return new Map(ids.map((id) => [id, { handle: 'alice', displayName: 'Alice', avatarUrl: null }]));
        },
      },
      curators: {
        async canCurate(_identity, subjectId) { return subjectId === CURATOR_SUBJECT; },
      },
      settings: {
        async find(identity) {
          if (options.settingsFind !== undefined) return options.settingsFind(identity);
          return options.settings ?? null;
        },
      },
      notifications: {
        // CS-05: owner resolves to the author account so the create path
        // exercises the no-recipient (self) case; appends are no-ops.
        ownerAccountId: async () => AUTHOR,
        append: async () => undefined,
      },
      ids: { next: () => 'comment-minted' },
      etags: { for: (comment) => communityCommentEtag(comment, HMAC_KEY) },
      audit: { async append() { return undefined; } },
      clock: { async now() { return NOW; } },
    },
  };
}
