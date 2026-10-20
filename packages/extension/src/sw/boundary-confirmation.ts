import type { SyncScope } from '../sync-state-store.js';
import { rootScopeKey } from './runtime.js';

const executing = new Map<string, Promise<unknown>>();

/** The durable admission owns cross-restart exclusion. This only joins callers
 * in the same worker, so a status read cannot execute a pending command twice. */
export async function runBoundaryConfirmation<T>(scope: SyncScope, commandId: string,
  work: () => Promise<T>): Promise<T> {
  const key = `${rootScopeKey(scope)}:${commandId}`;
  const prior = executing.get(key);
  if (prior) return prior as Promise<T>;
  const pending = Promise.resolve().then(work);
  executing.set(key, pending);
  try { return await pending; }
  // A caller that sees this key always joins above; it cannot replace pending.
  finally { executing.delete(key); }
}
