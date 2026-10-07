import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

/** Own the capture identity even before either its report or decision row exists. */
export async function lockCaptureIdentity(
  transaction: DatabaseTransaction, accountId: string, captureId: string,
): Promise<void> {
  // Take this gate before collection/receipt locks in every capture admission path.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
    json_build_array('bookmark-capture:v1'::text, ${accountId}::text, ${captureId}::text)::text, 0))`
    .execute(transaction);
}
