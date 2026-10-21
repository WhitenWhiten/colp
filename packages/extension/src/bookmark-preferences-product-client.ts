import { readBoundedJson } from './json-response.js';
import { assertCredentialHostPermission } from './server-origin-permission.js';
import { normalizeBookmarkPreferences, type BookmarkPreferences } from './bookmark-preferences.js';

const PATH = '/api/v1/me/bookmark-preferences';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class BookmarkPreferencesProductError extends Error {
  constructor(readonly code: string, readonly status: number, readonly sameRequestRetrySafe = false) {
    super(code); this.name = 'BookmarkPreferencesProductError';
  }
}

export interface BookmarkPreferencesRemote {
  readonly value: BookmarkPreferences;
  readonly revision: string;
  readonly etag: string;
}

export function createBookmarkPreferencesProductClient(options: {
  readonly serverOrigin: string; readonly expectedAuthUserId: string;
  readonly assertCurrent?: () => Promise<void>; readonly signal?: AbortSignal; readonly fetch?: typeof fetch;
}) {
  const origin = new URL(options.serverOrigin);
  if (origin.origin !== options.serverOrigin || origin.username || origin.password
      || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new TypeError('Invalid Product origin');
  }
  if (!options.expectedAuthUserId) throw new BookmarkPreferencesProductError('reconnect_required', 401);
  const fetcher = options.fetch ?? fetch;

  async function bootstrap(): Promise<{ readonly csrfToken: string; readonly sessionId: string }> {
    const session = await request('/api/v1/session');
    if (!record(session.body) || session.body.authenticated !== true || typeof session.body.csrfToken !== 'string'
        || !session.body.csrfToken || session.body.csrfToken.length > 1024) {
      throw new BookmarkPreferencesProductError('reconnect_required', 401);
    }
    const identity = (await request('/api/v1/auth/get-session')).body;
    if (!record(identity) || !record(identity.user) || identity.user.id !== options.expectedAuthUserId
        || !record(identity.session) || typeof identity.session.id !== 'string'
        || !identity.session.id || identity.session.id.length > 256) {
      throw new BookmarkPreferencesProductError('reconnect_required', 401);
    }
    return { csrfToken: session.body.csrfToken, sessionId: identity.session.id };
  }

  async function request(path: string, init: RequestInit = {}): Promise<{ readonly body: unknown; readonly response: Response }> {
    await options.assertCurrent?.();
    const deadline = AbortSignal.timeout(5_000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    let response: Response;
    const url = `${origin.origin}${path}`;
    const request: RequestInit = { ...init, credentials: 'include', redirect: 'error', cache: 'no-store', signal };
    try {
      await assertCredentialHostPermission(url, request);
      response = await fetcher(url, request);
    } catch { throw new BookmarkPreferencesProductError('transport_error', 0, true); }
    let body: unknown;
    try { body = await readBoundedJson(response, 64 * 1024, 'bookmark_preferences_response_invalid'); }
    catch { throw new BookmarkPreferencesProductError('bookmark_preferences_response_invalid', response.status, true); }
    await options.assertCurrent?.();
    if (!response.ok) {
      if (response.status === 401) throw new BookmarkPreferencesProductError('reconnect_required', 401);
      if (response.status === 412) throw new BookmarkPreferencesProductError('precondition_failed', 412);
      const error = record(body) && record(body.error) ? body.error : undefined;
      const code = typeof error?.code === 'string' ? error.code : response.status === 403 ? 'csrf_failed' : 'bookmark_preferences_unavailable';
      throw new BookmarkPreferencesProductError(code, response.status, error?.sameRequestRetrySafe === true);
    }
    return { body, response };
  }

  async function read(): Promise<BookmarkPreferencesRemote> {
    const identity = await bootstrap();
    const result = await request(PATH, { headers: { Accept: 'application/json' } });
    if (result.response.headers.get('Known-Bookmark-Session') !== identity.sessionId) {
      throw new BookmarkPreferencesProductError('reconnect_required', 401);
    }
    return parseRemote(result.body, result.response.headers.get('etag'));
  }

  async function patch(value: Partial<BookmarkPreferences>, commandId: string, ifMatch: string): Promise<BookmarkPreferencesRemote> {
    if (!UUID_V4.test(commandId) || !/^"[\x21\x23-\x7e]+"$/u.test(ifMatch)) throw new TypeError('Invalid bookmark preference command');
    const send = async () => {
      // A CSRF retry obtains both a fresh token and a newly verified account.
      const identity = await bootstrap();
      const result = await request(PATH, {
        method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          'X-CSRF-Token': identity.csrfToken, 'Known-Command-Id': commandId, 'If-Match': ifMatch }, body: JSON.stringify(value),
      });
      if (result.response.headers.get('Known-Bookmark-Session') !== identity.sessionId) {
        throw new BookmarkPreferencesProductError('reconnect_required', 401);
      }
      return result;
    };
    let result: { readonly body: unknown; readonly response: Response };
    try { result = await send(); }
    catch (error) {
      if (!(error instanceof BookmarkPreferencesProductError) || error.status !== 403 || error.code !== 'csrf_failed') throw error;
      result = await send();
    }
    return parseRemote(result.body, result.response.headers.get('etag'));
  }

  return Object.freeze({ read, patch });
}

function parseRemote(value: unknown, header: string | null): BookmarkPreferencesRemote {
  if (!record(value)) throw new BookmarkPreferencesProductError('bookmark_preferences_response_invalid', 200, true);
  const preferences = normalizeBookmarkPreferences(value);
  const revision = typeof value.revision === 'string' && value.revision ? value.revision : undefined;
  const etag = header && /^"[\x21\x23-\x7e]+"$/u.test(header) ? header : undefined;
  if (!preferences || !revision || !etag) throw new BookmarkPreferencesProductError('bookmark_preferences_response_invalid', 200, true);
  return { value: preferences, revision, etag };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
