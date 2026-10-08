import type { ProductCommandReceiptPort } from '../../../commands/index.js';
import type { Account, ProfileHandle } from '../../../identity/index.js';
import type { AccountCredentialKind } from './secret.js';

export type AccountCredentialState = 'active' | 'revoked' | 'expired';

export interface AccountCredentialRecord {
  readonly id: string;
  readonly kind: AccountCredentialKind;
  readonly parentId: string | null;
  readonly accountId: string;
  readonly subjectId: string;
  readonly managerAccountId: string;
  readonly label: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly state: 'active' | 'revoked';
  readonly revision: bigint;
  readonly epoch: bigint;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
  readonly mcpClientId: string;
}

export interface AccountCredentialDto {
  readonly id: string;
  readonly kind: AccountCredentialKind;
  readonly parentId: string | null;
  readonly accountId: string;
  readonly subjectId: string;
  readonly label: string;
  readonly prefix: string;
  readonly state: AccountCredentialState;
  readonly revision: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface AccountCredentialIssuedDto {
  readonly credential: AccountCredentialDto;
  readonly secret: string | null;
  readonly secretAvailable: boolean;
}

export interface AccountCredentialPageDto {
  readonly items: readonly AccountCredentialDto[];
  readonly nextCursor: string | null;
}

export type CreateChildAccountInput =
  | { readonly mode: 'new'; readonly displayName?: string }
  | { readonly mode: 'existing'; readonly accountId: string };

export interface CreateChildInput {
  readonly label: string;
  readonly expiresAt: string;
  readonly account: CreateChildAccountInput;
}

export interface RotateCredentialInput {
  readonly expiresAt: string;
}

export interface RevokeCredentialInput {
  readonly reason: string;
}

export interface AccountCredentialListFilters {
  readonly kind?: AccountCredentialKind;
  readonly state?: AccountCredentialState;
  readonly limit: number;
  readonly cursor?: string;
}

export interface AccountCredentialClock {
  now(): Promise<Date>;
}

export interface AccountCredentialStore {
  insert(record: AccountCredentialRecord): Promise<void>;
  findById(id: string): Promise<AccountCredentialRecord | null>;
  findBySecretHash(secretHash: string): Promise<AccountCredentialRecord | null>;
  findByMcpClientId(mcpClientId: string): Promise<AccountCredentialRecord | null>;
  lockById(id: string): Promise<AccountCredentialRecord | null>;
  listChildren(input: {
    readonly parentId: string;
    readonly after?: { readonly createdAt: Date; readonly id: string };
    readonly limit: number;
  }): Promise<readonly AccountCredentialRecord[]>;
  replaceSecret(input: {
    readonly id: string;
    readonly expectedRevision: bigint;
    readonly secretHash: string;
    readonly prefix: string;
    readonly expiresAt: Date;
    readonly revision: bigint;
    readonly epoch: bigint;
  }): Promise<AccountCredentialRecord | null>;
  revoke(input: {
    readonly id: string;
    readonly expectedRevision: bigint;
    readonly reason: string;
    readonly revokedAt: Date;
    readonly revision: bigint;
  }): Promise<AccountCredentialRecord | null>;
  touchLastUsed(id: string, lastUsedAt: Date): Promise<void>;
}

export interface AccountCredentialAccountPorts {
  findAccountById(id: string): Promise<Account | null>;
  insertAccount(account: Account): Promise<void>;
  insertProfile(profile: {
    readonly accountId: string;
    readonly displayName: string;
    readonly avatarUrl: string | null;
    readonly about: string;
    readonly updatedAt: Date;
  }): Promise<void>;
  ensureHandle(accountId: string): Promise<ProfileHandle>;
}

export interface AccountCredentialCommandPorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly credentials: AccountCredentialStore;
  readonly accounts: AccountCredentialAccountPorts;
  readonly clock: AccountCredentialClock;
  readonly ids: { nextCredentialId(): string; nextAccountId(): string; nextSubjectId(): string; nextGrantId(): string };
  /** AC-F003: deployment HMAC key for stored secret hashes; absent = bare
   * SHA-256 fallback (tests/unconfigured). Inject via the UoW options. */
  readonly secretHmacKey?: string;
}

export const ACCOUNT_CREDENTIAL_COMMAND_CONTRACT_VERSION = '1.0.0';
export const ACCOUNT_CREDENTIAL_PAGE_BYTE_BUDGET = 65_536;
export const ACCOUNT_CREDENTIAL_MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;
export const ACCOUNT_CREDENTIAL_CURSOR_TTL_MS = 900_000;
