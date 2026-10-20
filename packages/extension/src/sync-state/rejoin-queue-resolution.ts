import { requestValue } from './idb.js';
import { STORES } from './schema.js';
import { readScopeCommandRecord } from './scope-command-evidence.js';
import type { QueueOperation, UnknownRecord } from './types.js';

export interface RejoinQueueReference { readonly opId: string; readonly sequence: number; readonly digest: string }
export const rejoinResolutionId = (key: string, opId: string) => `rejoin-resolved:${key}:${opId}`;
export const rejoinGrantId = (key: string, id: string) => `rejoin-recovery:${key}:${id}`;
const matches = (row: QueueOperation, reference: RejoinQueueReference) => row.opId === reference.opId
  && row.sequence === reference.sequence && row.digest === reference.digest;
const decisions = new WeakMap<IDBTransaction, Map<string, Promise<{ dependencies: readonly string[]; references: readonly RejoinQueueReference[] } | null>>>();

/** Only display/protection changes. Original queue rows, attempts and receipts remain audit history. */
export async function unresolvedRejoinQueueRows(tx: IDBTransaction, key: string,
  rows: readonly QueueOperation[]): Promise<QueueOperation[]> {
  const diagnostics = tx.objectStore(STORES.diagnostics);
  // Only a refused terminal/local row can have been resolved. Pending,
  // claimed or unknown uploads still need their real outcome even if an old
  // diagnostic with the same identity exists.
  const values = await Promise.all(rows.map(row => row.status === 'terminal' || row.status === 'rejected'
    ? requestValue<UnknownRecord | undefined>(diagnostics.get(rejoinResolutionId(key, row.opId))) : undefined));
  return rows.filter((row, index) => {
    const value = values[index];
    return !value || value.kind !== 'rejoin_queue_resolution' || value.scopeKey !== key
      || value.opId !== row.opId || value.sequence !== row.sequence || value.digest !== row.digest;
  });
}

/** One accepted recovery may pass only its own rejected predecessors; other issue holds remain. */
export async function rejoinRecoveryHolders(tx: IDBTransaction, key: string, row: QueueOperation,
  holders: readonly QueueOperation[], maxBytes: number, eventId?: string): Promise<QueueOperation[]> {
  const diagnostics = tx.objectStore(STORES.diagnostics);
  const grant = await requestValue<UnknownRecord | undefined>(diagnostics.get(rejoinGrantId(key, row.opId)))
    ?? (eventId ? await requestValue<UnknownRecord | undefined>(diagnostics.get(rejoinGrantId(key, eventId))) : undefined);
  if (!grant || grant.kind !== 'rejoin_recovery_grant' || grant.scopeKey !== key
    || typeof grant.commandId !== 'string' || typeof grant.baselineDigest !== 'string') return [...holders];
  if (grant.operationDigest !== undefined && (grant.operationDigest !== row.digest || grant.sequence !== row.sequence)) return [...holders];
  let cache = decisions.get(tx); if (!cache) { cache = new Map(); decisions.set(tx, cache); }
  const id = JSON.stringify([key, grant.commandId, grant.baselineDigest]);
  let read = cache.get(id);
  if (!read) {
    read = (async () => {
      const raw = await requestValue(tx.objectStore(STORES.scopeCommandPlans).get([key, grant.commandId as string]));
      if (!raw) return null;
      const plan = await readScopeCommandRecord(tx, key, raw, maxBytes);
      if (!['confirmed', 'applying'].includes(plan.phase) || plan.baselineDigest !== grant.baselineDigest
        || !Array.isArray(plan.rejoinDecision?.rejectedReferences)) return null;
      return { dependencies: plan.dependencies, references: plan.rejoinDecision.rejectedReferences as unknown as RejoinQueueReference[] };
    })();
    cache.set(id, read);
  }
  const decision = await read;
  if (!decision || !decision.dependencies.includes(String(grant.dependencyId))) return [...holders];
  if (grant.operationDigest === undefined) diagnostics.put({ ...grant, id: rejoinGrantId(key, row.opId),
    operationDigest: row.digest, sequence: row.sequence });
  const references = new Map(decision.references.map(reference => [reference.opId, reference]));
  return holders.filter(holder => {
    const reference = references.get(holder.opId); return !reference || !matches(holder, reference);
  });
}
