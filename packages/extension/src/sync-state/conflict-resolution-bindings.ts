import type { UnknownRecord } from './types.js';

/** Local operations superseded by an authoritative conflict decision. */
export function conflictResolutionBindings(event: UnknownRecord): Array<{ opId: string; conflictId?: string }> {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const document = payload as UnknownRecord; const bindings: Array<{ opId: string; conflictId?: string }> = [];
  if (document.kind === 'conflict') {
    const conflict = document.conflict;
    if (conflict && typeof conflict === 'object' && !Array.isArray(conflict)) {
      const value = conflict as UnknownRecord;
      if (value.status === 'resolved' && typeof value.id === 'string' && typeof value.incomingOpId === 'string') {
        bindings.push({ opId: value.incomingOpId, conflictId: value.id });
      }
    }
  } else if (document.kind === 'operation') {
    const operation = document.operation;
    if (operation && typeof operation === 'object' && !Array.isArray(operation)) {
      const value = operation as UnknownRecord; const source = value.source;
      const adapterProfile = source && typeof source === 'object' && !Array.isArray(source)
        ? (source as UnknownRecord).adapterProfile : undefined;
      if (adapterProfile === 'known-conflict-resolution' && Array.isArray(value.dependencies)) {
        for (const dependency of value.dependencies) if (typeof dependency === 'string') bindings.push({ opId: dependency });
      }
    }
  }
  return bindings;
}
