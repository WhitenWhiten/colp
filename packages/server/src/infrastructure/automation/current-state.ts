import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { EventFacts, RuleDefinition, RoleBindings } from '@know-n/colp/automation';
import { automationDigest, normalizeUrl } from '@know-n/colp/automation';
import type { DatabaseSchema } from '../database/runtime.js';
import type { AutomationActor, BindingReadPort } from '../../modules/automation/index.js';
import { scopeCollectionId } from '../../modules/automation/index.js';
import { AutomationError } from '../../modules/automation/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresMcpOwnedCollectionReadPort } from '../collections/index.js';
import type { CurrentSample } from '../../modules/automation/index.js';

/** Bounded selection, then the existing canonical node reader. This is never event-time history. */
export async function readCurrentSample(db: Kysely<DatabaseSchema>, reads: BindingReadPort, serverUuid: string,
  actor: AutomationActor, definition: RuleDefinition, values: RoleBindings, selection?: { folderId: string; includeDescendants: boolean; limit: number }): Promise<CurrentSample> {
  const collectionId = scopeCollectionId(definition, values);
  const collection = collectionId ? await reads.readCollection(actor, collectionId) : null;
  if (!collection || !collectionId) throw new AutomationError('resource_not_found', 'Authorized rule scope is unavailable.');
  const binding = values[definition.scope.folderRole ?? ''];
  const folderId = selection?.folderId ?? (binding?.kind === 'folder' ? binding.folder.nodeId : null);
  const limit=selection?.limit ?? 200;
  // Recursive selection is bounded by the canonical collection's tree capacity. Materialize only 201 IDs.
  const selected = await sql<{ id: string; resource_revision: string; tags: unknown }>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM nodes WHERE collection_id=${collectionId} AND id=${folderId} AND deleted_at IS NULL
      UNION
      SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id=s.id
        WHERE n.collection_id=${collectionId} AND n.deleted_at IS NULL AND ${selection?.includeDescendants ?? definition.scope.includeDescendants === true}
    )
    SELECT id,resource_revision,tags FROM nodes WHERE collection_id=${collectionId} AND kind='bookmark' AND deleted_at IS NULL
      AND (${folderId}::text IS NULL OR parent_id IN (SELECT id FROM subtree))
    ORDER BY created_at DESC,id DESC LIMIT ${limit+1}
  `.execute(db);
  const canonical = createPostgresMcpOwnedCollectionReadPort({ db, accessPolicy: createPostgresAccessPolicyFactsPort(db) });
  const events: EventFacts[] = [], revisions: Record<string, string> = { collectionPolicy: collection.policyRevision };
  for (const selectedNode of selected.rows.slice(0, limit)) {
    const node = await canonical.readNode({ actorSubjectId: actor.subjectId, collectionId, nodeId: selectedNode.id });
    if (!node || node.kind !== 'bookmark') throw new AutomationError('automation_stale_input', 'A sampled bookmark became unavailable.');
    const normalized = normalizeUrl(node.url ?? '');
    const ancestors = [];
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId) {
      if (ancestors.length >= 128 || seen.has(parentId))
        throw new AutomationError('automation_binding_unavailable', 'Complete current ancestry exceeds the facts bound or contains a cycle.');
      seen.add(parentId);
      const parent = await canonical.readNode({ actorSubjectId: actor.subjectId, collectionId, nodeId: parentId });
      if (!parent || parent.kind !== 'folder')
        throw new AutomationError('automation_binding_unavailable', 'Complete current ancestry is unavailable.');
      ancestors.push({ serverUuid, collectionId, nodeId: parent.id }); parentId = parent.parentId;
    }
    if (ancestors.at(-1)?.nodeId !== collection.rootNodeId)
      throw new AutomationError('automation_binding_unavailable', 'Current ancestry does not reach the canonical root.');
    // Canonical IDs may already occupy all 128 characters of the facts ID bound.
    const snapshotId = `current_${automationDigest({ serverUuid, collectionId, nodeId: node.id })}`;
    events.push({ eventId: snapshotId, operationId: snapshotId, type: 'node.created', collectionId, nodeId: node.id,
      commitOrdinal: collection.commitOrdinal, occurredAt: node.createdAt.toISOString(), origin: 'user', changedFields: ['create'], hopCount: 0,
      intakeDisposition: 'unknown', bookmark: { kind: 'bookmark', url: normalized.status === 'available' ? { host: normalized.host, path: normalized.path } : { host: '' },
        title: node.title, tags: Array.isArray(selectedNode.tags) ? selectedNode.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        nodeId: node.id, ...(node.parentId ? { parent: { serverUuid, collectionId, nodeId: node.parentId } } : {}), ancestors } });
    revisions[node.id] = node.resourceRevision;
  }
  return { events, truncated: selected.rows.length > limit, revisions };
}
