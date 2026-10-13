import { assertValidNodeTags, CollectionsError } from '../../modules/collections/index.js';
import { sql } from 'kysely';
import { AutomationError } from '../../modules/automation/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export function createTagPreferences(tx: DatabaseTransaction, ownerId: string) {
  return { async set(ruleId: string, tag: string, rejected: boolean): Promise<boolean> {
    try { assertValidNodeTags([tag]); }
    catch (error) {
      if (!(error instanceof CollectionsError)) throw error;
      throw new AutomationError('invalid_request', 'Expected one valid canonical tag key.');
    }
    if (!rejected) return (await sql`DELETE FROM automation_tag_rejections WHERE owner_id=${ownerId}
      AND rule_id=${ruleId} AND tag_key=${tag} RETURNING tag_key`.execute(tx)).rows.length > 0;
    const existing = (await sql`SELECT 1 FROM automation_tag_rejections WHERE rule_id=${ruleId} AND tag_key=${tag}`.execute(tx)).rows;
    if (existing.length) return false;
    const count = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM automation_tag_rejections WHERE rule_id=${ruleId}`.execute(tx)).rows[0]!.n;
    if (count >= 1000) throw new AutomationError('payload_too_large', 'Maximum 1,000 rejected tags per rule; allow an existing tag before adding another.');
    return (await sql`INSERT INTO automation_tag_rejections(owner_id,rule_id,tag_key,rejected_at)
      VALUES(${ownerId},${ruleId},${tag},clock_timestamp()) ON CONFLICT DO NOTHING RETURNING tag_key`.execute(tx)).rows.length > 0;
  } };
}
