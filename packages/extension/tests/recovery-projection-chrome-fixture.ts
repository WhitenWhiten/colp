import type { PullBookmarkApi } from '../src/pull-applier.js';
import { CHROME_BOOKMARK_NOT_FOUND } from '../src/bookmark-api-error.js';

export function fakeChrome(seed: readonly { id: string; parentId?: string; index?: number; title: string; url?: string }[]) {
  const nodes = new Map(seed.map((node) => [node.id, { ...node }]));
  let nextId = seed.reduce((max, node) => Math.max(max, Number(node.id) || 0), 0) + 1;
  const crashOn = { create: 0, update: 0, move: 0, remove: 0 };
  let creates = 0;
  const api: PullBookmarkApi = {
    async create(input) {
      if (crashOn.create > 0) { crashOn.create -= 1; throw new Error('chrome_crash'); }
      creates += 1;
      const id = String(nextId); nextId += 1;
      nodes.set(id, { id, parentId: input.parentId, index: input.index ?? 0, title: input.title ?? '', url: input.url });
      return { id };
    },
    async update(id, changes) {
      if (crashOn.update > 0) { crashOn.update -= 1; throw new Error('chrome_crash'); }
      const current = nodes.get(id); if (!current) throw new Error('missing');
      nodes.set(id, { ...current, ...changes });
      return current;
    },
    async move(id, destination) {
      if (crashOn.move > 0) { crashOn.move -= 1; throw new Error('chrome_crash'); }
      const current = nodes.get(id); if (!current) throw new Error('missing');
      nodes.set(id, { ...current, parentId: destination.parentId ?? current.parentId, index: destination.index ?? 0 });
      return current;
    },
    async remove(id) {
      if (crashOn.remove > 0) { crashOn.remove -= 1; throw new Error('chrome_crash'); }
      if ([...nodes.values()].some(node => node.parentId === id)) throw new Error("Can't remove non-empty folder.");
      if (!nodes.delete(id)) throw new Error('missing');
    },
    async removeTree(id) {
      for (const child of [...nodes.values()].filter(node => node.parentId === id)) await api.removeTree(child.id);
      await api.remove(id);
    },
    async get(id) { const node = nodes.get(id); if (!node) throw new Error(CHROME_BOOKMARK_NOT_FOUND); return [node]; },
    async getChildren(id) {
      return [...nodes.values()].filter((node) => node.parentId === id)
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    },
  };
  return { api, nodes, crashOn, get creates() { return creates; } };
}
