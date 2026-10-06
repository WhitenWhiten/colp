import { isProxy } from 'node:util/types';

import { cloneAndFreezeJsonData, createValidatorRegistry } from '../schema/index.js';
import { validateSnapshotSemantics } from '../semantic/snapshot.js';
import type { Snapshot } from '../types/index.js';
import { assertPublicationSnapshotBookmarkUrls } from './publication-bookmark-url-guard.js';
import {
  PublicationPublicProjectionError,
  type PublicationPublicProjectionLimits,
} from './publication-public-projection.js';
import {
  createPublicationSnapshotPageResponse,
  type PublicationSnapshotNextLinkHeadersInit,
} from './publication-snapshot-next-link.js';

export type PublicationCollectionClassification = 'static' | 'dynamic';

export interface PublicationSnapshotDeliveryLimits {
  readonly smallMaxUtf8Bytes: number;
  readonly smallMaxObjects: number;
  readonly hardMaxUtf8Bytes: number;
  readonly hardMaxObjects: number;
}

export const publicationSnapshotDeliveryLimits: Readonly<PublicationSnapshotDeliveryLimits> = Object.freeze({
  smallMaxUtf8Bytes: 1 * 1_024 * 1_024,
  smallMaxObjects: 10_000,
  hardMaxUtf8Bytes: 64 * 1_024 * 1_024,
  hardMaxObjects: 1_000_000,
});

export interface PublicationSnapshotDeliveryInput {
  /** Storage/service classification; it is never inferred from request data. */
  readonly classification: PublicationCollectionClassification;
  /** Decoded SnapshotQuery DTO, not a raw URL search string. */
  readonly query: unknown;
  /**
   * Complete terminal authoritative source for an initial complete logical query,
   * or the canonical page selected by a cropped/continuation query.
   */
  readonly snapshot: unknown;
}

/**
 * Adapter/test options for delivery planning.
 * Request-shaped trust input remains {@link PublicationSnapshotDeliveryInput};
 * ceilings here are storage/service configuration, never client-controlled fields.
 */
export interface PublicationSnapshotDeliveryOptions {
  /**
   * Partial delivery ceilings. Omitted fields, and an empty object, keep the
   * production defaults in {@link publicationSnapshotDeliveryLimits}.
   */
  readonly limits: Readonly<Partial<PublicationSnapshotDeliveryLimits>>;
}

export class PublicationSnapshotAdapterContractError extends TypeError {
  readonly code = 'publication_snapshot_adapter_noncompliance';

  constructor() {
    super('Publication Snapshot adapter did not supply a complete terminal representation.');
    this.name = 'PublicationSnapshotAdapterContractError';
  }
}

export interface PublicationSnapshotDeliveryMetrics {
  readonly utf8Bytes: number;
  readonly objectCount: number;
}

declare const publicationSnapshotSinglePagePlanBrand: unique symbol;

export interface PublicationSnapshotSinglePagePlan {
  readonly [publicationSnapshotSinglePagePlanBrand]: true;
  readonly delivery: 'single-page';
  readonly classification: PublicationCollectionClassification;
  readonly snapshot: Readonly<Snapshot> & {
    readonly complete: true;
    readonly page: Readonly<{
      readonly sequence: 1;
      readonly hasMore: false;
      readonly nextCursor: null;
    }>;
  };
  readonly metrics: PublicationSnapshotDeliveryMetrics;
}

export interface PublicationSnapshotPaginationPlan {
  readonly delivery: 'paginate';
  readonly classification: 'dynamic';
  /** Complete immutable source for the existing PUB-0033/PUB-0034 paging adapter. */
  readonly snapshot: Readonly<Snapshot>;
  readonly metrics: PublicationSnapshotDeliveryMetrics;
  readonly reason: 'dynamic-over-small-limit';
}

