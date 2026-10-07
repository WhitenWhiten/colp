import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  compareCollectionPayloadToRelational,
  compareNodePayloadToRelational,
  compareResourcePayload,
  materializeCollectionPayload,
  materializeNodePayload,
  validateResourcePayload,
} from '../../../src/modules/collections/domain/resource-payload.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  dualReadCollectionPayload,
  dualReadNodePayload,
} from '../../../src/infrastructure/collections/resource-payload-dual-read.js';
import { canonicalJson } from '../../../src/modules/commands/index.js';

const createdAt = new Date('2026-07-01T09:00:00.000Z');
const updatedAt = new Date('2026-07-16T06:30:00.123Z');

function baseCollection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'collection-1',
    ownerSubjectId: 'owner-1',
    title: 'Bookmarks',
    summary: null as string | null,
    kind: 'bookmarks',
    visibility: 'private',
    allowSearchIndexing: false,
    rootNodeId: 'root-1',
    resourceRevision: 'r1',
    contentRevision: 'c1',
    policyRevision: 'p1',
    commitOrdinal: 1n,
    createdAt,
    updatedAt,
    deletedAt: null as Date | null,
    ...overrides,
  };
}

function baseRoot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'root-1',
    collectionId: 'collection-1',
    parentId: null as string | null,
    kind: 'folder',
    isRoot: true,
    title: 'Root',
    url: null as string | null,
    description: null as string | null,
    tags: null as unknown,
    visibility: 'inherit',
    positionToken: null as string | null,
    resourceRevision: 'rr1',
    childrenRevision: 'ch1',
    createdAt,
    updatedAt,
    deletedAt: null as Date | null,
    deletedCommitOrdinal: null as bigint | null,
    ...overrides,
  };
}

function baseFolder(overrides: Record<string, unknown> = {}) {
  return {
    ...baseRoot({
      id: 'folder-1',
      isRoot: false,
      parentId: 'root-1',
      positionToken: 'a0',
      title: 'Folder',
    }),
    ...overrides,
  };
}

function baseBookmark(overrides: Record<string, unknown> = {}) {
  return {
    ...baseFolder({
      id: 'bookmark-1',
      kind: 'bookmark',
      title: 'Example',
      url: 'https://example.test/',
      tags: ['a', 'b'],
      description: 'desc',
      visibility: 'private',
      positionToken: 'a1',
    }),
    ...overrides,
  };
}

