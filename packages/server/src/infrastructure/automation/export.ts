import type { AutomationExport } from '@know-n/colp/automation';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresCollectionExportReadPort } from '../collections/collection-export-postgres.js';
import { buildAutomationExport } from '../../modules/automation/index.js';

/** Owner-private export of current configuration (archived history does not consume a rule slot); folder paths are non-authoritative installation hints only. */
export async function exportAutomations(db: Kysely<DatabaseSchema>, ownerId: string): Promise<AutomationExport> {
  if (!db.isTransaction) return db.transaction().setIsolationLevel('repeatable read').execute((tx) => exportAutomations(tx, ownerId));
  const owner = await db.selectFrom('accounts').select(['subject_id', 'status']).where('id', '=', ownerId).executeTakeFirst();
  if (!owner) return buildAutomationExport([], new Date());
  if (owner.status !== 'active') throw new Error('Active export owner required.');
  const rules = await db.selectFrom('automation_rules as r').innerJoin('automation_rule_revisions as v', 'v.id', 'r.current_revision_id')
    .innerJoin('automation_binding_sets as b', 'b.id', 'v.binding_set_id')
    .innerJoin('automation_binding_revisions as br', (join) => join.onRef('br.binding_set_id', '=', 'b.id').onRef('br.revision', '=', 'b.current_revision'))
    .select(['v.definition_json', 'r.desired_state', 'br.values_json']).where('r.owner_id', '=', ownerId)
    .where('b.owner_id', '=', ownerId).where('r.desired_state', '!=', 'archived').orderBy('r.created_at').orderBy('r.id').limit(501).execute();
  const reads = createPostgresCollectionExportReadPort(db);
  const rows = [];
  for (const row of rules) {
    const paths: Record<string, string> = {};
    const scopeBinding = row.values_json[row.definition_json.scope.folderRole ?? ''];
    const collectionId = row.definition_json.scope.collectionId ?? (scopeBinding?.kind === 'folder' ? scopeBinding.folder.collectionId : undefined);
    const source = collectionId ? await reads.loadForPrincipal({ collectionId, subjectId: owner.subject_id }) : null;
    if (source) {
      const nodes = new Map(source.nodes.map((node) => [node.id, node]));
      for (const [role, binding] of Object.entries(row.values_json)) {
        if (binding.kind !== 'folder' || binding.folder.collectionId !== source.id) continue;
        const parts: string[] = [], seen = new Set<string>();
        let current: string | null = binding.folder.nodeId;
        let live = true;
        while (current && current !== source.rootNodeId) {
          if (seen.has(current)) { live = false; break; } seen.add(current);
          const node = nodes.get(current);
          if (!node || node.kind !== 'folder') { live = false; break; }
          parts.unshift(node.title ?? ''); current = node.parentId;
        }
        if (live && current === source.rootNodeId) paths[role] = `/${parts.join('/')}`;
      }
    }
    rows.push({ definition: row.definition_json, desiredState: row.desired_state, bindingsByPath: paths });
  }
  return buildAutomationExport(rows, new Date());
}
