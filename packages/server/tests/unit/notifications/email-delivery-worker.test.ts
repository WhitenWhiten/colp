import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { yieldToEventLoop } from '../../support/async-test-helpers.js';
import {
  EMAIL_BODY_MAX_BYTES,
  EMAIL_SUBJECT_MAX_CHARS,
  type EmailCallbackFact,
  type EmailDeliveryClassification,
  type EmailDeliveryErrorCategory,
  type EmailDeliverySendOutcome,
  type EmailLookupResult,
  type EmailSendResult,
} from '../../../src/modules/notifications/index.js';
import {
  createEmailDeliveryRetryPolicy,
  createEmailTemplateRenderers,
  decideEmailProcessingFailure,
  decideEmailSendOutcome,
  evaluateEmailSuppression,
  evaluateEmailSuppressionForAttempt,
  processEmailDeliveryClaim,
  reconcileEmailCallback,
  renderCollectionChangeEmail,
  renderFollowActivityEmail,
  parseCallbackOccurredAt,
  type EmailCallbackReconcilerRepository,
  type EmailDeliveryAttempt,
  type EmailDeliveryWorkerRepository,
  type EmailProviderAdapter,
  type EmailTemplateContext,
  type EmailTemplateRenderers,
} from '../../../src/modules/notifications/index.js';
import { EmailDeliveryWorkerLoop } from '../../../src/infrastructure/notifications/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');

function followContext(overrides: Partial<EmailTemplateContext> = {}): EmailTemplateContext {
  return Object.freeze({ notificationType: 'follow_activity', actorName: 'Alice',
    collectionTitle: null, occurredAt: NOW, ...overrides });
}
function collectionContext(overrides: Partial<EmailTemplateContext> = {}): EmailTemplateContext {
  return Object.freeze({ notificationType: 'collection_change', actorName: 'Bob',
    collectionTitle: 'Reading List', occurredAt: NOW, ...overrides });
}

test('P5-29 follow_activity renderer honors subject/body budgets with plain text and escaped HTML', () => {
  const message = renderFollowActivityEmail(followContext({ actorName: 'Alice <3 & co' }));
  assert.ok(message.subject.length <= EMAIL_SUBJECT_MAX_CHARS);
  assert.ok((message.textBody ?? '').length > 0, 'text body required');
  assert.ok(Buffer.byteLength(message.textBody!, 'utf8') <= EMAIL_BODY_MAX_BYTES);
  assert.ok(Buffer.byteLength(message.htmlBody!, 'utf8') <= EMAIL_BODY_MAX_BYTES);
  assert.match(message.subject, /follower/iu);
  assert.match(message.textBody!, /Alice <3 & co/u);
  assert.match(message.htmlBody!, /Alice &lt;3 &amp; co/u);
  assert.doesNotMatch(message.htmlBody!, /Alice <3 & co/u);
});

test('P5-29 collection_change renderer includes the escaped collection title', () => {
  const message = renderCollectionChangeEmail(collectionContext({ collectionTitle: 'Safari <b>Bookmarks</b>' }));
  assert.ok(message.subject.length <= EMAIL_SUBJECT_MAX_CHARS);
  assert.match(message.textBody!, /Safari <b>Bookmarks<\/b>/u);
  assert.match(message.htmlBody!, /Safari &lt;b&gt;Bookmarks&lt;\/b&gt;/u);
  assert.doesNotMatch(message.htmlBody!, /<b>Bookmarks<\/b>/u);
});

