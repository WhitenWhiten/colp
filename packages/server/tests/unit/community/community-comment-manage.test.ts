import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_COMMENT_DELETE_SCOPE,
  COMMUNITY_COMMENT_EDIT_SCOPE,
  COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
  COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE,
  COMMUNITY_COMMENT_NOT_DELETABLE_MESSAGE,
  COMMUNITY_COMMENT_NOT_EDITABLE_MESSAGE,
  COMMUNITY_COMMENT_PRECONDITION_MESSAGE,
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  CommunityCommentError,
  communityCommentDeleteFingerprint,
  communityCommentEditFingerprint,
  communityCommentEtag,
  communityCommentSettingsEtag,
  communityCurationEtag,
  deleteCommunityComment,
  editCommunityComment,
  type CommunityCommentDeleteInput,
  type CommunityCommentEditInput,
  type CommunityCommentManageAuditEvent,
  type CommunityCommentManagePorts,
  type CommunityCommentRecord,
  type CommunityTarget,
  type CommunityTargetIdentity,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import type { ProductCommandResult as ReceiptResult } from '../../../src/modules/commands/index.js';

const ACCOUNT = 'account-author';
const SUBJECT = 'subject-author';
const OTHER_ACCOUNT = 'account-other';
const OWNER_SUBJECT = 'subject-owner';
const COLLECTION = 'collection-target';
const COMMENT_ID = 'comment-1';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const COMMAND_ID_2 = '019fa956-0c4e-4190-94df-484c41fd9684';
const HMAC_KEY = Buffer.alloc(32, 7);
const NOW = new Date('2026-10-03T10:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const COLLECTION_IDENTITY: CommunityTargetIdentity = {
  kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null,
};

