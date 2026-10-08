import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  IDENTITY_APPLICATION_NOW as NOW,
  createIdentityApplicationHarness as createHarness,
} from '../../support/identity-application-memory.js';
import {
  BARE_HANDLE_ATTEMPTS,
  HANDLE_ADJECTIVES,
  HANDLE_CLAIM_MAX,
  HANDLE_NOUNS,
  HANDLE_WORD_MAX,
  IdentityError,
  assertClaimableHandle,
  assertValidHandle,
  claimHandle,
  ensureAccountHandle,
  generateAutomaticHandle,
  type Account,
  type IdentityPorts,
} from '../../../src/modules/identity/index.js';

/**
 * Canonical stored form, copied from the profile_handles CHECK constraint in
 * migrations/202607242200_public_profile_projection.ts. Anything the generator
 * mints has to survive this or the insert fails at the database.
 */
const CANONICAL_HANDLE = /^[a-z0-9._~-]{1,64}$/u;

/** Longest possible mint: two max-length words, a separator, a two-digit suffix. */
const LONGEST_GENERATED = HANDLE_WORD_MAX * 2 + 1 + 3;

function seedAccount(
  state: ReturnType<typeof createHarness>['state'],
  id: string,
): Account {
  const account: Account = {
    id,
    subjectId: `${id}-subject`,
    status: 'active',
    email: `${id}@example.test`,
    securityEpoch: 0n,
    createdAt: NOW,
    deletedAt: null,
  };
  state.accounts.set(id, account);
  return account;
}

describe('automatic handle vocabulary', () => {
  const lists: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['adjectives', HANDLE_ADJECTIVES],
    ['nouns', HANDLE_NOUNS],
  ];

  test('every word is short lowercase ASCII', () => {
    for (const [name, words] of lists) {
      for (const word of words) {
        assert.match(word, /^[a-z]{3,}$/u, `${name}: ${word} must be lowercase letters`);
        assert.ok(
          word.length <= HANDLE_WORD_MAX,
          `${name}: ${word} is longer than HANDLE_WORD_MAX (${HANDLE_WORD_MAX})`,
        );
      }
    }
  });

  test('no word repeats within or across the lists', () => {
    for (const [name, words] of lists) {
      assert.equal(new Set(words).size, words.length, `${name} contains a duplicate`);
    }
    const shared = HANDLE_ADJECTIVES.filter((word) => HANDLE_NOUNS.includes(word));
    assert.deepEqual(shared, [], 'a shared word would let a handle repeat itself');
  });

  test('the vocabulary is wide enough that early accounts get a bare pair', () => {
    // The bare space is sized once, here: a shrunken list would quietly push
    // accounts onto the suffixed form without anything else failing.
    assert.ok(
      HANDLE_ADJECTIVES.length * HANDLE_NOUNS.length >= 40_000,
      'bare adjective-noun space must stay above 40k combinations',
    );
  });
});

describe('generateAutomaticHandle', () => {
  test('mints a readable pair that the database and the claim policy accept', () => {
    for (let i = 0; i < 500; i += 1) {
      const handle = generateAutomaticHandle();
      assert.match(handle, /^[a-z]+-[a-z]+$/u);
      assert.match(handle, CANONICAL_HANDLE);
      assert.equal(assertValidHandle(handle), handle);
      assert.equal(assertClaimableHandle(handle), handle);
    }
  });

  test('appends exactly two digits when asked for the collision form', () => {
    for (let i = 0; i < 500; i += 1) {
      const handle = generateAutomaticHandle({ withSuffix: true });
      assert.match(handle, /^[a-z]+-[a-z]+-\d{2}$/u);
      assert.match(handle, CANONICAL_HANDLE);
      assert.equal(assertClaimableHandle(handle), handle);
    }
  });

  test('stays far inside the claim bound in both forms', () => {
    assert.ok(
      LONGEST_GENERATED <= HANDLE_CLAIM_MAX,
      `longest mint (${LONGEST_GENERATED}) must fit HANDLE_CLAIM_MAX (${HANDLE_CLAIM_MAX})`,
    );
    for (let i = 0; i < 500; i += 1) {
      assert.ok(generateAutomaticHandle().length <= HANDLE_WORD_MAX * 2 + 1);
      assert.ok(generateAutomaticHandle({ withSuffix: true }).length <= LONGEST_GENERATED);
    }
  });

  test('does not mint the retired opaque format', () => {
    for (let i = 0; i < 200; i += 1) {
      const handle = generateAutomaticHandle({ withSuffix: i % 2 === 0 });
      assert.ok(!handle.startsWith('u-'), `${handle} still carries the opaque prefix`);
      assert.ok(!handle.includes('_'), `${handle} carries base64url punctuation`);
    }
  });

  test('draws from the whole vocabulary rather than a fixed pair', () => {
    const minted = new Set<string>();
    for (let i = 0; i < 300; i += 1) minted.add(generateAutomaticHandle());
    assert.ok(minted.size > 250, `expected spread across the lists, got ${minted.size} distinct`);
  });
});