export interface PublicationSnapshotPreservePagePlan {
  readonly delivery: 'preserve-page';
  readonly classification: PublicationCollectionClassification;
  /** The canonical input page is preserved; this policy does not crop or upgrade it. */
  readonly snapshot: Readonly<Snapshot>;
  /** Whether the request selects the complete logical Snapshot or a cropped projection. */
  readonly logicalScope: 'complete' | 'cropped';
  /** Continuations are distinguished from an initial request whose query is cropped. */
  readonly reason: 'continuation-page' | 'cropped-query';
}

export type PublicationSnapshotDeliveryPlan =
  | PublicationSnapshotSinglePagePlan
  | PublicationSnapshotPaginationPlan
  | PublicationSnapshotPreservePagePlan;

export interface PublicationSnapshotSinglePageResponseInit {
  readonly method: 'GET' | 'HEAD';
  readonly status?: number;
  readonly headers?: PublicationSnapshotNextLinkHeadersInit;
  /**
   * Exact HTTPS extension namespaces audited as safe for public Snapshot wire.
   * Defaults to `[]` (fail-closed) when omitted; forwarded to the page response
   * public-projection boundary.
   */
  readonly publicExtensionNamespaces?: readonly string[];
  readonly publicProjectionLimits?: PublicationPublicProjectionLimits;
}

const INVALID_INPUT = 'Publication Snapshot delivery input is invalid.';
const INPUT_LIMIT = 'Publication Snapshot delivery input limit exceeded.';
const STATIC_LIMIT = 'Static Publication Snapshot exceeds the safe single-page delivery limit.';
const MAX_DEPTH = 128;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const QUERY_KEYS = new Set(['root', 'depth', 'include', 'limit', 'pageCursor']);
const AUTHORITATIVE_INCLUDES = new Set(['annotations', 'attachments', 'relations']);
const validators = createValidatorRegistry();
const issuedSinglePagePlans = new WeakSet<object>();

class DeliveryInputLimitError extends Error {}
class StaticDeliveryLimitError extends Error {}

/**
 * Chooses the Publication Snapshot adapter path without manufacturing pages.
 * Static Collections remain single-page up to the hard safety ceiling; dynamic
 * Collections are paginated when their validated complete representation is not small.
 */
export function planPublicationSnapshotDelivery(
  input: PublicationSnapshotDeliveryInput,
  options?: PublicationSnapshotDeliveryOptions,
): PublicationSnapshotDeliveryPlan {
  return sanitize(() => {
    const limits = resolveDeliveryLimits(options);
    const record = inspectRecord(input);
    assertExactKeys(record, new Set(['classification', 'query', 'snapshot']));
    const classification = dataProperty(record, 'classification');
    if (classification !== 'static' && classification !== 'dynamic') throw new TypeError();

    const query = canonicalQuery(dataProperty(record, 'query'));
    const inspected = inspectSnapshotGraph(dataProperty(record, 'snapshot'), classification, limits);
    const snapshot = cloneAndFreezeJsonData(dataProperty(record, 'snapshot')) as Readonly<Snapshot>;
    if (!validators.validate('snapshot', snapshot).valid || snapshot.mode !== 'publication') throw new TypeError();
    assertPublicationSnapshotBookmarkUrls(snapshot);

    const metrics = Object.freeze(inspected);
    const completeLogicalSnapshot = querySelectsCompleteLogicalSnapshot(query);
    if (Object.hasOwn(query, 'pageCursor')) {
      return planContinuationSnapshotDelivery(
        classification,
        snapshot,
        completeLogicalSnapshot,
      );
    }
    return planInitialSnapshotDelivery(
      classification,
      snapshot,
      metrics,
      limits,
      completeLogicalSnapshot,
    );
  });
}

/** Creates a no-continuation GET/HEAD response while retaining adapter headers. */
export function createPublicationSnapshotSinglePageResponse(
  plan: PublicationSnapshotSinglePagePlan,
  init: PublicationSnapshotSinglePageResponseInit,
): Response {
  try {
    if (typeof plan !== 'object' || plan === null || !issuedSinglePagePlans.has(plan)) throw new TypeError();
    return createPublicationSnapshotPageResponse(plan.snapshot, {
      ...canonicalResponseInit(init),
      nextUrl: null,
    });
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    if (error instanceof RangeError) throw error;
    throw new TypeError(INVALID_INPUT);
  }
}

