import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';
import type { ResourcePolicyFacts } from '../../../src/modules/access-policy/index.js';
import {
  CollectionAuthorizationError,
  CollectionsError,
  strongEntityTag,
  updateCollectionMetadataCanonical,
  type LockedCollectionRow,
  type ProductCollectionCanonicalPorts,
  type UpdateCollectionMetadataInput,
} from '../../../src/modules/collections/index.js';

const now = new Date('2026-07-24T00:00:00.000Z');

function locked(overrides: Partial<LockedCollectionRow> = {}): LockedCollectionRow {
  return {
    id: 'collection-1',
    ownerSubjectId: 'owner-subject',
    title: 'Collection',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    allowSearchIndexing: false,
    publicationSlug: null,
    publishedAt: null,
    rootNodeId: 'root-1',
    resourceRevision: 'resource-1',
    contentRevision: 'content-1',
    policyRevision: 'policy-1',
    commitOrdinal: 1n,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function input(subjectId = 'owner-subject', patch: UpdateCollectionMetadataInput['patch'] = {
  visibility: 'public',
  publicationSlug: 'engineering-notes',
}): UpdateCollectionMetadataInput {
  return {
    actor: { principalId: `principal-${subjectId}`, principalType: 'account', subjectId },
    command: { commandId: '11111111-2222-4333-8444-555555555555', fingerprint: 'fingerprint' },
    collectionId: 'collection-1',
    ifMatch: strongEntityTag('resource-1'),
    patch,
    operationId: 'operation-1',
    productOrigin: 'https://know.example',
  };
}

function ports(row: LockedCollectionRow, role: 'owner' | 'editor' = 'owner'):
ProductCollectionCanonicalPorts & { captured: Record<string, unknown> } {
  const captured: Record<string, unknown> = {};
  const facts: ResourcePolicyFacts = {
    collectionId: row.id,
    ownerSubjectId: row.ownerSubjectId,
    visibility: row.visibility,
    policyRevision: row.policyRevision,
    membershipRole: role,
    deleted: false,
  };
  return {
    captured,
    receipts: {
      async claim() { return { kind: 'claimed' }; },
      async complete(_binding, _fingerprint, result) { captured.receipt = result; },
      async purgeExpired() { return 0; },
      async deletePrincipalReceipts() { return 0; },
    },
    clock: { async now() { return now; } },
    collections: { async lockForUpdate() { return row; } },
    nodes: {
      async getNode() { return null; },
      async listLiveSiblingPositions() { return []; },
    },
    accessPolicy: {
      async loadCollectionFacts(request) {
        return { ...facts, membershipRole: request.actorSubjectId === 'editor-subject' ? 'editor' : role };
      },
    },
    canonical: {
      async execute(request) {
        captured.request = request as unknown as Record<string, unknown>;
        const fields = request.mutation.fields!.kindFields;
        const contentChanged = fields.title !== row.title || fields.summary !== row.summary;
        const policyChanged = fields.visibility !== row.visibility
          || fields.allowSearchIndexing !== row.allowSearchIndexing;
        return {
          operationId: request.operationId,
          collectionId: request.collectionId,
          resourceId: request.collectionId,
          action: 'update',
          allocation: {
            commitOrdinal: 2n,
            resourceRevision: 'resource-2',
            ...(contentChanged ? { contentRevision: 'content-2' } : {}),
            ...(policyChanged ? { policyRevision: 'policy-2' } : {}),
            childrenRevisions: {},
          },
        };
      },
      async bootstrapOwnedCollection() { throw new Error('unused'); },
    },
  };
}

test('owner publishes and withdraws through one canonical mutation with policy fence effects', async () => {
  const publishPorts = ports(locked());
  const published = await updateCollectionMetadataCanonical(publishPorts, input());
  assert.equal(published.kind, 'updated');
  if (published.kind !== 'updated') return;
  assert.equal(published.collection.visibility, 'public');
  assert.equal(published.collection.publicationSlug, 'engineering-notes');
  assert.equal(published.collection.publishedAt, '2026-07-24T00:00:00Z');
  assert.equal(published.collection.policyRevision, 'policy-2');
  assert.equal(published.collection.contentRevision, 'content-1');
  assert.equal(published.stableHeaders.location, 'https://know.example/c/engineering-notes');
  const publishReceipt = publishPorts.captured.receipt as { stableHeaders: Record<string, string> };
  assert.equal(publishReceipt.stableHeaders.location, published.stableHeaders.location);
  const request = publishPorts.captured.request as {
    mutation: { fields: { kindFields: Record<string, unknown> } };
  };
  assert.equal(request.mutation.fields.kindFields.publicationSlug, 'engineering-notes');

  const withdrawalPorts = ports(locked({
    visibility: 'public',
    publicationSlug: 'engineering-notes',
    publishedAt: now,
  }));
  const withdrawn = await updateCollectionMetadataCanonical(
    withdrawalPorts,
    input('owner-subject', { visibility: 'private' }),
  );
  assert.equal(withdrawn.kind, 'updated');
  if (withdrawn.kind === 'updated') {
    assert.equal(withdrawn.collection.visibility, 'private');
    assert.equal(withdrawn.collection.publicationSlug, 'engineering-notes');
    assert.equal(withdrawn.collection.publishedAt, '2026-07-24T00:00:00Z');
    assert.equal(withdrawn.collection.contentRevision, 'content-1');
    assert.equal(withdrawn.collection.policyRevision, 'policy-2');
    assert.equal(withdrawn.stableHeaders.location, 'https://know.example/c/engineering-notes');
  }

  const republished = await updateCollectionMetadataCanonical(
    ports(locked({
      visibility: 'private',
      publicationSlug: 'engineering-notes',
      publishedAt: now,
    })),
    input('owner-subject', { visibility: 'unlisted', publicationSlug: 'engineering-notes' }),
  );
  assert.equal(republished.kind, 'updated');
  if (republished.kind === 'updated') {
    assert.equal(republished.collection.visibility, 'unlisted');
    assert.equal(republished.collection.publicationSlug, 'engineering-notes');
    assert.equal(republished.stableHeaders.location, 'https://know.example/c/engineering-notes');
  }
});

test('publication settings are owner-only and slugs are canonical and immutable', async () => {
  await assert.rejects(
    () => updateCollectionMetadataCanonical(ports(locked(), 'editor'), input('editor-subject')),
    (error: unknown) => error instanceof CollectionAuthorizationError && error.outcome === 'deny',
  );
  for (const publicationSlug of ['Uppercase', 'ab', 'space slug']) {
    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports(locked()), input('owner-subject', {
        visibility: 'public',
        publicationSlug,
      })),
      (error: unknown) => error instanceof CollectionsError,
    );
  }
  await assert.rejects(
    () => updateCollectionMetadataCanonical(ports(locked({
      publicationSlug: 'reserved-slug',
      publishedAt: now,
    })), input('owner-subject', {
      visibility: 'public',
      publicationSlug: 'different-slug',
    })),
    (error: unknown) => error instanceof CollectionsError && /immutable/u.test(error.message),
  );

  await assert.rejects(
    () => updateCollectionMetadataCanonical(ports(locked()), input('owner-subject', {
      publicationSlug: 'draft-reservation',
    })),
    (error: unknown) => error instanceof CollectionsError && /first public or unlisted/u.test(error.message),
  );

  const firstPublishReplacingDraft = await updateCollectionMetadataCanonical(
    ports(locked({ publicationSlug: 'legacy-draft' })),
    input('owner-subject', { visibility: 'public', publicationSlug: 'published-slug' }),
  );
  assert.equal(firstPublishReplacingDraft.kind, 'updated');
  if (firstPublishReplacingDraft.kind === 'updated') {
    assert.equal(firstPublishReplacingDraft.collection.publicationSlug, 'published-slug');
  }
});

