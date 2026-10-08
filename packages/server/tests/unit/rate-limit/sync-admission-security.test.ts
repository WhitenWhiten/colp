import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMemorySyncAdmissionPolicy, syncAdmissionSubjectKey } from '../../../src/infrastructure/rate-limit/sync-admission-policy.js';

const credential = { issuer: 'https://issuer.test', subject: 'alice', clientId: 'client', credentialId: 'credential' };

test('wire IDs and credential/client rotation cannot shard a verified principal quota', async () => {
  const policy = createMemorySyncAdmissionPolicy({ budgets: { session: { maxRequests: 1, windowMs: 60_000 } } });
  try {
    const key = syncAdmissionSubjectKey({ credential, replicaId: 'a', sessionId: 'a' });
    const rotated = syncAdmissionSubjectKey({ credential: { ...credential, clientId: 'other', credentialId: 'other' }, replicaId: 'b', sessionId: 'b' });
    assert.equal(key, rotated);
    assert.notEqual(key, syncAdmissionSubjectKey({ credential: { ...credential, subject: 'bob' } }));
    assert.notEqual(key, syncAdmissionSubjectKey({ credential: { ...credential, issuer: 'https://other.test' } }));
    assert.equal((await policy.admitSubject({ purpose: 'session', subjectKey: key })).kind, 'allowed');
    assert.equal((await policy.admitSubject({ purpose: 'session', subjectKey: rotated })).kind, 'denied');
  } finally { await policy.close(); }
});

test('bounded memory denies new identities without evicting active quotas and reclaims expired entries', async () => {
  let now = 0;
  const policy = createMemorySyncAdmissionPolicy({ now: () => now, maxBuckets: 2,
    budgets: { session: { maxRequests: 1, windowMs: 1_000 } } });
  const request = (clientKey: string) => policy.admitPreAuth({ purpose: 'session', clientKey });
  try {
    assert.equal((await request('one')).kind, 'allowed');
    assert.equal((await request('two')).kind, 'allowed');
    for (let i = 0; i < 100; i++) assert.equal((await request(`new-${i}`)).kind, 'denied');
    assert.equal((await request('one')).kind, 'denied');
    assert.equal((await policy.admitSubject({ purpose: 'session', subjectKey: 'verified' })).kind, 'allowed');
    now = 1_001;
    assert.equal((await request('fresh')).kind, 'allowed');
    assert.equal((await request('another')).kind, 'allowed');
  } finally { await policy.close(); }
  assert.deepEqual(policy.readiness(), { status: 'degraded', reason: 'closed' });
  assert.equal((await request('closed')).kind, 'failed');
});

test('memory admission rejects invalid capacity', () => {
  for (const maxBuckets of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => createMemorySyncAdmissionPolicy({ budgets: {}, maxBuckets }), TypeError);
  }
});
