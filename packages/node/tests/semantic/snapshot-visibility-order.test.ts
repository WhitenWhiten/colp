import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import { createSnapshotVisibilityResolver } from '../../src/semantic/snapshot-visibility.js';
import type { SemanticIssue } from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';

const fixturePath = resolve(import.meta.dirname, '../../fixtures/protocol/examples/collection-snapshot.json');

function deepSnapshot(): Snapshot {
  const snapshot = JSON.parse(readFileSync(fixturePath, 'utf8')) as Snapshot;
  const root = snapshot.nodes.find(node => node.kind === 'root')!;
  const folders: StrictNode[] = [];
  let parentId = root.id;
  for (let index = 0; index < 10_001; index += 1) {
    const node: StrictNode = {
      id: `visibility-folder-${index}`, collectionId: snapshot.collection.id,
      kind: 'folder', parentId, position: 'A0', title: `Folder ${index}`,
      createdAt: snapshot.generatedAt, updatedAt: snapshot.generatedAt,
      revision: snapshot.revision, extensions: {},
      ...(index === 0 ? { visibility: 'private' as const } : {}),
    };
    folders.push(node);
    parentId = node.id;
  }
  snapshot.nodes = [root, ...folders];
  snapshot.annotations[0]!.subject = { type: 'node', id: parentId };
  return snapshot;
}

describe('Snapshot visibility is independent of node order', () => {
  it.each([64, 128])('resolves cyclic failure in linear work for %s nodes', count => {
    const snapshot = JSON.parse(readFileSync(fixturePath, 'utf8')) as Snapshot;
    const root = snapshot.nodes.find(node => node.kind === 'root')!;
    const cycle = Array.from({ length: count }, (_, index): StrictNode => ({
      id: `cycle-${index}`, collectionId: snapshot.collection.id, kind: 'folder',
      parentId: `cycle-${(index + 1) % count}`, position: 'A0', title: 'Cycle',
      createdAt: snapshot.generatedAt, updatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
    }));
    const entry = { ...cycle[0]!, id: 'cycle-entry', parentId: cycle[0]!.id } as StrictNode;
    const localNodes = new Map([root, ...cycle, entry].map(node => [node.id, node]));
    let lookups = 0;
    const resolveVisibility = createSnapshotVisibilityResolver({
      localNodes, collectionRank: 0, maxExternalNodes: 10_000,
      lookup: id => { lookups += 1; return localNodes.get(id); },
      report: () => { throw new Error('Local cycles are owned by graph validation'); },
    });
    for (const node of cycle) expect(resolveVisibility(node, '/nodes')).toBe(2);
    expect(resolveVisibility(entry, '/entry')).toBe(2);
    expect(resolveVisibility(entry, '/entry')).toBe(2);
    expect(resolveVisibility(root, '/root')).toBe(0);
    expect(lookups).toBeLessThanOrEqual(count + 1);
  });

  it.each(['parent-first', 'leaf-first', 'permuted'] as const)(
    'rejects public sidecars below a private ancestor beyond 10,000 levels: %s', order => {
      const snapshot = deepSnapshot();
      if (order === 'leaf-first') snapshot.nodes.reverse();
      if (order === 'permuted') {
        // A deterministic permutation, not a fixed seed for property discovery.
        snapshot.nodes = [...snapshot.nodes.filter((_, i) => i % 2),
          ...snapshot.nodes.filter((_, i) => i % 2 === 0).reverse()];
      }
      expect(createValidatorRegistry().validate('snapshot', snapshot).valid).toBe(true);
      const result = validateSnapshotSemantics(snapshot);
      expect(result.valid).toBe(false);
      expect(result.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: 'visibility_widened', path: '/annotations/0/visibility' },
      ]);
    },
  );

  it('does not cache a truncated external path reached from a local node', () => {
    const snapshot = deepSnapshot();
    const start = snapshot.nodes[1]! as StrictNode;
    const outside = { ...start, id: 'external-1', parentId: 'external-2' } as StrictNode;
    const outside2 = { ...outside, id: 'external-2', parentId: 'external-3' } as StrictNode;
    const local = { ...start, parentId: outside.id } as StrictNode;
    const reports: SemanticIssue[] = [];
    const external = new Map([[outside.id, outside], [outside2.id, outside2]]);
    const resolveVisibility = createSnapshotVisibilityResolver({
      localNodes: new Map([[local.id, local]]), collectionRank: 0, maxExternalNodes: 1,
      lookup: id => external.get(id), report: issue => { reports.push(issue); },
    });
    expect(resolveVisibility(local, '/nodes/0/parentId')).toBe(2);
    expect(resolveVisibility(local, '/nodes/0/parentId')).toBe(2);
    expect(reports.map(issue => issue.code)).toEqual([
      'reference_resolution_limit', 'reference_resolution_limit',
    ]);
  });
});
