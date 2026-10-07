import { test, expect } from 'vitest';
import { createIsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createBetterAuthSessionAuthority } from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { browserSessionCsrfTokenHash, browserSessionTokenHash, deriveBrowserSessionCsrfTokenRaw } from '../../../src/modules/auth/index.js';
import { createTestSessionTokenProtector } from '../../support/better-auth-session-token-protection.js';

for (const expiry of ['idle', 'absolute'] as const) {
for (const entry of ['authenticate', 'requireMutationActor', 'bootstrap'] as const) {
test(`AUTH-05: ${entry} commits ${expiry} expiry revocation`, async () => {
  const isolated = await createIsolatedPostgresRuntime('auth_review_expiry');
  try {
    await runMigrations(isolated.runtime.db, 'latest');
    const { pool, db } = isolated.runtime;
    const token = 'audit-expiry-token';
    await pool.query(`insert into accounts(id,subject_id,status,email) values ('acct','subject','active','audit@example.test')`);
    await pool.query(`insert into auth_users(id,name,email,"emailVerified") values ('usr','Audit','audit@example.test',true)`);
    await pool.query(`insert into auth_user_account_map(auth_user_id,account_id) values ('usr','acct')`);
    await pool.query(`insert into auth_sessions(id,token,"expiresAt","createdAt","updatedAt","userId") values ('sess',$1,now()+interval '1 day',now(),now(),'usr')`, [token]);
    await pool.query(`insert into known_auth_session_metadata(auth_session_id,session_token_hash,account_id,idle_expires_at,absolute_expires_at,security_epoch,csrf_token_hash,last_seen_at,created_at) values ('sess',$1,'acct',now()-interval '1 second',now()+interval '1 day',0,$2,now()-interval '2 days',now()-interval '2 days')`, [browserSessionTokenHash(token), browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token))]);
    // Carrier seam intentionally fixed: this case tests the REAL PostgreSQL
    // metadata transaction, not Better Auth signature/refresh behavior.
    const authority = createBetterAuthSessionAuthority({
      db, secret: 'audit-only-secret', sessionExpiresInSeconds: 86400,
      sessionTokenProtector: createTestSessionTokenProtector(),
      betterAuth: { getSession: async () => ({ id: 'sess', userId: 'usr', token, expiresAt: new Date(Date.now()+86400000), emailVerified: true }), signOut: async () => {} },
    });
    const request = { cookie: `__Host-known_session=${token}.signature` };
    if (expiry === 'absolute') {
      await pool.query("update known_auth_session_metadata set idle_expires_at=now()-interval '1 second', absolute_expires_at=now()-interval '1 second'");
    }
    if (entry === 'requireMutationActor') {
      await expect(authority.requireMutationActor(request)).rejects.toMatchObject({ code: 'authentication_required' });
    } else if (entry === 'bootstrap') {
      expect(await authority.bootstrap(request)).toEqual({ authenticated: false });
    } else {
      expect(await authority.authenticate(request)).toBe(null);
    }
    const result = await pool.query("select revoked_at from known_auth_session_metadata where auth_session_id='sess'");
    expect(result.rows[0].revoked_at).not.toBe(null);

  } finally { await isolated.close(); }
}, 120000);

}
}
