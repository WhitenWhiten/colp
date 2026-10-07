import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SOCIAL_IDENTITY_MAX_LENGTH, isSocialIdentityText } from '../../../src/modules/commands/index.js';
import {
  FEED_CURSOR_COMPARATOR_VERSION,
  FEED_CURSOR_PURPOSE,
  FEED_CURSOR_TTL_MS,
  FOLLOWERS_CURSOR_PURPOSE,
  FOLLOW_CURSOR_COMPARATOR_VERSION,
  FOLLOW_CURSOR_TTL_MS,
  FeedCursorError,
  FollowCursorError,
  createFeedCursorKeyring,
  createFollowCursorKeyring,
  queryCurrentFeed,
  queryFollowRelations,
  rebuildSocialFeedProjection,
  type FeedPageReadPort,
  type FollowPageReadPort,
} from '../../../src/modules/social/index.js';
import {
  NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION,
  NOTIFICATION_INBOX_CURSOR_PURPOSE,
  NOTIFICATION_INBOX_CURSOR_TTL_MS,
  NotificationInboxCursorError,
  createNotificationInboxCursorKeyring,
  queryCurrentNotificationInbox,
  type NotificationInboxReadPort,
} from '../../../src/modules/notifications/index.js';
import {
  socialCollectionChangeEnvelopeRegistrations,
} from '../../../src/infrastructure/social/feed-worker-route.js';
import {
  socialFollowEventEnvelopeRegistrations,
} from '../../../src/infrastructure/social/follow-command-postgres.js';
import {
  socialNotificationEnvelopeRegistrations,
} from '../../../src/infrastructure/notifications/social-notification-worker-route.js';

const DB_CLOCK = new Date('2020-06-15T12:00:00.000Z');
const WALL_CLOCK = new Date('2030-01-01T00:00:00.000Z');
const ACTIVE = { id: 'boundary-current', secret: Buffer.alloc(32, 11).toString('base64') };
const OLD = { id: 'boundary-old', secret: Buffer.alloc(32, 12).toString('base64') };
const STABLE_22 = 'abcdefghijklmnopqrstuw';

function text(length: number): string {
  return 'a'.repeat(length);
}

function followReads(): FollowPageReadPort {
  const rows = [{
    profile: {
      profileId: 'profile-b', handle: 'handle_b', displayName: 'B', avatarUrl: null,
    },
    followedAt: new Date('2020-06-15T11:00:00.000Z'),
  }, {
    profile: {
      profileId: 'profile-a', handle: 'handle_a', displayName: 'A', avatarUrl: null,
    },
    followedAt: new Date('2020-06-15T10:00:00.000Z'),
  }] as const;
  return {
    async listFollowers() { return rows; },
    async listFollowing() { return rows; },
  };
}

function feedReads(): FeedPageReadPort {
  return {
    async loadPage() {
      return [{
        feedItemId: 'feed-2', sourceEventId: 'event-2', kind: 'collection_change',
        actor: { profileId: 'actor-a', handle: 'actor_a', displayName: 'Actor', avatarUrl: null },
        collectionId: 'collection-a', publishedAt: new Date('2020-06-15T11:00:00.000Z'),
        collectionTitle: null, hiddenPublic: false, publicationSlug: null, summary: null,
      }, {
        feedItemId: 'feed-1', sourceEventId: 'event-1', kind: 'collection_change',
        actor: { profileId: 'actor-a', handle: 'actor_a', displayName: 'Actor', avatarUrl: null },
        collectionId: 'collection-a', publishedAt: new Date('2020-06-15T10:00:00.000Z'),
        collectionTitle: null, hiddenPublic: false, publicationSlug: null, summary: null,
      }];
    },
  };
}

