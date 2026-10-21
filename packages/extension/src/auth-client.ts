import { parseHttpsAvatarUrl, parseRemoteAvatarUrl } from './avatar-url.js';
import { readBoundedJson } from './json-response.js';
import { isLoopbackHttpHost } from './http-origin.js';
import { assertCredentialHostPermission } from './server-origin-permission.js';

export const SESSION_COOKIE_NAME = '__Host-known_session';
/** Plain HTTP (`COLP_INSECURE_HTTP`) cannot set a `__Host-` cookie. */
export const INSECURE_SESSION_COOKIE_NAME = 'known_session';
type SessionCookieName = typeof SESSION_COOKIE_NAME | typeof INSECURE_SESSION_COOKIE_NAME;
const SESSION_COOKIE_NAMES = [SESSION_COOKIE_NAME, INSECURE_SESSION_COOKIE_NAME] as const;
const SESSION_COOKIE_HEADER = new RegExp(`^(?:${SESSION_COOKIE_NAMES.join('|')})=([^;]*)`, 'u');
const AUTH_RESPONSE_MAX_BYTES = 64 * 1_024;

export type OAuthProvider = 'google' | 'github';

export interface AuthSessionInfo {
  readonly session: { readonly id: string; readonly userId: string; readonly expiresAt: string };
  readonly user: {
    readonly id: string; readonly email: string | null; readonly name: string | null;
    readonly image?: string;
  };
}

export interface AuthClient {
  signInWithPassword(input: { readonly email: string; readonly password: string }): Promise<string>;
  sendOtp(email: string): Promise<void>;
  signInWithOtp(input: { readonly email: string; readonly otp: string }): Promise<string>;
  startOAuth(provider: OAuthProvider): Promise<{ readonly url: string }>;
  getSession(cookieValue: string): Promise<AuthSessionInfo & { readonly cookieValue: string }>;
  readProfileAvatar(cookieValue: string): Promise<string | undefined>;
  signOut(cookieValue: string, signal?: AbortSignal): Promise<void>;
}

