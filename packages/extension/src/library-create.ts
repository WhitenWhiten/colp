import { colpCredentialHeaders } from './auth-client.js';
import { isProtocolOpaqueId } from './protocol-id.js';
import type { PublicCollectionChoice } from './types.js';

export const EXTENSION_COLLECTIONS_PATH = '/colp/v0.1/sync/collections';
export const LIBRARY_CREATE_IDEMPOTENCY = 'known.collections.create.idempotency.v1';
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{1,512}$/u;
const TITLE_MAX = 512;

export type LibraryCreateIdempotency = { readonly title: string; readonly key: string };
export type LibraryCreateResult =
  | { readonly ok: true; readonly collection: PublicCollectionChoice }
  | { readonly ok: false; readonly error: string };

export function libraryCreateIdempotency(
  stored: unknown, title: string, randomUUID: () => string,
): LibraryCreateIdempotency {
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const record = stored as Record<string, unknown>;
    if (record.title === title && typeof record.key === 'string' && IDEMPOTENCY_KEY.test(record.key)) {
      return { title, key: record.key };
    }
  }
  return { title, key: randomUUID() };
}

export function parseOwnedCollectionRecord(item: unknown): PublicCollectionChoice | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string'
      || typeof record.kind !== 'string' || typeof record.visibility !== 'string'
      || !isProtocolOpaqueId(record.id)) return undefined;
  return {
    id: record.id, title: record.title, kind: record.kind, visibility: record.visibility,
    ...(isProtocolOpaqueId(record.rootNodeId) ? { rootNodeId: record.rootNodeId } : {}),
  };
}

export async function postPrivateBookmarkLibrary(input: {
  readonly title: string; readonly serverOrigin: string; readonly accessToken: string;
  readonly origin: string; readonly idempotencyKey: string; readonly fetch?: typeof fetch;
}): Promise<LibraryCreateResult> {
  if (input.title.length < 1 || input.title.length > TITLE_MAX || input.title.trim().length === 0) {
    return { ok: false, error: 'invalid_request' };
  }
  const url = `${input.serverOrigin.replace(/\/$/u, '')}${EXTENSION_COLLECTIONS_PATH}`;
  const fetcher = input.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        ...colpCredentialHeaders(input.accessToken), Origin: input.origin,
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({ title: input.title }),
    });
  } catch { return { ok: false, error: 'offline' }; }
  if (response.status === 401 || response.status === 403) return { ok: false, error: 'collections_unauthorized' };
  if (response.status === 400) return { ok: false, error: 'invalid_request' };
  if (response.status !== 200 && response.status !== 201) {
    return { ok: false, error: response.status === 409 ? 'command_in_progress' : 'collections_unavailable' };
  }
  let body: unknown;
  try { body = await response.json(); } catch { return { ok: false, error: 'collections_unavailable' }; }
  const collection = parseOwnedCollectionRecord(body);
  if (!collection || collection.kind !== 'bookmarks' || collection.visibility !== 'private') {
    return { ok: false, error: 'collections_unavailable' };
  }
  return { ok: true, collection };
}
