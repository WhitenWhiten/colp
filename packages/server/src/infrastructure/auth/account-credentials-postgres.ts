import type { Kysely } from 'kysely';
import {
  createChildCredential,
  getDirectChildCredential,
  listDirectChildren,
  revokeCredential,
  rotateCredential,
  authenticateParentKey,
  authenticateChildKey,
  loadCredentialAuthority,
  type AccountCredentialCommandPorts,
  type AccountCredentialListFilters,
  type AccountCredentialRecord,
  type AccountCredentialStore,
  type CreateChildInput,
  type IssuanceLimiterPort,
  type RevokeCredentialInput,
  type RotateCredentialInput,
} from '../../modules/auth/index.js';
import { ensureAccountHandle, generateOpaqueId } from '../../modules/identity/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import {
  createPostgresAccountRepository,
  createPostgresIdentityClock,
  createPostgresProfileHandleRepository,
  createPostgresProfileRepository,
} from '../identity/repositories.js';
import type {
  AccountCredentialCursorCodec,
  CredentialGrantMachineBindingPort,
  CredentialPlanPort,
} from '../../modules/auth/index.js';
import {
  createPostgresCredentialGrantStore,
  createPostgresGrantResourcePort,
} from './account-credential-grants-postgres.js';

export interface AccountCredentialGrantRuntime {
  readonly plansInTransaction: (transaction: DatabaseTransaction) => CredentialPlanPort;
  readonly machine: CredentialGrantMachineBindingPort;
}

