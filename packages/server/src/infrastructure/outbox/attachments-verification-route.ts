import type { UnitOfWork } from '../database/unit-of-work.js';
import type {
  AttachmentsFeatureConfig,
  AttachmentsLedgerPort,
  GenerationObjectStorePort,
  VerificationFaultInjector,
  VerificationLogger,
  VerificationOutboxPayload,
  VerificationWorkerOutcome,
} from '../../modules/attachments/index.js';
import {
  ATTACHMENTS_VERIFICATION_EVENT_TYPE,
  ATTACHMENTS_VERIFICATION_EVENT_VERSION,
  ATTACHMENTS_VERIFICATION_HANDLER_NAME,
  parseAttachmentsVerificationPayload,
} from './attachments-verification.js';
import { OutboxDeliveryError, type OutboxHandlerContext, type OutboxRoute } from './router.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { verifyUploadedGeneration } from '../../modules/attachments/index.js';

export interface AttachmentsVerificationRouteOptions {
  /** Transaction-bound attachments ledger (postgres ports). */
  readonly repository: AttachmentsLedgerPort<DatabaseTransaction>;
  /** Narrow structural subset of the I06 `BlobStorePort`. */
  readonly blobStore: GenerationObjectStorePort;
  /** Matches the production `UnitOfWork`; the coordinator runs 1-2 txs. */
  readonly uow: UnitOfWork;
  readonly config: AttachmentsFeatureConfig;
  /** Deterministic crash hooks (tests/evidence only). */
  readonly faultInjector?: VerificationFaultInjector;
  readonly log?: VerificationLogger;
}

/**
 * Production verification consumer route. The outbox worker claims the row
 * (acquiring the outbox lease), then this handler runs the coordinator:
 * verification lease CAS, HEAD/GET outside any transaction, pure streamed
 * verification, then the lease-fenced `verifying -> stored_private` /
 * quarantine CAS. The side effect is DURABLE (the handler commits the CAS),
 * so the worker may permanently complete the row only after it returns.
 * Retryable/lease-lost outcomes throw `OutboxDeliveryError('retryable')` so
 * the row is re-delivered (idempotent convergence); duplicate deliveries
 * produce no contradictory evidence. FIX-L-045: an authoritatively
 * replaced/retired generation (`already_replaced`) is TERMINAL — the event
 * completes and the replacement's own verification event drives the new
 * generation.
 */
export function createAttachmentsVerificationOutboxRoute(
  options: AttachmentsVerificationRouteOptions,
): OutboxRoute {
  return Object.freeze({
    handlerName: ATTACHMENTS_VERIFICATION_HANDLER_NAME,
    handlerMode: 'delivery_each_event' as const,
    eventType: ATTACHMENTS_VERIFICATION_EVENT_TYPE,
    eventVersion: ATTACHMENTS_VERIFICATION_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'projection' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable', 'attachments verification attempt fence is missing');
      }
      const payload = parseAttachmentsVerificationPayload(context.envelope);
      const outcome = await verifyUploadedGeneration<DatabaseTransaction>(
        {
          ledger: options.repository,
          blobStore: options.blobStore,
          uow: options.uow,
          config: options.config,
          faultInjector: options.faultInjector,
          log: options.log,
        },
        payload,
        { outboxId: context.attempt.outboxId, leaseGeneration: context.attempt.leaseGeneration },
        context.signal,
      );
      throwIfRetryable(outcome);
    },
  });
}

function throwIfRetryable(outcome: VerificationWorkerOutcome): void {
  switch (outcome.outcome) {
    case 'stored_private':
    case 'already_stored':
    case 'quarantined':
    case 'already_expired':
    // FIX-L-045: an authoritatively replaced/retired generation can never
    // verify again — the event completes terminal (never dead-letters), and
    // the replacement's own verification event drives the new generation.
    case 'already_replaced':
      return;
    case 'retryable':
      throw new OutboxDeliveryError('retryable', `attachments verification retryable:${outcome.reason}`);
    case 'lease_lost':
      throw new OutboxDeliveryError('retryable', 'attachments verification lease lost');
    case 'not_found':
      throw new OutboxDeliveryError('retryable', 'attachments verification target not found');
  }
}

// Re-export the payload type so route consumers can name it.
export type { VerificationOutboxPayload };
