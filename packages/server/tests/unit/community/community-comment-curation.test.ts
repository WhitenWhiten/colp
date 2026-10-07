import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_CONCEALED_MESSAGE,
  COMMUNITY_COMMENT_CURATION_SCOPE,
  COMMUNITY_COMMENT_MANAGE_CONTRACT_VERSION,
  COMMUNITY_CURATION_FORBIDDEN_MESSAGE,
  COMMUNITY_CURATION_PRECONDITION_MESSAGE,
  COMMUNITY_CURATION_VIRTUAL_REVISION,
  COMMUNITY_STATIC_GENERATION,
  CommunityCommentError,
  communityCommentEtag,
  communityCommentSettingsEtag,
  communityCurationCommandFingerprint,
  communityCurationEtag,
  getCommentCuration,
  getCommunityComment,
  setCommentCuration,
  type CommunityCommentCurationInput,
  type CommunityCommentCurationRecord,
  type CommunityCommentManageAuditEvent,
  type CommunityCommentManagePorts,
  type CommunityCommentQueryPorts,
  type CommunityCommentRecord,
  type CommunityCurationQueryPorts,
  type CommunityTarget,
  type CommunityTargetIdentity,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import type { ProductCommandResult as ReceiptResult } from '../../../src/modules/commands/index.js';

const AUTHOR = 'account-author';
const AUTHOR_SUBJECT = 'subject-author';
const CURATOR = 'account-owner';
const CURATOR_SUBJECT = 'subject-owner';
const READER = 'account-reader';
const READER_SUBJECT = 'subject-reader';
const COLLECTION = 'collection-target';
const COMMENT_ID = 'comment-1';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const HMAC_KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-03T10:00:00.000Z');
const CREATED = new Date('2026-09-30T08:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const COLLECTION_IDENTITY: CommunityTargetIdentity = {
  kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null,
};

const CURATOR_ACTOR = { principalId: CURATOR, subjectId: CURATOR_SUBJECT } as const;