function notificationReads(): NotificationInboxReadPort {
  return {
    async loadPage() {
      return [{
        notificationId: 'n-2', notificationType: 'follow_activity', actorProfileId: 'actor-a',
        actorHandle: 'actor_a', actorDisplayName: 'Actor',
        subjectType: 'profile', subjectId: 'subject-a',
        collectionTitle: null, publicationSlug: null, summary: null,
        state: 'unread', stateRevision: 1n,
        readAt: null, occurredAt: new Date('2020-06-15T11:00:00.000Z'),
      }, {
        notificationId: 'n-1', notificationType: 'follow_activity', actorProfileId: 'actor-a',
        actorHandle: 'actor_a', actorDisplayName: 'Actor',
        subjectType: 'profile', subjectId: 'subject-a',
        collectionTitle: null, publicationSlug: null, summary: null,
        state: 'unread', stateRevision: 1n,
        readAt: null, occurredAt: new Date('2020-06-15T10:00:00.000Z'),
      }];
    },
    async countUnread() { return 2; },
  };
}

test('R5-07 shared identity helper accepts 255/256 and rejects 257 plus trim drift', () => {
  assert.equal(SOCIAL_IDENTITY_MAX_LENGTH, 256);
  assert.equal(isSocialIdentityText(text(255)), true);
  assert.equal(isSocialIdentityText(text(256)), true);
  assert.equal(isSocialIdentityText(text(257)), false);
  assert.equal(isSocialIdentityText(` ${text(10)}`), false);
  assert.equal(isSocialIdentityText(`${text(10)} `), false);
  assert.equal(isSocialIdentityText(''), false);
});

