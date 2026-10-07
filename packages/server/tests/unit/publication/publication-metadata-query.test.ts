import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  getPublicationCollectionMetadata,
  PublicationMetadataNotFoundError,
  type PublicationMetadataRecord,
} from '../../../src/modules/publication/index.js';

const now = new Date('2026-07-24T00:00:00Z');
function record(overrides: Partial<PublicationMetadataRecord> = {}): PublicationMetadataRecord {
  return {
    id: 'collection-1', ownerSubjectId: 'owner', kind: 'bookmarks', title: 'Collection', summary: null,
    visibility: 'public', publicationSlug: 'collection', rootNodeId: 'root-1', rootAvailable: true, contentRevision: 'c1',
    policyRevision: 'p1', tags: [], language: null, membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    deletedAt: null, ...overrides,
  };
}
function ports(current: PublicationMetadataRecord | null) {
  return {
    reads: { async load() { return current; } },
    origin: 'https://known.example',
    now: () => now,
  };
}

test('maps public and unlisted direct reads to canonical Metadata and Snapshot links', async () => {
  for (const visibility of ['public', 'unlisted'] as const) {
    const result = await getPublicationCollectionMetadata(ports(record({ visibility })), {
      collectionId: 'collection-1', principal: { kind: 'anonymous' },
    });
    assert.equal(result.kind, 'metadata');
    if (result.kind !== 'metadata') continue;
    assert.equal(result.projection, 'public');
    assert.equal(result.metadata.collection.revision, 'c1.p1');
    assert.equal(result.metadata.links.self, 'https://known.example/colp/v0.1/collections/collection-1');
    assert.equal(result.metadata.links.snapshot, 'https://known.example/colp/v0.1/collections/collection-1/snapshot');
    assert.equal(result.metadata.links.canonical, 'https://known.example/c/collection');
  }
});

test('member projection reads protected/private while anonymous requests are concealed', async () => {
  for (const visibility of ['protected', 'private'] as const) {
    const current = record({ visibility, membershipRole: 'viewer' });
    await assert.rejects(
      () => getPublicationCollectionMetadata(ports(current), {
        collectionId: 'collection-1', principal: { kind: 'anonymous' },
      }),
      PublicationMetadataNotFoundError,
    );
    const result = await getPublicationCollectionMetadata(ports(current), {
      collectionId: 'collection-1',
      principal: { kind: 'account', principalId: 'account', subjectId: 'member' },
    });
    assert.equal(result.kind, 'metadata');
    if (result.kind === 'metadata') assert.equal(result.projection, 'member');
  }
});

test('retains a deleted locator for 30 days and expires it at the exclusive boundary', async () => {
  const within = record({ deletedAt: '2026-07-01T00:00:01.000Z' });
  const result = await getPublicationCollectionMetadata(ports(within), {
    collectionId: 'collection-1', principal: { kind: 'anonymous' },
  });
  assert.deepEqual(result, {
    kind: 'gone', deletedAt: '2026-07-01T00:00:01.000Z',
    canonicalUrl: 'https://known.example/c/collection',
  });
  await assert.rejects(
    () => getPublicationCollectionMetadata(ports(record({ deletedAt: '2026-06-24T00:00:00.000Z' })), {
      collectionId: 'collection-1', principal: { kind: 'anonymous' },
    }),
    PublicationMetadataNotFoundError,
  );
});

test('looks up canonical tombstones by slug and conceals deleted private history', async () => {
  let loaded: unknown;
  const queryPorts = {
    reads: { async load(input: unknown) { loaded = input; return record({ deletedAt: '2026-07-01T00:00:01.000Z' }); } },
    origin: 'https://known.example',
    now: () => now,
  };
  const result = await getPublicationCollectionMetadata(queryPorts, {
    publicationSlug: 'collection', principal: { kind: 'anonymous' },
  });
  assert.equal(result.kind, 'gone');
  assert.deepEqual(loaded, { publicationSlug: 'collection' });

  await assert.rejects(
    () => getPublicationCollectionMetadata(ports(record({
      visibility: 'private', deletedAt: '2026-07-01T00:00:01.000Z',
    })), { publicationSlug: 'collection', principal: { kind: 'anonymous' } }),
    PublicationMetadataNotFoundError,
  );
});

test('conceals live Metadata when its declared Snapshot root is unavailable', async () => {
  await assert.rejects(
    () => getPublicationCollectionMetadata(ports(record({ rootAvailable: false })), {
      collectionId: 'collection-1', principal: { kind: 'anonymous' },
    }),
    PublicationMetadataNotFoundError,
  );
});
