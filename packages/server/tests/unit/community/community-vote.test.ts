import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_SELF_VOTE_MESSAGE,
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  COMMUNITY_TARGET_STALE_MESSAGE,
  COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION,
  CommunityTargetError,
  CommunityVoteCommandError,
  communityTargetIdentity,
  communityTargetMatches,
  communityTargetViewEtag,
  communityVoteCommandFingerprint,
  parseCommunityTarget,
  parseCommunityTargetQuery,
  parseCommunityVoteValue,
  resolveCommunityTargetView,
  setCommunityVote,
  type CommunityCommentSettingsRecord,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandInput,
  type CommunityVoteCommandPorts,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';

const ACCOUNT = 'account-voter';
const SUBJECT = 'subject-voter';
const OWNER_SUBJECT = 'subject-owner';
const COLLECTION = 'collection-target';
const NODE = 'node-bookmark';
const SERIES = 'series-digest';
const EDITION = 'edition-digest';
const GENERATION = 'bm-gen-0123456789abcdef';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const NOW = new Date('2026-10-01T08:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const BOOKMARK_TARGET: CommunityTarget = {
  kind: 'bookmark', id: NODE, collectionId: COLLECTION,
  seriesId: null, generation: GENERATION,
};
const EDITION_TARGET: CommunityTarget = {
  kind: 'digest_edition', id: EDITION,
  collectionId: null, seriesId: SERIES, generation: COMMUNITY_STATIC_GENERATION,
};

function resolved(target: CommunityTarget, ownerSubjectId = OWNER_SUBJECT): ResolvedCommunityTarget {
  return { target, ownerSubjectId, title: 'Target title', href: 'https://known.example/t/1' };
}

/* ——— target query parsing ——— */

test('parseCommunityTargetQuery accepts every kind with its required parents', () => {
  assert.deepEqual(parseCommunityTargetQuery({ kind: 'collection', id: COLLECTION }),
    { kind: 'collection', id: COLLECTION });
  assert.deepEqual(parseCommunityTargetQuery({ kind: 'digest_series', id: SERIES }),
    { kind: 'digest_series', id: SERIES });
  assert.deepEqual(parseCommunityTargetQuery({ kind: 'bookmark', id: NODE, collectionId: COLLECTION }),
    { kind: 'bookmark', id: NODE, collectionId: COLLECTION });
  assert.deepEqual(parseCommunityTargetQuery({ kind: 'digest_edition', id: EDITION, seriesId: SERIES }),
    { kind: 'digest_edition', id: EDITION, seriesId: SERIES });
});

test('parseCommunityTargetQuery enforces conditional parent rules per kind', () => {
  const invalid: Readonly<Record<string, unknown>>[] = [
    { kind: 'unknown', id: 'x' },
    { kind: 'collection', id: 'bad/id' },
    { kind: 'collection', id: 'x'.repeat(129) },
    { kind: 'collection', id: 'x', collectionId: 'p' },
    { kind: 'digest_series', id: 'x', seriesId: 'p' },
    { kind: 'bookmark', id: 'x' },
    { kind: 'bookmark', id: 'x', collectionId: 'p', seriesId: 'q' },
    { kind: 'bookmark', id: 'x', collectionId: null },
    { kind: 'digest_edition', id: 'x' },
    { kind: 'digest_edition', id: 'x', seriesId: 'p', collectionId: 'q' },
    { kind: 'digest_edition', id: 'x', seriesId: null },
    { kind: 'collection', id: '' },
  ];
  for (const query of invalid) {
    assert.throws(() => parseCommunityTargetQuery(query),
      (error: unknown) => error instanceof CommunityTargetError && error.code === 'invalid_query',
      JSON.stringify(query));
  }
});

/* ——— closed Target object parsing ——— */

test('parseCommunityTarget round-trips every well-formed target', () => {
  for (const target of [COLLECTION_TARGET, BOOKMARK_TARGET, EDITION_TARGET,
    { kind: 'digest_series', id: SERIES, collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION }]) {
    assert.deepEqual(parseCommunityTarget({ ...target }), target);
  }
});