function commentRecord(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: COMMENT_ID,
    target: COLLECTION_IDENTITY,
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: COMMENT_ID,
    replyToId: null,
    depth: 0,
    authorAccountId: ACCOUNT,
    body: 'hello',
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resolved(target: CommunityTarget = COLLECTION_TARGET): ResolvedCommunityTarget {
  return { target, ownerSubjectId: OWNER_SUBJECT, title: 'Target title', href: '/t/1' };
}

/** The strong comment ETag the fixture authority would serve for a revision. */
function commentTag(revision: bigint | string, id = COMMENT_ID): string {
  return communityCommentEtag({ id, revision: revision.toString() }, HMAC_KEY);
}

interface ManageEffects {
  accountLocks: string[];
  commentLocks: string[];
  targetLocks: CommunityTargetIdentity[];
  /** Shared lock-order timeline: 'probe' | 'target' | 'comment' in call order. */
  lockOrder: string[];
  claims: { principalId: string; commandScope: string; commandId: string; fingerprint: string }[];
  completions: ReceiptResult[];
  updates: {
    commentId: string;
    expectedRevision: bigint;
    write: { body: string | null; state: 'visible' | 'deleted' };
    updatedAt: Date;
  }[];
  audits: CommunityCommentManageAuditEvent[];
  canCurateCalls: { identity: CommunityTargetIdentity; subjectId: string }[];
  authorLookups: readonly string[][];
  threadCountCalls: readonly string[][];
  directCountCalls: readonly string[][];
}

function managePorts(options: {
  claim?: Awaited<ReturnType<CommunityCommentManagePorts['receipts']['claim']>>;
  account?: { subjectId: string } | null;
  comment?: CommunityCommentRecord | null;
  resolved?: ResolvedCommunityTarget | null;
  /** Simulate the CAS row write losing the revision race. */
  updateMiss?: boolean;
  /** CS-C05: the durable row moved past the locked revision (fresh etag). */
  updateMissFreshRevision?: boolean;
  canCurate?: (subjectId: string) => boolean;
  authorLive?: boolean;
  now?: Date | unknown;
} = {}): { ports: CommunityCommentManagePorts; effects: ManageEffects } {
  const effects: ManageEffects = {
    accountLocks: [], commentLocks: [], targetLocks: [], lockOrder: [],
    claims: [], completions: [], updates: [], audits: [],
    canCurateCalls: [], authorLookups: [], threadCountCalls: [], directCountCalls: [],
  };
  const recordOf = () => (options.comment === undefined ? commentRecord() : options.comment);
  let lockByIdCalls = 0;
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
          assert.equal(result.mediaType, 'application/json');
          assert.equal(result.stableHeaders['cache-control'], 'private, no-store');
          assert.equal(result.stableHeaders['content-type'], 'application/json');
          assert.match(String(result.stableHeaders.etag), /^"[a-z-]+:[A-Za-z0-9_-]{32}"$/u);
        },
        async purgeExpired() { return 0; },
        async deletePrincipalReceipts() { return 0; },
      },
      actor: {
        async lockActiveAccount(accountId) {
          effects.accountLocks.push(accountId);
          if (options.account === null) return null;
          if (options.account !== undefined) return options.account;
          if (accountId === ACCOUNT) return { subjectId: SUBJECT };
          if (accountId === OTHER_ACCOUNT) return { subjectId: 'subject-other' };
          return null;
        },
      },
      targets: {
        async lockResolved(identity) {
          effects.lockOrder.push('target');
          effects.targetLocks.push(identity);
          if ('resolved' in options) return options.resolved ?? null;
          return resolved({
            kind: identity.kind, id: identity.id,
            collectionId: identity.collectionId, seriesId: identity.seriesId,
            generation: COMMUNITY_STATIC_GENERATION,
          } as CommunityTarget);
        },
      },
      comments: {
        async findById(commentId) {
          effects.lockOrder.push('probe');
          return recordOf();
        },
        async lockById(commentId) {
          effects.lockOrder.push('comment');
          effects.commentLocks.push(commentId);
          lockByIdCalls += 1;
          const base = recordOf();
          // CS-C05: the fresh-etag re-read runs as the SECOND lockById (inside
          // freshCommentEtagAfterCasMiss after the CAS miss).
          if (base !== null && options.updateMissFreshRevision === true && lockByIdCalls === 2) {
            return { ...base, revision: 2n };
          }
          return base;
        },
        async update(commentId, expectedRevision, write, updatedAt) {
          effects.updates.push({ commentId, expectedRevision, write, updatedAt });
          if (options.updateMiss === true) return null;
          const base = recordOf();
          assert.equal(commentId, base!.id);
          // The durable CAS: the expected revision must equal the locked one.
          assert.equal(expectedRevision, base!.revision);
          return { ...base!, body: write.body, state: write.state,
            revision: base!.revision + 1n, updatedAt };
        },
        async countVisibleThreadReplies(ids) {
          effects.threadCountCalls.push(ids);
          return new Map(ids.map((id) => [id, 0]));
        },
        async countVisibleDirectReplies(ids) {
          effects.directCountCalls.push(ids);
          return new Map(ids.map((id) => [id, 0]));
        },
      },
      curations: {
        async lockByCommentId() { return null; },
        async upsert(record) { return record; },
      },
      settings: {
        async lockByTarget() { return null; },
        async upsert(record) { return record; },
      },
      curators: {
        async canCurate(identity, subjectId) {
          effects.canCurateCalls.push({ identity, subjectId });
          const predicate = options.canCurate ?? ((subject: string) => subject === OWNER_SUBJECT);
          return predicate(subjectId);
        },
      },
      authors: {
        async publicActors(accountIds) {
          effects.authorLookups.push(accountIds);
          const map = new Map();
          if (options.authorLive !== false) {
            for (const id of accountIds) {
              map.set(id, { handle: 'alice', displayName: 'Alice', avatarUrl: null });
            }
          }
          return map;
        },
      },
      etags: {
        for: (comment) => communityCommentEtag(comment, HMAC_KEY),
        curation: (curation) => communityCurationEtag(curation, HMAC_KEY),
        settings: (settings) => communityCommentSettingsEtag(settings, HMAC_KEY),
      },
      audit: {
        async append(event) { effects.audits.push(event); },
      },
      clock: {
        async now() { return (options.now === undefined ? NOW : options.now) as Date; },
      },
    },
  };
}

