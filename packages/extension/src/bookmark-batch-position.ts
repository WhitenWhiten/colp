import { itemPreDigest, type BatchChromeNode } from './bookmark-batch-plan.js';
import type { BatchItemRecord, BatchKind } from './sync-state/batch-repository.js';

interface Position { parentId: string; index: number }

/** Replay only durable batch effects, so external renames, moves and reorders still fail the precondition. */
function project(items: readonly BatchItemRecord[], kind: BatchKind, undo: boolean) {
  const positions = new Map(items.map(item => [item.nativeId, { parentId: item.parentNativeId, index: item.index }]));
  const sources = new Map<string, Position>();
  const firstTarget = items.find(item => item.targetParentNativeId && item.targetIndex !== undefined);
  const target = firstTarget ? { parentId: firstTarget.targetParentNativeId!, index: firstTarget.targetIndex! } : undefined;
  const remove = (id: string) => {
    const current = positions.get(id);
    if (!current) return;
    positions.delete(id);
    for (const value of [...positions.values(), ...(target ? [target] : [])]) {
      if (value.parentId === current.parentId && value.index > current.index) value.index--;
    }
  };
  const insert = (id: string, position: Position) => {
    for (const value of [...positions.values(), ...(target ? [target] : [])]) {
      if (value.parentId === position.parentId && value.index >= position.index) value.index++;
    }
    positions.set(id, { ...position });
  };
  for (const item of items) {
    if (!item.postDigest) continue;
    const source = positions.get(item.nativeId);
    if (!source) continue;
    sources.set(item.nativeId, { ...source });
    if (kind === 'rename') continue;
    remove(item.nativeId);
    if (kind === 'move') insert(item.nativeId, {
      parentId: item.targetParentNativeId!, index: item.postIndex ?? item.targetIndex!,
    });
  }
  if (undo && kind !== 'rename') for (const item of [...items].reverse()) {
    if (item.state !== 'undone') continue;
    const source = sources.get(item.nativeId);
    if (!source) continue;
    if (kind === 'move') remove(item.nativeId);
    insert(item.nativeId, source);
  }
  return { positions, sources, target };
}

export function matchesBatchInput(node: BatchChromeNode, item: BatchItemRecord, items: readonly BatchItemRecord[], kind: BatchKind) {
  const position = project(items, kind, false).positions.get(item.nativeId);
  return position !== undefined && (node.index ?? 0) === position.index && node.parentId === position.parentId
    && itemPreDigest({ ...node, index: item.index }) === item.preDigest;
}

export function batchTargetIndex(items: readonly BatchItemRecord[]) {
  return project(items, 'move', false).target?.index;
}

export function batchUndoPosition(item: BatchItemRecord, items: readonly BatchItemRecord[], kind: BatchKind) {
  return project(items, kind, true).sources.get(item.nativeId) ?? { parentId: item.parentNativeId, index: item.index };
}

export function matchesBatchOutput(node: BatchChromeNode, item: BatchItemRecord, items: readonly BatchItemRecord[], kind: BatchKind) {
  const position = project(items, kind, true).positions.get(item.nativeId);
  return position !== undefined && node.parentId === position.parentId && (node.index ?? 0) === position.index
    && (!item.postDigest || itemPreDigest({ ...node, index: item.postIndex ?? (kind === 'move' ? item.targetIndex : item.index) }) === item.postDigest);
}
