import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  IDENTITY_APPLICATION_NOW as NOW,
  createIdentityApplicationHarness as createHarness,
} from '../../support/identity-application-memory.js';
import {
  ABOUT_MAX,
  IdentityError,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_ROTATION_MIN_AGE_MS,
  SESSION_TOUCH_MIN_INTERVAL_MS,
  bootstrapBrowserSession,
  createIdentityApplication,
  deriveCsrfTokenRaw,
  hashSecret,
  rotateSession,
  secretsMatch,
  type Account,
  type AccountIdentity,
  type IdentityPorts,
  type IdentityUnitOfWork,
  type Profile,
} from '../../../src/modules/identity/index.js';

/**
 * Deterministic concurrent-first-login race harness (CI-shard reproduction).
 *
 * The winning callback commits account + profile + (issuer, subject) binding
 * with the same verified email BETWEEN the losing callback's identity lookup
 * (findByIssuerSubject → miss) and its email-availability check
 * (findByEmail → hit). Before the fix this surfaced the terminal
 * `email_conflict` (redirect auth=failed); the fix re-checks the binding and
 * converts it to the retryable `identity_conflict` so the caller converges.
 */
function createConcurrentEmailRaceHarness() {
  const { state, ports } = createHarness();
  let identityLookups = 0;
  let injected = false;
  const winner: Account = {
    id: 'race-winner-account',
    subjectId: 'race-winner-subject-id',
    status: 'active',
    email: 'race@example.test',
    securityEpoch: 0n,
    createdAt: NOW,
    deletedAt: null,
  };
  const winnerProfile: Profile = {
    accountId: winner.id,
    displayName: 'Winner',
    avatarUrl: null,
    about: '',
    updatedAt: NOW,
  };
  const winnerIdentity: AccountIdentity = {
    id: 'race-winner-identity',
    accountId: winner.id,
    issuer: 'https://issuer.example',
    subject: 'race-subject',
    createdAt: NOW,
  };
  const identityKey = (issuer: string, subject: string) => `${issuer}\0${subject}`;
  const wrapped: IdentityPorts = {
    ...ports,
    accountIdentities: {
      ...ports.accountIdentities,
      async findByIssuerSubject(issuer, subject) {
        identityLookups += 1;
        return ports.accountIdentities.findByIssuerSubject(issuer, subject);
      },
    },
    accounts: {
      ...ports.accounts,
      async findByEmail(email) {
        // Commit the winner's rows the first time the loser checks email
        // availability (after the loser's identity lookup already missed).
        if (!injected && identityLookups >= 1 && email === winner.email) {
          injected = true;
          state.accounts.set(winner.id, winner);
          state.profiles.set(winner.id, winnerProfile);
          state.identities.set(identityKey(winnerIdentity.issuer, winnerIdentity.subject), winnerIdentity);
          state.identitiesByAccount.set(winnerIdentity.accountId, winnerIdentity.id);
        }
        return ports.accounts.findByEmail(email);
      },
    },
  };
  const unitOfWork: IdentityUnitOfWork = {
    execute: async (work) => work(wrapped),
  };
  const app = createIdentityApplication({ unitOfWork });
  return { state, ports: wrapped, app };
}

/**
 * Mixed concurrent-race harness (T-OIDC-005): between the losing callback's
 * identity lookup (findByIssuerSubject → miss) and its email-availability
 * check, the (issuer, subject) binding is committed to account A while the
 * same verified email is held by a *different* account B. The loser must be
 * classified directly as terminal email_conflict — the mere presence of a
 * binding must never convert a foreign-holder collision into the retryable
 * identity_conflict (which would burn a fresh-transaction retry before
 * failing closed).
 */
