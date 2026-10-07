import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { AvatarObjectStore } from '../../modules/identity/index.js';

export interface PersistentAvatarStore extends AvatarObjectStore {
  drainCleanup(): Promise<number>;
  startCleanup(onError: (error: unknown) => void): void;
}

/** Upload preparation and GC own short SQL transactions; provider I/O never does. */
export function createPersistentAvatarStore(db: Kysely<DatabaseSchema>, objects: AvatarObjectStore): PersistentAvatarStore {
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<number> | undefined;
  const signal = () => AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);

  async function remove(id: string): Promise<boolean> {
    const claimed = await db.transaction().execute(async (tx) => {
      const found = await sql<{ lifecycle_state: string; leased: boolean }>`SELECT lifecycle_state,
        (lease_until > now()) AS leased FROM avatar_objects
        WHERE object_id=${id}::uuid AND uploader_account_id IS NOT NULL FOR UPDATE`.execute(tx);
      const row = found.rows[0];
      if (!row || row.lifecycle_state === 'deleted' || row.leased) return false;
      const refs = await sql`SELECT 1 FROM profiles WHERE avatar_url ~* ${`/api/v1/avatar/${id}$`} LIMIT 1`.execute(tx);
      if (refs.rows.length > 0) {
        await sql`UPDATE avatar_objects SET cleanup_after=now()+interval '1 day' WHERE object_id=${id}::uuid`.execute(tx);
        return false;
      }
      await sql`UPDATE avatar_objects SET lifecycle_state='deleting', lease_until=now()+interval '1 minute', cleanup_after=now()
        WHERE object_id=${id}::uuid`.execute(tx);
      return true;
    });
    if (!claimed) return false;
    // Deleting is a durable reference fence. Retry after lease expiry if the
    // provider fails or acknowledgement is lost; never restore ready on error.
    try {
      await objects.delete(id, signal());
    } catch (error) {
      await sql`UPDATE avatar_objects SET cleanup_after=now()+interval '5 minutes', lease_until=NULL
        WHERE object_id=${id}::uuid AND lifecycle_state='deleting'`.execute(db);
      throw error;
    }
    await sql`UPDATE avatar_objects SET lifecycle_state='deleted', cleanup_after=NULL, lease_until=NULL
      WHERE object_id=${id}::uuid AND lifecycle_state='deleting'`.execute(db);
    return true;
  }

  const store: PersistentAvatarStore = {
    get: (id) => objects.get(id),
    async put(id, body, contentType, accountId) {
      if (!accountId) throw new Error('Avatar uploader account is required');
      const prepare = await db.transaction().execute(async tx => {
        await sql`INSERT INTO avatar_objects(object_id, account_id, uploader_account_id, lifecycle_state, cleanup_after)
          VALUES (${id}::uuid, ${accountId}, ${accountId}, 'preparing', now()+interval '1 day') ON CONFLICT DO NOTHING`.execute(tx);
        const result = await sql<{ uploader_account_id: string; lifecycle_state: string; leased: boolean }>`
          SELECT uploader_account_id, lifecycle_state, (lease_until > now()) AS leased FROM avatar_objects
          WHERE object_id=${id}::uuid FOR UPDATE`.execute(tx);
        const row = result.rows[0];
        if (row?.uploader_account_id !== accountId) throw new Error('Avatar upload identity mismatch');
        if (row.lifecycle_state === 'ready') return false;
        if (row.lifecycle_state !== 'preparing' || row.leased) throw new Error('Avatar preparation is unavailable; retry later');
        await sql`UPDATE avatar_objects SET lease_until=now()+interval '1 minute' WHERE object_id=${id}::uuid`.execute(tx);
        return true;
      });
      if (!prepare) return;
      await objects.put(id, body, contentType, accountId, signal());
      const updated = await sql`UPDATE avatar_objects SET lifecycle_state='ready', lease_until=NULL
        WHERE object_id=${id}::uuid AND lifecycle_state='preparing' RETURNING object_id`.execute(db);
      if (updated.rows.length !== 1) throw new Error('Avatar preparation lease was lost');
    },
    async delete(id) { await remove(id); },
    async drainCleanup() {
      if (running) return running;
      running = (async () => {
        const due = await sql<{ object_id: string }>`SELECT object_id FROM avatar_objects
          WHERE uploader_account_id IS NOT NULL AND lifecycle_state <> 'deleted'
            AND cleanup_after <= now() AND (lease_until IS NULL OR lease_until <= now())
          ORDER BY cleanup_after, object_id LIMIT 20`.execute(db);
        let deleted = 0;
        for (const row of due.rows) {
          if (shutdown.signal.aborted) break;
          if (await remove(row.object_id)) deleted++;
        }
        return deleted;
      })();
      try { return await running; } finally { running = undefined; }
    },
    startCleanup(onError) {
      if (timer || shutdown.signal.aborted) return;
      const tick = () => { void store.drainCleanup().catch(onError); };
      timer = setInterval(tick, 60_000);
      timer.unref();
      tick();
    },
    async close() {
      if (timer) clearInterval(timer);
      shutdown.abort();
      try { await running; } finally { await objects.close?.(); }
    },
  };
  return store;
}
