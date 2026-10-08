import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
import { createPostgresAccountCredentialUnitOfWork } from '../auth/account-credentials-postgres.js';
import { createChildCredential, issueAccountCredentialSecret, AccountCredentialCommandError } from '../../modules/auth/index.js';

/** Issue a child credential bound to the owner, without exposing a provisioning parent. */
export async function issueAgentKey(db: Kysely<DatabaseSchema>, secretHmacKey: string,
  accountId: string, name: string, commandId: string) {
  const parent = await db.transaction().execute(async (trx) => {
    const account = await trx.selectFrom('accounts').select(['id', 'subject_id'])
      .where('id', '=', accountId).where('status', '=', 'active').forUpdate().executeTakeFirst();
    if (!account) throw new AccountCredentialCommandError('resource_not_found', 'The account is unavailable.');
    const now = new Date();
    const existing = await trx.selectFrom('account_credentials').select(['id', 'expires_at'])
      .where('manager_account_id', '=', accountId).where('kind', '=', 'parent')
      .where('label', '=', 'COLP agent provisioning').where('state', '=', 'active')
      .where('expires_at', '>', new Date(now.getTime() + 86_400_000)).executeTakeFirst();
    if (existing) return existing;
    const issued = issueAccountCredentialSecret('parent', secretHmacKey);
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
    await trx.insertInto('account_credentials').values({
      id, kind: 'parent', parent_id: null, account_id: account.id, subject_id: account.subject_id,
      manager_account_id: account.id, label: 'COLP agent provisioning',
      prefix: issued.prefix, secret_hash: issued.secretHash, mcp_client_id: issued.mcpClientId,
      state: 'active', revision: 1n, epoch: 1n, expires_at: expiresAt, created_at: now,
      last_used_at: null, revoked_at: null, revoke_reason: null,
    }).execute();
    return { id, expires_at: expiresAt };
  });
  const uow = createPostgresAccountCredentialUnitOfWork(db, undefined, undefined, { secretHmacKey });
  const outcome = await uow.execute((ports) => createChildCredential(ports, {
    managerAccountId: accountId, parentId: parent.id, commandId, actor: 'manager',
    body: { label: name, expiresAt: parent.expires_at.toISOString(), account: { mode: 'existing', accountId } },
  }));
  if (outcome.kind !== 'succeeded') {
    // Existing credential issuance receipts deliberately omit the plaintext secret.
    throw new AccountCredentialCommandError('precondition_failed', 'This key was already issued. Its secret cannot be shown again.');
  }
  if (!outcome.body.secret) throw new Error('The key secret is unavailable.');
  const record = await db.selectFrom('account_credentials').select('mcp_client_id')
    .where('id', '=', outcome.body.credential.id).executeTakeFirstOrThrow();
  return { id: record.mcp_client_id, name, secret: outcome.body.secret };
}
