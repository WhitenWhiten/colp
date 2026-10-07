import assert from 'node:assert/strict';
import {
  COMMUNITY_STATIC_GENERATION,
  communityCommentEtag,
  communityCommentSettingsEtag,
  communityCurationEtag,
  type CommunityCommentCurationRecord,
  type CommunityCommentManagePorts,
  type CommunityCommentRecord,
  type CommunityCommentSettingsRecord,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
} from '../../../src/modules/community/index.js';
import { createCommunityMcpToolPort } from '../../../src/modules/mcp/community-mcp.js';
import type { McpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { McpApplicationToolResult } from '../../../src/modules/mcp/application-results.js';
import type { ProductCommandBinding, ProductCommandClaim } from '../../../src/modules/commands/index.js';

export const ACCOUNT = 'account-author';
export const SUBJECT = 'subject-author';
export const COLLECTION = 'col-1';
export const HMAC_KEY = Buffer.alloc(32, 17);
export const NOW = new Date('2026-10-03T10:00:00.000Z');
export const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';

export const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};

// The three independent ETag authorities, derived with the same configured
// key the composition injects — the current tags the stubs compare against
// and the stale tags a client might echo back after losing a race.
export const COMMENT_ETAG = communityCommentEtag({ id: 'comment-1', revision: '1' }, HMAC_KEY);
export const STALE_COMMENT_ETAG = communityCommentEtag({ id: 'comment-1', revision: '9' }, HMAC_KEY);
export const VIRTUAL_CURATION_ETAG = communityCurationEtag({ commentId: 'comment-1', revision: '1' }, HMAC_KEY);
export const STALE_CURATION_ETAG = communityCurationEtag({ commentId: 'comment-1', revision: '9' }, HMAC_KEY);
export const VIRTUAL_SETTINGS_ETAG = communityCommentSettingsEtag(
  { target: COLLECTION_TARGET, revision: '1' }, HMAC_KEY);
export const STALE_SETTINGS_ETAG = communityCommentSettingsEtag(
  { target: COLLECTION_TARGET, revision: '9' }, HMAC_KEY);

export function context(options: { authenticated?: boolean; scopes?: readonly string[] } = {}): McpApplicationContext {
  const authenticated = options.authenticated ?? true;
  return {
    principal: authenticated
      ? { kind: 'authenticated', principalId: ACCOUNT, clientId: 'client',
          credentialBindingId: 'binding', resourceAudience: 'aud', securityEpoch: '1' }
      : { kind: 'anonymous', principalId: 'public', resourceAudience: 'aud', securityEpoch: '1' },
    clientId: 'client',
    scopes: options.scopes ?? ['product:read', 'product:write'],
    resourceAudience: 'aud',
    abortSignal: new AbortController().signal,
    budgets: { maxDepth: 8, maxNodes: 256, maxBytes: 65_536, maxOperations: 8 },
    correlationId: 'corr-1',
    authorization: authenticated ? { accountSubjectId: SUBJECT } : {},
  };
}

