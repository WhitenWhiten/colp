import { randomInt } from 'node:crypto';
import {
  HANDLE_ADJECTIVES,
  HANDLE_NOUNS,
  generateOpaqueId,
  type Account,
  type Profile,
} from '../../../identity/index.js';
import type { AccountCredentialAccountPorts } from './types.js';

function pick(words: readonly string[]): string {
  return words[randomInt(words.length)]!;
}

function titleCase(word: string): string {
  return word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`;
}

export function generateOrdinaryDisplayName(): string {
  return `${titleCase(pick(HANDLE_ADJECTIVES))} ${titleCase(pick(HANDLE_NOUNS))}`;
}

export async function provisionIndependentAccount(
  ports: AccountCredentialAccountPorts,
  now: Date,
  displayName: string | undefined,
): Promise<{ readonly account: Account; readonly profile: Profile }> {
  const account: Account = {
    id: generateOpaqueId(),
    subjectId: generateOpaqueId(),
    status: 'active',
    email: null,
    securityEpoch: 0n,
    createdAt: now,
    deletedAt: null,
  };
  await ports.insertAccount(account);
  const profile: Profile = {
    accountId: account.id,
    displayName: displayName && displayName.length > 0 ? displayName : generateOrdinaryDisplayName(),
    avatarUrl: null,
    about: '',
    updatedAt: now,
  };
  await ports.insertProfile(profile);
  await ports.ensureHandle(account.id);
  return { account, profile };
}
