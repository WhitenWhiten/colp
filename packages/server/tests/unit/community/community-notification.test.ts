import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_NOTIFICATION_KIND,
  COMMUNITY_NOTIFICATION_PREVIEW_MAX_CODE_POINTS,
  COMMUNITY_NOTIFICATION_SUBJECT_TYPE,
  COMMUNITY_STATIC_GENERATION,
  CommunityNotificationError,
  communityNotificationHref,
  communityNotificationPreferenceEtag,
  communityNotificationPreferenceView,
  communityNotificationPreferenceVirtual,
  communityNotificationPreview,
  communityNotificationView,
  communityReplyNotificationRecipients,
  isCommunityNotificationOpaqueId,
  type CommunityCommentRecord,
  type CommunityNotificationRow,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import {
  parseCommunityNotificationReadBody,
  validateCommunityNotificationIds,
  communityNotificationReadFingerprint,
  parseCommunityNotificationPreferenceBody,
  communityNotificationPreferenceFingerprint,
  parseCommunityNotificationsQuery,
} from '../../../src/modules/community/index.js';

const NOW = new Date('2026-10-05T10:00:00.000Z');
const HMAC_KEY = Buffer.alloc(32, 7);

function record(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-reply',
    target: { kind: 'collection', id: 'col-1', collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-root',
    replyToId: 'comment-root',
    depth: 1,
    authorAccountId: 'account-actor',
    body: 'reply body',
    state: 'visible',
    curationHidden: false,
    revision: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resolvedTarget(generation = COMMUNITY_STATIC_GENERATION): ResolvedCommunityTarget {
  return {
    target: {
      kind: 'collection', id: 'col-1', collectionId: null, seriesId: null, generation,
    },
    ownerSubjectId: 'subject-owner',
    title: 'Collection title',
    href: 'https://known.example/c/one',
  };
}

test('community reply notification recipients dedupe owner + parent author minus the actor', () => {
  assert.deepEqual(communityReplyNotificationRecipients({
    actorAccountId: 'a-actor', ownerAccountId: 'a-owner', parentAuthorAccountId: 'a-parent',
  }), ['a-owner', 'a-parent']);
  // Actor as owner and parent author produces no recipients.
  assert.deepEqual(communityReplyNotificationRecipients({
    actorAccountId: 'a-actor', ownerAccountId: 'a-actor', parentAuthorAccountId: 'a-actor',
  }), []);
  // Root comments have no parent author.
  assert.deepEqual(communityReplyNotificationRecipients({
    actorAccountId: 'a-actor', ownerAccountId: null, parentAuthorAccountId: null,
  }), []);
  // Same account behind owner + parent dedupes to one event.
  assert.deepEqual(communityReplyNotificationRecipients({
    actorAccountId: 'a-actor', ownerAccountId: 'a-shared', parentAuthorAccountId: 'a-shared',
  }), ['a-shared']);
});

test('notification preview redacts tombstones and bounds the excerpt', () => {
  assert.equal(communityNotificationPreview(record({ body: 'short' })), 'short');
  assert.equal(communityNotificationPreview(record({ body: null })), null);
  assert.equal(communityNotificationPreview(record({ state: 'deleted' })), null);
  assert.equal(communityNotificationPreview(record({ curationHidden: true })), null);
  const long = 'x'.repeat(COMMUNITY_NOTIFICATION_PREVIEW_MAX_CODE_POINTS + 40);
  const bounded = communityNotificationPreview(record({ body: long }));
  assert.equal([...bounded!].length, COMMUNITY_NOTIFICATION_PREVIEW_MAX_CODE_POINTS);
});

test('notification view binds the reply comment, target, actor, href, and read state', () => {
  const row: CommunityNotificationRow = {
    notificationId: 'n-1', actorProfileId: 'account-actor', subjectId: 'comment-reply',
    state: 'unread', readAt: null, occurredAt: NOW,
  };
  const view = communityNotificationView(row, record(), resolvedTarget(), {
    id: 'account-actor', handle: 'alice', displayName: 'Alice', avatarUrl: null,
  });
  assert.equal(view.id, 'n-1');
  assert.equal(view.kind, COMMUNITY_NOTIFICATION_KIND);
  assert.equal(view.commentId, 'comment-reply');
  assert.equal(view.target.generation, COMMUNITY_STATIC_GENERATION);
  assert.equal(view.actor.displayName, 'Alice');
  assert.equal(view.preview, 'reply body');
  assert.equal(view.href, 'https://known.example/c/one#comment-comment-reply');
  assert.equal(view.read, false);
  assert.equal(view.createdAt, NOW.toISOString());
});

test('preference view + virtual default carry the documented revision shape', () => {
  const virtual = communityNotificationPreferenceVirtual(NOW);
  assert.deepEqual(virtual, { enabled: true, revision: '1', updatedAt: NOW.toISOString() });
  const stored = communityNotificationPreferenceView({ enabled: false, revision: 4n, updatedAt: NOW });
  assert.deepEqual(stored, { enabled: false, revision: '4', updatedAt: NOW.toISOString() });
});

test('preference ETag is opaque, stable, and bound to recipient + revision', () => {
  const one = communityNotificationPreferenceEtag({ recipientAccountId: 'a-1', revision: '1' }, HMAC_KEY);
  const two = communityNotificationPreferenceEtag({ recipientAccountId: 'a-1', revision: '1' }, HMAC_KEY);
  const other = communityNotificationPreferenceEtag({ recipientAccountId: 'a-2', revision: '1' }, HMAC_KEY);
  const bumped = communityNotificationPreferenceEtag({ recipientAccountId: 'a-1', revision: '2' }, HMAC_KEY);
  assert.equal(one, two);
  assert.notEqual(one, other);
  assert.notEqual(one, bumped);
  assert.match(one, /^"community-notification-preference:[A-Za-z0-9_-]{32}"$/u);
  assert.throws(
    () => communityNotificationPreferenceEtag({ recipientAccountId: 'a-1', revision: '1' }, Buffer.alloc(8)),
    TypeError,
  );
});

test('opaque ids accept the bounded alphabet only', () => {
  assert.equal(isCommunityNotificationOpaqueId('n_-~.abc123'), true);
  assert.equal(isCommunityNotificationOpaqueId(''), false);
  assert.equal(isCommunityNotificationOpaqueId('has space'), false);
  assert.equal(isCommunityNotificationOpaqueId('x'.repeat(129)), false);
  assert.equal(isCommunityNotificationOpaqueId(null), false);
});

test('inbox query parsing defaults read=all limit=20 and rejects unknown keys', () => {
  assert.deepEqual(parseCommunityNotificationsQuery({}), { read: 'all', limit: 20, cursor: null });
  assert.deepEqual(parseCommunityNotificationsQuery({ read: 'unread', limit: '5' }),
    { read: 'unread', limit: 5, cursor: null });
  assert.deepEqual(parseCommunityNotificationsQuery({ read: 'all', limit: 100, cursor: 'tok' }),
    { read: 'all', limit: 100, cursor: 'tok' });
  for (const bad of [
    { read: 'read' }, { read: null }, { limit: 0 }, { limit: 101 }, { limit: 'x' },
    { limit: null }, { cursor: 42 }, { cursor: 'bad token!' }, { extra: 1 }, { read: 'all', surprise: 1 },
  ]) {
    assert.throws(() => parseCommunityNotificationsQuery(bad), CommunityNotificationError);
  }
});

test('read body parsing requires exactly {ids} of 1..100 unique opaque ids', () => {
  assert.deepEqual(parseCommunityNotificationReadBody({ ids: ['n-1', 'n-2'] }), ['n-1', 'n-2']);
  for (const bad of [
    null, 'x', [], {}, { ids: [] }, { ids: ['n-1'], extra: 1 }, { ids: null },
    { ids: ['n-1', 'n-1'] }, { ids: ['n-1', 5] }, { ids: ['bad id!'] },
    { ids: Array.from({ length: 101 }, (_, index) => `n-${index}`) },
  ]) {
    assert.throws(() => parseCommunityNotificationReadBody(bad), CommunityNotificationError);
  }
  assert.throws(() => validateCommunityNotificationIds('n-1'), CommunityNotificationError);
});

test('preference body parsing requires exactly {enabled:boolean}', () => {
  assert.equal(parseCommunityNotificationPreferenceBody({ enabled: true }), true);
  assert.equal(parseCommunityNotificationPreferenceBody({ enabled: false }), false);
  for (const bad of [null, {}, { enabled: 'yes' }, { enabled: null }, { enabled: true, extra: 1 }, []]) {
    assert.throws(() => parseCommunityNotificationPreferenceBody(bad), CommunityNotificationError);
  }
});

test('fingerprints are stable and bind actor plus command specifics', () => {
  const a = communityNotificationReadFingerprint({ actorPrincipalId: 'a-1', ids: ['n-1'] });
  assert.equal(a, communityNotificationReadFingerprint({ actorPrincipalId: 'a-1', ids: ['n-1'] }));
  assert.notEqual(a, communityNotificationReadFingerprint({ actorPrincipalId: 'a-1', ids: ['n-2'] }));
  assert.notEqual(a, communityNotificationReadFingerprint({ actorPrincipalId: 'a-2', ids: ['n-1'] }));
  const p = communityNotificationPreferenceFingerprint({ actorPrincipalId: 'a-1', enabled: true });
  assert.notEqual(p, communityNotificationPreferenceFingerprint({ actorPrincipalId: 'a-1', enabled: false }));
});

test('subject type and kind constants are the contract values', () => {
  assert.equal(COMMUNITY_NOTIFICATION_SUBJECT_TYPE, 'community_comment');
  assert.equal(COMMUNITY_NOTIFICATION_KIND, 'comment_reply');
  assert.equal(communityNotificationHref({ href: '/c/x' }, 'c-1'), '/c/x#comment-c-1');
});
