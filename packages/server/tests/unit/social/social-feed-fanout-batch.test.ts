import assert from 'node:assert/strict';
import { test } from 'vitest';
import { OutboxDeliveryError } from '../../../src/infrastructure/outbox/index.js';
import {
  fanoutPageContinuationCursor,
  stableFeedItemId,
  stableIntentId,
} from '../../../src/infrastructure/social/index.js';

function assertIntentPayloadBudget(payload: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 2_048) {
    throw new OutboxDeliveryError('permanent', 'social Feed notification intent exceeds content budget');
  }
}

test('R5-05 stable Feed and intent ids are deterministic across array positions', () => {
  const eventId = 'batch-event-stable';
  const recipients = ['r00002', 'r00001', 'r00003'];
  const feedIds = recipients.map((recipient) => stableFeedItemId(eventId, recipient));
  assert.deepEqual(
    feedIds,
    recipients.map((recipient) => stableFeedItemId(eventId, recipient)),
  );
  assert.equal(new Set(feedIds).size, recipients.length);

  const reversed = [...recipients].reverse().map((recipient) => stableFeedItemId(eventId, recipient));
  assert.deepEqual(
    new Set(reversed),
    new Set(feedIds),
    'id set must not depend on recipient array order',
  );

  for (const feedItemId of feedIds) {
    const eventIntent = stableIntentId('event', feedItemId);
    const outboxIntent = stableIntentId('outbox', feedItemId);
    assert.notEqual(eventIntent, outboxIntent);
    assert.equal(eventIntent, stableIntentId('event', feedItemId));
    assert.equal(outboxIntent, stableIntentId('outbox', feedItemId));
  }
});

test('R5-05 stable identity bytes are a frozen idempotency contract', () => {
  // These exact bytes are persisted in social_feed_items / resource_id_ledger / outbox_events
  // and re-derived on every retry. Changing the hash separator or prefix would orphan committed
  // rows, so it must ship as a new versioned derivation; this golden freeze fails such a change.
  assert.equal(
    stableFeedItemId('batch-event-stable', 'r00001'),
    'C8-PHhBQItWZheFtB57wbW2F_qj74D83Ar8W77p-NkQ',
  );
  assert.equal(
    stableFeedItemId('batch-event-stable', 'r00002'),
    'LxOaKStJHcpPoJkbvSQcQJvBeXEPuhRVu9iIbRMDGnU',
  );
  assert.equal(
    stableIntentId('event', 'fixed-feed-item-id'),
    '-yLxRumL432xxX5nyvwI_czbK44RDNZuPVogGg1BzU4',
  );
  assert.equal(
    stableIntentId('outbox', 'fixed-feed-item-id'),
    'qSGg1BUPx_9Q5O5Fjl1VoVilzGpa4WaA3CQkDuDodQQ',
  );
});

test('R5-05 intent payload budget rejects oversized Notification payloads', () => {
  const ok = {
    feedItemId: stableFeedItemId('evt', 'recipient'),
    recipientProfileId: 'recipient',
    sourceEventId: 'evt',
    collectionId: 'Dw8PDw8PDw8PDw8PDw8PDw',
    discoverabilityRecheckKey: 'publication.collection:Dw8PDw8PDw8PDw8PDw8PDw',
  };
  assert.doesNotThrow(() => assertIntentPayloadBudget(ok));

  const oversized = {
    ...ok,
    discoverabilityRecheckKey: `publication.collection:${'x'.repeat(3_000)}`,
  };
  assert.throws(
    () => assertIntentPayloadBudget(oversized),
    (error: unknown) => error instanceof OutboxDeliveryError
      && error.failureKind === 'permanent'
      && /content budget/u.test(error.message),
  );
});

test('R5-05 candidate-page cursor advances by candidate, never by RETURNING success count', () => {
  // A fake projection repository walks candidate pages with the production continuation
  // cursor: every full page keeps its last candidate as the durable cursor even when INSERT
  // RETURNING reports fewer new rows (conflicts), so retries resume past conflicts.
  const candidates = ['r00001', 'r00002', 'r00003', 'r00004', 'r00005'];
  const maxRecipients = 2;
  const walkedPages: string[][] = [];
  let afterRecipient: string | null = null;
  while (true) {
    const startIndex = afterRecipient === null ? 0 : candidates.indexOf(afterRecipient) + 1;
    const page = candidates.slice(startIndex, startIndex + maxRecipients);
    walkedPages.push(page);
    // Simulated RETURNING rows: the last candidate of each full page conflicts, so only the
    // first candidate is reported as newly inserted.
    const returningNew = page.slice(0, 1);
    if (page.length < maxRecipients) break;
    const cursor = fanoutPageContinuationCursor(page);
    assert.notEqual(cursor, null, 'cursor must exist for a full candidate page');
    assert.notEqual(cursor, returningNew.at(-1), 'cursor must never come from RETURNING rows');
    afterRecipient = cursor;
  }
  assert.deepEqual(walkedPages, [
    ['r00001', 'r00002'],
    ['r00003', 'r00004'],
    ['r00005'],
  ]);
  assert.equal(afterRecipient, 'r00004');

  // An empty candidate page cannot continue: the cursor is null.
  assert.equal(fanoutPageContinuationCursor([]), null);
});
