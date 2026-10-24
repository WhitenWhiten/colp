import { CODE_NEXT, CODE_WHAT, CODE_WHOLE, FAMILY_WHAT, nextClause, type SyncProblemNext } from './sync-problem-copy.js';
import { problemOffersRetry, problemRetriesByItself, syncProblemFamily, syncProblemLane,
  type SyncProblemFamily, type SyncProblemLane } from './sync-problem-families.js';

export { problemOffersRetry, syncProblemFamily, syncProblemLane, type SyncProblemFamily, type SyncProblemLane };

/**
 * The problem catalog: any sync code, as a sentence a person can act on.
 *
 * One entry per family (see `sync-problem-families.ts`), a sentence of its own
 * for the few codes where the family would be vague, and the raw code in
 * brackets on everything that does not mend itself, so a code nobody wrote
 * words for still reads as "what happened, what happens next (CODE)". The same
 * facts feed the Status card, the terminal card, the copied details and the
 * Sync-center report, so a state is described the same way everywhere.
 */
export interface SyncProblem {
  readonly code: string;
  readonly family: SyncProblemFamily;
  readonly lane: SyncProblemLane;
  /** The engine retries it without being asked. */
  readonly byItself: boolean;
  /** "Retry sync" is worth offering (one rule for the extension and the Sync center). */
  readonly offersRetry: boolean;
  readonly what: string;
  readonly next: string;
  /** `what`, `next` and the code in brackets, ready to show. */
  readonly sentence: string;
}

export type SyncProblemContext = Partial<SyncProblemNext>;

/** Long synthesised codes (`snapshot_native_projection_ambiguous:<id>:…`) show only their stable start. */
export function shownProblemCode(code: string): string {
  return code.length > 64 ? `${code.slice(0, 63)}…` : code;
}

/** The table-less shapes that carry a stable head: `name:detail` is `name`. */
function lookupKey(code: string): string {
  const head = code.split(':', 1)[0]!;
  return CODE_WHAT[code] || CODE_WHOLE[code] || CODE_NEXT[code] ? code : head;
}

export function describeSyncProblem(code: string | undefined, context: SyncProblemContext = {}): SyncProblem {
  const family = syncProblemFamily(code);
  const next = { ...context, now: context.now ?? Date.now() };
  const key = code === undefined ? '' : lookupKey(code);
  const whole = CODE_WHOLE[key]?.();
  const what = whole ?? (CODE_WHAT[key] ?? FAMILY_WHAT[family])();
  const clause = whole !== undefined ? '' : (CODE_NEXT[key] ?? ((c: SyncProblemNext) => nextClause(family, c)))(next);
  // A calm self-healing retry does not need its code on the card; everything else does.
  const quiet = problemRetriesByItself(family) && family !== 'unknown' && context.retryAutomatic !== false;
  const sentence = [what, clause, code && !quiet ? `(${shownProblemCode(code)})` : ''].filter(Boolean).join(' ');
  return { code: code ?? '', family, lane: syncProblemLane(code), byItself: problemRetriesByItself(family),
    offersRetry: problemOffersRetry(code), what, next: clause, sentence };
}
