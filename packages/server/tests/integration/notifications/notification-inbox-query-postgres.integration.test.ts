import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { buildNotificationInboxPageStatement, buildNotificationUnreadCountStatement,
  createPostgresNotificationInboxQueryUnitOfWork }
  from '../../../src/infrastructure/notifications/index.js';
import { createNotificationInboxCursorKeyring, queryCurrentNotificationInbox,
  type NotificationInboxQueryInput } from '../../../src/modules/notifications/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const PRIVATE_MARKER = 'notification-inbox-private-marker';
const ACTIVE_KEY = { id: 'notification-query-current',
  secret: Buffer.alloc(32, 51).toString('base64') };

describeWithPostgres('P5-18 current-account Notification inbox query', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_notification_query', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function query(input: NotificationInboxQueryInput,
    keys = createNotificationInboxCursorKeyring({ active: ACTIVE_KEY, retained: [] })) {
    const unit = createPostgresNotificationInboxQueryUnitOfWork(isolated.runtime.db, keys);
    return unit.execute((ports) => queryCurrentNotificationInbox(ports, input));
  }

  test('two accounts traverse complete isolated collections with authoritative unread totals', async () => {
    await seedAccount('traverse-a'); await seedAccount('traverse-b'); await seedAccount('traverse-actor');
    await seedNotifications('traverse-a', 53, 'traverse-actor');
    await seedNotifications('traverse-b', 37, 'traverse-actor');
    await markEveryThirdRead('traverse-a'); await markEveryThirdRead('traverse-b');

    for (const [accountId, expected] of [['traverse-a', 53], ['traverse-b', 37]] as const) {
      const seen: string[] = []; let cursor: string | undefined;
      do {
        const page = await query({ principalId: accountId, limit: 7, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((item) => item.notificationId));
        assert.equal(page.unreadCount, expected - Math.ceil(expected / 3));
        assert.equal(page.items.every((item) => item.notificationId.startsWith(`${accountId}-`)), true);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(seen.length, expected); assert.equal(new Set(seen).size, expected);
    }
  });

  test('empty/full pages and read/unread filters retain an independent authority count', async () => {
    await seedAccount('filters-empty'); await seedAccount('filters-a');
    assert.deepEqual(await query({ principalId: 'filters-empty', limit: 10 }),
      { items: [], nextCursor: null, unreadCount: 0 });
    await seedNotifications('filters-a', 9); await markEveryThirdRead('filters-a');
    const all = await query({ principalId: 'filters-a', state: '  ALL  ', limit: 20 });
    assert.equal(all.items.length, 9); assert.equal(all.unreadCount, 6);
    const unread = await query({ principalId: 'filters-a', state: 'unread', limit: 1 });
    assert.equal(unread.items.length, 1); assert.equal(unread.unreadCount, 6);
    assert.equal(unread.items[0]?.state, 'unread'); assert.ok(unread.nextCursor);
    const read = await query({ principalId: 'filters-a', state: 'read', limit: 20 });
    assert.equal(read.items.length, 3); assert.equal(read.unreadCount, 6);
    assert.equal(read.items.every((item) => item.state === 'read' && item.readAt !== null), true);
  });

  test('exclusive fence stays duplicate-free when newer rows are inserted and pending rows deleted', async () => {
    await seedAccount('mutation-a'); await seedNotifications('mutation-a', 6);
    const first = await query({ principalId: 'mutation-a', limit: 2 });
    await insertNotification('mutation-a', 'mutation-a-newer', new Date('2026-07-29T13:00:00Z'));
    await isolated.runtime.pool.query(`delete from notifications
      where recipient_account_id='mutation-a' and notification_id='mutation-a-0003'`);
    const seen = first.items.map((item) => item.notificationId); let cursor = first.nextCursor;
    while (cursor) {
      const page = await query({ principalId: 'mutation-a', limit: 2, cursor });
      seen.push(...page.items.map((item) => item.notificationId)); cursor = page.nextCursor;
    }
    assert.deepEqual(seen, ['mutation-a-0000','mutation-a-0001','mutation-a-0002',
      'mutation-a-0004','mutation-a-0005']);
    assert.equal(new Set(seen).size, seen.length); assert.equal(seen.includes('mutation-a-newer'), false);
  });

  test('equal timestamps traverse by descending notification identity without duplicates', async () => {
    await seedAccount('tie-a');
    const occurredAt = new Date('2026-07-29T12:00:00Z');
    for (const suffix of ['a', 'c', 'b']) {
      await insertNotification('tie-a', `tie-a-${suffix}`, occurredAt);
    }
    const first = await query({ principalId: 'tie-a', limit: 2 });
    const second = await query({ principalId: 'tie-a', limit: 2, cursor: first.nextCursor! });
    assert.deepEqual([...first.items, ...second.items].map((item) => item.notificationId),
      ['tie-a-c', 'tie-a-b', 'tie-a-a']);
    assert.equal(second.nextCursor, null);
  });

  test('page and unread count observe one repeatable-read authority snapshot', async () => {
    await seedAccount('snapshot-a'); await seedNotifications('snapshot-a', 3);
    const unit = createPostgresNotificationInboxQueryUnitOfWork(isolated.runtime.db,
      createNotificationInboxCursorKeyring({ active: ACTIVE_KEY, retained: [] }));
    await unit.execute(async (ports) => {
      const page = await ports.reads.loadPage({ principalId: 'snapshot-a', limit: 10 });
      assert.equal(page.length, 3);
      await isolated.runtime.pool.query(`update notifications set state='read',
        read_at=occurred_at+interval '1 second',state_revision=state_revision+1
        where recipient_account_id='snapshot-a' and notification_id='snapshot-a-0000'`);
      assert.equal(await ports.reads.countUnread({ principalId: 'snapshot-a' }), 3);
    });
    assert.equal((await query({ principalId: 'snapshot-a', limit: 10 })).unreadCount, 2);
  });

  test('cursor rejects tamper, cross-account replay and retires old keys after bounded rotation', async () => {
    await seedAccount('cursor-a'); await seedAccount('cursor-b');
    await seedNotifications('cursor-a', 3); await seedNotifications('cursor-b', 3);
    const old = { id: 'notification-query-old',
      secret: Buffer.alloc(32, 52).toString('base64') };
    const first = await query({ principalId: 'cursor-a', state: 'unread', limit: 1 },
      createNotificationInboxCursorKeyring({ active: old, retained: [] }));
    const token = first.nextCursor!;
    // Bind retained lastIssuedAt to PostgreSQL current_timestamp. Host wall clock can lag the
    // Testcontainers PG clock that seals cursor issuedAt, which fails issued <= lastIssuedAt.
    const lastIssuedAt = (await isolated.runtime.pool.query<{ now: Date }>(
      `select date_trunc('milliseconds', current_timestamp) as now`)).rows[0]!.now;
    await assert.rejects(() => query({ principalId: 'cursor-b', state: 'unread', limit: 1, cursor: token }));
    await assert.rejects(() => query({ principalId: 'cursor-a', state: 'unread', limit: 1,
      cursor: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` }));
    const rotated = createNotificationInboxCursorKeyring({ active: ACTIVE_KEY, retained: [{ ...old,
      lastIssuedAt: lastIssuedAt.toISOString(),
      retainUntil: new Date(lastIssuedAt.getTime() + 900_000).toISOString(),
    }] });
    const second = await query({ principalId: 'cursor-a', state: 'unread', limit: 1, cursor: token }, rotated);
    assert.deepEqual(second.items.map((item) => item.notificationId), ['cursor-a-0001']);
    assert.match(second.nextCursor!, /^ninbox1\.notification-query-current\./u);
  });

  test('DTO and page SELECT exclude raw event, delivery, recipient and secret state', async () => {
    await seedAccount('secret-a');
    await insertNotification('secret-a', 'secret-a-0000',
      new Date('2026-07-29T12:00:00Z'), null, PRIVATE_MARKER);
    await insertNotification('secret-a', 'secret-a-0001', new Date('2026-07-29T11:59:59Z'));
    await isolated.runtime.pool.query(`insert into notification_deliveries(
      delivery_id,notification_id,recipient_account_id,channel,provider_message_id)
      values('secret-delivery','secret-a-0000','secret-a','email',$1)`, [PRIVATE_MARKER]);
    const statement = buildNotificationInboxPageStatement({ principalId: 'secret-a', limit: 10 });
    assert.doesNotMatch(statement.text,
      /notification_deliveries|outbox|provider_message_id|attempt_count|source_event_id/iu);
    assert.match(statement.text, /left join lateral/iu);
    assert.match(statement.text, /visibility='public'/u);
    assert.match(statement.text, /publication_slug is not null/u);
    assert.match(statement.text, /published_at is not null/u);
    assert.match(statement.text, /deleted_at is null/u);
    assert.match(statement.text, /lower\(actor_handle\.handle\)/u);
    assert.doesNotMatch(statement.text,
      /left join collections(?:\s+\w+)?\s+on\s+\w+\.id=\w+\.subject_id/iu);
    const unread = buildNotificationUnreadCountStatement('secret-a');
    assert.doesNotMatch(unread.text, /collections|profiles|profile_handles/iu);
    // The statement-level filter starts at the `where` that opens the clause the
    // `order by` belongs to. Matching the *first* `where` in the text picked up
    // a lateral join's own clause (nine spaces deep), which is why this
    // assertion used to fail.
    const start = statement.text.indexOf('\n      where notification.recipient_account_id');
    assert.ok(start >= 0, `no statement-level where clause in:\n${statement.text}`);
    const orderBy = statement.text.indexOf('\n      order by', start);
    assert.ok(orderBy > start, `the where clause is not followed by an order by in:\n${statement.text}`);
    const outerWhere = statement.text.slice(start, orderBy);
    assert.match(outerWhere, /notification\.recipient_account_id=\$1/u);
    assert.doesNotMatch(outerWhere, /visibility|publication_slug|deleted_at/iu);
    // Concealment for hidden collections belongs to that same clause.
    assert.match(outerWhere, /moderation_actions/u);
    const page = await query({ principalId: 'secret-a', limit: 10 });
    const serialized = JSON.stringify(page);
    assert.equal(serialized.includes(PRIVATE_MARKER), false);
    for (const forbidden of ['providerMessageId','attemptCount','recipientAccountId','sourceEventId',
      'retainUntil','createdAt','payload']) assert.equal(serialized.includes(forbidden), false);
  });

  test('public collection_change locators stay on the inbox row and null out after private/unlisted/delete',
    async () => {
      await seedAccount('locator-recipient'); await seedAccount('locator-actor');
      await seedHandle('locator-actor', 'locator.actor');
      await isolated.runtime.pool.query(
        `update profiles set display_name='Locator Actor' where account_id='locator-actor'`);
      await seedPublicCollection({ id: 'locator-collection-id', ownerSubjectId: 'subject-locator-actor',
        title: 'Locator Collection', slug: 'locator-collection' });
      await insertNotification('locator-recipient', 'locator-n1', new Date('2026-07-29T12:00:00Z'),
        'locator-actor', 'event-locator-n1', { subjectId: 'locator-collection-id' });
      const beforeCount = Number((await isolated.runtime.pool.query(
        `select count(*)::int count from notifications where notification_id='locator-n1'`)).rows[0].count);
      assert.equal(beforeCount, 1);
      const publicPage = await query({ principalId: 'locator-recipient', limit: 10 });
      const publicItem = publicPage.items.find((item) => item.notificationId === 'locator-n1');
      assert.ok(publicItem);
      assert.equal(publicItem.subject.id, 'locator-collection-id');
      assert.notEqual(publicItem.subject.id, publicItem.publicationSlug);
      assert.equal(publicItem.collectionTitle, 'Locator Collection');
      assert.equal(publicItem.publicationSlug, 'locator-collection');
      assert.equal(publicItem.actorHandle, 'locator.actor');
      assert.equal(publicItem.actorDisplayName, 'Locator Actor');
      assert.equal(publicItem.summary, 'public_collection_updated');
      assert.doesNotMatch(JSON.stringify(publicPage.items), /"details"|nodeIds/u);
      const collectionId = 'locator-collection-id';
      for (const [label, apply] of [
        ['private', async () => {
          await isolated.runtime.pool.query(`update collections set visibility='private' where id=$1`,
            [collectionId]);
        }],
        ['unlisted', async () => {
          await isolated.runtime.pool.query(
            `update collections set visibility='unlisted', deleted_at=null where id=$1`, [collectionId]);
        }],
        ['deleted', async () => {
          await isolated.runtime.pool.query(`with deleted_nodes as (
              update nodes set deleted_at=current_timestamp where collection_id=$1 returning id
            )
            update collections set visibility='public', deleted_at=current_timestamp
             where id=$1 and exists(select 1 from deleted_nodes)`, [collectionId]);
        }],
      ] as const) {
        await apply();
        const after = await query({ principalId: 'locator-recipient', limit: 10 });
        const item = after.items.find((row) => row.notificationId === 'locator-n1');
        assert.ok(item, label);
        assert.equal(item.subject.id, 'locator-collection-id', label);
        assert.equal(item.collectionTitle, null, label);
        assert.equal(item.publicationSlug, null, label);
        assert.equal(item.summary, null, label);
        assert.equal(item.actorHandle, 'locator.actor', label);
        const count = Number((await isolated.runtime.pool.query(
          `select count(*)::int count from notifications where notification_id='locator-n1'`)).rows[0].count);
        assert.equal(count, 1, label);
      }
    });

  test('follow_activity keeps a null collection locator and a resolvable actor handle', async () => {
    await seedAccount('follow-recipient'); await seedAccount('follow-actor');
    await seedHandle('follow-actor', 'follow.actor');
    await isolated.runtime.pool.query(
      `update profiles set display_name='Follow Actor' where account_id='follow-actor'`);
    await insertNotification('follow-recipient', 'follow-n1', new Date('2026-07-29T12:00:00Z'),
      'follow-actor', 'event-follow-n1', { notificationType: 'follow_activity', subjectType: 'profile',
        subjectId: 'follow-actor' });
    const page = await query({ principalId: 'follow-recipient', limit: 10 });
    const item = page.items.find((row) => row.notificationId === 'follow-n1');
    assert.ok(item);
    assert.equal(item.collectionTitle, null);
    assert.equal(item.publicationSlug, null);
    assert.equal(item.summary, 'new_follower');
    assert.equal(item.actorHandle, 'follow.actor');
    assert.equal(item.actorDisplayName, 'Follow Actor');
  });

  test('unresolved actor still returns the inbox row with null handle and name', async () => {
    await seedAccount('orphan-recipient'); await seedAccount('orphan-actor');
    await insertNotification('orphan-recipient', 'orphan-n1', new Date('2026-07-29T12:00:00Z'),
      'orphan-actor', 'event-orphan-n1');
    const page = await query({ principalId: 'orphan-recipient', limit: 10 });
    const item = page.items.find((row) => row.notificationId === 'orphan-n1');
    assert.ok(item);
    assert.equal(item.actorProfileId, 'orphan-actor');
    assert.equal(item.actorHandle, null);
    assert.equal(item.actorDisplayName, null);
    assert.equal(item.subject.id.startsWith('collection-'), true);
  });

  async function seedAccount(id: string) {
    await isolated.runtime.pool.query(`insert into accounts(id,subject_id,status) values($1,$2,'active')`,
      [id, `subject-${id}`]);
    await isolated.runtime.pool.query(`insert into profiles(account_id,display_name) values($1,$2)`, [id, id]);
  }
  async function seedHandle(accountId: string, handle: string) {
    await isolated.runtime.pool.query(`insert into profile_handles(handle,account_id) values($1,$2)`,
      [handle, accountId]);
  }
  async function seedPublicCollection(input: {
    readonly id: string; readonly ownerSubjectId: string; readonly title: string; readonly slug: string;
  }) {
    const rootId = `root-${input.id}`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
        values($1,'collection',current_timestamp),($2,'node',current_timestamp)`, [input.id, rootId]);
      await client.query(`insert into collections(
        id,owner_subject_id,title,kind,visibility,publication_slug,published_at,
        root_node_id,root_node_is_root,resource_revision,content_revision,policy_revision,
        commit_ordinal,created_at,updated_at)
        values($1,$2,$3,'bookmarks','public',$4,current_timestamp,$5,true,
          'r1','c1','p1',1,current_timestamp,current_timestamp)`,
      [input.id, input.ownerSubjectId, input.title, input.slug, rootId]);
      await client.query(`insert into nodes(
        id,collection_id,parent_id,kind,is_root,title,url,position_token,
        resource_revision,children_revision,created_at,updated_at)
        values($1,$2,null,'folder',true,'Root',null,null,'r1','ch1',
          current_timestamp,current_timestamp)`, [rootId, input.id]);
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async function insertNotification(recipient: string, id: string, occurredAt: Date,
    actorProfileId: string | null = null, sourceEventId = `event-${id}`, options: {
      readonly notificationType?: 'collection_change' | 'follow_activity';
      readonly subjectType?: 'collection' | 'profile'; readonly subjectId?: string;
    } = {}) {
    const notificationType = options.notificationType ?? 'collection_change';
    const subjectType = options.subjectType ?? (notificationType === 'follow_activity' ? 'profile' : 'collection');
    const subjectId = options.subjectId ?? `collection-${id}`;
    await isolated.runtime.pool.query(`insert into notifications(notification_id,recipient_account_id,
      source_event_id,notification_type,actor_profile_id,subject_type,subject_id,occurred_at,retain_until)
      values($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,
        $8::timestamptz+interval '365 days')`,
    [id, recipient, sourceEventId, notificationType, actorProfileId, subjectType, subjectId, occurredAt]);
  }
  async function seedNotifications(recipient: string, count: number, actorProfileId: string | null = null) {
    for (let index = 0; index < count; index += 1) await insertNotification(recipient,
      `${recipient}-${String(index).padStart(4, '0')}`,
      new Date(Date.parse('2026-07-29T12:00:00Z') - index * 1_000), actorProfileId);
  }
  async function markEveryThirdRead(recipient: string) {
    await isolated.runtime.pool.query(`update notifications set state='read',read_at=occurred_at+interval '1 second',
      state_revision=state_revision+1 where recipient_account_id=$1
      and right(notification_id,4)::int % 3=0`, [recipient]);
  }
});
