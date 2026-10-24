import { STALLED_BUCKET_PREFIX } from './sync-circuit-breaker.js';
import type { SyncAttentionTerminalCode } from './sync-attention-types.js';
import { holdsUnprovenIdentity, needsReplicaRebuild, persistentLocalSyncFailure, refreshesReplicaIntegrity } from './sync-failure-class.js';

/**
 * The one reading of "has sync stopped, and what ends it".
 *
 * Four places used to answer that question separately: the engine (`persistentLocalSyncFailure`: retrying cannot
 * change the result), the Status card (`syncAttentionTerminalCode`), the progress strip, and the Help diagnostic
 * (`collectSyncDiagnostics`, which also wanted `recoveryFrozen` and ignored the recorded recovery code). They
 * agreed on most codes and disagreed on the rest, so the card, the chip and the copied details could tell
 * different stories about the same state. All of them read the table through this function now, and
 * `tests/sync-stop-state.test.ts` walks every table entry to keep it so.
 *
 *   terminal  only a person ends it: a Reset or a decision (a rebuild or decide exit, `payload_too_large`, a
 *             reset that did not finish). The engine is frozen and does not look again.
 *   stopped   retrying cannot change the result (a `stop` exit). The engine checks again by itself on a schedule
 *             (5 minutes, 15 minutes, an hour, then every six hours) and Retry checks at once.
 *   stalled   a transient code that is not about the network or the server kept coming back with no progress, so
 *             the engine stopped polling it and checks on the same schedule.
 *   cooling   the circuit breaker paused the engine after repeated errors; it resumes by itself.
 *
 * Pull-time integrity stops (`refresh` exit) are none of these: they wait for a person's Retry and say so.
 */
export type SyncStopKind = 'terminal' | 'stopped' | 'stalled' | 'cooling';

export interface SyncStopFacts {
  readonly lastError?: string;
  /** `scope.metadata.recoveryCode`: the code recorded when the scope was frozen. */
  readonly recoveryCode?: string;
  readonly phase?: string;
  /** The engine's circuit breaker row: its bucket names and the deadline of the pause. */
  readonly breaker?: { readonly failures: readonly { readonly code: string }[]; readonly retryAt?: number };
}

export interface SyncStopState {
  readonly kind: SyncStopKind;
  /** The code that explains it: the freeze code, the stop code, or the code the engine kept waiting on. */
  readonly code: string;
}

/**
 * The engine's terminal gate is `recoveryFrozen && (holdsUnprovenIdentity || needsReplicaRebuild ||
 * lastError === 'payload_too_large')`; `freezeScopeRecovery` records the same code as
 * `scope.metadata.recoveryCode`. Checking both fields means a freeze stays visible even if only one of the two
 * rows survived.
 */
export function syncAttentionTerminalCode(lastError: string | undefined,
  recoveryCode: string | undefined): SyncAttentionTerminalCode | undefined {
  for (const code of [recoveryCode, lastError]) {
    if (code === 'payload_too_large' || code === 'replica_rebuild_pending') return code;
    if (needsReplicaRebuild(code)) return code as SyncAttentionTerminalCode;
    if (holdsUnprovenIdentity(code)) return code as SyncAttentionTerminalCode;
  }
  return undefined;
}

/** Whether sync has stopped, why, and which way out it has. `undefined`: it has not stopped (it may be waiting, which is its own story). */
export function syncStopState(facts: SyncStopFacts): SyncStopState | undefined {
  const terminal = syncAttentionTerminalCode(facts.lastError, facts.recoveryCode);
  if (terminal) return { kind: 'terminal', code: terminal };
  const code = facts.lastError;
  if (facts.phase !== 'error' || code === undefined) return undefined;
  if (refreshesReplicaIntegrity(code)) return undefined;
  if (facts.breaker?.failures.some(row => row.code === `${STALLED_BUCKET_PREFIX}${code}`)) return { kind: 'stalled', code };
  if (persistentLocalSyncFailure(code)) return { kind: 'stopped', code };
  if (facts.breaker?.retryAt !== undefined) return { kind: 'cooling', code };
  return undefined;
}