test('R5-07 command/query/cursor/worker layers accept or reject the same identity bounds', async () => {
  const accept = text(256);
  const reject = text(257);
  const followKeys = createFollowCursorKeyring({ active: ACTIVE, retained: [] });
  const feedKeys = createFeedCursorKeyring({ active: ACTIVE, retained: [] });
  const inboxKeys = createNotificationInboxCursorKeyring({ active: ACTIVE, retained: [] });
  const clock = { now: async () => DB_CLOCK };

  const followPage = await queryFollowRelations({
    reads: followReads(), cursors: followKeys, clock,
  }, { principalId: accept, targetProfileId: accept, direction: 'followers', limit: 1 });
  assert.ok(followPage?.nextCursor);

  const feedPage = await queryCurrentFeed({
    reads: feedReads(), cursors: feedKeys, clock,
  }, { principalId: accept, limit: 1 });
  assert.ok(feedPage.nextCursor);

  const inboxPage = await queryCurrentNotificationInbox({
    reads: notificationReads(), cursors: inboxKeys, clock,
  }, { principalId: accept, limit: 1 });
  assert.ok(inboxPage.nextCursor);

  await assert.rejects(
    () => queryFollowRelations({
      reads: followReads(), cursors: followKeys, clock,
    }, { principalId: reject, targetProfileId: 'target', direction: 'followers', limit: 1 }),
    TypeError,
  );
  await assert.rejects(
    () => queryCurrentFeed({
      reads: feedReads(), cursors: feedKeys, clock,
    }, { principalId: reject, limit: 1 }),
    TypeError,
  );
  await assert.rejects(
    () => queryCurrentNotificationInbox({
      reads: notificationReads(), cursors: inboxKeys, clock,
    }, { principalId: reject, limit: 1 }),
    TypeError,
  );
  await assert.rejects(
    () => queryFollowRelations({
      reads: followReads(), cursors: followKeys, clock,
    }, { principalId: ` ${text(10)}`, targetProfileId: 'target', direction: 'followers', limit: 1 }),
    TypeError,
  );

  const issuedAt = DB_CLOCK.toISOString();
  const expiresAt = new Date(DB_CLOCK.getTime() + FOLLOW_CURSOR_TTL_MS).toISOString();
  assert.doesNotThrow(() => followKeys.followers.seal({
    v: 1, purpose: FOLLOWERS_CURSOR_PURPOSE, direction: 'followers',
    principalId: accept, targetProfileId: accept, actorProfileId: null, filter: '', limit: 1,
    comparatorVersion: FOLLOW_CURSOR_COMPARATOR_VERSION,
    after: { followedAt: issuedAt, profileId: accept }, issuedAt, expiresAt,
  }));
  assert.throws(() => followKeys.followers.seal({
    v: 1, purpose: FOLLOWERS_CURSOR_PURPOSE, direction: 'followers',
    principalId: reject, targetProfileId: accept, actorProfileId: null, filter: '', limit: 1,
    comparatorVersion: FOLLOW_CURSOR_COMPARATOR_VERSION,
    after: { followedAt: issuedAt, profileId: accept }, issuedAt, expiresAt,
  }), FollowCursorError);

  const feedIssued = DB_CLOCK.toISOString();
  const feedExpires = new Date(DB_CLOCK.getTime() + FEED_CURSOR_TTL_MS).toISOString();
  assert.doesNotThrow(() => feedKeys.feed.seal({
    v: 1, purpose: FEED_CURSOR_PURPOSE, principalId: accept, filter: '', limit: 1,
    comparatorVersion: FEED_CURSOR_COMPARATOR_VERSION,
    after: { publishedAt: feedIssued, sourceEventId: accept, feedItemId: accept },
    issuedAt: feedIssued, expiresAt: feedExpires,
  }));
  assert.throws(() => feedKeys.feed.seal({
    v: 1, purpose: FEED_CURSOR_PURPOSE, principalId: reject, filter: '', limit: 1,
    comparatorVersion: FEED_CURSOR_COMPARATOR_VERSION,
    after: { publishedAt: feedIssued, sourceEventId: accept, feedItemId: accept },
    issuedAt: feedIssued, expiresAt: feedExpires,
  }), FeedCursorError);

  const inboxIssued = DB_CLOCK.toISOString();
  const inboxExpires = new Date(DB_CLOCK.getTime() + NOTIFICATION_INBOX_CURSOR_TTL_MS).toISOString();
  assert.doesNotThrow(() => inboxKeys.inbox.seal({
    v: 1, purpose: NOTIFICATION_INBOX_CURSOR_PURPOSE, principalId: accept, filter: '',
    limit: 1, comparatorVersion: NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION,
    after: { occurredAt: inboxIssued, notificationId: accept },
    issuedAt: inboxIssued, expiresAt: inboxExpires,
  }));
  assert.throws(() => inboxKeys.inbox.seal({
    v: 1, purpose: NOTIFICATION_INBOX_CURSOR_PURPOSE, principalId: reject, filter: '',
    limit: 1, comparatorVersion: NOTIFICATION_INBOX_CURSOR_COMPARATOR_VERSION,
    after: { occurredAt: inboxIssued, notificationId: accept },
    issuedAt: inboxIssued, expiresAt: inboxExpires,
  }), NotificationInboxCursorError);

  const rebuild = await rebuildSocialFeedProjection({
    repository: {
      async rebuildCollectionScope() {
        return { eventCount: 0, itemCount: 0, highCommitOrdinal: '0' };
      },
    } as never,
    aggregateScope: accept, maxEvents: 1, maxRecipientsPerEvent: 1,
  });
  assert.equal(rebuild.eventCount, 0);
  await assert.rejects(() => rebuildSocialFeedProjection({
    repository: {
      async rebuildCollectionScope() { throw new Error('unreachable'); },
    } as never,
    aggregateScope: reject, maxEvents: 1, maxRecipientsPerEvent: 1,
  }), TypeError);

  const feedRegistration = socialCollectionChangeEnvelopeRegistrations
    .find((row) => row.eventVersion === 2)!;
  assert.equal(feedRegistration.validatePayload({
    collectionId: STABLE_22, ownerProfileId: STABLE_22,
    publicationRevision: text(256),
    discoverabilityRecheckKey: `publication.collection:${STABLE_22}`,
    producerDiscoverability: 'public_candidate',
  }), true);
  assert.equal(feedRegistration.validatePayload({
    collectionId: STABLE_22, ownerProfileId: STABLE_22,
    publicationRevision: text(257),
    discoverabilityRecheckKey: `publication.collection:${STABLE_22}`,
    producerDiscoverability: 'public_candidate',
  }), false);

  const notificationRegistration = socialNotificationEnvelopeRegistrations
    .find((row) => row.eventType === 'social.follow-created')!;
  assert.equal(notificationRegistration.validatePayload({
    actorProfileId: text(256), targetProfileId: text(256),
  }), true);
  assert.equal(notificationRegistration.validatePayload({
    actorProfileId: text(257), targetProfileId: text(256),
  }), false);

  for (const registration of socialFollowEventEnvelopeRegistrations) {
    assert.equal(registration.validatePayload({
      actorProfileId: text(255), targetProfileId: text(256),
    }), true, `${registration.eventType} must accept shared identity boundaries`);
    assert.equal(registration.validatePayload({
      actorProfileId: text(257), targetProfileId: text(256),
    }), false, `${registration.eventType} must reject 257 characters`);
    assert.equal(registration.validatePayload({
      actorProfileId: ` ${text(10)}`, targetProfileId: text(256),
    }), false, `${registration.eventType} must reject leading whitespace`);
    assert.equal(registration.validatePayload({
      actorProfileId: text(256), targetProfileId: `${text(10)} `,
    }), false, `${registration.eventType} must reject trailing whitespace`);
  }

  followKeys.destroy();
  feedKeys.destroy();
  inboxKeys.destroy();
});

