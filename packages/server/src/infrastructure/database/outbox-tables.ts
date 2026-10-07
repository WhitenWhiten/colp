import type { Generated } from 'kysely';

/** Mutable delivery queue row; permanent identity is owned by OutboxDispatchClaimTable. */
export interface OutboxEventTable {
  outbox_id: string;
  domain_event_id: string;
  event_type: string;
  event_version: number;
  handler_name: string;
  handler_mode: 'projection_latest_only' | 'delivery_each_event';
  aggregate_scope: string | null;
  aggregate_revision: string | null;
  commit_ordinal: bigint | null;
  payload_json: Record<string, unknown>;
  state: 'pending' | 'leased' | 'retryable' | 'completed' | 'dead_letter';
  attempt_count: number;
  available_at: Date;
  locked_until: Date | null;
  lease_generation: bigint;
  completed_at: Date | null;
  last_error: string | null;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: Date;
  dead_lettered_at: Date | null;
}

/** Permanent identity fact retained after its mutable queue row is retired. */
export interface OutboxDispatchClaimTable {
  domain_event_id: string;
  handler_name: string;
  outbox_id: string;
  claimed_at: Generated<Date>;
}

/** Inclusive deletion authority for one handler/event/scope source stream. */
export interface OutboxRetentionFloorTable {
  handler_name: string;
  event_type: string;
  aggregate_scope: string;
  floor_commit_ordinal: Generated<bigint>;
  floor_domain_event_id: string | null;
  state_revision: Generated<bigint>;
  advanced_at: Generated<Date>;
}

/** Outbox-owned slice composed into the application-wide Kysely schema. */
export interface OutboxDatabaseSchema {
  outbox_events: OutboxEventTable;
  outbox_dispatch_claims: OutboxDispatchClaimTable;
  outbox_retention_floors: OutboxRetentionFloorTable;
}
