import { nativeFixture } from './bookmark-subscriptions-fixture.js';

// Match Chromium insertion coordinates, bounds, and sibling reindexing. Opt in
// for placement regressions without changing unrelated legacy test fixtures.
export function positionedNativeFixture() {
  const fixture = nativeFixture();
  const raw = { ...fixture.api };
  const children = (id: string) => [...fixture.nodes.values()].filter(n => n.parentId === id).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const reindex = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => nodes.forEach((node, index) => { node.index = index; });
  const position = (index: number | undefined, length: number) => {
    const value = index ?? length;
    if (!Number.isInteger(value) || value < 0 || value > length) throw new Error('Index out of bounds.');
    return value;
  };
  fixture.api.create = async input => {
    const siblings = children(input.parentId!);
    const index = position(input.index, siblings.length);
    const created = await raw.create({ ...input, index });
    siblings.splice(index, 0, fixture.nodes.get(created.id)!); reindex(siblings);
    return { ...fixture.nodes.get(created.id)! };
  };
  fixture.api.move = async (id, input) => {
    const [current] = await raw.get(id);
    const parentId = input.parentId ?? current!.parentId!;
    await raw.get(parentId);
    const siblings = children(parentId);
    const requested = position(input.index, siblings.length);
    const index = requested - (parentId === current!.parentId && current!.index! < requested ? 1 : 0);
    const destination = siblings.filter(n => n.id !== id);
    await raw.move(id, { parentId, index });
    reindex(children(current!.parentId!).filter(n => n.id !== id));
    destination.splice(index, 0, fixture.nodes.get(id)!); reindex(destination);
    return { ...fixture.nodes.get(id)! };
  };
  fixture.api.remove = async id => {
    const [current] = await raw.get(id);
    await raw.remove(id); reindex(children(current!.parentId!));
  };
  return fixture;
}