test('R5-07 cursor issue/expiry follows injected database clock, not process wall clock', async () => {
  const keys = createFollowCursorKeyring({ active: ACTIVE, retained: [] });
  const reads = followReads();
  const page = await queryFollowRelations({
    reads, cursors: keys, clock: { now: async () => DB_CLOCK },
  }, { principalId: 'principal', targetProfileId: 'target', direction: 'followers', limit: 1 });
  assert.ok(page?.nextCursor);

  await assert.rejects(() => queryFollowRelations({
    reads, cursors: keys, clock: { now: async () => WALL_CLOCK },
  }, {
    principalId: 'principal', targetProfileId: 'target', direction: 'followers', limit: 1,
    cursor: page.nextCursor!,
  }), FollowCursorError);

  const almostExpired = new Date(DB_CLOCK.getTime() + FOLLOW_CURSOR_TTL_MS - 1);
  const renewed = await queryFollowRelations({
    reads, cursors: keys, clock: { now: async () => almostExpired },
  }, {
    principalId: 'principal', targetProfileId: 'target', direction: 'followers', limit: 1,
    cursor: page.nextCursor!,
  });
  assert.ok(renewed);

  const exactExpiry = new Date(DB_CLOCK.getTime() + FOLLOW_CURSOR_TTL_MS);
  await assert.rejects(() => queryFollowRelations({
    reads, cursors: keys, clock: { now: async () => exactExpiry },
  }, {
    principalId: 'principal', targetProfileId: 'target', direction: 'followers', limit: 1,
    cursor: page.nextCursor!,
  }), FollowCursorError);
  keys.destroy();
});

