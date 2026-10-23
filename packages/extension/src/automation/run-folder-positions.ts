/** Counts belong to one run. Browser edits invalidate them; observed owned moves update them. */
type Position = { readonly id: string; readonly parentId?: string; readonly index?: number };
type Move = { parentId: string; index: number; oldParentId: string; oldIndex: number };
export function createRunFolderPositions(api = chrome.bookmarks) {
  const counts = new Map<string, number>(), versions = new Map<string, number>();
  const expected = new Map<string, Move>(), unsubscribe: Array<() => void> = [];
  const observable = [api.onCreated, api.onRemoved, api.onMoved, api.onChildrenReordered]
    .every(event => event && typeof event.addListener === 'function' && typeof event.removeListener === 'function');
  const version = (id: string) => versions.get(id) ?? 0;
  const invalidate = (id: string | undefined) => {
    if (!id) return;
    counts.delete(id); versions.set(id, version(id) + 1);
  };
  function listen<Args extends unknown[]>(event: {
    addListener(listener: (...args: Args) => void): void;
    removeListener(listener: (...args: Args) => void): void;
  }, listener: (...args: Args) => void) {
    event.addListener(listener); unsubscribe.push(() => event.removeListener(listener));
  }
  if (observable) {
    listen(api.onCreated, (_id, node) => invalidate(node.parentId));
    listen(api.onRemoved, (id, info) => { expected.delete(id); invalidate(id); invalidate(info.parentId); });
    listen(api.onChildrenReordered, id => invalidate(id));
    listen(api.onMoved, (id, move) => {
      const own = expected.get(id); expected.delete(id);
      if (own && own.parentId === move.parentId && own.index === move.index
          && own.oldParentId === move.oldParentId && own.oldIndex === move.oldIndex) return;
      invalidate(move.oldParentId); invalidate(move.parentId);
    });
  }
  return {
    async count(parentId: string): Promise<number> {
      const cached = observable ? counts.get(parentId) : undefined;
      if (cached !== undefined) return cached;
      const before = version(parentId), size = (await api.getChildren(parentId)).length;
      if (observable && before === version(parentId)) counts.set(parentId, size);
      return size;
    },
    /** Register before the native call; settle only from its subsequent observed location. */
    expectMove(node: Position, destination: { parentId: string; index: number }) {
      const source = node.parentId, fromIndex = node.index;
      const fromVersion = source ? version(source) : 0, toVersion = version(destination.parentId);
      if (source && fromIndex !== undefined) expected.set(node.id, {
        ...destination, oldParentId: source, oldIndex: fromIndex,
      });
      return (observed: Position | null) => {
        if (!source || fromIndex === undefined) { invalidate(source); invalidate(destination.parentId); return; }
        if (observed?.parentId === destination.parentId && observed.index === destination.index) {
          if (source !== destination.parentId) {
            if (fromVersion === version(source) && counts.has(source)) counts.set(source, counts.get(source)! - 1);
            if (toVersion === version(destination.parentId) && counts.has(destination.parentId)) counts.set(destination.parentId, counts.get(destination.parentId)! + 1);
          }
        } else {
          expected.delete(node.id);
          if (observed?.parentId !== source || observed.index !== fromIndex) {
            invalidate(source); invalidate(destination.parentId);
          }
        }
      };
    },
    dispose() { for (const remove of unsubscribe) remove(); counts.clear(); expected.clear(); },
  };
}
