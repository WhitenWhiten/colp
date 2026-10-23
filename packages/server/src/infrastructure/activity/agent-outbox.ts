import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { defineClosedPayloadValidator, type EventPayloadRegistration } from '../outbox/envelope.js';
import type { OutboxHandlerContext, OutboxRoute } from '../outbox/router.js';
import { selectOpenAgentItem } from '../../modules/activity/index.js';

export const ACTIVITY_AGENT_EVENT = 'activity.agent_bookmark_created';
export const ACTIVITY_AGENT_HANDLER = 'activity_agent';
let enabled = false;
export function setAgentActivityEnabled(value: boolean): void { enabled = value; }
export function agentActivityEnabled(): boolean { return enabled; }
const text = (value: unknown) => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown) => value === null || text(value);
const validate = defineClosedPayloadValidator({ collectionId: text, nodeId: text, operationId: text,
  agentClientId: nullableText, credentialBindingId: nullableText,
  occurredAt: value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value)) });
export const activityAgentRegistration: EventPayloadRegistration = { eventType: ACTIVITY_AGENT_EVENT, eventVersion: 1, validatePayload: validate };
interface AgentEvent { collectionId: string; nodeId: string; operationId: string; agentClientId: string | null;
  credentialBindingId: string | null; occurredAt: string }
