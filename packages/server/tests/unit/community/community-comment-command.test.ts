import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
  COMMUNITY_COMMENT_COMMAND_SCOPE,
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_COMMENT_DEPTH_MESSAGE,
  COMMUNITY_COMMENT_TARGET_STALE_MESSAGE,
  COMMUNITY_REPLY_TARGET_MISMATCH_MESSAGE,
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  CommunityCommentError,
  communityCommentCommandFingerprint,
  communityCommentEtag,
  createCommunityComment,
  type CommunityCommentCommandInput,
  type CommunityCommentCommandPorts,
  type CommunityCommentRecord,
  type CommunityTarget,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';

const ACCOUNT = 'account-author';
const SUBJECT = 'subject-author';
const OWNER_SUBJECT = 'subject-owner';
const OWNER_ACCOUNT = 'account-owner';
const COLLECTION = 'collection-target';
const NODE = 'node-bookmark';
const GENERATION = 'bm-gen-0123456789abcdef';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const HMAC_KEY = Buffer.alloc(32, 5);
const NOW = new Date('2026-10-03T10:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: NODE, collectionId: COLLECTION,
  seriesId: null, generation: GENERATION,
};

function resolved(target: CommunityTarget, ownerSubjectId = OWNER_SUBJECT): ResolvedCommunityTarget {
  return { target, ownerSubjectId, title: 'Target title', href: 'https://known.example/t/1' };
}

