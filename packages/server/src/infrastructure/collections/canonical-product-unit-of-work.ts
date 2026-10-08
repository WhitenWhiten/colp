import type { Kysely } from 'kysely';
import {
  CanonicalMutationInvariantError,
  bootstrapCanonicalOwnedCollection,
  createCanonicalMutationApplication,
  type CanonicalMutationInput,
  type CanonicalMutationResult,
  type ProductCollectionCanonicalPorts,
} from '../../modules/collections/index.js';
import type {
  ProductCommandBinding,
  ProductCommandClaim,
  ProductCommandResult,
} from '../../modules/commands/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { lockActiveSyncReplicasForCollection } from '../database/lock-order.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { Metrics } from '../telemetry/index.js';
import type { SocialCollectionChangeRouteFaultInjector } from '../outbox/social-collection-change.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import {
  createUnitOfWork,
  type TransactionFaultInjector,
  type TransactionIsolationLevel,
} from '../database/unit-of-work.js';
import {
  createPostgresCanonicalMutationPorts,
  type PostgresCanonicalMutationFaultInjector,
} from './canonical-mutation-postgres-ports.js';
import { createPostgresAccessPolicyFactsPort, createPostgresAccessPolicyWritePort } from '../access-policy/index.js';
import {
  createPostgresBootstrapAuditPort,
  createPostgresBootstrapOperationPort,
  createPostgresBootstrapOutboxPort,
  createPostgresCollectionWritePort,
  createPostgresCollectionsClock,
  createPostgresIdLedgerPort,
  createPostgresNodeWritePort,
  createPostgresRevisionWritePort,
} from './repositories.js';
import { createPostgresBookmarkIconWritePort } from './bookmark-icon-postgres.js';
import { createPostgresFaviconSourcePort } from './favicon-source-postgres.js';
import { createPostgresFaviconPolicyPort } from './favicon-policy-postgres.js';
import { createPostgresFaviconJobWritePort } from './favicon-job-postgres.js';
export type PostgresCanonicalMutationProductPorts = ProductCollectionCanonicalPorts;

export interface PostgresCanonicalMutationUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: TransactionFaultInjector;
  readonly outboxIdGenerator?: () => string;
  readonly canonicalFaultInjector?: PostgresCanonicalMutationFaultInjector;
  readonly metrics?: Metrics;
  readonly positionRebalanceWindow?: number;
  readonly socialRouteFaultInjector?: SocialCollectionChangeRouteFaultInjector;
  readonly productOrigin?: string;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

export interface PostgresCanonicalMutationUnitOfWork {
  execute<Result>(work: (ports: PostgresCanonicalMutationProductPorts) => Promise<Result>): Promise<Result>;
}

function invariant(message: string): never {
  throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message);
}

export function createPostgresCanonicalMutationUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCanonicalMutationUnitOfWorkOptions = {},
): PostgresCanonicalMutationUnitOfWork {
  const unitOfWork = createUnitOfWork(db, {
    isolationLevel: options.isolationLevel,
    faultInjector: options.faultInjector,
  });
  return {
    async execute(work) {
      let committedRebalanceCount: number | undefined;
      const result = await unitOfWork.execute(async ({ transaction }) => {
      const rawCanonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(transaction, {
        outboxIdGenerator: options.outboxIdGenerator,
        faultInjector: options.canonicalFaultInjector,
        metrics: options.metrics,
        positionRebalanceWindow: options.positionRebalanceWindow,
        invalidateSyncReplicasOnNodeMutation: true,
        socialRouteFaultInjector: options.socialRouteFaultInjector,
        reportSourceInvalidation: options.reportSourceInvalidation,
      }));
      const rawReceipts = createPostgresProductCommandReceiptPort(transaction);
      const clock = createPostgresCollectionsClock(transaction);
      const collections = createPostgresCollectionWritePort(transaction, options.metrics);
      const collectionReader: ProductCollectionCanonicalPorts['collections'] = {
        lockForUpdate: async (collectionId) => {
          // T-10 lock order (ADR-0027): product node commands lock the
          // collection row before the canonical mutation, and the mutation
          // ends by marking this collection's active replicas
          // `recovery_required`. Lock the replica rows first so the pair is
          // never taken in the opposite order from Sync Push/Pull/Ack.
          await lockActiveSyncReplicasForCollection(transaction, collectionId);
          return collections.lockForUpdate(collectionId);
        },
      };
      const accessPolicy = createPostgresAccessPolicyFactsPort(transaction);
      const nodeReader = createPostgresNodeWritePort(transaction, options.metrics);
      let claimCalled = false;
      let claimedBinding: string | undefined;
      let claimedPrincipalId: string | undefined;
      let canonicalCalled = false;
      let canonicalSucceeded = false;
      let canonicalResourceId: string | undefined;
      let receiptCompleted = false;
      const canonical: PostgresCanonicalMutationProductPorts['canonical'] = {
        async execute(input) {
          if (canonicalCalled) invariant('one canonical mutation unit of work may execute exactly one mutation');
          if (!claimedBinding) invariant('canonical mutation requires an owned product command claim');
          if (input.actor.principalId !== claimedPrincipalId) {
            invariant('canonical mutation actor does not own the claimed product command');
          }
          canonicalCalled = true;
          const result = await rawCanonical.execute({ transaction }, input);
          canonicalSucceeded = true;
          canonicalResourceId = result.resourceId;
          if ((result.allocation.rebalancedSiblings?.length ?? 0) > 0) {
            committedRebalanceCount = result.allocation.rebalancedSiblings!.length;
          }
          return result;
        },
        async bootstrapOwnedCollection(input) {
          if (canonicalCalled) invariant('one canonical mutation unit of work may execute exactly one mutation');
          if (!claimedBinding) invariant('canonical mutation requires an owned product command claim');
          if (input.actor.principalId !== claimedPrincipalId) {
            invariant('canonical mutation actor does not own the claimed product command');
          }
          canonicalCalled = true;
          const result = await bootstrapCanonicalOwnedCollection({
            clock,
            idLedger: createPostgresIdLedgerPort(transaction),
            collections,
            nodes: createPostgresNodeWritePort(transaction, options.metrics),
            revisions: createPostgresRevisionWritePort(transaction),
            accessPolicy: createPostgresAccessPolicyWritePort(transaction),
            operations: createPostgresBootstrapOperationPort(transaction),
            audit: createPostgresBootstrapAuditPort(transaction),
            outbox: createPostgresBootstrapOutboxPort(transaction),
          }, input);
          canonicalSucceeded = true;
          canonicalResourceId = input.collectionId;
          return result;
        },
      };
      const receipts: PostgresCanonicalMutationProductPorts['receipts'] = {
        async claim(binding, fingerprint) {
          if (claimCalled) invariant('one canonical mutation unit of work may claim exactly one product command');
          claimCalled = true;
          const claim = await rawReceipts.claim(binding, fingerprint);
          if (claim.kind === 'claimed') {
            claimedBinding = JSON.stringify([binding.principalId, binding.commandScope, binding.commandId, fingerprint]);
            claimedPrincipalId = binding.principalId;
          }
          return claim;
        },
        async complete(binding, fingerprint, result) {
          const bindingKey = JSON.stringify([binding.principalId, binding.commandScope, binding.commandId, fingerprint]);
          if (!claimedBinding || bindingKey !== claimedBinding) invariant('product command completion does not own this unit of work claim');
          if (!canonicalSucceeded) invariant('product command receipt cannot complete before canonical outbox success');
          if (receiptCompleted) invariant('product command receipt cannot be completed twice');
          if (result.targetIdentity !== canonicalResourceId) {
            invariant('product command receipt target does not match the canonical mutation result');
          }
          await rawReceipts.complete(binding, fingerprint, result);
          receiptCompleted = true;
        },
      };
      const result = await work({
        canonical,
        receipts,
        clock,
        collections: collectionReader,
        nodes: {
          getNode: (collectionId, nodeId) => nodeReader.getNode(collectionId, nodeId),
          readParentAncestry: (collectionId, parentId, maxDepth) =>
            nodeReader.readParentAncestry!(collectionId, parentId, maxDepth),
          listLiveSiblingPositions: (collectionId, parentId) =>
            nodeReader.listLiveSiblingPositions(collectionId, parentId),
          hasLiveChildren: (collectionId, parentId) =>
            nodeReader.hasLiveChildren!(collectionId, parentId),
          listLiveNodes: (collectionId) => nodeReader.listLiveNodes!(collectionId),
        },
        accessPolicy,
        bookmarkIcons: createPostgresBookmarkIconWritePort(transaction),
        faviconAutoRefresh: {
          sources: createPostgresFaviconSourcePort(transaction),
          policies: createPostgresFaviconPolicyPort(transaction),
          jobs: createPostgresFaviconJobWritePort(transaction),
        },
        ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
      });
      if (!claimCalled) invariant('successful canonical mutation unit of work must claim one product command');
      if (claimedBinding && (!canonicalSucceeded || !receiptCompleted)) {
        invariant('successful canonical mutation unit of work left a claimed product command incomplete');
      }
      return result;
      });
      if (committedRebalanceCount !== undefined) {
        options.metrics?.increment('position.rebalance.bounded_total');
        options.metrics?.observe('position.rebalance.rewritten_siblings', committedRebalanceCount);
      }
      return result;
    },
  };
}
