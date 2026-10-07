/**
 * P4A-P09 fixture: a FUTURE shared consumer reaching the P02-era canonical
 * MUTATION port directly (finalize/retire/replacement transaction-bound
 * assembly).
 *
 * A shared consumer must never invoke canonical mutation: it sees only the
 * explicit eligibility verdict through the approved gate port. The
 * architecture scan must classify this as `consumer_repository_import`.
 */
import type { AttachmentCanonicalMutationPort } from '../../../src/modules/attachments/attachment-canonical-mutation-port.js';

export function canonicalMutationBypassFutureConsumer(): {
  readonly canonical: AttachmentCanonicalMutationPort<unknown> | null;
} {
  return { canonical: null };
}
