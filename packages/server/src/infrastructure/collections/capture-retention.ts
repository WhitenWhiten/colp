import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { CAPTURE_ATTENTION_REASONS } from '../../modules/collections/index.js';
export function captureHistoryRetention(db: Kysely<DatabaseSchema>, onError: () => void) {
  let timer: ReturnType<typeof setInterval> | undefined, work: Promise<void> | undefined;
  async function prune() {
    await sql`UPDATE bookmark_capture_tasks t SET report_json = report_json || '{"title":"","url":"","localPath":[]}'::jsonb
      WHERE started_at < clock_timestamp() - interval '180 days' AND coalesce(report_json->>'url','') <> ''
        AND report_json->>'save'='local-saved' AND report_json->>'sync' IN ('confirmed','local-only')
        AND coalesce(report_json->>'reason','') NOT IN (${sql.join(CAPTURE_ATTENTION_REASONS.map(reason => sql`${reason}`))})
        AND NOT EXISTS (SELECT 1 FROM bookmark_capture_decisions d WHERE d.account_id=t.account_id AND d.capture_id=t.capture_id AND d.status IN ('waiting','running','suggested'))`.execute(db);
    // Minimal per-capture cohort facts preserve deduplication and late feedback until day 365.
    await sql`DELETE FROM bookmark_capture_tasks WHERE started_at < clock_timestamp() - interval '365 days'
      AND report_json->>'url'=''`.execute(db);
  }
  const run = () => { work ??= prune().finally(() => { work = undefined; }); return work; };
  return { prune: run,
    start() { if (timer) return; void run().catch(onError); timer = setInterval(() => { void run().catch(onError); }, 86400000); timer.unref(); },
    async stop() { if (timer) clearInterval(timer); timer = undefined; await work?.catch(onError); },
  };
}