function commentRecord(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: COMMENT_ID,
    target: COLLECTION_IDENTITY,
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: COMMENT_ID,
    replyToId: null,
    depth: 0,
    authorAccountId: AUTHOR,
    body: 'hello',
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function curationRecord(overrides: Partial<CommunityCommentCurationRecord> = {}): CommunityCommentCurationRecord {
  return {
    commentId: COMMENT_ID,
    hidden: true,
    reason: 'spam',
    revision: 3n,
    updatedByAccountId: CURATOR,
    updatedAt: NOW,
    ...overrides,
  };
}

function resolved(target: CommunityTarget = COLLECTION_TARGET): ResolvedCommunityTarget {
  return { target, ownerSubjectId: CURATOR_SUBJECT, title: 'Target title', href: '/t/1' };
}

function errorCheck(code: string, message?: string) {
  return (error: unknown) => error instanceof CommunityCommentError
    && error.code === code
    && (message === undefined || error.message === message);
}

/* ——— getCommentCuration ——— */

function curationQueryPorts(options: {
  comment?: CommunityCommentRecord | null;
  resolved?: ResolvedCommunityTarget | null;
  curation?: CommunityCommentCurationRecord | null;
  curatorSubjects?: readonly string[];
} = {}): CommunityCurationQueryPorts {
  const curators = options.curatorSubjects ?? [CURATOR_SUBJECT];
  return {
    comments: {
      async findById() {
        return options.comment === undefined ? commentRecord() : options.comment;
      },
    },
    targets: {
      async resolve() {
        if ('resolved' in options) return options.resolved ?? null;
        return resolved();
      },
    },
    curators: {
      async canCurate(_identity, subjectId) { return curators.includes(subjectId); },
    },
    curations: {
      async find() { return options.curation ?? null; },
    },
  };
}

test('getCommentCuration conceals missing comments, dead targets and stale generations', async () => {
  const missing = curationQueryPorts({ comment: null });
  await assert.rejects(
    () => getCommentCuration(missing, {
      viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, commentId: COMMENT_ID,
    }), errorCheck('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE));

  const deadTarget = curationQueryPorts({ resolved: null });
  await assert.rejects(
    () => getCommentCuration(deadTarget, {
      viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, commentId: COMMENT_ID,
    }), errorCheck('resource_not_found'));

  const superseded = curationQueryPorts({
    comment: commentRecord({ targetGeneration: 'bm-gen-old' }),
  });
  await assert.rejects(
    () => getCommentCuration(superseded, {
      viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, commentId: COMMENT_ID,
    }), errorCheck('resource_not_found'));
});

test('getCommentCuration requires an authenticated curator of the comment target', async () => {
  const anonymous = curationQueryPorts();
  await assert.rejects(
    () => getCommentCuration(anonymous, {
      viewer: { accountId: null, subjectId: null }, commentId: COMMENT_ID,
    }), errorCheck('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE));

  const reader = curationQueryPorts();
  await assert.rejects(
    () => getCommentCuration(reader, {
      viewer: { accountId: READER, subjectId: READER_SUBJECT }, commentId: COMMENT_ID,
    }), errorCheck('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE));

  // The author alone is never a curator by virtue of authorship.
  const author = curationQueryPorts();
  await assert.rejects(
    () => getCommentCuration(author, {
      viewer: { accountId: AUTHOR, subjectId: AUTHOR_SUBJECT }, commentId: COMMENT_ID,
    }), errorCheck('insufficient_permission'));
});

test('getCommentCuration serves the virtual default before any curator write', async () => {
  const ports = curationQueryPorts();
  const curation = await getCommentCuration(ports, {
    viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, commentId: COMMENT_ID,
  });
  assert.deepEqual(curation, {
    commentId: COMMENT_ID,
    hidden: false,
    reason: null,
    revision: COMMUNITY_CURATION_VIRTUAL_REVISION,
    // The virtual updatedAt is the comment's own created_at.
    updatedAt: CREATED.toISOString(),
  });
});

test('getCommentCuration projects the stored overlay; the reason only shows while hidden', async () => {
  const hidden = await getCommentCuration(curationQueryPorts({ curation: curationRecord() }), {
    viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, commentId: COMMENT_ID,
  });
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.reason, 'spam');
  assert.equal(hidden.revision, '3');
  assert.equal(hidden.updatedAt, NOW.toISOString());

  // The stored reason survives an unhide for audit but is not on the wire.
  const unhidden = await getCommentCuration(
    curationQueryPorts({ curation: curationRecord({ hidden: false, revision: 4n }) }),
    { viewer: { accountId: CURATOR, subjectId: CURATOR_SUBJECT }, commentId: COMMENT_ID },
  );
  assert.equal(unhidden.hidden, false);
  assert.equal(unhidden.reason, null);
  assert.equal(unhidden.revision, '4');
});

/* ——— setCommentCuration ——— */

interface CurationEffects {
  accountLocks: string[];
  commentLocks: string[];
  claims: { principalId: string; commandScope: string; commandId: string; fingerprint: string }[];
  completions: ReceiptResult[];
  curationLocks: string[];
  curationUpserts: CommunityCommentCurationRecord[];
  commentUpdates: number;
  audits: CommunityCommentManageAuditEvent[];
  canCurateCalls: { identity: CommunityTargetIdentity; subjectId: string }[];
}

function managePorts(options: {
  claim?: Awaited<ReturnType<CommunityCommentManagePorts['receipts']['claim']>>;
  account?: { subjectId: string } | null;
  comment?: CommunityCommentRecord | null;
  resolved?: ResolvedCommunityTarget | null;
  curation?: CommunityCommentCurationRecord | null;
  curatorSubjects?: readonly string[];
} = {}): { ports: CommunityCommentManagePorts; effects: CurationEffects } {
  const effects: CurationEffects = {
    accountLocks: [], commentLocks: [], claims: [], completions: [],
    curationLocks: [], curationUpserts: [], commentUpdates: 0,
    audits: [], canCurateCalls: [],
  };
  const curators = options.curatorSubjects ?? [CURATOR_SUBJECT];
  const recordOf = () => (options.comment === undefined ? commentRecord() : options.comment);
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
          assert.match(String(result.stableHeaders.etag), /^"community-curation:[A-Za-z0-9_-]{32}"$/u);
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
          if ('resolved' in options) return options.resolved ?? null;
          return resolved({ ...identity, generation: COMMUNITY_STATIC_GENERATION } as CommunityTarget);
        },
      },
      comments: {
        async findById(commentId) {
          return recordOf();
        },
        async lockById(commentId) {
          effects.commentLocks.push(commentId);
          return recordOf();
        },
        async update() {
          effects.commentUpdates += 1;
          throw new Error('curation must never rewrite the comment row');
        },
        async countVisibleThreadReplies(ids) { return new Map(ids.map((id) => [id, 0])); },
        async countVisibleDirectReplies(ids) { return new Map(ids.map((id) => [id, 0])); },
      },
      curations: {
        async lockByCommentId(commentId) {
          effects.curationLocks.push(commentId);
          return options.curation ?? null;
        },
        async upsert(record) {
          effects.curationUpserts.push(record);
          return record;
        },
      },
      settings: {
        async lockByTarget() { return null; },
        async upsert(record) { return record; },
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

function curationTag(revision: bigint | string): string {
  return communityCurationEtag({ commentId: COMMENT_ID, revision: revision.toString() }, HMAC_KEY);
}

function curateInput(overrides: Partial<CommunityCommentCurationInput> = {}): CommunityCommentCurationInput {
  return {
    actor: CURATOR_ACTOR,
    commentId: COMMENT_ID,
    hidden: true,
    reason: 'spam',
    ifMatch: curationTag(COMMUNITY_CURATION_VIRTUAL_REVISION),
    commandId: COMMAND_ID,
    ...overrides,
  };
}

test('setCommentCuration: invalid inputs reject before any port call', async () => {
  for (const override of [
    { actor: { principalId: '', subjectId: CURATOR_SUBJECT } },
    { actor: { principalId: CURATOR, subjectId: ' padded ' } },
    { commentId: 'bad id!' },
    { hidden: undefined },
    { hidden: 'true' },
    { hidden: 1 },
    { reason: undefined },
    { reason: 5 },
    { reason: '   ' },
    { reason: 'x'.repeat(1_001) },
    { ifMatch: 'not-an-etag' },
    { ifMatch: 'W/"weak"' },
    { commandId: 'not-a-uuid' },
    { commandId: COMMAND_ID.toUpperCase() },
  ] as const) {
    const fixture = managePorts();
    await assert.rejects(
      () => setCommentCuration(fixture.ports, curateInput(override as Partial<CommunityCommentCurationInput>)),
      errorCheck('invalid_request'),
      JSON.stringify(override));
    assert.equal(fixture.effects.accountLocks.length, 0, JSON.stringify(override));
    assert.equal(fixture.effects.curationUpserts.length, 0);
  }
});

test('setCommentCuration: only a curator may write — the author alone is refused', async () => {
  const reader = managePorts();
  await assert.rejects(
    () => setCommentCuration(reader.ports,
      curateInput({ actor: { principalId: READER, subjectId: READER_SUBJECT } })),
    errorCheck('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE));
  assert.equal(reader.effects.claims.length, 1, 'the claim precedes the curator check');
  assert.equal(reader.effects.curationUpserts.length, 0);

  // Authorship never confers curation rights on its own.
  const author = managePorts();
  await assert.rejects(
    () => setCommentCuration(author.ports,
      curateInput({ actor: { principalId: AUTHOR, subjectId: AUTHOR_SUBJECT } })),
    errorCheck('insufficient_permission', COMMUNITY_CURATION_FORBIDDEN_MESSAGE));
  assert.deepEqual(author.effects.canCurateCalls[0]!.subjectId, AUTHOR_SUBJECT);
});

test('setCommentCuration: the first hide CAS-es on the virtual revision-1 tag', async () => {
  const fixture = managePorts();
  const result = await setCommentCuration(fixture.ports, curateInput());
  assert.equal(result.kind, 'succeeded');
  // Exactly one overlay row at revision 2 — the virtual default is '1'.
  assert.equal(fixture.effects.curationUpserts.length, 1);
  const stored = fixture.effects.curationUpserts[0]!;
  assert.equal(stored.commentId, COMMENT_ID);
  assert.equal(stored.hidden, true);
  assert.equal(stored.reason, 'spam');
  assert.equal(stored.revision, 2n);
  assert.equal(stored.updatedByAccountId, CURATOR);
  assert.equal(stored.updatedAt.getTime(), NOW.getTime());
  if (result.kind === 'succeeded') {
    assert.equal(result.value.hidden, true);
    assert.equal(result.value.reason, 'spam');
    assert.equal(result.value.revision, '2');
  }
  // The comment row itself is never touched — the overlay is independent.
  assert.equal(fixture.effects.commentUpdates, 0);
  // Audit carries the operator, the reason and the new revision.
  assert.equal(fixture.effects.audits.length, 1);
  const audit = fixture.effects.audits[0]!;
  assert.equal(audit.eventType, 'community.comment_curation_updated');
  assert.equal(audit.principalId, CURATOR);
  assert.equal(audit.details.commentId, COMMENT_ID);
  assert.equal(audit.details.hidden, true);
  assert.equal(audit.details.reason, 'spam');
  assert.equal(audit.details.revision, '2');
  assert.equal(audit.details.targetKind, 'collection');
  assert.equal(audit.details.targetId, COLLECTION);
  // The stored receipt carries the curation-domain ETag and identity.
  assert.equal(fixture.effects.completions.length, 1);
  assert.equal(fixture.effects.completions[0]!.stableHeaders.etag, curationTag(2n));
  assert.equal(fixture.effects.completions[0]!.targetIdentity, `comment-curation:${COMMENT_ID}`);
  assert.equal(fixture.effects.claims[0]!.commandScope, COMMUNITY_COMMENT_CURATION_SCOPE);
  assert.equal(COMMUNITY_COMMENT_CURATION_SCOPE, 'community:comment-curate:v1');
});

test('setCommentCuration: a second write increments the stored revision; stale and foreign tags are 412', async () => {
  // The first stored revision is 2; the next write increments to 3.
  const existing = curationRecord({ revision: 2n });
  const fixture = managePorts({ curation: existing });
  const result = await setCommentCuration(fixture.ports,
    curateInput({ hidden: false, reason: 'appeal accepted', ifMatch: curationTag(2n) }));
  assert.equal(result.kind, 'succeeded');
  assert.equal(fixture.effects.curationUpserts[0]!.revision, 3n);
  assert.equal(fixture.effects.curationUpserts[0]!.hidden, false);
  // The reason is stored on the row even though the wire hides it when unhidden.
  assert.equal(fixture.effects.curationUpserts[0]!.reason, 'appeal accepted');
  if (result.kind === 'succeeded') {
    assert.equal(result.value.hidden, false);
    assert.equal(result.value.reason, null);
    assert.equal(result.value.revision, '3');
  }

  // A stale overlay tag is refused with the CURRENT curation tag attached.
  const stale = managePorts({ curation: existing });
  await assert.rejects(
    () => setCommentCuration(stale.ports,
      curateInput({ ifMatch: curationTag(COMMUNITY_CURATION_VIRTUAL_REVISION) })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.message === COMMUNITY_CURATION_PRECONDITION_MESSAGE
      && error.currentEtag === curationTag(2n));
  assert.equal(stale.effects.curationUpserts.length, 0);

  // The comment ETag and the settings ETag are foreign authorities here.
  const foreignComment = managePorts({ curation: existing });
  await assert.rejects(
    () => setCommentCuration(foreignComment.ports,
      curateInput({ ifMatch: communityCommentEtag({ id: COMMENT_ID, revision: '1' }, HMAC_KEY) })),
    (error: unknown) => error instanceof CommunityCommentError
      && error.code === 'precondition_failed'
      && error.currentEtag === curationTag(2n));

  const foreignSettings = managePorts({ curation: existing });
  await assert.rejects(
    () => setCommentCuration(foreignSettings.ports,
      curateInput({
        ifMatch: communityCommentSettingsEtag({ target: COLLECTION_TARGET, revision: '1' }, HMAC_KEY),
      })),
    errorCheck('precondition_failed', COMMUNITY_CURATION_PRECONDITION_MESSAGE));
  assert.equal(foreignSettings.effects.curationUpserts.length, 0);
});

test('setCommentCuration: concealed comment or target and non-claimed receipts return early', async () => {
  const missing = managePorts({ comment: null });
  await assert.rejects(() => setCommentCuration(missing.ports, curateInput()),
    errorCheck('resource_not_found', COMMUNITY_COMMENT_CONCEALED_MESSAGE));

  const deadTarget = managePorts({ resolved: null });
  await assert.rejects(() => setCommentCuration(deadTarget.ports, curateInput()),
    errorCheck('resource_not_found'));

  for (const [claim, expected] of [
    [{ kind: 'reused' as const }, { kind: 'reused' }],
    [{ kind: 'in_progress' as const, retryAfterSeconds: 3 }, { kind: 'in_progress', retryAfterSeconds: 3 }],
    [{ kind: 'expired' as const, resultDigest: null }, { kind: 'expired', resultDigest: null }],
  ] as const) {
    const fixture = managePorts({ claim });
    assert.deepEqual(await setCommentCuration(fixture.ports, curateInput()), expected);
    assert.equal(fixture.effects.curationUpserts.length, 0);
  }
});

test('setCommentCuration: unhide removes only the overlay — a deleted tombstone stays deleted', async () => {
  // The overlay write never touches community_comments.state; unhiding a
  // comment whose own state is 'deleted' resurrects nothing.
  const fixture = managePorts({
    comment: commentRecord({ state: 'deleted', body: null }),
    curation: curationRecord({ hidden: true }),
  });
  const result = await setCommentCuration(fixture.ports,
    curateInput({ hidden: false, reason: 'restored overlay', ifMatch: curationTag(3n) }));
  assert.equal(result.kind, 'succeeded');
  assert.equal(fixture.effects.curationUpserts[0]!.hidden, false);
  assert.equal(fixture.effects.commentUpdates, 0,
    'no UPDATE ever ran against the tombstone row');
});

/* ——— hidden comment visibility on the read path ——— */

function commentQueryPorts(options: {
  comment?: CommunityCommentRecord | null;
  curatorSubjects?: readonly string[];
} = {}): CommunityCommentQueryPorts {
  const curators = options.curatorSubjects ?? [CURATOR_SUBJECT];
  return {
    targets: {
      async resolve() { return resolved(); },
      async createdAt() { return CREATED; },
    },
    curators: {
      async canCurate(_identity, subjectId) { return curators.includes(subjectId); },
    },
    comments: {
      async findById() { return options.comment === undefined ? commentRecord() : options.comment; },
      async scanRoots() { return []; },
      async scanDescendants() { return []; },
      async countVisibleThreadReplies(ids) { return new Map(ids.map((id) => [id, 2])); },
      async countVisibleDirectReplies(ids) { return new Map(ids.map((id) => [id, 0])); },
    },
    curations: { async find() { return curationRecord(); } },
    settings: { async find() { return null; } },
    authors: {
      async publicActors(ids) {
        return new Map(ids.map((id) => [id, { handle: 'alice', displayName: 'Alice', avatarUrl: null }]));
      },
    },
    clock: { async now() { return NOW; } },
  };
}

test('a curator-hidden comment serves a null body to every viewer; affordances stay per role', async () => {
  const ports = commentQueryPorts({ comment: commentRecord({ curationHidden: true }) });
  for (const [viewer, canDelete, canCurate] of [
    [{ accountId: null, subjectId: null }, false, false],
    [{ accountId: READER, subjectId: READER_SUBJECT }, false, false],
    [{ accountId: AUTHOR, subjectId: AUTHOR_SUBJECT }, true, false],
    [{ accountId: CURATOR, subjectId: CURATOR_SUBJECT }, false, true],
  ] as const) {
    const comment = await getCommunityComment(ports, { viewer, commentId: COMMENT_ID });
    assert.equal(comment.state, 'hidden');
    assert.equal(comment.body, null, `body never leaks for viewer ${viewer.accountId}`);
    assert.equal(comment.canEdit, false);
    assert.equal(comment.canDelete, canDelete);
    assert.equal(comment.canCurate, canCurate);
  }
});

test('the curation fingerprint binds actor, comment, hidden flag and reason', async () => {
  const base = communityCurationCommandFingerprint({
    actorPrincipalId: CURATOR, commentId: COMMENT_ID, hidden: true, reason: 'spam',
  });
  for (const variant of [
    { actorPrincipalId: AUTHOR },
    { commentId: 'comment-2' },
    { hidden: false },
    { reason: 'other' },
  ]) {
    assert.notEqual(base, communityCurationCommandFingerprint({
      actorPrincipalId: CURATOR, commentId: COMMENT_ID, hidden: true, reason: 'spam', ...variant,
    }), JSON.stringify(variant));
  }
});
