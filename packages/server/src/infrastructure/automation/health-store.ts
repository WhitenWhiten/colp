import { sql, type Kysely } from 'kysely';
import type { HealthIncident } from '@know-n/colp/automation';
import type { DatabaseSchema } from '../database/runtime.js';
import type { HealthStore } from '../../modules/automation/index.js';
const key = (incident: HealthIncident) => JSON.stringify([incident.role ?? 'runtime', incident.code, incident.dependencyRevision]);
export function createHealthStore(db: Kysely<DatabaseSchema>): HealthStore {
  return {
    async dependencies(revisionId) {
      const rows = await db.selectFrom('automation_dependencies').selectAll().where('rule_revision_id', '=', revisionId)
        .orderBy('role').orderBy('resource_kind').orderBy('resource_id').execute();
      return rows.map((row) => ({ role: row.role, kind: row.resource_kind === 'ancestor' ? 'ancestor' as const : 'folder' as const,
        resourceId: row.resource_id, revision: row.dependency_revision, snapshot: row.snapshot_json }));
    },
    async synchronize(ownerId, ruleId, expected) {
      const existing = await db.selectFrom('automation_incidents').selectAll().where('owner_id', '=', ownerId).where('rule_id', '=', ruleId).where('state', '!=', 'resolved').execute();
      const active = new Map(existing.map((row) => [key(row.incident_json), row]));
      const result: HealthIncident[] = [];
      for (const incident of expected) {
        const old = active.get(key(incident));
        const view = old ? { ...incident, id: old.id, state: old.state, firstSeenAt: old.first_seen.toISOString() } : incident;
        if (old) await db.updateTable('automation_incidents').set({ last_seen: new Date(view.lastSeenAt), incident_json: view }).where('id', '=', old.id).execute();
        else await db.insertInto('automation_incidents').values({ id: view.id, owner_id: ownerId, rule_id: ruleId, dependency_key: view.role ?? 'runtime',
          code: view.code, revision: view.dependencyRevision, severity: view.severity, state: view.state, incident_json: view,
          first_seen: new Date(view.firstSeenAt), last_seen: new Date(view.lastSeenAt) }).execute();
        result.push(view);
      }
      const retained = new Set(expected.map(key));
      for (const old of existing) if (!retained.has(key(old.incident_json))) await db.updateTable('automation_incidents').set({ state: 'resolved',
        incident_json: { ...old.incident_json, state: 'resolved' } }).where('id', '=', old.id).execute();
      return result;
    },
    async acknowledge(ownerId, id) {
      const row = await db.selectFrom('automation_incidents').selectAll().where('owner_id', '=', ownerId).where('id', '=', id).executeTakeFirst();
      if (!row) return null;
      const incident = { ...row.incident_json, state: row.state === 'resolved' ? 'resolved' as const : 'acknowledged' as const };
      await db.updateTable('automation_incidents').set({ state: incident.state, incident_json: incident }).where('id', '=', id).execute(); return incident;
    },
    async list(ownerId, after, limit) {
      let query = db.selectFrom('automation_incidents').select('incident_json').where('owner_id', '=', ownerId).where('state', '=', 'open');
      if (after) query = query.where(sql<boolean>`(first_seen,id) > (${after.createdAt}::timestamptz,${after.id})`);
      return (await query.orderBy('first_seen').orderBy('id').limit(limit).execute()).map((row) => row.incident_json);
    },
  };
}