function editInput(overrides: Partial<CommunityCommentEditInput> = {}): CommunityCommentEditInput {
  return {
    actor: { principalId: ACCOUNT, subjectId: SUBJECT },
    commentId: COMMENT_ID,
    body: 'edited body',
    ifMatch: commentTag(1n),
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function deleteInput(overrides: Partial<CommunityCommentDeleteInput> = {}): CommunityCommentDeleteInput {
  return {
    actor: { principalId: ACCOUNT, subjectId: SUBJECT },
    commentId: COMMENT_ID,
    ifMatch: commentTag(1n),
    commandId: COMMAND_ID,
    ...overrides,
  };
}

function errorCheck(code: string, message?: string) {
  return (error: unknown) => error instanceof CommunityCommentError
    && error.code === code
    && (message === undefined || error.message === message);
}

/* ——— shared input validation ——— */

test('edit: invalid inputs reject before any port call', async () => {
  for (const override of [
    { actor: { principalId: '', subjectId: SUBJECT } },
    { actor: { principalId: ACCOUNT, subjectId: ' padded ' } },
    { actor: { principalId: 'x'.repeat(257), subjectId: SUBJECT } },
    { commentId: 'bad id!' },
    { commentId: 7 },
    { body: 5 },
    { body: '   ' },
    { body: 'x'.repeat(4_001) },
    { ifMatch: undefined },
    { ifMatch: 'not-an-etag' },
    { ifMatch: 'W/"weak"' },
    { ifMatch: '"a","b"' },
    { ifMatch: '"with\nnewline"' },
    { commandId: 'not-a-uuid' },
    { commandId: COMMAND_ID.toUpperCase() },
  ] as const) {
    const fixture = managePorts();
    await assert.rejects(
      () => editCommunityComment(fixture.ports, editInput(override as Partial<CommunityCommentEditInput>)),
      errorCheck('invalid_request'),
      JSON.stringify(override));
    assert.equal(fixture.effects.accountLocks.length, 0, JSON.stringify(override));
    assert.equal(fixture.effects.updates.length, 0);
  }
});

test('delete: invalid inputs reject before any port call', async () => {
  for (const override of [
    { actor: { principalId: ' ', subjectId: SUBJECT } },
    { commentId: 'bad id!' },
    { ifMatch: 'W/"weak"' },
    { ifMatch: '*' },
    { commandId: 'also-not-a-uuid' },
  ] as const) {
    const fixture = managePorts();
    await assert.rejects(
      () => deleteCommunityComment(fixture.ports, deleteInput(override as Partial<CommunityCommentDeleteInput>)),
      errorCheck('invalid_request'),
      JSON.stringify(override));
    assert.equal(fixture.effects.accountLocks.length, 0, JSON.stringify(override));
    assert.equal(fixture.effects.updates.length, 0);
  }
});

/* ——— context locking and concealment ——— */

test('edit/delete re-prove account, comment row and target before claiming', async () => {
  for (const command of [editCommunityComment, deleteCommunityComment] as const) {
    const isEdit = command === editCommunityComment;
    const input = () => (isEdit ? editInput() : deleteInput());

    const inactive = managePorts({ account: null });
    await assert.rejects(() => command(inactive.ports, input()),
      errorCheck('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE));
    assert.equal(inactive.effects.commentLocks.length, 0, 'comment never locked for a dead account');
    assert.equal(inactive.effects.claims.length, 0, 'dead account never claims');

    const mismatch = managePorts({ account: { subjectId: 'subject-other' } });
    await assert.rejects(() => command(mismatch.ports, input()), errorCheck('resource_not_found'));

    const missing = managePorts({ comment: null });
    await assert.rejects(() => command(missing.ports, input()),
      errorCheck('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE));
    assert.equal(missing.effects.accountLocks.length, 1);
    assert.equal(missing.effects.targetLocks.length, 0, 'no target lock without a comment row');

    const deadTarget = managePorts({ resolved: null });
    await assert.rejects(() => command(deadTarget.ports, input()), errorCheck('resource_not_found'));

    // A comment pinned to a superseded generation is concealed with the old content.
    const superseded = managePorts({
      comment: commentRecord({ targetGeneration: 'bm-gen-old' }),
    });
    await assert.rejects(() => command(superseded.ports, input()), errorCheck('resource_not_found'));
    assert.equal(superseded.effects.claims.length, 0);
  }
});

test('edit/delete map every non-claimed receipt kind and replay re-proves access', async () => {
  for (const command of [editCommunityComment, deleteCommunityComment] as const) {
    const input = () => (command === editCommunityComment ? editInput() : deleteInput());
    for (const [claim, expected] of [
      [{ kind: 'reused' as const }, { kind: 'reused' }],
      [{ kind: 'in_progress' as const, retryAfterSeconds: 2 }, { kind: 'in_progress', retryAfterSeconds: 2 }],
      [{ kind: 'expired' as const, resultDigest: 'abc' }, { kind: 'expired', resultDigest: 'abc' }],
    ] as const) {
      const fixture = managePorts({ claim });
      assert.deepEqual(await command(fixture.ports, input()), expected);
      assert.equal(fixture.effects.updates.length, 0);
      assert.equal(fixture.effects.completions.length, 0);
    }
    const replay = {
      status: 200,
      body: Buffer.from('{"id":"comment-1","revision":"2"}'),
      stableHeaders: { 'cache-control': 'private, no-store', etag: '"community-comment:x"' },
      mediaType: 'application/json',
      contractVersion: COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
      targetIdentity: 'comment:comment-1',
    } as const;
    const fixture = managePorts({ claim: { kind: 'replay', result: replay } });
    assert.deepEqual(await command(fixture.ports, input()), { kind: 'replay', ...replay });
    // The saved body may only leak after live access is re-proved.
    assert.equal(fixture.effects.accountLocks.length, 1);
    assert.equal(fixture.effects.commentLocks.length, 1);
    assert.equal(fixture.effects.targetLocks.length, 1);
    assert.equal(fixture.effects.updates.length, 0);
  }
});

/* ——— author edit ——— */

test('edit/delete lock the target row BEFORE the comment row (CS-C03 lock order)', async () => {
  // The create-reply chain locks the target then the parent comment; the
  // manage chain must use the same order or concurrent edit+reply on one
  // comment deadlocks. The probe read picks the immutable target identity
  // before either lock is taken.
  for (const command of [editCommunityComment, deleteCommunityComment] as const) {
    const input = () => (command === editCommunityComment ? editInput() : deleteInput());
    const fixture = managePorts();
    const result = await command(fixture.ports, input());
    assert.equal(result.kind, 'succeeded');
    const order = fixture.effects.lockOrder;
    const targetAt = order.indexOf('target');
    const commentAt = order.indexOf('comment');
    assert.ok(order[0] === 'probe', `probe read must lead both locks: ${order.join(' -> ')}`);
    assert.ok(targetAt !== -1 && commentAt !== -1, `both locks taken: ${order.join(' -> ')}`);
    assert.ok(targetAt < commentAt,
      `${command.name} must lock the target before the comment: ${order.join(' -> ')}`);
  }
});

test('edit: the author CAS-es the body forward and the revision advances', async () => {
  const fixture = managePorts();
  const result = await editCommunityComment(fixture.ports, editInput({ body: '  cafe\u0301 body  ' }));
  assert.equal(result.kind, 'succeeded');
  // Trim + NFC normalization happened before the write; revision CASed 1 → 2.
  assert.equal(fixture.effects.updates.length, 1);
  const update = fixture.effects.updates[0]!;
  assert.equal(update.commentId, COMMENT_ID);
  assert.equal(update.expectedRevision, 1n);
  assert.equal(update.write.state, 'visible');
  assert.equal(update.write.body, 'café body');
  assert.equal(update.updatedAt.getTime(), NOW.getTime());
  if (result.kind === 'succeeded') {
    assert.equal(result.value.id, COMMENT_ID);
    assert.equal(result.value.body, 'café body');
    assert.equal(result.value.state, 'visible');
    assert.equal(result.value.revision, '2');
    assert.equal(result.value.canEdit, true);
    assert.equal(result.value.canDelete, true);
    assert.equal(result.value.canCurate, false, 'the author is not a curator here');
    assert.equal(result.value.author.displayName, 'Alice');
  }
  // One immutable audit event and one completed receipt (200 + Comment + ETag).
  assert.equal(fixture.effects.audits.length, 1);
  const audit = fixture.effects.audits[0]!;
  assert.equal(audit.eventType, 'community.comment_edited');
  assert.equal(audit.principalId, ACCOUNT);
  assert.equal(audit.details.commentId, COMMENT_ID);
  assert.equal(audit.details.revision, '2');
  assert.equal(audit.details.targetKind, 'collection');
  assert.equal(fixture.effects.completions.length, 1);
  assert.equal(fixture.effects.completions[0]!.targetIdentity, `comment:${COMMENT_ID}`);
  assert.equal(fixture.effects.completions[0]!.stableHeaders.etag, commentTag(2n));
  assert.equal(fixture.effects.claims[0]!.commandScope, COMMUNITY_COMMENT_EDIT_SCOPE);
  assert.equal(COMMUNITY_COMMENT_EDIT_SCOPE, 'community:comment-edit:v1');
});

test('edit: only the author may edit — a non-author is refused after the claim', async () => {
  const fixture = managePorts();
  await assert.rejects(
    () => editCommunityComment(fixture.ports,
      editInput({ actor: { principalId: OTHER_ACCOUNT, subjectId: 'subject-other' } })),
    errorCheck('insufficient_permission', COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE));
  assert.equal(fixture.effects.claims.length, 1, 'the receipt claim precedes the author check');
  assert.equal(fixture.effects.updates.length, 0);
  assert.equal(fixture.effects.completions.length, 0);
});

test('edit: deleted and hidden comments are not editable', async () => {
  for (const comment of [
    commentRecord({ state: 'deleted', body: null }),
    commentRecord({ state: 'hidden' }),
    commentRecord({ state: 'visible', curationHidden: true }),
  ]) {
    const fixture = managePorts({ comment });
    await assert.rejects(
      () => editCommunityComment(fixture.ports, editInput()),
      errorCheck('invalid_request', COMMUNITY_COMMENT_NOT_EDITABLE_MESSAGE),
      `state=${comment.state} curationHidden=${comment.curationHidden}`);
    assert.equal(fixture.effects.updates.length, 0);
  }
});

test('edit: a stale or foreign If-Match is 412 precondition_failed with the current tag', async () => {
  // An older revision tag is stale.
  const stale = managePorts();
  await assert.rejects(
    () => editCommunityComment(stale.ports, editInput({ ifMatch: commentTag(0n) })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.message === COMMUNITY_COMMENT_PRECONDITION_MESSAGE
      && error.currentEtag === commentTag(1n));
  assert.equal(stale.effects.updates.length, 0);

  // A curation-domain ETag is strong but the wrong authority — never accepted.
  const foreignCuration = managePorts();
  const curationTag = communityCurationEtag({ commentId: COMMENT_ID, revision: '1' }, HMAC_KEY);
  await assert.rejects(
    () => editCommunityComment(foreignCuration.ports, editInput({ ifMatch: curationTag })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.currentEtag === commentTag(1n));

  // A settings-domain ETag is likewise foreign here.
  const foreignSettings = managePorts();
  const settingsTag = communityCommentSettingsEtag(
    { target: COLLECTION_TARGET, revision: '1' }, HMAC_KEY);
  await assert.rejects(
    () => editCommunityComment(foreignSettings.ports, editInput({ ifMatch: settingsTag })),
    errorCheck('precondition_failed'));

  // The row's revision raced forward between the lock and the CAS write —
  // the 412 must carry the FRESH revision's etag (CS-C05), not the stale one.
  const raced = managePorts({ updateMiss: true });
  await assert.rejects(
    () => editCommunityComment(raced.ports, editInput()),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.currentEtag === commentTag(1n, COMMENT_ID));
  assert.equal(raced.effects.completions.length, 0);
  const freshRaced = managePorts({ updateMiss: true, updateMissFreshRevision: true });
  await assert.rejects(
    () => editCommunityComment(freshRaced.ports, editInput()),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.currentEtag === commentTag(2n, COMMENT_ID));
});

/* ——— author delete ——— */

test('delete: the author tombstone keeps the reply structure and advances the revision', async () => {
  const reply = commentRecord({
    id: 'comment-reply', rootId: 'comment-root', replyToId: 'comment-parent', depth: 2,
  });
  const fixture = managePorts({ comment: reply });
  const result = await deleteCommunityComment(fixture.ports,
    deleteInput({ commentId: 'comment-reply', ifMatch: commentTag(1n, 'comment-reply') }));
  assert.equal(result.kind, 'succeeded');
  // The write is the permanent tombstone: body null, state deleted.
  assert.equal(fixture.effects.updates.length, 1);
  assert.equal(fixture.effects.updates[0]!.write.body, null);
  assert.equal(fixture.effects.updates[0]!.write.state, 'deleted');
  if (result.kind === 'succeeded') {
    // The wire tombstone: body is null but the thread position survives.
    assert.equal(result.value.body, null);
    assert.equal(result.value.state, 'deleted');
    assert.equal(result.value.revision, '2');
    assert.equal(result.value.rootId, 'comment-root');
    assert.equal(result.value.replyToId, 'comment-parent');
    assert.equal(result.value.depth, 2);
    assert.equal(result.value.canEdit, false);
    assert.equal(result.value.canDelete, false);
    assert.equal(result.value.replyCount, 0, 'depth-2 comments never count replies');
    // The author identity survives on the tombstone.
    assert.equal(result.value.author.id, ACCOUNT);
  }
  assert.equal(fixture.effects.audits.length, 1);
  const audit = fixture.effects.audits[0]!;
  assert.equal(audit.eventType, 'community.comment_deleted');
  assert.equal(audit.details.commentId, 'comment-reply');
  assert.equal(audit.details.rootId, 'comment-root');
  assert.equal(audit.details.replyToId, 'comment-parent');
  assert.equal(audit.details.depth, 2);
  assert.equal(fixture.effects.completions[0]!.targetIdentity, 'comment:comment-reply');
  assert.equal(fixture.effects.completions[0]!.stableHeaders.etag, commentTag(2n, 'comment-reply'));
  assert.equal(fixture.effects.claims[0]!.commandScope, COMMUNITY_COMMENT_DELETE_SCOPE);
  assert.equal(COMMUNITY_COMMENT_DELETE_SCOPE, 'community:comment-delete:v1');
});

test('delete: a root tombstone still counts its thread; reply rows are untouched', async () => {
  const fixture = managePorts();
  const result = await deleteCommunityComment(fixture.ports, deleteInput());
  assert.equal(result.kind, 'succeeded');
  // Depth 0 asks the thread counter — the reply tree is never rewritten.
  assert.deepEqual(fixture.effects.threadCountCalls, [[COMMENT_ID]]);
  assert.equal(fixture.effects.directCountCalls.length, 0);
  assert.equal(fixture.effects.updates.length, 1, 'exactly one row write: the tombstone itself');
});

test('delete: non-author is refused and a second delete is invalid_request', async () => {
  const nonAuthor = managePorts();
  await assert.rejects(
    () => deleteCommunityComment(nonAuthor.ports,
      deleteInput({ actor: { principalId: OTHER_ACCOUNT, subjectId: 'subject-other' } })),
    errorCheck('insufficient_permission', COMMUNITY_COMMENT_NOT_AUTHOR_MESSAGE));

  const tombstoned = managePorts({ comment: commentRecord({ state: 'deleted', body: null }) });
  await assert.rejects(
    () => deleteCommunityComment(tombstoned.ports, deleteInput()),
    errorCheck('invalid_request', COMMUNITY_COMMENT_NOT_DELETABLE_MESSAGE));
  assert.equal(tombstoned.effects.updates.length, 0);
});

test('delete: a curator-hidden comment is still author-deletable', async () => {
  // Effective state hidden (overlay set) never blocks the author's own
  // deletion — only the durable `deleted` state does.
  const fixture = managePorts({ comment: commentRecord({ curationHidden: true }) });
  const result = await deleteCommunityComment(fixture.ports, deleteInput());
  assert.equal(result.kind, 'succeeded');
  if (result.kind === 'succeeded') {
    assert.equal(result.value.state, 'deleted');
  }
});

test('delete: stale and foreign If-Match tags are 412 precondition_failed', async () => {
  const stale = managePorts();
  await assert.rejects(
    () => deleteCommunityComment(stale.ports, deleteInput({ ifMatch: commentTag(0n) })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.currentEtag === commentTag(1n));

  // The curation overlay tag never authorizes a comment write.
  const foreign = managePorts();
  await assert.rejects(
    () => deleteCommunityComment(foreign.ports,
      deleteInput({ ifMatch: communityCurationEtag({ commentId: COMMENT_ID, revision: '1' }, HMAC_KEY) })),
    errorCheck('precondition_failed'));
  assert.equal(foreign.effects.updates.length, 0);
});

/* ——— fingerprints ——— */

test('edit and delete fingerprints bind the actor, the comment and (edit) the body', async () => {
  const editBase = communityCommentEditFingerprint({
    actorPrincipalId: ACCOUNT, commentId: COMMENT_ID, body: 'hi',
  });
  assert.equal(editBase, communityCommentEditFingerprint({
    actorPrincipalId: ACCOUNT, commentId: COMMENT_ID, body: 'hi',
  }));
  for (const variant of [
    { actorPrincipalId: OTHER_ACCOUNT },
    { commentId: 'comment-2' },
    { body: 'other' },
  ]) {
    assert.notEqual(editBase, communityCommentEditFingerprint({
      actorPrincipalId: ACCOUNT, commentId: COMMENT_ID, body: 'hi', ...variant,
    }), JSON.stringify(variant));
  }
  const deleteBase = communityCommentDeleteFingerprint({
    actorPrincipalId: ACCOUNT, commentId: COMMENT_ID,
  });
  assert.equal(deleteBase, communityCommentDeleteFingerprint({
    actorPrincipalId: ACCOUNT, commentId: COMMENT_ID,
  }));
  assert.notEqual(deleteBase, communityCommentDeleteFingerprint({
    actorPrincipalId: OTHER_ACCOUNT, commentId: COMMENT_ID,
  }));
  // Edit and delete never share a fingerprint for the same logical request.
  assert.notEqual(editBase, deleteBase);
});
