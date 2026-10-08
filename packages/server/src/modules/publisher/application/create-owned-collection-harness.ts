import {
  createOwnedCollectionCanonical,
  type CreateOwnedCollectionInput,
  type CreateOwnedCollectionResult,
  type ProductCollectionCanonicalPorts,
} from '../../collections/index.js';
import { adaptPublisherIdempotencyAsProductReceipts } from './admission.js';
import type { PublisherIdempotencyPort } from './ports.js';

/**
 * Default namespace for the Publisher create-owned-collection harness.
 * Distinct from Product CREATE_OWNED_COLLECTION_COMMAND_SCOPE even if a client
 * reuses the same string as an Idempotency-Key or command id.
 */
export const PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE =
  'colp.publisher.v0.1.create_owned_collection' as const;

export interface PublisherCreateOwnedCollectionHarnessPorts
  extends Omit<ProductCollectionCanonicalPorts, 'receipts'> {
  readonly publisherIdempotency: PublisherIdempotencyPort;
}

export interface PublisherCreateOwnedCollectionHarnessInput extends CreateOwnedCollectionInput {
  /**
   * Publisher namespace for the idempotency winner key.
   * Defaults to PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE.
   */
  readonly publisherNamespace?: string;
}

/**
 * Internal contract harness: admit a create-owned-collection mutation under
 * Publisher idempotency ownership while reusing the canonical collections
 * bootstrap (ID ledger, Collection+Root, membership/policy, Operation/Audit/Outbox).
 *
 * - Does not mount Publisher HTTP or Profile
 * - Does not open nested transactions (caller binds ports to one UoW)
 * - Does not read or write product_command_receipts
 */
export async function runPublisherCreateOwnedCollectionHarness(
  ports: PublisherCreateOwnedCollectionHarnessPorts,
  input: PublisherCreateOwnedCollectionHarnessInput,
): Promise<CreateOwnedCollectionResult> {
  const namespace = input.publisherNamespace?.trim()
    ? input.publisherNamespace
    : PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE;

  const receipts = adaptPublisherIdempotencyAsProductReceipts(ports.publisherIdempotency, {
    namespace,
  });

  const collectionPorts: ProductCollectionCanonicalPorts = {
    receipts,
    clock: ports.clock,
    collections: ports.collections,
    nodes: ports.nodes,
    accessPolicy: ports.accessPolicy,
    canonical: ports.canonical,
  };

  return createOwnedCollectionCanonical(collectionPorts, input);
}
