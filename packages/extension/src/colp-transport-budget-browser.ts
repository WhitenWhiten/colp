export const LEGACY_SYNC_TRANSPORT_BUDGET_BYTES = 2 * 1024 * 1024;
export const SYNC_TRANSPORT_BUDGET_MIN_BYTES = 16 * 1024;
export const SYNC_TRANSPORT_BUDGET_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_TRANSPORT_BUDGET_EXTENSION =
  'https://know-n.com/colp/extensions/sync-transport-budget';
export const SYNC_TRANSPORT_BUDGET_HEADER = 'Known-Sync-Transport-Budget';

export const SYNC_TRANSPORT_BUDGET_KEYS = Object.freeze([
  'effectAggregateBytes',
  'effectPageBytes',
  'pullResponseBytes',
  'snapshotPageBytes',
] as const);

export interface SyncTransportBudget {
  readonly pullResponseBytes: number;
  readonly snapshotPageBytes: number;
  readonly effectPageBytes: number;
  readonly effectAggregateBytes: number;
}

const budgetKeys = new Set<string>(SYNC_TRANSPORT_BUDGET_KEYS);

export function legacySyncTransportBudget(): SyncTransportBudget {
  return freezeBudget({
    pullResponseBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
    snapshotPageBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
    effectPageBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
    effectAggregateBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  });
}

/** Reads the budget declared by a Session request, falling back to legacy 2 MiB. */
export function declaredClientTransportBudget(request?: unknown): SyncTransportBudget {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return legacySyncTransportBudget();
  const replica = (request as Record<string, unknown>).replica;
  if (!replica || typeof replica !== 'object' || Array.isArray(replica)) return legacySyncTransportBudget();
  const extensions = (replica as Record<string, unknown>).extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)
      || !Object.hasOwn(extensions, SYNC_TRANSPORT_BUDGET_EXTENSION)) {
    return legacySyncTransportBudget();
  }
  try { return parseSyncTransportBudget((extensions as Record<string, unknown>)[SYNC_TRANSPORT_BUDGET_EXTENSION]); }
  catch { return legacySyncTransportBudget(); }
}

export function transportBudgetWithinDeclaration(
  observed: SyncTransportBudget,
  declared: SyncTransportBudget,
): boolean {
  return observed.pullResponseBytes <= declared.pullResponseBytes
    && observed.snapshotPageBytes <= declared.snapshotPageBytes
    && observed.effectPageBytes <= declared.effectPageBytes
    && observed.effectAggregateBytes <= declared.effectAggregateBytes;
}

export function sessionTransportBudget(session: { readonly transportBudget?: SyncTransportBudget }): SyncTransportBudget {
  return session.transportBudget ?? legacySyncTransportBudget();
}

export function parseSyncTransportBudget(value: unknown): SyncTransportBudget {
  if (!isPlainObject(value) || !exactKeys(value, budgetKeys)) {
    throw new TypeError('SyncTransportBudget is invalid.');
  }
  const budget = freezeBudget({
    pullResponseBytes: budgetBytes(value.pullResponseBytes),
    snapshotPageBytes: budgetBytes(value.snapshotPageBytes),
    effectPageBytes: budgetBytes(value.effectPageBytes),
    effectAggregateBytes: budgetBytes(value.effectAggregateBytes),
  });
  if (budget.effectPageBytes > budget.effectAggregateBytes) {
    throw new TypeError('SyncTransportBudget effectPageBytes exceeds effectAggregateBytes.');
  }
  return budget;
}

export function parseSyncTransportBudgetHeader(header: string | null | undefined): SyncTransportBudget {
  if (header === null || header === undefined || header === '') return legacySyncTransportBudget();
  let document: unknown;
  try { document = JSON.parse(header) as unknown; }
  catch { throw new TypeError('SyncTransportBudget header is invalid.'); }
  return parseSyncTransportBudget(document);
}

function budgetBytes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < SYNC_TRANSPORT_BUDGET_MIN_BYTES || value > SYNC_TRANSPORT_BUDGET_MAX_BYTES) {
    throw new TypeError('SyncTransportBudget field is out of range.');
  }
  return value;
}

function freezeBudget(budget: SyncTransportBudget): SyncTransportBudget {
  return Object.freeze({
    pullResponseBytes: budget.pullResponseBytes,
    snapshotPageBytes: budget.snapshotPageBytes,
    effectPageBytes: budget.effectPageBytes,
    effectAggregateBytes: budget.effectAggregateBytes,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}
