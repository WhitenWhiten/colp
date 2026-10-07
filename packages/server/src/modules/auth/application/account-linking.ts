/**
 * Task C3: explicit account linking facade (plan §9 Task C3 steps 4-5).
 *
 * Linking contract (plan §4.3.3/§4.3.5; G1 ADR §10-§11):
 * - the explicit link requires a CURRENT SESSION (A3 authority port), the
 *   product Origin/CSRF admission (enforced by the transport route), and a
 *   re-auth proof (`password` via the session user's credential, or
 *   `verified-email OTP` bound to the session user's email) before the OAuth
 *   state/PKCE flow starts;
 * - the callback URL must resolve inside the Know-N origin (allowlisted
 *   returnTo, `resolveAllowlistedCallbackUrl`) — the open-redirect guard;
 * - a provider that is already linked to the session user is refused before
 *   any OAuth round trip;
 * - the provider account unique check and the atomic link happen in the
 *   Better Auth callback (B1 `UNIQUE(providerId, accountId)` backstop); the
 *   cross-user case surfaces as `account_already_linked_to_different_user`
 *   and writes nothing (C3 integration suite);
 * - unlink requires the same session + re-auth and is REFUSED when it would
 *   remove the last recovery method (credential or provider account): the
 *   guard counts the session user's accounts and rejects a removal that
 *   leaves none (plan §9 C3 step 5).
 *
 * The server port is implemented over the real `auth.api` (linkSocialAccount
 * / listUserAccounts / unlinkAccount / getSession) by the composition/tests;
 * the authority port is the A3 BrowserSessionAuthority.
 */
import { canonicalizeSafeReturnTo } from '../../identity/index.js';
import type { BrowserSessionAuthority } from './browser-session-authority.js';

export type AccountLinkingErrorCode =
  | 'reauth_failed'
  | 'invalid_callback_url'
  | 'already_linked'
  | 'provider_not_configured'
  | 'link_start_failed'
  | 'account_not_found'
  | 'last_recovery_method';

export class AccountLinkingError extends Error {
  readonly code: AccountLinkingErrorCode;

  constructor(code: AccountLinkingErrorCode, message: string) {
    super(message);
    this.name = 'AccountLinkingError';
    this.code = code;
  }
}

/**
 * Better Auth server API for the OAuth2 link flow (infrastructure/test
 * implement this over the real `auth.api`; never over the HTTP mount).
 */
export interface OAuthLinkServerPort {
  /** BA `linkSocialAccount`: starts the state/PKCE flow for the session user; returns the authorization URL and the state Set-Cookie values. */
  startLink(input: {
    readonly cookie: string | undefined;
    readonly providerId: string;
    readonly callbackURL: string;
    readonly errorCallbackURL?: string;
  }): Promise<{ readonly url: string; readonly stateCookies: readonly string[] }>;
  /** BA `listUserAccounts`: every account row of the session user (credential + providers). */
  listAccounts(input: { readonly cookie: string | undefined }): Promise<ReadonlyArray<{
    readonly providerId: string;
    readonly accountId: string;
  }>>;
  /** BA `unlinkAccount`: remove one linked account of the session user. */
  unlinkAccount(input: {
    readonly cookie: string | undefined;
    readonly providerId: string;
    readonly accountId: string;
  }): Promise<void>;
  /** BA `getSession`: the session user's email (OTP re-auth binding). Null when the session is gone. */
  getUserEmail(input: { readonly cookie: string | undefined }): Promise<string | null>;
}

/** Re-auth proof: the session user proves control with their password or a verified-email OTP. */
export type ReauthProof =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'otp'; readonly email: string; readonly otp: string };

/** Verifies re-auth proofs (test/composition implement over `auth.api.verifyPassword` / `checkVerificationOTP`). */
export interface ReauthVerifier {
  verifyPassword(input: { readonly cookie: string | undefined; readonly password: string }): Promise<boolean>;
  verifyOtp(input: { readonly email: string; readonly otp: string }): Promise<boolean>;
}

export interface AccountLinkingPorts {
  /** A3 current-session check (constraint: link/unlink require the current session). */
  readonly authority: BrowserSessionAuthority;
  /** BA server API for the OAuth2 link flow. */
  readonly server: OAuthLinkServerPort;
  /** Password/OTP re-auth proof verification. */
  readonly reauth: ReauthVerifier;
  /** Exact Know-N product origin for the callback-URL allowlist. */
  readonly productOrigin: string;
}