function createMixedRaceHarness() {
  const { state, ports } = createHarness();
  let identityLookups = 0;
  let injected = false;
  const issuer = 'https://issuer.example';
  const subject = 'mixed-race-subject';
  const email = 'mixed-race@example.test';
  const boundAccount: Account = {
    id: 'mixed-bound-account',
    subjectId: 'mixed-bound-subject-id',
    status: 'active',
    email: 'bound-other@example.test',
    securityEpoch: 0n,
    createdAt: NOW,
    deletedAt: null,
  };
  const holderAccount: Account = {
    id: 'mixed-holder-account',
    subjectId: 'mixed-holder-subject-id',
    status: 'active',
    email,
    securityEpoch: 0n,
    createdAt: NOW,
    deletedAt: null,
  };
  const holderProfile: Profile = {
    accountId: holderAccount.id,
    displayName: 'Holder B',
    avatarUrl: null,
    about: '',
    updatedAt: NOW,
  };
  const boundIdentity: AccountIdentity = {
    id: 'mixed-bound-identity',
    accountId: boundAccount.id,
    issuer,
    subject,
    createdAt: NOW,
  };
  const identityKey = (i: string, s: string) => `${i}\0${s}`;
  const wrapped: IdentityPorts = {
    ...ports,
    accountIdentities: {
      ...ports.accountIdentities,
      async findByIssuerSubject(i, s) {
        identityLookups += 1;
        return ports.accountIdentities.findByIssuerSubject(i, s);
      },
    },
    accounts: {
      ...ports.accounts,
      async findByEmail(e) {
        // Commit both concurrent facts the first time the loser checks email
        // availability (after its identity lookup already missed): account B
        // holds the email while the (issuer, subject) binding lands on A.
        if (!injected && identityLookups >= 1 && e === email) {
          injected = true;
          state.accounts.set(holderAccount.id, holderAccount);
          state.profiles.set(holderAccount.id, holderProfile);
          state.identities.set(identityKey(issuer, subject), boundIdentity);
          state.identitiesByAccount.set(boundIdentity.accountId, boundIdentity.id);
        }
        return ports.accounts.findByEmail(e);
      },
    },
  };
  const unitOfWork: IdentityUnitOfWork = {
    execute: async (work) => work(wrapped),
  };
  const app = createIdentityApplication({ unitOfWork });
  return { state, ports: wrapped, app };
}

function expectIdentityCode(error: unknown, code: string): void {
  assert.ok(error instanceof IdentityError, `expected IdentityError, got ${String(error)}`);
  assert.equal(error.code, code);
}

describe('identity application: OIDC account bootstrap', () => {
  test('provisions an opaque canonical handle when OIDC has no username claim', async () => {
    const { app, state } = createHarness();
    const result = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example/realms/known',
      subject: 'provider-subject-must-not-leak',
      email: 'private-address@example.test',
      emailVerified: true,
      displayName: 'No Username User',
    });

    assert.ok(result.handle);
    assert.match(result.handle.handle, /^[a-z0-9._~-]{1,64}$/u);
    assert.equal(result.handle.accountId, result.account.id);
    assert.equal(result.handle.handle.includes('provider-subject'), false);
    assert.equal(result.handle.handle.includes('private-address'), false);
    assert.equal(state.handles.size, 1);
  });

  test('repairs a historical active OIDC account missing its handle and preserves it thereafter', async () => {
    const { app, state } = createHarness();
    const first = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example', subject: 'historical-missing-handle', handle: 'custom_name',
    });
    state.handles.delete('custom_name');

    const repaired = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example', subject: 'historical-missing-handle',
    });
    assert.ok(repaired.handle);
    assert.equal(repaired.handle.accountId, first.account.id);

    const repeated = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example', subject: 'historical-missing-handle', handle: 'ignored_claim',
    });
    assert.equal(repeated.handle?.handle, repaired.handle.handle);
    assert.equal(state.handles.size, 1);
  });

  test('creates account, profile, handle, and identity on first login', async () => {
    const { app, state } = createHarness();
    const result = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example/realms/known',
      subject: 'oidc-sub-1',
      email: 'first@example.test',
      emailVerified: true,
      displayName: 'First User',
      handle: 'firstuser',
      avatarUrl: 'https://cdn.example/a.png',
    });
    assert.equal(result.account.email, 'first@example.test');
    assert.equal(result.account.status, 'active');
    assert.equal(result.account.securityEpoch, 0n);
    assert.equal(result.profile.displayName, 'First User');
    assert.equal(result.profile.about, '');
    assert.equal(result.profile.avatarUrl, 'https://cdn.example/a.png');
    assert.equal(result.handle?.handle, 'firstuser');
    assert.equal(result.identity?.subject, 'oidc-sub-1');
    assert.equal(state.accounts.size, 1);
    assert.equal(state.identities.size, 1);
    assert.equal(state.handles.size, 1);
  });

  test('reuses the same account for the same issuer/subject', async () => {
    const { app } = createHarness();
    const first = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'reuse-sub',
      email: 'a@example.test',
      emailVerified: true,
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'reuse-sub',
      email: 'b@example.test',
      emailVerified: true,
    });
    assert.equal(second.account.id, first.account.id);
    // Verified email claim synchronizes on repeated login.
    assert.equal(second.account.email, 'b@example.test');
  });

});