export function createAuthClient(options: {
  readonly serverOrigin: string;
  readonly origin: string;
  readonly fetch?: typeof fetch;
  readonly readHostCookie?: () => Promise<string | undefined>;
}): AuthClient {
  const fetcher = options.fetch ?? fetch;
  const base = `${options.serverOrigin.replace(/\/$/u, '')}/api/v1/auth`;
  const cookieName = sessionCookieName(options.serverOrigin);
  const sessionCookie = (response: Response) => readSessionCookie(response, cookieName);

  async function transmit(url: string, init: RequestInit): Promise<Response> {
    await assertCredentialHostPermission(url, init);
    return fetcher(url, init);
  }

  async function mutate(path: string, body: unknown): Promise<Response> {
    try {
      return await transmit(`${base}${path}`, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: options.origin,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw normalizeTransport(error);
    }
  }

  async function readSession(cookieValue: string): Promise<Response> {
    try {
      return await transmit(`${base}/get-session`, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          Origin: options.origin,
          Cookie: cookieHeader(cookieValue, cookieName),
        },
      });
    } catch (error) {
      throw normalizeTransport(error);
    }
  }

  async function resolveSessionCookie(response: Response): Promise<string> {
    const fromHeader = sessionCookie(response);
    if (fromHeader) return fromHeader;
    const fromStore = await options.readHostCookie?.();
    if (fromStore) return fromStore;
    throw new Error('session_cookie_missing');
  }

  async function parsedLiveSession(response: Response): Promise<AuthSessionInfo> {
    if (response.status === 401 || response.status === 403) throw new Error('authentication_required');
    await assertOk(response, 'session_unavailable');
    const body = await readBoundedJson(response, AUTH_RESPONSE_MAX_BYTES, 'session_unavailable');
    if (body === null) throw new Error('authentication_required');
    const parsed = parseSession(body);
    if (!parsed) throw new Error('session_unavailable');
    return parsed;
  }

  return {
    async signInWithPassword(input) {
      // Better Auth's username plugin takes `{ username }`; email stays `{ email }`.
      const byUsername = !input.email.includes('@');
      const response = await mutate(
        byUsername ? '/sign-in/username' : '/sign-in/email',
        byUsername
          ? { username: input.email, password: input.password }
          : { email: input.email, password: input.password },
      );
      await assertOk(response, 'invalid_credentials');
      return resolveSessionCookie(response);
    },
    async sendOtp(email) {
      const response = await mutate('/email-otp/send-verification-otp', { email, type: 'sign-in' });
      await assertOk(response, 'otp_send_failed');
    },
    async signInWithOtp(input) {
      const response = await mutate('/sign-in/email-otp', { email: input.email, otp: input.otp });
      await assertOk(response, 'invalid_credentials');
      return resolveSessionCookie(response);
    },
    async startOAuth(provider) {
      const response = await mutate('/sign-in/social', {
        provider,
        callbackURL: '/library',
        disableRedirect: true,
      });
      await assertOk(response, 'oauth_start_failed');
      const body = await readBoundedJson(response, AUTH_RESPONSE_MAX_BYTES, 'oauth_start_failed');
      if (!record(body) || typeof body.url !== 'string' || body.url.length === 0) {
        throw new Error('oauth_start_failed');
      }
      assertOAuthUrl(body.url, provider, options.serverOrigin);
      return { url: body.url };
    },
    async getSession(cookieValue) {
      const response = await readSession(cookieValue);
      // Product session rotation revokes the predecessor. Its 401 is not a
      // sign-out when the host jar already contains a different successor.
      if (response.status === 401 || response.status === 403) {
        const successorCookie = await options.readHostCookie?.();
        if (!successorCookie || successorCookie === cookieValue) throw new Error('authentication_required');
        const successor = await readSession(successorCookie);
        const verified = await parsedLiveSession(successor);
        return { ...verified, cookieValue: sessionCookie(successor) ?? successorCookie };
      }
      const parsed = await parsedLiveSession(response);
      const rotated = sessionCookie(response);
      // Browsers conceal Set-Cookie from fetch, even when credentials: include
      // has already installed the successor cookie in the host jar. Re-read
      // its authority before pairing it with a user from this response. The
      // jar also wins if another in-flight refresh superseded this response.
      const hostCookie = await options.readHostCookie?.();
      const candidate = hostCookie && hostCookie !== cookieValue
        ? hostCookie : rotated && rotated !== cookieValue ? rotated : cookieValue;
      if (candidate === cookieValue) return { ...parsed, cookieValue };
      const successor = await readSession(candidate);
      const successorSession = await parsedLiveSession(successor);
      return { ...successorSession, cookieValue: sessionCookie(successor) ?? candidate };
    },
    async readProfileAvatar(cookieValue) {
      try {
        const origin = options.serverOrigin.replace(/\/$/u, '');
        const headers = { Accept: 'application/json', Cookie: cookieHeader(cookieValue, cookieName) };
        const get = (path: string) => transmit(`${origin}${path}`, {
          method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'include', headers,
        });
        const session = await get('/api/v1/session');
        if (!session.ok) return undefined;
        const occupancy = await readBoundedJson(session, AUTH_RESPONSE_MAX_BYTES, 'session_unavailable');
        if (!record(occupancy) || occupancy.authenticated !== true) return undefined;
        const response = await get('/api/v1/me');
        if (!response.ok) return undefined;
        const body = await readBoundedJson(response, AUTH_RESPONSE_MAX_BYTES, 'session_unavailable');
        return parseProfileAvatar(body, origin);
      } catch {
        return undefined;
      }
    },
    async signOut(cookieValue, signal) {
      try {
        await transmit(`${base}/sign-out`, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            Origin: options.origin,
            Cookie: cookieHeader(cookieValue, cookieName),
          },
          signal,
        });
      } catch {
        /* sign-out is best-effort once local authority is being cleared */
      }
    },
  };
}

