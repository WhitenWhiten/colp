import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import type { Snapshot } from '../../src/types/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

async function fixture(name: string): Promise<Snapshot> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as Snapshot;
}

describe('snapshot semantics [evidence:publication.bookmark-url-safety] [evidence:feed.bookmark-url-safety]', () => {
  it.each(['collection-snapshot.json', 'protected-publication-snapshot.json', 'sync-snapshot.json'])(
    'accepts %s',
    async (name) => {
      expect(validateSnapshotSemantics(await fixture(name))).toEqual({ valid: true, issues: [] });
    },
  );

  it('rejects unsafe publication extensions', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    snapshot.collection.extensions = { 'https://private.example/ns': { secret: true } };
    const result = validateSnapshotSemantics(snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues[0]?.code).toBe('unsafe_publication_extension');
  });

  it('allows explicitly approved publication extensions', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    snapshot.collection.extensions = { 'https://public.example/ns': { label: 'safe' } };
    expect(
      validateSnapshotSemantics(snapshot, {
        publicSafeExtensions: new Set(['https://public.example/ns']),
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it('rejects local schemes from publication snapshots', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark')!;
    if (bookmark.kind !== 'bookmark' || bookmark.redacted === true) throw new Error('fixture bookmark missing');
    (bookmark as { url: string }).url = 'file:///C:/Docs/private.html';
    const result = validateSnapshotSemantics(snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unsafe_publication_scheme',
      path: '/nodes/1/url',
    }));
  });

  it.each([
    ['anonymous public', 'collection-snapshot.json', 'https://user:password@example.com/private'],
    ['authorized protected', 'protected-publication-snapshot.json', 'HTTP://user%3Apassword@example.com/private'],
  ])('rejects %s publication Bookmark userinfo', async (_producer, fixtureName, url) => {
    const snapshot = await fixture(fixtureName);
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark')!;
    if (bookmark.kind !== 'bookmark') throw new Error('fixture bookmark missing');
    const projected = bookmark as unknown as Record<string, unknown>;
    delete projected.redacted;
    delete projected.accessUrl;
    projected.url = url;
    const result = validateSnapshotSemantics(snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unsafe_publication_userinfo',
      path: '/nodes/1/url',
    }));
  });

  it.each([
    'HTTPS://example.com/Case-Sensitive',
    'https://example.com/users/user%40example.com?q=user%3Apassword',
  ])('accepts safe publication URL spelling without rewriting: %s', async (url) => {
    const snapshot = await fixture('collection-snapshot.json');
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark')!;
    if (bookmark.kind !== 'bookmark' || bookmark.redacted === true) throw new Error('fixture bookmark missing');
    (bookmark as { url: string }).url = url;
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
    expect(bookmark.url).toBe(url);
  });

  it('allows a redacted publication Bookmark without a target URL', async () => {
    const snapshot = await fixture('collection-snapshot.json');
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark')! as unknown as Record<string, unknown>;
    bookmark.redacted = true;
    delete bookmark.url;
    delete bookmark.canonicalUrl;
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('preserves authoritative and Sync Bookmark userinfo behavior', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    const bookmark = snapshot.nodes.find((node) => node.kind === 'bookmark')!;
    if (bookmark.kind !== 'bookmark' || bookmark.redacted === true) throw new Error('fixture bookmark missing');
    (bookmark as { url: string }).url = 'https://user:password@example.com/private';
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('rejects Feed Bookmark userinfo through the shared httpUrl Schema contract', () => {
    const validators = createValidatorRegistry();
    const result = validators.validate('feedNode', {
      id: 'feed-node',
      kind: 'bookmark',
      url: 'https://user%3Apassword@example.com/private',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ instancePath: '/url' }),
    ]));
    expect(validators.validate('feedNode', {
      id: 'redacted-feed-node',
      kind: 'bookmark',
      redacted: true,
    })).toEqual({ valid: true, errors: [] });
  });

  it('rejects sidecars that widen a private collection', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    snapshot.annotations.push({
      id: 'annotation-1',
      collectionId: snapshot.collection.id,
      subject: { type: 'node', id: snapshot.nodes[1]!.id },
      type: 'note',
      format: 'plain',
      value: 'Private parent, public annotation',
      visibility: 'public',
      createdAt: snapshot.generatedAt,
      updatedAt: snapshot.generatedAt,
      revision: 'r-1',
    });
    const result = validateSnapshotSemantics(snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.some((item) => item.code === 'visibility_widened')).toBe(true);
  });

  it('assembles ordered pages and rejects repeated IDs', async () => {
    const complete = await fixture('collection-snapshot.json');
    const first = structuredClone(complete);
    const second = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = complete.nodes.slice(1);
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };
    const assembled = assembleSnapshotPages([first, second]);
    expect(assembled.valid).toBe(true);
    if (assembled.valid) expect(assembled.snapshot.nodes).toHaveLength(complete.nodes.length);

    second.nodes.push(first.nodes[0]!);
    const duplicate = assembleSnapshotPages([first, second]);
    expect(duplicate.valid).toBe(false);
  });

  it('enforces cumulative member and object budgets before page flattening', async () => {
    const complete = await fixture('collection-snapshot.json');
    const first = structuredClone(complete);
    first.nodes = complete.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    const second = structuredClone(complete);
    second.nodes = complete.nodes.slice(1);
    second.annotations = [];
    second.page = { nextCursor: null, hasMore: false, sequence: 2 };

    const memberLimited = assembleSnapshotPages([first, second], { maxMembers: 1 });
    expect(memberLimited.valid).toBe(false);
    if (!memberLimited.valid) expect(memberLimited.issues[0]?.code).toBe('snapshot_assembly_member_budget');

    const objectLimited = assembleSnapshotPages([first, second], { maxObjects: 1 });
    expect(objectLimited.valid).toBe(false);
    if (!objectLimited.valid) expect(objectLimited.issues[0]?.code).toBe('snapshot_assembly_object_budget');
  });

  it('rejects empty, changed, and cropped page assemblies', async () => {
    expect(assembleSnapshotPages([]).valid).toBe(false);
    const first = await fixture('collection-snapshot.json');
    const second = structuredClone(first);
    first.nodes = first.nodes.slice(0, 1);
    first.annotations = [];
    first.page = { nextCursor: 'page-2', hasMore: true, sequence: 1 };
    second.nodes = second.nodes.slice(1);
    second.snapshotId = 'another-snapshot';
    second.complete = false;
    second.page = { nextCursor: null, hasMore: false, sequence: 3 };
    const result = assembleSnapshotPages([first, second]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((item) => item.code)).toEqual(
        expect.arrayContaining(['snapshot_page_context_changed', 'invalid_snapshot_page_sequence']),
      );
    }
  });

  it('detects root, identity, graph, position, and reference errors', async () => {
    const snapshot = await fixture('sync-snapshot.json');
    const root = snapshot.nodes[0]!;
    const bookmark = snapshot.nodes[1]!;
    snapshot.collection.rootNodeId = 'missing-root';
    const mutableBookmark = bookmark as { collectionId: string; parentId: string; id: string };
    mutableBookmark.collectionId = 'another-collection';
    mutableBookmark.parentId = mutableBookmark.id;
    const duplicate = structuredClone(bookmark);
    (duplicate as { id: string }).id = root.id;
    snapshot.nodes.push(duplicate);
    snapshot.tombstones.push({
      resourceType: 'node',
      targetId: bookmark.id,
      collectionId: 'another-collection',
      scope: 'single',
      deletedAt: snapshot.generatedAt,
      deleteRevision: 'r-delete',
      operationId: 'delete-operation',
      deleteCursor: 'cursor-delete',
      affectedCount: 1,
      purgeAfter: snapshot.generatedAt,
    });
    const result = validateSnapshotSemantics(snapshot);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((item) => item.code)).toEqual(
        expect.arrayContaining([
          'root_id_mismatch',
          'duplicate_live_id',
          'collection_id_mismatch',
          'live_tombstone_overlap',
          'parent_cycle',
        ]),
      );
    }
  });
});
