import {
  type PublicActivityWorkerRepository,
} from '../../modules/social/index.js';
import { OutboxDeliveryError, type OutboxHandlerContext, type OutboxRoute } from '../outbox/router.js';
import {
  SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
  SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
} from '../outbox/social-collection-change.js';
import { normalizeSocialCollectionChange } from './feed-worker-route.js';

export function createPublicActivityWorkerRoutes(options: {
  readonly repository: PublicActivityWorkerRepository;
  readonly metrics?: { readonly increment: (name: string, value?: number) => void };
}): readonly OutboxRoute[] {
  return Object.freeze([Object.freeze({
    handlerName: SOCIAL_PUBLIC_ACTIVITY_HANDLER_NAME,
    handlerMode: SOCIAL_PUBLIC_ACTIVITY_HANDLER_MODE,
    eventType: SOCIAL_COLLECTION_CHANGE_EVENT_TYPE,
    eventVersion: 2,
    sideEffectDurability: 'durable' as const,
    routeClass: 'projection' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!context.attempt) {
        throw new OutboxDeliveryError('retryable', 'public Activity projection attempt fence is missing');
      }
      const result = await options.repository.projectCollectionChange({
        event: normalizeSocialCollectionChange(context.envelope),
        attempt: context.attempt,
        signal: context.signal,
      });
      recordDisposition(options.metrics, result.disposition);
      if (result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable', 'public Activity projection attempt lease was lost');
      }
    },
  })]);
}

function recordDisposition(
  metrics: { readonly increment: (name: string, value?: number) => void } | undefined,
  disposition: 'applied' | 'duplicate' | 'withdrawn' | 'ineligible' | 'lease_lost',
): void {
  if (!metrics) return;
  switch (disposition) {
    case 'applied': metrics.increment('public_activity.applied'); break;
    case 'duplicate': metrics.increment('public_activity.duplicate'); break;
    case 'withdrawn': metrics.increment('public_activity.withdrawn'); break;
    case 'ineligible': metrics.increment('public_activity.ineligible'); break;
    case 'lease_lost': metrics.increment('public_activity.lease_lost'); break;
  }
}