test('search indexing authority is owner-only, defaults false, and is independent from visibility', async () => {
  await assert.rejects(
    () => updateCollectionMetadataCanonical(ports(locked(), 'editor'), input('editor-subject', {
      allowSearchIndexing: true,
    })),
    (error: unknown) => error instanceof CollectionAuthorizationError && error.outcome === 'deny',
  );

  const optInPorts = ports(locked({ visibility: 'private', allowSearchIndexing: false }));
  const optedIn = await updateCollectionMetadataCanonical(optInPorts, input('owner-subject', {
    allowSearchIndexing: true,
  }));
  assert.equal(optedIn.kind, 'updated');
  if (optedIn.kind === 'updated') {
    assert.equal(optedIn.collection.visibility, 'private');
    assert.equal(optedIn.collection.allowSearchIndexing, true);
    assert.equal(optedIn.collection.policyRevision, 'policy-2');
  }
  const request = optInPorts.captured.request as {
    mutation: { fields: { kindFields: Record<string, unknown> } };
  };
  assert.equal(request.mutation.fields.kindFields.allowSearchIndexing, true);

  const publishWithoutOptIn = await updateCollectionMetadataCanonical(
    ports(locked({ visibility: 'private', allowSearchIndexing: false })),
    input('owner-subject', { visibility: 'public', publicationSlug: 'public-not-searchable' }),
  );
  assert.equal(publishWithoutOptIn.kind, 'updated');
  if (publishWithoutOptIn.kind === 'updated') {
    assert.equal(publishWithoutOptIn.collection.visibility, 'public');
    assert.equal(publishWithoutOptIn.collection.allowSearchIndexing, false);
  }
});

