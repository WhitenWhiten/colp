import { readBoundedJson } from './json-response.js';

export class NoteSyncError extends Error {
  constructor(readonly status: number, readonly code: string, readonly sameRequestRetrySafe = false) { super(code); }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export interface NoteProductTransportOptions {
  readonly serverOrigin: string; readonly accountId: string; readonly collectionId: string;
  readonly assertCurrent: () => Promise<void>;
  readonly dispatch?: (send: () => Promise<Response>) => Promise<Response>;
  readonly signal?: AbortSignal; readonly fetch?: typeof fetch;
}
export interface NoteProductRequest {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly command?: { readonly commandId: string; readonly revision?: string };
  readonly guard: () => Promise<void>;
  readonly maxBytes?: number;
}

/** One verified session per bounded scan; every resource response remains bound to that session. */
export function createNoteProductTransport(options: NoteProductTransportOptions) {
  const origin = new URL(options.serverOrigin);
  if (origin.origin !== options.serverOrigin || origin.username || origin.password || !(origin.protocol === 'https:'
    || origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('invalid_origin');
  const fetcher = options.fetch ?? fetch;
  const root = `/api/v1/collections/${encodeURIComponent(options.collectionId)}/annotations`;
  let auth: { sessionId: string; csrf: string } | undefined;
  async function raw(path: string, init: RequestInit = {}, guard?: () => Promise<void>) {
    const check = async () => { await options.assertCurrent(); await guard?.(); };
    await check();
    const send = async () => {
      await check();
      return fetcher(origin.origin + path, { ...init, credentials: 'include', redirect: 'error', cache: 'no-store',
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    };
    const response = await (options.dispatch ? options.dispatch(send) : send());
    await check();
    return response;
  }
  async function identity() {
    const session = await raw('/api/v1/session'), identity = await raw('/api/v1/auth/get-session');
    if (!session.ok || !identity.ok) throw new NoteSyncError(401, 'reconnect_required');
    const state = await readBoundedJson(session, 65536, 'annotation_response_invalid');
    const user = await readBoundedJson(identity, 65536, 'annotation_response_invalid');
    await options.assertCurrent();
    if (!object(state) || state.authenticated !== true || typeof state.csrfToken !== 'string' || !state.csrfToken
      || state.csrfToken.length > 1024 || /[\u0000-\u001f]/u.test(state.csrfToken)
      || !object(user) || !object(user.user) || user.user.id !== options.accountId || !object(user.session)
      || typeof user.session.id !== 'string' || !user.session.id || user.session.id.length > 256
      || /[\u0000-\u001f]/u.test(user.session.id)) throw new NoteSyncError(401, 'reconnect_required');
    auth = { csrf: state.csrfToken, sessionId: user.session.id };
    return auth;
  }
  async function request(path: string, input: NoteProductRequest, retryCsrf = true): Promise<unknown> {
    const url = new URL(path, origin.origin), tail = url.pathname.slice(root.length);
    if (url.origin !== origin.origin || !url.pathname.startsWith(root) || url.hash
      || (tail !== '' && (!tail.startsWith('/') || tail.length === 1 || tail.slice(1).includes('/')))) throw new Error('invalid_path');
    const verified = auth ?? await identity(), method = input.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json', 'Known-Annotation-Session': verified.sessionId };
    if (method !== 'GET') {
      if (!input.command || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.command.commandId)) throw new Error('invalid_command');
      headers['Known-Command-Id'] = input.command.commandId; headers['X-CSRF-Token'] = verified.csrf;
      if (method !== 'POST') {
        if (!input.command.revision || /[\u0000-\u001f"\\]/u.test(input.command.revision)) throw new Error('invalid_revision');
        headers['If-Match'] = `"${input.command.revision}"`;
      }
      if (input.body !== undefined) headers['Content-Type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
    }
    const response = await raw(path, { method, headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) }, input.guard);
    const bound = response.headers.get('Known-Annotation-Session') === verified.sessionId;
    // A CSRF refusal precedes session binding/admission. Only this error may be inspected without a bound session.
    if (!bound && response.status !== 403) throw new NoteSyncError(401, 'reconnect_required');
    const data = await readBoundedJson(response, bound ? input.maxBytes ?? 256 * 1024 : 16384, 'annotation_response_invalid');
    await options.assertCurrent(); await input.guard();
    const error = object(data) && object(data.error) ? data.error : undefined;
    if (retryCsrf && response.status === 403 && error?.code === 'csrf_failed') {
      auth = undefined; await identity(); return request(path, input, false);
    }
    if (!bound) throw new NoteSyncError(401, 'reconnect_required');
    if (!response.ok) throw new NoteSyncError(response.status,
      typeof error?.code === 'string' ? error.code : 'annotation_unavailable', error?.sameRequestRetrySafe === true);
    return data;
  }
  return { request, authority: Object.freeze({ serverOrigin: options.serverOrigin,
    accountId: options.accountId, collectionId: options.collectionId }) };
}
export type NoteProductTransport = ReturnType<typeof createNoteProductTransport>;
