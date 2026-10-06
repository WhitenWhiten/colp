import { types as nodeTypes } from 'node:util';

import { inspectExactDenseArray } from '../security/dense-array.js';
import type { FeedEvent } from '../types/index.js';
import {
  discriminateFeedEvent,
  type VerifiedFeedEvent,
} from './event-contracts.js';

/** Maximum number of subscription entries accepted by one merge. */
export const MAX_FEED_SUBSCRIPTIONS = 10_000;
/** Maximum UTF-16 length of a local subscription id. */
export const MAX_FEED_SUBSCRIPTION_ID_LENGTH = 256;
/** Maximum UTF-16 length of a collection id used by a subscription. */
export const MAX_FEED_COLLECTION_ID_LENGTH = 256;
/** Maximum UTF-16 length of an opaque server-side filter digest. */
export const MAX_FEED_FILTER_DIGEST_LENGTH = 256;
/** Maximum distinct collection scopes retained in one filter group. */
export const MAX_FEED_COLLECTIONS_PER_FILTER_GROUP = 1_000;
/** Maximum number of server-side filter groups produced by one merge. */
export const MAX_FEED_FILTER_GROUPS = 100;

const SUBSCRIPTION_OWN_KEYS = new Set(['id', 'collectionId', 'filterDigest']);
declare const mergedFeedRequestBrand: unique symbol;
const issuedRequestScopes = new WeakMap<
  object,
  ReadonlyMap<string, NormalizedSubscription>
>();

/**
 * Multi-subscription merge into filter-bound instance Feed requests
 * (FEED-0009).
 *
 * The host executes every returned request separately. A non-null
 * `filterDigest` is an opaque server-side filter binding; it is never evaluated
 * locally or merged with another digest.
 */

export interface FeedSubscription {
  /** Stable local subscription id (not sent on the wire). */
  readonly id: string;
  /** Collection id, or `null` / `'*'` for the whole instance. */
  readonly collectionId: string | null;
  /** Optional opaque server-side filter digest already bound by the host. */
  readonly filterDigest?: string;
}

export interface MergedFeedRequest {
  /** Nominal marker: request plans are opaque capabilities issued by this module. */
  readonly [mergedFeedRequestBrand]: true;
  /** Instance-level feed endpoint key. */
  readonly endpoint: 'instanceFeed';
  /** Opaque server-side filter binding; `null` means an unfiltered request. */
  readonly filterDigest: string | null;
  /** Distinct collection ids requested (empty means whole-instance interest). */
  readonly collectionIds: readonly string[];
  /** Subscription ids covered by this filter-bound request. */
  readonly subscriptionIds: readonly string[];
  /** True when this filter group contains an instance-wide subscription. */
  readonly instanceWide: boolean;
}

export type FeedMergeErrorCode =
  | 'empty_subscriptions'
  | 'too_many_subscriptions'
  | 'malformed_subscription'
  | 'conflicting_subscription_id'
  | 'too_many_filter_groups'
  | 'too_many_collections';

export type FeedMergeResult =
  | { readonly ok: true; readonly requests: readonly MergedFeedRequest[] }
  | { readonly ok: false; readonly code: FeedMergeErrorCode };

interface NormalizedSubscription {
  readonly id: string;
  readonly collectionId: string | null;
  readonly filterDigest: string | null;
}

interface MutableFeedRequestGroup {
  readonly filterDigest: string | null;
  readonly collectionIds: Set<string>;
  readonly subscriptionIds: string[];
  readonly scopesBySubscriptionId: Map<string, NormalizedSubscription>;
  instanceWide: boolean;
}

/**
 * Merges local Feed subscriptions into filter-bound instance request groups.
 *
 * Input is snapshotted from exact own data properties before aggregation.
 * Groups follow first filter occurrence, subscription ids follow first input
 * occurrence, and collection ids are sorted for deterministic wire planning.
 * `Map` duplicate/group lookup and `Set` collection aggregation keep the main
 * pass O(n); sorting is bounded by the exported per-group collection limit.
 */
