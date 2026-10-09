import { loadConfig } from './config.js';
import { timingSafeEqual } from 'node:crypto';
import {
  createAccountLinkingService,
  createAccountRecoveryService,
  createAccountDeletionService,
  type OAuthLinkServerPort,
  type ReauthVerifier,
  type RecoveryServerPort,
  type BetterAuthUserDeletionPort,
  type BrowserSessionAuthority,
  type AccountLinkingService,
  type AccountRecoveryService,
  type AccountDeletionService,
  sha256Base64Url,
} from '../modules/auth/index.js';
import type { AccountDeletionStore } from '../modules/auth/index.js';
import type { IdentityUnitOfWork } from '../modules/identity/index.js';

export /**
 * C3 recovery/linking server-API surface (structural cast target): the exact
 * `auth.api` calls the recovery and linking ports perform. AUTH-P1-a uses the
 * shared composition instance (same `onPasswordChanged` / occupancy hooks as
 * the HTTP mount); the runtime wires these methods when the emailOTP plugin
 * / social providers are configured (buildBetterAuthOptions), matching the
 * C3 integration-suite usage.
 */
interface RecoveryLinkingAuthApi {
  requestPasswordReset(input: { readonly body: { readonly email: string } }): Promise<unknown>;
  resetPasswordEmailOTP(input: {
    readonly body: { readonly email: string; readonly otp: string; readonly password: string };
  }): Promise<unknown>;
  oAuth2LinkAccount(input: {
    readonly headers: Headers;
    readonly body: {
      readonly providerId: string;
      readonly callbackURL: string;
      readonly errorCallbackURL?: string;
    };
    readonly asResponse: true;
  }): Promise<Response>;
  linkSocialAccount(input: {
    readonly headers: Headers;
    readonly body: {
      readonly provider: string;
      readonly callbackURL: string;
      readonly errorCallbackURL?: string;
    };
    readonly asResponse: true;
  }): Promise<Response>;
  listUserAccounts(input: { readonly headers: Headers }): Promise<ReadonlyArray<{
    /** auth_accounts row id — Better Auth 1.7 unlink takes this, not the provider subject. */
    readonly id: string;
    readonly providerId: string;
    readonly accountId: string;
  }>>;
  unlinkAccount(input: {
    readonly headers: Headers;
    readonly body: { readonly accountId: string };
  }): Promise<unknown>;
  getSession(input: { readonly headers: Headers }): Promise<{
    readonly user?: { readonly id?: string; readonly email?: string | null } | null;
  } | null>;
  verifyPassword(input: {
    readonly headers: Headers;
    readonly body: { readonly password: string };
  }): Promise<unknown>;
  checkVerificationOTP(input: {
    readonly body: { readonly email: string; readonly type: string; readonly otp: string };
  }): Promise<unknown>;
}

export interface ApiAccountServices {
  readonly accountRecovery: AccountRecoveryService | undefined;
  readonly accountLinking: AccountLinkingService | undefined;
  readonly accountDeletion: AccountDeletionService | undefined;
}

interface VerificationValue {
  readonly value: string;
  readonly expiresAt: Date;
}

interface ReauthVerificationAdapter {
  consumeVerificationValue(identifier: string): Promise<VerificationValue | null>;
  createVerificationValue(data: VerificationValue & { readonly identifier: string }): Promise<unknown>;
}

function splitStoredOtpValue(value: string): { readonly hash: string; readonly attempts: string } {
  const index = value.lastIndexOf(':');
  return index < 0
    ? { hash: value, attempts: '' }
    : { hash: value.slice(0, index), attempts: value.slice(index + 1) };
}

