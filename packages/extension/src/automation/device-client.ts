import type { BundleAckInput, LocalReceiptInput } from '@know-n/colp/automation';
import { colpCredentialHeaders } from '../auth-client.js';
import { assertCredentialHostPermission, SERVER_HOST_PERMISSION_ERROR } from '../server-origin-permission.js';
import { readBoundedJson } from '../json-response.js';

/**
 * The automation device routes (`/api/v1/automation-device/*`). They take the
 * same bearer and Sync session as Sync itself and never a cookie. Answers are
 * returned unparsed: the caller validates them against the shared schema.
 */
export interface DeviceAuthority {
  readonly serverOrigin: string;
  readonly accessToken: string;
  readonly sessionId: string;
  readonly origin: string;
}

export type DeviceProblem = 'offline' | 'unavailable' | 'signedOut' | 'rateLimited' | 'server' | 'invalid';
export type DeviceResult = { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly problem: DeviceProblem; readonly status: number; readonly code?: string; readonly retryAfterMs?: number };

const BASE = '/api/v1/automation-device';
const MAX_BYTES = 1_200_000;
const TIMEOUT_MS = 15_000;

function problemFor(status: number): DeviceProblem {
  if (status === 401 || status === 403) return 'signedOut';
  if (status === 404) return 'unavailable';
  if (status === 429 || status === 503) return 'rateLimited';
  return 'server';
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  return value && /^\d{1,6}$/u.test(value) ? Number(value) * 1_000 : undefined;
}

async function call(authority: DeviceAuthority, path: string, init: { method: 'GET' | 'POST'; body?: unknown; commandId?: string },
  fetcher: typeof fetch): Promise<DeviceResult> {
  let response: Response;
  const url = `${authority.serverOrigin.replace(/\/$/u, '')}${BASE}${path}`;
  const request: RequestInit = {
    method: init.method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json', ...colpCredentialHeaders(authority.accessToken), Origin: authority.origin,
      'Known-Sync-Session': authority.sessionId,
      ...(init.method === 'POST' ? { 'Content-Type': 'application/json', 'Known-Command-Id': init.commandId! } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  };
  try {
    await assertCredentialHostPermission(url, request);
    response = await fetcher(url, request);
  } catch (error) {
    if (error instanceof Error && error.message === SERVER_HOST_PERMISSION_ERROR) throw error;
    return { ok: false, problem: 'offline', status: 0 };
  }
  let body: unknown;
  try { body = await readBoundedJson(response, MAX_BYTES, 'automation_device_response_invalid'); }
  catch { return response.ok ? { ok: false, problem: 'invalid', status: response.status } : { ok: false, problem: problemFor(response.status), status: response.status }; }
  if (response.ok) return { ok: true, status: response.status, body };
  const error = body && typeof body === 'object' && 'error' in body ? (body as { error?: { code?: unknown } }).error : undefined;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const after = retryAfter(response);
  return { ok: false, problem: problemFor(response.status), status: response.status, ...(code ? { code } : {}),
    ...(after === undefined ? {} : { retryAfterMs: after }) };
}

export function fetchRuleBundle(authority: DeviceAuthority, fetcher: typeof fetch = fetch): Promise<DeviceResult> {
  return call(authority, '/bundle?profile=browser-bounded-v1', { method: 'GET' }, fetcher);
}

export function acknowledgeRuleBundle(authority: DeviceAuthority, input: BundleAckInput, commandId: string,
  fetcher: typeof fetch = fetch): Promise<DeviceResult> {
  return call(authority, '/bundle-acks', { method: 'POST', body: input, commandId }, fetcher);
}

/** A canonical-only receipt; `serializeReceipt` has already validated it against the contract. */
export function postIntakeReceipt(authority: DeviceAuthority, input: LocalReceiptInput, commandId: string,
  fetcher: typeof fetch = fetch): Promise<DeviceResult> {
  return call(authority, '/intake-receipts', { method: 'POST', body: input, commandId }, fetcher);
}
