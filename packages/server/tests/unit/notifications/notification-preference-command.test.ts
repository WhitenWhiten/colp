import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION,
  NotificationPreferenceCommandError,
  getNotificationPreferences,
  notificationPreferenceCommandFingerprint,
  updateNotificationPreference,
  type NotificationPreferenceCommandPorts,
  type NotificationPreferenceReadPort,
} from '../../../src/modules/notifications/index.js';

const PRINCIPAL = 'account-a';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const NOW = new Date('2026-07-29T09:00:00.000Z');

function channelValue(enabled: boolean, stateRevision: bigint, updatedAt: Date = NOW) {
  return { enabled, stateRevision, updatedAt };
}

test('read exposes in_app plus additive email status and maps persisted server defaults', async () => {
  const read: NotificationPreferenceReadPort = {
    async getForPrincipal(principalId) {
      assert.equal(principalId, PRINCIPAL);
      return {
        inApp: channelValue(true, 2n, NOW),
        email: channelValue(false, 0n, NOW),
        emailSuppressed: false,
      };
    },
  };
  const value = await getNotificationPreferences(read, { principalId: PRINCIPAL });
  assert.deepEqual(value, {
    channel: 'in_app', enabled: true, revision: 2n, updatedAt: NOW.toISOString(),
    email: { enabled: false, revision: 0n, updatedAt: NOW.toISOString(),
      verifiedSender: null, emailSuppressed: false, emailAvailable: false },
  });
});

test('read overlays verified sender, availability and suppression from the runtime view', async () => {
  const read: NotificationPreferenceReadPort = {
    async getForPrincipal() {
      return {
        inApp: channelValue(true, 1n),
        email: channelValue(true, 4n, new Date('2026-07-29T09:05:00.000Z')),
        emailSuppressed: true,
      };
    },
  };
  const value = await getNotificationPreferences(read, { principalId: PRINCIPAL }, {
    verifiedSender: 'no-reply@example.com', emailAvailable: true,
  });
  assert.deepEqual(value.email, { enabled: true, revision: 4n,
    updatedAt: '2026-07-29T09:05:00.000Z', verifiedSender: 'no-reply@example.com',
    emailSuppressed: true, emailAvailable: true });
});

function ports(claim: Awaited<ReturnType<NotificationPreferenceCommandPorts['receipts']['claim']>> =
{ kind: 'claimed' }, authority = { enabled: false, stateRevision: 3n, updatedAt: NOW,
  changed: true }, expectedChannel: 'in_app' | 'email' = 'in_app'):
{ value: NotificationPreferenceCommandPorts; effects: string[] } {
  const effects: string[] = [];
  return { effects, value: {
    receipts: {
      async claim() { effects.push('claim'); return claim; },
      async complete(_binding, _fingerprint, result) {
        effects.push('complete');
        assert.equal(result.contractVersion, NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION);
        assert.equal(result.targetIdentity, expectedChannel);
      },
      async purgeExpired() { return 0; }, async deletePrincipalReceipts() { return 0; },
    },
    authority: { async update(input) {
      effects.push('authority');
      assert.equal(input.channel, expectedChannel);
      return authority;
    } },
    audit: { async append(event) {
      effects.push('audit');
      assert.equal(event.channel, expectedChannel);
      assert.deepEqual(Object.keys(event).sort(),
        ['changed', 'channel', 'createdAt', 'mode', 'outcome', 'principalId']);
    } },
    clock: { async now() { return NOW; } },
  } };
}

test('set claims, applies channel CAS, writes minimal Audit and completes once', async () => {
  const seen = ports();
  assert.deepEqual(await updateNotificationPreference(seen.value, { principalId: PRINCIPAL,
    channel: 'in_app', mode: 'set', enabled: false, expectedRevision: 2n,
    commandId: COMMAND_ID }), { kind: 'succeeded', channel: 'in_app', enabled: false,
    revision: 3n, updatedAt: NOW.toISOString(), changed: true });
  assert.deepEqual(seen.effects, ['claim', 'authority', 'audit', 'complete']);
});

test('email channel set/reset are independent commands with the email default', async () => {
  const email = ports({ kind: 'claimed' }, { enabled: true, stateRevision: 1n, updatedAt: NOW,
    changed: true }, 'email');
  assert.deepEqual(await updateNotificationPreference(email.value, { principalId: PRINCIPAL,
    channel: 'email', mode: 'set', enabled: true, expectedRevision: 0n,
    commandId: COMMAND_ID }), { kind: 'succeeded', channel: 'email', enabled: true,
    revision: 1n, updatedAt: NOW.toISOString(), changed: true });
  assert.deepEqual(email.effects, ['claim', 'authority', 'audit', 'complete']);

  const reset = ports({ kind: 'claimed' }, { enabled: false, stateRevision: 2n, updatedAt: NOW,
    changed: true }, 'email');
  assert.deepEqual(await updateNotificationPreference(reset.value, { principalId: PRINCIPAL,
    channel: 'email', mode: 'reset', expectedRevision: 1n, commandId: COMMAND_ID }),
  { kind: 'succeeded', channel: 'email', enabled: false, revision: 2n,
    updatedAt: NOW.toISOString(), changed: true });
});

