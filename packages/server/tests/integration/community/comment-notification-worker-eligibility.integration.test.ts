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

describeWithPostgres('community-social comment notification worker eligibility', () => {
  let isolated: IsolatedPostgresRuntime;
  let workerRuntime: WorkerRuntime;
  let worker: CommunityWorker;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('community_comment_notif_elig', { maxConnections: 10 });
    await runMigrations(isolated.runtime.db, 'latest');
    workerRuntime = buildWorker(workerConfig(), isolated.runtime, new InMemoryMetrics());
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
    seedCollection, seedCommentRow, drainWorker, outboxRowsForComment,
    notificationCountForEvent, notificationCountForRecipient,
    setChannelPreference, setCollectionVisibility,
  } = createCommentNotificationFixture(() => isolated);

  async function drain(limit = 100): Promise<void> {
    await drainWorker(worker, limit);
  }

  test('delivery rechecks visibility: concealed target/comment blocks delivery; post-delivery reads redact or conceal', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o4');
      const alice = await issueUser(factory, 'a4');
      const bob = await issueUser(factory, 'b4');
      const collectionId = 'cnw-t4-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t4');

      const anonymous = communityClient(origin, config);
      const aliceClient = communityClient(origin, config, alice);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };
      const rootId = 'cnw-t4-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });

      // (a) Target turns private before delivery -> events complete as
      // ineligible and no notification row is written.
      const replyPrivate = await bobClient.createComment(
        { target, body: 'blocked by private target', replyToId: rootId }, randomUUID());
      await setCollectionVisibility(collectionId, 'private');
      await drain();
      for (const row of await outboxRowsForComment(replyPrivate.id)) {
        assert.equal(row.state, 'completed');
        assert.equal(await notificationCountForEvent(row.domain_event_id), 0);
      }
      await setCollectionVisibility(collectionId, 'public');

      // (b) Reply comment is author-deleted before delivery -> ineligible.
      const replyDeleted = await bobClient.createComment(
        { target, body: 'deleted before delivery', replyToId: rootId }, randomUUID());
      const deletedEtag = (await bobClient.getCommentWithEtag(replyDeleted.id)).etag;
      assert.ok(deletedEtag !== null);
      await bobClient.deleteComment(replyDeleted.id, deletedEtag, randomUUID());
      await drain();
      for (const row of await outboxRowsForComment(replyDeleted.id)) {
        assert.equal(row.state, 'completed');
        assert.equal(await notificationCountForEvent(row.domain_event_id), 0);
      }

      // (c) Reply comment is curator-hidden before delivery -> ineligible.
      const replyHidden = await bobClient.createComment(
        { target, body: 'hidden before delivery', replyToId: rootId }, randomUUID());
      const ownerClient = communityClient(origin, config, owner);
      const curation = await ownerClient.getCuration(replyHidden.id);
      assert.ok(curation.etag !== null);
      await ownerClient.setCuration(replyHidden.id,
        { hidden: true, reason: 'pre-delivery hide' }, curation.etag, randomUUID());
      await drain();
      for (const row of await outboxRowsForComment(replyHidden.id)) {
        assert.equal(row.state, 'completed');
        assert.equal(await notificationCountForEvent(row.domain_event_id), 0);
      }
      assert.equal(await notificationCountForRecipient(alice.accountId), 0);

      // (d) Delivered, then author-deleted -> the row stays servable with
      // preview=null (the sole redacted representation) and still counts.
      const replyLateDelete = await bobClient.createComment(
        { target, body: 'deleted after delivery', replyToId: rootId }, randomUUID());
      await drain();
      assert.equal(await notificationCountForRecipient(alice.accountId), 1);
      const lateEtag = (await bobClient.getCommentWithEtag(replyLateDelete.id)).etag;
      assert.ok(lateEtag !== null);
      await bobClient.deleteComment(replyLateDelete.id, lateEtag, randomUUID());
      const redacted = await aliceClient.listNotifications();
      assert.equal(redacted.items.length, 1);
      assert.equal(redacted.items[0]!.commentId, replyLateDelete.id);
      assert.equal(redacted.items[0]!.preview, null);
      assert.equal(redacted.items[0]!.read, false);
      assert.equal(redacted.unreadCount, 1);
      // Tombstoned rows stay markable: the read command still transitions them.
      const redactedRead = await aliceClient.markNotificationsRead(
        { ids: [redacted.items[0]!.id] }, randomUUID());
      assert.deepEqual(redactedRead.changedIds, [redacted.items[0]!.id]);
      assert.equal(redactedRead.unreadCount, 0);

      // (e) Delivered, then curator-hidden -> preview=null the same way.
      const replyLateHide = await bobClient.createComment(
        { target, body: 'hidden after delivery', replyToId: rootId }, randomUUID());
      await drain();
      const lateCuration = await ownerClient.getCuration(replyLateHide.id);
      assert.ok(lateCuration.etag !== null);
      await ownerClient.setCuration(replyLateHide.id,
        { hidden: true, reason: 'post-delivery hide' }, lateCuration.etag, randomUUID());
      const hiddenInbox = await aliceClient.listNotifications();
      const hiddenItem = hiddenInbox.items.find((row) => row.commentId === replyLateHide.id);
      assert.ok(hiddenItem !== undefined);
      assert.equal(hiddenItem.preview, null);

      // (f) Delivered, then the target turns private -> the whole row is
      // concealed at read time (not just redacted), and unread drops to 0.
      await setCollectionVisibility(collectionId, 'private');
      const concealed = await aliceClient.listNotifications();
      assert.equal(concealed.items.length, 0);
      assert.equal(concealed.unreadCount, 0);
      assert.equal(concealed.nextCursor, null);
      await setCollectionVisibility(collectionId, 'public');
      const restored = await aliceClient.listNotifications();
      assert.equal(restored.items.length, 2);
      // Only the curator-hidden row is still unread (the tombstoned one was
      // marked read above); both keep their redacted preview.
      assert.equal(restored.unreadCount, 1);
      assert.ok(restored.items.every((row) => row.preview === null));
    } finally {
      await app.close();
    }
  });

  test('preferences gate delivery: community enabled=false and global in_app=false both block projection', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o5');
      const alice = await issueUser(factory, 'a5');
      const bob = await issueUser(factory, 'b5');
      const collectionId = 'cnw-t5-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t5');

      const anonymous = communityClient(origin, config);
      const aliceClient = communityClient(origin, config, alice);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };
      const rootId = 'cnw-t5-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });

      // (a) The community preference is the virtual default: enabled,
      // revision '1'. PUT {enabled:false} under its If-Match tag stores
      // revision 2 and blocks the worker's delivery for this recipient.
      const preference = await aliceClient.getNotificationPreference();
      assert.equal(preference.data.enabled, true);
      assert.equal(preference.data.revision, '1');
      assert.ok(preference.etag !== null);
      const disabled = await aliceClient.putNotificationPreference(
        { enabled: false }, preference.etag, randomUUID());
      assert.equal(disabled.data.enabled, false);
      assert.equal(disabled.data.revision, '2');
      assert.ok(disabled.etag !== null && disabled.etag !== preference.etag);

      const replyBlocked = await bobClient.createComment(
        { target, body: 'community preference off', replyToId: rootId }, randomUUID());
      await drain();
      const blockedEvents = await outboxRowsForComment(replyBlocked.id);
      assert.equal(blockedEvents.length, 2);
      const aliceEvent = blockedEvents.find((row) => row.aggregate_scope === alice.accountId)!;
      const ownerEvent = blockedEvents.find((row) => row.aggregate_scope === owner.accountId)!;
      assert.equal(aliceEvent.state, 'completed');
      assert.equal(await notificationCountForEvent(aliceEvent.domain_event_id), 0);
      // The owner's own preference is untouched — its delivery lands.
      assert.equal(await notificationCountForEvent(ownerEvent.domain_event_id), 1);
      // The disabled representation also serves an empty inbox, not just
      // an empty unread counter.
      const disabledInbox = await aliceClient.listNotifications();
      assert.equal(disabledInbox.items.length, 0);
      assert.equal(disabledInbox.unreadCount, 0);

      // (b) The shared in_app channel is an independent delivery gate:
      // community stays enabled, in_app=false still blocks the projection.
      const carol = await issueUser(factory, 'c5');
      const carolClient = communityClient(origin, config, carol);
      const carolRootId = 'cnw-t5-root-carol';
      await seedCommentRow({ id: carolRootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: carol.accountId,
        body: 'carol parent' });
      await setChannelPreference(carol.accountId, 'in_app', false);
      const replyInAppOff = await bobClient.createComment(
        { target, body: 'in_app off', replyToId: carolRootId }, randomUUID());
      await drain();
      const carolEvent = (await outboxRowsForComment(replyInAppOff.id))
        .find((row) => row.aggregate_scope === carol.accountId)!;
      assert.equal(carolEvent.state, 'completed');
      assert.equal(await notificationCountForEvent(carolEvent.domain_event_id), 0);
      assert.equal(await notificationCountForRecipient(carol.accountId), 0);
      // Carol's community representation is still enabled — the row simply
      // was never delivered, so the inbox is honestly empty.
      const carolInbox = await carolClient.listNotifications();
      assert.equal(carolInbox.items.length, 0);
      assert.equal(carolInbox.unreadCount, 0);
    } finally {
      await app.close();
    }
  });

  test('legacy notification rows never leak into the community inbox, counters, or read transitions', async () => {
    const config = testConfig();
    const { app, origin, factory } = await startApp(config);
    try {
      const owner = await issueUser(factory, 'o7');
      const alice = await issueUser(factory, 'a7');
      const bob = await issueUser(factory, 'b7');
      const collectionId = 'cnw-t7-collection';
      await seedCollection(collectionId, owner.subjectId, 'public', 'cnw-t7');

      const anonymous = communityClient(origin, config);
      const aliceClient = communityClient(origin, config, alice);
      const bobClient = communityClient(origin, config, bob);
      const view = await anonymous.resolveTarget({ kind: 'collection', id: collectionId });
      const target = { ...view.target };
      const rootId = 'cnw-t7-root';
      await seedCommentRow({ id: rootId, targetKind: 'collection', targetId: collectionId,
        generation: COMMUNITY_STATIC_GENERATION, authorAccountId: alice.accountId,
        body: 'fixture parent' });

      // Pre-existing legacy rows on the same recipient + shared authority:
      // one unread follow_activity, one already-read collection_change.
      await isolated.runtime.pool.query(
        `insert into notifications(notification_id,recipient_account_id,source_event_id,
          notification_type,actor_profile_id,subject_type,subject_id,state,read_at,
          occurred_at,retain_until)
         values
          ('cnw-t7-legacy-follow',$1,'cnw-t7-legacy-follow-event','follow_activity',
           $2,'profile',$2,'unread',null,
           current_timestamp - interval '2 hours',
           current_timestamp - interval '2 hours' + interval '365 days'),
          ('cnw-t7-legacy-collection',$1,'cnw-t7-legacy-collection-event','collection_change',
           $2,'collection',$3,'unread',null,
           current_timestamp - interval '1 hour',
           current_timestamp - interval '1 hour' + interval '365 days')`,
        [alice.accountId, bob.accountId, collectionId]);
      // The transition guard admits only the legal lifecycle write: the
      // read row is marked through the same unread->read transition the
      // read command performs (revision +1, read_at set); the trigger
      // converges retain_until to least(occurred_at + 365d, read_at + 90d).
      await isolated.runtime.pool.query(
        `update notifications set state='read',
          read_at=current_timestamp - interval '30 minutes',
          state_revision=state_revision+1
         where notification_id='cnw-t7-legacy-collection'`);

      const reply = await bobClient.createComment(
        { target, body: 'legacy regression reply', replyToId: rootId }, randomUUID());
      await drain();
      const aliceEvent = (await outboxRowsForComment(reply.id))
        .find((row) => row.aggregate_scope === alice.accountId)!;
      assert.equal(await notificationCountForEvent(aliceEvent.domain_event_id), 1);

      // The community inbox pages only comment_reply rows: neither the
      // unread legacy row nor the read one leaks into items or unreadCount.
      const inbox = await aliceClient.listNotifications();
      assert.equal(inbox.items.length, 1);
      assert.equal(inbox.items[0]!.kind, 'comment_reply');
      assert.equal(inbox.items[0]!.commentId, reply.id);
      assert.equal(inbox.unreadCount, 1);
      const paged = await aliceClient.listNotifications({ limit: 1 });
      assert.equal(paged.items.length, 1);
      assert.equal(paged.items[0]!.kind, 'comment_reply');
      assert.equal(paged.nextCursor, null);

      // The read command transitions only the community row; the legacy
      // unread row stays unread and is never counted in the result.
      const read = await aliceClient.markNotificationsRead(
        { ids: [inbox.items[0]!.id] }, randomUUID());
      assert.deepEqual(read.changedIds, [inbox.items[0]!.id]);
      assert.equal(read.unreadCount, 0);
      const legacy = await isolated.runtime.pool.query<{ state: string }>(
        `select state from notifications where notification_id in
         ('cnw-t7-legacy-follow','cnw-t7-legacy-collection') order by notification_id`);
      assert.deepEqual(legacy.rows.map((row) => row.state), ['read', 'unread']);
      const unreadCommunity = await aliceClient.listNotifications({ read: 'unread' });
      assert.equal(unreadCommunity.unreadCount, 0);
    } finally {
      await app.close();
    }
  });
});
