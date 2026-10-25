/**
 * SR-10 / A-08: the read-only service-worker side of the options page's
 * "not included in sync" list.
 *
 * The durable ledger already exists — `listIngressDiagnostics` returns one row
 * per `(scopeKey, code)` with an accumulated `count`, a first-only `firstAt` and
 * a monotone `lastAt`, already sorted by `lastAt` desc — so this handler is a
 * projection, not a new store: it reads, renames nothing, and writes nothing.
 *
 * Two deliberate omissions:
 *   - `id`/`scopeKey` never leave the worker; the page has no use for them and
 *     they are the only fields that name internal rows;
 *   - `park:` rows are dropped here rather than in the page, because the code
 *     embeds an inbox `eventId` (`park:${eventId}`, see `PARK_MARKER_PREFIX`),
 *     their `count` is a marker-refresh round count rather than a number of
 *     filtered bookmarks, and the quarantine state is already surfaced through
 *     the native-wait / sync-attention channels. Dropping them in the worker
 *     means the id never crosses the message boundary at all.
 *
 * Like `sw/sync-attention.ts` this module never wakes the engine, never takes a
 * coordinator lane and never requires a user gesture.
 *
 * One addition at read time (C-20 / D2): for the three "this bookmark cannot be
 * synced" rows the handler may attach `example`, a live bookmark still refused
 * for that reason (`sw/ingress-examples.ts`). It is best effort — a slow, failing
 * or impossible tree read gives the list as it was — and it exists only in this
 * response: nothing is stored and no other report reads it.
 */
import { isParkMarkerCode } from '../ingress-diagnostics-ui.js';
import type { IngressDiagnosticRecord } from '../sync-state/bookmark-event-repository.js';
import type { createSyncStateStore, SyncScope } from '../sync-state-store.js';
import type { IngressDiagnosticsResponse, PublicIngressDiagnostic, PublicIngressExample } from '../types.js';
import { REFUSED_REASONS } from './ingress-examples.js';

export type IngressDiagnosticsStore = Pick<ReturnType<typeof createSyncStateStore>, 'listIngressDiagnostics'>;

/** The list must paint well inside the page's own 8 s wait; a tree read that takes longer is given up. */
export const INGRESS_EXAMPLES_BUDGET_MS = 3_000;

export interface IngressDiagnosticsDeps {
  readonly scope: () => Promise<SyncScope>;
  readonly store: IngressDiagnosticsStore;
  /** Live examples per ledger code. Absent, failing or too slow means no examples. */
  readonly examples?: (scope: SyncScope) => Promise<ReadonlyMap<string, PublicIngressExample>>;
}

async function liveExamples(deps: IngressDiagnosticsDeps, scope: SyncScope,
  rows: readonly PublicIngressDiagnostic[]): Promise<ReadonlyMap<string, PublicIngressExample>> {
  if (!deps.examples || !rows.some((row) => (REFUSED_REASONS as readonly string[]).includes(row.code))) return new Map();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([deps.examples(scope),
      new Promise<ReadonlyMap<string, PublicIngressExample>>((resolve) => {
        timer = setTimeout(() => resolve(new Map()), INGRESS_EXAMPLES_BUDGET_MS);
      })]);
  } catch { return new Map(); } finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * The public shape: exactly the four fields the list renders. `count` is
 * normalized to the documented "≥ 1" contract so a corrupt row cannot render as
 * "Count: 0", and a non-finite timestamp is read as `0` (time unknown) instead of NaN.
 */
export function publicIngressDiagnostic(row: IngressDiagnosticRecord): PublicIngressDiagnostic {
  const count = Number.isSafeInteger(row.count) && row.count >= 1 ? row.count : 1;
  return { code: row.code, count,
    firstAt: Number.isFinite(row.firstAt) ? row.firstAt : 0,
    lastAt: Number.isFinite(row.lastAt) ? row.lastAt : 0 };
}

export async function handleIngressDiagnosticsRequest(
  deps: IngressDiagnosticsDeps,
): Promise<IngressDiagnosticsResponse> {
  let scope: SyncScope;
  try { scope = await deps.scope(); } catch { return { ok: false, error: 'not_connected' }; }
  try {
    const rows = await deps.store.listIngressDiagnostics(scope);
    // Order is the store's (`lastAt` desc, `code` asc) — never re-sorted here.
    const diagnostics = rows.filter((row) => !isParkMarkerCode(row.code)).map(publicIngressDiagnostic);
    const examples = await liveExamples(deps, scope, diagnostics);
    return { ok: true, diagnostics: diagnostics.map((row) => {
      const example = examples.get(row.code);
      return example ? { ...row, example } : row;
    }) };
  } catch { return { ok: false, error: 'state_unavailable' }; }
}
