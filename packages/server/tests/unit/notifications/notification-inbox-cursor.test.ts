import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  NOTIFICATION_INBOX_CURSOR_PURPOSE,
  NotificationInboxCursorError,
  createNotificationInboxCursorKeyring,
} from '../../../src/modules/notifications/index.js';
import { FeedCursorError, createFeedCursorKeyring } from '../../../src/modules/social/index.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const OLD = { id: 'notification-old', secret: Buffer.alloc(32, 41).toString('base64') };
const CURRENT = { id: 'notification-current', secret: Buffer.alloc(32, 42).toString('base64') };

function payload() {
  return {
    v: 1 as const,
    purpose: NOTIFICATION_INBOX_CURSOR_PURPOSE,
    principalId: 'account-a',
    filter: 'unread' as const,
    limit: 20,
    comparatorVersion: 1 as const,
    after: { occurredAt: '2026-07-29T11:00:00.000Z', notificationId: 'notification-20' },
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
  };
}

test('notification inbox cursor is encrypted, purpose-specific and tamper evident', () => {
  const keys = createNotificationInboxCursorKeyring({ active: CURRENT, retained: [] });
  const token = keys.inbox.seal(payload());
  const repeated = keys.inbox.seal(payload());
  assert.notEqual(repeated, token, 'identical payloads must use independent IVs');
  assert.match(token, /^ninbox1\.notification-current\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/u);
  assert.deepEqual(keys.inbox.verify(token, NOW), { ...payload(), keyVersion: CURRENT.id });
  assert.deepEqual(keys.inbox.verify(repeated, NOW), { ...payload(), keyVersion: CURRENT.id });
  assert.throws(() => keys.inbox.seal({ ...payload(), comparatorVersion: 2 } as never));
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => keys.inbox.verify(tampered, NOW), NotificationInboxCursorError);
  const feedKeys = createFeedCursorKeyring({ active: CURRENT, retained: [] });
  assert.throws(() => feedKeys.feed.verify(token, NOW), FeedCursorError);
});

test('notification inbox cursor honors expiry and bounded retained-key lifecycle', () => {
  const oldKeys = createNotificationInboxCursorKeyring({ active: OLD, retained: [] });
  const token = oldKeys.inbox.seal(payload());
  const rotated = createNotificationInboxCursorKeyring({ active: CURRENT, retained: [{ ...OLD,
    lastIssuedAt: NOW.toISOString(), retainUntil: new Date(NOW.getTime() + 900_000).toISOString(),
  }] });
  assert.equal(rotated.inbox.verify(token, NOW).keyVersion, OLD.id);
  assert.match(rotated.inbox.seal(payload()), /^ninbox1\.notification-current\./u);
  assert.throws(() => rotated.inbox.verify(token, new Date(NOW.getTime() + 900_000)),
    NotificationInboxCursorError);
  assert.throws(() => createNotificationInboxCursorKeyring({ active: CURRENT, retained: [{ ...OLD,
    lastIssuedAt: NOW.toISOString(), retainUntil: new Date(NOW.getTime() + 899_999).toISOString(),
  }] }), /cover cursor TTL/iu);
});
