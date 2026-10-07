/**
 * P4A-I12 fixture: a FUTURE shared consumer reaching the attachments
 * repository port directly.
 *
 * This is the strongest forbidden shape: a consumer that reads
 * `stored_private|attached_private` repository facts (or the physical body)
 * without any exposure-eligibility gate. The architecture scan must classify
 * this as `consumer_repository_import`.
 */
import type { AttachmentsLedgerPort } from '../../../src/modules/attachments/attachments-repository-port.js';

export function repositoryBypassFutureConsumer(): { readonly ledger: AttachmentsLedgerPort<unknown> | null } {
  return { ledger: null };
}
