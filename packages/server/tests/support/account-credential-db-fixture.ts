import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../src/infrastructure/database/runtime.js';
import { issueAccountCredentialSecret } from '../../src/modules/auth/index.js';

/** Mirrors operator-only provisioning: no HTTP endpoint can create a parent. */
export async function insertTestParentCredential(
  db: Kysely<DatabaseSchema>,
  actor: { accountId: string; subjectId: string },
  secretHmacKey: string,
  expiresAt: string,
) {
  const issued = issueAccountCredentialSecret('parent', secretHmacKey);
  const id = randomUUID();
  await db.insertInto('account_credentials').values({
    id, kind: 'parent', parent_id: null, account_id: actor.accountId,
    subject_id: actor.subjectId, manager_account_id: actor.accountId,
    label: 'operator-provisioned', prefix: issued.prefix, secret_hash: issued.secretHash,
    state: 'active', revision: 1n, epoch: 1n, expires_at: new Date(expiresAt),
    created_at: new Date(), last_used_at: null, revoked_at: null, revoke_reason: null,
    mcp_client_id: issued.mcpClientId,
  }).execute();
  return { id, secret: issued.secret };
}
