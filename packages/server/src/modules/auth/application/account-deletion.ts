/** Reauthenticated account deletion commits through one atomic persistence boundary. */
import type { BrowserSessionAuthority } from './browser-session-authority.js';
import type { OAuthLinkServerPort, ReauthProof, ReauthVerifier } from './account-linking.js';
import { AccountLinkingError } from './account-linking.js';

export const ACCOUNT_DELETE_CONFIRMATION = 'DELETE';

export type AccountDeletionErrorCode = 'reauth_failed' | 'invalid_confirmation';

export class AccountDeletionError extends Error {
  readonly code: AccountDeletionErrorCode;

  constructor(code: AccountDeletionErrorCode, message: string) {
    super(message);
    this.name = 'AccountDeletionError';
    this.code = code;
  }
}

/** Server-side Better Auth user lookup/delete (composition implements over `$context.internalAdapter`). */
export interface BetterAuthUserDeletionPort {
  getAuthUserId(input: { readonly cookie: string | undefined }): Promise<string | null>;
}

export interface AccountDeletionStore {
  complete(accountId: string, authUserId: string): Promise<void>;
}

export interface AccountDeletionPorts {
  readonly authority: BrowserSessionAuthority;
  readonly server: Pick<OAuthLinkServerPort, 'getUserEmail'>;
  readonly reauth: ReauthVerifier;
  readonly store: AccountDeletionStore;
  readonly betterAuthUsers: BetterAuthUserDeletionPort;
}

export interface AccountDeletionService {
  deleteAccount(input: {
    readonly cookie: string | undefined;
    readonly confirmation: string;
    readonly reauth: ReauthProof;
  }): Promise<void>;
}

async function verifyReauth(
  ports: AccountDeletionPorts,
  cookie: string | undefined,
  proof: ReauthProof,
): Promise<void> {
  if (proof.kind === 'password') {
    const ok = await ports.reauth.verifyPassword({ cookie, password: proof.password });
    if (!ok) {
      throw new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid');
    }
    return;
  }
  const sessionEmail = await ports.server.getUserEmail({ cookie });
  if (sessionEmail === null || sessionEmail.toLowerCase() !== proof.email.toLowerCase()) {
    throw new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid');
  }
  const ok = await ports.reauth.verifyOtp({ email: proof.email, otp: proof.otp });
  if (!ok) {
    throw new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid');
  }
}

export function createAccountDeletionService(ports: AccountDeletionPorts): AccountDeletionService {
  return {
    async deleteAccount({ cookie, confirmation, reauth }) {
      const actor = await ports.authority.requireMutationActor({ cookie }, { touch: true });
      if (confirmation !== ACCOUNT_DELETE_CONFIRMATION) {
        throw new AccountDeletionError('invalid_confirmation', 'typed confirmation is required');
      }
      await verifyReauth(ports, cookie, reauth);
      const authUserId = await ports.betterAuthUsers.getAuthUserId({ cookie });
      if (authUserId === null) {
        throw new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid');
      }
      await ports.store.complete(actor.account.id, authUserId);
    },
  };
}
