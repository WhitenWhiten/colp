export interface ParentAncestryRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly isRoot: boolean;
  readonly kind: string;
  readonly collectionId: string;
  readonly deletedAt: Date | null;
}

export type ParentAncestryResult = { readonly ok: true } | { readonly ok: false; readonly code: 'target' | 'cycle' | 'invalid' | 'depth' };

export function classifyParentAncestry(
  rows: readonly ParentAncestryRow[], collectionId: string, nodeId: string, parentId: string, checkAncestry: boolean,
): ParentAncestryResult {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) return { ok: false, code: 'cycle' };
    seen.add(row.id);
  }
  for (const row of rows) {
    if (row.id === nodeId) return { ok: false, code: 'target' };
    if (row.collectionId !== collectionId || row.deletedAt !== null || row.kind !== 'folder') return { ok: false, code: 'invalid' };
  }
  const first = rows.find((row) => row.id === parentId);
  if (!first) return { ok: false, code: 'invalid' };
  if (!checkAncestry) return { ok: true };
  const last = rows.reduce((a, b) => (b.depth > a.depth ? b : a), first);
  return last.isRoot || last.parentId === null ? { ok: true } : { ok: false, code: 'depth' };
}
