import { NodeConflictError } from './errors.js';

export interface PlacementSibling {
  readonly id: string;
  readonly positionToken: string;
}

export interface ResolvedPlacement {
  readonly beforeToken: string | null;
  readonly afterToken: string | null;
  readonly insertIndex: number;
}

/**
 * Resolve sibling position bounds for create/move allocation.
 *
 * `beforeToken` is the exclusive lower bound (-∞ when null).
 * `afterToken` is the exclusive upper bound (+∞ when null).
 */
export function resolvePlacement(
  siblings: readonly PlacementSibling[],
  afterId?: string,
  beforeId?: string,
): ResolvedPlacement {
  const byId = new Map(siblings.map((sibling, index) => [sibling.id, { sibling, index }] as const));

  if (afterId !== undefined && !byId.has(afterId)) {
    throw new NodeConflictError('position_context_stale', 'afterId is not a live target sibling');
  }
  if (beforeId !== undefined && !byId.has(beforeId)) {
    throw new NodeConflictError('position_context_stale', 'beforeId is not a live target sibling');
  }

  if (afterId !== undefined && beforeId !== undefined) {
    const after = byId.get(afterId)!;
    const before = byId.get(beforeId)!;
    if (before.index !== after.index + 1) {
      throw new NodeConflictError(
        'position_context_stale',
        'afterId and beforeId must be adjacent target siblings',
      );
    }
    return {
      beforeToken: after.sibling.positionToken,
      afterToken: before.sibling.positionToken,
      insertIndex: before.index,
    };
  }

  if (afterId !== undefined) {
    const after = byId.get(afterId)!;
    const next = siblings[after.index + 1];
    return {
      beforeToken: after.sibling.positionToken,
      afterToken: next?.positionToken ?? null,
      insertIndex: after.index + 1,
    };
  }

  if (beforeId !== undefined) {
    const before = byId.get(beforeId)!;
    const previous = siblings[before.index - 1];
    return {
      beforeToken: previous?.positionToken ?? null,
      afterToken: before.sibling.positionToken,
      insertIndex: before.index,
    };
  }

  const last = siblings[siblings.length - 1];
  return {
    beforeToken: last?.positionToken ?? null,
    afterToken: null,
    insertIndex: siblings.length,
  };
}
