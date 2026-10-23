import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson } from '../sync-state/codec.js';
import type { LocalNodeFact, RemoteNodeFact } from './matcher.js';
import type {
  AdvancedChecklistItem, AdvancedDesiredLocalState, AdvancedDesiredRemoteState, AdvancedLocalState,
  AdvancedNodeValue, AdvancedParentRef, AdvancedRemoteState, AdvancedStep,
  AdvancedStepBase,
} from './advanced-plan-types.js';

export function localState(row: LocalNodeFact): AdvancedLocalState {
  return { nativeId: row.nativeId, mountNativeRootId: row.mountNativeRootId, parentNativeId: row.parentNativeId,
    kind: row.kind, title: row.title, ...(row.url ? { url: row.url } : {}), ...localIndex(row) };
}

export function remoteState(row: RemoteNodeFact): AdvancedRemoteState {
  return { nodeId: row.nodeId, parentId: row.parentId, kind: row.kind, title: row.title,
    ...(row.url ? { url: row.url } : {}), revision: row.revision,
    ...(row.position !== undefined ? { position: row.position } : {}),
    ...(row.childrenRevision !== undefined ? { childrenRevision: row.childrenRevision } : {}),
    ...(row.folderRole ? { folderRole: row.folderRole } : {}) };
}

export function nodeValue(row: LocalNodeFact | RemoteNodeFact): AdvancedNodeValue {
  return { kind: row.kind, title: row.title, ...(row.url ? { url: row.url } : {}),
    ...('folderRole' in row && row.folderRole ? { folderRole: row.folderRole } : {}) };
}

export function desiredRemote(nodeId: string | null, parent: AdvancedParentRef,
  node: AdvancedNodeValue): AdvancedDesiredRemoteState { return { nodeId, parent, node }; }

export function desiredLocal(nativeId: string | null, parent: AdvancedParentRef,
  node: AdvancedNodeValue, index?: number): AdvancedDesiredLocalState {
  return { nativeId, parent, node, ...(index === undefined ? {} : { index }) };
}

export function changedContent(remote: RemoteNodeFact, local: LocalNodeFact): {
  readonly base: Readonly<Record<string, string>>; readonly value: Readonly<Record<string, string>>;
} {
  const base: Record<string, string> = {}; const value: Record<string, string> = {};
  if (remote.title !== local.title) { base.title = remote.title; value.title = local.title; }
  if ((remote.url ?? '') !== (local.url ?? '')) {
    if (!remote.url || !local.url) throw new Error('advanced_unsupported_node');
    base.url = remote.url; value.url = local.url;
  }
  return { base, value };
}

export function baseStep<
  Side extends AdvancedStepBase['side'], Action extends AdvancedStepBase['action'], Operation extends string,
>(stepId: string, side: Side, action: Action, operation: Operation,
  dependsOn: readonly string[]): AdvancedStepBase & { readonly side: Side; readonly action: Action; readonly operation: Operation } {
  return { stepId, order: 0, dependsOn: [...dependsOn], side, action, operation };
}

export function parentRefId(ref: AdvancedParentRef): string | null { return ref.kind === 'step' ? null : ref.id; }

export function sortLocalParentFirst(rows: readonly LocalNodeFact[], byId: ReadonlyMap<string, LocalNodeFact>): LocalNodeFact[] {
  const ordinal = new Map(rows.map((row, index) => [row.nativeId, index]));
  return [...rows].sort((left, right) => depthLocal(left, byId) - depthLocal(right, byId)
    || compareOptionalNumber(left, right) || Number(left.kind === 'bookmark') - Number(right.kind === 'bookmark')
    || (ordinal.get(left.nativeId)! - ordinal.get(right.nativeId)!));
}
export function sortRemoteParentFirst(rows: readonly RemoteNodeFact[], byId: ReadonlyMap<string, RemoteNodeFact>): RemoteNodeFact[] {
  const ordinal = new Map(rows.map((row, index) => [row.nodeId, index]));
  return [...rows].sort((left, right) => depthRemote(left, byId) - depthRemote(right, byId)
    || comparePosition(left.position, right.position) || Number(left.kind === 'bookmark') - Number(right.kind === 'bookmark')
    || (ordinal.get(left.nodeId)! - ordinal.get(right.nodeId)!));
}
export function sortLocalChildFirst(rows: readonly LocalNodeFact[], byId: ReadonlyMap<string, LocalNodeFact>): LocalNodeFact[] {
  return sortLocalParentFirst(rows, byId).reverse();
}
export function sortRemoteChildFirst(rows: readonly RemoteNodeFact[], byId: ReadonlyMap<string, RemoteNodeFact>): RemoteNodeFact[] {
  return sortRemoteParentFirst(rows, byId).reverse();
}