describe('identity application: verified email and trusted claim sync', () => {
  test('does not trust email when email_verified is missing', async () => {
    const { app } = createHarness();
    const result = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'unverified-missing',
      email: 'untrusted@example.test',
    });
    assert.equal(result.account.email, null);
  });

  test('does not trust email when email_verified is false', async () => {
    const { app } = createHarness();
    const result = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'unverified-false',
      email: 'untrusted@example.test',
      emailVerified: false,
    });
    assert.equal(result.account.email, null);
  });

  test('trusts email when email_verified is true', async () => {
    const { app } = createHarness();
    const result = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'verified-true',
      email: 'trusted@example.test',
      emailVerified: true,
    });
    assert.equal(result.account.email, 'trusted@example.test');
  });

  test('unverified email does not overwrite an existing trusted email on re-login', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'keep-email',
      email: 'original@example.test',
      emailVerified: true,
      displayName: 'Original',
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'keep-email',
      email: 'attacker@example.test',
      emailVerified: false,
      displayName: 'Original',
    });
    assert.equal(second.account.email, 'original@example.test');
  });

  test('repeated login synchronizes displayName, avatar, and verified email', async () => {
    const { app } = createHarness();
    const first = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'sync-sub',
      email: 'old@example.test',
      emailVerified: true,
      displayName: 'Old Name',
      avatarUrl: 'https://cdn.example/old.png',
      handle: 'syncuser',
    });
    assert.equal(first.handle?.handle, 'syncuser');

    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'sync-sub',
      email: 'new@example.test',
      emailVerified: true,
      displayName: 'New Name',
      avatarUrl: 'https://cdn.example/new.png',
    });
    assert.equal(second.account.id, first.account.id);
    assert.equal(second.account.email, 'new@example.test');
    assert.equal(second.profile.displayName, 'New Name');
    assert.equal(second.profile.avatarUrl, 'https://cdn.example/new.png');
    // Handle is local-only — not overwritten by OIDC re-login without handle input.
    assert.equal(second.handle?.handle, 'syncuser');
  });

  test('absent avatar claim leaves local avatar unchanged', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-keep',
      emailVerified: true,
      email: 'avatar@example.test',
      displayName: 'Avatar',
      avatarUrl: 'https://cdn.example/keep.png',
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'avatar-keep',
      emailVerified: true,
      email: 'avatar@example.test',
      displayName: 'Avatar',
      // avatarUrl omitted
    });
    assert.equal(second.profile.avatarUrl, 'https://cdn.example/keep.png');
  });

  test('empty displayName claim does not clear existing displayName', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'name-keep',
      displayName: 'Kept Name',
    });
    const second = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'name-keep',
      displayName: '',
    });
    assert.equal(second.profile.displayName, 'Kept Name');
  });

  test('rejects email collision on first login for a different subject', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'owner',
      email: 'shared@example.test',
      emailVerified: true,
    });
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'other',
        email: 'shared@example.test',
        emailVerified: true,
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'email_conflict');
        return true;
      },
    );
  });

  test('concurrent first login email race surfaces identity_conflict when the winner committed the same binding between the loser\'s identity lookup and email check', async () => {
    // Simulate the two-callback interleaving that the CI shard hit: the loser\'s
    // findByIssuerSubject runs before the winner commits, then the winner\'s
    // account (with the same email and the same issuer+subject binding) lands
    // before the loser\'s assertEmailAvailable. The loser must be classified as
    // identity_conflict (retryable, converges) and never as the terminal
    // email_conflict that would redirect the login to auth=failed.
    const { state, app } = createConcurrentEmailRaceHarness();
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'race-subject',
        email: 'race@example.test',
        emailVerified: true,
        displayName: 'Race User',
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'identity_conflict');
        return true;
      },
    );
    // Only the injected winner rows exist — the loser wrote nothing.
    assert.equal(state.accounts.size, 1);
    assert.equal(state.identities.size, 1);
    assert.equal(state.profiles.size, 1);
  });

  test('foreign email holder still fails closed with email_conflict even when a concurrent identity binding exists for a different subject', async () => {
    // Negative control for the email-race conversion: the re-check must only
    // convert when the (issuer, subject) binding belongs to the email holder.
    // A different subject that collides on the email must remain terminal.
    const { state, app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'holder',
      email: 'shared@example.test',
      emailVerified: true,
    });
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'other',
        email: 'shared@example.test',
        emailVerified: true,
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'email_conflict');
        return true;
      },
    );
    assert.equal(state.accounts.size, 1);
  });

  test('mixed race: (issuer, subject) bound to account A while a foreign account B holds the email is terminal email_conflict on the first call', async () => {
    // Three facts (T-OIDC-005): the loser's first identity lookup misses; by
    // the time the loser checks email availability the (issuer, subject)
    // binding is committed to account A; the same verified email is held by
    // account B. Because the binding owner is NOT the email holder, the first
    // call must be classified directly as terminal email_conflict — never as
    // the retryable identity_conflict (which would trigger a pointless
    // fresh-transaction retry before failing closed).
    const { state, app } = createMixedRaceHarness();
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'mixed-race-subject',
        email: 'mixed-race@example.test',
        emailVerified: true,
        displayName: 'Mixed Race User',
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'email_conflict');
        return true;
      },
    );
    // Only the injected foreign holder (B) and the A binding exist — the
    // loser wrote no provisional account/profile/identity rows.
    assert.equal(state.accounts.size, 1);
    assert.equal(state.profiles.size, 1);
    assert.equal(state.identities.size, 1);
    const bound = state.identities.get('https://issuer.example\0mixed-race-subject');
    assert.equal(bound?.accountId, 'mixed-bound-account');
    const holder = state.accounts.get('mixed-holder-account');
    assert.equal(holder?.email, 'mixed-race@example.test');
  });

  test('rejects email collision when syncing a verified email onto an existing account', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'holder',
      email: 'taken@example.test',
      emailVerified: true,
    });
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'mover',
      email: 'mover@example.test',
      emailVerified: true,
    });
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'mover',
        email: 'taken@example.test',
        emailVerified: true,
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'email_conflict');
        return true;
      },
    );
  });

  test('existing-account email sync excludes its own account id when the email lookup returns itself', async () => {
    // The sync path must keep the own-account exclusion: if the account row
    // already reports the target email (e.g. a concurrent commit landed
    // between findById and findByEmail), re-applying it must not be
    // misclassified as an email_conflict against the account's own row.
    const { state, ports } = createHarness();
    const app = createIdentityApplication({
      unitOfWork: { execute: async (work) => work(ports) },
    });
    const first = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'self-sync',
      email: 'before@example.test',
      emailVerified: true,
    });
    const self = state.accounts.get(first.account.id)!;
    const wrapped: IdentityPorts = {
      ...ports,
      accounts: {
        ...ports.accounts,
        async findByEmail(email) {
          if (email === 'after@example.test') return { ...self, email };
          return ports.accounts.findByEmail(email);
        },
      },
    };
    const syncApp = createIdentityApplication({
      unitOfWork: { execute: async (work) => work(wrapped) },
    });
    const second = await syncApp.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'self-sync',
      email: 'after@example.test',
      emailVerified: true,
    });
    assert.equal(second.account.id, first.account.id);
    assert.equal(second.account.email, 'after@example.test');
  });

  test('email conflict does not apply partial claim updates', async () => {
    const { app, state } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'holder',
      email: 'taken@example.test',
      emailVerified: true,
    });
    const created = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'tx-subject',
      email: 'before@example.test',
      emailVerified: true,
      displayName: 'Before',
      avatarUrl: 'https://cdn.example/before.png',
    });

    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'tx-subject',
        email: 'taken@example.test',
        emailVerified: true,
        displayName: 'After',
        avatarUrl: 'https://cdn.example/after.png',
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'email_conflict');
        return true;
      },
    );

    // Availability is checked before any email/profile writes.
    const after = state.accounts.get(created.account.id)!;
    const profile = state.profiles.get(created.account.id)!;
    assert.equal(after.email, 'before@example.test');
    assert.equal(profile.displayName, 'Before');
    assert.equal(profile.avatarUrl, 'https://cdn.example/before.png');
  });

  test('requireVerifiedEmail policy rejects missing verification', async () => {
    const { app } = createHarness();
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'policy-sub',
        email: 'need@example.test',
        emailVerified: false,
        emailTrustPolicy: { requireVerifiedEmail: true },
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'email_unverified');
        return true;
      },
    );
  });
});

