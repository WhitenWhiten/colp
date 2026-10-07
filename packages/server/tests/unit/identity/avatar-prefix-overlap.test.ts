import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { assertAvatarPrefixesDoNotOverlap } from '../../../src/modules/identity/index.js';

const AVATAR_PREFIX = 'avatar/';

/** Asserts the pure guard rejects a prefix triple with an overlap RangeError. */
function expectOverlapRejected(avatarPrefix: string, livePrefix: string, probePrefix: string): void {
  assert.throws(
    () => assertAvatarPrefixesDoNotOverlap(avatarPrefix, livePrefix, probePrefix),
    (error: unknown) =>
      error instanceof RangeError && /must not overlap/u.test(error.message),
    `expected overlap rejection for avatar=${JSON.stringify(avatarPrefix)} live=${JSON.stringify(livePrefix)} probe=${JSON.stringify(probePrefix)}`,
  );
}

describe('assertAvatarPrefixesDoNotOverlap', () => {
  test('accepts non-overlapping avatar and attachments prefixes', () => {
    const cases = [
      ['avatar/', 'attachments/live/', 'attachments/probe/'],
      ['avatar/', 'attachments/live/2026/', 'attachments/probe/2026/'],
      ['avatar/', 'attachments/live', 'attachments/probe'],
      ['avatars/', 'attachments/live/', 'attachments/probe/'],
      ['avatar/', 'x-attachments/live/', 'attachments/probe/'],
    ] as const;
    for (const [avatarPrefix, livePrefix, probePrefix] of cases) {
      assert.doesNotThrow(
        () => assertAvatarPrefixesDoNotOverlap(avatarPrefix, livePrefix, probePrefix),
        `expected no overlap for avatar=${JSON.stringify(avatarPrefix)} live=${JSON.stringify(livePrefix)} probe=${JSON.stringify(probePrefix)}`,
      );
    }
  });

  test('rejects exact equality with the live or probe prefix', () => {
    expectOverlapRejected(AVATAR_PREFIX, 'avatar/', 'attachments/probe/');
    expectOverlapRejected(AVATAR_PREFIX, 'attachments/live/', 'avatar/');
  });

  test('rejects string-prefix relations in either direction (live prefix)', () => {
    // livePrefix is a string prefix of the avatar prefix.
    expectOverlapRejected(AVATAR_PREFIX, 'a', 'attachments/probe/');
    expectOverlapRejected(AVATAR_PREFIX, 'av', 'attachments/probe/');
    expectOverlapRejected(AVATAR_PREFIX, 'avatar', 'attachments/probe/');
    // avatar prefix is a string prefix of the live prefix.
    expectOverlapRejected('avatar', 'avatar/', 'attachments/probe/');
    expectOverlapRejected('avatar', 'avatar/x/', 'attachments/probe/');
  });

  test('rejects string-prefix relations in either direction (probe prefix)', () => {
    // probePrefix is a string prefix of the avatar prefix.
    expectOverlapRejected(AVATAR_PREFIX, 'attachments/live/', 'a');
    expectOverlapRejected(AVATAR_PREFIX, 'attachments/live/', 'avatar');
    // avatar prefix is a string prefix of the probe prefix.
    expectOverlapRejected('avatar', 'attachments/live/', 'avatar/');
    expectOverlapRejected('avatar', 'attachments/live/', 'avatar/x/');
  });

  test('rejects empty prefixes defensively (empty string is a prefix of every key)', () => {
    expectOverlapRejected(AVATAR_PREFIX, '', 'attachments/probe/');
    expectOverlapRejected(AVATAR_PREFIX, 'attachments/live/', '');
    expectOverlapRejected('', 'attachments/live/', 'attachments/probe/');
  });
});
