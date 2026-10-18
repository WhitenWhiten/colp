import { digestJson } from './bookmark-event-codec.js';
import { occupancyByNative, virtualNativeId } from './projection-native-occupancy.js';
import type { JsonObject, MappingInput, QueueOperation } from './sync-state-store.js';

export type OutstandingOperationType =
  | 'create_node' | 'update_node_content' | 'move_node' | 'delete_node' | 'delete_subtree' | 'restore_node';

export interface OutstandingTarget {
  readonly opId: string;
  readonly type: OutstandingOperationType;
  readonly colpIds: readonly string[];
  readonly provisionalColpId?: string;
  readonly parentColpId?: string;
}

export interface NativeFact {
  readonly nativeId: string;
  readonly title: string;
  readonly url?: string;
  readonly parentNativeId?: string;
  readonly index: number;
  readonly folder: boolean;
}

export interface RecoveryOverlayNode {
  readonly colpId: string;
  readonly parentColpId: string | null;
  readonly position: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly title: string;
  readonly url?: string;
  readonly mapping: MappingInput;
}

export type ProjectionIntentKind = 'create' | 'update' | 'move' | 'delete';

export interface ProjectionIntent {
  readonly intentId: string;
  readonly kind: ProjectionIntentKind;
  readonly colpId: string;
  readonly order: number;
  readonly suppression: string;
  readonly nativeId?: string;
  readonly parentColpId?: string;
  readonly parentNativeId?: string;
  readonly title?: string;
  readonly url?: string;
  readonly index?: number;
  readonly folder?: boolean;
}

export interface ProjectionIntentRecord extends ProjectionIntent {
  readonly generation: number;
  /** `recovery` is a durable, retryable stop (for example permission or a
   * temporarily unavailable native tree). `ambiguous` means we observed a
   * conflicting native fact and must not guess an id. */
  readonly state: 'pending' | 'executing' | 'terminal' | 'ambiguous' | 'recovery';
  readonly observedNativeId?: string;
}

export type ProjectionChangeFields = Readonly<Partial<Record<'title' | 'url', string>>>;

export interface RecoveryOverlayPlan {
  readonly targetMappings: readonly MappingInput[];
  readonly intents: readonly ProjectionIntent[];
  readonly protectedColpIds: readonly string[];
}

const ACTIVE = new Set(['pending', 'claimed', 'deferred', 'blocked', 'unknown', 'gap', 'set_aside']);

/** Typed outstanding-operation targets. Never falls back to a nested payload.targetId heuristic. */
export function extractOutstandingTarget(
  operation: Pick<QueueOperation, 'opId' | 'status' | 'payload'>,
): OutstandingTarget | null {
  if (!ACTIVE.has(operation.status)) return null;
  const type = operation.payload.type;
  if (type === 'create_node') {
    const parentColpId = nestedString(operation.payload, 'payload', 'parentId');
    return {
      opId: operation.opId, type, colpIds: [`pending-${operation.opId}`],
      provisionalColpId: `pending-${operation.opId}`,
      ...(parentColpId ? { parentColpId } : {}),
    };
  }
  if (type === 'update_node_content' || type === 'move_node'
      || type === 'delete_node' || type === 'delete_subtree' || type === 'restore_node') {
    const targetId = typeof operation.payload.targetId === 'string' ? operation.payload.targetId : '';
    return targetId ? { opId: operation.opId, type, colpIds: [targetId] } : null;
  }
  return null;
}

export function protectedColpIds(
  outstanding: readonly Pick<QueueOperation, 'opId' | 'status' | 'payload'>[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of outstanding) {
    const target = extractOutstandingTarget(item);
    if (target) for (const id of target.colpIds) ids.add(id);
  }
  return ids;
}