describe('resource payload materialization (ADR-0007 expand)', () => {
  test('materializes all Phase 1 collection kinds deterministically', () => {
    for (const kind of ['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'] as const) {
      const result = materializeCollectionPayload(baseCollection({ kind, summary: 's' }));
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.schemaVersion, RESOURCE_PAYLOAD_SCHEMA_VERSION);
      assert.equal(result.payload.kind, kind);
      assert.equal(result.payload.summary, 's');
      assert.equal(result.payload.allowSearchIndexing, false);
      assert.equal(result.payload.commitOrdinal, '1');
      assert.equal(result.payload.createdAt, '2026-07-01T09:00:00Z');
      // Milliseconds stripped to Product UtcDateTime.
      assert.equal(result.payload.updatedAt, '2026-07-16T06:30:00Z');
      assert.deepEqual(result.payload.extensions, {});
      // Idempotent / deterministic encoding.
      const again = materializeCollectionPayload(baseCollection({ kind, summary: 's' }));
      assert.equal(again.ok, true);
      if (!again.ok) return;
      assert.equal(canonicalJson(result.payload), canonicalJson(again.payload));
    }
  });

  test('accepts N-1 payload omission only as the default-false search authority', () => {
    const current = materializeCollectionPayload(baseCollection({ allowSearchIndexing: false }));
    assert.equal(current.ok, true);
    if (!current.ok) return;
    const { allowSearchIndexing: _omitted, ...nMinusOnePayload } = current.payload;
    assert.equal(validateResourcePayload('collection', nMinusOnePayload).ok, true);
    assert.equal(compareCollectionPayloadToRelational(
      baseCollection({ allowSearchIndexing: false }),
      nMinusOnePayload,
    ).equal, true);
    const optedIn = compareCollectionPayloadToRelational(
      baseCollection({ allowSearchIndexing: true }),
      nMinusOnePayload,
    );
    assert.equal(optedIn.equal, false);
    assert.equal(optedIn.mismatches[0]?.path, 'allowSearchIndexing');
  });

  test('materializes root, folder, and bookmark node variants', () => {
    const root = materializeNodePayload(baseRoot());
    assert.equal(root.ok, true);
    if (!root.ok) return;
    assert.equal(root.payload.kind, 'root');
    assert.equal(root.payload.isRoot, true);
    assert.equal(root.payload.folderRole, 'root');
    assert.equal(root.payload.parentId, null);
    assert.equal(root.payload.position, null);

    const folder = materializeNodePayload(baseFolder());
    assert.equal(folder.ok, true);
    if (!folder.ok) return;
    assert.equal(folder.payload.kind, 'folder');
    assert.equal(folder.payload.folderRole, null);
    assert.equal(folder.payload.position, 'a0');

    const bookmark = materializeNodePayload(baseBookmark());
    assert.equal(bookmark.ok, true);
    if (!bookmark.ok) return;
    assert.equal(bookmark.payload.kind, 'bookmark');
    assert.equal(bookmark.payload.url, 'https://example.test/');
    assert.deepEqual(bookmark.payload.tags, ['a', 'b']);
  });

  test('rejects malformed legacy rows without fabricating data', () => {
    const badTags = materializeNodePayload(baseBookmark({ tags: { not: 'array' } }));
    assert.equal(badTags.ok, false);
    if (badTags.ok) return;
    assert.match(badTags.reason, /tags/i);

    const badKind = materializeCollectionPayload(baseCollection({ kind: 'unknown' }));
    assert.equal(badKind.ok, false);

    const bookmarkNoUrl = materializeNodePayload(baseBookmark({ url: null }));
    assert.equal(bookmarkNoUrl.ok, false);

    for (const url of [
      'javascript:alert(1)',
      'https://user:secret@example.test/',
      'https://example.test/path with spaces',
    ]) {
      const badUrl = materializeNodePayload(baseBookmark({ url }));
      assert.equal(badUrl.ok, false, `expected malformed URL: ${url}`);
      if (!badUrl.ok) assert.equal(badUrl.fieldPath, 'url');
    }

    const longDescription = materializeNodePayload(baseBookmark({
      description: 'd'.repeat(20_001),
    }));
    assert.equal(longDescription.ok, false);
    if (!longDescription.ok) assert.equal(longDescription.fieldPath, 'description');

    for (const tags of [
      Array.from({ length: 65 }, (_, index) => `tag-${index}`),
      [''],
      ['   '],
      ['a'.repeat(65)],
      ['duplicate', 'duplicate'],
    ]) {
      const badTagsByDomainRule = materializeNodePayload(baseBookmark({ tags }));
      assert.equal(badTagsByDomainRule.ok, false, `expected malformed tags: ${JSON.stringify(tags)}`);
      if (!badTagsByDomainRule.ok) assert.equal(badTagsByDomainRule.fieldPath, 'tags');
    }

    const deletedWithoutOrdinal = materializeNodePayload(baseBookmark({
      deletedAt: new Date('2026-07-17T00:00:00.000Z'),
      deletedCommitOrdinal: null,
    }));
    assert.equal(deletedWithoutOrdinal.ok, false);
    if (!deletedWithoutOrdinal.ok) {
      assert.equal(deletedWithoutOrdinal.fieldPath, 'deletedCommitOrdinal');
    }

    const rootWithParent = materializeNodePayload(baseRoot({ parentId: 'x' }));
    assert.equal(rootWithParent.ok, false);

    const separator = materializeNodePayload(baseFolder({ kind: 'separator', title: null }));
    assert.equal(separator.ok, true);
    if (separator.ok) {
      assert.equal(separator.payload.kind, 'separator');
      assert.equal(Object.hasOwn(separator.payload, 'title'), false);
      assert.equal(Object.hasOwn(separator.payload, 'url'), false);
      assert.equal(Object.hasOwn(separator.payload, 'folderRole'), false);
    }
  });

  test('dual-read detects relational vs payload mismatches', () => {
    const row = baseCollection();
    const ok = materializeCollectionPayload(row);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;

    const match = compareCollectionPayloadToRelational(row, ok.payload);
    assert.equal(match.equal, true);
    assert.equal(match.mismatches.length, 0);

    const drifted = { ...ok.payload, title: 'drifted' };
    const mismatch = compareCollectionPayloadToRelational(row, drifted);
    assert.equal(mismatch.equal, false);
    assert.ok(mismatch.mismatches.some((m) => m.path === 'title'));

    const warnings: Array<{ name: string; value: number }> = [];
    const metrics = new InMemoryMetrics({
      onIncrement(name, value) {
        if (name === 'resource_authority_mismatch_total') warnings.push({ name, value });
      },
    });
    dualReadCollectionPayload({
      id: row.id,
      owner_subject_id: row.ownerSubjectId,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      visibility: row.visibility,
      root_node_id: row.rootNodeId,
      resource_revision: row.resourceRevision,
      content_revision: row.contentRevision,
      policy_revision: row.policyRevision,
      commit_ordinal: row.commitOrdinal,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      deleted_at: row.deletedAt,
      payload_json: drifted,
    }, metrics);
    assert.equal(metrics.get('resource_authority_mismatch_total'), 1);
    assert.deepEqual(warnings, [{ name: 'resource_authority_mismatch_total', value: 1 }]);

    const node = baseBookmark();
    const nodePayload = materializeNodePayload(node);
    assert.equal(nodePayload.ok, true);
    if (!nodePayload.ok) return;
    const nodeMismatch = compareNodePayloadToRelational(node, {
      ...nodePayload.payload,
      position: 'zzz',
    });
    assert.equal(nodeMismatch.equal, false);
    dualReadNodePayload({
      id: node.id,
      collection_id: node.collectionId,
      parent_id: node.parentId,
      kind: node.kind,
      is_root: node.isRoot,
      title: node.title,
      url: node.url,
      description: node.description,
      tags: node.tags,
      visibility: node.visibility,
      position_token: node.positionToken,
      resource_revision: node.resourceRevision,
      children_revision: node.childrenRevision,
      created_at: node.createdAt,
      updated_at: node.updatedAt,
      deleted_at: node.deletedAt,
      deleted_commit_ordinal: node.deletedCommitOrdinal,
      payload_json: null,
    }, metrics);
    assert.ok(metrics.get('resource_authority_mismatch_total') >= 2);
  });

  test('validateResourcePayload re-checks schema/domain invariants', () => {
    const collection = materializeCollectionPayload(baseCollection());
    assert.equal(collection.ok, true);
    if (!collection.ok) return;
    const valid = validateResourcePayload('collection', collection.payload);
    assert.equal(valid.ok, true);

    const invalid = validateResourcePayload('collection', { schemaVersion: 1 });
    assert.equal(invalid.ok, false);

    const node = materializeNodePayload(baseRoot());
    assert.equal(node.ok, true);
    if (!node.ok) return;
    assert.equal(validateResourcePayload('node', node.payload).ok, true);
  });

  test('compareResourcePayload is deterministic on key order', () => {
    const a = { z: 1, a: 2, nested: { b: 1, a: 0 } };
    const b = { a: 2, nested: { a: 0, b: 1 }, z: 1 };
    const comparison = compareResourcePayload({
      resourceType: 'collection',
      resourceId: 'x',
      expected: a,
      actual: b,
    });
    assert.equal(comparison.equal, true);
  });
});

