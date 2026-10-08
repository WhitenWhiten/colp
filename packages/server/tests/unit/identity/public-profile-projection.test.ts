import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  type PublicProfileFactsReadPort,
} from '../../../src/modules/identity/index.js';
import {
  PublicProfileNotFoundError,
  PublicProfileCursorError,
  PUBLIC_PROFILE_CURSOR_TTL_MS,
  getPublicProfileProjection,
} from '../../../src/bootstrap/public-profile-projection.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
} from '../../../src/modules/publication/index.js';

const records = Object.freeze([
  collection('public-new', '2026-07-24T03:00:00.000Z'),
  collection('public-A', '2026-07-24T02:00:00.000Z'),
  collection('public-a', '2026-07-24T02:00:00.000Z'),
  collection('public-old', '2026-07-24T01:00:00.000Z'),
]);

function collection(id: string, updatedAt: string): PublicationDirectoryRecord {
  return Object.freeze({
    id,
    ownerSubjectId: 'subject-alice',
    title: `Title ${id}`,
    summary: id === 'public-old' ? null : `Summary ${id}`,
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: `slug-${id.toLowerCase()}`,
    tags: Object.freeze([]),
    language: null,
    nodeCount: 2,
    updatedAt,
    orderingUpdatedAtMicros: String(BigInt(Date.parse(updatedAt)) * 1000n),
    protectedAuthorized: false,
  });
}

function ports(overrides: {
  readonly avatarUrl?: string | null;
  readonly facts?: PublicProfileFactsReadPort;
  readonly collections?: PublicationDirectoryReadPort;
} = {}) {
  const facts: PublicProfileFactsReadPort = overrides.facts ?? {
    async findByCanonicalHandle(handle) {
      if (handle !== 'alice') return null;
      return Object.freeze({
        profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
        handle: 'alice',
        displayName: 'Same display name',
        avatarUrl: overrides.avatarUrl === undefined ? 'https://cdn.example.test/avatar.png' : overrides.avatarUrl,
        about: '',
        ownerSubjectId: 'subject-alice',
      });
    },
  };
  const collections: PublicationDirectoryReadPort = overrides.collections ?? {
    async loadPage(request) {
      assert.equal(request.principal, 'anonymous');
      assert.deepEqual(request.filter, { creator: 'subject-alice' });
      let start = 0;
      if (request.after) {
        const index = records.findIndex((row) =>
          row.orderingUpdatedAtMicros === request.after?.orderingUpdatedAtMicros
          && createHash('sha256').update(row.id).digest('hex').slice(0, 32) === request.after.idLocator);
        start = index + 1;
      }
      return records.slice(start, start + request.limit + 1);
    },
  };
  return {
    profiles: facts,
    collections,
    cursors: createPublicationCursorKeyring({
      active: { id: 'profile-v1', secret: Buffer.alloc(32, 71).toString('base64') },
      retained: [],
    }),
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  };
}

test('canonicalizes ASCII case and percent encoding exactly once while rejecting Unicode boundaries', async () => {
  for (const handle of ['alice', 'ALICE', '%61lice', '%41LICE']) {
    const queryPorts = ports();
    try {
      const result = await getPublicProfileProjection(queryPorts, { handle, limit: 2 });
      assert.equal(result.profile.handle, 'alice');
    } finally {
      queryPorts.cursors.destroy();
    }
  }

  for (const handle of ['%2561lice', 'álîce', '%C3%A1lice', '%', '%2F', '.', '..', 'alice/bob']) {
    const queryPorts = ports();
    try {
      await assert.rejects(
        () => getPublicProfileProjection(queryPorts, { handle }),
        PublicProfileNotFoundError,
      );
    } finally {
      queryPorts.cursors.destroy();
    }
  }
});

