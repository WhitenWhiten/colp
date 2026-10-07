import type { SnapshotSemanticContext } from '@know-n/colp/semantic';
import { BOOKMARK_PIN_EXTENSION } from '../../collections/index.js';

/** The pin namespace, for publication adapters that read it from stored payloads. */
export const PUBLICATION_PIN_EXTENSION = BOOKMARK_PIN_EXTENSION;

/** The owner's pins are public layout, like Position, and the only node extension audited for publication. */
export const PUBLIC_NODE_EXTENSIONS: readonly string[] = Object.freeze([BOOKMARK_PIN_EXTENSION]);

/** Producer-side semantic checks shared by fresh pages and the Redis hit path. */
export const PUBLICATION_PRODUCER_SEMANTICS: SnapshotSemanticContext = Object.freeze({
  publicationExtensionMode: 'producer',
  publicSafeExtensions: new Set(PUBLIC_NODE_EXTENSIONS),
  referenceResolution: { mode: 'deferred' as const },
});

export function publicBookmarkExtensions(pinned: boolean | undefined) {
  return pinned === true ? { extensions: { [BOOKMARK_PIN_EXTENSION]: { pinned: true } } } : {};
}