function canonicalQuery(value: unknown): Readonly<Record<string, unknown>> {
  const query = inspectRecord(value);
  const keys = Reflect.ownKeys(query);
  if (keys.some((key) => typeof key !== 'string' || !QUERY_KEYS.has(key))) throw new TypeError();
  const clone = cloneAndFreezeJsonData(query) as Readonly<Record<string, unknown>>;
  if (!validators.validate('snapshotQuery', clone).valid) throw new TypeError();
  return clone;
}

function querySelectsCompleteLogicalSnapshot(query: Readonly<Record<string, unknown>>): boolean {
  if (Object.hasOwn(query, 'root') || Object.hasOwn(query, 'depth')) return false;
  if (!Object.hasOwn(query, 'include')) return true;
  const include = query.include;
  return Array.isArray(include)
    && include.length === AUTHORITATIVE_INCLUDES.size
    && new Set(include).size === AUTHORITATIVE_INCLUDES.size
    && include.every((value) => typeof value === 'string' && AUTHORITATIVE_INCLUDES.has(value));
}

function planInitialSnapshotDelivery(
  classification: PublicationCollectionClassification,
  snapshot: Readonly<Snapshot>,
  metrics: PublicationSnapshotDeliveryMetrics,
  limits: Readonly<PublicationSnapshotDeliveryLimits>,
  completeLogicalSnapshot: boolean,
): PublicationSnapshotDeliveryPlan {
  if (!completeLogicalSnapshot) {
    assertLogicalSnapshotCompleteness(snapshot, false);
    assertSnapshotSemantics(snapshot, false);
    return Object.freeze({
      delivery: 'preserve-page',
      classification,
      snapshot,
      logicalScope: 'cropped',
      reason: 'cropped-query',
    });
  }

  if (!isCompleteSinglePage(snapshot)) {
    assertSnapshotSemantics(snapshot, false);
    throw new PublicationSnapshotAdapterContractError();
  }
  assertSnapshotSemantics(snapshot, true);

  const small = metrics.utf8Bytes <= limits.smallMaxUtf8Bytes
    && metrics.objectCount <= limits.smallMaxObjects;
  if (classification === 'dynamic' && !small) {
    return Object.freeze({
      delivery: 'paginate',
      classification,
      snapshot,
      metrics,
      reason: 'dynamic-over-small-limit',
    });
  }

  const plan = Object.freeze({
    delivery: 'single-page',
    classification,
    snapshot: snapshot as PublicationSnapshotSinglePagePlan['snapshot'],
    metrics,
  }) as PublicationSnapshotSinglePagePlan;
  issuedSinglePagePlans.add(plan);
  return plan;
}

function planContinuationSnapshotDelivery(
  classification: PublicationCollectionClassification,
  snapshot: Readonly<Snapshot>,
  completeLogicalSnapshot: boolean,
): PublicationSnapshotPreservePagePlan {
  assertLogicalSnapshotCompleteness(snapshot, completeLogicalSnapshot);
  assertSnapshotSemantics(snapshot, false);
  return Object.freeze({
    delivery: 'preserve-page',
    classification,
    snapshot,
    logicalScope: completeLogicalSnapshot ? 'complete' : 'cropped',
    reason: 'continuation-page',
  });
}

function assertLogicalSnapshotCompleteness(snapshot: Readonly<Snapshot>, expected: boolean): void {
  if (snapshot.complete !== expected) throw new PublicationSnapshotAdapterContractError();
}

function isCompleteSinglePage(snapshot: Readonly<Snapshot>): snapshot is PublicationSnapshotSinglePagePlan['snapshot'] {
  return snapshot.complete === true
    && snapshot.page.sequence === 1
    && snapshot.page.hasMore === false
    && snapshot.page.nextCursor === null;
}

