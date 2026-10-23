import { readBoundedJson } from './json-response.js';
import { assertCredentialHostPermission } from './server-origin-permission.js';
import type { components } from './generated/favicon-helper-api.js';

export type IconPolicyDto = components['schemas']['FaviconOrderingIconPolicy'];
export type IconSourceDto = components['schemas']['FaviconOrderingIconSource'];
export type BookmarkNodeViewDto = components['schemas']['BookmarkNodeView'];

export const EXTENSION_FAVICON_POLICY_PATH = '/colp/v0.1/sync/favicon-policy';
export const EXTENSION_FAVICON_SOURCE_PATH =
  '/colp/v0.1/sync/collections/{collectionId}/nodes/{nodeId}/favicon-source';
export const EXTENSION_FAVICON_CAPTURE_PATH =
  '/colp/v0.1/sync/collections/{collectionId}/nodes/{nodeId}/favicon';

const HELPER_RESPONSE_MAX_BYTES = 64 * 1_024;

export interface FaviconHelperCredentials {
  readonly accessToken: string;
  readonly origin: string;
}

export interface FaviconHelperFetchOptions extends FaviconHelperCredentials {
  readonly serverOrigin: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** Stable helper failure: HTTP status plus the Product error code when present. */
export class FaviconHelperHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FaviconHelperHttpError';
  }
}

export interface ExtensionFaviconPolicyRead {
  readonly policy: IconPolicyDto;
  /** The strong account-policy ETag used by later captures. */
  readonly etag: string;
}

export interface ExtensionFaviconSourceRead {
  readonly source: IconSourceDto;
  /** The strong composite source ETag used by later captures. */
  readonly etag: string;
}

/** GET /colp/v0.1/sync/favicon-policy (FO-04 getExtensionFaviconPolicy). */
export async function fetchExtensionFaviconPolicy(
  options: FaviconHelperFetchOptions,
): Promise<ExtensionFaviconPolicyRead> {
  // EXTENSION_FAVICON_POLICY_PATH already starts with a '/'; the helperFetch
  // base is the exact origin, so no extra separator must be added.
  const response = await helperFetch(options, EXTENSION_FAVICON_POLICY_PATH);
  await assertHelperOk(response, 'The account favicon policy could not be read.');
  const body = await readBodyOrThrow(response, 'favicon_policy_invalid');
  assertIconPolicy(body);
  const etag = strongEtagHeader(response);
  if (etag === null) throw new FaviconHelperHttpError(response.status, 'favicon_policy_invalid', 'The favicon policy ETag is missing.');
  return { policy: body, etag };
}

/** GET /colp/v0.1/sync/collections/{cid}/nodes/{nid}/favicon-source (FO-04 getExtensionFaviconSource). */
export async function fetchExtensionFaviconSource(
  options: FaviconHelperFetchOptions,
  collectionId: string,
  nodeId: string,
): Promise<ExtensionFaviconSourceRead> {
  const response = await helperFetch(options, sourcePath(collectionId, nodeId));
  await assertHelperOk(response, 'The bookmark favicon source could not be read.');
  const body = await readBodyOrThrow(response, 'favicon_source_invalid');
  assertIconSource(body);
  const etag = strongEtagHeader(response);
  if (etag === null) throw new FaviconHelperHttpError(response.status, 'favicon_source_invalid', 'The favicon source ETag is missing.');
  return { source: body, etag };
}

