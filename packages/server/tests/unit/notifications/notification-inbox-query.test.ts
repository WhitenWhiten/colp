import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  NotificationInboxCursorError,
  createNotificationInboxCursorKeyring,
  queryCurrentNotificationInbox,
  type NotificationInboxPageReadInput,
  type NotificationInboxQueryFact,
  type NotificationInboxReadPort,
} from '../../../src/modules/notifications/index.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const CURRENT = { id: 'notification-query', secret: Buffer.alloc(32, 43).toString('base64') };

const INBOX_ITEM_KEYS = ['actorDisplayName', 'actorHandle', 'actorProfileId', 'collectionTitle',
  'notificationId', 'notificationType', 'occurredAt', 'publicationSlug', 'readAt', 'state',
  'stateRevision', 'subject', 'summary'];

function fact(index: number, state: NotificationInboxQueryFact['state'] = 'unread'):
NotificationInboxQueryFact {
  const value = String(index).padStart(4, '0');
  const follow = Boolean(index % 2);
  return { notificationId: `notification-${value}`,
    notificationType: follow ? 'follow_activity' : 'collection_change',
    actorProfileId: `profile-${value}`,
    actorHandle: `actor_${value}`, actorDisplayName: `Actor ${value}`,
    subjectType: follow ? 'profile' : 'collection', subjectId: `subject-${value}`,
    collectionTitle: follow ? null : `Collection ${value}`,
    publicationSlug: follow ? null : `pub-${value}`, summary: null,
    state, stateRevision: BigInt(Math.max(0, index)),
    readAt: state === 'read' ? new Date(NOW.getTime() - index * 500) : null,
    occurredAt: new Date(NOW.getTime() - index * 1_000) };
}

function readPort(rows: NotificationInboxQueryFact[]): NotificationInboxReadPort {
  return { async loadPage(input: NotificationInboxPageReadInput) {
    return rows.filter((row) => (input.state === undefined || row.state === input.state)
      && (!input.after || row.occurredAt < input.after.occurredAt
        || (row.occurredAt.getTime() === input.after.occurredAt.getTime()
          && row.notificationId < input.after.notificationId))).slice(0, input.limit + 1);
  }, async countUnread() { return rows.filter((row) => row.state === 'unread').length; } };
}

function ports(rows: NotificationInboxQueryFact[], now = NOW) {
  return { reads: readPort(rows), cursors: createNotificationInboxCursorKeyring({
    active: CURRENT, retained: [] }), clock: { now: async () => now } };
}

