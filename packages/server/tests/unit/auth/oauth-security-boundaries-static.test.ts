import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const migration = (name: string) => new URL(`../../../migrations/${name}`, import.meta.url);
const source = (name: string) => new URL(`../../../src/${name}`, import.meta.url);

test('OAuth refresh-family revocation uses the nullable timestamp predicate', async () => {
  const [sessionAuthority, businessAccounts] = await Promise.all([
    readFile(source('infrastructure/auth/better-auth-session-authority.ts'), 'utf8'),
    readFile(source('infrastructure/auth/business-account-repositories.ts'), 'utf8'),
  ]);

  for (const implementation of [sessionAuthority, businessAccounts]) {
    assert.match(implementation, /SET\s+"revoked"\s*=\s*clock_timestamp\(\)/u);
    assert.match(implementation, /AND\s+"revoked"\s+IS\s+NULL/u);
    assert.doesNotMatch(implementation, /"revoked"\s+IS\s+DISTINCT\s+FROM\s+true/u);
  }
});

test('password INSERT triggers guard OLD access and preserve the insert trigger', async () => {
  const [security, oauth, globalEpoch, creation] = await Promise.all([
    readFile(migration('202610201001_password_security_transaction.ts'), 'utf8'),
    readFile(migration('202610201004_password_oauth_refresh_revocation.ts'), 'utf8'),
    readFile(migration('202610220200_stop_password_global_mcp_epoch.ts'), 'utf8'),
    readFile(migration('202610201005_password_creation_security_transaction.ts'), 'utf8'),
  ]);

  for (const implementation of [security, globalEpoch]) {
    assert.match(
      implementation,
      /IF\s+TG_OP\s*=\s*'UPDATE'\s+THEN\s+IF\s+NEW\.password\s+IS\s+NOT\s+DISTINCT\s+FROM\s+OLD\.password\s+THEN\s+RETURN\s+NEW/iu,
    );
  }
  assert.match(
    oauth,
    /IF\s+TG_OP\s*=\s*'UPDATE'\s+THEN\s+IF\s+NEW\.password\s+IS\s+NOT\s+DISTINCT\s+FROM\s+OLD\.password\s+THEN\s+RETURN\s+NEW/iu,
  );
  assert.match(creation, /AFTER\s+INSERT\s+OR\s+UPDATE\s+OF\s+password\s+ON\s+auth_accounts/iu);
  assert.match(creation, /EXECUTE\s+FUNCTION\s+commit_password_security_event\(\)/iu);
  assert.match(creation, /EXECUTE\s+FUNCTION\s+revoke_password_oauth_grants\(\)/iu);
});