test('reset uses the server default and a same-value update is a stable successful no-op', async () => {
  const unchanged = ports({ kind: 'claimed' }, { enabled: true, stateRevision: 4n,
    updatedAt: NOW, changed: false });
  assert.deepEqual(await updateNotificationPreference(unchanged.value, { principalId: PRINCIPAL,
    channel: 'in_app', mode: 'reset', expectedRevision: 4n, commandId: COMMAND_ID }),
  { kind: 'succeeded', channel: 'in_app', enabled: true, revision: 4n,
    updatedAt: NOW.toISOString(), changed: false });
  assert.deepEqual(unchanged.effects, ['claim', 'authority', 'audit', 'complete']);
});

test('exact replay/reuse/in-progress/expired never re-enters authority or Audit', async () => {
  for (const claim of [
    { kind: 'replay' as const, result: { status: 200, body: Buffer.from('{"first":true}'),
      stableHeaders: { 'content-type': 'application/json' }, mediaType: 'application/json',
      contractVersion: NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION,
      targetIdentity: 'in_app' } },
    { kind: 'reused' as const }, { kind: 'in_progress' as const, retryAfterSeconds: 1 },
    { kind: 'expired' as const, resultDigest: 'a'.repeat(64) },
  ]) {
    const seen = ports(claim);
    assert.equal((await updateNotificationPreference(seen.value, { principalId: PRINCIPAL,
      channel: 'in_app', mode: 'set', enabled: false, expectedRevision: 0n,
      commandId: COMMAND_ID })).kind, claim.kind);
    assert.deepEqual(seen.effects, ['claim']);
  }
});

test('email channel replay is exact: same command id and channel never re-enters authority', async () => {
  const claim = { kind: 'replay' as const, result: { status: 200, body: Buffer.from('{"first":true}'),
    stableHeaders: { 'content-type': 'application/json' }, mediaType: 'application/json',
    contractVersion: NOTIFICATION_PREFERENCE_COMMAND_CONTRACT_VERSION, targetIdentity: 'email' } };
  const seen = ports(claim, undefined, 'email');
  const outcome = await updateNotificationPreference(seen.value, { principalId: PRINCIPAL,
    channel: 'email', mode: 'set', enabled: true, expectedRevision: 0n, commandId: COMMAND_ID });
  assert.equal(outcome.kind, 'replay');
  assert.deepEqual(seen.effects, ['claim']);
});

test('stale authority fails closed before Audit and receipt completion', async () => {
  const seen = ports({ kind: 'claimed' }, { kind: 'stale' } as never);
  await assert.rejects(() => updateNotificationPreference(seen.value, { principalId: PRINCIPAL,
    channel: 'in_app', mode: 'set', enabled: false, expectedRevision: 7n,
    commandId: COMMAND_ID }), (error: unknown) => error instanceof NotificationPreferenceCommandError
      && error.code === 'stale_revision');
  assert.deepEqual(seen.effects, ['claim', 'authority']);
});

test('invalid and unavailable Product channels are rejected before receipt claim', async () => {
  for (const input of [
    { channel: 'push', mode: 'set', enabled: true },
    { channel: 'sms', mode: 'reset' },
    { channel: 'in_app', mode: 'reset', enabled: false },
    { channel: 'in_app', mode: 'set' },
    { channel: 'email', mode: 'set' },
    { channel: 'email', mode: 'reset', enabled: true },
  ]) {
    const seen = ports();
    await assert.rejects(() => updateNotificationPreference(seen.value, { principalId: PRINCIPAL,
      expectedRevision: 0n, commandId: COMMAND_ID, ...input } as never),
    (error: unknown) => error instanceof NotificationPreferenceCommandError
      && error.code === 'invalid_request');
    assert.deepEqual(seen.effects, []);
  }
});

test('fingerprint binds principal, channel, mode, desired value, CAS revision and contract', () => {
  const base = { principalId: PRINCIPAL, channel: 'in_app' as const, mode: 'set' as const,
    enabled: false, expectedRevision: 0n, commandId: COMMAND_ID };
  const value = notificationPreferenceCommandFingerprint(base);
  assert.notEqual(value, notificationPreferenceCommandFingerprint({ ...base, enabled: true }));
  assert.notEqual(value, notificationPreferenceCommandFingerprint({ ...base, expectedRevision: 1n }));
  assert.notEqual(value, notificationPreferenceCommandFingerprint({ ...base,
    principalId: 'account-b' }));
  assert.notEqual(value, notificationPreferenceCommandFingerprint({ principalId: PRINCIPAL,
    channel: 'in_app', mode: 'reset', expectedRevision: 0n, commandId: COMMAND_ID }));
  // email is a distinct channel intent even with the same desired value.
  assert.notEqual(value, notificationPreferenceCommandFingerprint({ principalId: PRINCIPAL,
    channel: 'email', mode: 'set', enabled: false, expectedRevision: 0n, commandId: COMMAND_ID }));
  assert.notEqual(notificationPreferenceCommandFingerprint({ principalId: PRINCIPAL,
    channel: 'email', mode: 'reset', expectedRevision: 0n, commandId: COMMAND_ID }),
  notificationPreferenceCommandFingerprint({ principalId: PRINCIPAL, channel: 'in_app',
    mode: 'reset', expectedRevision: 0n, commandId: COMMAND_ID }));
});