test('P5-29 template injection markers are escaped in HTML and stay out of the recipient address', () => {
  const markerActor = 'P529_UNIQUE_ACTOR_<script>alert("pwned")</script>';
  const markerTitle = 'P529_UNIQUE_TITLE_<img src=x onerror=\'alert(1)\'>';
  const recipientEmail = 'P529_UNIQUE_RECIPIENT@example.invalid';
  const message = renderCollectionChangeEmail(
    collectionContext({ actorName: markerActor, collectionTitle: markerTitle }));
  const serialized = JSON.stringify(message);
  assert.doesNotMatch(message.htmlBody!, /<script>/u);
  assert.doesNotMatch(message.htmlBody!, /<img /u);
  assert.match(message.htmlBody!, /P529_UNIQUE_ACTOR_/u);
  assert.match(message.htmlBody!, /&lt;script&gt;alert\(&quot;pwned&quot;\)&lt;\/script&gt;/u);
  assert.match(message.htmlBody!, /&lt;img src=x onerror=&#39;alert\(1\)&#39;&gt;/u);
  assert.doesNotMatch(serialized, new RegExp(recipientEmail.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  // The same input renders deterministically (no timestamps, ids or nonce).
  const again = renderCollectionChangeEmail(
    collectionContext({ actorName: markerActor, collectionTitle: markerTitle }));
  assert.deepEqual(again, message);
});

test('P5-29 renderers stay within budgets for maximal user-controlled lengths', () => {
  const renderers = createEmailTemplateRenderers();
  for (const message of [
    renderers.render('follow_activity', followContext({ actorName: 'a'.repeat(120) })),
    renderers.render('collection_change',
      collectionContext({ actorName: 'b'.repeat(120), collectionTitle: 'c'.repeat(512) })),
  ]) {
    assert.ok(message.subject.length <= EMAIL_SUBJECT_MAX_CHARS);
    assert.ok(Buffer.byteLength(message.textBody ?? '', 'utf8') <= EMAIL_BODY_MAX_BYTES);
    assert.ok(Buffer.byteLength(message.htmlBody ?? '', 'utf8') <= EMAIL_BODY_MAX_BYTES);
    assert.ok((message.textBody ?? message.htmlBody ?? '').length > 0);
  }
  assert.throws(() => renderers.render('marketing' as never, followContext()),
    /unsupported notification type/u);
});

test('P5-29 retry policy is bounded and backoff increases with attempt count', () => {
  const policy = createEmailDeliveryRetryPolicy({
    baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 3, jitterRatio: 0, random: () => 0,
  });
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.backoffMs(1), 1_000);
  assert.equal(policy.backoffMs(2), 2_000);
  assert.equal(policy.backoffMs(10), 10_000);
  assert.throws(() => createEmailDeliveryRetryPolicy({ baseDelayMs: 0 }), /invalid email delivery retry policy/u);
  assert.throws(() => createEmailDeliveryRetryPolicy({ maxAttempts: 0 }), /invalid email delivery retry policy/u);
  assert.throws(() => createEmailDeliveryRetryPolicy({ jitterRatio: 2 }), /invalid email delivery retry policy/u);
});

test('P5-29 send outcome classification maps to delivery transitions (retry/dead-letter table)', () => {
  const policy = createEmailDeliveryRetryPolicy({
    baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 3, jitterRatio: 0, random: () => 0,
  });
  const decide = (classification: EmailDeliveryClassification, attemptCount: number,
    errorCategory: EmailDeliveryErrorCategory | null = null): EmailDeliverySendOutcome =>
    decideEmailSendOutcome({ classification, errorCategory, attemptCount, retryPolicy: policy, now: NOW });
  assert.deepEqual(decide('success', 1), { disposition: 'delivered', errorCategory: null, nextAttemptAt: null });
  assert.deepEqual(decide('retryable', 1, 'provider_unavailable'),
    { disposition: 'retryable', errorCategory: 'provider_unavailable', nextAttemptAt: new Date(NOW.getTime() + 1_000) });
  assert.deepEqual(decide('retryable', 2, 'dependency'),
    { disposition: 'retryable', errorCategory: 'dependency', nextAttemptAt: new Date(NOW.getTime() + 2_000) });
  assert.deepEqual(decide('retryable', 3, 'provider_unavailable'),
    { disposition: 'dead_letter', errorCategory: 'retry_exhausted', nextAttemptAt: null });
  assert.deepEqual(decide('permanent', 1, 'invalid_contract'),
    { disposition: 'dead_letter', errorCategory: 'invalid_contract', nextAttemptAt: null });
  assert.deepEqual(decide('permanent', 5, null),
    { disposition: 'dead_letter', errorCategory: 'invalid_contract', nextAttemptAt: null });
  assert.deepEqual(decide('unknown', 1, 'other'),
    { disposition: 'retryable', errorCategory: 'other', nextAttemptAt: new Date(NOW.getTime() + 1_000) });
  assert.deepEqual(decide('unknown', 3, 'other'),
    { disposition: 'dead_letter', errorCategory: 'retry_exhausted', nextAttemptAt: null });
});

test('P5-29 suppression decision rechecks preferences, account activity and durable facts', () => {
  assert.deepEqual(evaluateEmailSuppression({ accountActive: true, emailEnabled: true,
    accountEmail: 'a@example.invalid', suppression: null }),
  { decision: 'sendable', reason: 'none' });
  assert.deepEqual(evaluateEmailSuppression({ accountActive: true, emailEnabled: false,
    accountEmail: 'a@example.invalid', suppression: null }),
  { decision: 'suppressed', reason: 'email_disabled' });
  assert.deepEqual(evaluateEmailSuppression({ accountActive: false, emailEnabled: true,
    accountEmail: 'a@example.invalid', suppression: null }),
  { decision: 'suppressed', reason: 'account_inactive' });
  assert.deepEqual(evaluateEmailSuppression({ accountActive: true, emailEnabled: true,
    accountEmail: 'a@example.invalid', suppression: 'bounce' }),
  { decision: 'suppressed', reason: 'durable_suppression' });
  // Account inactivity wins over an enabled preference (mid-race account deactivation).
  assert.deepEqual(evaluateEmailSuppression({ accountActive: false, emailEnabled: false,
    accountEmail: null, suppression: 'unsubscribe' }),
  { decision: 'suppressed', reason: 'account_inactive' });
});

// ---------------------------------------------------------------------------
// processEmailDeliveryClaim orchestration (lease fencing + send recovery).
// ---------------------------------------------------------------------------

const ATTEMPT: EmailDeliveryAttempt = Object.freeze({
  deliveryId: 'delivery-1', notificationId: 'notification-1', recipientAccountId: 'recipient-1',
  state: 'leased', attemptCount: 1, stateRevision: '3', nextAttemptAt: NOW,
  leasedUntil: new Date(NOW.getTime() + 30_000), lastErrorCategory: null,
  providerMessageId: null,
});

function memoryRepository(overrides: Partial<EmailDeliveryWorkerRepository> = {}) {
  const calls: string[] = [];
  const repository: EmailDeliveryWorkerRepository = {
    async claimDue() { calls.push('claimDue'); return []; },
    async heartbeat() { calls.push('heartbeat'); return true; },
    async loadAttempt(fence) {
      calls.push(`loadAttempt:${fence.attemptCount}`);
      return fence.deliveryId === ATTEMPT.deliveryId
        ? { ...ATTEMPT, attemptCount: fence.attemptCount } : null;
    },
    async readSuppressionFacts() {
      calls.push('readSuppressionFacts');
      return { accountActive: true, emailEnabled: true, accountEmail: 'recipient@example.invalid',
        suppression: null };
    },
    async loadTemplateContext() { calls.push('loadTemplateContext'); return followContext(); },
    async recordSuppressionFact(_recipient, source) { calls.push(`recordSuppressionFact:${source}`); },
    async completeDelivery() { calls.push('completeDelivery'); return true; },
    async failDelivery(_fence, input) {
      calls.push(`failDelivery:${input.deadLetter ? 'dead_letter' : 'retryable'}:${input.errorCategory ?? 'null'}`);
      return true;
    },
    async suppressDelivery() { calls.push('suppressDelivery'); return true; },
    ...overrides,
  };
  return { repository, calls };
}

function stubProvider(options: {
  readonly send?: EmailSendResult;
  readonly lookup?: EmailLookupResult;
} = {}) {
  const sent: Array<{ idempotencyKey: string }> = [];
  const lookedUp: string[] = [];
  const value = {
    async send(input: { idempotencyKey: string }) {
      sent.push({ idempotencyKey: input.idempotencyKey });
      return options.send ?? { classification: 'success', providerMessageId: 'env-1',
        requestId: 'req-1', errorCategory: null };
    },
    async lookup(input: { idempotencyKey: string }) {
      lookedUp.push(input.idempotencyKey);
      return options.lookup ?? { classification: 'unknown', outcome: 'unknown', requestId: null,
        errorCategory: null };
    },
  };
  return { value, sent, lookedUp };
}

const renderers: EmailTemplateRenderers = createEmailTemplateRenderers();
const retryPolicy = createEmailDeliveryRetryPolicy({
  baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 3, jitterRatio: 0, random: () => 0,
});

test('P5-29 lost lease fences the attempt before any provider call', async () => {
  const { repository, calls } = memoryRepository({
    async loadAttempt(fence) {
      calls.push(`loadAttempt:${fence.attemptCount}`);
      return null;
    },
  });
  const provider = stubProvider();
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'lease_lost');
  assert.equal(provider.sent.length, 0);
  assert.equal(provider.lookedUp.length, 0);
  assert.deepEqual(calls, ['loadAttempt:1']);
});

test('P5-29 suppression recheck suppresses before send and records no durable fact', async () => {
  const { repository, calls } = memoryRepository({
    async readSuppressionFacts() { return { accountActive: true, emailEnabled: false,
      accountEmail: 'recipient@example.invalid', suppression: null }; },
  });
  const provider = stubProvider();
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(result.reason, 'email_disabled');
  assert.equal(provider.sent.length, 0);
  assert.ok(calls.includes('suppressDelivery'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')));
});

test('P5-29 mid-race disable between the recheck and the provider call suppresses with zero sends (m3)', async () => {
  // readSuppressionFacts is stateful: the claim-time recheck sees email
  // enabled, the pre-send recheck sees it disabled - the exact TOCTOU window
  // between the suppression recheck and the provider send.
  let factsReads = 0;
  const { repository, calls } = memoryRepository({
    async readSuppressionFacts() {
      factsReads += 1;
      calls.push('readSuppressionFacts');
      return factsReads === 1
        ? { accountActive: true, emailEnabled: true, accountEmail: 'recipient@example.invalid',
            suppression: null }
        : { accountActive: true, emailEnabled: false, accountEmail: 'recipient@example.invalid',
            suppression: null };
    },
  });
  const provider = stubProvider();
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(result.reason, 'email_disabled');
  assert.equal(provider.sent.length, 0,
    'a disable observed between the recheck and the provider call must never send');
  assert.equal(factsReads, 2, 'the pre-send recheck must re-read the suppression facts');
  assert.ok(calls.includes('suppressDelivery'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')));
});

test('P5-29 mid-race recheck helper returns null while sendable and suppresses when flipped', async () => {
  const sendable = await evaluateEmailSuppressionForAttempt(
    { readSuppressionFacts: async () => ({ accountActive: true, emailEnabled: true,
      accountEmail: 'a@example.invalid', suppression: null }),
      suppressDelivery: async () => true },
    { ...ATTEMPT }, { deliveryId: ATTEMPT.deliveryId, attemptCount: 1 });
  assert.equal(sendable, null);
  let suppressed = false;
  const flipped = await evaluateEmailSuppressionForAttempt(
    { readSuppressionFacts: async () => ({ accountActive: true, emailEnabled: false,
      accountEmail: 'a@example.invalid', suppression: null }),
      suppressDelivery: async () => { suppressed = true; return true; } },
    { ...ATTEMPT }, { deliveryId: ATTEMPT.deliveryId, attemptCount: 1 });
  assert.equal(flipped?.disposition, 'suppressed');
  assert.equal(flipped?.reason, 'email_disabled');
  assert.equal(suppressed, true);
});

test('P5-29 authority row missing mid-flight dead-letters as other with zero sends (N3)', async () => {
  const { repository, calls } = memoryRepository({
    async loadTemplateContext() { calls.push('loadTemplateContext:missing'); return null; },
  });
  const provider = stubProvider();
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'dead_letter');
  assert.equal(result.reason, 'authority_row_missing');
  assert.equal(result.errorCategory, 'other');
  assert.equal(provider.sent.length, 0);
  assert.equal(provider.lookedUp.length, 0);
  assert.ok(calls.some((call) => call === 'failDelivery:dead_letter:other'));
});

test('P5-29 missing recipient email dead-letters as invalid_contract without sending', async () => {
  const { repository, calls } = memoryRepository({
    async readSuppressionFacts() { return { accountActive: true, emailEnabled: true,
      accountEmail: null, suppression: null }; },
  });
  const provider = stubProvider();
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'dead_letter');
  assert.equal(result.errorCategory, 'invalid_contract');
  assert.equal(provider.sent.length, 0);
  assert.ok(calls.some((call) => call === 'failDelivery:dead_letter:invalid_contract'));
});

test('P5-29 successful send finalizes delivered with the stable provider key reused as idempotencyKey', async () => {
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ send: { classification: 'success',
    providerMessageId: 'env-1', requestId: 'req-1', errorCategory: null } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'delivered');
  assert.equal(provider.sent[0]?.idempotencyKey, 'delivery-1');
  assert.ok(calls.includes('completeDelivery'));
});

test('P5-29 retryable send schedules bounded backoff then dead-letters at max attempts', async () => {
  for (const attemptCount of [1, 2, 3]) {
    const { repository } = memoryRepository();
    const provider = stubProvider({ send: { classification: 'retryable',
      providerMessageId: null, requestId: null, errorCategory: 'provider_unavailable',
      redactedError: 'DirectMail request failed' } });
    const result = await processEmailDeliveryClaim({
      claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
        attemptCount },
      repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
    });
    if (attemptCount < 3) {
      assert.equal(result.disposition, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
    } else {
      assert.equal(result.disposition, 'dead_letter');
      assert.equal(result.errorCategory, 'retry_exhausted');
    }
  }
});

test('P5-29 permanent and unknown send outcomes dead-letter or retry with documented categories', async () => {
  const permanent = memoryRepository();
  const permanentProvider = stubProvider({ send: { classification: 'permanent',
    providerMessageId: null, requestId: null, errorCategory: 'invalid_contract',
    redactedError: 'DirectMail request failed: HTTP 400' } });
  assert.equal((await processEmailDeliveryClaim({ claim: { deliveryId: ATTEMPT.deliveryId,
    notificationId: 'n', recipientAccountId: 'r', attemptCount: 1 }, repository: permanent.repository,
  provider: permanentProvider.value, renderers, retryPolicy, now: () => NOW })).disposition,
  'dead_letter');

  const unknown = memoryRepository();
  const unknownProvider = stubProvider({ send: { classification: 'unknown',
    providerMessageId: null, requestId: null, errorCategory: 'other' } });
  const unknownResult = await processEmailDeliveryClaim({ claim: { deliveryId: ATTEMPT.deliveryId,
    notificationId: 'n', recipientAccountId: 'r', attemptCount: 1 }, repository: unknown.repository,
  provider: unknownProvider.value, renderers, retryPolicy, now: () => NOW });
  assert.equal(unknownResult.disposition, 'retryable');
  assert.equal(unknownResult.errorCategory, 'other');
  assert.ok(unknown.calls.includes('failDelivery:retryable:other'));
});

test('P5-29 stale final transition CAS never overwrites a newer attempt (lease_lost)', async () => {
  const scenarios: ReadonlyArray<{ name: string; repository: EmailDeliveryWorkerRepository;
    send?: EmailSendResult; suppressed?: boolean }> = [
    { name: 'completeDelivery', repository: memoryRepository({
      async completeDelivery() { return false; } }).repository },
    { name: 'failDelivery', repository: memoryRepository({
      async failDelivery() { return false; } }).repository,
    send: { classification: 'retryable', providerMessageId: null, requestId: null,
      errorCategory: 'provider_unavailable' } },
    { name: 'suppressDelivery', repository: memoryRepository({
      async readSuppressionFacts() { return { accountActive: true, emailEnabled: false,
        accountEmail: 'x@example.invalid', suppression: null }; },
      async suppressDelivery() { return false; } }).repository },
  ];
  for (const scenario of scenarios) {
    const provider = stubProvider(scenario.send ? { send: scenario.send } : {});
    const result = await processEmailDeliveryClaim({
      claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
        attemptCount: 1 },
      repository: scenario.repository, provider: provider.value, renderers, retryPolicy,
      now: () => NOW,
    });
    assert.equal(result.disposition, 'lease_lost', scenario.name);
  }
});

test('P5-29 retried attempts look up first and never re-send a known-delivered message', async () => {
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'success', outcome: 'delivered',
    requestId: 'req-lookup', errorCategory: null, errorClassification: 'SendOk' } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'delivered');
  assert.equal(result.reason, 'lookup_delivered');
  assert.equal(provider.sent.length, 0, 'a known-delivered message must not be re-sent');
  assert.deepEqual(provider.lookedUp, ['delivery-1']);
  assert.ok(calls.includes('completeDelivery'));
});