describe('resource payload negative branches (T8)', () => {
  function assertMalformed(
    result: { ok: boolean; fieldPath?: string; reason?: string },
    expected: { fieldPath: string; reason: RegExp },
  ): void {
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.fieldPath, expected.fieldPath);
    assert.match(result.reason, expected.reason);
  }

  test.each([
    ['illegal collection kind', () => materializeCollectionPayload(baseCollection({ kind: 'unknown' })), {
      fieldPath: 'kind',
      reason: /Phase 1 collection kind/i,
    }],
    ['illegal node kind', () => materializeNodePayload(baseFolder({ kind: 'unknown' })), {
      fieldPath: 'kind',
      reason: /Phase 1 node kind/i,
    }],
    ['non-boolean isRoot', () => materializeNodePayload(baseFolder({
      isRoot: 'true' as unknown as boolean,
    })), {
      fieldPath: 'isRoot',
      reason: /isRoot is required/i,
    }],
    ['separator with title', () => materializeNodePayload({
      ...baseFolder({ kind: 'separator', title: null }),
      title: 'forbidden separator title',
    }), {
      fieldPath: 'title',
      reason: /title is invalid/i,
    }],
    ['root with url', () => materializeNodePayload(baseRoot({
      url: 'https://example.test/',
    })), {
      fieldPath: 'url',
      reason: /root url must be null/i,
    }],
    ['non-bookmark with url', () => materializeNodePayload(baseFolder({
      url: 'https://example.test/',
    })), {
      fieldPath: 'url',
      reason: /non-Bookmark url must be null/i,
    }],
    ['missing parent on non-root', () => materializeNodePayload(baseFolder({
      parentId: null,
    })), {
      fieldPath: 'parentId',
      reason: /non-root parentId is required/i,
    }],
    ['missing position on non-root', () => materializeNodePayload(baseFolder({
      positionToken: null,
    })), {
      fieldPath: 'positionToken',
      reason: /non-root positionToken is required/i,
    }],
    ['deleted without commit ordinal', () => materializeNodePayload(baseBookmark({
      deletedAt: new Date('2026-07-17T00:00:00.000Z'),
      deletedCommitOrdinal: null,
    })), {
      fieldPath: 'deletedCommitOrdinal',
      reason: /deleted node must have deletedCommitOrdinal/i,
    }],
    ['live node with deleted commit ordinal', () => materializeNodePayload(baseBookmark({
      deletedCommitOrdinal: 9n,
    })), {
      fieldPath: 'deletedCommitOrdinal',
      reason: /live node cannot have deletedCommitOrdinal/i,
    }],
  ] as const)('rejects %s with precise fieldPath and reason', (_label, run, expected) => {
    assertMalformed(run(), expected);
  });
});
