import type { Kysely } from 'kysely';
import {
  createCanonicalMutationApplication,
  type CanonicalMutationApplication,
} from '../../modules/collections/index.js';
import type {
  ExecutePublisherCanonicalMutationInput,
  ExecutePublisherCanonicalMutationResult,
  PublisherCanonicalMutationHarnessPorts,
} from '../../modules/publisher/index.js';
import { executePublisherCanonicalMutation } from '../../modules/publisher/index.js';
import {
  createPostgresCanonicalMutationPorts,
  type PostgresCanonicalMutationFaultInjector,
  type PostgresCanonicalMutationPortOptions,
} from '../collections/canonical-mutation-postgres-ports.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionContext,
  type TransactionFaultInjector,
  type TransactionIsolationLevel,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { Metrics } from '../telemetry/index.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import { createPostgresPublisherIdempotencyPort } from './postgres-idempotency.js';

export interface PostgresPublisherCanonicalMutationUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: TransactionFaultInjector;
  readonly canonicalFaultInjector?: PostgresCanonicalMutationFaultInjector;
  readonly outboxIdGenerator?: () => string;
  readonly metrics?: Metrics;
  readonly positionRebalanceWindow?: number;
  readonly socialRouteFaultInjector?: PostgresCanonicalMutationPortOptions['socialRouteFaultInjector'];
  /** Optional report cache/source-fence fan-out for Publisher mutations. */
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

export interface PostgresPublisherCanonicalMutationUnitOfWork {
  execute<Result>(
    work: (
      ports: PublisherCanonicalMutationHarnessPorts<DatabaseTransaction>,
      context: TransactionContext,
    ) => Promise<Result>,
  ): Promise<Result>;
}

export interface PostgresPublisherCanonicalMutationApplication {
  execute(
    input: ExecutePublisherCanonicalMutationInput,
  ): Promise<ExecutePublisherCanonicalMutationResult>;
}

/**
 * Publisher admission UoW. Publisher owns the idempotency namespace while
 * Canonical Mutation owns all resource/revision/operation/audit/outbox writes.
 * Both adapters are bound to the one transaction created here.
 */
export function createPostgresPublisherCanonicalMutationUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresPublisherCanonicalMutationUnitOfWorkOptions = {},
): PostgresPublisherCanonicalMutationUnitOfWork {
  const unitOfWork = createUnitOfWork(db, {
    isolationLevel: options.isolationLevel,
    faultInjector: options.faultInjector,
  });
  return {
    execute: async (work) => {
      const committedRebalanceCounts: number[] = [];
      const result = await unitOfWork.execute(async (context) => {
        const rawCanonical = createCanonicalMutationApplication(createPostgresCanonicalMutationPorts(context.transaction, {
          outboxIdGenerator: options.outboxIdGenerator,
          faultInjector: options.canonicalFaultInjector,
          metrics: options.metrics,
          positionRebalanceWindow: options.positionRebalanceWindow,
          invalidateSyncReplicasOnNodeMutation: true,
          socialRouteFaultInjector: options.socialRouteFaultInjector,
          ...(options.reportSourceInvalidation === undefined ? {} : {
            reportSourceInvalidation: options.reportSourceInvalidation,
          }),
        }));
        const canonical: CanonicalMutationApplication<DatabaseTransaction> = {
          execute: async (mutationContext, input) => {
            const mutationResult = await rawCanonical.execute(mutationContext, input);
            if ((mutationResult.allocation.rebalancedSiblings?.length ?? 0) > 0) {
              committedRebalanceCounts.push(mutationResult.allocation.rebalancedSiblings!.length);
            }
            return mutationResult;
          },
        };
        const ports: PublisherCanonicalMutationHarnessPorts<DatabaseTransaction> = {
          publisherIdempotency: createPostgresPublisherIdempotencyPort(context.transaction),
          canonical,
        };
        const result = await work(ports, context);
        return result;
      });
      for (const committedRebalanceCount of committedRebalanceCounts) {
        options.metrics?.increment('position.rebalance.bounded_total');
        options.metrics?.observe('position.rebalance.rewritten_siblings', committedRebalanceCount);
      }
      return result;
    },
  };
}

/** Production Publisher application entry point; intentionally has no HTTP adapter. */
export function createPostgresPublisherCanonicalMutationApplication(
  db: Kysely<DatabaseSchema>,
  options: PostgresPublisherCanonicalMutationUnitOfWorkOptions = {},
): PostgresPublisherCanonicalMutationApplication {
  const unitOfWork = createPostgresPublisherCanonicalMutationUnitOfWork(db, options);
  return {
    execute: (input) => unitOfWork.execute((ports, context) =>
      executePublisherCanonicalMutation(ports, context, input)),
  };
}
