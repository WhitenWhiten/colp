/**
 * Client-facing presentation of a server Separator.
 *
 * Separators are authoritative Sync nodes, but browser bookmark managers do
 * not necessarily expose a native equivalent.  This projection is therefore
 * deliberately presentation-only: the original node is retained for identity
 * and ordering, while `presentation` tells a UI renderer to draw a divider.
 */
export interface SyncSeparatorVisualPresentation<Separator extends { readonly kind: 'separator' }> {
  readonly kind: 'separator';
  readonly presentation: 'visual';
  readonly separator: Separator;
}

/**
 * Client choice for whether a Separator is drawn. Omitting visual presentation
 * never mutates or drops the authoritative Separator record; it simply means
 * the host did not request a projection.
 */
export type SyncSeparatorVisualMode = 'omitted' | 'visible';

/**
 * Projects a server Separator for a client UI without changing the wire node
 * or implying that the browser can persist it natively.
 *
 * Identity and ordering fields on `separator` are preserved by reference; the
 * returned presentation is a distinct frozen envelope.
 */
export function projectSyncSeparatorForUi<Separator extends { readonly kind: 'separator' }>(
  separator: Separator,
): SyncSeparatorVisualPresentation<Separator> {
  if (typeof separator !== 'object' || separator === null || separator.kind !== 'separator') {
    throw new TypeError('Sync separator projection requires a server Separator node.');
  }
  return Object.freeze({
    kind: 'separator' as const,
    presentation: 'visual' as const,
    separator,
  });
}

/**
 * Optional visual representation helper.
 *
 * - `visible` → same envelope as {@link projectSyncSeparatorForUi}
 * - `omitted` → `undefined` (client chose not to draw; Separator identity is untouched)
 */
export function representSyncSeparatorForUiMode<Separator extends { readonly kind: 'separator' }>(
  separator: Separator,
  mode: SyncSeparatorVisualMode,
): SyncSeparatorVisualPresentation<Separator> | undefined {
  if (mode !== 'omitted' && mode !== 'visible') {
    throw new TypeError('Sync separator visual mode must be "omitted" or "visible".');
  }
  if (mode === 'omitted') {
    // Validating the node even when omitted keeps fail-closed input checks.
    if (typeof separator !== 'object' || separator === null || separator.kind !== 'separator') {
      throw new TypeError('Sync separator projection requires a server Separator node.');
    }
    return undefined;
  }
  return projectSyncSeparatorForUi(separator);
}