export function planRecoveryOverlay(input: {
  readonly snapshot: readonly RecoveryOverlayNode[];
  readonly mappings: readonly MappingInput[];
  readonly outstanding: readonly Pick<QueueOperation, 'opId' | 'status' | 'payload'>[];
  readonly nativeFacts: readonly NativeFact[];
  readonly selectedRootNativeId: string;
  readonly allowTitleUrlIdentityGuess?: boolean;
}): RecoveryOverlayPlan {
  const protectedIds = protectedColpIds(input.outstanding);
  const snapshotIds = new Set(input.snapshot.map((node) => node.colpId));
  const byColp = new Map(input.mappings.map((mapping) => [mapping.colpId, mapping]));
  const nativeById = new Map(input.nativeFacts.map((fact) => [fact.nativeId, fact]));
  const occupancy = occupancyByNative({ liveMappings: input.mappings });
  const assigned = new Set<string>();
  const targetMappings: MappingInput[] = [];
  const intents: ProjectionIntent[] = [];
  let order = 0;

  for (const mapping of input.mappings) {
    if (!protectedIds.has(mapping.colpId) || snapshotIds.has(mapping.colpId)) continue;
    // A pending create is local authority even when Chrome has already lost
    // the provisional native id. Keep the mapping, but replace the stale id
    // with a durable recovery placeholder and enqueue a create intent below.
    const target = input.outstanding.find((operation) => {
      const extracted = extractOutstandingTarget(operation);
      return extracted?.type === 'create_node' && extracted.colpIds.includes(mapping.colpId);
    });
    const nativePresent = !virtualNativeId(mapping.nativeId) && nativeById.has(mapping.nativeId);
    const targetMapping = nativePresent ? mapping : {
      ...mapping,
      nativeId: `recovery:${mapping.colpId}`,
      ...(mapping.parentNativeId && nativeById.has(mapping.parentNativeId) ? {} : { parentNativeId: undefined }),
    };
    targetMappings.push(targetMapping);
    if (nativePresent) assigned.add(mapping.nativeId);
    if (target && !nativePresent && mapping.nodeKind !== 'separator') {
      const content = mapping.projection.content ?? {};
      intents.push(intent('create', overlayNodeForMapping(targetMapping), ++order, {
        parentColpId: mapping.parentColpId,
        parentNativeId: mapping.parentNativeId && nativeById.has(mapping.parentNativeId)
          ? mapping.parentNativeId : undefined,
        title: typeof content.title === 'string' ? content.title : '',
        ...(typeof content.url === 'string' ? { url: content.url } : {}),
        index: 0, folder: mapping.nodeKind === 'folder',
      }));
    }
  }

  const pending = [...input.snapshot];
  const placed = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex((node) => !node.parentColpId || placed.has(node.parentColpId));
    if (index < 0) break;
    const [node] = pending.splice(index, 1) as [RecoveryOverlayNode];
    const parentMapping = node.parentColpId
      ? targetMappings.find((item) => item.colpId === node.parentColpId) : undefined;
    const prior = byColp.get(node.colpId);
    const reusable = prior && !virtualNativeId(prior.nativeId) && nativeById.has(prior.nativeId)
      && !assigned.has(prior.nativeId)
      && (occupancy.get(prior.nativeId) === undefined || occupancy.get(prior.nativeId) === node.colpId)
      ? prior.nativeId : undefined;
    const parentNativeId = parentMapping?.nativeId;
    const siblingIndex = input.snapshot.filter((item) => item.parentColpId === node.parentColpId
        && item.kind !== 'separator')
      .sort((left, right) => left.position < right.position ? -1 : 1)
      .findIndex((item) => item.colpId === node.colpId);
    let nativeId = reusable;
    if (!nativeId && input.allowTitleUrlIdentityGuess === true && parentNativeId
        && !virtualNativeId(parentNativeId)) {
      nativeId = uniqueUnoccupiedContentMatch(
        input.nativeFacts, node, parentNativeId, assigned, occupancy,
      );
    }
    if (!nativeId && !parentMapping) nativeId = input.selectedRootNativeId;
    if (!nativeId && node.kind === 'separator') nativeId = `sidecar:${node.colpId}`;

    const mapping: MappingInput = {
      ...node.mapping,
      nativeId: nativeId ?? `recovery:${node.colpId}`,
      rootNativeId: parentMapping?.rootNativeId ?? nativeId ?? input.selectedRootNativeId,
      ...(parentNativeId ? { parentNativeId } : {}),
      ...(node.parentColpId ? { parentColpId: node.parentColpId } : {}),
    };
    if (node.kind === 'separator') {
      targetMappings.push(mapping); placed.add(node.colpId);
      if (nativeId) assigned.add(nativeId);
      continue;
    }
    if (!nativeId) {
      intents.push(intent('create', node, ++order, {
        parentColpId: node.parentColpId ?? undefined, parentNativeId, title: node.title,
        ...(node.url ? { url: node.url } : {}), index: Math.max(0, siblingIndex), folder: node.kind === 'folder',
      }));
    } else {
      const fact = nativeById.get(nativeId);
      // The selected browser folder is a mount point for the canonical Root.
      // Snapshot recovery advances its mapping but must not replace the local
      // mount label (for example "Know-N") with the server Root title.
      if (fact && nativeId !== input.selectedRootNativeId
          && (fact.title !== node.title || (node.kind === 'bookmark' && fact.url !== node.url))) {
        intents.push(intent('update', node, ++order, {
          nativeId, title: node.title, ...(node.url ? { url: node.url } : {}),
        }));
      }
      if (fact && parentNativeId && (fact.parentNativeId !== parentNativeId || fact.index !== siblingIndex)) {
        intents.push(intent('move', node, ++order, {
          nativeId, parentColpId: node.parentColpId ?? undefined, parentNativeId, index: Math.max(0, siblingIndex),
        }));
      }
      assigned.add(nativeId);
    }
    targetMappings.push(mapping);
    placed.add(node.colpId);
  }

  const deletable = input.mappings.filter((mapping) => !snapshotIds.has(mapping.colpId)
    && !protectedIds.has(mapping.colpId) && mapping.nativeId !== input.selectedRootNativeId
    && !virtualNativeId(mapping.nativeId) && nativeById.has(mapping.nativeId));
  const deleteOrder = postOrderNative(deletable.map((mapping) => mapping.nativeId), nativeById);
  for (const nativeId of deleteOrder) {
    const mapping = deletable.find((item) => item.nativeId === nativeId);
    if (!mapping) continue;
    intents.push({
      intentId: `delete:${mapping.colpId}`, kind: 'delete', colpId: mapping.colpId, order: ++order,
      suppression: `recovery:delete:${mapping.colpId}`, nativeId, folder: nativeById.get(nativeId)?.folder === true,
    });
  }

  // Keep all creates parent-first, including local pending creates whose
  // parent is itself being rebuilt. Other mutations must wait until creates
  // have observed their native ids; deletes remain post-order.
  const depth = (colpId: string): number => {
    let value = 0; let current = byColp.get(colpId); const seen = new Set<string>();
    while (current?.parentColpId && !seen.has(current.parentColpId)) {
      seen.add(current.parentColpId); value += 1; current = byColp.get(current.parentColpId);
    }
    return value;
  };
  intents.sort((left, right) => {
    const rank = (kind: ProjectionIntentKind) => kind === 'create' ? 0 : kind === 'update' ? 1 : kind === 'move' ? 2 : 3;
    const byKind = rank(left.kind) - rank(right.kind);
    if (byKind) return byKind;
    if (left.kind === 'create' && right.kind === 'create') return depth(left.colpId) - depth(right.colpId);
    return left.order - right.order;
  });
  return { targetMappings, intents: intents.map((item, index) => ({ ...item, order: index + 1 })), protectedColpIds: [...protectedIds] };
}