export function mergeFeedSubscriptions(
  subscriptions: readonly FeedSubscription[],
): FeedMergeResult {
  const input = snapshotSubscriptionArray(subscriptions);
  if (input.kind === 'too-many') {
    return mergeError('too_many_subscriptions');
  }
  if (input.values.length === 0) {
    return mergeError('empty_subscriptions');
  }

  const normalizedSubscriptions: NormalizedSubscription[] = [];
  for (const item of input.values) {
    const normalized = snapshotSubscription(item);
    if (normalized === null) {
      return mergeError('malformed_subscription');
    }
    normalizedSubscriptions.push(normalized);
  }

  const scopesBySubscriptionId = new Map<string, NormalizedSubscription>();
  const groupsByFilter = new Map<string | null, MutableFeedRequestGroup>();

  for (const subscription of normalizedSubscriptions) {
    const previous = scopesBySubscriptionId.get(subscription.id);
    if (previous !== undefined) {
      if (!sameSubscriptionScope(previous, subscription)) {
        return mergeError('conflicting_subscription_id');
      }
      continue;
    }
    scopesBySubscriptionId.set(subscription.id, subscription);

    let group = groupsByFilter.get(subscription.filterDigest);
    if (group === undefined) {
      if (groupsByFilter.size >= MAX_FEED_FILTER_GROUPS) {
        return mergeError('too_many_filter_groups');
      }
      group = {
        filterDigest: subscription.filterDigest,
        collectionIds: new Set<string>(),
        subscriptionIds: [],
        scopesBySubscriptionId: new Map<string, NormalizedSubscription>(),
        instanceWide: false,
      };
      groupsByFilter.set(subscription.filterDigest, group);
    }

    group.subscriptionIds.push(subscription.id);
    group.scopesBySubscriptionId.set(subscription.id, subscription);
    if (subscription.collectionId === null) {
      group.instanceWide = true;
      continue;
    }

    group.collectionIds.add(subscription.collectionId);
    if (group.collectionIds.size > MAX_FEED_COLLECTIONS_PER_FILTER_GROUP) {
      return mergeError('too_many_collections');
    }
  }

  const requests = [...groupsByFilter.values()].map(freezeRequestGroup);
  return Object.freeze({ ok: true, requests: Object.freeze(requests) });
}

/**
 * Validates an instance Feed page and routes it to one subscription from the
 * supplied filter-bound request group.
 *
 * The complete page is contract-validated before group or Collection fan-out.
 * A subscription cannot consume an unknown group, a group for another id, or
 * a group with a different server-side filter binding.
 */
export function routeMergedFeedEvents(
  events: readonly FeedEvent[],
  subscription: FeedSubscription,
  request: MergedFeedRequest,
): readonly VerifiedFeedEvent[] {
  const eventSnapshots = snapshotExactArray(events, 'events');
  const verifiedEvents: VerifiedFeedEvent[] = [];
  for (let index = 0; index < eventSnapshots.length; index += 1) {
    const discriminated = discriminateFeedEvent(eventSnapshots[index]);
    if (!discriminated.valid) {
      throw new TypeError(
        `events[${index}] is not a valid Feed Event: ${discriminated.code} at ${discriminated.path}.`,
      );
    }
    verifiedEvents.push(discriminated.event);
  }

  const normalizedSubscription = snapshotSubscription(subscription);
  if (normalizedSubscription === null) {
    throw new TypeError('subscription must contain exact valid own data properties.');
  }
  const requestScope = issuedScopeForRequest(request);
  assertRequestCoversSubscription(request, normalizedSubscription, requestScope);

  if (normalizedSubscription.collectionId === null) {
    return Object.freeze(verifiedEvents);
  }

  return Object.freeze(
    verifiedEvents.filter(
      (event) => event.data.collectionId === normalizedSubscription.collectionId,
    ),
  );
}

function snapshotSubscriptionArray(
  value: unknown,
): { readonly kind: 'ok'; readonly values: readonly unknown[] }
  | { readonly kind: 'too-many' } {
  if (typeof value === 'object' && value !== null && nodeTypes.isProxy(value)) {
    throw new TypeError('subscriptions must be an exact ordinary dense array.');
  }
  const inspection = inspectExactDenseArray(value, {
    maxLength: MAX_FEED_SUBSCRIPTIONS,
  });
  if (inspection.ok) {
    return { kind: 'ok', values: Object.freeze([...inspection.values]) };
  }

  if (inspection.failure === 'invalid-length') {
    const length = safeArrayLength(value);
    if (length !== null && length > MAX_FEED_SUBSCRIPTIONS) {
      return { kind: 'too-many' };
    }
  }
  throw new TypeError('subscriptions must be an exact ordinary dense array.');
}

