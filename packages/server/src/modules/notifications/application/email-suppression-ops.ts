/**
 * P5-31 suppression operations surface (application layer).
 *
 * Ops-only view/clear over the durable `notification_email_suppressions`
 * facts table. Recipient identity is SCRUBBED in every output: ops tools may
 * see the opaque `recipientAccountId` (an internal account identifier) but
 * NEVER recipient emails or provider credentials. The table itself stores no
 * email address, and this module never joins to `accounts.email`.
 *
 * Clearing a fact is documented as RESUBSCRIBE: it removes the durable
 * bounce/complaint/unsubscribe fact so future delivery becomes eligible
 * again, aligning with the provider's UnblockRecipient semantics (gate doc
 * section 4). It never mutates `notification_preferences`, `accounts`, or
 * any Notification authority row.
 */
import { timingSafeEqual } from 'node:crypto';
import type { EmailSuppressionSource } from './email-delivery-worker.js';

export interface EmailSuppressionFactRecord {
  /** Opaque internal account id (never an email address). */
  readonly recipientAccountId: string;
  readonly source: EmailSuppressionSource;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface EmailSuppressionFactView {
  readonly recipientAccountId: string;
  readonly source: EmailSuppressionSource;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface EmailSuppressionOpsRepository {
  /** Aggregated count for runtime inspection; never exports recipient details. */
  countSuppressionFacts(): Promise<number>;
  /** Lists durable suppression facts; the production repo returns no emails. */
  listSuppressionFacts(): Promise<readonly EmailSuppressionFactRecord[]>;
  /** Removes one durable fact (documented as resubscribe). True when a row was deleted. */
  clearSuppressionFact(recipientAccountId: string): Promise<boolean>;
}

/**
 * Scrubs a suppression fact to the stable ops view. The view deliberately
 * carries only the opaque account id, source and timestamps; any future
 * email-bearing column must be stripped here before it reaches ops output.
 */
export function scrubEmailSuppressionFact(record: EmailSuppressionFactRecord): EmailSuppressionFactView {
  return Object.freeze({
    recipientAccountId: record.recipientAccountId,
    source: record.source,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  });
}

export async function listEmailSuppressionFacts(
  repository: EmailSuppressionOpsRepository,
): Promise<readonly EmailSuppressionFactView[]> {
  const records = await repository.listSuppressionFacts();
  return Object.freeze(records.map(scrubEmailSuppressionFact));
}

export async function clearEmailSuppressionFact(
  repository: EmailSuppressionOpsRepository,
  recipientAccountId: string,
): Promise<{ readonly cleared: boolean; readonly recipientAccountId: string }> {
  if (!/^[A-Za-z0-9._~-]{1,128}$/u.test(recipientAccountId)) {
    throw new RangeError('recipientAccountId must match [A-Za-z0-9._~-]{1,128}');
  }
  const cleared = await repository.clearSuppressionFact(recipientAccountId);
  return Object.freeze({ cleared, recipientAccountId });
}

/**
 * Constant-time compare for the ops token. An absent/empty expected token is
 * never valid so the ops surface is disabled (404) rather than accidentally
 * open when EMAIL_OPS_TOKEN is unset.
 */
export function verifyEmailOpsToken(
  expected: string | null | undefined,
  provided: string | undefined,
): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.length !== right.length) {
    // Burn comparable time on a dummy compare so length mismatches do not
    // leak early exit timing.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
