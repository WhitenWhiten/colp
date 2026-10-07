import type { Generated } from 'kysely';

export interface CreditAccountTable {
  account_id: string;
  last_sequence: Generated<bigint>;
  integrity_blocked: Generated<boolean>;
  integrity_issue_count: Generated<bigint>;
  created_at: Generated<Date>;
}

export interface CreditGrantTable {
  id: Generated<string>;
  account_id: string;
  grant_key: string;
  fingerprint: string;
  amount: bigint;
  reserved_amount: Generated<bigint>;
  spent_amount: Generated<bigint>;
  expired_amount: Generated<bigint>;
  valid_from: Date;
  expires_at: Date | null;
  expiry_processed_at: Date | null;
  source: 'operator' | 'scheduler' | 'system';
  reason_code: 'manual_grant' | 'trial_grant' | 'manual_refund';
  operator_note: string | null;
  created_at: Generated<Date>;
}

export type CreditChargeState = 'reserved' | 'settled' | 'released';

export interface CreditChargeTable {
  id: string;
  account_id: string;
  operation_key: string;
  fingerprint: string;
  operation_type: 'bookmark.classify';
  source: 'web' | 'extension' | 'batch' | 'system';
  price_version: string;
  quoted_amount: bigint;
  state: CreditChargeState;
  settled_amount: Generated<bigint>;
  refunded_amount: Generated<bigint>;
  task_kind: 'classification_preview' | 'classification_action';
  task_id: string;
  deadline_at: Date;
  created_at: Generated<Date>;
  completed_at: Date | null;
}

export interface CreditAllocationTable {
  account_id: string;
  charge_id: string;
  grant_id: string;
  amount: bigint;
}

export type CreditLedgerKind =
  | 'grant'
  | 'reserve'
  | 'spend'
  | 'release'
  | 'expire'
  | 'refund'
  | 'topup'
  | 'payment_refund';

export interface CreditLedgerEntryTable {
  id: Generated<string>;
  account_id: string;
  sequence: Generated<bigint>;
  event_key: string;
  fingerprint: string;
  kind: CreditLedgerKind;
  posted_at: Generated<Date>;
  effective_at: Date;
  points_delta: bigint;
  available_delta: bigint;
  reserved_delta: bigint;
  expired_points: bigint;
  available_after: bigint;
  reserved_after: bigint;
  operation_type: 'bookmark.classify' | 'credit.grant' | 'credit.expire' | 'credit.refund'
    | 'credit.topup' | 'credit.payment_refund';
  source: 'extension' | 'web' | 'batch' | 'operator' | 'scheduler' | 'system' | 'payment';
  reason_code:
    | 'trial_grant'
    | 'manual_grant'
    | 'classification_requested'
    | 'classification_completed'
    | 'classification_failed'
    | 'classification_cancelled'
    | 'classification_unneeded'
    | 'credits_expired'
    | 'hold_expired'
    | 'manual_refund'
    | 'payment_received'
    | 'payment_refunded';
  grant_id: string | null;
  charge_id: string | null;
  related_entry_id: string | null;
  expires_at: Date | null;
  task_json: Record<string, unknown> | null;
}

export interface CreditDatabaseSchema {
  credit_accounts: CreditAccountTable;
  credit_grants: CreditGrantTable;
  credit_charges: CreditChargeTable;
  credit_allocations: CreditAllocationTable;
  credit_ledger_entries: CreditLedgerEntryTable;
}
