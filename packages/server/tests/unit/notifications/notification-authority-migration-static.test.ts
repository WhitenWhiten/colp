import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('P5-16 migration owns private Notification authority without Feed or provider secrets', async () => {
  const source = await readFile(
    new URL('../../../migrations/202607290200_notification_authority.ts', import.meta.url),
    'utf8',
  );
  for (const contract of [
    'CREATE TABLE notification_preferences', 'CREATE TABLE notifications',
    'CREATE TABLE notification_deliveries', 'notifications_event_recipient_type_key',
    'notification_deliveries_notification_channel_key', 'notifications_recipient_page_idx',
    'notifications_recipient_unread_idx', 'notifications_retention_idx',
    'notification_deliveries_state_due_idx', 'notifications_transition_guard',
    'notification_deliveries_transition_guard', 'accounts_remove_notification_authority',
    'notifications_actor_guard', 'notification_actor_active',
    "notification_type IN ('collection_change','follow_activity')",
    "channel IN ('email')", "retain_until = occurred_at + interval '90 days'",
  ]) assert.ok(source.includes(contract), `missing migration contract: ${contract}`);

  for (const forbidden of [
    'CREATE TABLE social_feed_items', "'billing'", "'creator'", 'provider_secret',
    'provider_token', 'api_key', 'access_token', 'refresh_token', 'credential',
  ]) assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false,
    `forbidden Notification authority: ${forbidden}`);
});

test('FIX-H-005 forward migration owns a provable state-aware retention contract', async () => {
  const source = await readFile(
    new URL('../../../migrations/202608090100_notification_retention_state_contract.ts', import.meta.url),
    'utf8',
  );
  for (const contract of [
    'notifications_retention_window_state',
    "retain_until = occurred_at + interval '365 days'",
    "least(occurred_at + interval '365 days', read_at + interval '90 days')",
    // PostgreSQL forbids generated columns over timestamptz + interval
    // (42P17: generation expression is not immutable), so the 30-day delivery
    // horizon must be a trigger-converged column with a pre-NOT-NULL backfill.
    "NEW.retain_until := NEW.created_at + interval '30 days'",
    "SET retain_until = created_at + interval '30 days'",
    'notification_deliveries_retention_idx',
    "least(OLD.retain_until, NEW.read_at + interval '90 days')",
  ]) assert.ok(source.includes(contract), `missing retention contract: ${contract}`);
  assert.equal(source.includes('GENERATED ALWAYS'), false,
    'generated columns cannot express timestamptz + interval (42P17): delivery retention must be trigger + backfill');
  // Backfill MUST precede the validating ADD CONSTRAINT so validation never
  // sees legacy 90-day rows (bounded lock window, never shortens unread rows).
  assert.ok(
    source.indexOf('UPDATE notifications')
      < source.indexOf('ADD CONSTRAINT notifications_retention_window_state'),
    'backfill must run before the validating retention CHECK',
  );
  // Rollback restores the historical CHECK/guard and must never delete
  // audit/authority data.
  assert.equal(source.toLowerCase().includes('delete from notifications'), false);
  assert.equal(source.toLowerCase().includes('truncate'), false);
  const down = source.slice(source.indexOf('export async function down'));
  assert.ok(down.includes('ADD CONSTRAINT notifications_retention_window'),
    'down must restore the historical retention CHECK');
  assert.ok(down.includes('NOT VALID'),
    'restored historical CHECK must not fail on migrated state-aware rows');
});

test('FIX-H-005 writers, read commands and purge converge on the state-aware contract', async () => {
  const repository = await readFile(new URL(
    '../../../src/infrastructure/notifications/repository-postgres.ts', import.meta.url), 'utf8');
  const worker = await readFile(new URL(
    '../../../src/infrastructure/notifications/social-notification-worker-postgres.ts', import.meta.url),
  'utf8');
  const readCommand = await readFile(new URL(
    '../../../src/infrastructure/notifications/notification-read-command-postgres.ts', import.meta.url),
  'utf8');
  // unread rows are created with a 365-day deadline by both writers
  assert.ok(repository.includes("$8::timestamptz + interval '365 days'"),
    'repository saveNotification must write the unread 365-day deadline');
  assert.ok(worker.includes("$8::timestamptz + interval '365 days'"),
    'worker project must write the unread 365-day deadline');
  assert.ok(worker.includes('cancelPostgresBackend(pool.options, pid)'),
    'worker project must cancel the in-flight backend when the attempt signal aborts');
  // mark-read converges the deadline in the same write on every read path
  for (const site of [repository, readCommand]) {
    assert.ok(
      site.includes("least(retain_until,current_timestamp + interval '90 days')"),
      'mark-read must converge the deadline in the same write',
    );
  }
  // purge validates with BOTH state and the authoritative state-aware cutoff
  assert.ok(repository.includes("occurred_at + interval '365 days'"),
    'notification purge must recompute the state-aware unread cutoff');
  assert.ok(repository.includes("least(occurred_at + interval '365 days', read_at + interval '90 days')"),
    'notification purge must recompute the state-aware read cutoff');
  // independent 30-day delivery purge for resolved terminal rows only
  assert.ok(repository.includes('purgeExpiredDeliveries'), 'independent delivery purge must exist');
  assert.ok(repository.includes("state in ('delivered','suppressed')"),
    'delivery purge must only touch resolved terminal rows');
  const port = await readFile(new URL(
    '../../../src/modules/notifications/application/repository.ts', import.meta.url), 'utf8');
  assert.ok(port.includes('purgeExpiredDeliveries('),
    'delivery purge must be part of the repository port');
});

test('P5-16 repository contract exposes persistence only, not commands, queries, or workers', async () => {
  const source = await readFile(
    new URL('../../../src/modules/notifications/application/repository.ts', import.meta.url), 'utf8',
  );
  for (const method of [
    'getPreferences(', 'saveNotification(', 'saveDelivery(', 'markRead(',
    'transitionDelivery(', 'purgeExpiredNotifications(',
  ]) assert.ok(source.includes(method), `missing repository method ${method}`);
  assert.doesNotMatch(source, /http|route|worker|sendEmail|consumer/iu);
});
