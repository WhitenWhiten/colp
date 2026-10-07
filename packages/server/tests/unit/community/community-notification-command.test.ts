import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_NOTIFICATION_PREFERENCE_SCOPE,
  COMMUNITY_NOTIFICATION_READ_SCOPE,
  COMMUNITY_STATIC_GENERATION,
  CommunityNotificationError,
  communityNotificationPreferenceEtag,
  markCommunityNotificationsRead,
  putCommunityNotificationPreference,
  validateCommunityNotificationCommandId,
  validateCommunityNotificationIfMatch,
  type CommunityCommentRecord,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationPreferenceRecord,
  type CommunityNotificationRow,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../../src/modules/commands/index.js';

const HMAC_KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-05T12:00:00.000Z');
const COMMAND_ID = '3f6f6f38-7c5e-4a1b-9c8d-2f0a1b2c3d4e';
const ACTOR = { principalId: 'a-viewer', subjectId: 's-viewer' };

const TARGET = { kind: 'collection' as const, id: 'col-1', collectionId: null, seriesId: null };

/** Minimal in-memory receipt port with replay + reuse semantics. */
function receiptPort(): { port: ProductCommandReceiptPort; stored: Map<string, ProductCommandResult> } {
  const stored = new Map<string, ProductCommandResult>();
  const keyOf = (b: ProductCommandBinding) =>
    `${b.principalId}:${b.commandScope}:${b.commandId}`;
  const fingerprints = new Map<string, string>();
  return {
    stored,
    port: {
      claim: async (binding, fingerprint) => {
        const key = keyOf(binding);
        if (fingerprints.has(key)) {
          return fingerprints.get(key) === fingerprint
            ? ({ kind: 'replay', result: stored.get(key)! } satisfies ProductCommandClaim)
            : ({ kind: 'reused' } satisfies ProductCommandClaim);
        }
        fingerprints.set(key, fingerprint);
        return { kind: 'claimed' };
      },
      complete: async (binding, _fingerprint, result) => {
        stored.set(keyOf(binding), result);
      },
      purgeExpired: async () => 0,
      deletePrincipalReceipts: async () => 0,
    },
  };
}

function row(id: string, overrides: Partial<CommunityNotificationRow> = {}): CommunityNotificationRow {
  return {
    notificationId: id, actorProfileId: 'a-actor', subjectId: `comment-${id}`,
    state: 'unread', readAt: null, occurredAt: NOW, ...overrides,
  };
}

function comment(id: string, overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id, target: TARGET, targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-root', replyToId: 'comment-root', depth: 1,
    authorAccountId: 'a-actor', body: 'body', state: 'visible',
    curationHidden: false, revision: 1n, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function resolved(generation = COMMUNITY_STATIC_GENERATION): ResolvedCommunityTarget {
  return {
    target: { ...TARGET, generation }, ownerSubjectId: 's-owner',
    title: 'T', href: 'https://known.example/c/col-1',
  };
}

interface Harness {
  readonly ports: CommunityNotificationCommandPorts;
  readonly receipts: ReturnType<typeof receiptPort>;
  rows: CommunityNotificationRow[];
  comments: Map<string, CommunityCommentRecord>;
  preference: CommunityNotificationPreferenceRecord | null;
  account: { subjectId: string; createdAt: Date } | null;
  resolveResult: ResolvedCommunityTarget | null;
  readonly audited: string[];
  marked: string[][];
}

function harness(setup: Partial<Pick<Harness,
  'rows' | 'comments' | 'preference' | 'account' | 'resolveResult'>> = {}): Harness {
  const receipts = receiptPort();
  const h: Harness = {
    receipts,
    rows: setup.rows ?? [],
    comments: setup.comments ?? new Map(),
    preference: setup.preference ?? null,
    account: setup.account === undefined
      ? { subjectId: ACTOR.subjectId, createdAt: NOW }
      : setup.account,
    resolveResult: setup.resolveResult === undefined ? resolved() : setup.resolveResult,
    audited: [],
    marked: [],
    ports: undefined as never,
  };
  h.ports = {
    receipts: receipts.port,
    actor: { lockActiveAccount: async () => h.account },
    preferences: {
      findCommunity: async () => h.preference,
      lockCommunity: async () => h.preference,
      insertCommunity: async (_r, write) => {
        h.preference = {
          enabled: write.enabled, revision: write.revision, updatedAt: write.updatedAt,
        };
        return h.preference;
      },
      updateCommunity: async (_r, enabled, expectedRevision, updatedAt) => {
        if (h.preference === null || h.preference.revision !== expectedRevision) return null;
        h.preference = {
          enabled, revision: h.preference.revision + 1n, updatedAt,
        };
        return h.preference;
      },
    },
    notifications: {
      lockForRead: async (_recipient, ids) => h.rows.filter((r) => ids.includes(r.notificationId)),
      markRead: async (_recipient, ids, readAt) => {
        const changed: string[] = [];
        for (const r of h.rows) {
          if (ids.includes(r.notificationId) && r.state === 'unread') {
            r.state = 'read';
            r.readAt = readAt;
            changed.push(r.notificationId);
          }
        }
        h.marked.push([...ids]);
        return changed;
      },
      unreadGroups: async () => [],
    },
    comments: {
      findMany: async (ids) => {
        const out = new Map<string, CommunityCommentRecord>();
        for (const id of ids) {
          const c = h.comments.get(id);
          if (c !== undefined) out.set(id, c);
        }
        return out;
      },
    },
    targets: { resolve: async () => h.resolveResult },
    etags: {
      preference: (input) => communityNotificationPreferenceEtag(input, HMAC_KEY),
    },
    audit: { append: async (event) => { h.audited.push(event.eventType); } },
    clock: { now: async () => NOW },
  };
  return h;
}

function read(h: Harness, ids: readonly string[], commandId = COMMAND_ID) {
  return markCommunityNotificationsRead(h.ports, { actor: ACTOR, ids: [...ids], commandId });
}

test('mark read transitions only the caller\'s servable unread rows', async () => {
  const h = harness({
    rows: [
      row('n-1'),
      row('n-2', { state: 'read', readAt: NOW }),
      row('n-3', { subjectId: 'comment-gone' }),
    ],
    comments: new Map([
      ['comment-n-1', comment('comment-n-1')],
      ['comment-n-2', comment('comment-n-2')],
      // 'comment-gone' absent → n-3 concealed.
    ]),
  });
  const result = await read(h, ['n-1', 'n-2', 'n-3', 'n-foreign']);
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.value.changedIds, ['n-1']);
  assert.deepEqual(h.marked, [['n-1', 'n-2']]); // concealed n-3/foreign never reach markRead
});

