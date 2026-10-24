import type { MappingInput, SyncScope } from './sync-state-store.js';
import type { ProjectionIntentRecord } from './recovery-overlay.js';

export function virtualNativeId(nativeId: string): boolean {
  return nativeId.startsWith('recovery:') || nativeId.startsWith('sidecar:')
    || nativeId.startsWith('unmounted:') || nativeId.startsWith('pending-');
}

export function occupancyByNative(input: {
  readonly liveMappings?: readonly MappingInput[];
  readonly seedMappings?: readonly MappingInput[];
  readonly intents?: readonly Pick<ProjectionIntentRecord, 'colpId' | 'observedNativeId'>[];
}): ReadonlyMap<string, string> {
  const occupied = new Map<string, string>();
  const claim = (nativeId: string | undefined, colpId: string) => {
    if (!nativeId || virtualNativeId(nativeId)) return;
    if (!occupied.has(nativeId)) occupied.set(nativeId, colpId);
  };
  for (const mapping of input.liveMappings ?? []) claim(mapping.nativeId, mapping.colpId);
  for (const mapping of input.seedMappings ?? []) claim(mapping.nativeId, mapping.colpId);
  for (const intent of input.intents ?? []) claim(intent.observedNativeId, intent.colpId);
  return occupied;
}

/** The map of every claim at this moment: live mappings, the plan's own, projection intents. One read of each. */
export async function projectionOccupancy(
  store: { listMappings(scope: SyncScope): Promise<readonly MappingInput[]>;
    listProjectionIntents(scope: SyncScope): Promise<readonly Pick<ProjectionIntentRecord, 'colpId' | 'observedNativeId'>[]> },
  scope: SyncScope, seedMappings: Iterable<MappingInput>,
): Promise<ReadonlyMap<string, string>> {
  return occupancyByNative({ liveMappings: await store.listMappings(scope), seedMappings: [...seedMappings],
    intents: await store.listProjectionIntents(scope) });
}

export type CreateIdentityResolution =
  | { readonly action: 'reuse'; readonly nativeId: string }
  | { readonly action: 'create' }
  | { readonly action: 'ambiguous' };

/** Replay this intent only. Another Node with equal title/URL is not a match. */
export function resolveCreateIdentity(input: {
  readonly intent: Pick<ProjectionIntentRecord, 'colpId' | 'observedNativeId' | 'title' | 'url'> & { readonly state?: ProjectionIntentRecord['state'] };
  readonly children: readonly { readonly id: string; readonly title?: string; readonly url?: string }[];
  readonly occupancy: ReadonlyMap<string, string>;
}): CreateIdentityResolution {
  if (input.intent.observedNativeId && !virtualNativeId(input.intent.observedNativeId)) {
    return input.children.some((child) => child.id === input.intent.observedNativeId)
      && unoccupiedOrSelf(input.occupancy, input.intent.observedNativeId, input.intent.colpId)
      ? { action: 'reuse', nativeId: input.intent.observedNativeId } : { action: 'ambiguous' };
  }
  const matches = input.children.filter((candidate) => contentMatches(candidate, input.intent)
    && unoccupiedOrSelf(input.occupancy, candidate.id, input.intent.colpId));
  if (matches.length > 0 && input.intent.state && input.intent.state !== 'pending') return { action: 'ambiguous' };
  return { action: 'create' };
}

/**
 * B-16: whether `resolveCreateIdentity` can consult the claims at all. It does for an intent that already observed a
 * browser id and for an equal-content child; with neither the answer is `create` whatever the map holds, so the library
 * need not be read for it.
 */
export function createIdentityNeedsOccupancy(
  intent: Pick<ProjectionIntentRecord, 'observedNativeId' | 'title' | 'url'>,
  children: readonly { readonly title?: string; readonly url?: string }[],
): boolean {
  return Boolean(intent.observedNativeId && !virtualNativeId(intent.observedNativeId))
    || children.some((child) => contentMatches(child, intent));
}

function contentMatches(
  candidate: { readonly title?: string; readonly url?: string },
  intent: Pick<ProjectionIntentRecord, 'title' | 'url'>,
): boolean {
  return candidate.title === (intent.title ?? '')
    && (intent.url ? candidate.url === intent.url : candidate.url === undefined);
}

function unoccupiedOrSelf(occupancy: ReadonlyMap<string, string>, nativeId: string, colpId: string): boolean {
  const owner = occupancy.get(nativeId);
  return owner === undefined || owner === colpId;
}
