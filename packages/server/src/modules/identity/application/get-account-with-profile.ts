import { IdentityError } from '../domain/index.js';
import type { AccountWithProfile } from '../domain/types.js';
import type { IdentityPorts } from './ports.js';

export async function getAccountWithProfile(
  ports: IdentityPorts,
  accountId: string,
): Promise<AccountWithProfile> {
  const account = await ports.accounts.findById(accountId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  const profile = await ports.profiles.findByAccountId(accountId);
  if (!profile) {
    throw new IdentityError('account_not_found', 'profile for account is missing');
  }
  const handle = await ports.handles.findByAccountId(accountId);
  const identity = await ports.accountIdentities.findByAccountId(accountId);
  return { account, profile, handle, identity };
}

export async function getAccountWithProfileBySubjectId(
  ports: IdentityPorts,
  subjectId: string,
): Promise<AccountWithProfile> {
  const account = await ports.accounts.findBySubjectId(subjectId);
  if (!account) {
    throw new IdentityError('account_not_found', 'account was not found');
  }
  return getAccountWithProfile(ports, account.id);
}
