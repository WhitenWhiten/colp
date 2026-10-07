import { createHash } from 'node:crypto';

import { SNAPSHOT_MATERIALIZATION_SORT_VERSION } from '../collections/index.js';
export { SNAPSHOT_MATERIALIZATION_SORT_VERSION, SNAPSHOT_MATERIALIZATION_EXTENSION, snapshotMaterializationExtensionValue } from '../collections/index.js';

export interface SnapshotSortKey {
  readonly id: string;
  readonly parentId: string | null;
  readonly isRoot: boolean;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly positionToken: string | null;
}

export type ParentFirstOrder<T> =
  | { readonly ok: true; readonly ordered: readonly T[] }
  | { readonly ok: false; readonly code: 'invalid_graph' };

/** Byte-wise UTF-8 order matches PostgreSQL COLLATE "C". */
export function compareCollateC(left: string, right: string): number {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  const n = Math.min(a.length, b.length);
  for (let index = 0; index < n; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

/**
 * Root first, then a bounded preorder walk. Siblings use real position then id.
 * Independent of opaque id dictionary order; does not ORDER BY parent_id.
 */
export function orderSnapshotNodesParentFirst<T>(
  nodes: readonly T[],
  of: (node: T) => SnapshotSortKey,
): ParentFirstOrder<T> {
  if (nodes.length === 0) return { ok: false, code: 'invalid_graph' };
  const byId = new Map<string, T>();
  const keys = new Map<string, SnapshotSortKey>();
  for (const node of nodes) {
    const key = of(node);
    if (byId.has(key.id)) return { ok: false, code: 'invalid_graph' };
    byId.set(key.id, node);
    keys.set(key.id, key);
  }
  const roots = [...keys.values()].filter((key) => key.isRoot);
  if (roots.length !== 1 || roots[0]!.parentId !== null || roots[0]!.kind !== 'folder') {
    return { ok: false, code: 'invalid_graph' };
  }
  const rootId = roots[0]!.id;
  const children = new Map<string, string[]>();
  for (const key of keys.values()) {
    if (key.isRoot) continue;
    if (key.parentId === null || !keys.has(key.parentId)) return { ok: false, code: 'invalid_graph' };
    const parent = keys.get(key.parentId)!;
    if (parent.kind !== 'folder' && !parent.isRoot) return { ok: false, code: 'invalid_graph' };
    const siblings = children.get(key.parentId);
    if (siblings) siblings.push(key.id); else children.set(key.parentId, [key.id]);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => {
      const a = keys.get(left)!;
      const b = keys.get(right)!;
      const byPosition = compareCollateC(a.positionToken ?? '', b.positionToken ?? '');
      return byPosition !== 0 ? byPosition : compareCollateC(a.id, b.id);
    });
  }
  const ordered: T[] = [];
  const visiting = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visiting.has(current)) return { ok: false, code: 'invalid_graph' };
    visiting.add(current);
    ordered.push(byId.get(current)!);
    const kids = children.get(current) ?? [];
    for (let index = kids.length - 1; index >= 0; index -= 1) pending.push(kids[index]!);
  }
  if (ordered.length !== nodes.length) return { ok: false, code: 'invalid_graph' };
  return { ok: true, ordered };
}

export function snapshotMaterializationIdentityFacts(input: {
  readonly protocolVersion: '0.1' | '0.2';
  readonly sessionId: string;
  readonly replicaId: string;
  readonly leaseGeneration: string | number;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly rootNodeId: string;
}): readonly unknown[] {
  const facts = [input.sessionId, input.replicaId, String(input.leaseGeneration),
    input.contentRevision, input.policyRevision, input.rootNodeId];
  return input.protocolVersion === '0.2'
    ? ['sync-snapshot-v02', SNAPSHOT_MATERIALIZATION_SORT_VERSION, ...facts]
    : [SNAPSHOT_MATERIALIZATION_SORT_VERSION, ...facts];
}

export function snapshotMaterializationIdentity(input: Parameters<typeof snapshotMaterializationIdentityFacts>[0]): string {
  return createHash('sha256').update(JSON.stringify(snapshotMaterializationIdentityFacts(input)))
    .digest('base64url').slice(0, 32);
}


