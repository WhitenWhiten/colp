import type { JsonObject, MappingInput } from './sync-state-store.js';

export type FirstRunPhase = 'none' | 'deferred' | 'running' | 'completed';

export interface NodeIdentity {
  readonly nativeId: string;
  readonly colpId: string;
  readonly rootNativeId: string;
  readonly revision: string;
  readonly childrenRevision?: string;
  readonly content: JsonObject | null;
  readonly nodeKind?: MappingInput['nodeKind'];
  readonly parentNativeId?: string;
}

export type ObservedNativeClass =
  | { readonly kind: 'mapped'; readonly identity: NodeIdentity }
  | { readonly kind: 'pending_create'; readonly identity: NodeIdentity; readonly eventId: string }
  | { readonly kind: 'receipt_unbound'; readonly identity: NodeIdentity }
  | { readonly kind: 'bootstrap_owned'; readonly opId?: string }
  | { readonly kind: 'new_local' }
  | { readonly kind: 'needs_attention'; readonly reason: 'generation_mismatch' | 'identity_ambiguous' };

export type DeletionScopeClass =
  | { readonly kind: 'out_of_scope'; readonly reason: 'unselected' | 'private_local' | 'managed' | 'detached' }
  | { readonly kind: 'in_scope' }
  | { readonly kind: 'unknown' };

export function authoritativeColpId(id: string | undefined | null): id is string {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('pending-') && !id.startsWith('mount:')
    && !id.startsWith('local-') && !id.startsWith('recovery:') && !id.startsWith('unmounted:');
}

export function identityFromMapping(mapping: MappingInput): NodeIdentity {
  return {
    nativeId: mapping.nativeId, colpId: mapping.colpId, rootNativeId: mapping.rootNativeId,
    revision: mapping.projection.revision, content: mapping.projection.content ?? null,
    ...(mapping.projection.childrenRevision ? { childrenRevision: mapping.projection.childrenRevision } : {}),
    ...(mapping.nodeKind ? { nodeKind: mapping.nodeKind } : {}),
    ...(mapping.parentNativeId ? { parentNativeId: mapping.parentNativeId } : {}),
  };
}

/** Classify one observed native. Title/URL equality is never an identity proof. */
export function classifyObservedNative(input: {
  readonly generation: number;
  readonly observedGeneration?: number;
  readonly firstRun?: FirstRunPhase;
  readonly mapping?: NodeIdentity | null;
  readonly pendingCreate?: { readonly eventId: string; readonly identity: NodeIdentity } | null;
  readonly receiptIdentity?: NodeIdentity | null;
  readonly bootstrapCreateOpId?: string | null;
  readonly underSelectedMount: boolean;
}): ObservedNativeClass {
  if (input.observedGeneration !== undefined && input.observedGeneration !== input.generation) {
    return { kind: 'needs_attention', reason: 'generation_mismatch' };
  }
  if (input.mapping && authoritativeColpId(input.mapping.colpId)) {
    return { kind: 'mapped', identity: input.mapping };
  }
  if (input.pendingCreate) {
    return {
      kind: 'pending_create', identity: input.pendingCreate.identity, eventId: input.pendingCreate.eventId,
    };
  }
  if (input.receiptIdentity && authoritativeColpId(input.receiptIdentity.colpId)) {
    return { kind: 'receipt_unbound', identity: input.receiptIdentity };
  }
  if (input.bootstrapCreateOpId || input.firstRun === 'running') {
    return { kind: 'bootstrap_owned', ...(input.bootstrapCreateOpId ? { opId: input.bootstrapCreateOpId } : {}) };
  }
  if (input.underSelectedMount) return { kind: 'new_local' };
  return { kind: 'needs_attention', reason: 'identity_ambiguous' };
}

/**
 * Boundary for a removal. Walk ancestors from the callback parent (still present),
 * never `get(deletedId)`. Unknown must fail closed.
 */
export function classifyDeletionScope(input: {
  readonly managed: boolean;
  readonly ancestorWalkFailed: boolean;
  readonly selectedAncestor: boolean;
  readonly privateAncestor: boolean;
  readonly detachedMount: boolean;
  readonly hasInScopeMapping: boolean;
}): DeletionScopeClass {
  if (input.managed) return { kind: 'out_of_scope', reason: 'managed' };
  if (input.privateAncestor) return { kind: 'out_of_scope', reason: 'private_local' };
  if (input.detachedMount && !input.hasInScopeMapping) return { kind: 'out_of_scope', reason: 'detached' };
  if (input.selectedAncestor || input.hasInScopeMapping) return { kind: 'in_scope' };
  if (input.ancestorWalkFailed && !input.hasInScopeMapping) return { kind: 'unknown' };
  return { kind: 'out_of_scope', reason: 'unselected' };
}
