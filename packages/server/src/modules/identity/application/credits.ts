/** Account-owned financial operations. Every method participates in its caller's transaction. */
export const CLASSIFICATION_CREDIT_PRICE = Object.freeze({
  operationType: 'bookmark.classify',
  priceVersion: 'bookmark-classify.v1',
  unitPoints: 1,
} as const);
export const MAX_CREDIT_POINTS = 2_147_483_647;

export type CreditFailureCode =
  | 'billing_consent_required' | 'credit_price_changed' | 'credit_limit_exceeded'
  | 'insufficient_credits' | 'credits_busy' | 'credits_reconciling' | 'credits_unavailable';

export interface CreditQuoteContext {
  readonly requiredPoints: number;
  readonly availablePoints: number;
  readonly maxPoints: number;
  readonly priceVersion: string;
}

export class CreditError extends Error {
  constructor(readonly code: CreditFailureCode, readonly creditContext?: CreditQuoteContext, options?: ErrorOptions) {
    super(code, options);
    this.name = 'CreditError';
  }
}

export interface CreditReservation {
  readonly chargeId: string;
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly amount: number;
  readonly source: 'web' | 'extension' | 'batch' | 'system';
  readonly priceVersion: string;
  readonly ownerKind: 'classification_preview' | 'classification_action';
  readonly ownerId: string;
  readonly task: {
    readonly kind: CreditReservation['ownerKind'];
    readonly collectionId: string;
    readonly nodeId: string | null;
    readonly runId: string | null;
    readonly actionId: string | null;
  };
  readonly deadlineAt: string;
}

export interface CreditBalanceFacts {
  readonly available: number;
  readonly reserved: number;
  readonly nextExpiryAt: string | null;
  readonly expiringPoints: number;
  readonly lastSequence: string;
}

export interface CreditReconciliation {
  readonly processed: number;
  readonly hasMore: boolean;
  readonly lastSequence: string;
}

export interface CreditChargeTotals {
  readonly quoted: number;
  readonly reserved: number;
  readonly settled: number;
  readonly released: number;
}

export type CreditReleaseReason = 'classification_failed' | 'classification_cancelled'
  | 'classification_unneeded' | 'hold_expired';

/**
 * One port is bound to one account and one READ COMMITTED transaction.
 * lock() is L0/L1 and must precede receipts or business locks. The caller owns
 * task fencing and commit; financial completion alone cannot end a task.
 */
export interface AccountCreditsPort {
  lock(options?: { readonly allowInactive?: boolean }): Promise<Date>;
  /** L6 locks for multi-charge completion; requires lock() and business locks first. */
  lockFinancialRows(): Promise<void>;
  reconcile(asOf?: Date | string): Promise<CreditReconciliation>;
  /** Production decisions pass clock_timestamp()::text to retain PostgreSQL microseconds. */
  balance(asOf: Date | string): Promise<CreditBalanceFacts>;
  hasExpiryBacklog(asOf: Date | string): Promise<boolean>;
  isReserved(chargeId: string): Promise<boolean>;
  /** Read-only aggregation also supports the caller's REPEATABLE READ run snapshot. */
  totals(chargeIds: readonly string[]): Promise<CreditChargeTotals>;
  reserve(input: CreditReservation): Promise<string>;
  settle(chargeId: string): Promise<boolean>;
  release(chargeId: string, reason: CreditReleaseReason): Promise<boolean>;
}

/** Returns a stable refusal for the receipt owner to COMMIT, rather than throwing it away. */
export function checkClassificationCreditConsent(
  billing: { readonly priceVersion: string; readonly maxPoints: number } | undefined,
  requiredPoints: number,
  availablePoints: number,
): CreditError | null {
  if (!Number.isSafeInteger(requiredPoints) || requiredPoints < 1 || requiredPoints > 50
    || !Number.isSafeInteger(availablePoints) || availablePoints < 0 || availablePoints > MAX_CREDIT_POINTS) {
    throw new CreditError('credits_unavailable');
  }
  if (!billing) return new CreditError('billing_consent_required');
  const context = { requiredPoints, availablePoints, maxPoints: billing.maxPoints,
    priceVersion: CLASSIFICATION_CREDIT_PRICE.priceVersion };
  if (billing.priceVersion !== CLASSIFICATION_CREDIT_PRICE.priceVersion) return new CreditError('credit_price_changed', context);
  if (requiredPoints > billing.maxPoints) return new CreditError('credit_limit_exceeded', context);
  if (requiredPoints > availablePoints) return new CreditError('insufficient_credits', context);
  return null;
}
