import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresFeedQueryUnitOfWork,
  createPostgresFollowQueryUnitOfWork,
} from '../../../src/infrastructure/social/index.js';
import { createPostgresNotificationInboxQueryUnitOfWork }
  from '../../../src/infrastructure/notifications/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  createFeedCursorKeyring,
  createFollowCursorKeyring,
  queryCurrentFeed,
  queryFollowRelations,
} from '../../../src/modules/social/index.js';
import {
  createNotificationInboxCursorKeyring,
  queryCurrentNotificationInbox,
} from '../../../src/modules/notifications/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ACTIVE = { id: 'boundary-pg-current', secret: Buffer.alloc(32, 21).toString('base64') };

describeWithPostgres('R5-07 social identity and database clock boundaries', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_social_boundaries', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seed();
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('Follow/Feed/Notification query UoWs expose stable PostgreSQL current_timestamp clocks', async () => {
    const followKeys = createFollowCursorKeyring({ active: ACTIVE, retained: [] });
    const feedKeys = createFeedCursorKeyring({ active: ACTIVE, retained: [] });
    const inboxKeys = createNotificationInboxCursorKeyring({ active: ACTIVE, retained: [] });
    try {
      const units = [
        createPostgresFollowQueryUnitOfWork(isolated.runtime.db, followKeys),
        createPostgresFeedQueryUnitOfWork(isolated.runtime, feedKeys),
        createPostgresNotificationInboxQueryUnitOfWork(isolated.runtime.db, inboxKeys),
      ];
      for (const unit of units) {
        await unit.execute(async (ports) => {
          const first = await ports.clock.now();
          const second = await ports.clock.now();
          assert.ok(first instanceof Date && Number.isFinite(first.getTime()));
          assert.equal(first.getTime(), second.getTime(), 'RR transaction clock must be stable');
        });
      }

      const followUnit = createPostgresFollowQueryUnitOfWork(isolated.runtime.db, followKeys);
      const page = await followUnit.execute((ports) => queryFollowRelations(ports, {
        principalId: 'viewer', targetProfileId: 'hub', direction: 'followers', limit: 2,
      }));
      assert.ok(page);
      assert.equal(page.items.length, 2);
      assert.ok(page.nextCursor);
      const next = await followUnit.execute((ports) => queryFollowRelations(ports, {
        principalId: 'viewer', targetProfileId: 'hub', direction: 'followers', limit: 2,
        cursor: page.nextCursor!,
      }));
      assert.ok(next);
      assert.equal(next.items[0]?.profileId, 'p00003');
    } finally {
      followKeys.destroy();
      feedKeys.destroy();
      inboxKeys.destroy();
    }
  });

  test('query UoW page and unread count observe one repeatable-read snapshot', async () => {
    const keys = createNotificationInboxCursorKeyring({ active: ACTIVE, retained: [] });
    try {
      const unit = createPostgresNotificationInboxQueryUnitOfWork(isolated.runtime.db, keys);
      await unit.execute(async (ports) => {
        const page = await ports.reads.loadPage({ principalId: 'inbox-a', limit: 10 });
        assert.equal(page.length, 3);
        await isolated.runtime.pool.query(`update notifications set state='read',
          read_at=current_timestamp,state_revision=state_revision+1
          where recipient_account_id='inbox-a' and notification_id='inbox-a-0000'`);
        assert.equal(await ports.reads.countUnread({ principalId: 'inbox-a' }), 3);
      });
      const after = await unit.execute((ports) => queryCurrentNotificationInbox(ports, {
        principalId: 'inbox-a', limit: 10,
      }));
      assert.equal(after.unreadCount, 2);
    } finally {
      keys.destroy();
    }
  });

  test('repository and query layers reject 257-character identities consistently', async () => {
    const overlong = 'a'.repeat(SOCIAL_IDENTITY_MAX_LENGTH + 1);
    const followKeys = createFollowCursorKeyring({ active: ACTIVE, retained: [] });
    const feedKeys = createFeedCursorKeyring({ active: ACTIVE, retained: [] });
    const inboxKeys = createNotificationInboxCursorKeyring({ active: ACTIVE, retained: [] });
    try {
      await assert.rejects(() => createPostgresFollowQueryUnitOfWork(isolated.runtime.db, followKeys)
        .execute((ports) => queryFollowRelations(ports, {
          principalId: overlong, targetProfileId: 'hub', direction: 'followers', limit: 1,
        })), TypeError);
      await assert.rejects(() => createPostgresFeedQueryUnitOfWork(isolated.runtime, feedKeys)
        .execute((ports) => queryCurrentFeed(ports, { principalId: overlong, limit: 1 })), TypeError);
      await assert.rejects(() => createPostgresNotificationInboxQueryUnitOfWork(
        isolated.runtime.db, inboxKeys,
      ).execute((ports) => queryCurrentNotificationInbox(ports, {
        principalId: overlong, limit: 1,
      })), TypeError);

      await assert.rejects(() => createPostgresFollowQueryUnitOfWork(isolated.runtime.db, followKeys)
        .execute((ports) => ports.reads.listFollowers({
          targetProfileId: overlong, limit: 1,
        })), TypeError);
      await assert.rejects(() => createPostgresFeedQueryUnitOfWork(isolated.runtime, feedKeys)
        .execute((ports) => ports.reads.loadPage({
          principalId: overlong, limit: 1,
        })), TypeError);
      await assert.rejects(() => createPostgresNotificationInboxQueryUnitOfWork(
        isolated.runtime.db, inboxKeys,
      ).execute((ports) => ports.reads.loadPage({
        principalId: overlong, limit: 1,
      })), TypeError);
    } finally {
      followKeys.destroy();
      feedKeys.destroy();
      inboxKeys.destroy();
    }
  });

  test('transaction abort and aborted query signal fail closed', async () => {
    const keys = createFollowCursorKeyring({ active: ACTIVE, retained: [] });
    try {
      const aborting = createPostgresFollowQueryUnitOfWork(isolated.runtime.db, keys, {
        faultInjector: {
          afterCallbackBeforeCommit() {
            throw new Error('r5-07-query-abort');
          },
        },
      });
      await assert.rejects(
        () => aborting.execute((ports) => queryFollowRelations(ports, {
          principalId: 'viewer', targetProfileId: 'hub', direction: 'followers', limit: 1,
        })),
        (error: unknown) => error instanceof Error && error.message === 'r5-07-query-abort',
      );

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => createPostgresFollowQueryUnitOfWork(isolated.runtime.db, keys).execute((ports) =>
          queryFollowRelations(ports, {
            principalId: 'viewer', targetProfileId: 'hub', direction: 'followers', limit: 1,
            signal: controller.signal,
          })),
        (error: unknown) => error instanceof Error,
      );
    } finally {
      keys.destroy();
    }
  });

  test('256-character principal identities seal and open against the database clock', async () => {
    const identity = 'b'.repeat(SOCIAL_IDENTITY_MAX_LENGTH);
    const keys = createFollowCursorKeyring({ active: ACTIVE, retained: [] });
    try {
      const unit = createPostgresFollowQueryUnitOfWork(isolated.runtime.db, keys);
      const first = await unit.execute((ports) => queryFollowRelations(ports, {
        principalId: identity, targetProfileId: 'hub', direction: 'followers', limit: 1,
      }));
      assert.ok(first?.nextCursor);
      const second = await unit.execute((ports) => queryFollowRelations(ports, {
        principalId: identity, targetProfileId: 'hub', direction: 'followers', limit: 1,
        cursor: first.nextCursor!,
      }));
      assert.ok(second);
      assert.equal(second.items[0]?.profileId, 'p00002');
    } finally {
      keys.destroy();
    }
  });

  async function seed(): Promise<void> {
    await isolated.runtime.pool.query(`
      insert into accounts(id,subject_id,status,email) values
        ('hub','s-hub','active','hub@example.test'),
        ('viewer','s-viewer','active','viewer@example.test'),
        ('p00001','s1','active','p1@example.test'),
        ('p00002','s2','active','p2@example.test'),
        ('p00003','s3','active','p3@example.test'),
        ('inbox-a','s-inbox','active','inbox@example.test');
      insert into profiles(account_id,display_name)
        select id,'Display '||id from accounts;
      insert into profile_handles(handle,account_id)
        select 'handle_'||id,id from accounts;
      insert into follows(actor_profile_id,target_profile_id,followed_at) values
        ('p00001','hub','2026-07-01T00:00:03Z'),
        ('p00002','hub','2026-07-01T00:00:02Z'),
        ('p00003','hub','2026-07-01T00:00:01Z');
      insert into notifications(
        notification_id,recipient_account_id,source_event_id,notification_type,actor_profile_id,
        subject_type,subject_id,state,state_revision,occurred_at,retain_until
      ) values
        ('inbox-a-0000','inbox-a','event-inbox-0','follow_activity','p00001','profile','hub','unread',0,
          '2026-07-01T00:00:03Z','2026-07-01T00:00:03Z'::timestamptz + interval '365 days'),
        ('inbox-a-0001','inbox-a','event-inbox-1','follow_activity','p00002','profile','hub','unread',0,
          '2026-07-01T00:00:02Z','2026-07-01T00:00:02Z'::timestamptz + interval '365 days'),
        ('inbox-a-0002','inbox-a','event-inbox-2','follow_activity','p00003','profile','hub','unread',0,
          '2026-07-01T00:00:01Z','2026-07-01T00:00:01Z'::timestamptz + interval '365 days')`);
    assert.equal(SOCIAL_IDENTITY_MAX_LENGTH, 256);
  }
});
