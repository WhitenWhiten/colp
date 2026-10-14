import type { BindingReadPort, BindingStore } from '../domain/bindings.js';
import type { AutomationPorts } from './ports.js';

function once<T>(values: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let value = values.get(key);
  if (!value) { value = read(); values.set(key, value); }
  return value;
}

/** One read-only inspection pass, while its caller holds the Owner/collection locks.
 * Never retain this across mutations or transactions. Role constraints are still
 * evaluated separately for each rule; worker readiness/expiry is not cached.
 */
export function inspectionBindingReads(reads: BindingReadPort): BindingReadPort {
  const collections = new Map<string, ReturnType<BindingReadPort['readCollection']>>();
  const folders = new Map<string, ReturnType<BindingReadPort['readFolder']>>();
  return {
    readCollection: (actor, id) => once(collections, JSON.stringify([actor.accountId, actor.subjectId, id]), () => reads.readCollection(actor, id)),
    readFolder: (actor, folder) => once(folders, JSON.stringify([actor.accountId, actor.subjectId, folder.serverUuid, folder.collectionId, folder.nodeId]), () => reads.readFolder(actor, folder)),
  };
}

export function inspectionReads(ports: AutomationPorts): AutomationPorts {
  const bindings = new Map<string, ReturnType<BindingStore['load']>>();
  return { ...ports, reads: inspectionBindingReads(ports.reads), bindings: { ...ports.bindings,
    load: (ownerId, id) => once(bindings, JSON.stringify([ownerId, id]), () => ports.bindings.load(ownerId, id)),
  } };
}
