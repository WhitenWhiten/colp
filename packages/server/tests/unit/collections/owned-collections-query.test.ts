import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'vitest';
import {
  OWNED_COLLECTIONS_DEFAULT_LIMIT,
  OwnedCollectionsCursorError,
  createProductOwnedCollectionsCursorSigner,
  getOwnedCollectionsPage,
  type OwnedCollectionFact,
  type OwnedCollectionsReadInput,
  type OwnedCollectionsReadPort,
} from '../../../src/modules/collections/index.js';
import { createProductEditorCursorSigner } from '../../../src/modules/collections/index.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CURRENT = { id: 'owned-v2', key: 'owned-collections-current-secret-material' };
const OLD = { id: 'owned-v1', key: 'owned-collections-previous-secret-material' };

function fact(id: string, updatedAt: string, overrides: Partial<OwnedCollectionFact> = {}): OwnedCollectionFact {
  return {
    id, kind: 'bookmarks', title: `Owned ${id}`, summary: null, visibility: 'private',
    publicationSlug: null, allowSearchIndexing: false, publishedAt: null,
    rootNodeId: `root-${id}`, resourceRevision: `r-${id}`, contentRevision: `c-${id}`,
    policyRevision: `p-${id}`, createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date(updatedAt), ...overrides,
  };
}

function memoryPort(rows: readonly OwnedCollectionFact[]): OwnedCollectionsReadPort {
  return {
    async listOwnedCollections(input: OwnedCollectionsReadInput) {
      return rows.filter((row) =>
        (!input.kind || row.kind === input.kind)
        && (!input.visibility || row.visibility === input.visibility)
        && (!input.after || row.updatedAt < input.after.updatedAt
          || (row.updatedAt.getTime() === input.after.updatedAt.getTime()
            && Buffer.compare(Buffer.from(row.id), Buffer.from(input.after.id)) > 0)))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
          || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))
        .slice(0, input.limit + 1);
    },
  };
}

function ports(rows: readonly OwnedCollectionFact[], signer = createProductOwnedCollectionsCursorSigner({ current: CURRENT })) {
  return { reads: memoryPort(rows), cursors: signer, clock: { now: async () => NOW } };
}

