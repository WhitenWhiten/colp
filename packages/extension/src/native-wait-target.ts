import { lookupBookmark } from './bookmark-api-error.js';
import { chromeCreate } from './pull-projection.js';
import type { PullNode } from './pull-applier-types.js';
import type { ConfirmNativeWaitInput } from './native-wait.js';
import type { IntentRecord, MountBindingRecord } from './sync-state-store.js';

/** A free-form id is a candidate, never proof of a native landing. */
export async function validNativeWaitTarget(input: ConfirmNativeWaitInput, intent: IntentRecord,
  mounts: readonly MountBindingRecord[]): Promise<boolean> {
  if (!input.api || !input.nativeId || !intent.nativeParentId) return false;
  const found = await lookupBookmark((id) => input.api!.get(id), input.nativeId);
  if (found.class !== 'present') return false;
  const node = found.nodes[0];
  if (!node || node.id !== input.nativeId || node.parentId !== intent.nativeParentId || node.unmodifiable) return false;
  if ((await input.store.listLocalSyncExclusions(input.scope)).some(row => row.nativeId === node.id)) return false;
  const parent = await input.store.getMappingByNativeId(input.scope, intent.nativeParentId);
  if (!parent || (mounts.length > 0 && !mounts.some(mount => mount.status === 'active'
    && mount.nativeRootId === parent.rootNativeId))) return false;
  const scope = await input.store.getScope(input.scope);
  const privateRoots = new Set(scope?.privateRoots ?? []);
  const mappings = new Map((await input.store.listMappings(input.scope)).map(row => [row.nativeId, row]));
  const seen = new Set<string>(); let ancestor: typeof parent | undefined = parent;
  while (ancestor) {
    if (seen.has(ancestor.nativeId) || privateRoots.has(ancestor.colpId)) return false;
    seen.add(ancestor.nativeId);
    ancestor = ancestor.parentNativeId ? mappings.get(ancestor.parentNativeId) : undefined;
  }
  if (!intent.eventId) return false;
  const event = await input.store.getPullEvent(input.scope, intent.eventId);
  const remote = (event?.payload as { effect?: { node?: PullNode } } | undefined)?.effect?.node;
  if (!remote) return false;
  try {
    const expected = chromeCreate(remote);
    return node.title === expected.title && node.url === ('url' in expected ? expected.url : undefined);
  } catch { return false; }
}