export interface AccountLinkingService {
  /**
   * Begin the explicit provider link: session + re-auth + callback-URL
   * allowlist, then the OAuth state/PKCE start. Returns the provider
   * authorization URL and the state cookie(s) the browser must carry to the
   * callback.
   */
  beginProviderLink(input: {
    readonly cookie: string | undefined;
    readonly providerId: string;
    readonly callbackURL: string;
    readonly errorCallbackURL?: string;
    readonly reauth: ReauthProof;
  }): Promise<{ readonly url: string; readonly stateCookies: readonly string[] }>;
  /**
   * Linked social providers of the current session user (credential rows are
   * omitted from `accounts`). `hasPassword` is true iff a `credential` row
   * exists (P3: Settings set-password vs change-password). Session-gated;
   * no re-auth — this is a read of the user's own account list. Never
   * includes the password hash or the credential `accountId` in `accounts`.
   */
  listLinkedProviders(input: { readonly cookie: string | undefined }): Promise<{
    readonly accounts: ReadonlyArray<{
      readonly providerId: string;
      readonly accountId: string;
    }>;
    readonly hasPassword: boolean;
  }>;
  /**
   * Unlink a provider account (or the password credential). Refused when the
   * target is not linked to the session user, when the re-auth proof fails,
   * or when the removal would delete the LAST recovery method.
   */
  unlinkProvider(input: {
    readonly cookie: string | undefined;
    readonly providerId: string;
    readonly accountId: string;
    readonly reauth: ReauthProof;
  }): Promise<void>;
}

/**
 * Allowlisted callback URL. Same canonicalization as browser returnTo and the
 * Better Auth bridge: same-origin relative path, or an absolute URL on the
 * Know-N origin normalized to `pathname + search + hash`.
 */
export function resolveAllowlistedCallbackUrl(raw: unknown, productOrigin: string): string | null {
  return canonicalizeSafeReturnTo(raw, productOrigin);
}

async function verifyReauth(
  ports: AccountLinkingPorts,
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
  // OTP re-auth must be bound to the CURRENT session user's email: proving
  // control of an unrelated mailbox must never authorize this user's links.
  const sessionEmail = await ports.server.getUserEmail({ cookie });
  if (sessionEmail === null || sessionEmail.toLowerCase() !== proof.email.toLowerCase()) {
    throw new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid');
  }
  const ok = await ports.reauth.verifyOtp({ email: proof.email, otp: proof.otp });
  if (!ok) {
    throw new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid');
  }
}

export function createAccountLinkingService(ports: AccountLinkingPorts): AccountLinkingService {
  return {
    async beginProviderLink({ cookie, providerId, callbackURL, errorCallbackURL, reauth }) {
      // Current session (A3) — throws BrowserSessionAuthenticationError when absent.
      await ports.authority.requireMutationActor({ cookie }, { touch: true });

      const resolvedCallback = resolveAllowlistedCallbackUrl(callbackURL, ports.productOrigin);
      if (resolvedCallback === null) {
        throw new AccountLinkingError('invalid_callback_url', 'the callback URL must stay on the Know-N origin');
      }
      let resolvedErrorCallback: string | undefined;
      if (errorCallbackURL !== undefined) {
        const candidate = resolveAllowlistedCallbackUrl(errorCallbackURL, ports.productOrigin);
        if (candidate === null) {
          throw new AccountLinkingError('invalid_callback_url', 'the callback URL must stay on the Know-N origin');
        }
        resolvedErrorCallback = candidate;
      }

      await verifyReauth(ports, cookie, reauth);

      // Provider account unique check (start side): a provider already
      // linked to this user is refused before any OAuth round trip.
      const accounts = await ports.server.listAccounts({ cookie });
      if (accounts.some((account) => account.providerId === providerId)) {
        throw new AccountLinkingError('already_linked', 'this provider is already linked to the account');
      }

      try {
        return await ports.server.startLink({
          cookie,
          providerId,
          callbackURL: resolvedCallback,
          ...(resolvedErrorCallback === undefined ? {} : { errorCallbackURL: resolvedErrorCallback }),
        });
      } catch (error) {
        if (error instanceof AccountLinkingError) throw error;
        // The port surface knows the stable provider-not-found classification.
        throw new AccountLinkingError('link_start_failed', 'the provider could not start the link flow');
      }
    },
    async listLinkedProviders({ cookie }) {
      await ports.authority.requireMutationActor({ cookie }, { touch: false });
      const accounts = await ports.server.listAccounts({ cookie });
      const hasPassword = accounts.some((account) => account.providerId === 'credential');
      return {
        accounts: accounts
          .filter((account) => account.providerId !== 'credential')
          .map((account) => ({ providerId: account.providerId, accountId: account.accountId })),
        hasPassword,
      };
    },
    async unlinkProvider({ cookie, providerId, accountId, reauth }) {
      // Current session (A3).
      await ports.authority.requireMutationActor({ cookie }, { touch: true });
      await verifyReauth(ports, cookie, reauth);

      const accounts = await ports.server.listAccounts({ cookie });
      const target = accounts.find((account) =>
        account.providerId === providerId && account.accountId === accountId);
      if (!target) {
        throw new AccountLinkingError('account_not_found', 'the provider account is not linked to this user');
      }
      const remaining = accounts.filter((account) =>
        !(account.providerId === providerId && account.accountId === accountId));
      if (remaining.length === 0) {
        // Removing the last credential/provider is never allowed — the user
        // must always keep another recovery method (plan §9 C3 step 5).
        throw new AccountLinkingError(
          'last_recovery_method',
          'removing the last recovery method is not allowed',
        );
      }
      await ports.server.unlinkAccount({ cookie, providerId, accountId: target.accountId });
    },
  };
}