describe('assertClaimableHandle', () => {
  test('accepts an ordinary handle up to the bound', () => {
    assert.equal(assertClaimableHandle('mira'), 'mira');
    assert.equal(assertClaimableHandle('a'.repeat(HANDLE_CLAIM_MAX)).length, HANDLE_CLAIM_MAX);
  });

  test('rejects a handle past the claim bound', () => {
    assert.throws(
      () => assertClaimableHandle('a'.repeat(HANDLE_CLAIM_MAX + 1)),
      (error: unknown) => error instanceof IdentityError && error.code === 'invalid_handle',
    );
  });

  test('rejects handles that would impersonate the product or its operators', () => {
    for (const reserved of ['admin', 'support', 'known', 'noreply', 'security']) {
      assert.throws(
        () => assertClaimableHandle(reserved),
        (error: unknown) => error instanceof IdentityError && error.code === 'invalid_handle',
        `${reserved} must not be claimable`,
      );
    }
  });

  test('leaves a reserved word usable as part of a longer handle', () => {
    assert.equal(assertClaimableHandle('admin-notes'), 'admin-notes');
  });
});

describe('ensureAccountHandle', () => {
  test('reserves a readable pair for a fresh account', async () => {
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-fresh');

    const reserved = await ensureAccountHandle(ports, 'acct-fresh');

    assert.match(reserved.handle, /^[a-z]+-[a-z]+$/u);
    assert.equal(reserved.accountId, 'acct-fresh');
    assert.ok(state.handles.has(reserved.handle));
  });

  test('falls back to the suffixed form once bare pairs keep colliding', async () => {
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-collide');
    const attempted: string[] = [];
    const wrapped: IdentityPorts = {
      ...ports,
      handles: {
        ...ports.handles,
        async tryInsert(row) {
          attempted.push(row.handle);
          // Reject every bare candidate so the loop has to reach the suffix.
          if (attempted.length <= BARE_HANDLE_ATTEMPTS) return false;
          return ports.handles.tryInsert(row);
        },
      },
    };

    const reserved = await ensureAccountHandle(wrapped, 'acct-collide');

    assert.equal(attempted.length, BARE_HANDLE_ATTEMPTS + 1);
    for (const bare of attempted.slice(0, BARE_HANDLE_ATTEMPTS)) {
      assert.match(bare, /^[a-z]+-[a-z]+$/u);
    }
    assert.match(reserved.handle, /^[a-z]+-[a-z]+-\d{2}$/u);
  });

  test('never derives the handle from the account identifiers', async () => {
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-private');

    const reserved = await ensureAccountHandle(ports, 'acct-private');

    assert.ok(!reserved.handle.includes('acct'));
    assert.ok(!reserved.handle.includes('example'));
  });
});

describe('claimHandle under the current policy', () => {
  test('rejects a new handle past the claim bound', async () => {
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-long');

    await assert.rejects(
      () => claimHandle(ports, { accountId: 'acct-long', handle: 'x'.repeat(HANDLE_CLAIM_MAX + 1) }),
      (error: unknown) => error instanceof IdentityError && error.code === 'invalid_handle',
    );
  });

  test('rejects a new reserved handle regardless of case', async () => {
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-reserved');

    await assert.rejects(
      () => claimHandle(ports, { accountId: 'acct-reserved', handle: 'Support' }),
      (error: unknown) => error instanceof IdentityError && error.code === 'invalid_handle',
    );
  });

  test('lets an account re-submit the longer handle it already holds', async () => {
    // Handles minted by the retired scheme run to 34 characters. Saving the
    // rest of the profile must not force those accounts to rename.
    const legacy = `u-${'a'.repeat(32)}`;
    assert.ok(legacy.length > HANDLE_CLAIM_MAX);
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-legacy');
    state.handles.set(legacy, { handle: legacy, accountId: 'acct-legacy', createdAt: NOW });

    const kept = await claimHandle(ports, { accountId: 'acct-legacy', handle: legacy });

    assert.equal(kept.handle, legacy);
    assert.equal(state.handles.size, 1);
  });

  test('still applies the bound when a legacy holder picks a different handle', async () => {
    const legacy = `u-${'b'.repeat(32)}`;
    const { state, ports } = createHarness();
    seedAccount(state, 'acct-rename');
    state.handles.set(legacy, { handle: legacy, accountId: 'acct-rename', createdAt: NOW });

    await assert.rejects(
      () => claimHandle(ports, { accountId: 'acct-rename', handle: `u-${'c'.repeat(32)}` }),
      (error: unknown) => error instanceof IdentityError && error.code === 'invalid_handle',
    );
    const renamed = await claimHandle(ports, { accountId: 'acct-rename', handle: 'quiet-fern' });
    assert.equal(renamed.handle, 'quiet-fern');
    assert.equal(state.handles.has(legacy), false, 'the old handle is released on rename');
  });
});
