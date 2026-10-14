/**
 * Why a bookmark appeared in this browser. Only new local intent (the user
 * starring a page, or adding one in the browser's bookmark manager) may start
 * intake here:
 *
 * - `ownEcho`: the extension saved it, and the pre-save path already decided.
 * - `inboundProjection`: Sync applied it from the server, recognized by its
 *   canonical identity. Its intake belongs to the device or server that made it,
 *   so two browsers projecting one change never run a rule twice.
 * - `import`, `recovery`: the browser's or Know-N's import, an undo or restore,
 *   or a page re-created moments after it was removed. Not intake.
 * - `outsideCollection`: Sync did not capture it (unsynced or private folder).
 *   There is no canonical create for a receipt to name.
 */
export type CreateCause = 'localIntent' | 'ownEcho' | 'inboundProjection' | 'import' | 'recovery' | 'outsideCollection';

export interface CreateEvidence {
  /** The Sync capture of this create; `placement` marks the extension's own reserved save. */
  readonly localCreate: { readonly placement: boolean } | null;
  /** A canonical mapping already names this native node. */
  readonly projected: boolean;
  /** A browser or Know-N import was running when it appeared. */
  readonly importing: boolean;
  /** The same URL was removed in this browser shortly before. */
  readonly recentlyRemoved: boolean;
}

export function createCause(evidence: CreateEvidence): CreateCause {
  if (evidence.importing) return 'import';
  if (evidence.localCreate?.placement) return 'ownEcho';
  if (!evidence.localCreate) return evidence.projected ? 'inboundProjection' : 'outsideCollection';
  return evidence.recentlyRemoved ? 'recovery' : 'localIntent';
}
