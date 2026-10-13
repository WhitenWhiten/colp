import { FACTS_VERSION, prepareAutomationSchema } from './schema.js';
import { normalizeEventFacts, type NormalizedFacts } from './normalize.js';

const snapshotBrand: unique symbol = Symbol('automation.predicate.input');
/** Opaque in-memory handle; not a transport field, digest input or authority grant. */
export interface PreparedPredicateInput { readonly [snapshotBrand]: true }
interface Snapshot {
  source: unknown;
  version: number;
  normalized: NormalizedFacts;
  preparationMs: number;
}
const snapshots = new WeakMap<PreparedPredicateInput, Snapshot>();

/** Normalize once for a synchronous evaluation batch, retaining a private immutable copy. */
export function preparePredicateInput(value: unknown, options: { factsVersion?: number; now?: () => number } = {}): PreparedPredicateInput {
  prepareAutomationSchema('EventFacts');
  const now = options.now ?? (() => performance.now());
  const started = now();
  const version = options.factsVersion ?? FACTS_VERSION;
  const normalized = normalizeEventFacts(value, version);
  const handle = Object.freeze({ [snapshotBrand]: true as const });
  snapshots.set(handle, { source: value, version, normalized, preparationMs: now() - started });
  return handle;
}

/** Internal lookup rejects forged handles and use with another source/version. */
export function preparedPredicateInput(handle: PreparedPredicateInput, source: unknown, version = FACTS_VERSION): Snapshot | undefined {
  const snapshot = snapshots.get(handle);
  return snapshot?.source === source && snapshot.version === version ? snapshot : undefined;
}