/**
 * Return the part of a confirmed remote sibling list that can be represented
 * by Chrome. Separators remain in the snapshot for safety checks, but there is
 * no local materialisation operation for them.
 */
export function materializedRemoteChildren(rows: readonly RemoteNodeFact[], parentId: string): RemoteNodeFact[] {
  return rows.filter((row) => row.parentId === parentId && row.kind !== 'separator')
    .map((row, ordinal) => ({ row, ordinal }))
    .sort((left, right) => comparePosition(left.row.position, right.row.position)
      || left.ordinal - right.ordinal)
    .map(({ row }) => row);
}

/** The zero-based materialisable sibling rank in the confirmed remote tree. */
export function remoteMaterializedIndex(row: RemoteNodeFact, rows: readonly RemoteNodeFact[]): number {
  if (!row.parentId) return 0;
  const index = materializedRemoteChildren(rows, row.parentId).findIndex((candidate) => candidate.nodeId === row.nodeId);
  if (index < 0) throw new Error('advanced_parent_missing');
  return index;
}

/** Local children excluding protected separators, in their observed order. */
export function materializedLocalChildren(rows: readonly LocalNodeFact[], parentNativeId: string): LocalNodeFact[] {
  return rows.filter((row) => row.parentNativeId === parentNativeId && row.kind !== 'separator')
    .map((row, ordinal) => ({ row, ordinal }))
    .sort((left, right) => compareOptionalNumber(left.row, right.row) || left.ordinal - right.ordinal)
    .map(({ row }) => row);
}

export function selectedLocalIds(rows: readonly LocalNodeFact[], byId: ReadonlyMap<string, LocalNodeFact>,
  mounts: ReadonlyMap<string, unknown>): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const row of rows) {
    if (!mounts.has(row.mountNativeRootId)) continue;
    let current: LocalNodeFact | undefined = row; const seen = new Set<string>();
    while (current) {
      selected.add(row.nativeId);
      if (current.nativeId === row.mountNativeRootId) break;
      if (!current.parentNativeId || seen.has(current.nativeId)) break;
      seen.add(current.nativeId); current = byId.get(current.parentNativeId);
    }
  }
  return selected;
}

export function selectedRemoteIds(rows: readonly RemoteNodeFact[], byId: ReadonlyMap<string, RemoteNodeFact>,
  mounts: readonly { readonly remoteNodeId?: string }[]): ReadonlySet<string> {
  const roots = new Set(mounts.flatMap((mount) => mount.remoteNodeId ? [mount.remoteNodeId] : []));
  const selected = new Set<string>();
  for (const row of rows) {
    let current: RemoteNodeFact | undefined = row; const seen = new Set<string>();
    while (current) {
      if (roots.has(current.nodeId)) { selected.add(row.nodeId); break; }
      if (current.parentId === null || seen.has(current.nodeId)) break;
      seen.add(current.nodeId); current = byId.get(current.parentId);
    }
  }
  for (const root of roots) selected.add(root);
  return selected;
}