function parentRecord(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-parent',
    target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
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

interface Effects {
  inserted: CommunityCommentRecord[];
  audits: number;
  completed: number;
  parentLocks: string[];
  accountLocks: number;
  targetLocks: number;
  idCounter: number;
  notificationAppends: { commentId: string; recipientAccountId: string }[];
}

function commandInput(overrides: Partial<CommunityCommentCommandInput> = {}): CommunityCommentCommandInput {
  return {
    actor: { principalId: ACCOUNT, subjectId: SUBJECT },
    target: { ...COLLECTION_TARGET },
    body: 'hello',
    replyToId: null,
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function commandPorts(options: {
  claim?: Awaited<ReturnType<CommunityCommentCommandPorts['receipts']['claim']>>;
  account?: { subjectId: string } | null;
  resolvedTarget?: ResolvedCommunityTarget | null;
  parent?: CommunityCommentRecord | null;
  authorLive?: boolean;
  settings?: Awaited<ReturnType<CommunityCommentCommandPorts['settings']['find']>>;
} = {}): { ports: CommunityCommentCommandPorts; effects: Effects } {
  const effects: Effects = {
    inserted: [], audits: 0, completed: 0, parentLocks: [],
    accountLocks: 0, targetLocks: 0, idCounter: 0, notificationAppends: [],
  };
  return {
    effects,
    ports: {
      receipts: {
        async claim() { return options.claim ?? { kind: 'claimed' }; },
        async complete(_binding, _fingerprint, receipt) {
          effects.completed += 1;
          assert.equal(receipt.contractVersion, COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION);
          assert.equal(receipt.status, 201);
          assert.equal(receipt.mediaType, 'application/json');
          assert.match(String(receipt.stableHeaders.etag), /^"community-comment:[A-Za-z0-9_-]{32}"$/u);
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      actor: {
        async lockActiveAccount(accountId) {
          effects.accountLocks += 1;
          if (options.account === null) return null;
          const account = options.account ?? { subjectId: SUBJECT };
          return accountId === ACCOUNT ? account : null;
        },
      },
      targets: {
        async lockResolved(identity) {
          effects.targetLocks += 1;
          if ('resolvedTarget' in options) return options.resolvedTarget ?? null;
          return resolved({
            kind: identity.kind, id: identity.id,
            collectionId: identity.collectionId, seriesId: identity.seriesId,
            generation: identity.kind === 'bookmark' ? GENERATION : COMMUNITY_STATIC_GENERATION,
          } as CommunityTarget);
        },
      },
      comments: {
        async lockReplyTarget(commentId) {
          effects.parentLocks.push(commentId);
          if (options.parent === undefined) return parentRecord();
          return options.parent;
        },
        async insert(record) { effects.inserted.push(record); },
      },
      authors: {
        async publicActors(accountIds) {
          const map = new Map();
          if (options.authorLive !== false) {
            for (const id of accountIds) {
              map.set(id, { handle: 'alice', displayName: 'Alice', avatarUrl: null });
            }
          }
          return map;
        },
      },
      curators: {
        // CS-04: only the resolved owner subject curates this fixture target.
        async canCurate(_identity, subjectId) { return subjectId === OWNER_SUBJECT; },
      },
      settings: {
        // No settings row: the comment area is unlocked for every write.
        async find() { return options.settings ?? null; },
      },
      notifications: {
        // CS-05: the resolved owner subject maps to the owner account;
        // appends are recorded for recipient assertions.
        async ownerAccountId(ownerSubjectId) {
          return ownerSubjectId === OWNER_SUBJECT ? OWNER_ACCOUNT : null;
        },
        async append(input) {
          effects.notificationAppends.push({
            commentId: input.comment.id,
            recipientAccountId: input.recipientAccountId,
          });
        },
      },
      ids: { next: () => `comment-${++effects.idCounter}` },
      // The real opaque ETag derivation so the stored receipt header is
      // asserted against the production format, not a looser fake shape.
      etags: { for: (comment) => communityCommentEtag(comment, HMAC_KEY) },
      audit: { async append(event) {
        effects.audits += 1;
        assert.equal(event.principalId, ACCOUNT);
        assert.equal(event.depth, effects.inserted[0]?.depth);
      } },
      clock: { async now() { return NOW; } },
    },
  };
}

/* ——— input validation ——— */

test('invalid inputs reject before any port call', async () => {
  for (const override of [
    { actor: { principalId: '', subjectId: SUBJECT } },
    { actor: { principalId: ACCOUNT, subjectId: ' padded ' } },
    { target: { kind: 'collection', id: COLLECTION } },
    { target: 'collection' },
    { body: 5 },
    { body: '   ' },
    { body: 'x'.repeat(4001) },
    { replyToId: 'bad id!' },
    { commandId: 'not-a-uuid' },
    { commandId: COMMAND_ID.toUpperCase() },
  ] as const) {
    const fixture = commandPorts();
    await assert.rejects(
      () => createCommunityComment(fixture.ports, commandInput(override as Partial<CommunityCommentCommandInput>)),
      (error: unknown) => error instanceof CommunityCommentError && error.code === 'invalid_request',
      JSON.stringify(override));
    assert.equal(fixture.effects.accountLocks, 0);
    assert.equal(fixture.effects.inserted.length, 0);
  }
});

/* ——— receipt ordering ——— */

test('account check precedes target lock; concealed account maps to resource_not_found', async () => {
  const inactive = commandPorts({ account: null });
  await assert.rejects(() => createCommunityComment(inactive.ports, commandInput()),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'resource_not_found'
      && error.message === COMMUNITY_TARGET_CONCEALED_MESSAGE);
  assert.equal(inactive.effects.targetLocks, 0);

  const mismatched = commandPorts({ account: { subjectId: 'subject-other' } });
  await assert.rejects(() => createCommunityComment(mismatched.ports, commandInput()),
    (error: unknown) => error instanceof CommunityCommentError && error.code === 'resource_not_found');
});

test('concealed target maps to resource_not_found after the account lock', async () => {
  const fixture = commandPorts({ resolvedTarget: null });
  await assert.rejects(() => createCommunityComment(fixture.ports, commandInput()),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'resource_not_found'
      && error.message === COMMUNITY_COMMENT_CONCEALED_MESSAGE);
  assert.equal(fixture.effects.accountLocks, 1);
  assert.equal(fixture.effects.inserted.length, 0);
});

test('reused, in_progress and expired claims return before preconditions or writes', async () => {
  for (const [claim, expected] of [
    [{ kind: 'reused' as const }, { kind: 'reused' }],
    [{ kind: 'in_progress' as const, retryAfterSeconds: 2 }, { kind: 'in_progress', retryAfterSeconds: 2 }],
    [{ kind: 'expired' as const, resultDigest: 'abc' }, { kind: 'expired', resultDigest: 'abc' }],
  ] as const) {
    const fixture = commandPorts({ claim });
    assert.deepEqual(await createCommunityComment(fixture.ports, commandInput()), expected);
    assert.equal(fixture.effects.inserted.length, 0);
    assert.equal(fixture.effects.completed, 0);
  }
});

test('exact replay returns the saved result after account and target re-proof', async () => {
  const replay = {
    status: 201,
    body: Buffer.from('{"id":"comment-9"}'),
    stableHeaders: { 'cache-control': 'private, no-store', etag: '"community-comment:x"' },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
    targetIdentity: 'comment:comment-9',
  } as const;
  const fixture = commandPorts({ claim: { kind: 'replay', result: replay } });
  assert.deepEqual(await createCommunityComment(fixture.ports, commandInput()), { kind: 'replay', ...replay });
  // Access re-proved before the saved body may leak: account + target locked.
  assert.equal(fixture.effects.accountLocks, 1);
  assert.equal(fixture.effects.targetLocks, 1);
  assert.equal(fixture.effects.inserted.length, 0);
});

test('a supplied stale generation maps to revision_conflict after the claim', async () => {
  const stale = { ...BOOKMARK_TARGET, generation: 'bm-gen-superseded0000' };
  const fixture = commandPorts();
  await assert.rejects(
    () => createCommunityComment(fixture.ports, commandInput({ target: stale })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'revision_conflict'
      && error.message === COMMUNITY_COMMENT_TARGET_STALE_MESSAGE);
  assert.equal(fixture.effects.inserted.length, 0);
});

/* ——— mutation ——— */

test('root comment: self-rooted depth 0 row bound to the resolved generation', async () => {
  const fixture = commandPorts();
  const result = await createCommunityComment(fixture.ports, commandInput());
  assert.equal(result.kind, 'succeeded');
  const inserted = fixture.effects.inserted[0]!;
  assert.equal(inserted.depth, 0);
  assert.equal(inserted.replyToId, null);
  assert.equal(inserted.rootId, inserted.id);
  assert.equal(inserted.targetGeneration, COMMUNITY_STATIC_GENERATION);
  assert.equal(inserted.state, 'visible');
  assert.equal(inserted.revision, 1n);
  assert.equal(inserted.authorAccountId, ACCOUNT);
  assert.equal(fixture.effects.audits, 1);
  assert.equal(fixture.effects.completed, 1);
  assert.equal(fixture.effects.parentLocks.length, 0, 'roots never lock a parent');
  if (result.kind === 'succeeded') {
    assert.equal(result.comment.id, 'comment-1');
    assert.equal(result.comment.canEdit, true);
    assert.equal(result.comment.author.displayName, 'Alice');
    assert.deepEqual(result.comment.target, COLLECTION_TARGET);
  }
});

test('direct and nested replies inherit root and bump depth', async () => {
  const direct = commandPorts({ parent: parentRecord({ depth: 0 }) });
  const first = await createCommunityComment(direct.ports, commandInput({ replyToId: 'comment-parent' }));
  assert.equal(first.kind, 'succeeded');
  assert.deepEqual(direct.effects.parentLocks, ['comment-parent']);
  assert.equal(direct.effects.inserted[0]!.depth, 1);
  assert.equal(direct.effects.inserted[0]!.rootId, 'comment-parent');
  assert.equal(direct.effects.inserted[0]!.replyToId, 'comment-parent');

  const nested = commandPorts({
    parent: parentRecord({ id: 'comment-reply', rootId: 'comment-parent', depth: 1, replyToId: 'comment-parent' }),
  });
  const second = await createCommunityComment(nested.ports, commandInput({ replyToId: 'comment-reply' }));
  assert.equal(second.kind, 'succeeded');
  assert.equal(nested.effects.inserted[0]!.depth, 2);
  assert.equal(nested.effects.inserted[0]!.rootId, 'comment-parent');
  assert.equal(nested.effects.inserted[0]!.replyToId, 'comment-reply');
});

test('replying to a depth-2 comment is invalid_request', async () => {
  const fixture = commandPorts({
    parent: parentRecord({ id: 'comment-deep', rootId: 'comment-parent', depth: 2, replyToId: 'comment-reply' }),
  });
  await assert.rejects(
    () => createCommunityComment(fixture.ports, commandInput({ replyToId: 'comment-deep' })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'invalid_request'
      && error.message === COMMUNITY_COMMENT_DEPTH_MESSAGE);
  assert.equal(fixture.effects.inserted.length, 0);
});

test('reply parent must be a visible comment on the same target and generation', async () => {
  const cases: [string, Partial<CommunityCommentRecord>][] = [
    ['missing', null as unknown as Partial<CommunityCommentRecord>],
    ['tombstoned', { state: 'deleted', body: null }],
    ['hidden', { state: 'hidden' }],
    ['other generation', { targetGeneration: 'bm-gen-old' }],
    ['other target', { target: { kind: 'collection', id: 'collection-other', collectionId: null, seriesId: null } }],
    ['other kind', { target: { kind: 'digest_series', id: COLLECTION, collectionId: null, seriesId: null } }],
  ];
  for (const [name, parent] of cases) {
    const fixture = commandPorts({
      parent: name === 'missing' ? null : parentRecord(parent),
    });
    await assert.rejects(
      () => createCommunityComment(fixture.ports, commandInput({ replyToId: 'comment-parent' })),
      (error: unknown) => error instanceof CommunityCommentError
        && error.code === 'resource_not_found'
        && error.message === COMMUNITY_REPLY_TARGET_MISMATCH_MESSAGE,
      name);
    assert.equal(fixture.effects.inserted.length, 0, name);
  }
});

test('reply binds the resolved generation, not the supplied one', async () => {
  const fixture = commandPorts();
  await createCommunityComment(fixture.ports, commandInput({ target: { ...BOOKMARK_TARGET }, replyToId: null }));
  assert.equal(fixture.effects.inserted[0]!.targetGeneration, GENERATION);
  assert.deepEqual(fixture.effects.inserted[0]!.target, {
    kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: null,
  });
});

test('comment id is server-minted; fingerprint binds actor, target, body and replyToId', async () => {
  const base = communityCommentCommandFingerprint({
    actorPrincipalId: ACCOUNT, target: COLLECTION_TARGET, body: 'hi', replyToId: null,
  });
  assert.equal(base, communityCommentCommandFingerprint({
    actorPrincipalId: ACCOUNT, target: { ...COLLECTION_TARGET }, body: 'hi', replyToId: null,
  }));
  for (const variant of [
    { actorPrincipalId: 'account-other' },
    { body: 'other' },
    { replyToId: 'comment-1' },
    { target: { ...COLLECTION_TARGET, id: 'collection-other' } },
    { target: { ...COLLECTION_TARGET, generation: GENERATION } },
  ]) {
    assert.notEqual(base, communityCommentCommandFingerprint({
      actorPrincipalId: ACCOUNT, target: COLLECTION_TARGET, body: 'hi', replyToId: null,
      ...variant,
    }), JSON.stringify(variant));
  }
  assert.equal(COMMUNITY_COMMENT_COMMAND_SCOPE, 'community:comment-create:v1');
});