describe('identity application: session lifecycle', () => {
  test('createSession stores only hashes and returns raw secrets once', async () => {
    const { app, state } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'session-subject',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    assert.ok(created.rawSessionToken.length >= 16);
    assert.ok(created.rawCsrfToken.length >= 16);
    assert.notEqual(created.rawSessionToken, created.session.tokenHash);
    assert.equal(created.session.tokenHash, hashSecret(created.rawSessionToken));
    assert.equal(created.session.csrfTokenHash, hashSecret(created.rawCsrfToken));
    assert.equal(created.session.securityEpoch, ensured.account.securityEpoch);
    assert.equal(created.session.idleExpiresAt.getTime() - state.now.getTime(), SESSION_IDLE_TTL_MS);
    assert.equal(
      created.session.absoluteExpiresAt.getTime() - state.now.getTime(),
      SESSION_ABSOLUTE_TTL_MS,
    );
    for (const row of state.sessions.values()) {
      assert.notEqual(row.tokenHash, created.rawSessionToken);
      assert.notEqual(row.csrfTokenHash, created.rawCsrfToken);
    }
  });

  test('authenticateSession slides idle expiry and keeps absolute expiry fixed', async () => {
    const { app, state } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'auth-sub',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    state.now = new Date(state.now.getTime() + 60_000);
    const auth = await app.authenticateSession(created.rawSessionToken, { touch: true });
    assert.equal(auth.account.id, ensured.account.id);
    assert.equal(auth.session.idleExpiresAt.getTime(), state.now.getTime() + SESSION_IDLE_TTL_MS);
    assert.equal(
      auth.session.absoluteExpiresAt.getTime(),
      created.session.absoluteExpiresAt.getTime(),
    );
    assert.ok(secretsMatch(created.rawCsrfToken, auth.session.csrfTokenHash));
  });

  test('authenticateSession rejects idle expiry, absolute expiry, and revoke with stable codes', async () => {
    const { app, state } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'reject-sub',
    });

    const idle = await app.createSession({ accountId: ensured.account.id });
    state.now = new Date(idle.session.idleExpiresAt.getTime() + 1);
    await assert.rejects(
      () => app.authenticateSession(idle.rawSessionToken),
      (error: unknown) => {
        expectIdentityCode(error, 'session_expired');
        return true;
      },
    );

    state.now = new Date(NOW);
    const absolute = await app.createSession({ accountId: ensured.account.id });
    const absoluteRow = state.sessions.get(absolute.session.id)!;
    state.sessions.set(absolute.session.id, {
      ...absoluteRow,
      idleExpiresAt: new Date(state.now.getTime() + SESSION_IDLE_TTL_MS),
      absoluteExpiresAt: new Date(state.now.getTime() - 1),
    });
    await assert.rejects(
      () => app.authenticateSession(absolute.rawSessionToken),
      (error: unknown) => {
        expectIdentityCode(error, 'session_expired');
        return true;
      },
    );

    const revocable = await app.createSession({ accountId: ensured.account.id });
    const firstRevoke = await app.revokeSession(revocable.session.id);
    const secondRevoke = await app.revokeSession(revocable.session.id);
    assert.equal(firstRevoke.revoked, true);
    assert.equal(secondRevoke.revoked, false);
    await assert.rejects(
      () => app.authenticateSession(revocable.rawSessionToken),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
  });

  test('rotateSession invalidates the old token and rotates CSRF material', async () => {
    const { app } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'rotate-sub',
    });
    const first = await app.createSession({ accountId: ensured.account.id });
    const second = await app.rotateSession(first.session.id);

    assert.notEqual(second.rawSessionToken, first.rawSessionToken);
    assert.notEqual(second.rawCsrfToken, first.rawCsrfToken);
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(second.session.rotatedFromSessionId, first.session.id);
    assert.notEqual(second.session.csrfTokenHash, first.session.csrfTokenHash);
    // Absolute lifetime must not be extended by rotation.
    assert.equal(
      second.session.absoluteExpiresAt.getTime(),
      first.session.absoluteExpiresAt.getTime(),
    );
    assert.equal(second.rawCsrfToken, deriveCsrfTokenRaw(second.rawSessionToken));

    await assert.rejects(
      () => app.authenticateSession(first.rawSessionToken),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
    const auth = await app.authenticateSession(second.rawSessionToken);
    assert.equal(auth.session.id, second.session.id);
  });

  test('authenticateSession below touch threshold is a pure read (no idle write)', async () => {
    const { app, state } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'touch-threshold-sub',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    const before = state.sessions.get(created.session.id)!;
    // Advance less than SESSION_TOUCH_MIN_INTERVAL_MS.
    state.now = new Date(state.now.getTime() + SESSION_TOUCH_MIN_INTERVAL_MS - 1);
    const auth = await app.authenticateSession(created.rawSessionToken, { touch: true });
    const after = state.sessions.get(created.session.id)!;
    assert.equal(after.lastSeenAt.getTime(), before.lastSeenAt.getTime());
    assert.equal(after.idleExpiresAt.getTime(), before.idleExpiresAt.getTime());
    assert.equal(auth.session.lastSeenAt.getTime(), before.lastSeenAt.getTime());
  });

  test('bootstrapBrowserSession below rotation threshold re-issues CSRF without minting', async () => {
    const { ports, state } = createHarness();
    const app = createIdentityApplication({
      unitOfWork: { execute: async (work) => work(ports) },
    });
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'bootstrap-young-sub',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    const sizeBefore = state.sessions.size;
    const boot = await bootstrapBrowserSession(ports, created.rawSessionToken, {
      rotationMinAgeMs: SESSION_ROTATION_MIN_AGE_MS,
    });
    assert.equal(boot.rotated, false);
    assert.equal(boot.rawSessionToken, created.rawSessionToken);
    assert.equal(boot.rawCsrfToken, deriveCsrfTokenRaw(created.rawSessionToken));
    assert.equal(state.sessions.size, sizeBefore);
    assert.equal(boot.session.id, created.session.id);
  });

  test('bootstrapBrowserSession below rotation threshold does not throttle-touch idle', async () => {
    const { ports, state } = createHarness();
    const app = createIdentityApplication({
      unitOfWork: { execute: async (work) => work(ports) },
    });
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'bootstrap-no-touch-sub',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    const before = state.sessions.get(created.session.id)!;
    state.now = new Date(state.now.getTime() + SESSION_TOUCH_MIN_INTERVAL_MS);
    const boot = await bootstrapBrowserSession(ports, created.rawSessionToken, {
      rotationMinAgeMs: SESSION_ROTATION_MIN_AGE_MS,
    });
    const after = state.sessions.get(created.session.id)!;
    assert.equal(boot.rotated, false);
    assert.equal(boot.rawSessionToken, created.rawSessionToken);
    assert.equal(after.lastSeenAt.getTime(), before.lastSeenAt.getTime());
    assert.equal(after.idleExpiresAt.getTime(), before.idleExpiresAt.getTime());
    assert.equal(boot.session.lastSeenAt.getTime(), before.lastSeenAt.getTime());
  });

  test('bootstrapBrowserSession above rotation threshold rotates once', async () => {
    const { ports, state } = createHarness();
    const app = createIdentityApplication({
      unitOfWork: { execute: async (work) => work(ports) },
    });
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'bootstrap-old-sub',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    state.now = new Date(created.session.createdAt.getTime() + SESSION_ROTATION_MIN_AGE_MS);
    const boot = await bootstrapBrowserSession(ports, created.rawSessionToken);
    assert.equal(boot.rotated, true);
    assert.notEqual(boot.rawSessionToken, created.rawSessionToken);
    assert.equal(boot.session.rotatedFromSessionId, created.session.id);
    assert.equal(
      boot.session.absoluteExpiresAt.getTime(),
      created.session.absoluteExpiresAt.getTime(),
    );
    await assert.rejects(
      () => app.authenticateSession(created.rawSessionToken),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
  });

  test('concurrent browser bootstrap losers resolve to the winner; replay fails', async () => {
    const { ports, state } = createHarness();
    const app = createIdentityApplication({
      unitOfWork: { execute: async (work) => work(ports) },
    });
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'race-sub',
    });
    const created = await app.createSession({ accountId: ensured.account.id });
    const sizeBefore = state.sessions.size;

    let arrived = 0;
    let releaseRace: (() => void) | undefined;
    const raceGate = new Promise<void>((resolve) => { releaseRace = resolve; });
    let releaseSuccessor: (() => void) | undefined;
    const successorVisible = new Promise<void>((resolve) => { releaseSuccessor = resolve; });
    const racePorts: IdentityPorts = {
      ...ports,
      sessions: {
        ...ports.sessions,
        async revoke(sessionId, revokedAt) {
          const claimed = await ports.sessions.revoke(sessionId, revokedAt);
          if (!claimed) await successorVisible;
          return claimed;
        },
        async insert(session) {
          await ports.sessions.insert(session);
          releaseSuccessor?.();
        },
      },
      clock: {
        async now() {
          arrived += 1;
          if (arrived === 3) releaseRace?.();
          await raceGate;
          return new Date(state.now);
        },
      },
    };

    const results = await Promise.allSettled([
      bootstrapBrowserSession(racePorts, created.rawSessionToken, { rotationMinAgeMs: 0 }),
      bootstrapBrowserSession(racePorts, created.rawSessionToken, { rotationMinAgeMs: 0 }),
      bootstrapBrowserSession(racePorts, created.rawSessionToken, { rotationMinAgeMs: 0 }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 3, 'CAS losers must resolve to the winner');

    const winner = (fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof bootstrapBrowserSession>>
    >).value;
    assert.equal(winner.rotated, true);
    for (const result of fulfilled) {
      assert.ok(result.status === 'fulfilled');
      assert.equal(result.value.session.id, winner.session.id);
      assert.equal(result.value.rawSessionToken, winner.rawSessionToken);
      assert.equal(result.value.rawCsrfToken, winner.rawCsrfToken);
    }
    assert.equal(winner.session.rotatedFromSessionId, created.session.id);
    // Exactly one successor row for this predecessor.
    const successors = [...state.sessions.values()].filter(
      (s) => s.rotatedFromSessionId === created.session.id,
    );
    assert.equal(successors.length, 1);
    assert.equal(state.sessions.size, sizeBefore + 1);

    await assert.rejects(
      () => app.authenticateSession(created.rawSessionToken),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
    await assert.rejects(
      () => bootstrapBrowserSession(ports, created.rawSessionToken, { rotationMinAgeMs: 0 }),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
    const auth = await app.authenticateSession(winner.rawSessionToken);
    assert.equal(auth.session.id, winner.session.id);
  });

  test('bumpAccountSecurityEpoch invalidates every existing session for the account', async () => {
    const { app } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'epoch-sub',
    });
    const first = await app.createSession({ accountId: ensured.account.id });
    const second = await app.createSession({ accountId: ensured.account.id });
    const bumped = await app.bumpAccountSecurityEpoch(ensured.account.id);
    assert.equal(bumped.securityEpoch, ensured.account.securityEpoch + 1n);
    assert.equal(bumped.revokedSessions, 2);

    for (const raw of [first.rawSessionToken, second.rawSessionToken]) {
      await assert.rejects(
        () => app.authenticateSession(raw),
        (error: unknown) => {
          assert.ok(error instanceof IdentityError);
          assert.ok(
            error.code === 'session_revoked'
            || error.code === 'session_security_epoch_mismatch',
          );
          return true;
        },
      );
    }

    const fresh = await app.createSession({ accountId: ensured.account.id });
    const auth = await app.authenticateSession(fresh.rawSessionToken);
    assert.equal(auth.session.securityEpoch, bumped.securityEpoch);
  });
});

