import type { BuildConfig, PublicAuthState, StoredCredential, StoredSession } from './types.js';
import { createAuthClient, INSECURE_SESSION_COOKIE_NAME, sessionCookieName, SESSION_COOKIE_NAME, type AuthClient, type AuthSessionInfo, type OAuthProvider } from './auth-client.js';
import { inlineAvatarDataUrl, parseHttpsAvatarUrl, parsePaintAvatarUrl, parseRemoteAvatarUrl } from './avatar-url.js';
import { createCredentialStore } from './credential-store.js';

type Store = ReturnType<typeof createCredentialStore>;

export type LoginInput =
  | { readonly method: 'password'; readonly email: string; readonly password: string }
  | { readonly method: 'otp'; readonly email: string; readonly otp: string }
  | { readonly method: 'oauth'; readonly provider: OAuthProvider };

export interface CookieChangeInfo {
  readonly cookie: { readonly name: string; readonly value: string; readonly domain?: string };
  readonly removed: boolean;
}

export interface CookiePort {
  get(details: { url: string; name: string }): Promise<{ readonly value: string } | null>;
  set(details: {
    url: string; name: string; value: string; path: string;
    secure: boolean; httpOnly: boolean; sameSite: 'lax'; expirationDate: number;
  }): Promise<unknown>;
  remove(details: { url: string; name: string }): Promise<unknown>;
  readonly onChanged: {
    addListener(callback: (change: CookieChangeInfo) => void): void;
    removeListener(callback: (change: CookieChangeInfo) => void): void;
  };
}

interface Dependencies {
  readonly config: BuildConfig;
  readonly store: Store;
  readonly origin: string;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly auth?: AuthClient;
  readonly cookies?: CookiePort;
  readonly openOAuthTab?: (url: string) => Promise<unknown>;
  readonly oauthTimeoutMs?: number;
  readonly oauthPollMs?: number;
  readonly retire?: (credential: StoredCredential, session: StoredSession, signal?: AbortSignal) => Promise<void>;
  readonly drain?: () => Promise<void>;
  readonly logoutTimeoutMs?: number;
}

const OAUTH_TIMEOUT_MS = 5 * 60 * 1_000;
const OAUTH_POLL_MS = 250;

