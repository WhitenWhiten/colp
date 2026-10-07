import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicProfileFactsReadPort } from '../../../src/infrastructure/identity/index.js';
import { ABOUT_MAX } from '../../../src/modules/identity/index.js';

test('identity public facts query uses canonical handle index and returns only internal aggregation facts', async () => {
  const calls: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  const runtime = {
    pool: {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        return { rows: [{
          profile_id: 'IiIiIiIiIiIiIiIiIiIiIg',
          handle: 'alice', display_name: 'Alice', avatar_url: 'https://cdn.example/a.png',
          about: '',
          owner_subject_id: 'subject-alice',
        }] };
      },
    } as unknown as DatabaseRuntime['pool'],
  };
  const result = await createPostgresPublicProfileFactsReadPort(runtime)
    .findByCanonicalHandle('alice');
  assert.deepEqual(result, {
    profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
    handle: 'alice', displayName: 'Alice', avatarUrl: 'https://cdn.example/a.png',
    about: '',
    ownerSubjectId: 'subject-alice',
  });
  const query = calls[0]!;
  assert.deepEqual(query.values, ['alice']);
  assert.match(query.text, /lower\(h\.handle\).*collate "C"/iu);
  assert.match(query.text, /a\.status = 'active'/u);
  assert.match(query.text, /a\.deleted_at is null/u);
  assert.match(query.text, /p\.account_id/u);
  assert.match(query.text, /p\.account_id as profile_id/u);
  assert.match(query.text, /p\.about/u);
  assert.doesNotMatch(query.text, /collections|nodes|collection_members|publication_/u);
  assert.equal(Object.isFrozen(result), true);
});

test('identity public facts resolve the same safe projection by internal owner subject without exposing it', async () => {
  const calls: Array<{ readonly text: string; readonly values?: readonly unknown[] }> = [];
  const runtime = {
    pool: {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        return { rows: [{
          profile_id: 'IiIiIiIiIiIiIiIiIiIiIg', handle: 'alice', display_name: 'Alice',
          avatar_url: null, about: '', owner_subject_id: 'subject-alice',
        }] };
      },
    } as unknown as DatabaseRuntime['pool'],
  };
  const result = await createPostgresPublicProfileFactsReadPort(runtime)
    .findByOwnerSubjectId('subject-alice');
  assert.equal(result?.profileId, 'IiIiIiIiIiIiIiIiIiIiIg');
  assert.equal(result?.ownerSubjectId, 'subject-alice');
  assert.deepEqual(calls[0]?.values, ['subject-alice']);
  assert.match(calls[0]!.text, /a\.subject_id = \$1/u);
  assert.match(calls[0]!.text, /a\.status = 'active'/u);
  assert.match(calls[0]!.text, /a\.deleted_at is null/u);
});

test('identity public facts query returns null for a concealed profile and validates canonical input', async () => {
  let calls = 0;
  const runtime = {
    pool: {
      async query() { calls += 1; return { rows: [] }; },
    } as unknown as DatabaseRuntime['pool'],
  };
  const read = createPostgresPublicProfileFactsReadPort(runtime);
  assert.equal(await read.findByCanonicalHandle('missing'), null);
  await assert.rejects(() => read.findByCanonicalHandle('Alice'), TypeError);
  await assert.rejects(() => read.findByCanonicalHandle('%61lice'), TypeError);
  await assert.rejects(() => read.findByCanonicalHandle('álîce'), TypeError);
  assert.equal(calls, 1);
});

test('identity public facts fail closed on a stored avatar URL that violates the HttpsUrl contract', async () => {
  // FIX-M-003: a legacy row whose avatar_url slipped past the old write path
  // (javascript:, http:, userinfo, fragment, non-default port) must never be
  // served to anonymous readers. The read adapter downgrades the unsafe value
  // to null on both lookups while keeping the otherwise-valid profile facts
  // reachable, and the projection layer keeps its own safe-avatar fallback.
  for (const avatarUrl of [
    'javascript:alert(1)',
    'http://cdn.example/a.png',
    '//cdn.example/a.png',
    'https://user:pass@cdn.example/a.png',
    'https://cdn.example/a.png#frag',
    'https://cdn.example/a.png#',
    'https://cdn.example:8443/a.png',
    'https://cdn.example/' + 'a'.repeat(2049),
  ]) {
    const runtime = {
      pool: {
        async query() {
          return { rows: [{
            profile_id: 'IiIiIiIiIiIiIiIiIiIiIg',
            handle: 'alice', display_name: 'Alice', avatar_url: avatarUrl,
            owner_subject_id: 'subject-alice',
          }] };
        },
      },
    } as unknown as DatabaseRuntime['pool'];
    const read = createPostgresPublicProfileFactsReadPort(runtime);
    const canonical = await read.findByCanonicalHandle('alice');
    assert.notEqual(canonical, null, `canonical lookup must keep the profile for ${avatarUrl}`);
    assert.equal(canonical?.avatarUrl, null, `canonical lookup must not serve ${avatarUrl}`);
    const owner = await read.findByOwnerSubjectId('subject-alice');
    assert.notEqual(owner, null, `owner lookup must keep the profile for ${avatarUrl}`);
    assert.equal(owner?.avatarUrl, null, `owner lookup must not serve ${avatarUrl}`);
  }
});

test('identity public facts sanitize invalid about values without concealing the profile', async () => {
  for (const about of [undefined, 12, '   ', 'x'.repeat(ABOUT_MAX + 1)]) {
    const runtime = {
      pool: {
        async query() {
          return { rows: [{
            profile_id: 'IiIiIiIiIiIiIiIiIiIiIg',
            handle: 'alice', display_name: 'Alice', avatar_url: null,
            about, owner_subject_id: 'subject-alice',
          }] };
        },
      },
    } as unknown as DatabaseRuntime['pool'];
    const read = createPostgresPublicProfileFactsReadPort(runtime);
    const canonical = await read.findByCanonicalHandle('alice');
    assert.notEqual(canonical, null, `canonical lookup must keep the profile for about=${String(about)}`);
    assert.equal(canonical?.about, '', `canonical lookup must sanitize about=${String(about)}`);
  }

  const valid = {
    pool: {
      async query() {
        return { rows: [{
          profile_id: 'IiIiIiIiIiIiIiIiIiIiIg',
          handle: 'alice', display_name: 'Alice', avatar_url: null,
          about: 'I collect bookmarks.', owner_subject_id: 'subject-alice',
        }] };
      },
    },
  } as unknown as DatabaseRuntime['pool'];
  const facts = await createPostgresPublicProfileFactsReadPort(valid)
    .findByCanonicalHandle('alice');
  assert.equal(facts?.about, 'I collect bookmarks.');
});
