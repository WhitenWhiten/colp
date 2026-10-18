import { SyncFailureError } from './sync-failure-class.js';
import type { BookmarkLookup } from './bookmark-api-error.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Scope-level private roots also protect descendants whose stored root is an active mount. */
export async function withinPrivateNativeBoundary(input: {
  readonly store: Pick<ReturnType<typeof createSyncStateStore>, 'getMappingByColpId'>;
  readonly scope: SyncScope; readonly mapping: MappingInput; readonly privateRoots: readonly string[];
  readonly lookup: (id: string) => Promise<BookmarkLookup>;
}): Promise<boolean> {
  if (input.privateRoots.length === 0) return false;
  if (input.privateRoots.includes(input.mapping.colpId)) return true;
  const privateMappings = await Promise.all(input.privateRoots.map(id => input.store.getMappingByColpId(input.scope, id)));
  if (privateMappings.some(mapping => mapping === null)) throw new SyncFailureError('private_root_mapping_missing');
  const nativeRoots = new Set(privateMappings.map(mapping => mapping!.nativeId));
  if (nativeRoots.has(input.mapping.rootNativeId)) return true;
  let nativeId: string | undefined = input.mapping.nativeId;
  const seen = new Set<string>();
  while (nativeId !== undefined) {
    if (nativeRoots.has(nativeId)) return true;
    if (seen.has(nativeId) || seen.size >= 256) throw new SyncFailureError('private_ancestry_unproven');
    seen.add(nativeId);
    const observed = await input.lookup(nativeId);
    if (observed.class === 'not_found') throw new SyncFailureError('private_ancestry_unproven');
    if (observed.class !== 'present') throw new Error(observed.message);
    nativeId = observed.nodes[0]?.parentId;
  }
  return false;
}
