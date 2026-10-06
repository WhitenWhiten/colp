import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot, StrictNode } from '../../src/types/index.js';

it('returns 150,000 extension diagnostics without argument-list overflow or truncation', () => {
  const snapshot = JSON.parse(readFileSync(resolve(import.meta.dirname,
    '../../fixtures/protocol/examples/collection-snapshot.json'), 'utf8')) as Snapshot;
  const root = snapshot.nodes.find(node => node.kind === 'root')!;
  snapshot.annotations = [];
  snapshot.attachments = [];
  snapshot.relations = [];
  snapshot.nodes = [root];
  for (let index = 0; index < 75_000; index += 1) {
    const node: StrictNode = {
      id: `diagnostic-${index}`, collectionId: snapshot.collection.id,
      kind: 'folder', parentId: root.id, position: index.toString(36), title: 'Folder',
      createdAt: snapshot.generatedAt, updatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
      extensions: { 'invalid-namespace-a': {}, 'invalid-namespace-b': {} },
    };
    snapshot.nodes.push(node);
  }
  const result = validateSnapshotSemantics(snapshot);
  expect(result.valid).toBe(false);
  expect(result.issues).toHaveLength(150_000);
  expect(result.issues.every(issue => issue.code === 'invalid_extension_namespace')).toBe(true);
  expect(result.issues[0]!.path).toBe('/nodes/1/extensions/invalid-namespace-a');
  expect(result.issues.at(-1)!.path).toBe('/nodes/75000/extensions/invalid-namespace-b');
}, 30_000);
