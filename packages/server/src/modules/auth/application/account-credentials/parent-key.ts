import { AccountCredentialCommandError } from './errors.js';
import { hashAccountCredentialSecret, parseAccountCredentialSecret } from './secret.js';
import { effectiveCredentialState } from './dto.js';
import type {
  AccountCredentialAccountPorts,
  AccountCredentialClock,
  AccountCredentialRecord,
  AccountCredentialStore,
} from './types.js';

export interface ParentKeyActor {
  readonly parent: AccountCredentialRecord;
  readonly accountId: string;
  readonly subjectId: string;
  readonly managerAccountId: string;
}

export async function authenticateParentKey(
  ports: {
    readonly credentials: AccountCredentialStore;
    readonly clock: AccountCredentialClock;
    readonly accounts: AccountCredentialAccountPorts;
    readonly secretHmacKey?: string;
  },
  rawSecret: string,
): Promise<ParentKeyActor> {
  let parsed: ReturnType<typeof parseAccountCredentialSecret>;
  try {
    parsed = parseAccountCredentialSecret(rawSecret);
  } catch {
    throw new AccountCredentialCommandError('invalid_request', 'The parent credential is invalid.');
  }
  if (parsed.kind !== 'parent') {
    throw new AccountCredentialCommandError('invalid_request', 'The parent credential is invalid.');
  }
  const record = await ports.credentials.findBySecretHash(hashAccountCredentialSecret(rawSecret, ports.secretHmacKey));
  const now = await ports.clock.now();
  if (!record || record.kind !== 'parent' || effectiveCredentialState(record, now) !== 'active') {
    throw new AccountCredentialCommandError('invalid_request', 'The parent credential is invalid.');
  }
  const account = await ports.accounts.findAccountById(record.managerAccountId);
  if (!account || account.status !== 'active' || account.deletedAt !== null) {
    throw new AccountCredentialCommandError('invalid_request', 'The parent credential is invalid.');
  }
  await ports.credentials.touchLastUsed(record.id, now);
  return {
    parent: record,
    accountId: record.accountId,
    subjectId: record.subjectId,
    managerAccountId: record.managerAccountId,
  };
}