export function orderSteps(steps: readonly AdvancedStep[], fail: (code: string,
  details?: Readonly<Record<string, string>>) => never): readonly AdvancedStep[] {
  const byId = new Map<string, AdvancedStep>();
  for (const step of steps) {
    if (byId.has(step.stepId)) fail('advanced_duplicate_id', { field: 'stepId', id: step.stepId });
    byId.set(step.stepId, step);
  }
  const insertion = new Map(steps.map((step, index) => [step.stepId, index]));
  for (const step of steps) for (const dependency of step.dependsOn) if (!byId.has(dependency)) {
    fail('advanced_input_invalid', { field: 'dependency', id: dependency });
  }
  const result: AdvancedStep[] = []; const emitted = new Set<string>(); const active = new Set<string>();
  const visit = (step: AdvancedStep) => {
    if (emitted.has(step.stepId)) return;
    if (active.has(step.stepId)) fail('advanced_parent_cycle', { id: step.stepId });
    active.add(step.stepId); for (const dependency of step.dependsOn) visit(byId.get(dependency)!);
    active.delete(step.stepId); emitted.add(step.stepId); result.push(step);
  };
  for (const step of [...steps].sort((left, right) => insertion.get(left.stepId)! - insertion.get(right.stepId)!)) visit(step);
  return result.map((step, index) => ({ ...step, order: index + 1, dependsOn: [...step.dependsOn] }));
}

function depthLocal(row: LocalNodeFact, byId: ReadonlyMap<string, LocalNodeFact>): number {
  let current: LocalNodeFact | undefined = row; let depth = 0; const seen = new Set<string>();
  while (current?.parentNativeId && current.parentNativeId !== current.mountNativeRootId) {
    if (seen.has(current.nativeId)) throw new Error('advanced_parent_cycle');
    seen.add(current.nativeId); depth += 1; current = byId.get(current.parentNativeId);
  }
  return depth;
}
function depthRemote(row: RemoteNodeFact, byId: ReadonlyMap<string, RemoteNodeFact>): number {
  let current: RemoteNodeFact | undefined = row; let depth = 0; const seen = new Set<string>();
  while (current?.parentId) {
    if (seen.has(current.nodeId)) throw new Error('advanced_parent_cycle');
    seen.add(current.nodeId); depth += 1; current = byId.get(current.parentId);
  }
  return depth;
}

function localIndex(row: LocalNodeFact): { readonly index?: number } {
  const value = (row as LocalNodeFact & { readonly index?: unknown }).index;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { index: value } : {};
}
function compareOptionalNumber(left: LocalNodeFact, right: LocalNodeFact): number {
  const leftIndex = localIndex(left).index; const rightIndex = localIndex(right).index;
  if (leftIndex === undefined || rightIndex === undefined) return 0;
  return leftIndex - rightIndex;
}
function comparePosition(left: string | null | undefined, right: string | null | undefined): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return 1;
  if (right === undefined || right === null) return -1;
  return left < right ? -1 : 1;
}

export function checklistForStep(step: AdvancedStep): AdvancedChecklistItem {
  const before = step.before;
  const targetId = step.side === 'remote'
    ? ('target' in step ? step.target.nodeId : step.source.nativeId)
    : ('target' in step ? step.target.nativeId : step.source.nodeId);
  const state = before ?? ('after' in step && step.after ? step.after : null);
  const node = state && 'node' in state ? state.node : state;
  const title = node && 'title' in node ? node.title : '';
  const kind = node && 'kind' in node ? node.kind : 'folder';
  const parentId = before && 'parentId' in before ? before.parentId
    : before && 'parentNativeId' in before ? before.parentNativeId : null;
  return { itemId: `check:${step.stepId}`, stepId: step.stepId, order: step.order,
    side: step.side, action: step.action, targetId, title, kind, parentId };
}

export function localDigestFacts(rows: readonly LocalNodeFact[]): readonly AdvancedLocalState[] {
  return [...rows].map(localState).sort((left, right) => left.nativeId.localeCompare(right.nativeId));
}
export function authoritativeId(value: string | null | undefined): value is string {
  return nonEmpty(value) && !value.startsWith('mount:') && !value.startsWith('pending-');
}
export function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
export function stableId(confirmationId: string, action: string, target: string): string {
  return `advanced.${bytesToHex(sha256(new TextEncoder().encode(canonicalJson([confirmationId, action, target]))))}`;
}
export function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}
