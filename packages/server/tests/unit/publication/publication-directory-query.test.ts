import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createPublicationCursorKeyring,
  getPublicationDirectoryPage,
  PublicationDirectoryCursorError,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
} from '../../../src/modules/publication/index.js';

const rows: readonly (PublicationDirectoryRecord & { discoverable: boolean })[] = [
  record('public-new', '2026-07-24T03:00:00.000Z', 'public', true),
  record('protected-member', '2026-07-24T02:00:00.000Z', 'protected', true),
  record('unlisted', '2026-07-24T01:00:00.000Z', 'public', false),
  record('private', '2026-07-24T00:00:00.000Z', 'protected', false),
];

function record(
  id: string,
  updatedAt: string,
  visibility: PublicationDirectoryRecord['visibility'],
  discoverable: boolean,
): PublicationDirectoryRecord & { discoverable: boolean } {
  return {
    id, ownerSubjectId: 'owner', title: id, summary: `summary ${id}`, kind: 'bookmarks',
    visibility, publicationSlug: id, tags: ['tag'], language: 'en', nodeCount: 2,
    updatedAt, orderingUpdatedAtMicros: String(BigInt(Date.parse(updatedAt)) * 1000n),
    protectedAuthorized: id === 'protected-member', discoverable,
  };
}

const reads: PublicationDirectoryReadPort = {
  async loadPage(request) {
    let selected = rows.filter((row) => row.discoverable && (
      row.visibility === 'public'
      || (request.principal !== 'anonymous' && row.protectedAuthorized)
    ));
    if (request.filter.q) selected = selected.filter((row) => row.title.includes(request.filter.q!));
    if (request.after) {
      const index = selected.findIndex((row) => row.orderingUpdatedAtMicros === request.after?.orderingUpdatedAtMicros);
      selected = selected.slice(index + 1);
    }
    return selected.slice(0, request.limit + 1);
  },
};

function ports() {
  return {
    reads,
    origin: 'https://known.example',
    cursors: createPublicationCursorKeyring({
      active: { id: 'directory-v1', secret: Buffer.alloc(32, 23).toString('base64') }, retained: [],
    }),
  };
}

test('anonymous directory enumerates only discoverable public collections', async () => {
  const result = await getPublicationDirectoryPage(ports(), {
    principal: { kind: 'anonymous' }, query: { limit: 10 },
  });
  assert.deepEqual(result.directory.collections.map((item) => item.id), ['public-new']);
  assert.equal(result.directory.nextCursor, null);
  assert.equal(result.projection, 'public');
});

test('member directory adds authorized protected collections with stable keyset paging', async () => {
  const queryPorts = ports();
  const principal = { kind: 'account', principalId: 'account', subjectId: 'member' } as const;
  const first = await getPublicationDirectoryPage(queryPorts, { principal, query: { limit: 1 } });
  assert.deepEqual(first.directory.collections.map((item) => item.id), ['public-new']);
  assert.ok(first.nextCursor);
  const second = await getPublicationDirectoryPage(queryPorts, {
    principal, query: { limit: 1, cursor: first.nextCursor },
  });
  assert.deepEqual(second.directory.collections.map((item) => item.id), ['protected-member']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.projection, 'member');
});

test('cursor binds principal, canonical filter, limit, sort, and protocol scope', async () => {
  const queryPorts = ports();
  const principal = { kind: 'account', principalId: 'account', subjectId: 'member' } as const;
  const first = await getPublicationDirectoryPage(queryPorts, {
    principal, query: { limit: 1, q: ' PUBLIC ' },
  });
  assert.equal(first.nextCursor, null);

  const paged = await getPublicationDirectoryPage(queryPorts, { principal, query: { limit: 1 } });
  for (const input of [
    { principal: { kind: 'anonymous' } as const, query: { limit: 1, cursor: paged.nextCursor! } },
    { principal, query: { limit: 2, cursor: paged.nextCursor! } },
    { principal, query: { limit: 1, q: 'different', cursor: paged.nextCursor! } },
  ]) {
    await assert.rejects(() => getPublicationDirectoryPage(queryPorts, input), PublicationDirectoryCursorError);
  }
});

test('strictly validates and canonicalizes updatedSince while allowing canonical-equivalent cursor reuse', async () => {
  const queryPorts = ports();
  const principal = { kind: 'account', principalId: 'account', subjectId: 'member' } as const;
  const first = await getPublicationDirectoryPage(queryPorts, {
    principal, query: { limit: 1, updatedSince: '2026-07-24T03:30:00.000000+01:30' },
  });
  assert.ok(first.nextCursor);
  const second = await getPublicationDirectoryPage(queryPorts, {
    principal, query: { limit: 1, updatedSince: '2026-07-24T02:00:00Z', cursor: first.nextCursor },
  });
  assert.deepEqual(second.directory.collections.map((item) => item.id), ['protected-member']);

  for (const updatedSince of [
    '2026-07-24',
    '2026-02-30T00:00:00Z',
    '2026-07-24T24:00:00Z',
    '2026-07-24T00:00:00',
    '2026-07-24T00:00:00-00:00',
  ]) {
    await assert.rejects(
      () => getPublicationDirectoryPage(queryPorts, { principal, query: { updatedSince } }),
      TypeError,
    );
  }
  await assert.doesNotReject(() => getPublicationDirectoryPage(queryPorts, {
    principal, query: { updatedSince: '2026-07-24T00:00:00.000001Z' },
  }));
});

test('cursor requires a present non-empty string and survives rotation but rejects tampering', async () => {
  const oldSecret = Buffer.alloc(32, 31).toString('base64');
  const oldPorts = { ...ports(), cursors: createPublicationCursorKeyring({ active: { id: 'old', secret: oldSecret }, retained: [] }) };
  const principal = { kind: 'account', principalId: 'account', subjectId: 'member' } as const;
  const first = await getPublicationDirectoryPage(oldPorts, { principal, query: { limit: 1 } });
  assert.ok(first.nextCursor);
  const rotated = {
    ...ports(),
    cursors: createPublicationCursorKeyring({
      active: { id: 'new', secret: Buffer.alloc(32, 32).toString('base64') },
      retained: [{ id: 'old', secret: oldSecret }],
    }),
  };
  await assert.doesNotReject(() => getPublicationDirectoryPage(rotated, {
    principal, query: { limit: 1, cursor: first.nextCursor! },
  }));
  const tampered = `${first.nextCursor!.slice(0, -1)}${first.nextCursor!.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(
    () => getPublicationDirectoryPage(rotated, { principal, query: { limit: 1, cursor: tampered } }),
    PublicationDirectoryCursorError,
  );
  for (const cursor of ['', 1] as readonly unknown[]) {
    await assert.rejects(
      () => getPublicationDirectoryPage(rotated, { principal, query: { cursor } as never }),
      TypeError,
    );
  }
  oldPorts.cursors.destroy();
  rotated.cursors.destroy();
});