describe('identity application: OIDC login transaction', () => {
  test('create and one-time consume; second consume fails', async () => {
    const { app, state, ports } = createHarness();
    const started = await app.createOidcLoginTransaction({ returnTo: '/editor' });
    assert.equal(started.transaction.returnTo, '/editor');
    assert.ok(started.transaction.state.length >= 16);
    assert.ok(started.transaction.codeVerifier.length >= 43);
    assert.equal(started.codeVerifier, started.transaction.codeVerifier);

    // At rest: digests + ciphertext only (no raw browser secrets).
    assert.equal(state.oidc.size, 1);
    const stored = [...state.oidc.values()][0]!;
    assert.notEqual(stored.state, started.transaction.state);
    assert.equal(stored.nonce, '');
    assert.equal(stored.codeVerifier, '');
    assert.equal(stored.stateHash, ports.oidcTransactionSecrets.digestState(started.transaction.state));
    assert.ok(stored.nonceHash);
    assert.ok(stored.pkceVerifierCiphertext);

    const first = await app.consumeOidcLoginTransaction(started.transaction.state);
    assert.ok(first.consumedAt);
    assert.equal(first.returnTo, '/editor');
    assert.equal(first.state, started.transaction.state);
    assert.equal(first.codeVerifier, started.codeVerifier);

    await assert.rejects(
      () => app.consumeOidcLoginTransaction(started.transaction.state),
      (error: unknown) => {
        expectIdentityCode(error, 'transaction_consumed');
        return true;
      },
    );
  });

  test('rejects open-redirect returnTo values', async () => {
    const { app } = createHarness();
    await assert.rejects(
      () => app.createOidcLoginTransaction({ returnTo: '//evil.example' }),
      (error: unknown) => {
        expectIdentityCode(error, 'invalid_return_to');
        return true;
      },
    );
  });

  test('expired OIDC transaction cannot be consumed', async () => {
    const { app, state } = createHarness();
    const started = await app.createOidcLoginTransaction({ returnTo: '/' });
    state.now = new Date(started.transaction.expiresAt.getTime() + 60_000);
    await assert.rejects(
      () => app.consumeOidcLoginTransaction(started.transaction.state),
      (error: unknown) => {
        expectIdentityCode(error, 'transaction_expired');
        return true;
      },
    );
  });

  test('unknown browser state is not found (no plaintext dual-read)', async () => {
    const { app } = createHarness();
    await assert.rejects(
      () => app.consumeOidcLoginTransaction('unknown-browser-state-value-xx'),
      (error: unknown) => {
        expectIdentityCode(error, 'transaction_not_found');
        return true;
      },
    );
  });
});

