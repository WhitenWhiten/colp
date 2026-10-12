import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { parseAuthSnapshot } from '../src/auth-snapshot.js';

describe('public auth snapshot cache', () => {
  const snapshot = { status: 'connected', environment: 'production', serverOrigin: 'https://know-n.com',
    accountLabel: 'ada@example.test', sessionExpiresAt: '2026-08-26T00:00:00.000Z', updatedAt: 1 };

  test('returns the public auth state and tolerates optional fields', () => {
    assert.deepEqual(parseAuthSnapshot(snapshot), {
      status: 'connected', environment: 'production', serverOrigin: 'https://know-n.com',
      accountLabel: 'ada@example.test', sessionExpiresAt: '2026-08-26T00:00:00.000Z',
    });
    assert.deepEqual(parseAuthSnapshot({
      ...snapshot, avatarUrl: 'https://know-n.com/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
    }), {
      status: 'connected', environment: 'production', serverOrigin: 'https://know-n.com',
      accountLabel: 'ada@example.test',
      avatarUrl: 'https://know-n.com/api/v1/avatar/123e4567-e89b-42d3-a456-426614174000',
      sessionExpiresAt: '2026-08-26T00:00:00.000Z',
    });
  });

  test('rejects malformed snapshots instead of guessing', () => {
    assert.equal(parseAuthSnapshot(undefined), undefined);
    assert.equal(parseAuthSnapshot('connected'), undefined);
    assert.equal(parseAuthSnapshot([]), undefined);
    assert.equal(parseAuthSnapshot({ ...snapshot, status: 'root' }), undefined);
    assert.equal(parseAuthSnapshot({ ...snapshot, environment: 'test' }), undefined);
    assert.equal(parseAuthSnapshot({ ...snapshot, serverOrigin: 42 }), undefined);
    assert.equal(parseAuthSnapshot({ ...snapshot, accountLabel: 42 }), undefined);
    assert.equal(parseAuthSnapshot({ ...snapshot, avatarUrl: 42 }), undefined);
    assert.equal(parseAuthSnapshot({ ...snapshot, sessionExpiresAt: 42 }), undefined);
  });

  test('never carries credential material', () => {
    const parsed = parseAuthSnapshot({ ...snapshot, accessToken: 'secret', refreshToken: 'secret' });
    assert.ok(parsed);
    assert.deepEqual(Object.keys(parsed), ['status', 'environment', 'serverOrigin', 'accountLabel', 'sessionExpiresAt']);
  });
});
