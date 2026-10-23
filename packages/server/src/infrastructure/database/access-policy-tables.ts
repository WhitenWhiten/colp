import type { Generated } from 'kysely';

export interface CollectionMemberTable {
  collection_id: string;
  subject_id: string;
  role: 'owner' | 'editor' | 'viewer';
  granted_at: Date;
  /** P-10: denormalized collections.updated_at; trigger/default fill it on insert. */
  collection_updated_at: Generated<Date>;
}

export interface CollectionInviteTable {
  id: string;
  collection_id: string;
  role: 'editor' | 'viewer';
  email_normalized: string;
  invited_subject_id: string | null;
  invited_by_subject_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expires_at: Date;
  created_at: Generated<Date>;
  resolved_at: Date | null;
  accepted_subject_id: string | null;
  collection_title_snapshot: string;
}

export interface CollectionInviteDeliveryTable {
  delivery_id: string;
  invite_id: string;
  state: 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';
  attempt_count: number;
  state_revision: bigint;
  next_attempt_at: Date;
  leased_until: Date | null;
  delivered_at: Date | null;
  suppressed_at: Date | null;
  dead_lettered_at: Date | null;
  last_error_category:
    | 'unknown_future_version'
    | 'invalid_contract'
    | 'retry_exhausted'
    | 'dependency'
    | 'provider_unavailable'
    | 'other'
    | 'not_configured'
    | null;
  provider_message_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CollectionPolicyTable {
  collection_id: string;
  policy_json: Record<string, unknown>;
  updated_at: Date;
}
