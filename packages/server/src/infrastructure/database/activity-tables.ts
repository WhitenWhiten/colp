import type { Generated } from 'kysely';
export interface ActivityDatabaseSchema {
  activity_items: {
    id: string; account_id: string; kind: string; source_key: string; agent_client_id: string | null;
    collection_id: string | null; run_id: string | null; plan_id: string | null; count: Generated<number>; details_json: Generated<Record<string, unknown>>;
    created_at: Generated<Date>; revision: Generated<string>; occurred_at: Generated<Date>; updated_at: Generated<Date>; read_at: Date | null;
  };
  activity_members: {
    source_event_id: string; activity_id: string; collection_id: string; node_id: string; parent_id: string | null;
    operation_id: string; occurred_at: Date;
  };
}
