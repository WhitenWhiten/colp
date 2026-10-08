import type { ProductCommandBinding } from '../../commands/index.js';
import {
  PRODUCT_COMMAND_RECEIPT_TABLE,
  PUBLISHER_IDEMPOTENCY_TABLE,
  type PublisherIdempotencyBinding,
} from './ports.js';
import { PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE } from './create-owned-collection-harness.js';
import { CREATE_OWNED_COLLECTION_COMMAND_SCOPE } from '../../collections/index.js';

/**
 * Isolation probe: identical principal + key material on Product and Publisher
 * must never collide because ownership tables and PK dimensions differ.
 */
export interface PublisherProductIsolationProbe {
  readonly productTable: typeof PRODUCT_COMMAND_RECEIPT_TABLE;
  readonly publisherTable: typeof PUBLISHER_IDEMPOTENCY_TABLE;
  readonly productBinding: ProductCommandBinding;
  readonly publisherBinding: PublisherIdempotencyBinding;
  /** Shared logical key string used as Product commandId and Publisher idempotencyKey. */
  readonly sharedKey: string;
  readonly sharedPrincipalId: string;
}

export interface BuildIsolationCollisionProbeInput {
  readonly principalId: string;
  /** Canonical UUID v4 when the Product path validates Known-Command-Id. */
  readonly sharedKey: string;
  readonly productCommandScope?: string;
  readonly publisherNamespace?: string;
}

/**
 * Builds paired bindings that intentionally reuse the same principal and key string.
 * Tests claim both independently to prove no shared storage.
 */
export function buildPublisherProductIsolationProbe(
  input: BuildIsolationCollisionProbeInput,
): PublisherProductIsolationProbe {
  if (!input.principalId?.trim()) throw new Error('principalId is required');
  if (!input.sharedKey?.trim()) throw new Error('sharedKey is required');

  const productCommandScope = input.productCommandScope?.trim()
    ? input.productCommandScope
    : CREATE_OWNED_COLLECTION_COMMAND_SCOPE;
  const publisherNamespace = input.publisherNamespace?.trim()
    ? input.publisherNamespace
    : PUBLISHER_CREATE_OWNED_COLLECTION_NAMESPACE;

  return {
    productTable: PRODUCT_COMMAND_RECEIPT_TABLE,
    publisherTable: PUBLISHER_IDEMPOTENCY_TABLE,
    sharedKey: input.sharedKey,
    sharedPrincipalId: input.principalId,
    productBinding: {
      principalId: input.principalId,
      commandScope: productCommandScope,
      commandId: input.sharedKey,
    },
    publisherBinding: {
      namespace: publisherNamespace,
      principalId: input.principalId,
      idempotencyKey: input.sharedKey,
    },
  };
}

/**
 * Structural isolation contract for tests and static review.
 * Product and Publisher receipt owners are separate tables with disjoint PK shapes.
 */
export function publisherProductReceiptIsolationContract(): {
  readonly productTable: typeof PRODUCT_COMMAND_RECEIPT_TABLE;
  readonly publisherTable: typeof PUBLISHER_IDEMPOTENCY_TABLE;
  readonly productPrimaryKey: readonly ['principal_id', 'command_scope', 'command_id'];
  readonly publisherPrimaryKey: readonly ['namespace', 'principal_id', 'idempotency_key'];
  readonly sharedTables: false;
  readonly nestedTransactions: false;
  readonly productOwnsHttpIdempotencyKey: false;
  readonly publisherOwnsProductCommandId: false;
} {
  return {
    productTable: PRODUCT_COMMAND_RECEIPT_TABLE,
    publisherTable: PUBLISHER_IDEMPOTENCY_TABLE,
    productPrimaryKey: ['principal_id', 'command_scope', 'command_id'],
    publisherPrimaryKey: ['namespace', 'principal_id', 'idempotency_key'],
    sharedTables: false,
    nestedTransactions: false,
    productOwnsHttpIdempotencyKey: false,
    publisherOwnsProductCommandId: false,
  };
}