describe('LM-01 owned Collection application query', () => {
  test.each([0, 1, 30, 31, 100, 101])('fully traverses %i rows with stable tuple order', async (count) => {
    const rows = Array.from({ length: count }, (_, index) =>
      fact(`id-${String(count - index).padStart(3, '0')}`, index < Math.min(count, 40)
        ? '2026-07-25T12:00:00.000Z'
        : `2026-07-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`));
    const seen: OwnedCollectionFact[] = [];
    let cursor: string | undefined;
    do {
      const page = await getOwnedCollectionsPage(ports(rows), {
        actor: { subjectId: 'subject-owner' }, ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items);
      cursor = page.page.nextCursor ?? undefined;
      assert.equal(page.page.hasMore, cursor !== undefined);
      assert.ok(page.page.returnedCount <= OWNED_COLLECTIONS_DEFAULT_LIMIT);
    } while (cursor);
    assert.equal(new Set(seen.map((row) => row.id)).size, count);
    assert.deepEqual(new Set(seen.map((row) => row.id)), new Set(rows.map((row) => row.id)));
    for (let index = 1; index < seen.length; index += 1) {
      const previous = seen[index - 1]!;
      const current = seen[index]!;
      assert.ok(previous.updatedAt > current.updatedAt
        || (previous.updatedAt.getTime() === current.updatedAt.getTime()
          && Buffer.compare(Buffer.from(previous.id), Buffer.from(current.id)) < 0));
    }
  });

  test('uses only the authenticated actor subject and canonical kind/visibility filters', async () => {
    const calls: OwnedCollectionsReadInput[] = [];
    const reads: OwnedCollectionsReadPort = { async listOwnedCollections(input) { calls.push(input); return []; } };
    const queryPorts = { ...ports([]), reads };
    for (const kind of ['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'] as const) {
      for (const visibility of ['private', 'protected', 'unlisted', 'public'] as const) {
        await getOwnedCollectionsPage(queryPorts, { actor: { subjectId: 'authoritative-subject' }, kind, visibility, limit: 1 });
      }
    }
    assert.equal(calls.length, 16);
    assert.ok(calls.every((call) => call.ownerSubjectId === 'authoritative-subject'));
    assert.deepEqual(new Set(calls.map((call) => call.kind)), new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']));
    assert.deepEqual(new Set(calls.map((call) => call.visibility)), new Set(['private', 'protected', 'unlisted', 'public']));
  });

  test('rejects invalid limits and cursor mixed with first-page parameters', async () => {
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await assert.rejects(() => getOwnedCollectionsPage(ports([]), { actor: { subjectId: 'owner' }, limit }), /limit|invalid_query/u);
    }
    const first = await getOwnedCollectionsPage(ports([fact('a', '2026-07-25T00:00:00Z'), fact('b', '2026-07-24T00:00:00Z')]), { actor: { subjectId: 'owner' }, limit: 1 });
    await assert.rejects(() => getOwnedCollectionsPage(ports([]), { actor: { subjectId: 'owner' }, cursor: first.page.nextCursor!, limit: 1 }), /mutually exclusive|invalid_query/u);
  });

  test('honors the maximum limit with a limit+1 continuation probe', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => fact(
      `max-${String(index).padStart(3, '0')}`,
      new Date(NOW.getTime() - index * 1000).toISOString(),
    ));
    const page = await getOwnedCollectionsPage(ports(rows), { actor: { subjectId: 'owner' }, limit: 100 });
    assert.equal(page.items.length, 100);
    assert.equal(page.page.returnedCount, 100);
    assert.equal(page.page.hasMore, true);
    assert.ok(page.page.nextCursor);
  });

  test('preserves millisecond precision in the cursor tuple', async () => {
    const rows = [
      fact('a', '2026-07-25T12:00:00.900Z'),
      fact('b', '2026-07-25T12:00:00.500Z'),
      fact('c', '2026-07-25T12:00:00.100Z'),
    ];
    const queryPorts = ports(rows);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getOwnedCollectionsPage(queryPorts, {
        actor: { subjectId: 'owner' }, limit: cursor ? undefined : 1, ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ['a', 'b', 'c']);
  });

  test('defines live keyset behavior for inserts and updates between pages', async () => {
    const rows = [fact('a', '2026-07-25T03:00:00Z'), fact('b', '2026-07-25T02:00:00Z'), fact('c', '2026-07-25T01:00:00Z')];
    const queryPorts = ports(rows);
    const first = await getOwnedCollectionsPage(queryPorts, { actor: { subjectId: 'owner' }, limit: 1 });
    rows.push(fact('newer-insert', '2026-07-25T04:00:00Z'));
    rows.push(fact('older-insert', '2026-07-25T01:30:00Z'));
    rows[2] = fact('c', '2026-07-25T05:00:00Z');
    const second = await getOwnedCollectionsPage(queryPorts, { actor: { subjectId: 'owner' }, cursor: first.page.nextCursor! });
    assert.deepEqual(first.items.map((row) => row.id), ['a']);
    assert.deepEqual(second.items.map((row) => row.id), ['b']);
    const third = await getOwnedCollectionsPage(queryPorts, { actor: { subjectId: 'owner' }, cursor: second.page.nextCursor! });
    assert.deepEqual(third.items.map((row) => row.id), ['older-insert']);
    assert.ok(![...second.items, ...third.items].some((row) => row.id === 'newer-insert' || row.id === 'c'));
  });

  test('fails closed for tamper, expiry, key rotation, cross-subject and cross-purpose replay', async () => {
    const rows = [fact('a', '2026-07-25T02:00:00Z'), fact('b', '2026-07-25T01:00:00Z')];
    const oldSigner = createProductOwnedCollectionsCursorSigner({ current: OLD });
    const first = await getOwnedCollectionsPage(ports(rows, oldSigner), { actor: { subjectId: 'owner-a' }, limit: 1, kind: 'bookmarks' });
    const token = first.page.nextCursor!;
    const rotated = createProductOwnedCollectionsCursorSigner({ current: CURRENT, previous: [{
      ...OLD, lastIssuedAt: '2026-07-26T00:00:00.000Z', retainUntil: '2026-07-26T01:00:00.000Z',
    }] });
    assert.equal((await getOwnedCollectionsPage(ports(rows, rotated), { actor: { subjectId: 'owner-a' }, cursor: token })).items[0]?.id, 'b');
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [tampered]) {
      await assert.rejects(() => getOwnedCollectionsPage(ports(rows, rotated), { actor: { subjectId: 'owner-a' }, cursor: bad }), OwnedCollectionsCursorError);
    }
    await assert.rejects(() => getOwnedCollectionsPage(ports(rows, rotated), { actor: { subjectId: 'owner-b' }, cursor: token }), OwnedCollectionsCursorError);
    const expiredPorts = { ...ports(rows, rotated), clock: { now: async () => new Date('2026-07-26T00:16:00.000Z') } };
    await assert.rejects(() => getOwnedCollectionsPage(expiredPorts, { actor: { subjectId: 'owner-a' }, cursor: token }), OwnedCollectionsCursorError);
    const unknown = createProductOwnedCollectionsCursorSigner({ current: { id: 'unknown', key: 'unrelated-owned-cursor-secret-material' } });
    await assert.rejects(() => getOwnedCollectionsPage(ports(rows, unknown), { actor: { subjectId: 'owner-a' }, cursor: token }), OwnedCollectionsCursorError);
    const editor = createProductEditorCursorSigner({ current: { id: CURRENT.id, key: CURRENT.key } }).sign({
      v: 1, purpose: 'product-editor-cursor', principalId: 'p', collectionId: 'c', limit: 1,
      comparatorVersion: 'v1', after: { parentKey: '', positionKey: '', nodeId: 'n' },
      contentRevision: 'c1', policyRevision: 'p1', snapshotId: 's',
      issuedAt: '2026-07-26T00:00:00.000Z', expiresAt: '2026-07-26T00:15:00.000Z',
    });
    await assert.rejects(() => getOwnedCollectionsPage(ports(rows, rotated), { actor: { subjectId: 'owner-a' }, cursor: editor }), OwnedCollectionsCursorError);
  });

  test('uses canonical encoding and enforces exact expiry and future-time boundaries', () => {
    const signer = createProductOwnedCollectionsCursorSigner({ current: CURRENT });
    const token = signer.sign({
      v: 1, purpose: 'product-owned-collections-cursor', subjectId: 'subject-a',
      filters: { kind: null, visibility: 'private' }, limit: 30,
      sort: 'updated_at:desc,id:asc', comparatorVersion: 'updated-desc-id-c-v1',
      after: { updatedAt: '2026-07-25T00:00:00.000Z', id: 'collection-a' },
      issuedAt: '2026-07-26T00:00:00.000Z', expiresAt: '2026-07-26T00:15:00.000Z',
    });
    const body = token.split('.')[1]!;
    const canonical = Buffer.from(body, 'base64url').toString('utf8');
    assert.equal(Buffer.from(canonical).toString('base64url'), body);
    assert.deepEqual(Object.keys(JSON.parse(canonical)), [...Object.keys(JSON.parse(canonical))].sort());
    assert.equal(signer.verify(token, new Date('2026-07-26T00:14:59.999Z')).subjectId, 'subject-a');
    assert.throws(() => signer.verify(token, new Date('2026-07-26T00:15:00.000Z')), OwnedCollectionsCursorError);

    const future = signer.sign({
      v: 1, purpose: 'product-owned-collections-cursor', subjectId: 'subject-a',
      filters: { kind: null, visibility: null }, limit: 30,
      sort: 'updated_at:desc,id:asc', comparatorVersion: 'updated-desc-id-c-v1',
      after: { updatedAt: '2026-07-25T00:00:00.000Z', id: 'collection-a' },
      issuedAt: '2026-07-26T00:00:00.001Z', expiresAt: '2026-07-26T00:15:00.001Z',
    });
    assert.throws(() => signer.verify(future, NOW), OwnedCollectionsCursorError);
  });

  test('retains rotated keys only for their issuance window and rejects unsafe keyrings', () => {
    assert.throws(() => createProductOwnedCollectionsCursorSigner({ current: CURRENT, previous: [{
      ...OLD, lastIssuedAt: '2026-07-26T00:00:00.000Z', retainUntil: '2026-07-26T00:14:59.999Z',
    }] }), /retention/u);
    assert.throws(() => createProductOwnedCollectionsCursorSigner({ current: CURRENT, previous: [{
      ...CURRENT, lastIssuedAt: '2026-07-26T00:00:00.000Z', retainUntil: '2026-07-26T00:15:00.000Z',
    }] }), /unique/u);

    const oldSigner = createProductOwnedCollectionsCursorSigner({ current: OLD });
    const token = oldSigner.sign({
      v: 1, purpose: 'product-owned-collections-cursor', subjectId: 'subject-a',
      filters: { kind: null, visibility: null }, limit: 30,
      sort: 'updated_at:desc,id:asc', comparatorVersion: 'updated-desc-id-c-v1',
      after: { updatedAt: '2026-07-25T00:00:00.000Z', id: 'collection-a' },
      issuedAt: '2026-07-26T00:00:00.000Z', expiresAt: '2026-07-26T00:15:00.000Z',
    });
    const rotated = createProductOwnedCollectionsCursorSigner({ current: CURRENT, previous: [{
      ...OLD, lastIssuedAt: '2026-07-26T00:00:00.000Z', retainUntil: '2026-07-26T00:15:00.000Z',
    }] });
    assert.equal(rotated.verify(token, new Date('2026-07-26T00:14:59.999Z')).keyVersion, OLD.id);
    assert.throws(() => rotated.verify(token, new Date('2026-07-26T00:15:00.000Z')), OwnedCollectionsCursorError);
  });

  test('destroys retained key material and fails closed after signer shutdown', () => {
    const signer = createProductOwnedCollectionsCursorSigner({ current: CURRENT, previous: [{
      ...OLD, lastIssuedAt: '2026-07-26T00:00:00.000Z', retainUntil: '2026-07-26T00:15:00.000Z',
    }] });
    const payload = {
      v: 1 as const, purpose: 'product-owned-collections-cursor' as const, subjectId: 'subject-a',
      filters: { kind: null, visibility: null }, limit: 30,
      sort: 'updated_at:desc,id:asc' as const, comparatorVersion: 'updated-desc-id-c-v1' as const,
      after: { updatedAt: '2026-07-25T00:00:00.000Z', id: 'collection-a' },
      issuedAt: '2026-07-26T00:00:00.000Z', expiresAt: '2026-07-26T00:15:00.000Z',
    };
    const token = signer.sign(payload);
    signer.destroy();
    signer.destroy();
    assert.throws(() => signer.sign(payload), OwnedCollectionsCursorError);
    assert.throws(() => signer.verify(token, NOW), OwnedCollectionsCursorError);
  });

  test('owned list SQL does not inline count(*)', async () => {
    const source = await readFile(
      new URL('../../../src/infrastructure/collections/owned-collections-query.ts', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /count\(\*\)/i);
  });
});
