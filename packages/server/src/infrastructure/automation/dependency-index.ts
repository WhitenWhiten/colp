import type { RoleBindings } from '@know-n/colp/automation';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import type { FolderResolution } from '../../modules/automation/index.js';
export function createDependencyIndex(db: Kysely<DatabaseSchema>) {
  return {
    async replace(ruleRevisionId: string, resolutions: Record<string, FolderResolution>, values?: RoleBindings) {
      const previous = await db.selectFrom('automation_dependencies').selectAll().where('rule_revision_id', '=', ruleRevisionId).execute();
      await db.deleteFrom('automation_dependencies').where('rule_revision_id', '=', ruleRevisionId).execute();
      for (const [role, resolution] of Object.entries(resolutions)) {
        const { snapshot } = resolution;
        if (!snapshot) {
          const binding = values?.[role];
          const oldFolder = previous.find((row) => row.role === role && row.resource_kind === 'folder');
          if (binding?.kind === 'folder') {
            const preserved = oldFolder?.resource_id === binding.folder.nodeId ? previous.filter((row) => row.role === role) : [];
            if (preserved.length) await db.insertInto('automation_dependencies').values(preserved).execute();
            else await db.insertInto('automation_dependencies').values({ rule_revision_id: ruleRevisionId, role, resource_kind: 'folder',
              resource_id: binding.folder.nodeId, dependency_revision: 'unavailable', stage: 'intake', snapshot_json: { folder: binding.folder } }).execute();
          }
          continue;
        }
        // A live folder outside its allowed subtree still needs ancestor events to recover.
        for (const ref of [snapshot.folder, ...snapshot.ancestors]) {
          await db.insertInto('automation_dependencies').values({ rule_revision_id: ruleRevisionId, role,
            resource_kind: ref.nodeId === snapshot.folder.nodeId ? 'folder' : 'ancestor', resource_id: ref.nodeId,
            dependency_revision: snapshot.revision, stage: 'intake', snapshot_json: { ...snapshot, folder: ref } }).execute();
        }
      }
    },
    async affected(resourceIds: readonly string[]): Promise<{ ownerId: string; ruleId: string }[]> {
      if (!resourceIds.length) return [];
      const rows = await db.selectFrom('automation_dependencies as d').innerJoin('automation_rule_revisions as v', 'v.id', 'd.rule_revision_id')
        .innerJoin('automation_rules as r', 'r.current_revision_id', 'v.id').select(['r.owner_id', 'r.id']).distinct()
        .where('d.resource_id', 'in', [...resourceIds]).execute();
      return rows.map((row) => ({ ownerId: row.owner_id, ruleId: row.id }));
    },
  };
}