test('metadata and publication locator changes allocate only their authoritative revision effects', async () => {
  const metadataPorts = ports(locked());
  const metadata = await updateCollectionMetadataCanonical(
    metadataPorts,
    input('owner-subject', { title: 'Changed title' }),
  );
  assert.equal(metadata.kind, 'updated');
  if (metadata.kind === 'updated') {
    assert.equal(metadata.collection.contentRevision, 'content-2');
    assert.equal(metadata.collection.policyRevision, 'policy-1');
    assert.equal(metadata.stableHeaders.location, undefined);
  }

  const locatorPorts = ports(locked({ publicationSlug: 'legacy-draft' }));
  const locator = await updateCollectionMetadataCanonical(
    locatorPorts,
    input('owner-subject', { visibility: 'public', publicationSlug: 'first-live-slug' }),
  );
  assert.equal(locator.kind, 'updated');
  if (locator.kind === 'updated') {
    assert.equal(locator.collection.contentRevision, 'content-1');
    assert.equal(locator.collection.policyRevision, 'policy-2');
  }
});

test('canonical publication Location accepts only an exact trusted origin', async () => {
  for (const productOrigin of [
    'not-a-url',
    'https://know.example/path',
    'https://user@know.example',
    'ftp://know.example',
    'javascript:alert(1)',
  ]) {
    await assert.rejects(
      () => updateCollectionMetadataCanonical(ports(locked()), {
        ...input(),
        productOrigin,
      }),
      (error: unknown) => error instanceof CollectionsError && /exact HTTP\(S\) origin/u.test(error.message),
    );
  }
});

test('publication locator migration avoids immediate check validation and reserves canonical slugs', async () => {
  const source = await readFile(
    new URL('../../../migrations/202607240100_publication_locators.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /ADD COLUMN publication_slug/u);
  assert.match(source, /ADD COLUMN published_at/u);
  assert.match(source, /CREATE UNIQUE INDEX collections_publication_slug_unique/u);
  assert.match(source, /publication_slug = lower\(publication_slug\)/u);
  assert.match(source, /length\(publication_slug\) BETWEEN 3 AND 263/u);
  assert.match(source, /publication_slug ~ '\^\[a-z0-9\]\[a-z0-9-\]\*\[a-z0-9\]\$'/u);
  assert.doesNotMatch(source, /\{1,261\}/u);
  assert.match(source, /collections_publication_slug_canonical[\s\S]*?NOT VALID/u);
  assert.match(source, /collections_published_locator_required[\s\S]*?NOT VALID/u);
  assert.doesNotMatch(source, /VALIDATE CONSTRAINT/u);
  assert.doesNotMatch(source, /CREATE UNIQUE INDEX CONCURRENTLY/u);
  assert.doesNotMatch(source, /CREATE TABLE\s+publications/iu);
});
