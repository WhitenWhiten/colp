/**
 * Account MCP revocation is the resolved account's security epoch, not the
 * global incident floor. Password changes and revokeAll write that account
 * fact; they do not move the historical floor.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresMcpOauthRevocationStore } from '../../../src/infrastructure/database/postgres-mcp-oauth-revocation-store.js';
import { createBetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createBetterAuthSessionAuthority } from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import {
  createAccountSecurityEventNotification,
  createSecurityEpochBridge,
  type BetterAuthServerPort,
} from '../../../src/modules/auth/index.js';
import {
  createMcpOauthVerifier,
  McpOauthVerificationError,
  type McpOauthVerifier,
} from '../../../src/modules/mcp/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://mcp-boundary.example.test';
const AUDIENCE = 'https://mcp-boundary.example.test/mcp';
const CLIENT_ID = 'known-mcp-boundary';
const SCOPES = ['mcp:read:own'] as const;

describeWithPostgres('account MCP security boundary', () => {
  let isolated: IsolatedPostgresRuntime;
  let privateKey: KeyLike;
  let jwk: JWK;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('mcp_account_boundary');
    await runMigrations(isolated.runtime.db, 'latest');
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    jwk = await exportJWK(pair.publicKey);
    Object.assign(jwk, { kid: 'boundary-kid', alg: 'RS256', use: 'sig' });
  }, 120_000);

  afterAll(async () => { await isolated?.close(); });

  function store() {
    return createPostgresMcpOauthRevocationStore({ db: isolated.runtime.db });
  }

  async function anchorFloor(at: Date): Promise<void> {
    await isolated.runtime.pool.query(
      'update mcp_oauth_security_epoch set effective_at = $1, updated_at = $1 where id = 1',
      [at],
    );
  }

  async function readFloor(): Promise<{ epoch: string; effectiveAt: Date }> {
    const row = await isolated.runtime.pool.query<{ epoch: string; effective_at: Date | string }>(
      'select epoch, effective_at from mcp_oauth_security_epoch where id = 1',
    );
    return {
      epoch: row.rows[0]!.epoch,
      effectiveAt: new Date(row.rows[0]!.effective_at),
    };
  }

  async function mint(input: {
    readonly subject: string;
    readonly issuedAtSeconds: number;
    readonly knownAccountEpoch?: string;
    readonly jti: string;
  }): Promise<string> {
    const claims: Record<string, string> = { scope: SCOPES.join(' '), client_id: CLIENT_ID };
    if (input.knownAccountEpoch !== undefined) claims.known_account_epoch = input.knownAccountEpoch;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'boundary-kid' })
      .setIssuer(ISSUER)
      .setSubject(input.subject)
      .setAudience(AUDIENCE)
      .setIssuedAt(input.issuedAtSeconds)
      .setExpirationTime(input.issuedAtSeconds + 3_600)
      .setJti(input.jti)
      .sign(privateKey);
  }

  function verifier(requireAccountEpoch: boolean): McpOauthVerifier {
    const revocation = store();
    return createMcpOauthVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      allowedScopes: SCOPES,
      jwks: { async getKeySet() { return { keys: [jwk] }; } },
      isRevoked: (query) => revocation.isRevoked(query),
      securityEpoch: () => revocation.securityEpoch(),
      resolveAccountBySubject: async (sub) => {
        const row = await isolated.runtime.pool.query<{
          id: string; subject_id: string; status: string; security_epoch: string;
        }>(
          'select id, subject_id, status, security_epoch::text from accounts where subject_id = $1',
          [sub],
        );
        if (row.rowCount !== 1) return null;
        const account = row.rows[0]!;
        if (account.status !== 'active') return null;
        return {
          id: account.id,
          subjectId: account.subject_id,
          status: account.status,
          securityEpoch: account.security_epoch,
        };
      },
      requireAccountEpoch,
      readAccountSecurityBoundary: (accountId) => revocation.readAccountSecurityBoundary!(accountId),
    });
  }

  async function insertAccount(id: string, subjectId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status, email) values ($1, $2, 'active', $3)`,
      [id, subjectId, `${id}@example.test`],
    );
  }

  test('the global floor uses strict less-than and an incident bump does not lower it', async () => {
    const revocation = store();
    const floorAt = new Date('2026-08-20T06:00:00.400Z');
    await anchorFloor(floorAt);
    const floor = Math.floor(floorAt.getTime() / 1_000);
    const probe = {
      issuer: ISSUER, subject: 'floor-subject', clientId: CLIENT_ID,
      tokenId: 'floor-jti', credentialDigest: 'floor-digest',
    };
    assert.equal(await revocation.isRevoked({ ...probe, issuedAtSeconds: floor }), false);
    assert.equal(await revocation.isRevoked({ ...probe, issuedAtSeconds: floor - 1 }), true);
    const future = new Date(Date.now() + 86_400_000);
    await anchorFloor(future);
    const before = await readFloor();
    const bumped = await revocation.bumpSecurityEpoch('known.incident:boundary');
    const after = await readFloor();
    assert.equal(bumped.value, 'known.incident:boundary');
    assert.ok(after.effectiveAt.getTime() >= before.effectiveAt.getTime());
    assert.equal(after.effectiveAt.getTime(), future.getTime());
    const futureFloor = Math.floor(future.getTime() / 1_000);
    assert.equal(await revocation.isRevoked({ ...probe, tokenId: 'future-jti', issuedAtSeconds: futureFloor - 1 }), true);
    assert.equal(await revocation.isRevoked({ ...probe, tokenId: 'future-same', issuedAtSeconds: futureFloor }), false);
  });

  test('a password change rejects only that account, including same-second iat', async () => {
    const past = new Date(Date.now() - 3_600_000);
    await anchorFloor(past);
    const beforeFloor = await readFloor();
    await insertAccount('boundary-acct-a', 'boundary-subject-a');
    await insertAccount('boundary-acct-b', 'boundary-subject-b');
    const pool = isolated.runtime.pool;
    for (const [userId, accountId] of [['boundary-user-a', 'boundary-acct-a'], ['boundary-user-b', 'boundary-acct-b']] as const) {
      await pool.query(
        `insert into auth_users(id, name, email, "emailVerified") values ($1, $2, $3, true)`,
        [userId, userId, `${userId}@example.test`],
      );
      await pool.query(
        `insert into auth_user_account_map(auth_user_id, account_id) values ($1, $2)`,
        [userId, accountId],
      );
      await pool.query(
        `insert into auth_accounts(id, "accountId", "providerId", "userId", issuer, "createdAt", "updatedAt")
         values ($1, $2, 'credential', $2, 'credential', now(), now())`,
        [`cred-${userId}`, userId],
      );
    }
    const builtIn = verifier(true);
    const external = verifier(false);
    const issuedAt = Math.floor(Date.now() / 1_000) - 30;
    const aOldBuiltIn = await mint({
      subject: 'boundary-subject-a', issuedAtSeconds: issuedAt, knownAccountEpoch: '0', jti: 'a-old-builtin',
    });
    const bOldBuiltIn = await mint({
      subject: 'boundary-subject-b', issuedAtSeconds: issuedAt, knownAccountEpoch: '0', jti: 'b-old-builtin',
    });
    const aOldExternal = await mint({
      subject: 'boundary-subject-a', issuedAtSeconds: issuedAt, jti: 'a-old-external',
    });
    const bOldExternal = await mint({
      subject: 'boundary-subject-b', issuedAtSeconds: issuedAt, jti: 'b-old-external',
    });
    assert.equal((await builtIn.verify({ authorization: `Bearer ${aOldBuiltIn}` })).accountSubjectId, 'boundary-subject-a');
    assert.equal((await external.verify({ authorization: `Bearer ${bOldExternal}` })).accountSubjectId, 'boundary-subject-b');

    await pool.query(`update auth_accounts set password = 'hash-a', "updatedAt" = now() where "userId" = 'boundary-user-a'`);
    const stamp = await pool.query<{ security_epoch: string; security_epoch_bumped_at: Date | string }>(
      'select security_epoch::text, security_epoch_bumped_at from accounts where id = $1',
      ['boundary-acct-a'],
    );
    assert.equal(stamp.rows[0]!.security_epoch, '1');
    const bumpedAt = new Date(stamp.rows[0]!.security_epoch_bumped_at);
    assert.ok(!Number.isNaN(bumpedAt.getTime()));
    const other = await pool.query<{ security_epoch: string }>(
      'select security_epoch::text from accounts where id = $1',
      ['boundary-acct-b'],
    );
    assert.equal(other.rows[0]!.security_epoch, '0');
    const afterPassword = await readFloor();
    assert.equal(afterPassword.epoch, beforeFloor.epoch);
    assert.equal(afterPassword.effectiveAt.getTime(), beforeFloor.effectiveAt.getTime());

    const eventSecond = Math.floor(bumpedAt.getTime() / 1_000);
    const aNewBuiltIn = await mint({
      subject: 'boundary-subject-a', issuedAtSeconds: eventSecond, knownAccountEpoch: '1', jti: 'a-new-builtin',
    });
    const aSameSecondExternal = await mint({
      subject: 'boundary-subject-a', issuedAtSeconds: eventSecond, jti: 'a-same-external',
    });
    const aPreviousSecondExternal = await mint({
      subject: 'boundary-subject-a', issuedAtSeconds: eventSecond - 1, jti: 'a-prev-external',
    });

    await assert.rejects(
      () => builtIn.verify({ authorization: `Bearer ${aOldBuiltIn}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
    await assert.rejects(
      () => external.verify({ authorization: `Bearer ${aOldExternal}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
    await assert.rejects(
      () => external.verify({ authorization: `Bearer ${aPreviousSecondExternal}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
    assert.equal((await builtIn.verify({ authorization: `Bearer ${aNewBuiltIn}` })).evidence.principalId, 'boundary-acct-a');
    assert.equal((await external.verify({ authorization: `Bearer ${aSameSecondExternal}` })).evidence.principalId, 'boundary-acct-a');
    assert.equal((await builtIn.verify({ authorization: `Bearer ${bOldBuiltIn}` })).evidence.principalId, 'boundary-acct-b');
    assert.equal((await external.verify({ authorization: `Bearer ${bOldExternal}` })).evidence.principalId, 'boundary-acct-b');
    const missing = await mint({
      subject: 'boundary-missing', issuedAtSeconds: eventSecond, jti: 'missing-map',
    });
    await assert.rejects(
      () => builtIn.verify({ authorization: `Bearer ${missing}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'invalid_token',
    );

    const survivorAt = Math.max(eventSecond, Math.floor(Date.now() / 1_000));
    const aSurvivor = await mint({
      subject: 'boundary-subject-a', issuedAtSeconds: survivorAt, knownAccountEpoch: '1', jti: 'a-survivor',
    });
    const bSurvivor = await mint({
      subject: 'boundary-subject-b', issuedAtSeconds: survivorAt, knownAccountEpoch: '0', jti: 'b-survivor',
    });
    assert.equal((await builtIn.verify({ authorization: `Bearer ${aSurvivor}` })).accountSubjectId, 'boundary-subject-a');
    assert.equal((await builtIn.verify({ authorization: `Bearer ${bSurvivor}` })).accountSubjectId, 'boundary-subject-b');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const incident = await store().bumpSecurityEpoch('known.incident:all-accounts');
    assert.ok(incident.effectiveAt.getTime() >= beforeFloor.effectiveAt.getTime());
    await assert.rejects(
      () => builtIn.verify({ authorization: `Bearer ${aSurvivor}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
    await assert.rejects(
      () => builtIn.verify({ authorization: `Bearer ${bSurvivor}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
  });

  test('a failed revokeAll commits nothing, and propagation failure does not revoke again', async () => {
    await anchorFloor(new Date(Date.now() - 3_600_000));
    const floorBefore = await readFloor();
    await insertAccount('boundary-acct-c', 'boundary-subject-c');
    await insertAccount('boundary-acct-d', 'boundary-subject-d');
    const external = verifier(false);
    const issuedAt = Math.floor(Date.now() / 1_000) - 30;
    const oldC = await mint({ subject: 'boundary-subject-c', issuedAtSeconds: issuedAt, jti: 'c-old' });
    const oldD = await mint({ subject: 'boundary-subject-d', issuedAtSeconds: issuedAt, jti: 'd-old' });
    assert.equal((await external.verify({ authorization: `Bearer ${oldC}` })).evidence.principalId, 'boundary-acct-c');

    const authorityOptions = {
      db: isolated.runtime.db,
      betterAuth: {
        async getSession() { return null; },
        async signOut() {},
      } satisfies BetterAuthServerPort,
      secret: 'boundary-better-auth-secret-0123456789', // secret-scan: allow 'boundary-better-auth-secret-0123456789'
      sessionExpiresInSeconds: 86_400,
      sessionTokenProtector: createBetterAuthSessionTokenProtector({
        keys: [{ version: 1, key: Buffer.alloc(32, 9) }],
        legacyPlaintextReadUntil: null,
      }),
    };
    const pool = isolated.runtime.pool;
    await pool.query(
      `create function reject_mcp_boundary_epoch() returns trigger language plpgsql as $$
       begin raise exception 'epoch unavailable'; end $$`,
    );
    await pool.query(
      `create trigger reject_mcp_boundary_epoch before update of security_epoch on accounts
       for each row execute function reject_mcp_boundary_epoch()`,
    );
    try {
      const blocked = createBetterAuthSessionAuthority(authorityOptions);
      await assert.rejects(() => blocked.revokeAll('boundary-acct-c'));
      const rolled = await pool.query<{ security_epoch: string; security_epoch_bumped_at: Date | null }>(
        'select security_epoch::text, security_epoch_bumped_at from accounts where id = $1',
        ['boundary-acct-c'],
      );
      assert.equal(rolled.rows[0]!.security_epoch, '0');
      assert.equal(rolled.rows[0]!.security_epoch_bumped_at, null);
      assert.equal((await external.verify({ authorization: `Bearer ${oldC}` })).evidence.principalId, 'boundary-acct-c');
    } finally {
      await pool.query('drop trigger if exists reject_mcp_boundary_epoch on accounts');
      await pool.query('drop function if exists reject_mcp_boundary_epoch()');
    }

    let deliveries = 0;
    const bridge = createSecurityEpochBridge({
      authority: createBetterAuthSessionAuthority(authorityOptions),
      propagation: {
        async propagate() {
          deliveries += 1;
          throw new Error('notification downstream unavailable');
        },
      },
    });
    const raised = await bridge.raiseAccountSecurityEvent('mfa_disable', 'boundary-acct-c');
    assert.equal(raised.securityEpoch, 1n);
    assert.equal(deliveries, 1);
    const committed = await pool.query<{ security_epoch: string }>(
      'select security_epoch::text from accounts where id = $1',
      ['boundary-acct-c'],
    );
    assert.equal(committed.rows[0]!.security_epoch, '1');
    const lines: string[] = [];
    const notify = createAccountSecurityEventNotification({
      info(_bindings, message) { lines.push(message); },
      warn() { throw new Error('unused'); },
    });
    await notify.propagate({ accountId: 'boundary-acct-c', event: 'mfa_disable' });
    await notify.propagate({ accountId: 'boundary-acct-c', event: 'mfa_disable' });
    assert.equal(lines.length, 2);
    const still = await pool.query<{ security_epoch: string }>(
      'select security_epoch::text from accounts where id = $1',
      ['boundary-acct-c'],
    );
    assert.equal(still.rows[0]!.security_epoch, '1');
    const other = await pool.query<{ security_epoch: string }>(
      'select security_epoch::text from accounts where id = $1',
      ['boundary-acct-d'],
    );
    assert.equal(other.rows[0]!.security_epoch, '0');
    const floorAfter = await readFloor();
    assert.equal(floorAfter.epoch, floorBefore.epoch);
    assert.equal(floorAfter.effectiveAt.getTime(), floorBefore.effectiveAt.getTime());
    await assert.rejects(
      () => external.verify({ authorization: `Bearer ${oldC}` }),
      (error: unknown) => error instanceof McpOauthVerificationError && error.reason === 'revoked',
    );
    assert.equal((await external.verify({ authorization: `Bearer ${oldD}` })).evidence.principalId, 'boundary-acct-d');
  });
});
