export const LEGACY_SYNC_TRANSPORT_BUDGET_BYTES = 2 * 1024 * 1024;
export const SYNC_TRANSPORT_BUDGET_MIN_BYTES = 16 * 1024;
export const SYNC_TRANSPORT_BUDGET_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_TRANSPORT_BUDGET_EXTENSION =
  'https://know-n.com/colp/extensions/sync-transport-budget';
export const SYNC_TRANSPORT_BUDGET_HEADER = 'Known-Sync-Transport-Budget';
/**
 * The negotiated budget header is a tiny fixed-shape JSON object.  Bound its
 * wire representation before invoking JSON.parse so a peer cannot force an
 * unbounded parse/allocation with a long ignored suffix or a giant number.
 */
export const SYNC_TRANSPORT_BUDGET_HEADER_MAX_BYTES = 1024;

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

export function defaultServerTransportBudget(
  effectPageBytes = 262_144,
): SyncTransportBudget {
  return freezeBudget({
    pullResponseBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
    snapshotPageBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
    effectPageBytes,
    effectAggregateBytes: LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  });
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

export function readDeclaredTransportBudget(extensions: unknown): SyncTransportBudget | undefined {
  if (extensions === undefined || extensions === null) return undefined;
  if (!isPlainObject(extensions)) throw new TypeError('Replica extensions must be a plain object.');
  if (!Object.hasOwn(extensions, SYNC_TRANSPORT_BUDGET_EXTENSION)) return undefined;
  return parseSyncTransportBudget(extensions[SYNC_TRANSPORT_BUDGET_EXTENSION]);
}

export function negotiateSyncTransportBudget(
  client: SyncTransportBudget | undefined,
  server: SyncTransportBudget,
): SyncTransportBudget {
  const declared = client ?? legacySyncTransportBudget();
  const negotiated = freezeBudget({
    pullResponseBytes: Math.min(declared.pullResponseBytes, server.pullResponseBytes),
    snapshotPageBytes: Math.min(declared.snapshotPageBytes, server.snapshotPageBytes),
    effectPageBytes: Math.min(declared.effectPageBytes, server.effectPageBytes),
    effectAggregateBytes: Math.min(declared.effectAggregateBytes, server.effectAggregateBytes),
  });
  if (negotiated.effectPageBytes > negotiated.effectAggregateBytes) {
    return freezeBudget({
      ...negotiated,
      effectPageBytes: negotiated.effectAggregateBytes,
    });
  }
  return negotiated;
}

export function encodeSyncTransportBudgetHeader(budget: SyncTransportBudget): string {
  return JSON.stringify({
    effectAggregateBytes: budget.effectAggregateBytes,
    effectPageBytes: budget.effectPageBytes,
    pullResponseBytes: budget.pullResponseBytes,
    snapshotPageBytes: budget.snapshotPageBytes,
  });
}

export function parseSyncTransportBudgetHeader(header: string | null | undefined): SyncTransportBudget {
  if (header === null || header === undefined || header === '') return legacySyncTransportBudget();
  if (typeof header !== 'string') throw new TypeError('SyncTransportBudget header is invalid.');
  if (new TextEncoder().encode(header).byteLength > SYNC_TRANSPORT_BUDGET_HEADER_MAX_BYTES) {
    throw new TypeError('SyncTransportBudget header exceeds its byte budget.');
  }
  let document: unknown;
  try { document = JSON.parse(header) as unknown; }
  catch { throw new TypeError('SyncTransportBudget header is invalid.'); }
  return parseSyncTransportBudget(document);
}

export function utf8JsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function jsonFitsTransportBudget(value: unknown, limit: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1 && utf8JsonByteLength(value) <= limit;
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