describe('identity application: handle claim and me query', () => {
  test('claims canonical lowercase handles and treats ASCII case variants as one identity', async () => {
    const { app } = createHarness();
    const a = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example', subject: 'case-a', handle: 'Alice_User',
    });
    const b = await app.ensureAccountFromOidcIdentity({ issuer: 'https://issuer.example', subject: 'case-b' });
    assert.equal(a.handle?.handle, 'alice_user');
    await assert.rejects(
      () => app.claimHandle({ accountId: b.account.id, handle: 'ALICE_USER' }),
      (error: unknown) => {
        expectIdentityCode(error, 'handle_taken');
        return true;
      },
    );
  });

  test('claims a unique handle and rejects duplicates', async () => {
    const { app } = createHarness();
    const a = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'h1',
    });
    const b = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'h2',
    });
    await app.claimHandle({ accountId: a.account.id, handle: 'uniquehandle' });
    await assert.rejects(
      () => app.claimHandle({ accountId: b.account.id, handle: 'uniquehandle' }),
      (error: unknown) => {
        expectIdentityCode(error, 'handle_taken');
        return true;
      },
    );
  });

  test('ensureAccount rejects a handle already reserved by another account', async () => {
    const { app } = createHarness();
    await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'owner',
      handle: 'sharedhandle',
    });
    await assert.rejects(
      () => app.ensureAccountFromOidcIdentity({
        issuer: 'https://issuer.example',
        subject: 'other',
        handle: 'sharedhandle',
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'handle_taken');
        return true;
      },
    );
  });

  test('getAccountWithProfile returns linked profile and handle', async () => {
    const { app } = createHarness();
    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'me-sub',
      email: 'me@example.test',
      emailVerified: true,
      displayName: 'Me',
      handle: 'me_user',
    });
    const me = await app.getAccountWithProfile(ensured.account.id);
    assert.equal(me.account.email, 'me@example.test');
    assert.equal(me.profile.displayName, 'Me');
    assert.equal(me.profile.about, '');
    assert.equal(me.handle?.handle, 'me_user');
  });
});

