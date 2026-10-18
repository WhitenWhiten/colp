import type { JsonObject, JsonValue, MappingInput } from './sync-state-store.js';

type Bindings = ReadonlyMap<string, string>;
export function rebindIdentity<T>(value: T, bindings: Bindings): T {
  return (typeof value === 'string' ? bindings.get(value) ?? value : value) as T;
}
function fields(record: JsonObject, keys: readonly string[], bindings: Bindings): JsonObject {
  return { ...record, ...Object.fromEntries(keys.filter(key => record[key] !== undefined)
    .map(key => [key, rebindIdentity(record[key]!, bindings)])) };
}
function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
/** Wire identities have schema-defined paths. Content/extension strings are never tokens. */
export function rebindOperationIdentity(operation: JsonObject, bindings: Bindings): JsonObject {
  const result = fields(operation, ['targetId', 'baseRevision'], bindings);
  const payload = object(operation.payload); let bound = payload;
  switch (operation.type) {
    case 'create_node':
      if (payload) bound = fields(payload, ['parentId', 'afterId', 'beforeId'], bindings);
      break;
    case 'move_node':
      if (payload) bound = fields(payload, ['newParentId', 'afterId', 'beforeId', 'baseSourceParentRevision', 'baseTargetParentRevision'], bindings);
      break;
    case 'restore_node':
      if (payload) bound = fields(payload, ['newParentId', 'afterId', 'beforeId'], bindings);
      break;
    case 'reorder_children':
      if (payload) bound = { ...fields(payload, ['parentId', 'baseChildrenRevision'], bindings),
        ...(Array.isArray(payload.childIds) ? { childIds: payload.childIds.map(id => rebindIdentity(id, bindings)) } : {}) };
      break;
  }
  return { ...result,
    ...(Array.isArray(operation.dependencies) ? { dependencies: operation.dependencies.map(id => rebindIdentity(id, bindings)) } : {}),
    ...(bound ? { payload: bound } : {}) };
}
/** Native ids and projection content/digests retain their original meaning. */
export function rebindMappingIdentity(mapping: MappingInput, bindings: Bindings): MappingInput {
  return { ...mapping, colpId: rebindIdentity(mapping.colpId, bindings),
    ...(mapping.parentColpId === undefined ? {} : { parentColpId: rebindIdentity(mapping.parentColpId, bindings) }),
    projection: { ...mapping.projection, revision: rebindIdentity(mapping.projection.revision, bindings),
      ...(mapping.projection.resourceRevision === undefined ? {} : { resourceRevision: rebindIdentity(mapping.projection.resourceRevision, bindings) }),
      ...(mapping.projection.childrenRevision === undefined ? {} : { childrenRevision: rebindIdentity(mapping.projection.childrenRevision, bindings) }) } };
}
