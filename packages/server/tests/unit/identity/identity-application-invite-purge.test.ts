import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createIdentityApplicationHarness } from '../../support/identity-application-memory.js';

describe('identity application: pending unbound invite purge', () => {
  test('verified email change revokes pending unbound invites for the old mailbox only', async () => {
    const { app, state } = createIdentityApplicationHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'invite-purge',
      email: 'Old@example.test',
      emailVerified: true,
    });
    state.pendingUnboundInvites.push(
      { emailNormalized: 'old@example.test', invitedSubjectId: null, status: 'pending', resolvedAt: null },
      { emailNormalized: 'old@example.test', invitedSubjectId: 'subject-bound', status: 'pending', resolvedAt: null },
      { emailNormalized: 'new@example.test', invitedSubjectId: null, status: 'pending', resolvedAt: null },
    );
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'invite-purge',
      email: 'new@example.test',
      emailVerified: true,
    });
    assert.equal(state.pendingUnboundInvites[0]?.status, 'revoked');
    assert.equal(state.pendingUnboundInvites[1]?.status, 'pending', 'bound invites stay subject-bound');
    assert.equal(state.pendingUnboundInvites[2]?.status, 'pending', 'new mailbox invites are not destroyed');
    assert.equal(
      state.pendingUnboundInvites.some((row) => (
        row.emailNormalized === 'old@example.test'
        && row.invitedSubjectId === null
        && row.status === 'pending'
      )),
      false,
      'a later account on the old mailbox must not find a pending unbound invite',
    );
  });

  test('first trusted email does not purge invites for the new mailbox', async () => {
    const { app, state } = createIdentityApplicationHarness();
    state.pendingUnboundInvites.push(
      { emailNormalized: 'first@example.test', invitedSubjectId: null, status: 'pending', resolvedAt: null },
    );
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'first-email',
      email: 'first@example.test',
      emailVerified: true,
    });
    assert.equal(state.pendingUnboundInvites[0]?.status, 'pending');
  });
});
