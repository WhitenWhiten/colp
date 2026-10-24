import type { SyncScope } from '../sync-state-store.js';
import { store, syncState } from './runtime.js';
import { ensureSyncScope, loadConfig } from './scope.js';

/**
 * W2A-06: the scope's record is written when a Session is minted or renewed. If the sync database is lost or
 * recreated while the binding (in `storage.local`) and the Session survive, nothing wrote it again until the
 * Session next renewed: every wake found no scope and ended without a word, and the first-sync preview ran
 * against an unregistered scope. A wake that finds a live Session and no record registers the scope from that
 * Session now (the same call the Session lane makes), and leaves a diagnostic saying it did.
 *
 * - `present`: nothing to do.
 * - `no_authority`: no credential or Session to register with; the Session lane registers when it mints one.
 * - `registered`: the scope was missing and has been written again (first sync starts from the merge).
 */
export async function ensureRegisteredScope(scope: SyncScope): Promise<'present' | 'no_authority' | 'registered'> {
  if (await syncState.getScope(scope)) return 'present';
  const credential = await store.loadCredential(); const session = await store.loadSession();
  if (!credential || !session) return 'no_authority';
  await ensureSyncScope(await loadConfig(), credential, session, (await store.fence.capture()).generation);
  await syncState.putScopeDiagnostic(scope, { kind: 'scope_reregistered', code: 'scope_not_registered' });
  return 'registered';
}
