import type { UnknownRecord } from './types.js';

/**
 * W2A-03: what a retired scope's archive keeps.
 *
 * A scope's pull facts (`pull_terminal_fact`, `pull_applied_fact`) are two diagnostics rows per applied remote
 * operation, never deleted while the scope lives, and about three quarters of an archive's bytes (12 of 15.5 MB
 * in the audit's measurement). Nothing reads them from an archive: a retired scope key is never applied to
 * again (a Reset, a sign-out and a remount all move to a new replica identity), and the mappings, the unsent
 * queue and the events, which are what a rebuild's identity hints, the metadata proofs and a support export
 * need, stay whole. Dropping the facts keeps every Reset and sign-out from copying the whole history again.
 */
export const ARCHIVE_OMITTED_DIAGNOSTICS: ReadonlySet<unknown> = new Set(['pull_terminal_fact', 'pull_applied_fact']);

export function slimArchive<T extends { readonly diagnostics: readonly UnknownRecord[] }>(exported: T): T & { readonly omittedPullFacts: number } {
  const diagnostics = exported.diagnostics.filter(row => !ARCHIVE_OMITTED_DIAGNOSTICS.has(row.kind));
  return { ...exported, diagnostics, omittedPullFacts: exported.diagnostics.length - diagnostics.length };
}
