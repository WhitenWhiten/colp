import type { RepresentationKey, NativeBinding } from './contracts.js';
import type { ManagedReference } from './managed-client.js';
import type { SourceMount } from './layout.js';
import { managedLibraryKey } from './copy-identity.js';
import { destinationScopeId } from './destination-scope.js';
import { rows } from './source-db.js';

type ScopedCopy = RepresentationKey & { shared?: ManagedReference; native?: NativeBinding };
/** Resolve legacy placement records without treating another library as an existing copy. */
export async function copiesInScope<T>(tx: IDBTransaction, values: readonly T[], scopeId: string | undefined, copy: (value: T) => ScopedCopy): Promise<T[]> {
  if (!scopeId) return [...values];
  const mounts = new Map<string, SourceMount[]>(), result: T[] = [];
  for (const value of values) {
    const r = copy(value);
    let scope = r.scopeId ?? (r.shared ? managedLibraryKey(r.shared.library) : undefined);
    if (!scope && r.purpose === 'sourceArchive') {
      let source = mounts.get(r.connectionId);
      if (!source) { source = await rows<SourceMount>(tx, 'mounts', r.connectionId); mounts.set(r.connectionId, source); }
      const mount = source.find(m => m.id === r.mountId);
      if (mount) scope = destinationScopeId(mount.destination, mount.root.deviceId);
      else if (r.native) scope = destinationScopeId(null, r.native.deviceId);
      else throw new Error('sourceDestinationNeedsReview');
    }
    if (scope === scopeId) result.push(value);
  }
  return result;
}
