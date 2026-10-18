import { readHealthReceipt } from './replica-health-receipt.js';
import type { SyncScope } from '../sync-state-store.js';
import type { StorageArea } from '../credential-store.js';

export const HEALTH_STORAGE_KEY = 'known.sync.health.v1';
const RETENTION_MS = 8 * 24 * 60 * 60_000;
interface FinalReport { readonly body: Record<string, unknown>; readonly createdAt: number; readonly confirmedAt?: number; readonly retryAt?: number }
interface Entry { readonly scope: SyncScope; readonly value: Record<string, unknown>; readonly final?: FinalReport; readonly updatedAt: number }
interface Journal { readonly version: 2; readonly records: Record<string, Entry> }
const identity = (scope: SyncScope) => JSON.stringify([scope.serverOrigin, scope.serverId, scope.accountId,
  scope.browserProfileId, scope.collectionId, scope.replicaId, scope.generation]);
const sameOwner = (left: SyncScope, right: SyncScope) => left.serverOrigin === right.serverOrigin
  && left.serverId === right.serverId && left.accountId === right.accountId && left.browserProfileId === right.browserProfileId;

/** Scope-separated reports and immutable final deliveries survive worker and replica replacement. */
export async function createHealthDelivery(input: { scope: SyncScope; storage: Pick<StorageArea, 'get' | 'set'>;
  now: () => number; post: (body: Record<string, unknown>, scope: SyncScope) => Promise<Response>;
  receiptTimeoutMilliseconds?: number;
  archive?: (scope: SyncScope) => Promise<{ readonly reason?: unknown }> }) {
  const loaded = (await input.storage.get(HEALTH_STORAGE_KEY))[HEALTH_STORAGE_KEY] as Journal | undefined;
  const journal: Journal = loaded?.version === 2 ? loaded : { version: 2, records: {} };
  const key = identity(input.scope);
  const persist = () => input.storage.set({ [HEALTH_STORAGE_KEY]: journal });
  const finalBody = (entry: Entry, results: unknown[]) => ({ replicaId: entry.scope.replicaId,
    revision: Number(entry.value.revision ?? input.now()) + 1, state: 'stopped', code: 'replica_rebuilt',
    since: new Date(input.now()).toISOString(), issues: { total: 0, items: [] }, actions: [], commandResults: results });
  // If the worker stopped after durable replica rotation but before recording
  // the runner return, the actual archive proves that Rebuild completed.
  for (const entry of Object.values(journal.records)) {
    if (!sameOwner(entry.scope, input.scope) || entry.scope.replicaId === input.scope.replicaId || entry.final) continue;
    const commands = entry.value.commands as { commandId: string; action?: string; outcome?: string; reported?: boolean }[] | undefined;
    if (!commands?.some(command => command.action === 'rebuild' && !command.outcome)) continue;
    const archive = await input.archive?.(entry.scope).catch(() => undefined);
    if (archive?.reason !== 'user_replica_rebuild') continue;
    const finished = commands.map(command => command.action === 'rebuild' && !command.outcome
      ? { ...command, outcome: 'done' } : command);
    entry.value.commands = finished;
    (entry as { final?: FinalReport }).final = { createdAt: input.now(), body: finalBody(entry,
      finished.filter(command => command.outcome && !command.reported)
        .map(command => ({ commandId: command.commandId, outcome: command.outcome }))) };
    await persist();
  }
  const flush = async () => {
    for (const [entryKey, entry] of Object.entries(journal.records)) {
      if (!sameOwner(entry.scope, input.scope)) continue;
      if (entry.final && entry.final.confirmedAt === undefined && ((entry.final.retryAt ?? 0) <= input.now() || input.now() < Number(entry.final.retryAt) - 60_000)) {
        const sent = await input.post(entry.final.body, entry.scope).catch(() => undefined);
        const receipt = sent ? await readHealthReceipt(sent, entry.final.body,
          { timeoutMilliseconds: input.receiptTimeoutMilliseconds ?? 10_000 }).catch(() => undefined) : undefined;
        if (receipt) {
          if (!receipt.accepted && receipt.revision >= Number.MAX_SAFE_INTEGER) throw new Error('health_revision_exhausted');
          (entry as { final?: FinalReport }).final = receipt.accepted
            ? { ...entry.final, confirmedAt: input.now() }
            : { ...entry.final, body: { ...entry.final.body, revision: receipt.revision + 1 }, retryAt: input.now() + 60_000 };
          const delivered = new Set((entry.final.body.commandResults as { commandId: string }[] | undefined)?.map(result => result.commandId));
          const commands = entry.value.commands as { commandId: string; reported?: boolean }[] | undefined;
          if (commands) entry.value.commands = commands.map(command => delivered.has(command.commandId) ? { ...command, reported: true } : command);
          await persist();
        }
      }
      // Keep deduplication evidence through the server's seven-day command TTL.
      const pending = (entry.value.commands as { reported?: boolean }[] | undefined)?.some(command => !command.reported);
      if (entryKey !== key && !pending && (!entry.final || entry.final.confirmedAt !== undefined) && input.now() - entry.updatedAt > RETENTION_MS) {
        delete journal.records[entryKey]; await persist();
      }
    }
  };
  await flush();
  const storage: Pick<StorageArea, 'get' | 'set'> = {
    async get() { return { [HEALTH_STORAGE_KEY]: journal.records[key]?.value }; },
    async set(values) {
      const previous = journal.records[key];
      journal.records[key] = { ...previous, scope: input.scope, value: values[HEALTH_STORAGE_KEY] as Record<string, unknown>, updatedAt: input.now() };
      await persist();
    },
  };
  return { storage, async stageFinal(body: Record<string, unknown>) {
    const current = journal.records[key]; if (!current) throw new Error('health_record_missing');
    journal.records[key] = { ...current, final: { body, createdAt: input.now() } }; await persist();
    await flush();
  } };
}
