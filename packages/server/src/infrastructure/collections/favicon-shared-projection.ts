import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { knownFaviconForUrl } from '../../modules/collections/index.js';

/** Shared objects are a read projection, never owned by an individual bookmark. */
export async function overlaySharedFaviconObjectIds(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
  nodeIds: readonly string[],
  objects: Map<string, string>,
): Promise<ReadonlyMap<string, string>> {
  if (nodeIds.length === 0) return objects;
  const rows = (await sql<{ id: string; url: string | null }>`
    SELECT n.id, n.url FROM nodes n
    JOIN collections c ON c.id=n.collection_id
    LEFT JOIN accounts a ON a.subject_id=c.owner_subject_id
    LEFT JOIN account_favicon_policies p ON p.account_id=a.id
    LEFT JOIN bookmark_icon_sources s ON s.node_id=n.id
    WHERE n.id=ANY(${nodeIds}::text[]) AND n.kind='bookmark'
      AND n.deleted_at IS NULL AND c.deleted_at IS NULL
      AND (coalesce(p.force_all_online, false)
        OR s.source_mode='online'
        OR (coalesce(s.source_mode, 'inherit')='inherit' AND p.new_default='online'))
  `.execute(db)).rows;
  const hosts = new Map(rows.flatMap(row => {
    const hostname = knownFaviconForUrl(row.url);
    return hostname ? [[row.id, hostname] as const] : [];
  }));
  if (hosts.size === 0) return objects;
  const cached = (await sql<{ hostname: string; object_id: string }>`
    SELECT hostname, object_id FROM favicon_shared_domains
    WHERE hostname=ANY(${[...new Set(hosts.values())]}::text[]) AND object_id IS NOT NULL
  `.execute(db)).rows;
  const byHostname = new Map(cached.map(row => [row.hostname, row.object_id]));
  for (const [nodeId, hostname] of hosts) {
    const objectId = byHostname.get(hostname);
    if (objectId) objects.set(nodeId, objectId);
  }
  return objects;
}