function storedOtpMatches(storedHash: string, otp: string): boolean {
  const left = Buffer.from(storedHash, 'utf8');
  const right = Buffer.from(sha256Base64Url(otp), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Consume the email-verification OTP atomically before accepting it as a
 * re-authentication proof.  Better Auth's public `checkVerificationOTP`
 * endpoint intentionally only checks the row, so using it for account link
 * or deletion would leave the same mailbox code reusable until expiry.  This
 * mirrors the plugin's atomic verifier: a wrong attempt recreates the row
 * with an incremented budget, while a correct attempt is never recreated.
 */
async function consumeReauthOtp(
  adapter: ReauthVerificationAdapter,
  email: string,
  otp: string,
  maxAttempts: number,
): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  const identifier = `email-verification-otp-${normalizedEmail}`;
  const consumed = await adapter.consumeVerificationValue(identifier);
  if (consumed === null) return false;
  const { hash, attempts } = splitStoredOtpValue(consumed.value);
  const usedAttempts = attempts === '' ? 0 : Number.parseInt(attempts, 10);
  if (!Number.isSafeInteger(usedAttempts) || usedAttempts < 0 || usedAttempts >= maxAttempts) return false;
  if (storedOtpMatches(hash, otp)) return true;
  await adapter.createVerificationValue({
    value: `${hash}:${usedAttempts + 1}`,
    identifier,
    expiresAt: consumed.expiresAt,
  });
  return false;
}

export function composeApiAccountServices(input: {
  readonly config: ReturnType<typeof loadConfig>;
  readonly identityUnitOfWork: IdentityUnitOfWork;
  readonly accountDeletionStore?: AccountDeletionStore;
  readonly browserSessionAuthority: BrowserSessionAuthority | undefined;
  readonly recoveryLinkingAuth: unknown;
}): ApiAccountServices {
  const { config, browserSessionAuthority, recoveryLinkingAuth } = input;
  // C3 account recovery + explicit account linking (plan §9 Task C3): facades
  // are wired over the SHARED Better Auth instance from composition (mount +
  // session authority + auth.api). Recovery reset therefore hits the same
  // onPasswordChanged / occupancy / epoch-revoke hooks as HTTP /change-password.
  // Legacy mode keeps the surface closed (no authority -> no facades -> no routes).
  let accountRecovery: ReturnType<typeof createAccountRecoveryService> | undefined;
  let accountLinking: ReturnType<typeof createAccountLinkingService> | undefined;
  let accountDeletion: ReturnType<typeof createAccountDeletionService> | undefined;
  if (browserSessionAuthority !== undefined && config.betterAuth.enabled) {
    if (recoveryLinkingAuth === undefined) {
      throw new Error('API composition refused: Better Auth mode must expose the shared auth instance');
    }
    // buildBetterAuthOptions returns the base BetterAuthOptions type, so the
    // inferred `auth.api` surface is the plugin-less base; the recovery/
    // linking ports need the emailOTP/social server-API methods that the
    // configured plugins provide at runtime. The structural cast below pins
    // exactly the server-API calls these ports use (same calls the C3
    // integration suite performs on its literal-options instance).
    const sharedAuth = recoveryLinkingAuth as unknown as {
      readonly api: RecoveryLinkingAuthApi;
      readonly $context: Promise<{
        readonly internalAdapter: {
          deleteUser(userId: string): Promise<void>;
          consumeVerificationValue(identifier: string): Promise<VerificationValue | null>;
          createVerificationValue(data: VerificationValue & { readonly identifier: string }): Promise<unknown>;
        };
      }>;
    };
    const recoveryServer: RecoveryServerPort = {
      async requestPasswordReset({ email }) {
        await sharedAuth.api.requestPasswordReset({ body: { email } });
      },
      async resetPasswordWithEmailOtp({ email, otp, newPassword }) {
        await sharedAuth.api.resetPasswordEmailOTP({ body: { email, otp, password: newPassword } });
      },
    };
    accountRecovery = createAccountRecoveryService(recoveryServer);
    const linkServer: OAuthLinkServerPort = {
      async startLink({ cookie, providerId, callbackURL, errorCallbackURL }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const body = {
          callbackURL,
          ...(errorCallbackURL === undefined ? {} : { errorCallbackURL }),
        };
        // Better Auth 1.7 folds genericOAuth onto the social chain; link
        // start is always `/link-social` + `{ provider }` (no oAuth2LinkAccount).
        const response = await sharedAuth.api.linkSocialAccount({
          headers,
          body: { provider: providerId, ...body },
          asResponse: true,
        });
        const parsed = (await response.json()) as { url?: string };
        if (typeof parsed.url !== 'string' || parsed.url.length === 0) {
          throw new Error('link start did not produce an authorization URL');
        }
        return { url: parsed.url, stateCookies: response.headers.getSetCookie() };
      },
      async listAccounts({ cookie }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const accounts = await sharedAuth.api.listUserAccounts({ headers });
        return accounts.map((account) => ({ providerId: account.providerId, accountId: account.accountId }));
      },
      async unlinkAccount({ cookie, providerId, accountId }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        // Better Auth 1.7 unlink takes the auth_accounts row `id`, not the
        // provider subject (`accountId`) + providerId pair.
        const accounts = await sharedAuth.api.listUserAccounts({ headers });
        const target = accounts.find((account) =>
          account.providerId === providerId && account.accountId === accountId);
        if (target === undefined) {
          throw new Error('unlink target is not linked to this session');
        }
        await sharedAuth.api.unlinkAccount({ headers, body: { accountId: target.id } });
      },
      async getUserEmail({ cookie }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const session = await sharedAuth.api.getSession({ headers });
        return session?.user?.email ?? null;
      },
    };
    const reauthVerifier: ReauthVerifier = {
      async verifyPassword({ cookie, password }) {
        try {
          const headers = new Headers();
          if (cookie !== undefined) headers.set('cookie', cookie);
          await sharedAuth.api.verifyPassword({ headers, body: { password } });
          return true;
        } catch {
          return false;
        }
      },
      async verifyOtp({ email, otp }) {
        try {
          const context = await sharedAuth.$context;
          return await consumeReauthOtp(
            context.internalAdapter,
            email,
            otp,
            config.betterAuth.otpMaxAttempts,
          );
        } catch {
          return false;
        }
      },
    };
    accountLinking = createAccountLinkingService({
      authority: browserSessionAuthority,
      server: linkServer,
      reauth: reauthVerifier,
      productOrigin: config.productOrigin,
    });
    const betterAuthUsers: BetterAuthUserDeletionPort = {
      async getAuthUserId({ cookie }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const session = await sharedAuth.api.getSession({ headers });
        return session?.user?.id ?? null;
      },
    };
    accountDeletion = createAccountDeletionService({
      authority: browserSessionAuthority,
      server: linkServer,
      reauth: reauthVerifier,
      store: input.accountDeletionStore ?? {
        async complete() { throw new Error('Atomic account deletion store is required'); },
      },
      betterAuthUsers,
    });
  }
  return { accountRecovery, accountLinking, accountDeletion };
}