export async function appendAgentActivityOutbox(tx: DatabaseTransaction,
  event: { domainEventId: string; operationId: string; collectionId: string; commitOrdinal: bigint },
  input: { mutation: { action: string; target: { resourceId: string }; fields?: { kindFields: { readonly [key: string]: unknown } } };
    automationContext?: { origin: string; agent?: { clientId: string; credentialBindingId: string } } }): Promise<void> {
  if (!agentActivityEnabled() || input.automationContext?.origin !== 'mcp' || input.mutation.action !== 'create'
    || input.mutation.fields?.kindFields.kind !== 'bookmark') return;
  // Facts capture precedes the projection append that normally reserves this shared domain event.
  const reserved = await tx.insertInto('resource_id_ledger').values({ resource_id: event.domainEventId, resource_type: 'domain-event' })
    .onConflict(conflict => conflict.column('resource_id').doNothing()).returning('resource_type').executeTakeFirst();
  if (!reserved) {
    const existing = await tx.selectFrom('resource_id_ledger').select('resource_type').where('resource_id', '=', event.domainEventId).executeTakeFirst();
    if (existing?.resource_type !== 'domain-event') throw new Error('Activity domain event reservation conflicts with another resource');
  }
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now;
  const id = randomUUID(), agent = input.automationContext?.agent;
  const payload: AgentEvent = { collectionId: event.collectionId, nodeId: input.mutation.target.resourceId,
    operationId: event.operationId, agentClientId: agent?.clientId ?? null, credentialBindingId: agent?.credentialBindingId ?? null,
    occurredAt: now.toISOString() };
  await sql`WITH reserved AS (INSERT INTO resource_id_ledger(resource_id,resource_type) VALUES (${id},'outbox') RETURNING resource_id)
    INSERT INTO outbox_events(outbox_id,domain_event_id,event_type,event_version,handler_name,handler_mode,
      aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,commit_ordinal,payload_json,state,attempt_count,
      available_at,occurred_at,locked_until,lease_generation,completed_at,last_error,dead_lettered_at)
    SELECT resource_id,${event.domainEventId},${ACTIVITY_AGENT_EVENT},1,${ACTIVITY_AGENT_HANDLER},'delivery_each_event',
      'collection',${event.collectionId},${event.collectionId},NULL,${event.commitOrdinal},${JSON.stringify(payload)}::jsonb,
      'pending',0,clock_timestamp(),${now},NULL,0,NULL,NULL,NULL FROM reserved`.execute(tx);
}
async function verifyLease(tx: DatabaseTransaction, context: OutboxHandlerContext): Promise<void> {
  const lease = await tx.selectFrom('outbox_events').select('outbox_id').where('outbox_id', '=', context.attempt!.outboxId)
    .where('domain_event_id', '=', context.envelope.event_id).where('handler_name', '=', ACTIVITY_AGENT_HANDLER)
    .where('state', '=', 'leased').where('lease_generation', '=', BigInt(context.attempt!.leaseGeneration))
    .where('locked_until', '>', sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
  if (!lease || context.signal.aborted) throw new Error('Activity source lease lost');
}
export function createActivityAgentRoute(db: Kysely<DatabaseSchema>): OutboxRoute {
  return { handlerName: ACTIVITY_AGENT_HANDLER, handlerMode: 'delivery_each_event', eventType: ACTIVITY_AGENT_EVENT,
    eventVersion: 1, sideEffectDurability: 'durable', async handle(context) {
      if (!context.attempt || context.signal.aborted || !validate(context.envelope.payload)
        || context.envelope.aggregate_identity.aggregate_scope !== context.envelope.payload.collectionId
        || context.envelope.aggregate_identity.aggregate_id !== context.envelope.payload.collectionId
        || context.envelope.aggregate_identity.aggregate_type !== 'collection' || !context.envelope.commit_ordinal)
        throw new Error('Invalid activity source delivery');
      const payload = context.envelope.payload as unknown as AgentEvent;
      await db.transaction().execute(async tx => {
        // The account row also serializes the first aggregate, before any activity row exists.
        const owner = await tx.selectFrom('collections as c').innerJoin('accounts as a', 'a.subject_id', 'c.owner_subject_id')
          .select(['a.id', 'a.status', 'a.deleted_at']).where('c.id', '=', payload.collectionId).forUpdate('a').executeTakeFirst();
        if (owner?.status === 'active' && !owner.deleted_at) {
          const duplicate = await tx.selectFrom('activity_members').select('source_event_id')
            .where('source_event_id', '=', context.envelope.event_id).executeTakeFirst();
          if (!duplicate) {
            const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now;
            const candidates = (await sql<{ id: string; occurred_at: Date; read_at: Date | null }>`SELECT id,occurred_at,read_at
              FROM activity_items WHERE account_id=${owner.id} AND kind='agent_bookmarks_added'
                AND agent_client_id IS NOT DISTINCT FROM ${payload.agentClientId} AND collection_id=${payload.collectionId}
                AND read_at IS NULL AND occurred_at>clock_timestamp()-interval '24 hours' ORDER BY updated_at DESC,id DESC FOR UPDATE`.execute(tx)).rows;
            const open = selectOpenAgentItem(candidates.map(row => ({ id: row.id, occurredAt: row.occurred_at, readAt: row.read_at })), now);
            const activityId = open?.id ?? randomUUID();
            if (!open) await sql`INSERT INTO activity_items(id,account_id,kind,source_key,agent_client_id,collection_id,occurred_at)
              VALUES(${activityId},${owner.id},'agent_bookmarks_added',${`agent:${payload.agentClientId ?? 'unknown'}:${payload.collectionId}:${activityId}`},
                ${payload.agentClientId},${payload.collectionId},${payload.occurredAt}::timestamptz)`.execute(tx);
            const inserted = await sql`INSERT INTO activity_members(source_event_id,activity_id,collection_id,node_id,parent_id,operation_id,occurred_at)
              VALUES(${context.envelope.event_id},${activityId},${payload.collectionId},${payload.nodeId},
                (SELECT parent_id FROM nodes WHERE id=${payload.nodeId} AND collection_id=${payload.collectionId}),
                ${payload.operationId},${payload.occurredAt}::timestamptz) ON CONFLICT(source_event_id) DO NOTHING RETURNING source_event_id`.execute(tx);
            if (inserted.rows.length) await sql`UPDATE activity_items SET count=count+1,revision=revision+1,updated_at=clock_timestamp()
              WHERE id=${activityId}`.execute(tx);
          }
        }
        await verifyLease(tx, context);
      });
    } };
}
