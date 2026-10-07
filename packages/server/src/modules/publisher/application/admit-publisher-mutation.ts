/**
 * Re-export surface for the generic Publisher claim → execute → complete admission.
 * Prefer importing from `./admission.js` or the module public index.
 */
export {
  admitPublisherMutation,
  adaptPublisherIdempotencyAsProductReceipts,
  type AdmitPublisherMutationInput,
  type AdmitPublisherMutationResult,
  type PublisherAsProductReceiptOptions,
} from './admission.js';