function snapshotSubscription(value: unknown): NormalizedSubscription | null {
  const descriptors = exactOwnDataDescriptors(
    value,
    SUBSCRIPTION_OWN_KEYS,
  );
  if (descriptors === null) {
    return null;
  }

  const id = ownDataValue(descriptors, 'id', true);
  const collectionId = ownDataValue(descriptors, 'collectionId', true);
  const filterDigestValue = ownDataValue(descriptors, 'filterDigest', false);
  if (
    !isBoundedNonEmptyString(id, MAX_FEED_SUBSCRIPTION_ID_LENGTH) ||
    !(
      collectionId === null ||
      collectionId === '*' ||
      isBoundedNonEmptyString(collectionId, MAX_FEED_COLLECTION_ID_LENGTH)
    ) ||
    !(
      filterDigestValue === undefined ||
      isBoundedNonEmptyString(filterDigestValue, MAX_FEED_FILTER_DIGEST_LENGTH)
    )
  ) {
    return null;
  }

  return Object.freeze({
    id,
    collectionId: collectionId === '*' ? null : collectionId,
    filterDigest: filterDigestValue ?? null,
  });
}

function assertRequestCoversSubscription(
  request: MergedFeedRequest,
  subscription: NormalizedSubscription,
  issuedScopes: ReadonlyMap<string, NormalizedSubscription>,
): void {
  const issuedSubscription = issuedScopes.get(subscription.id);
  if (
    issuedSubscription === undefined ||
    !sameSubscriptionScope(issuedSubscription, subscription) ||
    request.filterDigest !== subscription.filterDigest
  ) {
    throw new TypeError('subscription is not covered by the supplied filter group.');
  }
}

function issuedScopeForRequest(value: unknown): ReadonlyMap<string, NormalizedSubscription> {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    throw new TypeError('request must be an issued Feed merge request.');
  }
  const scopes = issuedRequestScopes.get(value);
  if (scopes === undefined) {
    throw new TypeError('request must be an issued Feed merge request.');
  }
  return scopes;
}

function snapshotExactArray(
  value: unknown,
  name: string,
  maxLength?: number,
): readonly unknown[] {
  if (typeof value === 'object' && value !== null && nodeTypes.isProxy(value)) {
    throw new TypeError(`${name} must be an exact ordinary dense array.`);
  }
  const inspection = inspectExactDenseArray(
    value,
    maxLength === undefined ? undefined : { maxLength },
  );
  if (!inspection.ok) {
    throw new TypeError(`${name} must be an exact ordinary dense array.`);
  }
  return Object.freeze([...inspection.values]);
}

function exactOwnDataDescriptors(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Readonly<Record<string, PropertyDescriptor | undefined>> | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const descriptors: Record<string, PropertyDescriptor | undefined> = Object.create(null) as Record<
    string,
    PropertyDescriptor | undefined
  >;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      return null;
    }
    descriptors[key] = descriptor;
  }
  return descriptors;
}

function ownDataValue(
  descriptors: Readonly<Record<string, PropertyDescriptor | undefined>>,
  key: string,
  required: boolean,
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined) {
    return required ? MISSING_PROPERTY : undefined;
  }
  return descriptor.value;
}

const MISSING_PROPERTY = Symbol('missing-property');

function safeArrayLength(value: unknown): number | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeTypes.isProxy(value) ||
    !Array.isArray(value)
  ) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  return descriptor !== undefined &&
    'value' in descriptor &&
    Number.isSafeInteger(descriptor.value) &&
    (descriptor.value as number) >= 0
    ? descriptor.value as number
    : null;
}

function sameSubscriptionScope(
  left: NormalizedSubscription,
  right: NormalizedSubscription,
): boolean {
  return left.collectionId === right.collectionId && left.filterDigest === right.filterDigest;
}

function freezeRequestGroup(group: MutableFeedRequestGroup): MergedFeedRequest {
  const request = Object.freeze({
    endpoint: 'instanceFeed' as const,
    filterDigest: group.filterDigest,
    collectionIds: Object.freeze(
      group.instanceWide ? [] : [...group.collectionIds].sort(),
    ),
    subscriptionIds: Object.freeze([...group.subscriptionIds]),
    instanceWide: group.instanceWide,
  }) as MergedFeedRequest;
  issuedRequestScopes.set(
    request,
    new Map<string, NormalizedSubscription>(group.scopesBySubscriptionId),
  );
  return request;
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function mergeError(code: FeedMergeErrorCode): FeedMergeResult {
  return Object.freeze({ ok: false, code });
}