/** POST /colp/v0.1/sync/collections/{cid}/nodes/{nid}/favicon (FO-04 captureExtensionFavicon). */
export async function captureExtensionFavicon(input: {
  readonly credentials: FaviconHelperCredentials;
  readonly serverOrigin: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly commandId: string;
  readonly ifMatch: string;
  readonly policyRevision: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<{ readonly status: number; readonly view: BookmarkNodeViewDto }> {
  const response = await helperFetch(
    { ...input.credentials, serverOrigin: input.serverOrigin, fetch: input.fetch, signal: input.signal },
    capturePath(input.collectionId, input.nodeId),
    {
      method: 'POST',
      headers: {
        'Known-Command-Id': input.commandId,
        'If-Match': input.ifMatch,
        'Known-Favicon-Policy-Revision': input.policyRevision,
        'Content-Type': input.contentType,
      },
      body: input.bytes,
    },
  );
  await assertHelperOk(response, 'The favicon capture was rejected by the server.');
  const view = await readBodyOrThrow(response, 'favicon_capture_invalid');
  assertBookmarkNodeView(view);
  return { status: response.status, view };
}

/** DELETE /colp/v0.1/sync/collections/{cid}/nodes/{nid}/favicon (FO-04 clearExtensionCapturedFavicon). */
export async function clearExtensionCapturedFavicon(input: {
  readonly credentials: FaviconHelperCredentials;
  readonly serverOrigin: string;
  readonly collectionId: string;
  readonly nodeId: string;
  readonly commandId: string;
  readonly ifMatch: string;
  readonly policyRevision: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<{ readonly status: number; readonly view: BookmarkNodeViewDto }> {
  const response = await helperFetch(
    { ...input.credentials, serverOrigin: input.serverOrigin, fetch: input.fetch, signal: input.signal },
    capturePath(input.collectionId, input.nodeId),
    {
      method: 'DELETE',
      headers: {
        'Known-Command-Id': input.commandId,
        'If-Match': input.ifMatch,
        'Known-Favicon-Policy-Revision': input.policyRevision,
      },
    },
  );
  await assertHelperOk(response, 'The favicon clear was rejected by the server.');
  const view = await readBodyOrThrow(response, 'favicon_clear_invalid');
  assertBookmarkNodeView(view);
  return { status: response.status, view };
}

/** The server policy revision header value for a capture/clear (contract Revision). */
export function policyRevisionOf(policy: IconPolicyDto): string {
  return policy.revision;
}

/** Whether the account policy wants automatic captured icons at all (FO-04 client gate). */
export function policyAllowsAutomaticCapture(policy: IconPolicyDto): boolean {
  return policy.newDefault !== 'none' && !policy.forceAllOnline;
}

/** Whether the current source state is capturable by the extension helper (client-side mirror of the server refusal list). */
export function sourceAllowsAutomaticCapture(source: IconSourceDto): boolean {
  const { sourceMode, effectiveMode } = source;
  if (sourceMode === 'uploaded' || sourceMode === 'none') return false;
  if (effectiveMode === 'uploaded' || effectiveMode === 'none') return false;
  return true;
}

function sourcePath(collectionId: string, nodeId: string): string {
  return EXTENSION_FAVICON_SOURCE_PATH
    .replace('{collectionId}', encodeURIComponent(collectionId))
    .replace('{nodeId}', encodeURIComponent(nodeId));
}

function capturePath(collectionId: string, nodeId: string): string {
  return EXTENSION_FAVICON_CAPTURE_PATH
    .replace('{collectionId}', encodeURIComponent(collectionId))
    .replace('{nodeId}', encodeURIComponent(nodeId));
}

async function helperFetch(
  options: FaviconHelperFetchOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  const base = options.serverOrigin.replace(/\/$/u, '');
  const headers = new Headers(init.headers);
  headers.set('Authorization', bearerOf(options.accessToken));
  headers.set('Origin', options.origin);
  const url = `${base}${path}`;
  const request: RequestInit = {
    ...init,
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
    headers,
    signal: options.signal,
  };
  try {
    await assertCredentialHostPermission(url, request);
    return await fetcher(url, request);
  } catch (error) {
    throw helperTransportError(error);
  }
}

function bearerOf(accessToken: string): string {
  if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8_192
      || !/^[\x21-\x7e]+$/u.test(accessToken)) {
    throw new Error('session_cookie_invalid');
  }
  return `Bearer ${accessToken}`;
}

function readBodyOrThrow(response: Response, code: string): Promise<unknown> {
  try {
    return readBoundedJson(response, HELPER_RESPONSE_MAX_BYTES, code);
  } catch (error) {
    if (error instanceof FaviconHelperHttpError) throw error;
    throw new FaviconHelperHttpError(response.status, code, 'The favicon helper response is invalid.');
  }
}

function strongEtagHeader(response: Response): string | null {
  const value = response.headers.get('etag');
  if (value === null) return null;
  const trimmed = value.trim();
  const candidate = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
  if (candidate.length < 3 || !/^"[^"\r\n]+"$/u.test(candidate)) return null;
  return candidate;
}

async function assertHelperOk(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 0) throw new FaviconHelperHttpError(0, 'offline', 'The favicon helper is unreachable.');
  let code = 'helper_rejected';
  try {
    const body = await readBoundedJson(response, HELPER_RESPONSE_MAX_BYTES, 'helper_rejected');
    const nested = record(body) && record(body.error) ? (body as { error: Record<string, unknown> }).error : body;
    if (record(nested) && typeof nested.code === 'string' && /^[a-z][a-z0-9_:-]{1,63}$/u.test(nested.code)) {
      code = nested.code;
    }
  } catch {
    // The status alone is enough to steer the drain (428/403/412/404/429/5xx).
  }
  if (response.status === 401 || response.status === 403) {
    throw new FaviconHelperHttpError(response.status, code, 'The favicon helper credential was rejected.');
  }
  throw new FaviconHelperHttpError(response.status, code, fallback);
}

function helperTransportError(error: unknown): FaviconHelperHttpError {
  if (error instanceof FaviconHelperHttpError) return error;
  if (error instanceof TypeError && /fetch|network|abort/i.test(error.message)) {
    return new FaviconHelperHttpError(0, 'offline', 'The favicon helper is unreachable.');
  }
  if (error instanceof Error && /abort/i.test(error.message)) {
    return new FaviconHelperHttpError(0, 'offline', 'The favicon helper request was aborted.');
  }
  return new FaviconHelperHttpError(0, 'offline', 'The favicon helper request failed.');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertIconPolicy(value: unknown): asserts value is IconPolicyDto {
  if (!record(value)) throw new FaviconHelperHttpError(200, 'favicon_policy_invalid', 'The favicon policy is invalid.');
  if (typeof value.revision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value.revision)) {
    throw new FaviconHelperHttpError(200, 'favicon_policy_invalid', 'The favicon policy revision is invalid.');
  }
  if (value.newDefault !== 'capture' && value.newDefault !== 'online' && value.newDefault !== 'none') {
    throw new FaviconHelperHttpError(200, 'favicon_policy_invalid', 'The favicon policy default is invalid.');
  }
  if (typeof value.forceAllOnline !== 'boolean') {
    throw new FaviconHelperHttpError(200, 'favicon_policy_invalid', 'The favicon policy force flag is invalid.');
  }
}

function assertIconSource(value: unknown): asserts value is IconSourceDto {
  if (!record(value)) throw new FaviconHelperHttpError(200, 'favicon_source_invalid', 'The favicon source is invalid.');
  if (typeof value.collectionId !== 'string' || typeof value.nodeId !== 'string') {
    throw new FaviconHelperHttpError(200, 'favicon_source_invalid', 'The favicon source ids are invalid.');
  }
  if (typeof value.revision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value.revision)) {
    throw new FaviconHelperHttpError(200, 'favicon_source_invalid', 'The favicon source revision is invalid.');
  }
  if (typeof value.policyRevision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value.policyRevision)) {
    throw new FaviconHelperHttpError(200, 'favicon_source_invalid', 'The favicon source policy revision is invalid.');
  }
  for (const key of ['sourceMode', 'effectiveMode', 'status'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new FaviconHelperHttpError(200, 'favicon_source_invalid', `The favicon source ${key} is invalid.`);
    }
  }
}

function assertBookmarkNodeView(value: unknown): asserts value is BookmarkNodeViewDto {
  if (!record(value) || typeof value.id !== 'string' || value.kind !== 'bookmark') {
    throw new FaviconHelperHttpError(200, 'favicon_capture_invalid', 'The bookmark node view is invalid.');
  }
}
