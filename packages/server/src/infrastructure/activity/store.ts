import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ActivityPorts, ActivityReadRequest } from '../../modules/activity/index.js';
import { AutomationError, createAutomationPagination } from '../../modules/automation/index.js';
import { activityViews, type ActivityRow } from './item-views.js';

async function unreadCount(tx: DatabaseTransaction, accountId: string): Promise<number> {
  return (await sql<{ count: number }>`SELECT count(*)::integer AS count FROM activity_items WHERE account_id=${accountId} AND read_at IS NULL`.execute(tx)).rows[0]!.count;
}
export function createActivityStore(db: Kysely<DatabaseSchema>, cursorKey: string): ActivityPorts {
  const page = createAutomationPagination(cursorKey);
  return {
    async list(accountId, query) {
      const state = query.state ?? 'all';
      if (state !== 'unread' && state !== 'all') throw new AutomationError('invalid_request', 'Activity state must be all or unread.');
      const now = new Date(), scope = `activity:${state}`, { limit, after } = page.read({ ...query, limit: query.limit ?? '20' }, accountId, scope, now);
      return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
        const rows = (await sql<ActivityRow>`SELECT *,revision::text,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_updated_at
          FROM activity_items WHERE account_id=${accountId} ${state === 'unread' ? sql`AND read_at IS NULL` : sql``}
          ${after ? sql`AND (updated_at,id)<(${after.createdAt}::timestamptz,${after.id})` : sql``}
          ORDER BY updated_at DESC,id DESC LIMIT ${limit + 1}`.execute(tx)).rows;
        const last = rows[limit - 1];
        return { items: await activityViews(tx, accountId, rows.slice(0, limit)), unreadCount: await unreadCount(tx, accountId),
          nextCursor: rows.length > limit && last ? page.next(accountId, scope, limit, { createdAt: last.sort_updated_at, id: last.id }, now) : null };
      });
    },
    async summary(accountId) {
      return db.transaction().setIsolationLevel('repeatable read').execute(async tx => {
        const rows = (await sql<ActivityRow>`SELECT *,revision::text,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_updated_at
          FROM activity_items WHERE account_id=${accountId} ORDER BY updated_at DESC,id DESC LIMIT 1`.execute(tx)).rows;
        const revision = (await sql<{ revision: string }>`SELECT coalesce(max(revision),0)::text AS revision FROM activity_items WHERE account_id=${accountId}`.execute(tx)).rows[0]!.revision;
        return { unreadCount: await unreadCount(tx, accountId), latest: (await activityViews(tx, accountId, rows))[0] ?? null, revision };
      });
    },
    async markRead(accountId, request: ActivityReadRequest) {
      return db.transaction().execute(async tx => {
        // Shared with the consumer, so each aggregate is either read before or after an arriving member.
        await tx.selectFrom('accounts').select('id').where('id', '=', accountId).forUpdate().executeTakeFirst();
        const target = 'ids' in request
          ? sql`id IN (${sql.join(request.ids.map(id => sql`${id}`))})`
          : sql`(updated_at,id)<=(SELECT updated_at,id FROM activity_items WHERE id=${request.through} AND account_id=${accountId} ${request.throughRevision === undefined ? sql`` : sql`AND revision::text=${request.throughRevision}`})`;
        const changed = await sql`UPDATE activity_items SET read_at=clock_timestamp(),revision=revision+1
          WHERE account_id=${accountId} AND read_at IS NULL AND ${target} RETURNING id`.execute(tx);
        return { readCount: changed.rows.length, unreadCount: await unreadCount(tx, accountId) };
      });
    },
  };
}
