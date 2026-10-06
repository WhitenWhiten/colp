import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validatePublicationSnapshotReplacementSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = 'semantic.snapshot.assembly';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'collection-snapshot.json',
);

async function completePublication(): Promise<Snapshot> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Snapshot;
}

function issueCodes(snapshot: Snapshot): readonly string[] {
  const result = validatePublicationSnapshotReplacementSemantics(snapshot);
  expect(result.valid).toBe(false);
  return result.issues.map((issue) => issue.code);
}

describe(`PUB-0005 publication replacement semantics [evidence:${evidence}]`, () => {
  it(`accepts a complete terminal publication Snapshot [evidence:${evidence}]`, async () => {
    expect(validatePublicationSnapshotReplacementSemantics(await completePublication())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it.each([
    ['complete=false', (snapshot: Snapshot) => { snapshot.complete = false; }, 'incomplete_publication_replacement'],
    ['sync mode', (snapshot: Snapshot) => { snapshot.mode = 'sync'; }, 'invalid_publication_replacement_mode'],
    ['hasMore=true', (snapshot: Snapshot) => { snapshot.page.hasMore = true; }, 'unnormalized_publication_replacement_page'],
    ['a continuation cursor', (snapshot: Snapshot) => { snapshot.page.nextCursor = 'page-2'; }, 'unnormalized_publication_replacement_page'],
    ['sequence=2', (snapshot: Snapshot) => { snapshot.page.sequence = 2; }, 'unnormalized_publication_replacement_page'],
  ] as const)(
    `rejects %s before publication state replacement [evidence:${evidence}]`,
    async (_label, mutate, code) => {
      const snapshot = await completePublication();
      mutate(snapshot);
      expect(issueCodes(snapshot)).toContain(code);
    },
  );

  it.each([
    ['a duplicate live ID', (snapshot: Snapshot) => {
      snapshot.nodes.push({ ...snapshot.nodes[1]!, id: snapshot.nodes[0]!.id });
    }, 'duplicate_live_id'],
    ['a missing root', (snapshot: Snapshot) => {
      snapshot.collection.rootNodeId = 'missing-root';
    }, 'root_id_mismatch'],
    ['a missing Parent', (snapshot: Snapshot) => {
      const bookmark = snapshot.nodes[1] as unknown as { parentId: string };
      bookmark.parentId = 'missing-parent';
    }, 'missing_parent'],
    ['a Parent cycle', (snapshot: Snapshot) => {
      const bookmark = snapshot.nodes[1] as unknown as { id: string; parentId: string };
      bookmark.parentId = bookmark.id;
    }, 'parent_cycle'],
    ['a missing Annotation subject', (snapshot: Snapshot) => {
      snapshot.annotations[0]!.subject = { type: 'node', id: 'missing-subject' };
    }, 'missing_subject'],
    ['a widened sidecar visibility', (snapshot: Snapshot) => {
      const bookmark = snapshot.nodes[1] as Snapshot['nodes'][number] & { visibility?: 'private' };
      bookmark.visibility = 'private';
      snapshot.annotations[0]!.visibility = 'public';
    }, 'visibility_widened'],
    ['a foreign live resource', (snapshot: Snapshot) => {
      snapshot.annotations[0]!.collectionId = 'another-collection';
    }, 'collection_id_mismatch'],
  ] as const)(
    `rejects complete terminal publication state containing %s [evidence:${evidence}]`,
    async (_label, mutate, code) => {
      const snapshot = await completePublication();
      mutate(snapshot);
      expect(issueCodes(snapshot)).toContain(code);
    },
  );
});
