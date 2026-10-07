import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import {
  PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE,
  PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE,
  SHARED_COLLECTIONS_DEFAULT_LIMIT,
  SharedCollectionsCursorError,
  SharedCollectionsInputError,
  createProductOwnedCollectionsCursorSigner,
  createProductSharedCollectionsCursorSigner,
  getOwnedCollectionsPage,
  getSharedCollectionsPage,
  toSharedCollectionListItem,
  type OwnedCollectionFact,
  type SharedCollectionFact,
  type SharedCollectionsReadInput,
  type SharedCollectionsReadPort,
} from '../../../src/modules/collections/index.js';

const NOW = new Date('2026-08-19T00:00:00.000Z');
const CURRENT = { id: 'shared-v1', key: 'shared-collections-current-secret-material' };
const ACTOR = 'subject-member';
const OWNER = 'subject-owner';

function fact(
  id: string,
  updatedAt: string,
  overrides: Partial<SharedCollectionFact> = {},
): SharedCollectionFact {
  return {
    id,
    kind: 'bookmarks',
    title: `Shared ${id}`,
    summary: null,
    visibility: 'private',
    publicationSlug: null,
    allowSearchIndexing: false,
    publishedAt: null,
    rootNodeId: `root-${id}`,
    resourceRevision: `r-${id}`,
    contentRevision: `c-${id}`,
    policyRevision: `p-${id}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date(updatedAt),
    ownerSubjectId: OWNER,
    membershipRole: 'editor',
    ...overrides,
  };
}

interface MemoryRow {
  readonly collection: SharedCollectionFact;
  readonly deleted?: boolean;
  readonly members: ReadonlyArray<{
    readonly subjectId: string;
    readonly role: 'owner' | 'editor' | 'viewer';
  }>;
  readonly pendingInviteSubjects?: readonly string[];
}

function memoryPort(rows: readonly MemoryRow[]): SharedCollectionsReadPort {
  return {
    async listSharedCollections(input: SharedCollectionsReadInput) {
      return rows
        .filter((row) => row.deleted !== true)
        .filter((row) => row.collection.ownerSubjectId !== input.memberSubjectId)
        .filter((row) => row.members.some((member) =>
          member.subjectId === input.memberSubjectId
          && (member.role === 'editor' || member.role === 'viewer')))
        .filter((row) => !input.kind || row.collection.kind === input.kind)
        .filter((row) => !input.visibility || row.collection.visibility === input.visibility)
        .map((row) => {
          const membership = row.members.find((member) =>
            member.subjectId === input.memberSubjectId
            && (member.role === 'editor' || member.role === 'viewer'))!;
          return {
            ...row.collection,
            membershipRole: membership.role as 'editor' | 'viewer',
          };
        })
        .filter((row) => !input.after || row.updatedAt < input.after.updatedAt
          || (row.updatedAt.getTime() === input.after.updatedAt.getTime()
            && Buffer.compare(Buffer.from(row.id), Buffer.from(input.after.id)) > 0))
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
          || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)))
        .slice(0, input.limit + 1);
    },
  };
}

function ports(rows: readonly MemoryRow[], signer = createProductSharedCollectionsCursorSigner({ current: CURRENT })) {
  return { reads: memoryPort(rows), cursors: signer, clock: { now: async () => NOW } };
}

function ownedRow(id: string, updatedAt: string): MemoryRow {
  return {
    collection: fact(id, updatedAt, { ownerSubjectId: ACTOR, membershipRole: 'editor' }),
    members: [{ subjectId: ACTOR, role: 'owner' }],
  };
}

function sharedRow(
  id: string,
  updatedAt: string,
  role: 'editor' | 'viewer' = 'editor',
  extras: Partial<MemoryRow> = {},
): MemoryRow {
  return {
    collection: fact(id, updatedAt, { membershipRole: role }),
    members: [
      { subjectId: OWNER, role: 'owner' },
      { subjectId: ACTOR, role },
    ],
    ...extras,
  };
}

describe('SC-03 shared Collection application query', () => {
  test('empty page for a subject with no shared memberships', async () => {
    const page = await getSharedCollectionsPage(ports([]), { actor: { subjectId: ACTOR } });
    assert.deepEqual(page.items, []);
    assert.deepEqual(page.page, { returnedCount: 0, hasMore: false, nextCursor: null });
  });

  test('owned-only collections do not appear on the shared list', async () => {
    const page = await getSharedCollectionsPage(ports([ownedRow('mine', '2026-08-18T00:00:00.000Z')]), {
      actor: { subjectId: ACTOR },
    });
    assert.deepEqual(page.items.map((row) => row.id), []);
  });

  test('shared-only editor memberships appear', async () => {
    const page = await getSharedCollectionsPage(ports([
      sharedRow('shared-a', '2026-08-18T12:00:00.000Z'),
    ]), { actor: { subjectId: ACTOR } });
    assert.deepEqual(page.items.map((row) => row.id), ['shared-a']);
    assert.equal(page.items[0]?.membershipRole, 'editor');
    assert.equal(page.items[0]?.ownerSubjectId, OWNER);
  });

  test('mixed: owned omitted, shared included', async () => {
    const page = await getSharedCollectionsPage(ports([
      ownedRow('mine', '2026-08-18T13:00:00.000Z'),
      sharedRow('theirs', '2026-08-18T12:00:00.000Z'),
    ]), { actor: { subjectId: ACTOR } });
    assert.deepEqual(page.items.map((row) => row.id), ['theirs']);
  });

  test('deleted collections, revoked membership, and pending invites are omitted', async () => {
    const page = await getSharedCollectionsPage(ports([
      { ...sharedRow('deleted', '2026-08-18T12:00:00.000Z'), deleted: true },
      {
        collection: fact('revoked', '2026-08-18T11:00:00.000Z'),
        members: [{ subjectId: OWNER, role: 'owner' }],
      },
      {
        collection: fact('pending', '2026-08-18T10:00:00.000Z'),
        members: [{ subjectId: OWNER, role: 'owner' }],
        pendingInviteSubjects: [ACTOR],
      },
      sharedRow('live', '2026-08-18T09:00:00.000Z', 'viewer'),
    ]), { actor: { subjectId: ACTOR } });
    assert.deepEqual(page.items.map((row) => row.id), ['live']);
  });

  test('viewer vs editor capabilities follow the real membership role, never owner', () => {
    const viewer = toSharedCollectionListItem(fact('v', '2026-08-18T00:00:00.000Z', {
      membershipRole: 'viewer',
    }), 'viewer');
    const editor = toSharedCollectionListItem(fact('e', '2026-08-18T00:00:00.000Z', {
      membershipRole: 'editor',
    }), 'editor');
    assert.equal(viewer.capabilities.createNode, false);
    assert.equal(viewer.capabilities.updateCollection, false);
    assert.equal(viewer.capabilities.managePublication, false);
    assert.equal(viewer.capabilities.updateNode, false);
    assert.equal(viewer.capabilities.moveNode, false);
    assert.equal(viewer.capabilities.deleteNode, false);
    assert.equal(editor.capabilities.createNode, true);
    assert.equal(editor.capabilities.updateCollection, true);
    assert.equal(editor.capabilities.updateNode, true);
    assert.equal(editor.capabilities.moveNode, true);
    assert.equal(editor.capabilities.deleteNode, true);
    assert.equal(editor.capabilities.managePublication, false);
  });

  test('owned cursor payload/purpose is rejected as invalid_cursor', async () => {
    const ownedSigner = createProductOwnedCollectionsCursorSigner({ current: CURRENT });
    const sharedSigner = createProductSharedCollectionsCursorSigner({ current: CURRENT });
    const ownedFact: OwnedCollectionFact = fact('a', '2026-08-18T02:00:00.000Z');
    const ownedPage = await getOwnedCollectionsPage({
      reads: {
        async listOwnedCollections() {
          return [ownedFact, { ...ownedFact, id: 'b', updatedAt: new Date('2026-08-18T01:00:00.000Z') }];
        },
      },
      cursors: ownedSigner,
      clock: { now: async () => NOW },
    }, { actor: { subjectId: ACTOR }, limit: 1 });
    const ownedCursor = ownedPage.page.nextCursor!;
    assert.ok(ownedCursor);
    const decoded = JSON.parse(Buffer.from(ownedCursor.split('.')[1]!, 'base64url').toString('utf8')) as {
      purpose: string;
    };
    assert.equal(decoded.purpose, PRODUCT_OWNED_COLLECTIONS_CURSOR_PURPOSE);
    await assert.rejects(
      () => getSharedCollectionsPage(ports([sharedRow('a', '2026-08-18T02:00:00.000Z')], sharedSigner), {
        actor: { subjectId: ACTOR }, cursor: ownedCursor,
      }),
      SharedCollectionsCursorError,
    );
  });

  test('timestamp ties are broken by id C-locale/bytewise ASC', async () => {
    const tied = '2026-08-18T12:00:00.000Z';
    const page = await getSharedCollectionsPage(ports([
      sharedRow('b-id', tied),
      sharedRow('a-id', tied),
      sharedRow('c-id', tied),
    ]), { actor: { subjectId: ACTOR } });
    assert.deepEqual(page.items.map((row) => row.id), ['a-id', 'b-id', 'c-id']);
  });

  test('queries the in-memory port with the authenticated member subject and default limit', async () => {
    const calls: SharedCollectionsReadInput[] = [];
    const reads: SharedCollectionsReadPort = {
      async listSharedCollections(input) { calls.push(input); return []; },
    };
    await getSharedCollectionsPage({ ...ports([]), reads }, { actor: { subjectId: 'authoritative-member' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.memberSubjectId, 'authoritative-member');
    assert.equal(calls[0]?.limit, SHARED_COLLECTIONS_DEFAULT_LIMIT);
    assert.equal(calls[0]?.after, undefined);
  });

  test('rejects invalid limits and cursor mixed with first-page parameters', async () => {
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await assert.rejects(
        () => getSharedCollectionsPage(ports([]), { actor: { subjectId: ACTOR }, limit }),
        SharedCollectionsInputError,
      );
    }
    const first = await getSharedCollectionsPage(ports([
      sharedRow('a', '2026-08-18T02:00:00.000Z'),
      sharedRow('b', '2026-08-18T01:00:00.000Z'),
    ]), { actor: { subjectId: ACTOR }, limit: 1 });
    await assert.rejects(
      () => getSharedCollectionsPage(ports([]), {
        actor: { subjectId: ACTOR }, cursor: first.page.nextCursor!, limit: 1,
      }),
      SharedCollectionsInputError,
    );
  });

  test('pages 30 then 1 across 31 shared rows and signs a shared-purpose cursor', async () => {
    const rows = Array.from({ length: 31 }, (_, index) =>
      sharedRow(`id-${String(index).padStart(3, '0')}`, new Date(NOW.getTime() - index * 1000).toISOString()));
    const first = await getSharedCollectionsPage(ports(rows), { actor: { subjectId: ACTOR } });
    assert.equal(first.items.length, 30);
    assert.equal(first.page.returnedCount, 30);
    assert.equal(first.page.hasMore, true);
    assert.ok(first.page.nextCursor);
    const payload = JSON.parse(Buffer.from(first.page.nextCursor!.split('.')[1]!, 'base64url').toString('utf8')) as {
      purpose: string;
    };
    assert.equal(payload.purpose, PRODUCT_SHARED_COLLECTIONS_CURSOR_PURPOSE);
    const second = await getSharedCollectionsPage(ports(rows), {
      actor: { subjectId: ACTOR }, cursor: first.page.nextCursor!,
    });
    assert.equal(second.items.length, 1);
    assert.equal(second.page.hasMore, false);
    assert.equal(second.page.nextCursor, null);
    assert.equal(new Set([...first.items, ...second.items].map((row) => row.id)).size, 31);
  });

  test('shared list SQL does not inline count(*)', async () => {
    const source = await readFile(
      new URL('../../../src/infrastructure/collections/shared-collections-query.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /count\(\*\)/i);
  });

  test('shared list SQL orders by denormalized collection_updated_at (P-10)', async () => {
    const source = await readFile(
      new URL('../../../src/infrastructure/collections/shared-collections-query.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /P-10/u);
    assert.match(source, /collection_members\.collection_updated_at/u);
    assert.match(source, /'collections\.updated_at'/u);
    assert.match(source, /collection_members\.collection_id COLLATE "C"/u);
    assert.doesNotMatch(source, /orderBy\('collections\.updated_at'/u);
  });

  test('shared list capabilities use membershipRole without a synthetic ActorPrincipal', async () => {
    const source = await readFile(
      new URL('../../../src/modules/collections/application/get-shared-collections.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /shared-member/u);
    assert.doesNotMatch(source, /resolveEffectiveRole/u);
    assert.doesNotMatch(source, /kind:\s*'account'/u);
    assert.match(source, /capabilitiesForRole\(membershipRole\)/u);
  });
});
