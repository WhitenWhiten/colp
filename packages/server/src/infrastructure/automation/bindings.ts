import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { bindingSemanticDigest, type BindingSet } from '@know-n/colp/automation';
import type { DatabaseSchema } from '../database/runtime.js';
import { authorizeCapability } from '../../modules/access-policy/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresMcpOwnedCollectionReadPort } from '../collections/index.js';
import type { BindingStore, BindingReadPort, AutomationActor } from '../../modules/automation/domain/bindings.js';

export function createBindingReadPort(db: Kysely<DatabaseSchema>, serverUuid: string): BindingReadPort {
  const accessPolicy = createPostgresAccessPolicyFactsPort(db);
  const canonical = createPostgresMcpOwnedCollectionReadPort({ db, accessPolicy });
  const authorized = async (actor: AutomationActor, collectionId: string) => (await authorizeCapability(accessPolicy, {
    collectionId, actor: { principalId: actor.accountId, subjectId: actor.subjectId, kind: 'account' }, capability: 'move_node',
  })).outcome === 'allow';
  return {
    async readCollection(actor, collectionId) {
      if (!await authorized(actor, collectionId)) return null;
      const collection = await canonical.readCollection({ actorSubjectId: actor.subjectId, collectionId });
      if (!collection) return null;
      const row = await db.selectFrom('collections').select('commit_ordinal').where('id', '=', collectionId).executeTakeFirstOrThrow();
      return { id: collection.id, rootNodeId: collection.rootNodeId, contentRevision: collection.contentRevision,
        policyRevision: collection.policyRevision, commitOrdinal: String(row.commit_ordinal) };
    },
    async readFolder(actor, folder) {
      if (folder.serverUuid !== serverUuid) return { status: 'blocked', code: 'scopeChanged', message: 'Folder belongs to another server.' };
      if (!await authorized(actor, folder.collectionId)) return { status: 'blocked', code: 'permissionRevoked', message: 'Current write authority is unavailable.' };
      const collection = await canonical.readCollection({ actorSubjectId: actor.subjectId, collectionId: folder.collectionId });
      const node = await canonical.readNode({ actorSubjectId: actor.subjectId, collectionId: folder.collectionId, nodeId: folder.nodeId });
      if (!collection || !node || node.kind !== 'folder') return { status: 'blocked', code: 'bindingDeleted', message: 'Restore this folder or choose another; same-name replacements are not rebound.' };
      const ancestors = [];
      const seen = new Set([folder.nodeId]);
      let current = node;
      while (current.id !== collection.rootNodeId) {
        if (!current.parentId || seen.has(current.parentId) || ancestors.length >= 128) return { status: 'blocked', code: 'scopeChanged', message: 'Live canonical ancestry is unavailable.' };
        seen.add(current.parentId);
        const parent = await canonical.readNode({ actorSubjectId: actor.subjectId, collectionId: folder.collectionId, nodeId: current.parentId });
        if (!parent || parent.kind !== 'folder') return { status: 'blocked', code: 'bindingDeleted', message: 'Restore the missing ancestor or choose another folder.' };
        ancestors.push({ ...folder, nodeId: parent.id }); current = parent;
      }
      return { status: 'valid', snapshot: { folder, title: node.title ?? '', revision: node.resourceRevision, ancestors, policyRevision: collection.policyRevision } };
    },
  };
}
export function createBindingStore(db: Kysely<DatabaseSchema>): BindingStore {
  const select = () => db.selectFrom('automation_binding_sets as b').innerJoin('automation_binding_revisions as r', (join) =>
    join.onRef('b.id', '=', 'r.binding_set_id').onRef('b.current_revision', '=', 'r.revision'))
    .select(['b.id', 'b.name', 'b.current_revision', 'b.updated_at', 'b.created_at', 'r.values_json']);
  const view = (row: Awaited<ReturnType<ReturnType<typeof select>['executeTakeFirstOrThrow']>>): BindingSet => ({
    id: row.id, revision: String(row.current_revision), name: row.name, values: row.values_json, updatedAt: row.updated_at.toISOString(),
  });
  return {
    async load(ownerId, id) { const row = await select().where('b.owner_id', '=', ownerId).where('b.id', '=', id).executeTakeFirst(); return row ? view(row) : null; },
    async save(ownerId, value) {
      if (value.revision === '1') await db.insertInto('automation_binding_sets').values({ id: value.id, owner_id: ownerId, rule_id: null, current_revision: '1', name: value.name }).execute();
      await db.insertInto('automation_binding_revisions').values({ binding_set_id: value.id, revision: value.revision, values_json: value.values, semantic_digest: bindingSemanticDigest(value.values) }).execute();
      await db.updateTable('automation_binding_sets').set({ current_revision: value.revision, name: value.name, updated_at: new Date(value.updatedAt) }).where('id', '=', value.id).where('owner_id', '=', ownerId).execute();
    },
    async list(ownerId, after, limit) {
      let query = select().where('b.owner_id', '=', ownerId);
      if (after) query = query.where(sql<boolean>`(b.created_at, b.id) > (${new Date(after.createdAt)}, ${after.id})`);
      return (await query.orderBy('b.created_at').orderBy('b.id').limit(limit).execute()).map((row) => ({ view: view(row), createdAt: row.created_at.toISOString() }));
    },
    async delete(ownerId, id) {
      const referenced = await db.selectFrom('automation_rule_revisions').select('id').where('binding_set_id', '=', id).executeTakeFirst();
      if (referenced) return false;
      await db.deleteFrom('automation_binding_sets').where('owner_id', '=', ownerId).where('id', '=', id).execute(); return true;
    },
  };
}
