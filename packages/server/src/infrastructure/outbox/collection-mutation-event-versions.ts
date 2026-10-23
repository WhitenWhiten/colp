import {
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_EVENT_VERSION as COLLECTION_CREATED_EVENT_VERSION_N,
  COLLECTION_UPDATED_EVENT_TYPE,
  COLLECTION_UPDATED_EVENT_VERSION,
  NODE_RESTORED_EVENT_TYPE,
  NODE_RESTORED_EVENT_VERSION,
  NODE_CREATED_EVENT_TYPE,
  NODE_CREATED_EVENT_VERSION,
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETED_EVENT_VERSION,
  NODE_MOVED_EVENT_TYPE,
  NODE_MOVED_EVENT_VERSION,
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_EVENT_VERSION,
} from '../../modules/collections/index.js';

/**
 * Producer-facing list of versions currently emitted by Product mutations.
 * Expand-contract: keep producers on N until all consumers accept N+1.
 */
export const PHASE1_PRODUCER_EVENT_VERSIONS: Readonly<Record<string, number>> = Object.freeze({
  [COLLECTION_CREATED_EVENT_TYPE]: COLLECTION_CREATED_EVENT_VERSION_N,
  [COLLECTION_UPDATED_EVENT_TYPE]: COLLECTION_UPDATED_EVENT_VERSION,
  [NODE_RESTORED_EVENT_TYPE]: NODE_RESTORED_EVENT_VERSION,
  [NODE_CREATED_EVENT_TYPE]: NODE_CREATED_EVENT_VERSION,
  [NODE_UPDATED_EVENT_TYPE]: NODE_UPDATED_EVENT_VERSION,
  [NODE_MOVED_EVENT_TYPE]: NODE_MOVED_EVENT_VERSION,
  [NODE_DELETED_EVENT_TYPE]: NODE_DELETED_EVENT_VERSION,
});

export interface Phase1MutationEventCompatibility {
  readonly producerVersion: number;
  readonly currentConsumerVersions: readonly number[];
  readonly previousConsumerVersions: readonly number[];
}

/** Explicit rollout matrix for every real Phase 1 event/version; no synthetic versions. */
export const PHASE1_MUTATION_EVENT_COMPATIBILITY: Readonly<
  Record<string, Phase1MutationEventCompatibility>
> = Object.freeze({
  [COLLECTION_CREATED_EVENT_TYPE]: Object.freeze({
    producerVersion: 1,
    currentConsumerVersions: Object.freeze([1, 2]),
    previousConsumerVersions: Object.freeze([1]),
  }),
  [COLLECTION_UPDATED_EVENT_TYPE]: Object.freeze({
    producerVersion: 1,
    currentConsumerVersions: Object.freeze([1]),
    previousConsumerVersions: Object.freeze([1]),
  }),
  [NODE_RESTORED_EVENT_TYPE]: Object.freeze({ producerVersion: 1, currentConsumerVersions: Object.freeze([1]), previousConsumerVersions: Object.freeze([]) }),
  [NODE_CREATED_EVENT_TYPE]: Object.freeze({
    producerVersion: 1,
    currentConsumerVersions: Object.freeze([1]),
    previousConsumerVersions: Object.freeze([1]),
  }),
  [NODE_UPDATED_EVENT_TYPE]: Object.freeze({
    producerVersion: 1,
    currentConsumerVersions: Object.freeze([1]),
    previousConsumerVersions: Object.freeze([1]),
  }),
  [NODE_MOVED_EVENT_TYPE]: Object.freeze({
    producerVersion: 1,
    currentConsumerVersions: Object.freeze([1]),
    previousConsumerVersions: Object.freeze([1]),
  }),
  [NODE_DELETED_EVENT_TYPE]: Object.freeze({
    producerVersion: 1,
    currentConsumerVersions: Object.freeze([1]),
    previousConsumerVersions: Object.freeze([1]),
  }),
});