test('looks up by canonical handle rather than display name and exposes only the minimal immutable DTO', async () => {
  const observed: string[] = [];
  const queryPorts = ports({
    facts: {
      async findByCanonicalHandle(handle) {
        observed.push(handle);
        if (handle === 'same-display-name') return null;
        return Object.freeze({
          profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
          handle: 'alice', displayName: 'Same display name', avatarUrl: null, about: '',
          ownerSubjectId: 'subject-alice',
        });
      },
    },
  });
  try {
    const result = await getPublicProfileProjection(queryPorts, { handle: 'Alice', limit: 2 });
    assert.deepEqual(observed, ['alice']);
    assert.deepEqual(Object.keys(result.profile).sort(), ['about', 'avatarUrl', 'displayName', 'handle', 'profileId']);
    assert.equal(result.profile.profileId, 'IiIiIiIiIiIiIiIiIiIiIg');
    assert.deepEqual(Object.keys(result.collections[0]!).sort(), [
      'id', 'kind', 'slug', 'summary', 'title', 'updatedAt',
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.profile), true);
    assert.equal(Object.isFrozen(result.collections), true);
    assert.equal(Object.isFrozen(result.collections[0]!), true);
    assert.equal('ownerSubjectId' in result.profile, false);
    assert.equal('accountId' in result.profile, false);
    assert.equal('email' in result.profile, false);
    assert.equal('revision' in result.collections[0]!, false);

    await assert.rejects(
      () => getPublicProfileProjection(queryPorts, { handle: 'Same-Display-Name' }),
      PublicProfileNotFoundError,
    );
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('preserves an empty display name and accepts only standard-parser absolute https avatar URLs', async () => {
  for (const [avatarUrl, expected] of [
    ['https://cdn.example.test/a b.png', 'https://cdn.example.test/a%20b.png'],
    ['HTTPS://CDN.EXAMPLE.TEST/avatar.png', 'https://cdn.example.test/avatar.png'],
    [null, null],
    ['', null],
    ['http://cdn.example.test/avatar.png', null],
    ['javascript:alert(1)', null],
    ['//cdn.example.test/avatar.png', null],
    ['https://user:secret@cdn.example.test/avatar.png', null],
    ['not a URL', null],
  ] as const) {
    const queryPorts = ports({
      facts: {
        async findByCanonicalHandle() {
          return Object.freeze({
            profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
            handle: 'alice', displayName: '', avatarUrl,
            about: '',
            ownerSubjectId: 'subject-alice',
          });
        },
      },
    });
    try {
      const result = await getPublicProfileProjection(queryPorts, { handle: 'alice' });
      assert.equal(result.profile.displayName, '');
      assert.equal(result.profile.avatarUrl, expected);
      assert.equal(result.profile.about, '');
    } finally {
      queryPorts.cursors.destroy();
    }
  }
});

test('projects a stored about onto the public DTO without exposing owner facts', async () => {
  const queryPorts = ports({
    facts: {
      async findByCanonicalHandle() {
        return Object.freeze({
          profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
          handle: 'alice', displayName: 'Alice', avatarUrl: null,
          about: 'I collect bookmarks.',
          ownerSubjectId: 'subject-alice',
        });
      },
    },
  });
  try {
    const result = await getPublicProfileProjection(queryPorts, { handle: 'alice' });
    assert.equal(result.profile.about, 'I collect bookmarks.');
    assert.equal('ownerSubjectId' in result.profile, false);
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('conceals missing, deleted, and non-public profiles with the same application error', async () => {
  for (const reason of ['missing', 'deleted', 'private']) {
    const queryPorts = ports({ facts: { async findByCanonicalHandle() { return null; } } });
    try {
      await assert.rejects(
        () => getPublicProfileProjection(queryPorts, { handle: reason }),
        (error: unknown) => {
          assert.ok(error instanceof PublicProfileNotFoundError);
          assert.equal(error.code, 'resource_not_found');
          assert.equal(error.message, 'Public Profile was not found.');
          return true;
        },
      );
    } finally {
      queryPorts.cursors.destroy();
    }
  }
});

test('requests only publication-authorized anonymous collections and traverses a strict stable keyset', async () => {
  const queryPorts = ports();
  try {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await getPublicProfileProjection(queryPorts, {
        handle: 'ALICE', limit: 1, ...(cursor ? { cursor } : {}),
      });
      ids.push(...page.collections.map((item) => item.id));
      cursor = page.page.cursor ?? undefined;
    } while (cursor);
    assert.deepEqual(ids, records.map((row) => row.id));
    assert.equal(new Set(ids).size, records.length);
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('profile cursor has an independent purpose and binds canonical handle, page size, and comparator', async () => {
  const queryPorts = ports();
  try {
    const first = await getPublicProfileProjection(queryPorts, { handle: 'Alice', limit: 1 });
    assert.ok(first.page.cursor);
    const directoryCursor = queryPorts.cursors.directory.sign({
      resourceId: 'https://colp.example/colp/v0.1/collections', principal: 'anonymous', filterDigest: 'x', sort: 'x', limit: 1,
      protocolVersion: '0.1', nextPosition: 'x',
    });
    const productCursor = queryPorts.cursors.product.sign({
      purpose: 'product-public-page', slug: 'alice', limit: 1, nextPosition: 'x',
    });
    const cursorParts = first.page.cursor!.split('.');
    const mac = cursorParts[2]!;
    const tamperedCursor = `${cursorParts[0]}.${cursorParts[1]}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
    for (const input of [
      { handle: 'bob', limit: 1, cursor: first.page.cursor! },
      { handle: 'alice', limit: 2, cursor: first.page.cursor! },
      { handle: 'alice', limit: 1, cursor: directoryCursor },
      { handle: 'alice', limit: 1, cursor: productCursor },
      { handle: 'alice', limit: 1, cursor: tamperedCursor },
    ]) {
      await assert.rejects(
        () => getPublicProfileProjection(queryPorts, input),
        PublicProfileCursorError,
      );
    }
  } finally {
    queryPorts.cursors.destroy();
  }
});

test('profile cursor expires and survives configured key rotation before expiry', async () => {
  const oldSecret = Buffer.alloc(32, 81).toString('base64');
  const base = ports();
  const oldCursors = createPublicationCursorKeyring({
    active: { id: 'old-profile', secret: oldSecret }, retained: [],
  });
  const oldPorts = { ...base, cursors: oldCursors };
  const first = await getPublicProfileProjection(oldPorts, { handle: 'alice', limit: 1 });
  assert.ok(first.page.cursor);
  const rotated = createPublicationCursorKeyring({
    active: { id: 'new-profile', secret: Buffer.alloc(32, 82).toString('base64') },
    retained: [{ id: 'old-profile', secret: oldSecret }],
  });
  try {
    await assert.doesNotReject(() => getPublicProfileProjection(
      { ...base, cursors: rotated },
      { handle: 'alice', limit: 1, cursor: first.page.cursor! },
    ));
    const originalNow = Date.now;
    Date.now = () => originalNow() + PUBLIC_PROFILE_CURSOR_TTL_MS + 1;
    try {
      await assert.rejects(
        () => getPublicProfileProjection(
          { ...base, cursors: rotated },
          { handle: 'alice', limit: 1, cursor: first.page.cursor! },
        ),
        PublicProfileCursorError,
      );
    } finally {
      Date.now = originalNow;
    }
  } finally {
    base.cursors.destroy();
    oldCursors.destroy();
    rotated.destroy();
  }
});