function controller(dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now;
  // A worker is short-lived, so one attempt per instance bounds the cost of a
  // stale cookie without needing a timer.
  let cookieRestoreAttempted = false;
  const restoreOnce = async (generation: number): Promise<StoredCredential | null> => {
    if (cookieRestoreAttempted) return null;
    cookieRestoreAttempted = true;
    return restoreCredentialFromCookie(dependencies, auth, generation);
  };
  const auth = dependencies.auth ?? createAuthClient({
    serverOrigin: dependencies.config.serverOrigin,
    origin: dependencies.origin,
    fetch: dependencies.fetch,
    readHostCookie: () => readHostCookie(dependencies),
  });
  return {
    dependencies,
    async login(input: LoginInput): Promise<PublicAuthState> {
      try {
        await dependencies.store.clearTransaction();
        const cookieValue = input.method === 'oauth'
          ? await completeOAuth(dependencies, auth, input.provider)
          : input.method === 'password'
            ? await auth.signInWithPassword({ email: input.email, password: input.password })
            : await auth.signInWithOtp({ email: input.email, otp: input.otp });
        await persistSession(dependencies, auth, cookieValue, now());
        await dependencies.store.clearSignOutReason();
        return stateView('connected', dependencies.config);
      } catch (error) {
        await dependencies.store.clearCredential();
        const code = safeCode(error);
        return stateView(code === 'offline' ? 'offline' : code === 'policy_blocked' ? 'policy_blocked' : 'error',
          dependencies.config, code);
      }
    },
    async sendOtp(email: string): Promise<void> {
      await auth.sendOtp(email);
    },
    async ensureFreshCredential(forceRefresh = false): Promise<StoredCredential> {
      const expectedGeneration = (await dependencies.store.fence.read()).generation;
      let current = await dependencies.store.loadCredential();
      if (!current) {
        // The session area is empty after a browser restart; the cookie in the
        // browser's jar is not. Rebuild before asking the user to sign in again.
        current = await restoreOnce(expectedGeneration);
      }
      if (!current) throw new Error('authentication_required');
      const hostCookie = await readHostCookieOnce(dependencies);
      if (!forceRefresh && (!hostCookie || hostCookie === current.accessToken)
        && current.expiresAt - now() > dependencies.config.refreshBeforeExpirySeconds * 1_000) {
        return current;
      }
      try {
        const session = await auth.getSession(current.accessToken);
        if (session.cookieValue !== current.accessToken) {
          await writeHostCookie(dependencies, session.cookieValue, Date.parse(session.session.expiresAt));
        }
        const next = await credentialFromLiveSession(dependencies, auth, session.cookieValue, session, current);
        if (current.subject && next.subject !== current.subject) throw new Error('authentication_required');
        if (next.expiresAt <= now()) throw new Error('authentication_required');
        await dependencies.store.saveCredential(next, expectedGeneration);
        return next;
      } catch (error) {
        const stillCurrent = (await dependencies.store.fence.read()).generation === expectedGeneration;
        if (stillCurrent) {
          if (safeCode(error) === 'authentication_required') {
            await dependencies.store.clearAuthority();
            await dependencies.store.markSignOutReason('authentication_required');
          } else await dependencies.store.clearSession();
        }
        throw error;
      }
    },
    async hydrateAvatar(): Promise<void> {
      const current = await dependencies.store.loadCredential();
      if (!current || parsePaintAvatarUrl(current.avatarUrl, current.serverOrigin)) return;
      try {
        const remote = parseRemoteAvatarUrl(
          await auth.readProfileAvatar(current.accessToken), dependencies.config.serverOrigin,
        );
        if (!remote) return;
        const avatarUrl = await inlineAvatarDataUrl(remote, dependencies.fetch ?? fetch) ?? remote;
        await dependencies.store.saveCredential({ ...current, avatarUrl });
      } catch { /* photo is best-effort; never clear COLP from this path */ }
    },
    async logout(): Promise<PublicAuthState> {
      const credential = await dependencies.store.loadCredential();
      const session = await dependencies.store.loadSession();
      await dependencies.store.revokeAuthority();
      // Fence and abort local work before any network call. The auth lane is
      // excluded by the service-worker drain callback because this operation
      // itself is in-flight on that lane.
      await dependencies.drain?.();
      await removeHostCookie(dependencies);
      await dependencies.store.clearAuthority();
      await dependencies.store.clearSignOutReason();
      const timeoutMs = dependencies.logoutTimeoutMs ?? 10_000;
      const remoteAbort = new AbortController();
      const timer = setTimeout(() => remoteAbort.abort(), timeoutMs);
      try {
        // Remote retirement/sign-out are deliberately best-effort. A stalled
        // server cannot keep local logout from completing.
        if (credential && session && dependencies.retire) {
          await withTimeout(dependencies.retire(credential, session, remoteAbort.signal), timeoutMs);
        }
        if (credential) await withTimeout(auth.signOut(credential.accessToken, remoteAbort.signal), timeoutMs);
      } finally { clearTimeout(timer); }
      return stateView('signed_out', dependencies.config);
    },
    async status(): Promise<PublicAuthState> {
      let credential = await dependencies.store.loadCredential();
      const session = await dependencies.store.loadSession();
      if (!credential) {
        // Restore a live browser cookie after the session storage area is reset.
        credential = await restoreOnce((await dependencies.store.fence.read()).generation);
      }
      if (!credential) {
        const reason = await dependencies.store.loadSignOutReason();
        return reason
          ? stateView('signed_out', dependencies.config, reason)
          : stateView('signed_out', dependencies.config);
      }
      if (credential.issuer !== dependencies.config.issuer || credential.audience !== dependencies.config.audience
          || credential.clientId !== dependencies.config.clientId
          || credential.serverOrigin !== dependencies.config.serverOrigin) {
        await dependencies.store.markSignOutReason('binding_mismatch');
        await dependencies.store.clearAuthority();
        return stateView('error', dependencies.config, 'binding_mismatch');
      }
      return {
        ...stateView('connected', dependencies.config),
        ...(credential.accountLabel || credential.subject
          ? { accountLabel: credential.accountLabel ?? credential.subject } : {}),
        ...(credential.avatarUrl ? { avatarUrl: credential.avatarUrl } : {}),
        ...(session ? { sessionExpiresAt: session.expiresAt } : {}),
      };
    },
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const createAuthController = controller;

async function persistSession(
  dependencies: Dependencies,
  auth: AuthClient,
  cookieValue: string,
  now: number,
): Promise<StoredCredential> {
  const tokenValue = decodeCookieValue(cookieValue);
  await writeHostCookie(dependencies, tokenValue);
  const session = await auth.getSession(tokenValue);
  const token = decodeCookieValue(session.cookieValue);
  const sessionExpiresAtMs = Date.parse(session.session.expiresAt);
  if (token !== tokenValue) await writeHostCookie(dependencies, token, sessionExpiresAtMs);
  else await writeHostCookie(dependencies, tokenValue, sessionExpiresAtMs);
  const credential = await credentialFromLiveSession(dependencies, auth, token, session);
  if (credential.expiresAt <= now) throw new Error('authentication_required');
  const activated = await dependencies.store.activateAuthority();
  // Revoke first, then settle already dispatched native work before the new identity owns the tree.
  await dependencies.drain?.();
  await dependencies.store.saveCredential(credential, activated.generation);
  return credential;
}

async function credentialFromLiveSession(
  dependencies: Dependencies,
  auth: AuthClient,
  cookieValue: string,
  session: AuthSessionInfo,
  prior?: StoredCredential,
): Promise<StoredCredential> {
  const meAvatar = await auth.readProfileAvatar(cookieValue).catch(() => undefined);
  const remote = parseRemoteAvatarUrl(meAvatar, dependencies.config.serverOrigin)
    ?? parseHttpsAvatarUrl(session.user.image)
    ?? parseRemoteAvatarUrl(prior?.avatarUrl, dependencies.config.serverOrigin);
  let avatarUrl = remote;
  if (remote) {
    try { avatarUrl = await inlineAvatarDataUrl(remote, dependencies.fetch ?? fetch) ?? remote; }
    catch { avatarUrl = remote; }
  }
  return credentialFromSession(dependencies.config, cookieValue, session, prior, avatarUrl);
}

function credentialFromSession(
  config: BuildConfig,
  cookieValue: string,
  session: { readonly session: { readonly expiresAt: string }; readonly user: { readonly id: string; readonly email: string | null; readonly image?: string } },
  prior?: StoredCredential,
  meAvatar?: string,
): StoredCredential {
  const expiresAt = Date.parse(session.session.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error('session_unavailable');
  const accountLabel = session.user.email ?? prior?.accountLabel;
  const avatarUrl = parsePaintAvatarUrl(meAvatar, config.serverOrigin)
    ?? parseHttpsAvatarUrl(session.user.image)
    ?? parsePaintAvatarUrl(prior?.avatarUrl, config.serverOrigin);
  return Object.freeze({
    accessToken: cookieValue,
    tokenType: 'Bearer',
    expiresAt,
    scope: Object.freeze([...config.scopes]),
    issuer: config.issuer,
    audience: config.audience,
    clientId: config.clientId,
    serverOrigin: config.serverOrigin,
    subject: session.user.id,
    ...(accountLabel ? { accountLabel } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  });
}

/**
 * Re-establish the credential from the browser's session cookie.
 *
 * `chrome.storage.session` is cleared when the browser session ends, but the
 * session cookie lives in the browser's COOKIE JAR and survives a restart — and the
 * credential's `accessToken` IS that cookie's value. Nothing consulted the cookie
 * when the stored credential was missing, so a restarted profile reported
 * `signed_out` and made the user sign in again although the cookie proving the
 * session was still there. That is a product regression, not a storage tradeoff:
 * every browser restart forced a fresh login.
 *
 * Nothing new is persisted to a page-readable area. The cookie stays in the
 * browser's jar (which extension pages cannot read) and the rebuilt credential
 * stays in the `TRUSTED_CONTEXTS` session area, so the property that an injected
 * options/popup script cannot read a credential is unchanged. Deliberately NOT a
 * refresh token in `local`: that would hold a mintable secret in the very area the
 * split was made to clear.
 *
 * Fails closed. An absent, expired or rejected cookie returns null and the caller
 * reports `authentication_required` / `signed_out`, so a stale cookie can never
 * conjure a session that the authority does not accept.
 */
async function restoreCredentialFromCookie(
  dependencies: Dependencies, auth: AuthClient, expectedGeneration: number,
): Promise<StoredCredential | null> {
  const cookieValue = await readHostCookie(dependencies);
  if (!cookieValue) return null;
  try {
    const session = await auth.getSession(cookieValue);
    const next = await credentialFromLiveSession(dependencies, auth, session.cookieValue, session);
    if (next.expiresAt <= (dependencies.now ?? Date.now)()) return null;
    // Throws when the authority is fenced, which is the point: a revoked authority
    // must not be silently restored.
    await dependencies.store.saveCredential(next, expectedGeneration);
    if (session.cookieValue !== cookieValue) {
      await writeHostCookie(dependencies, session.cookieValue, Date.parse(session.session.expiresAt));
    }
    return next;
  } catch {
    return null;
  }
}

async function completeOAuth(
  dependencies: Dependencies,
  auth: AuthClient,
  provider: OAuthProvider,
): Promise<string> {
  const started = await auth.startOAuth(provider);
  if (!dependencies.openOAuthTab) throw new Error('identity_unavailable');
  const baseline = await readHostCookieOnce(dependencies) ?? '';
  const pending = waitForHostCookie(dependencies, baseline);
  await dependencies.openOAuthTab(started.url);
  return pending;
}

function waitForHostCookie(dependencies: Dependencies, baseline: string): Promise<string> {
  const cookies = dependencies.cookies;
  if (!cookies) return Promise.reject(new Error('identity_unavailable'));
  const timeoutMs = dependencies.oauthTimeoutMs ?? OAUTH_TIMEOUT_MS;
  const pollMs = dependencies.oauthPollMs ?? OAUTH_POLL_MS;
  const host = new URL(cookieUrl(dependencies.config)).hostname;
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(poller);
      cookies.onChanged.removeListener(onChanged);
    };
    const finish = (value: string) => {
      const decoded = decodeCookieValue(value);
      if (settled || decoded.length === 0) return;
      settled = true;
      stop();
      resolve(decoded);
    };
    const timer = setTimeout(() => {
      stop();
      if (!settled) reject(new Error('login_cancelled:oauth_timeout'));
    }, timeoutMs);
    const onChanged = (change: CookieChangeInfo) => {
      if (change.removed || change.cookie.name !== sessionCookieName(dependencies.config.serverOrigin)) return;
      if (!cookieHostMatches(change.cookie.domain, host)) return;
      if (change.cookie.value) finish(change.cookie.value);
    };
    cookies.onChanged.addListener(onChanged);
    const poller = setInterval(() => {
      void readHostCookieOnce(dependencies).then((value) => {
        if (value && value !== baseline) finish(value);
      });
    }, pollMs);
  });
}

function cookieHostMatches(domain: string | undefined, host: string): boolean {
  if (domain === undefined || domain === '') return true;
  return domain.replace(/^\./u, '') === host;
}

async function readHostCookieOnce(dependencies: Dependencies): Promise<string | undefined> {
  if (!dependencies.cookies) return undefined;
  const url = cookieUrl(dependencies.config);
  const cookie = await dependencies.cookies.get({ url, name: sessionCookieName(dependencies.config.serverOrigin) });
  return cookie?.value ? decodeCookieValue(cookie.value) : undefined;
}

async function readHostCookie(dependencies: Dependencies): Promise<string | undefined> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = await readHostCookieOnce(dependencies);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function writeHostCookie(dependencies: Dependencies, cookieValue: string, expiresAtMs?: number): Promise<void> {
  if (!dependencies.cookies) return;
  try {
    await dependencies.cookies.set({
      url: cookieUrl(dependencies.config),
      name: sessionCookieName(dependencies.config.serverOrigin),
      value: cookieValue,
      path: '/',
      secure: new URL(dependencies.config.serverOrigin).protocol === 'https:',
      httpOnly: true,
      sameSite: 'lax',
      // Without an expiration this is a session cookie and Chromium drops it
      // on browser restart, leaving a stored credential that fails every
      // authenticated call with 401 until the user signs in again.
      expirationDate: Math.floor((expiresAtMs && expiresAtMs > Date.now()
        ? expiresAtMs : Date.now() + FALLBACK_COOKIE_LIFETIME_MS) / 1_000),
    });
  } catch {
    /* Fetch uses the server-installed cookie jar when a cookie cannot be written here. */
  }
}

const FALLBACK_COOKIE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

async function removeHostCookie(dependencies: Dependencies): Promise<void> {
  if (!dependencies.cookies) return;
  const url = cookieUrl(dependencies.config);
  for (const name of [SESSION_COOKIE_NAME, INSECURE_SESSION_COOKIE_NAME]) {
    await dependencies.cookies.remove({ url, name }).catch(() => undefined);
  }
}

function cookieUrl(config: BuildConfig): string {
  return `${config.serverOrigin.replace(/\/$/u, '')}/`;
}

function stateView(status: PublicAuthState['status'], config: BuildConfig, errorCode?: string): PublicAuthState {
  return Object.freeze({
    status,
    environment: config.environment,
    serverOrigin: config.serverOrigin,
    ...(errorCode ? { errorCode } : {}),
  });
}

function safeCode(error: unknown): string {
  if (error instanceof TypeError && error.message === 'Failed to fetch') return 'offline';
  return error instanceof Error ? error.message : 'authentication_failed';
}
