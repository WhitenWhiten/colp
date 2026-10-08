import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { normalizeClassificationHostname, type CaptureMemoryEvidence } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
interface Source {
  page: string; hostname: string; kind: string; folder: string | null; taxonomy: string; received: Date; ordering: string; eligible: boolean;
  correction: { beforeParentId: string; afterParentId: string; beforeTags: string[]; afterTags: string[] } | null;
  current_parent: string | null;
}
export async function captureMemorySources(tx: DatabaseTransaction, input: { accountId: string; collectionId: string; ownerSubjectId: string; url: string }): Promise<Source[]> {
  const hostname = normalizeClassificationHostname(input.url); if (!hostname) return [];
  const preference = await tx.selectFrom('bookmark_preferences').select('learn_from_corrections').where('account_id', '=', input.accountId).executeTakeFirst();
  if (preference?.learn_from_corrections === false) return [];
  const rows = await sql<Source>`SELECT d.original_url AS page,d.original_hostname AS hostname,e.kind,
      d.result_json->>'parentId' AS folder,coalesce(x.content_revision,'') AS taxonomy,e.received_at AS received,
      to_char(e.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ordering,
      e.learning_eligible AND e.evidence_generation=coalesce(l.generation,0) AS eligible,e.correction_json AS correction,n.parent_id AS current_parent
    FROM bookmark_capture_decisions d JOIN collections c ON c.id=d.collection_id AND c.owner_subject_id=${input.ownerSubjectId} AND c.deleted_at IS NULL
    JOIN nodes n ON n.id=d.node_id AND n.collection_id=d.collection_id AND n.deleted_at IS NULL
    LEFT JOIN classification_provider_executions x ON x.id=d.execution_id
    LEFT JOIN bookmark_capture_learning l ON l.account_id=d.account_id
    JOIN LATERAL (SELECT e.* FROM bookmark_capture_feedback e WHERE e.account_id=d.account_id AND e.decision_id=d.id
      AND ((e.event_id=d.effective_event_id AND e.kind IN ('explicit_positive','explicit_negative','correction_applied'))
        OR (e.kind='withdrawn' AND coalesce(d.effective_feedback,'') NOT IN ('explicit_positive','explicit_negative','correction_applied')))
      ORDER BY e.revision DESC LIMIT 1) e ON true
    WHERE d.account_id=${input.accountId} AND d.collection_id=${input.collectionId} AND d.original_hostname=${hostname}
      AND d.original_url IS NOT NULL AND e.received_at>clock_timestamp()-interval '180 days'
    ORDER BY e.received_at DESC,d.id LIMIT 10001`.execute(tx);
  if (rows.rows.length > 10000) return [];
  const legacy = await sql<{ page: string; bookmark_key: string; folder: string; taxonomy: string; received: Date; ordering: string }>`
    SELECT n.url AS page,e.bookmark_key,e.folder_id AS folder,e.taxonomy_revision AS taxonomy,e.created_at AS received,
      to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ordering
    FROM collection_classification_evidence e JOIN nodes n ON n.id=e.node_id AND n.collection_id=e.collection_id
    JOIN collections c ON c.id=e.collection_id AND c.owner_subject_id=${input.ownerSubjectId} AND c.deleted_at IS NULL
    LEFT JOIN bookmark_capture_learning l ON l.account_id=${input.accountId}
    WHERE e.owner_subject_id=${input.ownerSubjectId} AND e.collection_id=${input.collectionId} AND e.hostname=${hostname}
      AND e.bookmark_key IS NOT NULL AND e.evidence_generation=coalesce(l.generation,0)
      AND n.deleted_at IS NULL AND n.kind='bookmark' AND n.url IS NOT NULL AND n.parent_id=e.folder_id AND e.created_at>clock_timestamp()-interval '180 days'
    ORDER BY e.created_at DESC,e.evidence_id LIMIT 10001`.execute(tx);
  if (legacy.rows.length > 10000) return [];
  const sources = [...rows.rows, ...legacy.rows.filter(row => createHash('sha256').update(row.page).digest('hex') === row.bookmark_key).map(row => ({ ...row, hostname,
    kind: 'explicit_positive', eligible: true, correction: null, current_parent: row.folder }))];
  const latest = new Map<string, Source>();
  for (const row of sources.sort((a, b) => b.ordering.localeCompare(a.ordering))) if (!latest.has(row.page)) latest.set(row.page, row);
  return [...latest.values()];
}
export async function readCapturePreferenceEvidence(tx: DatabaseTransaction, input: Parameters<typeof captureMemorySources>[1]): Promise<CaptureMemoryEvidence[]> {
  const sources = await captureMemorySources(tx, input), evidence: CaptureMemoryEvidence[] = [];
  for (const row of sources) {
    if (!row.eligible) continue;
    const add = (folderId: string, positive: number, negative: number) => evidence.push({ folderId, positive, negative,
      pageKey: createHash('sha256').update(row.page).digest('hex'), taxonomyRevision: row.taxonomy, receivedAt: row.received.toISOString() });
    if (row.kind === 'explicit_positive' && row.folder && row.current_parent === row.folder) add(row.folder, 1, 0);
    if (row.kind === 'correction_applied' && row.correction && row.correction.beforeParentId !== row.correction.afterParentId
      && row.current_parent === row.correction.afterParentId) { add(row.correction.beforeParentId, 0, 1); add(row.correction.afterParentId, 2, 0); }
  }
  return evidence;
}