export interface PostgresAccountCredentialUnitOfWork {
  execute<Result>(
    work: (ports: AccountCredentialCommandPorts & { readonly issuance?: IssuanceLimiterPort }) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export function createPostgresAccountCredentialStore(
  transaction: DatabaseTransaction,
): AccountCredentialStore {
  return {
    async insert(record) {
      await transaction.insertInto('account_credentials').values(toRow(record)).execute();
    },
    async findById(id) {
      const row = await transaction.selectFrom('account_credentials').selectAll()
        .where('id', '=', id).executeTakeFirst();
      return row ? fromRow(row) : null;
    },
    async findBySecretHash(secretHash) {
      const row = await transaction.selectFrom('account_credentials').selectAll()
        .where('secret_hash', '=', secretHash).executeTakeFirst();
      return row ? fromRow(row) : null;
    },
    async findByMcpClientId(mcpClientId) {
      const row = await transaction.selectFrom('account_credentials').selectAll()
        .where('mcp_client_id', '=', mcpClientId).executeTakeFirst();
      return row ? fromRow(row) : null;
    },
    async lockById(id) {
      const row = await transaction.selectFrom('account_credentials').selectAll()
        .where('id', '=', id).forUpdate().executeTakeFirst();
      return row ? fromRow(row) : null;
    },
    async listChildren(input) {
      let query = transaction.selectFrom('account_credentials').selectAll()
        .where('parent_id', '=', input.parentId);
      if (input.after) {
        query = query.where((eb) => eb.or([
          eb('created_at', '>', input.after!.createdAt),
          eb.and([
            eb('created_at', '=', input.after!.createdAt),
            eb('id', '>', input.after!.id),
          ]),
        ]));
      }
      const rows = await query.orderBy('created_at').orderBy('id').limit(input.limit).execute();
      return rows.map(fromRow);
    },
    async replaceSecret(input) {
      const row = await transaction.updateTable('account_credentials').set({
        secret_hash: input.secretHash,
        prefix: input.prefix,
        expires_at: input.expiresAt,
        revision: input.revision,
        epoch: input.epoch,
      }).where('id', '=', input.id)
        .where('revision', '=', input.expectedRevision)
        .returningAll().executeTakeFirst();
      return row ? fromRow(row) : null;
    },
    async revoke(input) {
      const row = await transaction.updateTable('account_credentials').set({
        state: 'revoked',
        revoked_at: input.revokedAt,
        revoke_reason: input.reason,
        revision: input.revision,
      }).where('id', '=', input.id)
        .where('revision', '=', input.expectedRevision)
        .returningAll().executeTakeFirst();
      return row ? fromRow(row) : null;
    },
    async touchLastUsed(id, lastUsedAt) {
      await transaction.updateTable('account_credentials')
        .set({ last_used_at: lastUsedAt })
        .where('id', '=', id)
        .execute();
    },
  };
}

export function createPostgresAccountCredentialPorts(
  transaction: DatabaseTransaction,
  issuance?: IssuanceLimiterPort,
  grantRuntime?: AccountCredentialGrantRuntime,
  options: { readonly secretHmacKey?: string } = {},
): AccountCredentialCommandPorts & { readonly issuance?: IssuanceLimiterPort } {
  const accounts = createPostgresAccountRepository(transaction);
  const profiles = createPostgresProfileRepository(transaction);
  const handles = createPostgresProfileHandleRepository(transaction);
  const clock = createPostgresIdentityClock(transaction);
  return {
    receipts: createPostgresProductCommandReceiptPort(transaction),
    credentials: createPostgresAccountCredentialStore(transaction),
    accounts: {
      findAccountById: (id) => accounts.findById(id),
      lockAccountById: async (id) => {
        const row = await transaction.selectFrom('accounts').selectAll()
          .where('id', '=', id).forUpdate().executeTakeFirst();
        return row ? (await createPostgresAccountRepository(transaction).findById(row.id)) : null;
      },
      insertAccount: (account) => accounts.insert(account),
      insertProfile: (profile) => profiles.insert(profile),
      ensureHandle: (accountId) => ensureAccountHandle({ accounts, handles, clock }, accountId),
    },
    clock,
    ids: {
      nextCredentialId: generateOpaqueId,
      nextAccountId: generateOpaqueId,
      nextSubjectId: generateOpaqueId,
      nextGrantId: generateOpaqueId,
    },
    grants: createPostgresCredentialGrantStore(transaction),
    resources: createPostgresGrantResourcePort(transaction),
    ...(grantRuntime
      ? {
          plans: grantRuntime.plansInTransaction(transaction),
          machine: grantRuntime.machine,
        }
      : {}),
    ...(issuance ? { issuance } : {}),
    // AC-F003: deployment HMAC key for stored secret hashes (may be absent).
    ...(options.secretHmacKey !== undefined ? { secretHmacKey: options.secretHmacKey } : {}),
  } as AccountCredentialCommandPorts & { readonly issuance?: IssuanceLimiterPort };
}

export function createPostgresAccountCredentialUnitOfWork(
  db: Kysely<DatabaseSchema>,
  issuance?: IssuanceLimiterPort,
  grantRuntime?: AccountCredentialGrantRuntime,
  options: { readonly secretHmacKey?: string } = {},
): PostgresAccountCredentialUnitOfWork {
  return {
    execute(work) {
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work(createPostgresAccountCredentialPorts(transaction, issuance, grantRuntime, options)));
    },
  };
}

export function createAccountCredentialApplication(input: {
  readonly unitOfWork: PostgresAccountCredentialUnitOfWork;
  readonly cursors: AccountCredentialCursorCodec | null;
}) {
  return {
    createChild(managerAccountId: string, parentId: string, commandId: string, body: CreateChildInput, actor: 'manager' | 'parent-key') {
      return input.unitOfWork.execute((ports) => createChildCredential(ports, {
        managerAccountId, parentId, commandId, body, actor,
      }));
    },
    rotate(managerAccountId: string, credentialId: string, commandId: string, ifMatch: string | undefined, body: RotateCredentialInput, parentId?: string) {
      return input.unitOfWork.execute((ports) => rotateCredential(ports, {
        managerAccountId, credentialId, commandId, ifMatch, body, parentId,
      }));
    },
    revoke(managerAccountId: string, credentialId: string, commandId: string, ifMatch: string | undefined, body: RevokeCredentialInput, parentId?: string) {
      return input.unitOfWork.execute((ports) => revokeCredential(ports, {
        managerAccountId, credentialId, commandId, ifMatch, body, parentId,
      }));
    },
    getChild(parentId: string, credentialId: string) {
      return input.unitOfWork.execute((ports) => getDirectChildCredential(ports, { parentId, credentialId }));
    },
    listChildren(parent: AccountCredentialRecord, filters: AccountCredentialListFilters) {
      if (!input.cursors) throw new Error('account credential cursor codec is required');
      const cursors = input.cursors;
      return input.unitOfWork.execute((ports) => listDirectChildren({ ...ports, cursors }, { parent, filters }));
    },
    authenticateParent(secret: string) {
      return input.unitOfWork.execute((ports) => authenticateParentKey(ports, secret));
    },
    authenticateChild(secret: string) {
      return input.unitOfWork.execute((ports) => authenticateChildKey(ports, secret));
    },
    loadAuthority(credentialId: string) {
      return input.unitOfWork.execute((ports) => loadCredentialAuthority(ports, credentialId));
    },
    exchange(work: (ports: AccountCredentialCommandPorts) => Promise<unknown>) {
      return input.unitOfWork.execute(work);
    },
  };
}

function toRow(record: AccountCredentialRecord) {
  return {
    id: record.id,
    kind: record.kind,
    parent_id: record.parentId,
    account_id: record.accountId,
    subject_id: record.subjectId,
    manager_account_id: record.managerAccountId,
    label: record.label,
    prefix: record.prefix,
    secret_hash: record.secretHash,
    state: record.state,
    revision: record.revision,
    epoch: record.epoch,
    expires_at: record.expiresAt,
    created_at: record.createdAt,
    last_used_at: record.lastUsedAt,
    revoked_at: record.revokedAt,
    revoke_reason: record.revokeReason,
    mcp_client_id: record.mcpClientId,
  };
}

function fromRow(row: {
  readonly id: string;
  readonly kind: 'parent' | 'child';
  readonly parent_id: string | null;
  readonly account_id: string;
  readonly subject_id: string;
  readonly manager_account_id: string;
  readonly label: string;
  readonly prefix: string;
  readonly secret_hash: string;
  readonly state: 'active' | 'revoked';
  readonly revision: bigint | number | string;
  readonly epoch: bigint | number | string;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoke_reason: string | null;
  readonly mcp_client_id: string;
}): AccountCredentialRecord {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    accountId: row.account_id,
    subjectId: row.subject_id,
    managerAccountId: row.manager_account_id,
    label: row.label,
    prefix: row.prefix,
    secretHash: row.secret_hash,
    state: row.state,
    revision: typeof row.revision === 'bigint' ? row.revision : BigInt(row.revision),
    epoch: typeof row.epoch === 'bigint' ? row.epoch : BigInt(row.epoch),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    mcpClientId: row.mcp_client_id,
  };
}