describe('identity application: profile settings about', () => {
  const productOrigin = 'https://app.example.test';

  test('sets, preserves, and clears about with avatarUrl merge-patch semantics', async () => {
    const { app, state } = createHarness();
    const created = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'about-sub',
      displayName: 'About User',
      handle: 'about_user',
    });
    assert.equal(created.profile.about, '');

    const set = await app.updateProfileSettings({
      accountId: created.account.id,
      handle: 'about_user',
      displayName: 'About User',
      productOrigin,
      about: 'I collect bookmarks.',
    });
    assert.equal(set.profile.about, 'I collect bookmarks.');
    const afterSet = state.profiles.get(created.account.id)!;
    assert.equal(afterSet.about, 'I collect bookmarks.');
    const setUpdatedAt = afterSet.updatedAt;

    state.now = new Date('2026-01-01T13:00:00.000Z');
    const omitted = await app.updateProfileSettings({
      accountId: created.account.id,
      handle: 'about_user',
      displayName: 'About User',
      productOrigin,
    });
    assert.equal(omitted.profile.about, 'I collect bookmarks.');
    assert.equal(state.profiles.get(created.account.id)?.updatedAt, setUpdatedAt);

    const cleared = await app.updateProfileSettings({
      accountId: created.account.id,
      handle: 'about_user',
      displayName: 'About User',
      productOrigin,
      about: null,
    });
    assert.equal(cleared.profile.about, '');
    assert.equal(state.profiles.get(created.account.id)?.about, '');
  });

  test('rejects whitespace-only and overlong about without mutating the stored profile', async () => {
    const { app, state } = createHarness();
    const created = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'about-reject',
      displayName: 'About Reject',
      handle: 'about_reject',
    });
    await app.updateProfileSettings({
      accountId: created.account.id,
      handle: 'about_reject',
      displayName: 'About Reject',
      productOrigin,
      about: 'kept',
    });
    const before = state.profiles.get(created.account.id)!;

    await assert.rejects(
      () => app.updateProfileSettings({
        accountId: created.account.id,
        handle: 'about_reject',
        displayName: 'About Reject',
        productOrigin,
        about: '   ',
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'invalid_about');
        return true;
      },
    );
    await assert.rejects(
      () => app.updateProfileSettings({
        accountId: created.account.id,
        handle: 'about_reject',
        displayName: 'About Reject',
        productOrigin,
        about: 'x'.repeat(ABOUT_MAX + 1),
      }),
      (error: unknown) => {
        expectIdentityCode(error, 'invalid_about');
        return true;
      },
    );

    const after = state.profiles.get(created.account.id)!;
    assert.equal(after.about, 'kept');
    assert.equal(after.updatedAt, before.updatedAt);
  });

  test('accepts an empty about string as a clear and does not bump updatedAt when unchanged', async () => {
    const { app, state } = createHarness();
    const created = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject: 'about-empty',
      displayName: 'About Empty',
      handle: 'about_empty',
    });
    const initial = state.profiles.get(created.account.id)!;
    const same = await app.updateProfileSettings({
      accountId: created.account.id,
      handle: 'about_empty',
      displayName: 'About Empty',
      productOrigin,
      about: '',
    });
    assert.equal(same.profile.about, '');
    assert.equal(state.profiles.get(created.account.id)?.updatedAt, initial.updatedAt);
  });
});
