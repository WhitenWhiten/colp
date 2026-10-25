import type { Representation, SiteItem } from './contracts.js';
import type { ReconcileDifference, ReconcileNode, ReconcileSnapshot } from './reconcile-model.js';
import { sourceKey } from './source-db.js';
const same = (a: ReconcileNode, b: Representation) => a.native.nativeId === b.native.nativeId && a.native.dateAdded === b.native.dateAdded && a.native.deviceId === b.native.deviceId;
/** No writes, URL guesses, order changes or AI work. Every choice is derived from a frozen inventory. */
export function reconcileDifferences(input: { snapshot: ReconcileSnapshot; representations: readonly Representation[]; nodes: readonly ReconcileNode[];
  candidates(item: SiteItem, node: ReconcileNode): boolean; collectionParentId: string; negative?(itemId: string): boolean }): ReconcileDifference[] {
  const { snapshot, nodes } = input, differences: ReconcileDifference[] = [], claimed = new Set<string>();
  const source = new Map(snapshot.items.map(item => [item.id, item]));
  const add = (itemId: string | null, kind: ReconcileDifference['kind'], title: string, rest: Partial<ReconcileDifference> = {}) => {
    differences.push({ id: sourceKey(snapshot.collectionId, itemId, kind, rest.native?.nativeId ?? null), collectionId: snapshot.collectionId,
      itemId, kind, title, choices: ['keep'], ...rest });
  };
  for (const r of input.representations) {
    const item = source.get(r.itemId), node = nodes.find(n => same(n, r)); if (node) claimed.add(node.native.nativeId);
    const data = { representation: r, ...(node ? { native: node.native, expected: node } : {}), ...(item ? { source: item } : {}) };
    if (!item) {
      const absent = snapshot.absence === 'proven' || input.negative?.(r.itemId);
      add(r.itemId, absent ? 'sourceRemoved' : 'unverified', node?.title ?? r.lastWritten?.title ?? r.itemId,
        { ...data, choices: absent && node && !node.protected && !node.pinned && r.state === 'active' ? ['keep', 'archive'] : ['keep'], reason: absent ? undefined : snapshot.reason ?? 'sourceAbsenceUnverified' });
    } else if (!node || r.state === 'suppressed') add(r.itemId, 'localDeleted', item.title, { ...data, choices: ['keep', 'restore'] });
    else if (node.parentId !== input.collectionParentId || r.state === 'detached') add(r.itemId, 'moved', node.title, {
      ...data, choices: node.protected ? ['keep'] : ['keep', 'return'], reason: node.parentId === input.collectionParentId ? 'sourceAssociationNeedsReview' : 'sourceCopyMoved' });
    else if (item.title !== r.lastWritten?.title && node.title === r.lastWritten?.title) add(r.itemId, 'title', item.title, { ...data, choices: ['keep', 'updateTitle'] });
    else add(r.itemId, 'present', node.title, data);
    source.delete(r.itemId);
  }
  for (const item of source.values()) {
    const candidates = nodes.filter(n => !claimed.has(n.native.nativeId) && !n.protected && n.native.kind === 'bookmark' && input.candidates(item, n));
    for (const n of candidates) claimed.add(n.native.nativeId);
    add(item.id, candidates.length ? 'candidate' : 'add', item.title, { source: item, candidates, choices: candidates.length ? ['keep', 'adopt'] : ['keep'] });
  }
  for (const node of nodes) if (node.parentId === input.collectionParentId && !claimed.has(node.native.nativeId)) add(null, node.protected ? 'protected' : 'personal', node.title,
    { native: node.native, expected: node, choices: node.protected ? ['keep'] : ['keep', 'move'] });
  return differences;
}
