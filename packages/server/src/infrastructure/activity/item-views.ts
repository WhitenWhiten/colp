import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ActivityItem, ActivityKind } from '../../modules/activity/index.js';
export interface ActivityRow {
  id: string; kind: ActivityKind; agent_client_id: string | null; collection_id: string | null; run_id: string | null;
  count: number; revision: string; occurred_at: Date; updated_at: Date; read_at: Date | null;
  details_json: { status?: string; attention?: 'review' | 'awaitingApproval' | null }; sort_updated_at: string;
}
interface Member { activity_id: string; node_id: string; title: string | null; url: string | null; occurred_at: Date;
  parent_id: string | null; parent_title: string | null }
export async function activityViews(tx: DatabaseTransaction, accountId: string, rows: ActivityRow[]): Promise<ActivityItem[]> {
  if (!rows.length) return [];
  const ids = sql.join(rows.map(row => sql`${row.id}`));
  // One directory lookup for the page. Labels are resolved live and restricted to this account's credentials.
  const agents = (await sql<{ id: string; name: string | null; kind: 'oauth_client' | 'api_key' }>`
    SELECT c."clientId" AS id,nullif(btrim(c.name),'') AS name,'oauth_client' AS kind FROM "auth_oauth_client" c
      WHERE c."clientId" IN (SELECT agent_client_id FROM activity_items WHERE id IN (${ids}))
    UNION ALL SELECT k.mcp_client_id,nullif(btrim(k.label),''),'api_key' FROM account_credentials k
      WHERE k.manager_account_id=${accountId} AND k.mcp_client_id IN (SELECT agent_client_id FROM activity_items WHERE id IN (${ids}))`.execute(tx)).rows;
  const collections = (await sql<{ id: string; title: string | null }>`SELECT c.id,c.title FROM collections c
    JOIN accounts a ON a.subject_id=c.owner_subject_id WHERE a.id=${accountId} AND c.deleted_at IS NULL
      AND c.id IN (SELECT collection_id FROM activity_items WHERE id IN (${ids}))`.execute(tx)).rows;
  const liveMembers = sql`FROM activity_members m JOIN nodes n ON n.id=m.node_id AND n.collection_id=m.collection_id AND n.deleted_at IS NULL
    JOIN collections c ON c.id=n.collection_id AND c.deleted_at IS NULL JOIN accounts a ON a.subject_id=c.owner_subject_id AND a.id=${accountId}
    LEFT JOIN nodes p ON p.id=n.parent_id AND p.collection_id=n.collection_id AND p.deleted_at IS NULL WHERE m.activity_id IN (${ids})`;
  const members = (await sql<Member>`SELECT * FROM (SELECT m.activity_id,n.id AS node_id,n.title,n.url,m.occurred_at,
    n.parent_id,p.title AS parent_title,row_number() OVER(PARTITION BY m.activity_id ORDER BY m.occurred_at DESC,m.source_event_id DESC) AS rank
    ${liveMembers}) ranked WHERE rank<=5 ORDER BY activity_id,rank`.execute(tx)).rows;
  const folderRows = (await sql<{ activity_id: string; node_id: string; title: string | null; count: number }>`
    WITH grouped AS (SELECT m.activity_id,n.parent_id AS node_id,p.title,count(*)::integer AS count ${liveMembers}
      AND n.parent_id IS NOT NULL GROUP BY m.activity_id,n.parent_id,p.title), ranked AS (
      SELECT *,row_number() OVER(PARTITION BY activity_id ORDER BY count DESC,node_id) AS rank FROM grouped)
    SELECT * FROM ranked WHERE rank<=5 ORDER BY activity_id,rank`.execute(tx)).rows;
  const runs = (await sql<{ id: string; rule_id: string; rule_name: string | null; state: string; output_count: number }>`
    SELECT r.id,v.rule_id,v.definition_json->>'name' AS rule_name,r.state,
      (SELECT count(*)::integer FROM automation_run_outputs o WHERE o.run_id=r.id) AS output_count
    FROM automation_runs r LEFT JOIN automation_rule_revisions v ON v.id=r.rule_revision_id
    WHERE r.owner_id=${accountId} AND r.id IN (SELECT run_id FROM activity_items WHERE id IN (${ids}))`.execute(tx)).rows;
  return rows.map(row => {
    const agent = agents.find(value => value.id === row.agent_client_id), collection = collections.find(value => value.id === row.collection_id);
    const live = members.filter(value => value.activity_id === row.id), run = runs.find(value => value.id === row.run_id);
    return { id: row.id, kind: row.kind, state: row.read_at ? 'read' : 'unread', revision: row.revision,
      occurredAt: row.occurred_at.toISOString(), updatedAt: row.updated_at.toISOString(), readAt: row.read_at?.toISOString() ?? null,
      count: row.count, agent: row.agent_client_id ? { clientId: row.agent_client_id, name: agent?.name?.slice(0, 256) ?? null, kind: agent?.kind ?? 'unknown' } : null,
      collection: collection ?? null, folders: folderRows.filter(folder => folder.activity_id === row.id).map(folder => ({ nodeId: folder.node_id, title: folder.title, count: folder.count })),
      items: live.slice(0, 5).map(member => ({ nodeId: member.node_id, title: member.title, host: host(member.url), occurredAt: member.occurred_at.toISOString() })),
      run: run ? { id: run.id, ruleId: run.rule_id, ruleName: run.rule_name, status: row.details_json.status ?? run.state,
        outputCount: run.output_count, attention: row.details_json.attention ?? null } : null };
  });
}
function host(url: string | null): string | null {
  try { return url ? new URL(url).hostname : null; } catch { return null; }
}
