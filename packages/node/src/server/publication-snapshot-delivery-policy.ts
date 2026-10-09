import { isProxy } from 'node:util/types';
import {
  planPublicationSnapshotDelivery as planBoundedDelivery,
  createPublicationSnapshotSinglePageResponse as createBoundedResponse,
  type PublicationSnapshotDeliveryInput,
  type PublicationSnapshotDeliveryOptions,
  type PublicationSnapshotDeliveryPlan,
  type PublicationSnapshotSinglePagePlan,
  type PublicationSnapshotSinglePageResponseInit,
} from './publication-snapshot-delivery-policy-core.js';
import {
  PublicationPublicProjectionError,
  type PublicationPublicProjectionLimits,
} from './publication-public-projection.js';

export * from './publication-snapshot-delivery-policy-core.js';

// An exact issued plan owns its default output budget. A copied object cannot
// use these limits to bypass the underlying single-page capability check.
const projectionBudgets = new WeakMap<object, Readonly<{ maxDepth: number; maxNodes: number }>>();

/** Choose delivery and bind a compatible default projection budget to a single-page plan. */
export function planPublicationSnapshotDelivery(
  input: PublicationSnapshotDeliveryInput,
  options?: PublicationSnapshotDeliveryOptions,
): PublicationSnapshotDeliveryPlan {
  const plan = planBoundedDelivery(input, options);
  if (plan.delivery === 'single-page') {
    // Source data was already copied, deeply frozen and bounded by the planner.
    // Count every JSON value, not only objects: these are projection's units.
    let maxDepth = 0;
    let maxNodes = 0;
    const pending: { value: unknown; depth: number }[] = [{ value: plan.snapshot, depth: 0 }];
    while (pending.length > 0) {
      const { value, depth } = pending.pop()!;
      maxNodes += 1;
      maxDepth = Math.max(maxDepth, depth);
      if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
      }
    }
    projectionBudgets.set(plan, Object.freeze({ maxNodes: Math.max(100_000, maxNodes), maxDepth: Math.max(64, maxDepth) }));
  }
  return plan;
}

/**
 * Use the issued plan's measured budget by default. Explicit tighter output
 * limits remain authoritative and may reject output. Authorization, extension
 * allowlisting, schema checks and hard wire-byte limits are never bypassed.
 */
export function createPublicationSnapshotSinglePageResponse(
  plan: PublicationSnapshotSinglePagePlan,
  init: PublicationSnapshotSinglePageResponseInit,
): Response {
  const budget = typeof plan === 'object' && plan !== null ? projectionBudgets.get(plan) : undefined;
  if (budget === undefined) return createBoundedResponse(plan, init);
  const copied = copyDataRecord(init, false);
  const supplied = copied.publicProjectionLimits;
  const limits = supplied === undefined ? {} : copyDataRecord(supplied, true);
  if (Object.keys(limits).some(key => key !== 'maxDepth' && key !== 'maxNodes' && key !== 'maxBytes')) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  for (const value of Object.values(limits)) {
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1)) {
      throw new PublicationPublicProjectionError('invalid_policy');
    }
  }
  return createBoundedResponse(plan, {
    ...copied,
    publicProjectionLimits: {
      maxDepth: (limits.maxDepth as number | undefined) ?? budget.maxDepth,
      maxNodes: (limits.maxNodes as number | undefined) ?? budget.maxNodes,
      ...(limits.maxBytes === undefined ? {} : { maxBytes: limits.maxBytes as number }),
    },
  } as unknown as PublicationSnapshotSinglePageResponseInit);
}

function copyDataRecord(value: unknown, policy: boolean): Record<string, unknown> {
  const invalid = (): never => {
    if (policy) throw new PublicationPublicProjectionError('invalid_policy');
    throw new TypeError('Publication Snapshot delivery input is invalid.');
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