test('P5-29 lookup bounce on retry suppresses and records a durable suppression fact', async () => {
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'success', outcome: 'bounced',
    requestId: 'req-lookup', errorCategory: null } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(provider.sent.length, 0);
  assert.ok(calls.includes('recordSuppressionFact:bounce'));
  assert.ok(calls.includes('suppressDelivery'));
});

test('FIX-L-062: lookup suppression records the provider event time, not the reconcile clock', async () => {
  // The retry lookup resolves a definitive bounce with a reliable provider
  // event time (FIX-M-025 winner time). The durable fact must carry THAT
  // time - never the local reconcile clock - so an out-of-order old fact can
  // never masquerade as newer than a verified callback fact.
  const recorded: Date[] = [];
  const { repository, calls } = memoryRepository({
    async recordSuppressionFact(_recipient, source, occurredAt) {
      calls.push(`recordSuppressionFact:${source}`);
      recorded.push(occurredAt);
    },
  });
  const provider = stubProvider({ lookup: { classification: 'success', outcome: 'bounced',
    requestId: 'req-lookup', errorCategory: null, eventTimeMs: 1783036806000 } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(provider.sent.length, 0);
  assert.ok(calls.includes('recordSuppressionFact:bounce'));
  assert.deepEqual(recorded, [new Date(1783036806000)],
    'the durable fact must carry the lookup provider event time, not now()');
  assert.ok(calls.includes('suppressDelivery'));
});

test('FIX-L-062: lookup suppression without a provider event time falls back to the reconcile clock explicitly', async () => {
  // The lookup outcome is definitive but the winning row carried no reliable
  // provider time: the explicit documented fallback is the reconcile clock
  // (mirrors the callback path); it is never presented as a verified time.
  const recorded: Date[] = [];
  const { repository, calls } = memoryRepository({
    async recordSuppressionFact(_recipient, source, occurredAt) {
      calls.push(`recordSuppressionFact:${source}`);
      recorded.push(occurredAt);
    },
  });
  const provider = stubProvider({ lookup: { classification: 'success', outcome: 'complaint',
    requestId: 'req-lookup', errorCategory: null } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(provider.sent.length, 0);
  assert.ok(calls.includes('recordSuppressionFact:complaint'));
  assert.deepEqual(recorded, [NOW], 'the explicit fallback is the reconcile clock');
  assert.ok(calls.includes('suppressDelivery'));
});

test('P5-29 conflicting lookup facts dead-letter for manual review and never record a durable suppression fact', async () => {
  // FIX-M-025: the provider returned BOTH delivered and failure rows with no
  // provable event order. The worker must take NO irreversible action: no
  // recipient suppression from an unproven failure, no delivered completion
  // from an unproven success, and no re-send of a possibly-delivered message.
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'success', outcome: 'conflicting_facts',
    requestId: 'req-lookup', errorCategory: null } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'dead_letter');
  assert.equal(result.reason, 'lookup_conflicting_facts');
  assert.equal(result.errorCategory, 'other');
  assert.equal(provider.sent.length, 0, 'conflicting provider facts must never trigger a re-send');
  assert.deepEqual(provider.lookedUp, ['delivery-1']);
  assert.ok(calls.includes('failDelivery:dead_letter:other'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')),
    'an unproven failure row must never drive durable recipient suppression');
  assert.ok(!calls.includes('completeDelivery'),
    'an unproven delivered row must never complete the delivery');
});

// ---------------------------------------------------------------------------
// FIX-L-058: a lookup API ERROR must never be treated as "no delivery facts".
// A failed statistics call proves NOTHING about the previous attempt, so
// re-sending on an error could double-deliver a possibly-sent message. Errors
// take the same attempt-fenced transition as the send path and NEVER reach the
// provider send; only the documented benign unknown (successful response, no
// facts, errorCategory null = statistics lag) proceeds to send per the frozen
// strategy. An error is also NEVER recorded as a durable suppression fact.
// ---------------------------------------------------------------------------

test('FIX-L-058: retryable lookup failure backs off with the adapter category and never re-sends', async () => {
  const backoffs: Date[] = [];
  const { repository, calls } = memoryRepository({
    async failDelivery(_fence, input) {
      calls.push(`failDelivery:${input.deadLetter ? 'dead_letter' : 'retryable'}:${input.errorCategory ?? 'null'}`);
      backoffs.push(input.nextAttemptAt);
      return true;
    },
  });
  const provider = stubProvider({ lookup: { classification: 'retryable', outcome: 'unknown',
    requestId: null, errorCategory: 'provider_unavailable',
    redactedError: 'DirectMail request failed: timeout' } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'retryable');
  assert.equal(result.reason, 'lookup_retryable_error');
  assert.equal(result.errorCategory, 'provider_unavailable');
  assert.equal(provider.sent.length, 0,
    'a failed lookup must never trigger a re-send (the stats outage proves nothing)');
  assert.deepEqual(provider.lookedUp, ['delivery-1']);
  assert.ok(calls.includes('failDelivery:retryable:provider_unavailable'));
  assert.deepEqual(backoffs, [new Date(NOW.getTime() + 2_000)],
    'the retryable lookup failure must carry the policy backoff for the failed attempt');
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')),
    'a lookup API error must never be recorded as a durable suppression fact');
});

test('FIX-L-058: retryable lookup failure at max attempts dead-letters retry_exhausted without a re-send', async () => {
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'retryable', outcome: 'unknown',
    requestId: null, errorCategory: 'dependency' } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 3 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'dead_letter');
  assert.equal(result.reason, 'lookup_retry_exhausted');
  assert.equal(result.errorCategory, 'retry_exhausted');
  assert.equal(provider.sent.length, 0,
    'a lookup error at max attempts must dead-letter, never re-send');
  assert.ok(calls.includes('failDelivery:dead_letter:retry_exhausted'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')));
});

test('FIX-L-058: permanent lookup failure (invalid contract) dead-letters for review without a re-send', async () => {
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'permanent', outcome: 'unknown',
    requestId: null, errorCategory: 'invalid_contract',
    redactedError: 'DirectMail request failed: HTTP 403 SignatureDoesNotMatch' } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'dead_letter');
  assert.equal(result.reason, 'lookup_permanent_error');
  assert.equal(result.errorCategory, 'invalid_contract');
  assert.equal(provider.sent.length, 0,
    'a permanent lookup failure must never trigger a re-send');
  assert.ok(calls.includes('failDelivery:dead_letter:invalid_contract'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')),
    'a permanent lookup failure must never be recorded as a durable suppression fact');
});

test('FIX-L-058: malformed 2xx lookup body (unknown with an error category) backs off and never re-sends', async () => {
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'unknown', outcome: 'unknown',
    requestId: null, errorCategory: 'other',
    redactedError: 'SenderStatisticsDetailByParam response is malformed' } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'retryable');
  assert.equal(result.reason, 'lookup_retryable_error');
  assert.equal(result.errorCategory, 'other');
  assert.equal(provider.sent.length, 0,
    'a malformed statistics response must never trigger a re-send');
  assert.ok(calls.includes('failDelivery:retryable:other'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')),
    'a malformed statistics response must never be recorded as a durable suppression fact');
});

test('FIX-L-058: benign unknown lookup (statistics lag) proceeds to send per the explicit strategy', async () => {
  // The ONLY lookup case that may reach the provider send: a successful
  // statistics response with no facts and NO error (errorCategory null) -
  // statistics may lag after send. That is not an error, so the frozen
  // strategy proceeds to send (the row's attempt fence still bounds retries).
  const { repository, calls } = memoryRepository();
  const provider = stubProvider({ lookup: { classification: 'unknown', outcome: 'unknown',
    requestId: null, errorCategory: null } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'delivered');
  assert.equal(provider.sent.length, 1,
    'statistics lag (no facts, no error) must proceed to send');
  assert.deepEqual(provider.lookedUp, ['delivery-1']);
  assert.ok(calls.includes('completeDelivery'));
});

test('P5-29 aborted claim never sends and never finalizes (lease expires naturally)', async () => {
  const { repository } = memoryRepository();
  const controller = new AbortController();
  controller.abort(new Error('worker stopping'));
  const provider = stubProvider();
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 1 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
    signal: controller.signal,
  });
  assert.equal(result.disposition, 'lease_lost');
  assert.equal(provider.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Callback reconciliation mapping.
// ---------------------------------------------------------------------------

function callbackRepository(rows: Array<Record<string, unknown>> = [], options: {
  readonly applyResult?: boolean;
} = {}) {
  const calls: string[] = [];
  const suppressionFactTimes: Date[] = [];
  const transitions: Array<Record<string, unknown>> = [];
  const repository: EmailCallbackReconcilerRepository = {
    async resolveDeliveryForCallback() {
      calls.push('resolveDeliveryForCallback');
      const row = rows.shift();
      return row ? row as never : null;
    },
    async resolveSuppressionRecipient(recipientEmail) {
      calls.push(`resolveSuppressionRecipient:${recipientEmail}`);
      return recipientEmail === 'P529_CALLBACK_RECIPIENT@example.invalid' ? 'recipient-1' : null;
    },
    async recordSuppressionFact(_recipient, source, occurredAt) {
      calls.push(`recordSuppressionFact:${source}`);
      suppressionFactTimes.push(occurredAt);
    },
    async applyCallbackTransition(input) {
      calls.push('applyCallbackTransition');
      transitions.push({ ...input });
      return options.applyResult ?? true;
    },
  };
  return { repository, calls, suppressionFactTimes, transitions };
}

function leasedRow(overrides: Record<string, unknown> = {}) {
  return { deliveryId: 'delivery-1', notificationId: 'notification-1',
    recipientAccountId: 'recipient-1', state: 'leased', attemptCount: 1, stateRevision: '3',
    leasedUntil: new Date(NOW.getTime() + 30_000), ...overrides };
}

test('P5-29 callback reconciliation maps every verified fact kind to a delivery transition', async () => {
  const cases: ReadonlyArray<{ fact: EmailCallbackFact; expectedDisposition: string;
    expectSuppression: boolean; expectedSource: string | null }> = [
    { fact: { kind: 'delivered', providerMessageId: 'env-1', tag: 'p529-delivery-1' },
      expectedDisposition: 'delivered', expectSuppression: false, expectedSource: null },
    { fact: { kind: 'bounced', providerMessageId: 'env-2', tag: 'p529-delivery-1' },
      expectedDisposition: 'suppressed', expectSuppression: true, expectedSource: 'bounce' },
    { fact: { kind: 'complaint', providerMessageId: 'env-3', tag: 'p529-delivery-1' },
      expectedDisposition: 'suppressed', expectSuppression: true, expectedSource: 'complaint' },
    { fact: { kind: 'unsubscribed', providerMessageId: 'env-4', tag: 'p529-delivery-1' },
      expectedDisposition: 'suppressed', expectSuppression: true, expectedSource: 'unsubscribe' },
    { fact: { kind: 'subscribed', providerMessageId: 'env-5', tag: 'p529-delivery-1' },
      expectedDisposition: 'noop', expectSuppression: false, expectedSource: null },
    { fact: { kind: 'open', providerMessageId: 'env-6', tag: 'p529-delivery-1' },
      expectedDisposition: 'noop', expectSuppression: false, expectedSource: null },
    { fact: { kind: 'click', providerMessageId: 'env-7', tag: 'p529-delivery-1' },
      expectedDisposition: 'noop', expectSuppression: false, expectedSource: null },
  ];
  for (const scenario of cases) {
    const { repository, calls } = callbackRepository([leasedRow()]);
    const result = await reconcileEmailCallback({
      fact: scenario.fact, repository, tagPrefix: 'p529-', now: () => NOW,
    });
    assert.equal(result.disposition, scenario.expectedDisposition, scenario.fact.kind);
    assert.equal(result.deliveryTransitioned, scenario.expectedDisposition !== 'noop', scenario.fact.kind);
    assert.equal(result.suppressionRecorded, scenario.expectSuppression, scenario.fact.kind);
    if (scenario.expectedSource) {
      assert.ok(calls.includes(`recordSuppressionFact:${scenario.expectedSource}`), scenario.fact.kind);
    }
  }
});

test('P5-29 complaint reconciliation records the durable fact at the FblReport block_time, not now()', async () => {
  // The REAL FblReport pipeline maps block_email -> recipient,
  // message_id -> providerMessageId and block_time -> occurredAt (UNIX epoch
  // seconds). Reconciliation must persist the complaint time, never a
  // fabricated now().
  // Resolvable delivery: the row's recipientAccountId wins, the fact records
  // block_time and the row transitions to suppressed.
  const resolvable = callbackRepository([leasedRow()]);
  const first = await reconcileEmailCallback({
    fact: { kind: 'complaint', recipient: 'P529_CALLBACK_RECIPIENT@example.invalid',
      providerMessageId: '<fixture-msg-3@example.invalid>', occurredAt: '1783036806' },
    repository: resolvable.repository, tagPrefix: 'p529-', now: () => NOW,
  });
  assert.equal(first.suppressionRecorded, true);
  assert.equal(first.deliveryTransitioned, true);
  assert.ok(resolvable.calls.includes('recordSuppressionFact:complaint'));
  assert.deepEqual(resolvable.suppressionFactTimes, [new Date(1783036806 * 1000)],
    'the suppression fact must carry the complaint block_time, not now()');
  assert.ok(!resolvable.calls.some((call) => call.startsWith('resolveSuppressionRecipient')),
    'a resolvable delivery supplies the account id without an email lookup');
  // No matching delivery: block_email -> account resolution still records the
  // durable fact at block_time (the FblReport complaint is never dropped).
  const unresolved = callbackRepository([]);
  const second = await reconcileEmailCallback({
    fact: { kind: 'complaint', recipient: 'P529_CALLBACK_RECIPIENT@example.invalid',
      providerMessageId: '<fixture-msg-3@example.invalid>', occurredAt: '1783036806' },
    repository: unresolved.repository, tagPrefix: 'p529-', now: () => NOW,
  });
  assert.equal(second.suppressionRecorded, true);
  assert.equal(second.deliveryTransitioned, false);
  assert.ok(unresolved.calls.includes('resolveSuppressionRecipient:P529_CALLBACK_RECIPIENT@example.invalid'),
    'a complaint fact with a recipient must resolve the suppression recipient by email');
  assert.deepEqual(unresolved.suppressionFactTimes, [new Date(1783036806 * 1000)],
    'the email-resolved complaint fact must also carry the block_time');
});

test('P5-29 suppression fact falls back to now() when the callback carries no parseable occurredAt', async () => {
  const { repository, suppressionFactTimes } = callbackRepository([leasedRow()]);
  const result = await reconcileEmailCallback({
    fact: { kind: 'bounced', providerMessageId: 'env-2', tag: 'p529-delivery-1' },
    repository, tagPrefix: 'p529-', now: () => NOW,
  });
  assert.equal(result.suppressionRecorded, true);
  assert.deepEqual(suppressionFactTimes, [NOW]);
});

test('parseCallbackOccurredAt handles ISO-8601 and UNIX epoch seconds/milliseconds', () => {
  assert.deepEqual(parseCallbackOccurredAt('1783036806'), new Date(1783036806 * 1000),
    'UNIX epoch seconds (FblReport block_time/send_time) must parse');
  assert.deepEqual(parseCallbackOccurredAt('1783036806000'), new Date(1783036806000),
    'UNIX epoch milliseconds must parse');
  assert.deepEqual(parseCallbackOccurredAt('2026-08-02T00:00:12'), new Date('2026-08-02T00:00:12'),
    'ISO-8601 date-time (deliver/operate events) must parse');
  assert.equal(parseCallbackOccurredAt(undefined), null);
  assert.equal(parseCallbackOccurredAt('not-a-time'), null);
});

test('P5-29 delivered callback re-arms a dead-lettered delivery and persists the delivered-confirmed marker', async () => {
  const { repository, calls, transitions } = callbackRepository([leasedRow({ state: 'dead_letter',
    attemptCount: 3 })]);
  const result = await reconcileEmailCallback({ fact: { kind: 'delivered',
    providerMessageId: 'env-late', tag: 'p529-delivery-1' }, repository, tagPrefix: 'p529-',
  now: () => NOW });
  assert.equal(result.disposition, 'delivered');
  assert.ok(calls.includes('applyCallbackTransition'));
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')));
  assert.equal(transitions[0]?.nextState, 'retryable',
    'the re-arm must stay a legal dead_letter -> retryable transition under the guard');
  assert.equal(transitions[0]?.providerMessageId, 'env-late',
    'the verified delivered callback must persist its provider message id as the delivered-confirmed marker');
});

test('P5-29 re-armed dead-letter row completes delivered on a lookup MISS without any provider call', async () => {
  // The dead_letter row was re-armed by a verified delivered callback, so the
  // claimed attempt carries the persisted provider message id (marker). The
  // lookup returns NO definitive fact (SenderStatisticsDetailByParam lag or
  // 30-day retention); without the marker the claim would proceed to SEND.
  const { repository, calls } = memoryRepository({
    async loadAttempt(fence) {
      calls.push(`loadAttempt:${fence.attemptCount}`);
      return { ...ATTEMPT, attemptCount: fence.attemptCount, providerMessageId: 'env-late' };
    },
  });
  const provider = stubProvider({ lookup: { classification: 'unknown', outcome: 'unknown',
    requestId: null, errorCategory: null } });
  const result = await processEmailDeliveryClaim({
    claim: { deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
      attemptCount: 2 },
    repository, provider: provider.value, renderers, retryPolicy, now: () => NOW,
  });
  assert.equal(result.disposition, 'delivered');
  assert.equal(result.reason, 'callback_delivered_confirmed');
  assert.equal(provider.sent.length, 0,
    'a delivery confirmed delivered by a verified callback must never be re-sent');
  assert.equal(provider.lookedUp.length, 0,
    'the persisted marker must finalize WITHOUT relying on the lookup');
  assert.ok(calls.includes('completeDelivery'));
  assert.ok(!calls.some((call) => call.startsWith('readSuppressionFacts')
    || call.startsWith('loadTemplateContext')),
  'the delivered-confirmed marker outranks the suppression recheck (delivery already happened)');
});

test('P5-29 delivered callback without a provider message id never re-arms a dead-lettered row', async () => {
  // A re-arm without a persisted marker would reopen the re-send hole on a
  // lookup miss; dead_letter must stay terminal so a re-send can never occur.
  const { repository, calls } = callbackRepository([leasedRow({ state: 'dead_letter',
    attemptCount: 3 })]);
  const result = await reconcileEmailCallback({ fact: { kind: 'delivered',
    tag: 'p529-delivery-1' }, repository, tagPrefix: 'p529-', now: () => NOW });
  assert.equal(result.disposition, 'noop');
  assert.equal(result.deliveryTransitioned, false);
  assert.ok(!calls.includes('applyCallbackTransition'),
    'an id-less delivered callback must not re-arm a dead-lettered row');
});

test('FIX-M-028: a verified delivered callback finalizes a retryable row delivered and persists the marker', async () => {
  // The send succeeded but the final leased->delivered CAS lost the lease, so
  // the row fell back to retryable (attempt 1) and the next claim would run
  // the retry lookup first - with statistics lag it would RE-SEND. The
  // verified delivered callback is authoritative evidence the provider
  // accepted the message: it must finalize retryable -> delivered NOW and
  // persist the callback's provider message id (delivered-confirmed marker).
  const { repository, calls, transitions } = callbackRepository([leasedRow({
    state: 'retryable', attemptCount: 1, leasedUntil: null })]);
  const result = await reconcileEmailCallback({ fact: { kind: 'delivered',
    providerMessageId: 'env-late', tag: 'p529-delivery-1' }, repository, tagPrefix: 'p529-',
  now: () => NOW });
  assert.equal(result.disposition, 'delivered');
  assert.equal(result.deliveryTransitioned, true);
  assert.ok(!calls.some((call) => call.startsWith('recordSuppressionFact')));
  assert.equal(transitions[0]?.expectedState, 'retryable');
  assert.equal(transitions[0]?.nextState, 'delivered',
    'the retryable row must be finalized delivered directly, not re-armed');
  assert.equal(transitions[0]?.expectedAttemptCount, 1,
    'the retryable -> delivered CAS must bind the row attempt count');
  assert.equal(transitions[0]?.expectedStateRevision, '3',
    'the retryable -> delivered CAS must bind the row state revision');
  assert.equal(transitions[0]?.providerMessageId, 'env-late',
    'the verified delivered callback must persist its provider message id as the delivered-confirmed marker');
});

test('FIX-M-028: retryable delivered-callback replay is idempotent and a refused CAS never overwrites', async () => {
  // A second delivered callback after the row is already delivered must be a
  // no-op (CAS on state='retryable' no longer matches), and a stale fence
  // whose CAS is refused must never mutate the row.
  const replay = callbackRepository([leasedRow({ state: 'delivered' })]);
  const second = await reconcileEmailCallback({ fact: { kind: 'delivered',
    providerMessageId: 'env-late', tag: 'p529-delivery-1' }, repository: replay.repository,
  tagPrefix: 'p529-', now: () => NOW });
  assert.equal(second.disposition, 'noop');
  assert.equal(second.deliveryTransitioned, false,
    'callback replay on the terminal row must be idempotent');
  assert.ok(!replay.calls.includes('applyCallbackTransition'));

  const refused = callbackRepository([leasedRow({ state: 'retryable', attemptCount: 1,
    leasedUntil: null })], { applyResult: false });
  const first = await reconcileEmailCallback({ fact: { kind: 'delivered',
    providerMessageId: 'env-late', tag: 'p529-delivery-1' }, repository: refused.repository,
  tagPrefix: 'p529-', now: () => NOW });
  assert.equal(first.deliveryTransitioned, false, 'a stale fence must not overwrite');
  assert.equal(first.disposition, 'noop');
});

test('FIX-M-028: a bounce callback on a retryable row still suppresses (delivered finalization must not hijack suppression)', async () => {
  // The delivered finalization is a delivered-only branch: a suppression
  // callback on the same retryable row must still transition retryable ->
  // suppressed and record the durable fact.
  const { repository, calls, transitions } = callbackRepository([leasedRow({
    state: 'retryable', attemptCount: 1, leasedUntil: null })]);
  const result = await reconcileEmailCallback({ fact: { kind: 'bounced',
    providerMessageId: 'env-2', tag: 'p529-delivery-1' }, repository, tagPrefix: 'p529-',
  now: () => NOW });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(result.deliveryTransitioned, true);
  assert.equal(transitions[0]?.expectedState, 'retryable');
  assert.equal(transitions[0]?.nextState, 'suppressed',
    'a suppression callback must not be hijacked by the retryable delivered finalization');
  assert.ok(calls.includes('recordSuppressionFact:bounce'));
});

test('P5-29 callback replay is idempotent and a failed fence never overwrites newer state', async () => {
  const stale = callbackRepository([leasedRow()], { applyResult: false });
  const first = await reconcileEmailCallback({ fact: { kind: 'bounced',
    providerMessageId: 'env-2', tag: 'p529-delivery-1' }, repository: stale.repository,
  tagPrefix: 'p529-', now: () => NOW });
  assert.equal(first.deliveryTransitioned, false, 'stale fence must not overwrite');
  assert.equal(first.suppressionRecorded, true);

  const replay = callbackRepository([leasedRow({ state: 'suppressed' })]);
  const second = await reconcileEmailCallback({ fact: { kind: 'bounced',
    providerMessageId: 'env-2', tag: 'p529-delivery-1' }, repository: replay.repository,
  tagPrefix: 'p529-', now: () => NOW });
  assert.equal(second.disposition, 'suppressed');
  assert.equal(second.deliveryTransitioned, false);
});

test('P5-29 suppression facts are recorded even when no delivery row matches, never creating rows', async () => {
  const { repository, calls } = callbackRepository([]);
  const result = await reconcileEmailCallback({ fact: { kind: 'unsubscribed',
    recipient: 'P529_CALLBACK_RECIPIENT@example.invalid' }, repository, tagPrefix: 'p529-',
  now: () => NOW });
  assert.equal(result.disposition, 'suppressed');
  assert.equal(result.deliveryId, null);
  assert.equal(result.suppressionRecorded, true);
  assert.ok(calls.includes('recordSuppressionFact:unsubscribe'));
  assert.ok(calls.includes('resolveSuppressionRecipient:P529_CALLBACK_RECIPIENT@example.invalid'));
  assert.ok(!calls.includes('applyCallbackTransition'));
});

test('P5-29 delivered callback for an un-sent delivery is a no-op (send authority stays with the worker)', async () => {
  const { repository, calls } = callbackRepository([leasedRow({ state: 'pending' })]);
  const result = await reconcileEmailCallback({ fact: { kind: 'delivered',
    providerMessageId: 'env-x', tag: 'p529-delivery-1' }, repository, tagPrefix: 'p529-',
  now: () => NOW });
  assert.equal(result.disposition, 'noop');
  assert.equal(result.deliveryTransitioned, false);
  assert.ok(!calls.includes('applyCallbackTransition'));
});

test('P5-29 callback tag is stripped by the configured prefix before resolving the delivery', async () => {
  const { repository, calls } = callbackRepository([leasedRow()]);
  await reconcileEmailCallback({ fact: { kind: 'delivered', tag: 'p529-delivery-1' },
    repository, tagPrefix: 'p529-', now: () => NOW });
  assert.equal(calls[0], 'resolveDeliveryForCallback');
});

// m1: the production PostgreSQL repository must keep last_error_category
// accurate per state semantics. This static contract test pins the SQL so a
// future repository change cannot silently reintroduce stale categories; the
// real-PostgreSQL behavior is asserted in
// tests/integration/notifications/email-delivery-worker-postgres.integration.test.ts.
test('m1: repository SQL clears last_error_category on claim and every suppression path, keeps it on dead_letter re-arm', () => {
  const source = readFileSync(new URL(
    '../../../src/infrastructure/notifications/email-delivery-worker-postgres.ts', import.meta.url), 'utf8');
  const claim = source.match(/update notification_deliveries delivery[\s\S]*?returning delivery\.delivery_id/);
  assert.ok(claim, 'claimDue UPDATE must exist');
  assert.match(claim![0], /last_error_category=null/u,
    'claimDue must clear the stale category when a retryable row is re-claimed (m1)');
  assert.match(source, /set state='suppressed', state_revision=state_revision\+1, leased_until=null,\r?\n\s*suppressed_at=current_timestamp, last_error_category=null/u,
    'suppressDelivery must clear last_error_category (m1)');
  assert.match(source, /when \$3 in \('delivered','suppressed'\) then null/u,
    'callback leased->suppressed/delivered must clear last_error_category (m1)');
  assert.match(source, /set state='suppressed', state_revision=state_revision\+1, suppressed_at=current_timestamp,\r?\n\s*leased_until=null, last_error_category=null, updated_at=current_timestamp\r?\n\s*where delivery_id=\$1 and channel='email' and state=\$2 and state_revision=\$3/u,
    'callback pending|retryable->suppressed must clear last_error_category (m1)');
  // The dead_letter -> retryable re-arm keeps the category: the P5-25/29
  // trigger requires same attempt_count AND same last_error_category.
  const rearm = source.match(/update notification_deliveries\r?\n\s*set state='retryable',[\s\S]*?state='dead_letter'\r?\n\s*and state_revision=\$3/);
  assert.ok(rearm, 'dead_letter re-arm UPDATE must exist');
  assert.doesNotMatch(rearm![0], /last_error_category/u,
    'the dead_letter re-arm must KEEP last_error_category (trigger guard, m1)');
});

// FIX-M-028: the retryable -> delivered callback write is terminal error-free:
// it must clear the stale failure category (m1) and fence the CAS on the
// attempt count, and the transition guard must allow the new transition. This
// static contract test pins the SQL/migration so a future repository or guard
// change cannot silently reopen the re-send hole (real-PostgreSQL behavior is
// asserted in the integration suite).
test('FIX-M-028: repository SQL clears last_error_category and fences the retryable->delivered CAS on attempt_count', () => {
  const source = readFileSync(new URL(
    '../../../src/infrastructure/notifications/email-delivery-worker-postgres.ts', import.meta.url), 'utf8');
  const write = source.match(/update notification_deliveries\r?\n\s*set state='delivered',[\s\S]*?state='retryable' and attempt_count=\$2[\s\S]*?state_revision=\$3/);
  assert.ok(write, 'retryable -> delivered callback UPDATE must exist');
  assert.match(source, /if \(input\.expectedState === 'retryable' && input\.nextState === 'delivered'\)/u,
    'the delivered finalization branch must NOT hijack retryable suppression callbacks');
  assert.match(write![0], /last_error_category=null/u,
    'the retryable -> delivered callback write must clear the stale category (m1)');
  assert.match(write![0], /provider_message_id=coalesce\(\$4, provider_message_id\)/u,
    'the write must persist the callback provider message id as the delivered-confirmed marker');
  assert.match(write![0], /delivered_at=current_timestamp/u,
    'the write must set delivered_at on the terminal row');

  const migration = readFileSync(new URL(
    '../../../migrations/202608220100_delivery_callback_retryable_delivered.ts', import.meta.url), 'utf8');
  const branch = migration.match(/OLD\.state='retryable' and NEW\.state='delivered'[\s\S]*?NEW\.last_error_category is null/);
  assert.ok(branch, 'the transition guard must allow the retryable -> delivered callback finalization');
  assert.match(branch![0], /NEW\.attempt_count = OLD\.attempt_count/u,
    'the guard branch must bind the attempt count (callback CAS fence)');
  assert.match(branch![0], /NEW\.last_error_category is null/u,
    'the guard branch must require the cleared category (m1)');
});

// ---------------------------------------------------------------------------
// FIX-M-026: unclassified process-phase exceptions (repository / renderer /
// provider throws) must be bounded: retryable+backoff below maxAttempts,
// dead_letter retry_exhausted at/above it, heartbeat/lease_lost classified
// separately so the old owner never writes.
// ---------------------------------------------------------------------------

test('FIX-M-026: unclassified processing errors map to the stable sanitized other category with bounded transitions', () => {
  const policy = createEmailDeliveryRetryPolicy({
    baseDelayMs: 1_000, maxDelayMs: 4_000, maxAttempts: 3, jitterRatio: 0, random: () => 0,
  });
  // The category must never vary with the error text (PII/secrets stay out of
  // the row and the ops tally); only the attempt fence decides the transition.
  // attempt 1 -> retryable 'other' with policy backoff; attempt 3 (= max) ->
  // dead_letter retry_exhausted; an unknown provider send outcome is never
  // hastily dead-lettered below max (the retry reconciles via lookup first).
  for (const error of [new Error('DirectMail request failed: password=supersecret token=abc123'),
    'plain string failure', { code: 'ECONNREFUSED' }, undefined]) {
    assert.deepEqual(decideEmailProcessingFailure({ error, attemptCount: 1,
      retryPolicy: policy, now: NOW }),
    { disposition: 'retryable', errorCategory: 'other',
      nextAttemptAt: new Date(NOW.getTime() + 1_000) });
    assert.deepEqual(decideEmailProcessingFailure({ error, attemptCount: 2,
      retryPolicy: policy, now: NOW }),
    { disposition: 'retryable', errorCategory: 'other',
      nextAttemptAt: new Date(NOW.getTime() + 2_000) });
    assert.deepEqual(decideEmailProcessingFailure({ error, attemptCount: 3,
      retryPolicy: policy, now: NOW }),
    { disposition: 'dead_letter', errorCategory: 'retry_exhausted', nextAttemptAt: null });
  }
});

// ---------------------------------------------------------------------------
// The production loop catch: every live claim must end in the single
// attempt-fenced failDelivery, so a poisoned delivery can never churn lease
// takeovers with an unbounded attempt_count.
// ---------------------------------------------------------------------------

const LOOP_RETRY_POLICY = createEmailDeliveryRetryPolicy({
  baseDelayMs: 1_000, maxDelayMs: 1_000, maxAttempts: 3, jitterRatio: 0, random: () => 0,
});

function loopProvider(): { provider: EmailProviderAdapter; sent: string[]; lookedUp: string[] } {
  const sent: string[] = [];
  const lookedUp: string[] = [];
  const provider: EmailProviderAdapter = {
    async send(input) {
      sent.push(input.idempotencyKey);
      return { classification: 'success', providerMessageId: 'env-1',
        requestId: 'req-1', errorCategory: null };
    },
    async lookup(input) {
      lookedUp.push(input.idempotencyKey);
      return { classification: 'unknown', outcome: 'unknown', requestId: null,
        errorCategory: null };
    },
    async verifyCallback() { throw new Error('FIX-M-026 unit stub: no callback verification'); },
    async close() {},
  };
  return { provider, sent, lookedUp };
}

function loopHarness(options: {
  readonly attemptCount?: number;
  readonly repositoryOverrides?: Partial<EmailDeliveryWorkerRepository>;
  readonly provider?: EmailProviderAdapter;
  readonly renderers?: EmailTemplateRenderers;
  readonly heartbeatResult?: boolean;
  readonly failDeliveryResult?: boolean;
} = {}) {
  const metrics = new InMemoryMetrics();
  const logs: Array<{ level: string; bindings: object; message: string }> = [];
  const failInputs: Array<{ nextAttemptAt: Date;
    errorCategory: EmailDeliveryErrorCategory | null; deadLetter: boolean }> = [];
  let due = true;
  let resolveHeartbeatFired!: () => void;
  const heartbeatFiredPromise = new Promise<void>((resolve) => { resolveHeartbeatFired = resolve; });
  const repository: EmailDeliveryWorkerRepository & EmailCallbackReconcilerRepository = {
    async claimDue() {
      if (!due) return [];
      due = false;
      return [{ deliveryId: ATTEMPT.deliveryId, notificationId: 'n', recipientAccountId: 'r',
        attemptCount: options.attemptCount ?? 1 }];
    },
    async heartbeat() {
      resolveHeartbeatFired();
      return options.heartbeatResult ?? true;
    },
    async loadAttempt(fence) {
      return { ...ATTEMPT, attemptCount: fence.attemptCount };
    },
    async readSuppressionFacts() {
      return { accountActive: true, emailEnabled: true, accountEmail: 'recipient@example.invalid',
        suppression: null };
    },
    async loadTemplateContext() { return followContext(); },
    async recordSuppressionFact() {},
    async completeDelivery() { return true; },
    async failDelivery(_fence, input) {
      failInputs.push({ ...input });
      return options.failDeliveryResult ?? true;
    },
    async suppressDelivery() { return true; },
    async resolveDeliveryForCallback() { return null; },
    async resolveSuppressionRecipient() { return null; },
    async applyCallbackTransition() { return false; },
    ...options.repositoryOverrides,
  };
  const loop = new EmailDeliveryWorkerLoop({
    repository,
    provider: options.provider ?? loopProvider().provider,
    renderers: options.renderers,
    logger: {
      info(bindings, message) { logs.push({ level: 'info', bindings, message }); },
      warn(bindings, message) { logs.push({ level: 'warn', bindings, message }); },
      error(bindings, message) { logs.push({ level: 'error', bindings, message }); },
    },
    metrics,
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 5,
    pollIntervalMs: 100,
    batchSize: 4,
    retryPolicy: LOOP_RETRY_POLICY,
  });
  return { loop, metrics, logs, failInputs, heartbeatFiredPromise };
}

test('FIX-M-026: each process phase throwing (suppression read/template/render/lookup/send) retries with backoff then dead-letters at maxAttempts', async () => {
  const phases: ReadonlyArray<{ name: string; attemptCount: number;
    overrides?: Partial<EmailDeliveryWorkerRepository>;
    provider?: EmailProviderAdapter; renderers?: EmailTemplateRenderers }> = [
    { name: 'suppression-read', attemptCount: 1,
      overrides: { readSuppressionFacts: async () => { throw new Error('FIX-M-026 suppression read'); } } },
    { name: 'template-load', attemptCount: 1,
      overrides: { loadTemplateContext: async () => { throw new Error('FIX-M-026 template load'); } } },
    { name: 'render', attemptCount: 1,
      renderers: { render: () => { throw new Error('FIX-M-026 render'); } } },
    { name: 'lookup', attemptCount: 2, provider: (() => {
      const stub = loopProvider();
      stub.provider.lookup = async () => { throw new Error('FIX-M-026 lookup'); };
      return stub.provider;
    })() },
    { name: 'send', attemptCount: 1, provider: (() => {
      const stub = loopProvider();
      stub.provider.send = async () => { throw new Error('FIX-M-026 send'); };
      return stub.provider;
    })() },
  ];
  for (const phase of phases) {
    for (const attemptCount of [phase.attemptCount, LOOP_RETRY_POLICY.maxAttempts]) {
      const harness = loopHarness({ attemptCount, repositoryOverrides: phase.overrides,
        provider: phase.provider, renderers: phase.renderers });
      const receivedAt = Date.now();
      await harness.loop.runOnce();
      assert.equal(harness.failInputs.length, 1, phase.name);
      const input = harness.failInputs[0]!;
      if (attemptCount >= LOOP_RETRY_POLICY.maxAttempts) {
        assert.equal(input.deadLetter, true, phase.name);
        assert.equal(input.errorCategory, 'retry_exhausted', phase.name);
        assert.equal(harness.metrics.get('notifications.email_delivery.dead_letter'), 1, phase.name);
      } else {
        assert.equal(input.deadLetter, false, phase.name);
        assert.equal(input.errorCategory, 'other', phase.name);
        assert.ok(input.nextAttemptAt.getTime() >= receivedAt + 500
          && input.nextAttemptAt.getTime() <= receivedAt + 1_500,
        `${phase.name}: the retryable write must carry the policy backoff`);
        assert.equal(harness.metrics.get('notifications.email_delivery.retryable'), 1, phase.name);
      }
      assert.equal(harness.metrics.get('notifications.email_delivery.error'), 1, phase.name);
      assert.equal(harness.metrics.get('notifications.email_delivery.lease_lost'), 0, phase.name);
      assert.equal(harness.metrics.get('notifications.email_delivery.delivered'), 0, phase.name);
    }
  }
});

test('FIX-M-026: heartbeat/lease_lost is classified separately - the old owner never writes after losing the lease', async () => {
  let releaseProcessing!: () => void;
  const processingGate = new Promise<void>((resolve) => { releaseProcessing = resolve; });
  const harness = loopHarness({
    attemptCount: 1,
    heartbeatResult: false,
    repositoryOverrides: {
      async readSuppressionFacts() {
        await processingGate;
        throw new Error('FIX-M-026 processing failure after lease loss');
      },
    },
  });
  const runPromise = harness.loop.runOnce();
  await harness.heartbeatFiredPromise;
  // Let the already-settled heartbeat continuation record lease loss before
  // releasing the processing gate; no wall-clock timing is involved.
  await yieldToEventLoop();
  releaseProcessing();
  await runPromise;
  assert.equal(harness.failInputs.length, 0,
    'a lease-lost claim must never write retryable/dead_letter (no stale-owner update)');
  assert.equal(harness.metrics.get('notifications.email_delivery.heartbeat_lost'), 1);
  assert.equal(harness.metrics.get('notifications.email_delivery.lease_lost'), 1);
  assert.equal(harness.metrics.get('notifications.email_delivery.retryable'), 0);
  assert.equal(harness.metrics.get('notifications.email_delivery.dead_letter'), 0);
});

test('FIX-M-026: a failed failDelivery CAS (newer owner) reports lease_lost and never loops or overwrites', async () => {
  // The catch must be reached: poison the provider send so the maxAttempts
  // claim fails and the loop's catch attempts the dead_letter write. The
  // refused CAS (newer owner) then reports lease_lost, never dead_letter, and
  // the same pass must not re-offer the row.
  const poisoned = loopProvider();
  poisoned.provider.send = async () => { throw new Error('FIX-M-026 send'); };
  const harness = loopHarness({ attemptCount: LOOP_RETRY_POLICY.maxAttempts,
    provider: poisoned.provider, failDeliveryResult: false });
  await harness.loop.runOnce();
  assert.equal(harness.failInputs.length, 1);
  assert.equal(harness.failInputs[0]?.deadLetter, true,
    'the catch must attempt the maxAttempts dead_letter write exactly once');
  assert.equal(harness.metrics.get('notifications.email_delivery.lease_lost'), 1,
    'a refused CAS must report lease_lost, never dead_letter');
  assert.equal(harness.metrics.get('notifications.email_delivery.dead_letter'), 0);
  // The refused CAS ends the claim: the same pass must not re-offer the row.
  assert.equal(await harness.loop.runOnce(), false, 'claimDue must not re-offer the row');
});

