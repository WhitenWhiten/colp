import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createExploreGovernanceCursorSigner,
  exploreGovernanceBindDigest,
  ExploreGovernanceCursorExpiredError,
  EXPLORE_GOVERNANCE_CURSOR_MAX_LENGTH,
  EXPLORE_GOVERNANCE_CURSOR_PURPOSE,
} from '../../../src/modules/governance/application/explore-cursor.js';

const hmac = Buffer.alloc(32, 11).toString('base64url');

function payload(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    v: 1 as const,
    purpose: EXPLORE_GOVERNANCE_CURSOR_PURPOSE,
    sort: 'updated' as const,
    language: 'en',
    viewer: 'acct-1',
    prefRev: '2',
    after: { micros: '1', id: 'col-1' },
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    ...overrides,
  };
}

test('explore governance cursor binds language, viewer, and preference revision', () => {
  const signer = createExploreGovernanceCursorSigner(hmac);
  try {
    const token = signer.sign(payload());
    const decoded = signer.verify(token, new Date('2026-01-01T00:01:00.000Z'));
    assert.equal(decoded.sort, 'updated');
    assert.equal(decoded.after.id, 'col-1');
    assert.equal(decoded.bind, exploreGovernanceBindDigest({
      language: 'en', viewer: 'acct-1', prefRev: '2', sort: 'updated',
    }));
    assert.notEqual(
      decoded.bind,
      exploreGovernanceBindDigest({
        language: 'fr', viewer: 'acct-1', prefRev: '2', sort: 'updated',
      }),
    );
    assert.throws(
      () => signer.verify(token.slice(0, -2) + 'ab', new Date('2026-01-01T00:01:00.000Z')),
    );
  } finally {
    signer.destroy();
  }
});

test('expired explore governance cursor is snapshot_expired, not a generic invalid token', () => {
  const signer = createExploreGovernanceCursorSigner(hmac);
  try {
    const token = signer.sign(payload());
    assert.throws(
      () => signer.verify(token, new Date('2026-01-01T00:20:00.000Z')),
      (error: unknown) => error instanceof ExploreGovernanceCursorExpiredError,
    );
  } finally {
    signer.destroy();
  }
});

test('schema-max HMAC explore cursor fits in 512 and round-trips', () => {
  const signer = createExploreGovernanceCursorSigner(hmac);
  try {
    const max = payload({
      sort: 'popular',
      language: 'x'.repeat(35),
      viewer: 'v'.repeat(128),
      prefRev: '9'.repeat(19),
      after: { micros: '-9223372036854775808', id: 'i'.repeat(128), viewCount: Number.MAX_SAFE_INTEGER },
    });
    const token = signer.sign(max);
    assert.ok(token.length <= EXPLORE_GOVERNANCE_CURSOR_MAX_LENGTH, String(token.length));
    const decoded = signer.verify(token, new Date('2026-01-01T00:01:00.000Z'));
    assert.equal(decoded.sort, 'popular');
    assert.equal(decoded.after.id, max.after.id);
    assert.equal(decoded.after.micros, max.after.micros);
    assert.equal(decoded.after.viewCount, Number.MAX_SAFE_INTEGER);
    assert.equal(decoded.bind, exploreGovernanceBindDigest({
      language: max.language, viewer: max.viewer, prefRev: max.prefRev, sort: 'popular',
    }));
  } finally {
    signer.destroy();
  }
});

test('production 22-char popular cursor with max BCP47 stays within 512', () => {
  const signer = createExploreGovernanceCursorSigner(hmac);
  try {
    const token = signer.sign(payload({
      sort: 'popular',
      language: 'x'.repeat(35),
      viewer: 'a'.repeat(22),
      prefRev: '9'.repeat(19),
      after: { micros: '1784851200000000', id: 'b'.repeat(22), viewCount: 1_000_000 },
    }));
    assert.ok(token.length <= EXPLORE_GOVERNANCE_CURSOR_MAX_LENGTH, String(token.length));
    const decoded = signer.verify(token, new Date('2026-01-01T00:01:00.000Z'));
    assert.equal(decoded.after.id, 'b'.repeat(22));
    assert.equal(decoded.after.viewCount, 1_000_000);
  } finally {
    signer.destroy();
  }
});