test('R5-07 feed and notification cursors reject exact expiry and invalid Date clocks', async () => {
  const feedKeys = createFeedCursorKeyring({ active: ACTIVE, retained: [] });
  const inboxKeys = createNotificationInboxCursorKeyring({ active: ACTIVE, retained: [] });
  const feedPage = await queryCurrentFeed({
    reads: feedReads(), cursors: feedKeys, clock: { now: async () => DB_CLOCK },
  }, { principalId: 'principal', limit: 1 });
  const inboxPage = await queryCurrentNotificationInbox({
    reads: notificationReads(), cursors: inboxKeys, clock: { now: async () => DB_CLOCK },
  }, { principalId: 'principal', limit: 1 });
  assert.ok(feedPage.nextCursor);
  assert.ok(inboxPage.nextCursor);

  const feedExact = new Date(DB_CLOCK.getTime() + FEED_CURSOR_TTL_MS);
  const inboxExact = new Date(DB_CLOCK.getTime() + NOTIFICATION_INBOX_CURSOR_TTL_MS);
  await assert.rejects(() => queryCurrentFeed({
    reads: feedReads(), cursors: feedKeys, clock: { now: async () => feedExact },
  }, { principalId: 'principal', limit: 1, cursor: feedPage.nextCursor! }), FeedCursorError);
  await assert.rejects(() => queryCurrentNotificationInbox({
    reads: notificationReads(), cursors: inboxKeys, clock: { now: async () => inboxExact },
  }, { principalId: 'principal', limit: 1, cursor: inboxPage.nextCursor! }), NotificationInboxCursorError);

  const invalid = new Date(Number.NaN);
  await assert.rejects(() => queryCurrentFeed({
    reads: feedReads(), cursors: feedKeys, clock: { now: async () => invalid },
  }, { principalId: 'principal', limit: 1 }), TypeError);
  await assert.rejects(() => queryCurrentNotificationInbox({
    reads: notificationReads(), cursors: inboxKeys, clock: { now: async () => invalid },
  }, { principalId: 'principal', limit: 1 }), TypeError);
  await assert.rejects(() => queryFollowRelations({
    reads: followReads(), cursors: createFollowCursorKeyring({ active: ACTIVE, retained: [] }),
    clock: { now: async () => invalid },
  }, { principalId: 'principal', targetProfileId: 'target', direction: 'followers', limit: 1 }), TypeError);

  feedKeys.destroy();
  inboxKeys.destroy();
});

test('R5-07 retiring retained cursor keys are rejected after retainUntil', async () => {
  const oldKeys = createFeedCursorKeyring({ active: OLD, retained: [] });
  const page = await queryCurrentFeed({
    reads: feedReads(), cursors: oldKeys, clock: { now: async () => DB_CLOCK },
  }, { principalId: 'principal', limit: 1 });
  assert.ok(page.nextCursor);
  const retainUntil = new Date(DB_CLOCK.getTime() + FEED_CURSOR_TTL_MS).toISOString();
  const rotated = createFeedCursorKeyring({
    active: ACTIVE,
    retained: [{
      ...OLD,
      lastIssuedAt: DB_CLOCK.toISOString(),
      retainUntil,
    }],
  });
  const ok = await queryCurrentFeed({
    reads: feedReads(), cursors: rotated, clock: { now: async () => DB_CLOCK },
  }, { principalId: 'principal', limit: 1, cursor: page.nextCursor! });
  assert.ok(ok);
  const retired = createFeedCursorKeyring({ active: ACTIVE, retained: [] });
  await assert.rejects(() => queryCurrentFeed({
    reads: feedReads(), cursors: retired, clock: { now: async () => DB_CLOCK },
  }, { principalId: 'principal', limit: 1, cursor: page.nextCursor! }), FeedCursorError);
  const expiredRetention = createFeedCursorKeyring({
    active: ACTIVE,
    retained: [{
      ...OLD,
      lastIssuedAt: DB_CLOCK.toISOString(),
      retainUntil,
    }],
  });
  await assert.rejects(() => queryCurrentFeed({
    reads: feedReads(), cursors: expiredRetention,
    clock: { now: async () => new Date(Date.parse(retainUntil)) },
  }, { principalId: 'principal', limit: 1, cursor: page.nextCursor! }), FeedCursorError);
  oldKeys.destroy();
  rotated.destroy();
  retired.destroy();
  expiredRetention.destroy();
});