function assertSnapshotSemantics(snapshot: Readonly<Snapshot>, authoritative: boolean): void {
  const semantic = validateSnapshotSemantics(snapshot, {
    publicationExtensionMode: 'consumer',
    ...(authoritative ? {} : { referenceResolution: { mode: 'deferred' as const } }),
  });
  if (!semantic.valid) throw new TypeError();
}

function resolveDeliveryLimits(options: unknown): Readonly<PublicationSnapshotDeliveryLimits> {
  if (options === undefined) return publicationSnapshotDeliveryLimits;
  const record = inspectRecord(options);
  assertExactKeys(record, new Set(['limits']));
  const limitsValue = dataProperty(record, 'limits');
  const limitsRecord = inspectRecord(limitsValue);
  const allowed = new Set([
    'smallMaxUtf8Bytes',
    'smallMaxObjects',
    'hardMaxUtf8Bytes',
    'hardMaxObjects',
  ]);
  const keys = Reflect.ownKeys(limitsRecord);
  if (keys.length === 0) return publicationSnapshotDeliveryLimits;
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError();
  }
  const resolved: {
    smallMaxUtf8Bytes: number;
    smallMaxObjects: number;
    hardMaxUtf8Bytes: number;
    hardMaxObjects: number;
  } = {
    smallMaxUtf8Bytes: publicationSnapshotDeliveryLimits.smallMaxUtf8Bytes,
    smallMaxObjects: publicationSnapshotDeliveryLimits.smallMaxObjects,
    hardMaxUtf8Bytes: publicationSnapshotDeliveryLimits.hardMaxUtf8Bytes,
    hardMaxObjects: publicationSnapshotDeliveryLimits.hardMaxObjects,
  };
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError();
    const value = dataProperty(limitsRecord, key);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new TypeError();
    resolved[key as keyof PublicationSnapshotDeliveryLimits] = value;
  }
  return Object.freeze(resolved);
}

/**
 * Walks a Snapshot candidate as a JSON DAG.
 *
 * Cycle detection uses the current ancestor path only. Shared subtrees and
 * frozen constants (the same `Object.freeze([])` on two Nodes) are accepted;
 * `TypeError` is thrown only when the same object reappears on the active
 * ancestor path. Proxies are rejected independently of aliasing.
 *
 * `utf8Bytes` and `objectCount` accumulate once per traversal visit, not once
 * per unique object identity. A shared subtree therefore contributes again on
 * every incoming edge, matching JSON serialization and
 * {@link cloneAndFreezeJsonData} (neither preserves identity). Unique-object
 * counting would under-count against
 * {@link PublicationSnapshotDeliveryLimits.hardMaxUtf8Bytes} /
 * {@link PublicationSnapshotDeliveryLimits.hardMaxObjects}.
 */
