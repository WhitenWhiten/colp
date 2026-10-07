import type { GeneratedAlways } from 'kysely';
import type { Subscription, Mapping, ExitPreview, ExitTask, ActionReceipt, SnapshotDescriptor, SourceProjection } from '../../modules/bookmark-subscriptions/index.js';
export interface BookmarkSubscriptionsDatabaseSchema {
  bookmark_subscription_snapshot_guards: {account_id:string;revision:string};
  bookmark_subscriptions: { id: string; account_id: string; source_type: string; source_id: string; status: string; created_at: Date; document: Subscription };
  bookmark_subscription_mappings: { id: string; account_id: string; subscription_id: string; source_type: string; source_id: string; profile_id: string; status: string; created_at: Date; document: Mapping };
  bookmark_subscription_exit_previews: { id: string; account_id: string; expires_at: Date; document: ExitPreview; selection_revision: string|null };
  bookmark_subscription_actions: { id: string; account_id: string; mapping_id: string; generation: string; profile_id: string; sequence: GeneratedAlways<bigint>; document: ExitTask; receipt: ActionReceipt | null };
  bookmark_subscription_snapshots: { id: string; account_id: string; expires_at: Date; size_bytes: number; descriptor: SnapshotDescriptor; projection: SourceProjection };
}