export function overlayNodesFromMappings(staged: readonly MappingInput[]): RecoveryOverlayNode[] {
  return staged.map((mapping) => {
    const content = mapping.projection.content ?? {};
    return {
      colpId: mapping.colpId, parentColpId: mapping.parentColpId ?? null,
      position: typeof content.position === 'string' ? content.position : mapping.colpId,
      kind: mapping.nodeKind ?? 'folder',
      title: typeof content.title === 'string' ? content.title : '',
      ...(typeof content.url === 'string' ? { url: content.url } : {}),
      mapping,
    };
  });
}

export function projectionSuppresses(
  intents: readonly (Pick<ProjectionIntentRecord, 'state' | 'kind' | 'nativeId' | 'observedNativeId' | 'title' | 'url'
    | 'parentNativeId' | 'index'>
    & Partial<Pick<ProjectionIntentRecord, 'suppression'>>)[],
  event: { readonly kind: 'create' | 'change' | 'move' | 'remove'; readonly nativeId: string; readonly suppression?: string;
    readonly changes?: ProjectionChangeFields; readonly parentNativeId?: string; readonly index?: number },
): boolean {
  // Native id and event kind are not sufficient: a user can edit the same
  // bookmark while a projection is in flight. Listener callers must provide
  // the durable correlation token emitted by the projection intent.
  if (!event.suppression) return false;
  const chromeKind = event.kind === 'change' ? 'update' : event.kind === 'remove' ? 'delete' : event.kind;
  return intents.some((intent) => {
    if (intent.state === 'terminal' || intent.kind !== chromeKind
        || intent.suppression !== event.suppression
        || (intent.kind !== 'create' && intent.nativeId !== event.nativeId
          && intent.observedNativeId !== event.nativeId)) return false;
    if (intent.kind === 'move') {
      // A move token is only valid for the native destination it scheduled.
      // An unrelated user move during recovery must remain a local operation.
      return event.parentNativeId !== undefined && intent.parentNativeId === event.parentNativeId
        && (intent.index === undefined || intent.index === event.index);
    }
    if (intent.kind !== 'update') return true;
    const changes = event.changes;
    if (!changes || Object.keys(changes).length === 0) return false;
    return Object.entries(changes).every(([field, value]) =>
      (field === 'title' || field === 'url') && typeof value === 'string'
      && intent[field] === value);
  });
}