export function sessionCookieName(origin: string): SessionCookieName {
  const url = new URL(origin);
  if (url.protocol === 'https:') return SESSION_COOKIE_NAME;
  if (url.protocol === 'http:' && isLoopbackHttpHost(url.hostname)) return INSECURE_SESSION_COOKIE_NAME;
  throw new TypeError('HTTPS is required');
}

export function cookieHeader(cookieValue: string, name: SessionCookieName = SESSION_COOKIE_NAME): string {
  return `${name}=${encodeURIComponent(cookieValue)}`;
}

/**
 * COLP uses one explicit Bearer carrier. Chromium strips a script-supplied
 * `Cookie` header from extension fetches, so relying on Cookie silently sends
 * no credential even when the host cookie can be read through chrome.cookies.
 */
export function colpCredentialHeaders(accessToken: string): {
  readonly Authorization: string;
} {
  if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8_192
      || !/^[\x21-\x7e]+$/u.test(accessToken)) {
    throw new Error('session_cookie_invalid');
  }
  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

export function isSessionCookieName(name: string): boolean {
  return (SESSION_COOKIE_NAMES as readonly string[]).includes(name);
}

export function readSessionCookie(response: Response, name?: SessionCookieName): string | undefined {
  for (const header of setCookieHeaders(response)) {
    if (name !== undefined && !header.startsWith(`${name}=`)) continue;
    const match = SESSION_COOKIE_HEADER.exec(header);
    if (!match || match[1] === undefined || match[1] === '') continue;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return undefined;
}

function setCookieHeaders(response: Response): readonly string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

async function assertOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 0) throw new Error('offline');
  const problem = await readBoundedJson(response, AUTH_RESPONSE_MAX_BYTES, fallback).catch(() => undefined);
  throw new Error(errorCodeOf(problem, response.status, fallback));
}

function errorCodeOf(body: unknown, status: number, fallback: string): string {
  if (record(body)) {
    const nested = record(body.error) ? body.error : body;
    if (typeof nested.code === 'string' && nested.code.length > 0 && nested.code.length <= 64) {
      return nested.code;
    }
  }
  if (status === 401 || status === 403) return 'invalid_credentials';
  if (status === 429) return 'rate_limited';
  return fallback;
}

function parseSession(body: unknown): AuthSessionInfo | null {
  if (!record(body) || !record(body.session) || !record(body.user)) return null;
  const session = body.session;
  const user = body.user;
  if (typeof session.id !== 'string' || session.id.length === 0) return null;
  if (typeof session.userId !== 'string' || session.userId.length === 0) return null;
  if (typeof session.expiresAt !== 'string' || session.expiresAt.length === 0) return null;
  if (typeof user.id !== 'string' || user.id.length === 0) return null;
  const image = parseHttpsAvatarUrl(user.image);
  return {
    session: { id: session.id, userId: session.userId, expiresAt: session.expiresAt },
    user: {
      id: user.id,
      email: typeof user.email === 'string' ? user.email : null,
      name: typeof user.name === 'string' ? user.name : null,
      ...(image ? { image } : {}),
    },
  };
}

function parseProfileAvatar(body: unknown, serverOrigin: string): string | undefined {
  if (!record(body) || !record(body.profile)) return undefined;
  return parseRemoteAvatarUrl(body.profile.avatarUrl, serverOrigin);
}

function normalizeTransport(error: unknown): Error {
  if (error instanceof TypeError && error.message === 'Failed to fetch') return new Error('offline');
  if (error instanceof Error) return error;
  return new Error('offline');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Provider redirects are external by design, but never arbitrary browser URLs. */
function assertOAuthUrl(value: string, provider: OAuthProvider, serverOrigin: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('oauth_start_failed'); }
  const expected = provider === 'google' ? 'https://accounts.google.com' : 'https://github.com';
  const server = new URL(serverOrigin);
  const localFixture = ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)
    && server.protocol === 'http:' && url.origin === server.origin;
  if (url.username || url.password || (url.origin !== expected && !localFixture)) {
    throw new Error('oauth_start_failed');
  }
}
