import type { SyncScope } from '../sync-state-store.js';
import { iterateCursor, requestValue } from '../sync-state/idb.js';
import type { PlacementIntent } from './indexeddb-store.js';
import { OBSERVATION_TTL_MS, SETTLE_MS, type Observation } from './observed-create.js';

const PREFIX = 'known.automation.observation.v1.';
const MAX_PENDING = 100, MAX_ATTENTION = 100;
const ATTENTION_TTL_MS = 7 * 86_400_000;
export const OBSERVED_ALARM = 'known-automation-observed';
export type ObservationStage = 'bookmark' | 'evidence' | 'rules' | 'intent' | 'move' | 'receipt';
export interface ObservationProblem { readonly stage: ObservationStage; readonly code: string; readonly retryable: boolean }
export interface PendingObservation extends Observation {
  readonly id: string; readonly ownerKey: string; readonly scope: SyncScope; readonly title: string;
  readonly state: 'pending' | 'processing' | 'attention'; readonly attempts: number; readonly nextAttemptAt: number;
  readonly problem?: ObservationProblem;
  /** Session-only import and undo markers captured before a browser restart can erase them. */
  readonly localCausation?: { readonly importing: boolean; readonly recentlyRemoved: boolean };
}
type Run = <T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>) => Promise<T>;
const range = () => IDBKeyRange.bound(PREFIX, `${PREFIX}\uffff`);

async function entries(state: IDBObjectStore): Promise<PendingObservation[]> {
  const rows: PendingObservation[] = [];
  await iterateCursor(state, range(), value => { rows.push(value as PendingObservation); });
  return rows;
}
/** Called within clearAccount's transaction as well, so sign-out fences pending work. */
export async function clearObservedAccount(state: IDBObjectStore, ownerKey: string): Promise<void> {
  await iterateCursor(state, range(), (value, cursor) => { if ((value as PendingObservation).ownerKey === ownerKey) cursor.delete(); });
}

/** Durable evaluation up to the native boundary; handoff and intent insertion share a transaction. */
export function createObservedQueue(run: Run, changed: () => Promise<unknown> | undefined) {
  async function writeEntry(state: IDBObjectStore, entry: PendingObservation): Promise<void> {
    const all = await entries(state);
    const others = all.filter(row => row.id !== entry.id);
    if (entry.state !== 'attention' && others.filter(row => row.state !== 'attention').length >= MAX_PENDING)
      throw new Error('observation_queue_full');
    const attention = others.filter(row => row.state === 'attention').sort((a, b) => b.observedAt - a.observedAt);
    for (const [index, row] of attention.entries()) {
      if (entry.observedAt - row.observedAt > ATTENTION_TTL_MS || index >= MAX_ATTENTION - (entry.state === 'attention' ? 1 : 0))
        state.delete(PREFIX + row.id);
    }
    state.put(entry, PREFIX + entry.id);
  }
  async function save(entry: PendingObservation): Promise<void> {
    await run(['state'], 'readwrite', tx => writeEntry(tx.objectStore('state'), entry));
    await changed();
  }
  return {
    save,
    list: () => run(['state'], 'readonly', tx => entries(tx.objectStore('state'))),
    async claim(id: string, now: number, manual = false): Promise<PendingObservation | null> {
      return run(['state'], 'readwrite', async tx => {
        const state = tx.objectStore('state'), entry = await requestValue(state.get(PREFIX + id)) as PendingObservation | undefined;
        if (!entry || entry.state === 'attention' || now - entry.observedAt < SETTLE_MS || !manual && now < entry.nextAttemptAt) return null;
        const claimed: PendingObservation = { ...entry, state: 'processing', attempts: entry.attempts + 1 };
        state.put(claimed, PREFIX + id); return claimed;
      });
    },
    async remove(id: string): Promise<void> {
      await run(['state'], 'readwrite', async tx => { tx.objectStore('state').delete(PREFIX + id); }); await changed();
    },
    async fail(id: string, problem: ObservationProblem, now: number): Promise<PendingObservation | null> {
      const failed = await run(['state'], 'readwrite', async tx => {
        const state = tx.objectStore('state'), entry = await requestValue(state.get(PREFIX + id)) as PendingObservation | undefined;
        // An intent already owns this work after handoff. Never re-create an evaluation that could move twice.
        if (!entry) return null;
        const retryable = problem.retryable && now - entry.observedAt < OBSERVATION_TTL_MS;
        const next: PendingObservation = { ...entry, state: retryable ? 'pending' : 'attention',
          problem: { ...problem, ...(problem.retryable && !retryable ? { code: 'observation_expired' } : {}), retryable }, nextAttemptAt: Math.min(entry.observedAt + OBSERVATION_TTL_MS,
            now + Math.min(5_000, 1_000 * 2 ** Math.min(entry.attempts, 3))) };
        await writeEntry(state, next); return next;
      });
      if (failed) await changed(); return failed;
    },
    async handoff(entry: PendingObservation, intent: PlacementIntent): Promise<void> {
      await run(['state', 'intents'], 'readwrite', async tx => {
        const state = tx.objectStore('state'), stored = await requestValue(state.get(PREFIX + entry.id)) as PendingObservation | undefined;
        if (!stored || stored.ownerKey !== entry.ownerKey || stored.state !== 'processing') throw new Error('observation_context_changed');
        tx.objectStore('intents').put({ ...intent, observation: entry });
        state.delete(PREFIX + entry.id);
      });
      await changed();
    },
    /** A stopped native attempt becomes a terminal check; sign-out cannot be undone by a late recovery callback. */
    async abandon(intentId: string, problem: ObservationProblem): Promise<boolean> {
      const abandoned = await run(['state', 'intents'], 'readwrite', async tx => {
        const intents = tx.objectStore('intents'), stored = await requestValue(intents.get(intentId)) as PlacementIntent | undefined;
        if (!stored?.observation) return false;
        await writeEntry(tx.objectStore('state'), { ...stored.observation, state: 'attention', problem });
        intents.delete(intentId); return true;
      });
      if (abandoned) await changed(); return abandoned;
    },
  };
}
