import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker, type WorkerRuntime } from '../../../src/bootstrap/worker.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { COMMUNITY_STATIC_GENERATION } from '../../../src/modules/community/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createCommentNotificationFixture,
  type CommunityWorker,
} from './comment-notification-worker-helpers.js';

describeWithPostgres('community-social comment notification worker', () => {
  let isolated: IsolatedPostgresRuntime;
  let metrics: InMemoryMetrics;
  let workerRuntime: WorkerRuntime;
  let worker: CommunityWorker;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_notif_worker', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    metrics = new InMemoryMetrics();
    workerRuntime = buildWorker(workerConfig(), isolated.runtime, metrics);
    assert.ok(workerRuntime.outbox);
    worker = workerRuntime.outbox;
  }, 120_000);
  // NB: WorkerRuntime.stop() also closes the shared database runtime, so the
  // file-level worker is deliberately never started and never stopped — every
  // drain is driven manually through outbox.runOnce().
  afterAll(async () => {
    await workerRuntime?.outbox?.stop();
    await isolated?.close();
  });

  const {
    testConfig, workerConfig, startApp, issueUser, communityClient,
    seedCollection, seedCommentRow, rawGet, drainWorker, outboxRowsForComment,
    notificationCountForEvent, notificationCountForRecipient, replayEvent,
  } = createCommentNotificationFixture(() => isolated);

  async function drain(limit = 100): Promise<void> {
    await drainWorker(worker, limit);
  }

  test('full chain: HTTP reply -> outbox event -> worker drain -> recipient inbox -> mark read', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o1');
      const alice = await issueUser(factory, 'a1');
      const bob = await issueUser(factory, 'b1');
      const collectionId = 'cnw-t1-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t1');

      const anonymous = communityClient(origin, config);
      const ownerClient = communityClient(origin, config, owner);
      const aliceClient = communityClient(origin, config, alice);
      const bobClient = communityClient(origin, config, bob);

      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };
      const root = await aliceClient.createComment(
        { target, body: 'root comment body', replyToId: null }, randomUUID());
      const reply = await bobClient.createComment(
        { target, body: 'reply body for alice', replyToId: root.id }, randomUUID());

      // Root comment produced exactly one event (owner); the reply produced
      // one event per deduplicated recipient (owner + parent author).
      assert.deepEqual(
        (await outboxRowsForComment(root.id)).map((row) => row.aggregate_scope),
        [owner.accountId]);
      assert.deepEqual(
        (await outboxRowsForComment(reply.id)).map((row) => row.aggregate_scope).sort(),
        [alice.accountId, owner.accountId].sort());

      await drain();
      for (const row of [
        ...await outboxRowsForComment(root.id),
        ...await outboxRowsForComment(reply.id),
      ]) {
        assert.equal(row.state, 'completed');
        assert.equal(await notificationCountForEvent(row.domain_event_id), 1);
      }

      const inbox = await aliceClient.listNotifications();
      assert.deepEqual(Object.keys(inbox).sort(), ['items', 'nextCursor', 'unreadCount']);
      assert.equal(inbox.unreadCount, 1);
      assert.equal(inbox.items.length, 1);
      assert.equal(inbox.nextCursor, null);
      const item = inbox.items[0]!;
      assert.deepEqual(Object.keys(item).sort(), [
        'actor', 'commentId', 'createdAt', 'href', 'id', 'kind', 'preview', 'read', 'target',
      ]);
      assert.equal(item.kind, 'comment_reply');
      assert.equal(item.commentId, reply.id);
      assert.deepEqual(item.target, target);
      assert.equal(item.actor.id, bob.accountId);
      assert.equal(item.actor.handle, bob.handle);
      assert.equal(typeof item.actor.displayName, 'string');
      assert.equal(item.preview, 'reply body for alice');
      assert.ok(item.href.endsWith(`#comment-${reply.id}`));
      assert.equal(item.read, false);
      assert.equal(item.createdAt, reply.createdAt);

      // The owner inbox carries both the root-comment and the reply
      // notification — same worker route, different recipients.
      const ownerInbox = await ownerClient.listNotifications();
      assert.equal(ownerInbox.unreadCount, 2);
      assert.deepEqual(ownerInbox.items.map((row) => row.commentId).sort(),
        [reply.id, root.id].sort());

      // Anonymous inbox reads stay rejected (private per-recipient surface).
      const denied = await rawGet(origin, '/api/v1/me/community-notifications');
      assert.equal(denied.status, 401);

      const read = await aliceClient.markNotificationsRead({ ids: [item.id] }, randomUUID());
      assert.deepEqual(read.changedIds, [item.id]);
      assert.equal(read.unreadCount, 0);
      const after = await aliceClient.listNotifications();
      assert.equal(after.unreadCount, 0);
      assert.equal(after.items.length, 1);
      assert.equal(after.items[0]!.id, item.id);
      assert.equal(after.items[0]!.read, true);
      const unreadOnly = await aliceClient.listNotifications({ read: 'unread' });
      assert.equal(unreadOnly.items.length, 0);
      assert.equal(unreadOnly.unreadCount, 0);
    } finally {
      await app.close();
    }
  });

  test('keyset paging serves both rows of a same-millisecond microsecond boundary (CS-C01)', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'ok1');
      const alice = await issueUser(factory, 'ak1');
      const bob = await issueUser(factory, 'bk1');
      const collectionId = 'cnw-k1-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-k1');

      const anonymous = communityClient(origin, config);
      const aliceClient = communityClient(origin, config, alice);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };

      // Two replies to a silent fixture parent give the reader real comment
      // subjects. The worker is NOT drained here: the two notification rows
      // are inserted directly (same shape the worker writes) so the keyset
      // timestamps can be forced — the bug under test lives in the inbox
      // READ path, not the worker.
      const rootId = 'cnw-k1-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });
      const replyUpper = await bobClient.createComment(
        { target, body: 'microsecond upper', replyToId: rootId }, randomUUID());
      const replyLower = await bobClient.createComment(
        { target, body: 'microsecond lower', replyToId: rootId }, randomUUID());
      assert.equal(await outboxRowsForComment(replyUpper.id).then((rows) => rows.length), 2);
      assert.equal(await outboxRowsForComment(replyLower.id).then((rows) => rows.length), 2);
      const upperId = randomUUID();
      const lowerId = randomUUID();
      for (const [notificationId, subjectId, occurredAt, eventId] of [
        [upperId, replyUpper.id, '2026-09-17T12:00:00.123400Z', randomUUID()],
        [lowerId, replyLower.id, '2026-09-17T12:00:00.123100Z', randomUUID()],
      ] as const) {
        await isolated.runtime.pool.query(
          `insert into notifications(notification_id,recipient_account_id,source_event_id,
             notification_type,actor_profile_id,subject_type,subject_id,occurred_at,retain_until)
           values($1,$2,$3,'comment_reply',$4,'community_comment',$5,$6::timestamptz,
             $6::timestamptz + interval '365 days')
           on conflict(recipient_account_id,source_event_id,notification_type) do nothing`,
          [notificationId, alice.accountId, eventId, bob.accountId, subjectId, occurredAt]);
      }
      assert.equal(await notificationCountForRecipient(alice.accountId), 2);

      // Both rows must be reachable across hard page breaks at limit=1.
      const page1 = await aliceClient.listNotifications({ limit: 1 });
      assert.deepEqual(page1.items.map((row) => row.commentId), [replyUpper.id]);
      assert.ok(page1.nextCursor !== null);
      const page2 = await aliceClient.listNotifications({ limit: 1, cursor: page1.nextCursor });
      assert.deepEqual(page2.items.map((row) => row.commentId), [replyLower.id]);
      // No row remains after the lower-microsecond row: page2 is terminal.
      assert.equal(page2.nextCursor, null);

      // Nothing was skipped: the unread count still accounts for both rows
      // and marking them visible brings the count to zero.
      assert.equal(page1.unreadCount, 2);
      const read = await aliceClient.markNotificationsRead(
        { ids: [page1.items[0]!.id, page2.items[0]!.id] }, randomUUID());
      assert.deepEqual(read.changedIds.sort(), [page1.items[0]!.id, page2.items[0]!.id].sort());
      assert.equal(read.unreadCount, 0);
    } finally {
      await app.close();
    }
  });

  test('recipient dedup: owner == parent author yields one event; the replying actor never notifies itself', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o2');
      const bob = await issueUser(factory, 'b2');
      const collectionId = 'cnw-t2-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t2');

      const anonymous = communityClient(origin, config);
      const ownerClient = communityClient(origin, config, owner);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };

      // The owner comments on its own collection: the only candidate
      // recipient is the owner itself, which the actor exclusion removes —
      // the producer must write no outbox event at all.
      const root = await ownerClient.createComment(
        { target, body: 'owner root', replyToId: null }, randomUUID());
      assert.equal((await outboxRowsForComment(root.id)).length, 0);

      // Bob replies: owner and parent author are the SAME account, so the
      // producer emits exactly one event (recipient dedup), not two.
      const reply = await bobClient.createComment(
        { target, body: 'reply to owner', replyToId: root.id }, randomUUID());
      const replyEvents = await outboxRowsForComment(reply.id);
      assert.equal(replyEvents.length, 1);
      assert.equal(replyEvents[0]!.aggregate_scope, owner.accountId);

      // Bob replies to his own reply: the parent-author candidate is Bob
      // himself and is excluded; only the owner event remains.
      const selfReply = await bobClient.createComment(
        { target, body: 'reply to myself', replyToId: reply.id }, randomUUID());
      const selfEvents = await outboxRowsForComment(selfReply.id);
      assert.equal(selfEvents.length, 1);
      assert.equal(selfEvents[0]!.aggregate_scope, owner.accountId);

      await drain();
      const ownerInbox = await ownerClient.listNotifications();
      assert.equal(ownerInbox.unreadCount, 2);
      assert.deepEqual(ownerInbox.items.map((row) => row.commentId).sort(),
        [reply.id, selfReply.id].sort());
      for (const item of ownerInbox.items) {
        assert.equal(item.actor.id, bob.accountId);
      }

      // Bob's own inbox stays empty — actors never receive their own replies.
      const bobInbox = await bobClient.listNotifications();
      assert.equal(bobInbox.items.length, 0);
      assert.equal(bobInbox.unreadCount, 0);
      assert.equal(await notificationCountForRecipient(bob.accountId), 0);
    } finally {
      await app.close();
    }
  });

  test('duplicate replays and out-of-order delivery never produce duplicate notifications', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o3');
      const alice = await issueUser(factory, 'a3');
      const bob = await issueUser(factory, 'b3');
      const collectionId = 'cnw-t3-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t3');

      const anonymous = communityClient(origin, config);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };

      // Fixture parent: no outbox events for the root itself.
      const rootId = 'cnw-t3-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });

      const reply1 = await bobClient.createComment(
        { target, body: 'reply one', replyToId: rootId }, randomUUID());
      const reply2 = await bobClient.createComment(
        { target, body: 'reply two', replyToId: rootId }, randomUUID());
      const events1 = await outboxRowsForComment(reply1.id);
      const events2 = await outboxRowsForComment(reply2.id);
      assert.equal(events1.length, 2);
      assert.equal(events2.length, 2);

      // Out-of-order: the second reply's events become claimable while the
      // first reply's stay deferred — the worker delivers them first.
      await isolated.runtime.pool.query(`update outbox_events
        set available_at = current_timestamp + interval '1 hour'
        where aggregate_id = $1`, [reply1.id]);
      await drain();
      for (const row of events2) {
        assert.equal(await notificationCountForEvent(row.domain_event_id), 1);
      }
      for (const row of events1) {
        assert.equal(await notificationCountForEvent(row.domain_event_id), 0);
      }

      // Replay one already-completed event mid-stream as a crash-before-
      // complete redelivery — its delivery receipt never landed, so the
      // projection runs again and the dedupe key
      // (recipient, source_event_id, notification_type) makes it a no-op.
      const duplicatesBefore = metrics.get('community.notification.duplicate');
      await isolated.runtime.pool.query(`delete from outbox_delivery_receipts
        where handler_name='community_comment_notification' and domain_event_id=$1`,
        [events2[0]!.domain_event_id]);
      await replayEvent(events2[0]!.outbox_id);
      await drain();
      assert.equal(await notificationCountForEvent(events2[0]!.domain_event_id), 1);
      assert.ok(metrics.get('community.notification.duplicate') > duplicatesBefore);

      // Release the deferred events; every event still projects exactly once.
      await isolated.runtime.pool.query(`update outbox_events
        set available_at = current_timestamp where aggregate_id = $1`, [reply1.id]);
      await drain();
      for (const row of [...events1, ...events2]) {
        assert.equal(await notificationCountForEvent(row.domain_event_id), 1);
      }
      const states = await isolated.runtime.pool.query<{ state: string }>(
        `select state from outbox_events where aggregate_id in ($1,$2)`,
        [reply1.id, reply2.id]);
      assert.deepEqual(states.rows.map((row) => row.state),
        ['completed', 'completed', 'completed', 'completed']);
      assert.equal(await notificationCountForRecipient(alice.accountId), 2);
      assert.equal(await notificationCountForRecipient(owner.accountId), 2);
    } finally {
      await app.close();
    }
  });

  test('worker restart resumes pending events without redelivering completed ones', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o6');
      const alice = await issueUser(factory, 'a6');
      const bob = await issueUser(factory, 'b6');
      const collectionId = 'cnw-t6-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t6');

      const anonymous = communityClient(origin, config);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };
      const rootId = 'cnw-t6-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });

      const reply1 = await bobClient.createComment(
        { target, body: 'restart reply one', replyToId: rootId }, randomUUID());
      const reply2 = await bobClient.createComment(
        { target, body: 'restart reply two', replyToId: rootId }, randomUUID());
      const allEvents = [
        ...await outboxRowsForComment(reply1.id),
        ...await outboxRowsForComment(reply2.id),
      ];
      assert.equal(allEvents.length, 4);

      // First worker process: drains only part of the backlog, then stops
      // (the outbox stop is the process boundary — the database is shared).
      const runtimeA = buildWorker(workerConfig(), isolated.runtime, new InMemoryMetrics());
      const workerA = runtimeA.outbox!;
      assert.equal(await workerA.runOnce(), true);
      await workerA.stop();
      const completedCount = async () => (await isolated.runtime.pool
        .query<{ count: number }>(`select count(*)::int count from outbox_events
          where aggregate_id in ($1,$2) and state='completed'`, [reply1.id, reply2.id]))
        .rows[0]!.count;
      assert.equal(await completedCount(), 1);
      assert.equal(await notificationCountForRecipient(alice.accountId)
        + await notificationCountForRecipient(owner.accountId), 1);

      // Restarted process: a fresh worker instance claims only what is still
      // claimable — completed events are never re-delivered.
      const runtimeB = buildWorker(workerConfig(), isolated.runtime, new InMemoryMetrics());
      const workerB = runtimeB.outbox!;
      try {
        await drainWorker(workerB);
        assert.equal(await completedCount(), 4);
        const ids = await isolated.runtime.pool.query<{ notification_id: string }>(
          `select notification_id from notifications
           where source_event_id in ($1,$2,$3,$4)`,
          allEvents.map((row) => row.domain_event_id));
        assert.equal(ids.rows.length, 4);
        assert.equal(new Set(ids.rows.map((row) => row.notification_id)).size, 4);
        assert.equal(await notificationCountForRecipient(alice.accountId), 2);
        assert.equal(await notificationCountForRecipient(owner.accountId), 2);

        // A post-restart replay of one finished event still dedupes.
        await replayEvent(allEvents[0]!.outbox_id);
        await drainWorker(workerB);
        assert.equal(await notificationCountForEvent(allEvents[0]!.domain_event_id), 1);
        assert.equal(await notificationCountForRecipient(alice.accountId)
          + await notificationCountForRecipient(owner.accountId), 4);
      } finally {
        await workerB.stop();
      }
    } finally {
      await app.close();
    }
  });

  test('the delivered notification pins the event instant end-to-end, independent of session time zone', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o8');
      const alice = await issueUser(factory, 'a8');
      const bob = await issueUser(factory, 'b8');
      const collectionId = 'cnw-t8-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t8');

      const anonymous = communityClient(origin, config);
      const aliceClient = communityClient(origin, config, alice);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };
      const rootId = 'cnw-t8-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });
      const reply = await bobClient.createComment(
        { target, body: 'clock reply', replyToId: rootId }, randomUUID());
      await drain();
      const event = (await outboxRowsForComment(reply.id))
        .find((row) => row.aggregate_scope === alice.accountId)!;

      // One instant is pinned end-to-end: the comment command's
      // transaction clock stamped outbox_events.occurred_at, the worker
      // copied it verbatim into notifications.occurred_at (the dedupe
      // predicate compares it), and retain_until derived +365d from it.
      const instants = await isolated.runtime.pool.query<{
        event_ms: string; notif_ms: string; retain_ms: string; utc_text: string }>(
        `select
           round(extract(epoch from e.occurred_at) * 1000)::bigint::text event_ms,
           round(extract(epoch from n.occurred_at) * 1000)::bigint::text notif_ms,
           round(extract(epoch from n.retain_until) * 1000)::bigint::text retain_ms,
           to_char(n.occurred_at at time zone 'UTC',
                   'YYYY-MM-DD HH24:MI:SS.MS') utc_text
         from notifications n
         join outbox_events e on e.domain_event_id = n.source_event_id
         where n.source_event_id = $1`, [event.domain_event_id]);
      const pinned = instants.rows[0]!;
      assert.equal(pinned.notif_ms, pinned.event_ms,
        'the notification instant is the outbox event instant, not worker wall-clock');
      assert.equal(BigInt(pinned.retain_ms) - BigInt(pinned.notif_ms),
        365n * 24n * 60n * 60n * 1000n,
        'retain_until is exactly occurred_at + 365 days');

      // The wire projection carries the same UTC instant to the recipient.
      const inbox = await aliceClient.listNotifications();
      const wire = inbox.items.find((item) => item.commentId === reply.id)!;
      assert.equal(Date.parse(wire.createdAt), Number(pinned.notif_ms),
        'createdAt on the wire is the pinned UTC instant');

      // timestamptz stores the instant itself: under extreme session time
      // zones the epoch and the UTC wall clock read back identically.
      for (const zone of ['Pacific/Kiritimati', 'America/New_York']) {
        const client = await isolated.runtime.pool.connect();
        try {
          await client.query(`set time zone '${zone}'`);
          const shifted = await client.query<{ notif_ms: string; utc_text: string }>(
            `select round(extract(epoch from occurred_at) * 1000)::bigint::text notif_ms,
               to_char(occurred_at at time zone 'UTC',
                       'YYYY-MM-DD HH24:MI:SS.MS') utc_text
             from notifications where source_event_id = $1`, [event.domain_event_id]);
          assert.equal(shifted.rows[0]?.notif_ms, pinned.notif_ms,
            `the epoch is session-time-zone independent under ${zone}`);
          assert.equal(shifted.rows[0]?.utc_text, pinned.utc_text,
            `the UTC rendering is session-time-zone independent under ${zone}`);
        } finally {
          await client.query('reset time zone').catch(() => undefined);
          client.release();
        }
      }

      // Re-delivery never re-stamps the instant: replaying the completed
      // event dedupes against the pinned occurred_at rather than writing
      // a second notification at worker wall-clock time.
      await replayEvent(event.outbox_id);
      await drain();
      const after = await isolated.runtime.pool.query<{ notif_ms: string }>(
        `select round(extract(epoch from occurred_at) * 1000)::bigint::text notif_ms
         from notifications where source_event_id = $1`, [event.domain_event_id]);
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0]!.notif_ms, pinned.notif_ms,
        'a replayed event still pins the original instant');
    } finally {
      await app.close();
    }
  });
});