test('mark read ignores concealed ids when the target generation rotated', async () => {
  const h = harness({
    rows: [row('n-1')],
    comments: new Map([['comment-n-1', comment('comment-n-1', { targetGeneration: 'gen-old' })]]),
  });
  const result = await read(h, ['n-1']);
  assert.equal(result.kind, 'succeeded');
  if (result.kind === 'succeeded') assert.deepEqual(result.value.changedIds, []);
  assert.deepEqual(h.marked, []);
});

test('mark read preserves input order in changedIds and audits the write', async () => {
  const h = harness({
    rows: [row('n-1'), row('n-2')],
    comments: new Map([
      ['comment-n-1', comment('comment-n-1')],
      ['comment-n-2', comment('comment-n-2')],
    ]),
  });
  const result = await read(h, ['n-2', 'n-1']);
  if (result.kind === 'succeeded') assert.deepEqual(result.value.changedIds, ['n-2', 'n-1']);
  assert.deepEqual(h.audited, ['community.notification_read']);
});

test('mark read under a disabled preference succeeds as a durable no-op', async () => {
  const h = harness({
    rows: [row('n-1')],
    comments: new Map([['comment-n-1', comment('comment-n-1')]]),
    preference: { enabled: false, revision: 2n, updatedAt: NOW },
  });
  const result = await read(h, ['n-1']);
  if (result.kind === 'succeeded') {
    assert.deepEqual(result.value, { changedIds: [], unreadCount: 0 });
  }
  assert.deepEqual(h.marked, []); // nothing transitions while disabled
  assert.equal(h.rows[0]!.state, 'unread');
});

test('an exact command replay returns the saved result; a changed fingerprint is reused', async () => {
  const h = harness({
    rows: [row('n-1')],
    comments: new Map([['comment-n-1', comment('comment-n-1')]]),
  });
  const first = await read(h, ['n-1']);
  assert.equal(first.kind, 'succeeded');
  const replay = await read(h, ['n-1']);
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') {
    assert.equal(replay.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(replay.body).toString('utf8')),
      { changedIds: ['n-1'], unreadCount: 0 });
    assert.equal(replay.stableHeaders['cache-control'], 'private, no-store');
  }
  // Same command id, different request fingerprint → command_id_reused.
  const reused = await read(h, ['n-2']);
  assert.equal(reused.kind, 'reused');
});

test('mark read conceals when the actor account is gone or mismatched', async () => {
  for (const account of [null, { subjectId: 's-other', createdAt: NOW }]) {
    const h = harness({ account });
    await assert.rejects(() => read(h, ['n-1']), (error: unknown) =>
      (error as CommunityNotificationError).code === 'resource_not_found');
  }
});

