import {
  defaultServerTransportBudget,
  legacySyncTransportBudget,
  parseSyncTransportBudget,
  type SyncTransportBudget,
} from '@know-n/colp/sync';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

export {
  defaultServerTransportBudget,
  encodeSyncTransportBudgetHeader,
  LEGACY_SYNC_TRANSPORT_BUDGET_BYTES,
  legacySyncTransportBudget,
  negotiateSyncTransportBudget,
  parseSyncTransportBudget,
  readDeclaredTransportBudget,
  SYNC_TRANSPORT_BUDGET_EXTENSION,
  SYNC_TRANSPORT_BUDGET_HEADER,
  type SyncTransportBudget,
} from '@know-n/colp/sync';

export function transportBudgetFromBindingJson(binding: unknown): SyncTransportBudget {
  if (binding === undefined || binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return legacySyncTransportBudget();
  }
  const record = binding as Record<string, unknown>;
  if (!Object.hasOwn(record, 'transportBudget')) return legacySyncTransportBudget();
  try {
    return parseSyncTransportBudget(record.transportBudget);
  } catch {
    return legacySyncTransportBudget();
  }
}

export function resolvePullResponseBudget(
  binding: unknown,
  configuredBudget: number | undefined,
): number {
  const sessionBudget = transportBudgetFromBindingJson(binding).pullResponseBytes;
  if (configuredBudget === undefined) return sessionBudget;
  if (!Number.isSafeInteger(configuredBudget) || configuredBudget < 1) return sessionBudget;
  return Math.min(configuredBudget, sessionBudget);
}

export function snapshotByteCap(maxSnapshotBytes: number, binding: unknown): number {
  return Math.min(maxSnapshotBytes, transportBudgetFromBindingJson(binding).snapshotPageBytes);
}

/** Per-page transport budget; independent of the whole-tree aggregate cap. */
export function snapshotPageByteBudget(binding: unknown): number {
  return transportBudgetFromBindingJson(binding).snapshotPageBytes;
}

export function defaultProductionServerBudget(input: {
  readonly pullResponseBytes: number;
  readonly snapshotPageBytes: number;
  readonly effectPageBytes?: number;
}): SyncTransportBudget {
  return Object.freeze({
    ...defaultServerTransportBudget(input.effectPageBytes),
    pullResponseBytes: input.pullResponseBytes,
    snapshotPageBytes: input.snapshotPageBytes,
    effectAggregateBytes: Math.min(
      defaultServerTransportBudget().effectAggregateBytes,
      input.pullResponseBytes,
    ),
  });
}

export async function bindSessionTransportBudget(
  transaction: DatabaseTransaction,
  sessionId: string,
  state: 'issued' | 'replayed',
  negotiated: SyncTransportBudget,
): Promise<SyncTransportBudget> {
  const row = await transaction.selectFrom('sync_sessions').select('binding_json')
    .where('session_id', '=', sessionId).executeTakeFirst();
  if (!row) return negotiated;
  if (Object.hasOwn(row.binding_json, 'transportBudget')) {
    return transportBudgetFromBindingJson(row.binding_json);
  }
  if (state !== 'issued') return legacySyncTransportBudget();
  await transaction.updateTable('sync_sessions').set({
    binding_json: { ...row.binding_json, transportBudget: negotiated },
  }).where('session_id', '=', sessionId).execute();
  return negotiated;
}
