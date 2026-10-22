import type { JsonObject, JsonValue, MappingInput, QueueOperation } from './sync-state-store.js';

export const MOVE_AUTHORITY_REFRESH_ATTEMPTS = 8;
export interface MoveAuthorityNode {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly revision: string;
  readonly childrenRevision?: string;
}

export function needsMoveAuthorityRefresh(row: QueueOperation): boolean {
  return row.payload.type === 'move_node' && !row.attempt
    && row.retry.attempt >= MOVE_AUTHORITY_REFRESH_ATTEMPTS
    && (row.recovery?.code === 'revision_conflict' || row.recovery?.code === 'position_context_stale');
}

/** Use a complete authenticated read as fences, without projecting it or advancing the Pull cursor. */
export function snapshotMoveFences(nodes: readonly MoveAuthorityNode[], targetId: string,
  placement: JsonObject): { readonly baseRevision: string; readonly placement: JsonObject } | undefined {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const target = byId.get(targetId);
  const source = target?.parentId ? byId.get(target.parentId) : undefined;
  const dest = typeof placement.newParentId === 'string' ? byId.get(placement.newParentId) : undefined;
  if (!target || !source?.childrenRevision || !dest?.childrenRevision) return undefined;
  const next: Record<string, JsonValue> = { ...placement, baseSourceParentRevision: source.childrenRevision,
    baseTargetParentRevision: dest.childrenRevision };
  for (const anchor of ['afterId', 'beforeId']) {
    const id = next[anchor];
    if (typeof id === 'string' && (id === targetId || byId.get(id)?.parentId !== dest.nodeId)) delete next[anchor];
  }
  return { baseRevision: target.revision, placement: next };
}

/** A local move owns native placement, but must not retain obsolete server revision fences. */
export function recoverMoveAuthority(prior: MappingInput, staged: MappingInput): MappingInput {
  return { ...prior, parentColpId: staged.parentColpId,
    projection: { ...prior.projection, revision: staged.projection.revision,
      resourceRevision: staged.projection.resourceRevision ?? staged.projection.revision,
      childrenRevision: staged.projection.childrenRevision } };
}

export function rebaseableRecoveryMoves(rows: readonly QueueOperation[]): ReadonlySet<string> {
  const candidates = new Set<string>(); const protectedIds = new Set<string>();
  for (const row of rows) {
    if (row.status === 'terminal' || row.status === 'rejected') continue;
    const id = row.payload.targetId;
    if (typeof id !== 'string') continue;
    if (row.payload.type === 'move_node' && !row.attempt) candidates.add(id);
    else protectedIds.add(id);
  }
  for (const id of protectedIds) candidates.delete(id);
  return candidates;
}