test('empty and full pages traverse the stable tuple and map only private inbox DTO fields', async () => {
  assert.deepEqual(await queryCurrentNotificationInbox(ports([]), { principalId: 'account-a' }),
    { items: [], nextCursor: null, unreadCount: 0 });
  const rows = Array.from({ length: 207 }, (_, index) => fact(index, index % 3 ? 'unread' : 'read'));
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = await queryCurrentNotificationInbox(ports(rows), { principalId: 'account-a', limit: 17,
      ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((item) => item.notificationId));
    assert.equal(page.unreadCount, rows.filter((row) => row.state === 'unread').length);
    assert.deepEqual(Object.keys(page.items[0] ?? {}).sort(), page.items.length
      ? INBOX_ITEM_KEYS : []);
    if (page.items[0]) {
      assert.equal(Object.hasOwn(page.items[0], 'actorHandle'), true);
      assert.equal(Object.hasOwn(page.items[0], 'summary'), true);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, rows.map((row) => row.notificationId));
  assert.equal(new Set(seen).size, rows.length);
  assert.equal(JSON.stringify((await queryCurrentNotificationInbox(ports(rows),
    { principalId: 'account-a', limit: 1 })).items).includes('sourceEventId'), false);
});

test('all/read/unread filters are normalized and unread count is independent of page length', async () => {
  const rows = [fact(0), fact(1, 'read'), fact(2), fact(3, 'read'), fact(4)];
  const all = await queryCurrentNotificationInbox(ports(rows), {
    principalId: 'account-a', state: '  ALL  ', limit: 10 });
  assert.equal(all.items.length, rows.length);
  assert.equal(all.unreadCount, 3);
  const unread = await queryCurrentNotificationInbox(ports(rows), {
    principalId: 'account-a', state: '  UNREAD  ', limit: 1 });
  assert.equal(unread.items.length, 1);
  assert.equal(unread.unreadCount, 3);
  const read = await queryCurrentNotificationInbox(ports(rows), {
    principalId: 'account-a', state: 'read', limit: 10 });
  assert.deepEqual(read.items.map((item) => item.state), ['read', 'read']);
  assert.equal(read.unreadCount, 3);
  await assert.rejects(() => queryCurrentNotificationInbox(ports(rows), {
    principalId: 'account-a', state: 'delivery_failed' }), /invalid Notification state/iu);
});

test('fence is exclusive across equal timestamps and stable under insertion and deletion', async () => {
  const tied = new Date('2026-07-29T11:59:59.000Z');
  const rows = [{ ...fact(0), notificationId: 'notification-c', occurredAt: tied },
    { ...fact(0), notificationId: 'notification-b', occurredAt: tied }, fact(2), fact(3)];
  const shared = ports(rows);
  const first = await queryCurrentNotificationInbox(shared, { principalId: 'account-a', limit: 1 });
  rows.unshift(fact(-1));
  rows.splice(rows.findIndex((row) => row.notificationId === 'notification-0002'), 1);
  const seen = [...first.items.map((item) => item.notificationId)]; let cursor = first.nextCursor;
  while (cursor) {
    const page = await queryCurrentNotificationInbox(shared, { principalId: 'account-a', limit: 1, cursor });
    seen.push(...page.items.map((item) => item.notificationId)); cursor = page.nextCursor;
  }
  assert.deepEqual(seen, ['notification-c', 'notification-b', 'notification-0003']);
});

test('cursor binds principal, normalized filter, limit and rejects expiry and cross-account replay', async () => {
  const rows = [fact(0), fact(1), fact(2)];
  const first = await queryCurrentNotificationInbox(ports(rows), {
    principalId: 'account-a', state: 'unread', limit: 1 });
  const token = first.nextCursor!;
  for (const input of [
    { principalId: 'account-b', state: 'unread', limit: 1, cursor: token },
    { principalId: 'account-a', state: 'read', limit: 1, cursor: token },
    { principalId: 'account-a', state: 'unread', limit: 2, cursor: token },
  ]) await assert.rejects(() => queryCurrentNotificationInbox(ports(rows), input),
  NotificationInboxCursorError);
  await assert.rejects(() => queryCurrentNotificationInbox(ports(rows,
    new Date(NOW.getTime() + 900_000)), { principalId: 'account-a', state: 'unread',
    limit: 1, cursor: token }), NotificationInboxCursorError);
});

test('rejects unsafe adapter facts and comparator violations without reflecting secret markers', async () => {
  await assert.rejects(() => queryCurrentNotificationInbox(ports([
    { ...fact(0), subjectId: 'notification-inbox-secret-marker\n' },
  ]), { principalId: 'account-a' }), /invalid Notification inbox projection/iu);
  await assert.rejects(() => queryCurrentNotificationInbox(ports([
    { ...fact(0), actorHandle: 'BAD HANDLE' },
  ]), { principalId: 'account-a' }), /invalid Notification inbox projection/iu);
  await assert.rejects(() => queryCurrentNotificationInbox(ports([fact(1), fact(0)]),
    { principalId: 'account-a' }), /violated comparator/iu);
});

test('maps locator keys even when JOIN facts are null', async () => {
  const page = await queryCurrentNotificationInbox(ports([{
    ...fact(0), actorHandle: null, actorDisplayName: null,
    collectionTitle: null, publicationSlug: null, summary: null,
  }]), { principalId: 'account-a' });
  assert.deepEqual(Object.keys(page.items[0]!).sort(), INBOX_ITEM_KEYS);
  assert.equal(page.items[0]!.actorHandle, null);
  assert.equal(page.items[0]!.actorDisplayName, null);
  assert.equal(page.items[0]!.collectionTitle, null);
  assert.equal(page.items[0]!.publicationSlug, null);
  assert.equal(page.items[0]!.summary, null);
});

test('emits closed summary tokens from kind and locator visibility', async () => {
  const change = await queryCurrentNotificationInbox(ports([fact(0)]), { principalId: 'account-a' });
  assert.equal(change.items[0]!.notificationType, 'collection_change');
  assert.equal(change.items[0]!.summary, 'public_collection_updated');
  const follow = await queryCurrentNotificationInbox(ports([fact(1)]), { principalId: 'account-a' });
  assert.equal(follow.items[0]!.notificationType, 'follow_activity');
  assert.equal(follow.items[0]!.summary, 'new_follower');
  assert.equal(follow.items[0]!.collectionTitle, null);
  assert.equal(follow.items[0]!.publicationSlug, null);
  const hidden = await queryCurrentNotificationInbox(ports([{
    ...fact(0), collectionTitle: null, publicationSlug: null, summary: null,
  }]), { principalId: 'account-a' });
  assert.equal(hidden.items[0]!.summary, null);
  assert.doesNotMatch(JSON.stringify([...change.items, ...follow.items, ...hidden.items]),
    /"details"|nodeIds|https?:\/\//u);
});