function uniqueUnoccupiedContentMatch(
  facts: readonly NativeFact[], node: RecoveryOverlayNode, parentNativeId: string,
  assigned: ReadonlySet<string>, occupancy: ReadonlyMap<string, string>,
): string | undefined {
  const matches = facts.filter((fact) => fact.parentNativeId === parentNativeId
    && !assigned.has(fact.nativeId) && !virtualNativeId(fact.nativeId)
    && (occupancy.get(fact.nativeId) === undefined || occupancy.get(fact.nativeId) === node.colpId)
    && fact.title === node.title
    && (node.kind !== 'bookmark' || fact.url === node.url)); // exact raw URL, same parent; never a normalizer
  return matches.length === 1 ? matches[0]?.nativeId : undefined;
}

function overlayNodeForMapping(mapping: MappingInput): RecoveryOverlayNode {
  const content = mapping.projection.content ?? {};
  return {
    colpId: mapping.colpId, parentColpId: mapping.parentColpId ?? null,
    position: typeof content.position === 'string' ? content.position : mapping.colpId,
    kind: mapping.nodeKind ?? 'folder', title: typeof content.title === 'string' ? content.title : '',
    ...(typeof content.url === 'string' ? { url: content.url } : {}), mapping,
  };
}

function intent(
  kind: ProjectionIntentKind, node: RecoveryOverlayNode, order: number, extra: Partial<ProjectionIntent>,
): ProjectionIntent {
  return {
    intentId: `${kind}:${node.colpId}`, kind, colpId: node.colpId, order,
    suppression: kind === 'create' && extra.parentNativeId && extra.title !== undefined
      ? createProjectionSuppression(extra.parentNativeId, extra.title, extra.url)
      : `recovery:${kind}:${node.colpId}`, ...extra,
  };
}

/** Stable listener correlation for a create callback whose native id is not
 * known until Chrome allocates it. */
export function createProjectionSuppression(parentNativeId: string, title: string, url?: string): string {
  return `recovery:create:v2:${digestJson([parentNativeId, title, url ?? null])}`;
}

function nestedString(payload: JsonObject, outer: string, inner: string): string | undefined {
  const nested = payload[outer];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
  const value = (nested as JsonObject)[inner];
  return typeof value === 'string' ? value : undefined;
}

function postOrderNative(
  nativeIds: readonly string[], facts: ReadonlyMap<string, NativeFact>,
): string[] {
  const wanted = new Set(nativeIds);
  const children = new Map<string, string[]>();
  for (const id of nativeIds) {
    const parent = facts.get(id)?.parentNativeId;
    if (!parent || !wanted.has(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    ordered.push(id);
  };
  for (const id of nativeIds) visit(id);
  return ordered;
}
