import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  NOTIFICATION_READ_BULK_MAX_ITEMS,
  NOTIFICATION_READ_COMMAND_CONTRACT_VERSION,
  NotificationReadCommandError,
  markNotificationRead,
  markNotificationsRead,
  notificationReadCommandFingerprint,
  type NotificationReadCommandPorts,
} from '../../../src/modules/notifications/index.js';

const PRINCIPAL = 'account-a';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const NOW = new Date('2026-07-29T08:00:00.000Z');

function ports(claim: Awaited<ReturnType<NotificationReadCommandPorts['receipts']['claim']>> =
{ kind: 'claimed' }): { value: NotificationReadCommandPorts; effects: string[] } {
  const effects: string[] = [];
  return { effects, value: {
    receipts: {
      async claim() { effects.push('claim'); return claim; },
      async complete(_binding, _fingerprint, result) {
        effects.push('complete');
        assert.equal(result.contractVersion, NOTIFICATION_READ_COMMAND_CONTRACT_VERSION);
      },
      async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    authority: {
      async markOne(input) {
        effects.push('authority');
        return input.notificationId === 'missing' ? { kind: 'not_found' }
          : input.notificationId === 'read' ? { kind: 'already_read', stateRevision: 7n, readAt: NOW }
            : { kind: 'marked', stateRevision: input.expectedStateRevision + 1n, readAt: NOW };
      },
      async markMany(input) {
        effects.push('authority');
        return { requestedCount: input.notificationIds.length,
          markedCount: input.notificationIds.filter((id) => id !== 'read').length };
      },
    },
    audit: { async append(event) {
      effects.push('audit');
      assert.deepEqual(Object.keys(event).sort(),
        ['changedCount', 'createdAt', 'mode', 'outcome', 'principalId', 'requestedCount']);
    } },
    clock: { async now() { return NOW; } },
  } };
}

test('mark-one claims, CAS marks, writes privacy-minimal Audit and completes once', async () => {
  const seen = ports();
  const result = await markNotificationRead(seen.value, { principalId: PRINCIPAL,
    notificationId: 'notification-1', expectedStateRevision: 2n, commandId: COMMAND_ID });
  assert.deepEqual(result, { kind: 'succeeded', outcome: 'marked', notificationId: 'notification-1',
    state: 'read', stateRevision: 3n, readAt: NOW.toISOString(), changed: true });
  assert.deepEqual(seen.effects, ['claim', 'authority', 'audit', 'complete']);
});

test('already-read is a stable successful no-op and missing/foreign is concealed', async () => {
  const already = ports();
  assert.deepEqual(await markNotificationRead(already.value, { principalId: PRINCIPAL,
    notificationId: 'read', expectedStateRevision: 0n, commandId: COMMAND_ID }),
  { kind: 'succeeded', outcome: 'already_read', notificationId: 'read', state: 'read',
    stateRevision: 7n, readAt: NOW.toISOString(), changed: false });
  const hidden = ports();
  assert.deepEqual(await markNotificationRead(hidden.value, { principalId: PRINCIPAL,
    notificationId: 'missing', expectedStateRevision: 0n, commandId: COMMAND_ID }),
  { kind: 'succeeded', outcome: 'not_found', changed: false });
  assert.deepEqual(hidden.effects, ['claim', 'authority', 'audit', 'complete']);
});

test('exact replay/reuse/in-progress/expired never re-enters authority or Audit', async () => {
  const replayBody = Buffer.from('{"first":true}');
  for (const claim of [
    { kind: 'replay' as const, result: { status: 200, body: replayBody,
      stableHeaders: { 'content-type': 'application/json' }, mediaType: 'application/json',
      contractVersion: NOTIFICATION_READ_COMMAND_CONTRACT_VERSION } },
    { kind: 'reused' as const }, { kind: 'in_progress' as const, retryAfterSeconds: 1 },
    { kind: 'expired' as const, resultDigest: 'a'.repeat(64) },
  ]) {
    const seen = ports(claim);
    const result = await markNotificationRead(seen.value, { principalId: PRINCIPAL,
      notificationId: 'notification-1', expectedStateRevision: 0n, commandId: COMMAND_ID });
    assert.equal(result.kind, claim.kind);
    assert.deepEqual(seen.effects, ['claim']);
  }
});

test('bounded bulk validates nonempty unique identities and the resource-safe maximum', async () => {
  assert.equal(NOTIFICATION_READ_BULK_MAX_ITEMS, 100);
  const valid = Array.from({ length: NOTIFICATION_READ_BULK_MAX_ITEMS }, (_, index) => `n-${index}`);
  const seen = ports();
  assert.deepEqual(await markNotificationsRead(seen.value, { principalId: PRINCIPAL,
    notificationIds: valid, commandId: COMMAND_ID }),
  { kind: 'succeeded', requestedCount: 100, markedCount: 100 });
  for (const notificationIds of [[], ['same', 'same'], [...valid, 'overflow']]) {
    await assert.rejects(() => markNotificationsRead(ports().value,
      { principalId: PRINCIPAL, notificationIds, commandId: COMMAND_ID }),
    (error: unknown) => error instanceof NotificationReadCommandError
      && error.code === 'invalid_request');
  }
});

test('validated input is snapshotted before the asynchronous receipt claim', async () => {
  const input = { principalId: PRINCIPAL, notificationIds: ['n-1'], commandId: COMMAND_ID };
  const seen = ports();
  seen.value.receipts.claim = async () => {
    input.notificationIds[0] = 'mutated'; input.notificationIds.push('n-2');
    return { kind: 'claimed' };
  };
  assert.deepEqual(await markNotificationsRead(seen.value, input),
    { kind: 'succeeded', requestedCount: 1, markedCount: 1 });
});

test('mark-one rejects revisions outside the PostgreSQL bigint domain', async () => {
  await assert.rejects(() => markNotificationRead(ports().value, { principalId: PRINCIPAL,
    notificationId: 'n-1', expectedStateRevision: 9_223_372_036_854_775_808n,
    commandId: COMMAND_ID }),
  (error: unknown) => error instanceof NotificationReadCommandError
    && error.code === 'invalid_request');
});

test('fingerprint binds principal, mode, CAS revision, ordered bulk identities and contract', () => {
  const base = { principalId: PRINCIPAL, notificationId: 'n-1', expectedStateRevision: 0n,
    commandId: COMMAND_ID };
  const fingerprint = notificationReadCommandFingerprint('one', base);
  assert.notEqual(fingerprint, notificationReadCommandFingerprint('one',
    { ...base, expectedStateRevision: 1n }));
  assert.notEqual(fingerprint, notificationReadCommandFingerprint('one',
    { ...base, principalId: 'account-b' }));
  assert.notEqual(notificationReadCommandFingerprint('bulk', { principalId: PRINCIPAL,
    notificationIds: ['n-1', 'n-2'], commandId: COMMAND_ID }),
  notificationReadCommandFingerprint('bulk', { principalId: PRINCIPAL,
    notificationIds: ['n-2', 'n-1'], commandId: COMMAND_ID }));
});