test('parseCommunityTarget rejects open objects, wrong parents and bad generations', () => {
  const bad: unknown[] = [
    null, 'collection', [{ ...COLLECTION_TARGET }],
    { ...COLLECTION_TARGET, extra: 'x' },
    { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
    { ...COLLECTION_TARGET, collectionId: 'other' },
    { ...COLLECTION_TARGET, generation: 'static-v2' },
    { ...COLLECTION_TARGET, generation: GENERATION },
    { ...BOOKMARK_TARGET, seriesId: 's' },
    { ...BOOKMARK_TARGET, generation: COMMUNITY_STATIC_GENERATION },
    { ...BOOKMARK_TARGET, generation: 'client-made' },
    { ...EDITION_TARGET, seriesId: null },
    { ...EDITION_TARGET, collectionId: 'c' },
    { ...EDITION_TARGET, generation: GENERATION },
  ];
  for (const value of bad) {
    assert.throws(() => parseCommunityTarget(value),
      (error: unknown) => error instanceof CommunityTargetError && error.code === 'invalid_request',
      JSON.stringify(value));
  }
});

test('parseCommunityVoteValue accepts only -1, 0 and 1', () => {
  assert.equal(parseCommunityVoteValue(-1), -1);
  assert.equal(parseCommunityVoteValue(0), 0);
  assert.equal(parseCommunityVoteValue(1), 1);
  for (const value of [2, -2, '1', 'up', null, undefined, true, NaN]) {
    assert.throws(() => parseCommunityVoteValue(value),
      (error: unknown) => error instanceof CommunityTargetError && error.code === 'invalid_request',
      String(value));
  }
});

test('communityTargetMatches compares kind, ids and generation exactly', () => {
  assert.equal(communityTargetMatches(COLLECTION_TARGET, { ...COLLECTION_TARGET }), true);
  assert.equal(communityTargetMatches(BOOKMARK_TARGET, { ...BOOKMARK_TARGET }), true);
  assert.equal(communityTargetMatches(BOOKMARK_TARGET,
    { ...BOOKMARK_TARGET, generation: 'bm-gen-fedcba9876543210' }), false);
  assert.equal(communityTargetMatches(BOOKMARK_TARGET,
    { ...BOOKMARK_TARGET, collectionId: 'collection-other' }), false);
  assert.equal(communityTargetMatches(EDITION_TARGET,
    { ...EDITION_TARGET, seriesId: 'series-other' }), false);
  assert.deepEqual(communityTargetIdentity(BOOKMARK_TARGET), {
    kind: 'bookmark', id: NODE, collectionId: COLLECTION, seriesId: null,
  });
});

/* ——— resolveCommunityTargetView ——— */

function queryPorts(options: {
  target?: ResolvedCommunityTarget | null;
  counts?: { up: number; down: number; myVote: -1 | 0 | 1 | null };
  areaLocked?: boolean;
} = {}): CommunityTargetQueryPorts {
  const target = options.target === undefined ? resolved(COLLECTION_TARGET) : options.target;
  return {
    targets: {
      async resolve() { return target; },
    },
    votes: {
      async readCounts() { return options.counts ?? { up: 2, down: 1, myVote: 0 }; },
    },
    curators: {
      // CS-04: the resolved owner curates; any other subject does not.
      async canCurate(_identity, subjectId) {
        return target !== null && subjectId === target.ownerSubjectId;
      },
    },
    settings: {
      async find() {
        return options.areaLocked === true ? lockedSettingsRecord() : null;
      },
    },
  };
}

function lockedSettingsRecord(): CommunityCommentSettingsRecord {
  return Object.freeze({
    target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
    locked: true, reason: 'Moderation pause', revision: 2n,
    updatedByAccountId: 'account-owner', updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

test('concealed targets produce a uniform resource_not_found', async () => {
  await assert.rejects(() => resolveCommunityTargetView(queryPorts({ target: null }), {
    viewer: { accountId: ACCOUNT, subjectId: SUBJECT },
    query: { kind: 'collection', id: COLLECTION },
  }), (error: unknown) => error instanceof CommunityTargetError
    && error.code === 'resource_not_found'
    && error.message === COMMUNITY_TARGET_CONCEALED_MESSAGE);
});

test('anonymous viewers see counts but cannot vote or comment', async () => {
  const view = await resolveCommunityTargetView(queryPorts({
    counts: { up: 5, down: 2, myVote: null },
  }), {
    viewer: { accountId: null, subjectId: null },
    query: { kind: 'collection', id: COLLECTION },
  });
  assert.deepEqual({ up: view.votes.up, down: view.votes.down, myVote: view.votes.myVote },
    { up: 5, down: 2, myVote: null });
  assert.equal(view.canVote, false);
  assert.equal(view.canComment, false);
  assert.equal(view.commentDeniedReason, 'anonymous');
  assert.equal(view.canCurateComments, false);
});

test('authenticated non-owners can vote and comment; owners cannot vote but can curate', async () => {
  const voter = await resolveCommunityTargetView(queryPorts(), {
    viewer: { accountId: ACCOUNT, subjectId: SUBJECT },
    query: { kind: 'collection', id: COLLECTION },
  });
  assert.equal(voter.canVote, true);
  assert.equal(voter.canComment, true);
  assert.equal(voter.commentDeniedReason, null);
  assert.equal(voter.canCurateComments, false);

  const owner = await resolveCommunityTargetView(queryPorts(), {
    viewer: { accountId: ACCOUNT, subjectId: OWNER_SUBJECT },
    query: { kind: 'collection', id: COLLECTION },
  });
  assert.equal(owner.canVote, false);
  assert.equal(owner.canComment, true);
  assert.equal(owner.commentDeniedReason, null);
  assert.equal(owner.canCurateComments, true);
});

test('a locked comment area denies signed-in viewers with the locked reason', async () => {
  // CS-04: the lock rejects every new write, curators included — the view
  // must agree with the write path instead of inviting a doomed comment.
  const reader = await resolveCommunityTargetView(queryPorts({ areaLocked: true }), {
    viewer: { accountId: ACCOUNT, subjectId: SUBJECT },
    query: { kind: 'collection', id: COLLECTION },
  });
  assert.equal(reader.canComment, false);
  assert.equal(reader.commentDeniedReason, 'locked');
  assert.equal(reader.canVote, true);

  const owner = await resolveCommunityTargetView(queryPorts({ areaLocked: true }), {
    viewer: { accountId: ACCOUNT, subjectId: OWNER_SUBJECT },
    query: { kind: 'collection', id: COLLECTION },
  });
  assert.equal(owner.canComment, false);
  assert.equal(owner.commentDeniedReason, 'locked');
  assert.equal(owner.canCurateComments, true);

  // Anonymous viewers stay 'anonymous' even on a locked area, and the
  // settings row is never read for them.
  const anonymous = await resolveCommunityTargetView(queryPorts({ areaLocked: true }), {
    viewer: { accountId: null, subjectId: null },
    query: { kind: 'collection', id: COLLECTION },
  });
  assert.equal(anonymous.canComment, false);
  assert.equal(anonymous.commentDeniedReason, 'anonymous');
});

test('target-view ETag is deterministic and bound to the configured key', async () => {
  const view = await resolveCommunityTargetView(queryPorts(), {
    viewer: { accountId: ACCOUNT, subjectId: SUBJECT },
    query: { kind: 'collection', id: COLLECTION },
  });
  const key = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 9);
  const tag = communityTargetViewEtag(view, key);
  assert.match(tag, /^"community-target:[A-Za-z0-9_-]{32}"$/u);
  assert.equal(tag, communityTargetViewEtag(view, key));
  assert.notEqual(tag, communityTargetViewEtag(view, other));
  assert.notEqual(tag, communityTargetViewEtag({ ...view, title: 'other' }, key));
});

/* ——— setCommunityVote command ——— */

interface Effects {
  upserted: [string, string, 1 | -1][];
  removed: number;
  counted: number;
  audit: number;
  completed: number;
  lockResolved: number;
  enqueued: number;
}

function commandInput(overrides: Partial<CommunityVoteCommandInput> = {}): CommunityVoteCommandInput {
  return {
    actor: { principalId: ACCOUNT, subjectId: SUBJECT },
    target: COLLECTION_TARGET,
    value: 1,
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function commandPorts(options: {
  claim?: Awaited<ReturnType<CommunityVoteCommandPorts['receipts']['claim']>>;
  account?: { subjectId: string } | null;
  target?: CommunityTarget;
  resolvedTarget?: ResolvedCommunityTarget | null;
  current?: { value: -1 | 0 | 1; generation: string } | null;
  counts?: { up: number; down: number };
  ownerSubjectId?: string;
} = {}): { ports: CommunityVoteCommandPorts; effects: Effects } {
  const effects: Effects = {
    upserted: [], removed: 0, counted: 0, audit: 0, completed: 0, lockResolved: 0,
    enqueued: 0,
  };
  const target = options.target ?? COLLECTION_TARGET;
  return {
    effects,
    ports: {
      receipts: {
        async claim() { return options.claim ?? { kind: 'claimed' }; },
        async complete(_binding, _fingerprint, receipt) {
          effects.completed += 1;
          assert.equal(receipt.contractVersion, COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION);
          assert.equal(receipt.targetIdentity, `${target.kind}:${target.id}`);
          assert.equal(receipt.status, 200);
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      actor: {
        async lockActiveAccount(accountId) {
          if (options.account === null) return null;
          const account = options.account ?? { subjectId: SUBJECT };
          return accountId === ACCOUNT ? account : null;
        },
      },
      targets: {
        async lockResolved(identity) {
          effects.lockResolved += 1;
          if ('resolvedTarget' in options) return options.resolvedTarget ?? null;
          if (identity.id !== target.id || identity.kind !== target.kind) return null;
          return resolved(target, options.ownerSubjectId ?? OWNER_SUBJECT);
        },
      },
      votes: {
        async lockOwn() { return options.current ?? null; },
        async upsert(_accountId, identity, generation, value) {
          effects.upserted.push([identity.id, generation, value]);
        },
        async remove() { effects.removed += 1; },
        async count() {
          effects.counted += 1;
          return options.counts ?? { up: 4, down: 1 };
        },
      },
      refreshes: { async enqueue() { effects.enqueued += 1; } },
      audit: { async append(event) {
        effects.audit += 1;
        assert.deepEqual(Object.keys(event).sort(), [
          'changed', 'createdAt', 'generation', 'previousValue', 'principalId', 'target', 'value',
        ]);
      } },
      clock: { async now() { return NOW; } },
    },
  };
}

test('first upvote persists authority, audit and receipt in one transaction', async () => {
  const fixture = commandPorts();
  const result = await setCommunityVote(fixture.ports, commandInput());
  assert.equal(result.kind, 'succeeded');
  assert.equal(result.kind === 'succeeded' && result.state.myVote, 1);
  assert.equal(result.kind === 'succeeded' && result.state.up, 4);
  assert.deepEqual(fixture.effects.upserted, [[COLLECTION, COMMUNITY_STATIC_GENERATION, 1]]);
  assert.equal(fixture.effects.removed, 0);
  assert.equal(fixture.effects.counted, 1);
  assert.equal(fixture.effects.audit, 1);
  assert.equal(fixture.effects.completed, 1);
  assert.equal(fixture.effects.enqueued, 1, 'a real vote mutation enqueues one ranking refresh');
});

test('value 0 removes the stored row and reports the reconciled counts', async () => {
  const fixture = commandPorts({ current: { value: 1, generation: COMMUNITY_STATIC_GENERATION } });
  const result = await setCommunityVote(fixture.ports, commandInput({ value: 0 }));
  assert.equal(result.kind, 'succeeded');
  assert.equal(result.kind === 'succeeded' && result.state.myVote, 0);
  assert.deepEqual(fixture.effects.upserted, []);
  assert.equal(fixture.effects.removed, 1);
  assert.equal(fixture.effects.enqueued, 1, 'an unvote is a real mutation and enqueues a refresh');
});

test('a stored vote on a superseded generation no longer counts as the previous value', async () => {
  const fixture = commandPorts({ current: { value: -1, generation: 'bm-gen-old' }, target: BOOKMARK_TARGET });
  const result = await setCommunityVote(fixture.ports, commandInput({ target: BOOKMARK_TARGET, value: 1 }));
  assert.equal(result.kind, 'succeeded');
  // previousValue 0 → upsert rebinds the row to the current generation.
  assert.deepEqual(fixture.effects.upserted, [[NODE, GENERATION, 1]]);
  assert.equal(fixture.effects.enqueued, 1);
});

test('no-op vote still completes its receipt without an authority write', async () => {
  const fixture = commandPorts({ current: { value: 1, generation: COMMUNITY_STATIC_GENERATION } });
  const result = await setCommunityVote(fixture.ports, commandInput());
  assert.equal(result.kind, 'succeeded');
  assert.deepEqual(fixture.effects.upserted, []);
  assert.equal(fixture.effects.removed, 0);
  assert.equal(fixture.effects.audit, 1);
  assert.equal(fixture.effects.completed, 1);
  assert.equal(fixture.effects.enqueued, 0,
    'a no-op vote mutates nothing and must not force a ranking rebuild');
});

test('exact replay returns the saved outcome with no locks beyond resolve', async () => {
  const replay = {
    status: 200,
    body: Buffer.from('{"up":4,"down":1,"myVote":1}'),
    stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_VOTE_COMMAND_CONTRACT_VERSION,
    targetIdentity: `collection:${COLLECTION}`,
  } as const;
  const fixture = commandPorts({ claim: { kind: 'replay', result: replay } });
  assert.deepEqual(await setCommunityVote(fixture.ports, commandInput()), { kind: 'replay', ...replay });
  assert.equal(fixture.effects.lockResolved, 1);
  assert.equal(fixture.effects.counted + fixture.effects.audit + fixture.effects.completed, 0);
  assert.deepEqual(fixture.effects.upserted, []);
  assert.equal(fixture.effects.enqueued, 0, 'a replay never re-enqueues a refresh');
});

test('reused and in_progress claims return before any precondition or write', async () => {
  const reused = commandPorts({ claim: { kind: 'reused' } });
  assert.deepEqual(await setCommunityVote(reused.ports, commandInput()), { kind: 'reused' });
  assert.equal(reused.effects.counted + reused.effects.audit + reused.effects.completed, 0);
  assert.equal(reused.effects.enqueued, 0);

  const inProgress = commandPorts({ claim: { kind: 'in_progress', retryAfterSeconds: 2 } });
  assert.deepEqual(await setCommunityVote(inProgress.ports, commandInput()),
    { kind: 'in_progress', retryAfterSeconds: 2 });
  assert.equal(inProgress.effects.enqueued, 0);
});

test('a stale supplied target maps to revision_conflict after the claim', async () => {
  const stale = { ...BOOKMARK_TARGET, generation: 'bm-gen-superseded' };
  const fixture = commandPorts({ target: BOOKMARK_TARGET });
  await assert.rejects(() => setCommunityVote(fixture.ports, commandInput({ target: stale })),
    (error: unknown) => error instanceof CommunityVoteCommandError
      && error.code === 'revision_conflict'
      && error.message === COMMUNITY_TARGET_STALE_MESSAGE);
});

test('self-vote is rejected with insufficient_permission and the locked message', async () => {
  const fixture = commandPorts({ ownerSubjectId: SUBJECT });
  await assert.rejects(() => setCommunityVote(fixture.ports, commandInput()),
    (error: unknown) => error instanceof CommunityVoteCommandError
      && error.code === 'insufficient_permission'
      && error.message === COMMUNITY_SELF_VOTE_MESSAGE);
});

test('concealed target and inactive/mismatched account both map to resource_not_found', async () => {
  const missing = commandPorts({ resolvedTarget: null });
  await assert.rejects(() => setCommunityVote(missing.ports, commandInput()),
    (error: unknown) => error instanceof CommunityVoteCommandError
      && error.code === 'resource_not_found'
      && error.message === COMMUNITY_TARGET_CONCEALED_MESSAGE);

  const inactive = commandPorts({ account: null });
  await assert.rejects(() => setCommunityVote(inactive.ports, commandInput()),
    (error: unknown) => error instanceof CommunityVoteCommandError
      && error.code === 'resource_not_found');
  assert.equal(inactive.effects.lockResolved, 0, 'account check precedes target lock');

  const mismatched = commandPorts({ account: { subjectId: 'subject-other' } });
  await assert.rejects(() => setCommunityVote(mismatched.ports, commandInput()),
    (error: unknown) => error instanceof CommunityVoteCommandError
      && error.code === 'resource_not_found');
});

test('invalid inputs reject before any port call', async () => {
  for (const override of [
    { actor: { principalId: '', subjectId: SUBJECT } },
    { actor: { principalId: ACCOUNT, subjectId: ' padded ' } },
    { target: { kind: 'collection', id: COLLECTION } },
    { value: 2 },
    { value: 'up' },
    { commandId: 'not-a-uuid' },
  ] as const) {
    const fixture = commandPorts();
    await assert.rejects(() => setCommunityVote(fixture.ports, commandInput(override)),
      (error: unknown) => error instanceof CommunityVoteCommandError
        && error.code === 'invalid_request', JSON.stringify(override));
    assert.equal(fixture.effects.lockResolved, 0);
    assert.equal(fixture.effects.completed, 0);
  }
});

test('fingerprint binds actor principal, closed target and value', () => {
  const base = communityVoteCommandFingerprint({
    actorPrincipalId: ACCOUNT, target: COLLECTION_TARGET, value: 1,
  });
  assert.equal(base, communityVoteCommandFingerprint({
    actorPrincipalId: ACCOUNT, target: COLLECTION_TARGET, value: 1,
  }));
  assert.notEqual(base, communityVoteCommandFingerprint({
    actorPrincipalId: 'account-other', target: COLLECTION_TARGET, value: 1,
  }));
  assert.notEqual(base, communityVoteCommandFingerprint({
    actorPrincipalId: ACCOUNT, target: COLLECTION_TARGET, value: -1,
  }));
  assert.notEqual(base, communityVoteCommandFingerprint({
    actorPrincipalId: ACCOUNT, target: { ...COLLECTION_TARGET, id: 'collection-other' }, value: 1,
  }));
});