export function record(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-1',
    target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-1', replyToId: null, depth: 0,
    authorAccountId: ACCOUNT, body: 'hello', state: 'visible',
    curationHidden: false,
    revision: 1n, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

export interface ManageEffects {
  lockedAccountId: string | null;
  claims: ProductCommandBinding[];
  updates: {
    commentId: string;
    expectedRevision: bigint;
    write: { readonly body: string | null; readonly state: 'visible' | 'deleted' };
    updatedAt: Date;
  }[];
  curationUpserts: CommunityCommentCurationRecord[];
  settingsUpserts: CommunityCommentSettingsRecord[];
  canCurateSubjectId: string | null;
  audits: { eventType: string; principalId: string }[];
}

export function commentManagePorts(options: {
  claim?: ProductCommandClaim;
  comment?: CommunityCommentRecord | null;
  resolvedNull?: boolean;
  updateNull?: boolean;
  canCurate?: boolean;
  curationRow?: CommunityCommentCurationRecord | null;
  settingsRow?: CommunityCommentSettingsRecord | null;
} = {}): { ports: CommunityCommentManagePorts; effects: ManageEffects } {
  const effects: ManageEffects = {
    lockedAccountId: null, claims: [], updates: [], curationUpserts: [],
    settingsUpserts: [], canCurateSubjectId: null, audits: [],
  };
  return {
    effects,
    ports: {
      receipts: {
        claim: async (binding) => {
          effects.claims.push(binding);
          return options.claim ?? { kind: 'claimed' };
        },
        complete: async () => undefined,
        purgeExpired: async () => 0,
        deletePrincipalReceipts: async () => 0,
      },
      actor: {
        lockActiveAccount: async (accountId) => {
          effects.lockedAccountId = accountId;
          return accountId === ACCOUNT ? { subjectId: SUBJECT } : null;
        },
      },
      targets: {
        lockResolved: async (identity) => options.resolvedNull === true ? null : ({
          target: { ...identity, generation: COMMUNITY_STATIC_GENERATION } as CommunityTarget,
          ownerSubjectId: 'subject-owner', title: 'T', href: '/t/1',
        }),
      },
      comments: {
        findById: async () => options.comment === undefined ? record() : options.comment,
        lockById: async () => options.comment === undefined ? record() : options.comment,
        update: async (commentId, expectedRevision, write, updatedAt) => {
          effects.updates.push({ commentId, expectedRevision, write, updatedAt });
          if (options.updateNull === true) return null;
          return record({ body: write.body, state: write.state, revision: 2n, updatedAt });
        },
        countVisibleThreadReplies: async (ids) => new Map(ids.map((id) => [id, 0])),
        countVisibleDirectReplies: async (ids) => new Map(ids.map((id) => [id, 0])),
      },
      curations: {
        lockByCommentId: async () => options.curationRow ?? null,
        upsert: async (row) => { effects.curationUpserts.push(row); return row; },
      },
      settings: {
        lockByTarget: async () => options.settingsRow ?? null,
        upsert: async (row) => { effects.settingsUpserts.push(row); return row; },
      },
      curators: {
        canCurate: async (_identity, subjectId) => {
          effects.canCurateSubjectId = subjectId;
          return options.canCurate ?? false;
        },
      },
      authors: {
        publicActors: async (ids) => new Map(
          ids.map((id) => [id, { handle: 'alice', displayName: 'Alice', avatarUrl: null }]),
        ),
      },
      etags: {
        for: (comment) => communityCommentEtag(comment, HMAC_KEY),
        curation: (curation) => communityCurationEtag(curation, HMAC_KEY),
        settings: (settings) => communityCommentSettingsEtag(settings, HMAC_KEY),
      },
      audit: {
        append: async (event) => {
          effects.audits.push({ eventType: event.eventType, principalId: event.principalId });
        },
      },
      clock: { now: async () => NOW },
    },
  };
}

export function port(input: {
  enabled?: boolean;
  manage?: CommunityCommentManagePorts;
} = {}) {
  return createCommunityMcpToolPort({
    enabled: input.enabled ?? true,
    targetQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityTargetQueryPorts) => Promise<Result>) =>
        work({} as CommunityTargetQueryPorts),
    },
    voteCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>) =>
        work({} as CommunityVoteCommandPorts),
    },
    ...(input.manage !== undefined ? {
      commentManageUnitOfWork: {
        execute: <Result>(work: (ports: CommunityCommentManagePorts) => Promise<Result>,
          _options?: { readonly signal?: AbortSignal }) => work(input.manage!),
      },
    } : {}),
  });
}

export function structured(result: McpApplicationToolResult): unknown {
  assert.equal(result.kind, 'complete');
  return result.kind === 'complete' ? result.structuredContent : undefined;
}

export function errorBody(result: McpApplicationToolResult): { code: string } {
  assert.equal(result.kind, 'complete');
  assert.equal(result.kind === 'complete' && result.isError, true);
  const body = structured(result) as { error: { code: string; message: string } };
  assert.deepEqual(Object.keys(body), ['error']);
  return body.error;
}

export const editArgs = {
  path: { commentId: 'comment-1' },
  body: { body: 'edited body' },
  commandId: COMMAND_ID,
  ifMatch: COMMENT_ETAG,
};
export const deleteArgs = {
  path: { commentId: 'comment-1' },
  commandId: COMMAND_ID,
  ifMatch: COMMENT_ETAG,
};
export const curateArgs = {
  path: { commentId: 'comment-1' },
  body: { hidden: true, reason: 'spam' },
  commandId: COMMAND_ID,
  ifMatch: VIRTUAL_CURATION_ETAG,
};
export const configureArgs = {
  body: { target: COLLECTION_TARGET, locked: true, reason: 'cleanup' },
  commandId: COMMAND_ID,
  ifMatch: VIRTUAL_SETTINGS_ETAG,
};
