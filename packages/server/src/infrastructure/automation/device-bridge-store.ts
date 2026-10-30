import { sql, type Kysely } from 'kysely';
import { automationDigest, boundedJson } from '@know-n/colp/automation';
import { AutomationError, type AutomationDeviceActor } from '../../modules/automation/index.js';
import { DEVICE_BRIDGE_OPERATIONS, type DeviceBridgeOwnerPort, type DeviceBridgeDevicePort,
  type DeviceBridgeView, type DeviceBridgeRequest } from '../../modules/automation/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
interface Row { id: string; owner_id: string; replica_id: string; replica_generation: string; collection_id: string;
  operation: DeviceBridgeRequest['operation']; fingerprint: string; input_json: DeviceBridgeRequest['input']; state: 'pending' | 'running' | 'done' | 'failed';
  result_json: unknown; expires_at: Date; expired: boolean }
const unavailable = () => new AutomationError('resource_not_found', 'Device request is unavailable under current account and replica authority.');
const view = (r: Row): DeviceBridgeView => ({ requestId: r.id, replicaId: r.replica_id, operation: r.operation,
  state: r.expired && (r.state === 'pending' || r.state === 'running') ? 'expired' : r.state, expiresAt: r.expires_at.toISOString(), result: r.result_json });
export function createDeviceBridgeOwnerPort(db: Kysely<DatabaseSchema>): DeviceBridgeOwnerPort {
  return {
    request: (actor, operation, args) => db.transaction().execute(async tx => {
      if (!DEVICE_BRIDGE_OPERATIONS.includes(operation) || !boundedJson(args)) throw new AutomationError('invalid_request','Invalid device operation.');
      const account = await tx.selectFrom('accounts').select('id').where('id','=',actor.accountId).where('subject_id','=',actor.subjectId)
        .where('status','=','active').where('deleted_at','is',null).forUpdate().executeTakeFirst();
      if (!account) throw unavailable();
      const replica = (await sql<{ collection_id: string; lease_generation: string }>`SELECT r.collection_id,r.lease_generation::text
        FROM sync_replicas r JOIN collections c ON c.id=r.collection_id WHERE r.replica_id=${String(args.replicaId)} AND r.account_id=${actor.accountId}
        AND r.status IN ('active','recovery_required') AND c.owner_subject_id=${actor.subjectId} AND c.deleted_at IS NULL`.execute(tx)).rows[0];
      if (!replica) throw unavailable();
      const fingerprint = automationDigest({ clientId: actor.clientId, binding: actor.credentialBindingId, operation, args });
      const old = (await sql<Row>`SELECT *,expires_at<=clock_timestamp() AS expired FROM automation_device_requests WHERE id=${String(args.commandId)} AND owner_id=${actor.accountId}`.execute(tx)).rows[0];
      if (old) { if (old.fingerprint !== fingerprint) throw new AutomationError('automation_command_conflict','Device command identity was reused.'); return view(old); }
      const count = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM automation_device_requests WHERE owner_id=${actor.accountId}
        AND state IN ('pending','running') AND expires_at>clock_timestamp()`.execute(tx)).rows[0]!.n;
      if (count >= 64) throw new AutomationError('rate_limited','Too many browser requests are still outstanding.');
      // Expired results have a fixed retention; never remove work that may still execute.
      await sql`DELETE FROM automation_device_requests WHERE owner_id=${actor.accountId} AND expires_at<clock_timestamp()-interval '30 days'`.execute(tx);
      const { replicaId: _, commandId: __, ...input } = args;
      const row = (await sql<Row>`INSERT INTO automation_device_requests(id,owner_id,replica_id,replica_generation,collection_id,operation,fingerprint,input_json,state)
        VALUES(${String(args.commandId)},${actor.accountId},${String(args.replicaId)},${replica.lease_generation}::bigint,${replica.collection_id},${operation},${fingerprint},${JSON.stringify(input)}::jsonb,'pending')
        ON CONFLICT(id) DO NOTHING RETURNING *,false AS expired`.execute(tx)).rows[0]!;
      if (!row) throw new AutomationError('automation_command_conflict','Device command identity was reused.');
      return view(row);
    }),
    async get(actor,id) {
      const row = (await sql<Row>`SELECT q.*,q.expires_at<=clock_timestamp() AS expired FROM automation_device_requests q JOIN accounts a ON a.id=q.owner_id
        WHERE q.id=${id} AND q.owner_id=${actor.accountId} AND a.subject_id=${actor.subjectId} AND a.status='active' AND a.deleted_at IS NULL`.execute(db)).rows[0];
      if (!row) throw unavailable(); return view(row);
    },
  };
}
export function deviceBridgeDevicePort(tx: DatabaseTransaction, actor: AutomationDeviceActor): DeviceBridgeDevicePort {
  return {
    async pending() {
      const rows = (await sql<Row>`UPDATE automation_device_requests SET state='running' WHERE id IN (
        SELECT id FROM automation_device_requests WHERE owner_id=${actor.accountId} AND replica_id=${actor.replicaId}
          AND replica_generation=${actor.replicaGeneration}::bigint AND collection_id=${actor.collectionId}
          AND state IN ('pending','running') AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 8 FOR UPDATE)
        RETURNING *`.execute(tx)).rows;
      return { items: rows.map(r => ({ id: r.id, replicaId: r.replica_id, collectionId: r.collection_id,
        operation: r.operation, input: r.input_json, expiresAt: r.expires_at.toISOString() })) };
    },
    async complete(body) {
      if (!boundedJson(body) || !body || typeof body !== 'object' || Array.isArray(body)) throw new AutomationError('invalid_request','Invalid browser result.');
      const r = body as Record<string, unknown>;
      if (typeof r.requestId !== 'string' || (r.state !== 'done' && r.state !== 'failed') || !Object.hasOwn(r,'result')
        || Object.keys(r).some(k => !['requestId','state','result'].includes(k))) throw new AutomationError('invalid_request','Invalid browser result.');
      const rows = (await sql`UPDATE automation_device_requests SET state=${String(r.state)},result_json=${JSON.stringify(r.result)}::jsonb
        WHERE id=${r.requestId} AND owner_id=${actor.accountId} AND replica_id=${actor.replicaId} AND replica_generation=${actor.replicaGeneration}::bigint
          AND collection_id=${actor.collectionId} AND state='running' AND expires_at>clock_timestamp() RETURNING id`.execute(tx)).rows;
      return { recorded: rows.length > 0 };
    },
  };
}