function inspectSnapshotGraph(
  value: unknown,
  classification: PublicationCollectionClassification,
  limits: Readonly<PublicationSnapshotDeliveryLimits>,
): PublicationSnapshotDeliveryMetrics {
  type InspectFrame =
    | { readonly type: 'visit'; readonly value: unknown; readonly depth: number }
    | { readonly type: 'leave'; readonly object: object };
  const pending: InspectFrame[] = [{ type: 'visit', value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let objectCount = 0;
  let utf8Bytes = 0;
  const addBytes = (bytes: number): void => {
    utf8Bytes += bytes;
    if (utf8Bytes > limits.hardMaxUtf8Bytes) {
      if (classification === 'static') throw new StaticDeliveryLimitError();
      throw new DeliveryInputLimitError();
    }
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.type === 'leave') {
      ancestors.delete(current.object);
      continue;
    }
    if (current.value === null) {
      addBytes(4);
      continue;
    }
    if (typeof current.value === 'string') {
      addBytes(jsonStringUtf8Bytes(current.value));
      continue;
    }
    if (typeof current.value === 'boolean') {
      addBytes(current.value ? 4 : 5);
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)
        || (Number.isInteger(current.value) && !Number.isSafeInteger(current.value))) throw new TypeError();
      addBytes(String(current.value).length);
      continue;
    }
    if (typeof current.value !== 'object') throw new TypeError();
    if (isProxy(current.value)) throw new TypeError();
    if (ancestors.has(current.value)) throw new TypeError();
    if (current.depth > MAX_DEPTH) throw new DeliveryInputLimitError();
    ancestors.add(current.value);
    objectCount += 1;
    if (objectCount > limits.hardMaxObjects) throw new DeliveryInputLimitError();

    const array = Array.isArray(current.value);
    const prototype = Object.getPrototypeOf(current.value) as unknown;
    if ((array && prototype !== Array.prototype)
      || (!array && prototype !== Object.prototype && prototype !== null)) throw new TypeError();
    const keys = Reflect.ownKeys(current.value);
    const dataKeys = array ? keys.filter((key) => key !== 'length') : keys;
    addBytes(2 + Math.max(0, dataKeys.length - 1));
    pending.push({ type: 'leave', object: current.value });
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
      if (!array) addBytes(jsonStringUtf8Bytes(key) + 1);
      pending.push({ type: 'visit', value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return Object.freeze({ utf8Bytes, objectCount });
}

function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c || unit === 0x08 || unit === 0x09
      || unit === 0x0a || unit === 0x0c || unit === 0x0d) {
      bytes += 2;
    } else if (unit <= 0x1f) {
      bytes += 6;
    } else if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) throw new TypeError();
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError();
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError();
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function canonicalResponseInit(init: PublicationSnapshotSinglePageResponseInit): PublicationSnapshotSinglePageResponseInit {
  const record = inspectRecord(init);
  const keys = Reflect.ownKeys(record);
  const allowed = new Set(['method', 'status', 'headers', 'publicExtensionNamespaces', 'publicProjectionLimits']);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) throw new TypeError();
  const method = dataProperty(record, 'method');
  const status = Object.hasOwn(record, 'status') ? dataProperty(record, 'status') : undefined;
  const headers = Object.hasOwn(record, 'headers') ? dataProperty(record, 'headers') : undefined;
  const publicExtensionNamespaces = Object.hasOwn(record, 'publicExtensionNamespaces')
    ? dataProperty(record, 'publicExtensionNamespaces')
    : undefined;
  const publicProjectionLimits = Object.hasOwn(record, 'publicProjectionLimits')
    ? dataProperty(record, 'publicProjectionLimits')
    : undefined;
  if ((method !== 'GET' && method !== 'HEAD')
    || (status !== undefined && (!Number.isInteger(status) || (status as number) < 200 || (status as number) > 599))) {
    throw new TypeError();
  }
  return Object.freeze({
    method,
    ...(status === undefined ? {} : { status: status as number }),
    ...(headers === undefined ? {} : { headers: headers as PublicationSnapshotNextLinkHeadersInit }),
    ...(publicExtensionNamespaces === undefined
      ? {}
      : { publicExtensionNamespaces: publicExtensionNamespaces as readonly string[] }),
    ...(publicProjectionLimits === undefined
      ? {}
      : { publicProjectionLimits: publicProjectionLimits as PublicationPublicProjectionLimits }),
  });
}

function inspectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) throw new TypeError();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || FORBIDDEN_KEYS.has(key))) throw new TypeError();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, expected: ReadonlySet<string>): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.size || keys.some((key) => typeof key !== 'string' || !expected.has(key))) {
    throw new TypeError();
  }
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function sanitize<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PublicationSnapshotAdapterContractError) throw error;
    if (error instanceof StaticDeliveryLimitError) throw new RangeError(STATIC_LIMIT, { cause: error });
    if (error instanceof DeliveryInputLimitError || error instanceof RangeError) throw new RangeError(INPUT_LIMIT, { cause: error });
    throw new TypeError(INVALID_INPUT, { cause: error });
  }
}