test('command id, If-Match, and actor validation reject malformed input', async () => {
  const h = harness();
  await assert.rejects(
    () => markCommunityNotificationsRead(h.ports, { actor: ACTOR, ids: ['n-1'], commandId: 'not-a-uuid' }),
    (error: unknown) => (error as CommunityNotificationError).code === 'invalid_request',
  );
  await assert.rejects(
    () => markCommunityNotificationsRead(h.ports, {
      actor: { principalId: '  ', subjectId: 's' }, ids: ['n-1'], commandId: COMMAND_ID,
    }),
    (error: unknown) => (error as CommunityNotificationError).code === 'invalid_request',
  );
  assert.equal(validateCommunityNotificationCommandId(COMMAND_ID), COMMAND_ID);
  assert.throws(() => validateCommunityNotificationCommandId('ABC'), CommunityNotificationError);
  for (const bad of [null, '', 'weak', 'W/"tag"', '"unclosed', ['"a"']]) {
    assert.throws(() => validateCommunityNotificationIfMatch(bad), CommunityNotificationError);
  }
  assert.equal(validateCommunityNotificationIfMatch('"strong-tag"'), '"strong-tag"');
});

function put(h: Harness, enabled: boolean, ifMatch: string, commandId = COMMAND_ID) {
  return putCommunityNotificationPreference(h.ports, {
    actor: ACTOR, enabled, ifMatch, commandId,
  });
}

test('the first preference write against the virtual tag stores revision 2', async () => {
  const h = harness();
  const virtualTag = communityNotificationPreferenceEtag(
    { recipientAccountId: ACTOR.principalId, revision: '1' }, HMAC_KEY);
  const result = await put(h, false, virtualTag);
  assert.equal(result.kind, 'succeeded');
  if (result.kind !== 'succeeded') return;
  assert.deepEqual(result.value, { enabled: false, revision: '2', updatedAt: NOW.toISOString() });
  assert.equal(h.preference!.revision, 2n);
  assert.deepEqual(h.audited, ['community.notification_preference_updated']);
});

test('a stale If-Match maps to precondition_failed with the current tag attached', async () => {
  const h = harness({
    preference: { enabled: true, revision: 5n, updatedAt: NOW },
  });
  const staleTag = communityNotificationPreferenceEtag(
    { recipientAccountId: ACTOR.principalId, revision: '4' }, HMAC_KEY);
  await assert.rejects(() => put(h, false, staleTag), (error: unknown) => {
    assert.ok(error instanceof CommunityNotificationError);
    const e = error as CommunityNotificationError & { currentEtag?: string };
    assert.equal(e.code, 'precondition_failed');
    assert.equal(e.currentEtag, communityNotificationPreferenceEtag(
      { recipientAccountId: ACTOR.principalId, revision: '5' }, HMAC_KEY));
    return true;
  });
  assert.equal(h.preference!.enabled, true); // untouched
});

test('preference write replays an exact command and rejects fingerprint reuse', async () => {
  const h = harness();
  const tag = communityNotificationPreferenceEtag(
    { recipientAccountId: ACTOR.principalId, revision: '1' }, HMAC_KEY);
  const first = await put(h, true, tag);
  assert.equal(first.kind, 'succeeded');
  const replay = await put(h, true, tag);
  assert.equal(replay.kind, 'replay');
  if (replay.kind === 'replay') {
    assert.equal(replay.stableHeaders.etag, communityNotificationPreferenceEtag(
      { recipientAccountId: ACTOR.principalId, revision: '2' }, HMAC_KEY));
  }
  const reused = await put(h, false, tag);
  assert.equal(reused.kind, 'reused');
});

test('preference write increments the stored revision across successive CAS writes', async () => {
  const h = harness();
  const id2 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const id3 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const first = await put(h, false, communityNotificationPreferenceEtag(
    { recipientAccountId: ACTOR.principalId, revision: '1' }, HMAC_KEY), id2);
  if (first.kind === 'succeeded') assert.equal(first.value.revision, '2');
  const second = await put(h, true, communityNotificationPreferenceEtag(
    { recipientAccountId: ACTOR.principalId, revision: '2' }, HMAC_KEY), id3);
  if (second.kind === 'succeeded') assert.equal(second.value.revision, '3');
  assert.equal(h.preference!.enabled, true);
});

test('read and preference commands use disjoint command scopes', () => {
  assert.notEqual(COMMUNITY_NOTIFICATION_READ_SCOPE, COMMUNITY_NOTIFICATION_PREFERENCE_SCOPE);
});
