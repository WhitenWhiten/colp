import type { StoredCredential, StoredSession } from './types.js';
import type { SyncEndpoints } from './manifest-client.js';
import { colpCredentialHeaders } from './auth-client.js';
import { assertCredentialHostPermission } from './server-origin-permission.js';
import { readBoundedJson } from './json-response.js';
import {
  parseSyncTransportBudgetHeader,
  declaredClientTransportBudget,
  transportBudgetWithinDeclaration,
  SYNC_TRANSPORT_BUDGET_HEADER,
  type SyncTransportBudget,
} from './colp-transport-budget-browser.js';
import { measureClientClockSkew, serverNow, localTimeOf } from './session-clock.js';
import { authorityCodeForStatus, classifyHttpStatus } from './sync-transport-failure.js';
import { SERVER_VERSION_MISMATCH, classifySyncFailure } from './sync-failure-class.js';

const SESSION_RESPONSE_MAX_BYTES = 128 * 1_024;
const REPLICA_LEASE_RENEWAL_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_KEYS = new Set(['sessionId', 'expiresAt', 'serverTime', 'clockSkewMilliseconds',
  'acceptedProtocolVersion', 'scope', 'maxBatchOperations', 'tombstoneRetentionSeconds', 'replicaLease',
  'collection', 'conversionPolicy']);
const LEASE_KEYS = new Set(['leaseId', 'generation', 'state', 'lastSeenAt', 'expiresAt', 'acknowledgedCursor']);
const COLLECTION_KEYS = new Set(['collectionId', 'snapshotRequired', 'serverCursor', 'serverRevision']);
const CONVERSION_KEYS = new Set(['alias', 'separator', 'unknownExtensions']);
const MAX_RETRY_AFTER_SECONDS = 3_600;
/** The Session route answered "not found": the server does not know this replica id for this account or Collection. */
export const SESSION_REPLICA_UNKNOWN = 'session_replica_unknown';

export class SessionRequestError extends Error {
  readonly code: string;
  readonly retryAfterMilliseconds?: number;
  constructor(code: string, retryAfterMilliseconds?: number) {
    super(code); this.name = 'SessionRequestError'; this.code = code;
    if (retryAfterMilliseconds !== undefined) this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

export type SessionAuthority = 'active' | 'bootstrap' | 'recovery';

export function classifySessionAuthority(session: unknown, context: {
  readonly authorityRefreshRequired: boolean; readonly bootstrapped: boolean;
}): SessionAuthority {
  if (!record(session) || !record(session.replicaLease)
      || session.replicaLease.state !== 'active' || typeof session.snapshotRequired !== 'boolean') {
    throw new Error('session_authority_invalid');
  }
  if (!session.snapshotRequired) return 'active';
  const checkpoint = session.replicaLease.acknowledgedCursor;
  if (checkpoint === null && !context.bootstrapped) return 'bootstrap';
  if (typeof checkpoint === 'string') return 'recovery';
  return context.authorityRefreshRequired || context.bootstrapped ? 'recovery' : 'bootstrap';
}

export function createSessionAuthorityQueue() {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return Object.freeze({
    run<T>(operation: () => Promise<T>): Promise<T> {
      pending += 1;
      const result = tail.then(operation, operation);
      tail = result.then(() => { pending -= 1; }, () => { pending -= 1; });
      return result;
    },
    isInFlight: () => pending > 0,
  });
}

export function shouldForceSessionRefresh(requested: boolean, observedSessionId: string | null,
  currentSessionId: string | null): boolean {
  return requested && observedSessionId === currentSessionId;
}

export async function createSyncSession(input: { readonly endpoints: SyncEndpoints; readonly credential: StoredCredential;
  readonly request: unknown; readonly replicaProof?: string; readonly origin?: string; readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal }): Promise<StoredSession> {
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const signal = input.signal ? mergeAbortSignals(input.signal, timeout.signal) : timeout.signal;
  const sessionInit: RequestInit = { method: 'POST', redirect: 'error',
    cache: 'no-store', credentials: 'omit', signal,
    headers: { Accept: 'application/json', ...colpCredentialHeaders(input.credential.accessToken),
      'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(),
      ...(input.replicaProof ? { 'Known-Sync-Replica-Proof': input.replicaProof } : {}),
      ...(input.origin ? { Origin: input.origin } : {}) }, body: JSON.stringify(input.request) };
  let response: Response;
  try {
    await assertCredentialHostPermission(input.endpoints.syncSessions, sessionInit);
    response = await (input.fetch ?? fetch)(input.endpoints.syncSessions, sessionInit);
  } finally { clearTimeout(timer); }
  const receivedAt = Date.now();
  if (response.status !== 201 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    if (response.status === 401) throw new SessionRequestError('credential_revoked');
    const problem = await readBoundedJson(response, SESSION_RESPONSE_MAX_BYTES, 'session_problem_invalid', { signal: input.signal })
      .catch(() => undefined);
    // A gateway hiccup is transient whatever its body (or lack of one) says; an unreadable body on a denial keeps the status' meaning.
    const kind = classifyHttpStatus(response.status);
    const named = kind === 'transient' ? 'server_unavailable'
      : record(problem) && typeof problem.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(problem.code)
        ? problem.code : authorityCodeForStatus(response.status) ?? 'session_failed';
    // No Session exists yet, so "not found" here cannot mean an expired one: the server does not know this replica id
    // for this account (or this Collection). Renewing authority cannot cure it (W2B-P1-3).
    const code = response.status === 404 && named === 'resource_not_found' ? SESSION_REPLICA_UNKNOWN : named;
    const retryAfterMilliseconds = code === 'rate_limited' ? sessionRetryAfter(response, problem) : undefined;
    throw new SessionRequestError(code, retryAfterMilliseconds);
  }
  const value = await readBoundedJson(response, SESSION_RESPONSE_MAX_BYTES, 'session_invalid', { signal: input.signal });
  let transportBudget: SyncTransportBudget;
  try {
    transportBudget = parseSyncTransportBudgetHeader(response.headers.get(SYNC_TRANSPORT_BUDGET_HEADER));
    if (!transportBudgetWithinDeclaration(transportBudget, declaredClientTransportBudget(input.request))) {
      throw new Error('server budget exceeds client declaration');
    }
  } catch {
    throw new Error('session_invalid');
  }
  return parseSyncSessionResult(value, input.request, await credentialAuthorityDigest(input.credential.accessToken),
    transportBudget, receivedAt);
}

export function parseSyncSessionResult(value: unknown, requestInput: unknown,
  authorityDigest: string, transportBudget?: SyncTransportBudget, receivedAt: number = Date.now()): StoredSession {
  // W2C-12: strict same-version validation stays, but an unknown field says "newer server", not "broken Session".
  if (record(value) && hasUnknownSessionField(value)) throw new Error(SERVER_VERSION_MISMATCH);
  const request = record(requestInput) ? requestInput : {};
  const requestCollection = record(request.collection) ? request.collection : {};
  const replica = record(request.replica) ? request.replica : {};
  const capabilities = record(replica.capabilities) ? replica.capabilities : {};
  if (!record(value) || !exactKeys(value, SESSION_KEYS) || typeof value.sessionId !== 'string' || value.scope !== 'collection'
      || value.acceptedProtocolVersion !== '0.2' || !Number.isSafeInteger(value.maxBatchOperations)
      || Number(value.maxBatchOperations) < 1 || Number(value.maxBatchOperations) > 50
      || Number(value.maxBatchOperations) > Number(capabilities.maxBatchOperations ?? 1)
      || typeof value.serverTime !== 'string' || !validDate(value.serverTime) || typeof value.expiresAt !== 'string'
      || !validDate(value.expiresAt) || Date.parse(string(value.expiresAt)) <= Date.parse(string(value.serverTime))
      || !Number.isSafeInteger(value.clockSkewMilliseconds) || !Number.isSafeInteger(value.tombstoneRetentionSeconds)
      || !record(value.collection) || value.collection.collectionId !== requestCollection.collectionId
      || !exactKeys(value.collection, COLLECTION_KEYS)
      || typeof value.collection.snapshotRequired !== 'boolean' || typeof value.collection.serverCursor !== 'string'
      || typeof value.collection.serverRevision !== 'string' || !record(value.replicaLease)
      || !exactKeys(value.replicaLease, LEASE_KEYS)
      || typeof value.replicaLease.leaseId !== 'string' || typeof value.replicaLease.generation !== 'string'
      || value.replicaLease.state !== 'active'
      || typeof value.replicaLease.lastSeenAt !== 'string' || !validDate(value.replicaLease.lastSeenAt)
      || typeof value.replicaLease.expiresAt !== 'string' || !validDate(value.replicaLease.expiresAt)
      || !(value.replicaLease.acknowledgedCursor === null
        || typeof value.replicaLease.acknowledgedCursor === 'string' && value.replicaLease.acknowledgedCursor.length > 0)
      || Date.parse(string(value.replicaLease.expiresAt)) <= Date.parse(string(value.replicaLease.lastSeenAt))
      || !record(value.conversionPolicy) || !exactKeys(value.conversionPolicy, CONVERSION_KEYS)
      || typeof value.conversionPolicy.alias !== 'string'
      || !['duplicate', 'skip', 'reject'].includes(value.conversionPolicy.alias)
      || typeof value.conversionPolicy.separator !== 'string'
      || !['native', 'omit', 'preserve_remote', 'reject'].includes(value.conversionPolicy.separator)
      || typeof value.conversionPolicy.unknownExtensions !== 'string'
      || !['preserve_remote', 'sidecar', 'reject'].includes(value.conversionPolicy.unknownExtensions)) {
    throw new Error('session_invalid');
  }
  if (!/^[a-f0-9]{64}$/u.test(authorityDigest)) throw new Error('session_invalid');
  // W2B-P0-1: `expiresAt` and the lease are server time. Keep the offset so every expiry decision can use it.
  const clientClockSkewMilliseconds = measureClientClockSkew({ clientTime: request.clientTime,
    serverTime: string(value.serverTime), receivedAt });
  return Object.freeze({ sessionId: value.sessionId, credentialAuthorityDigest: authorityDigest,
    expiresAt: value.expiresAt, clientClockSkewMilliseconds, scope: 'collection',
    acceptedProtocolVersion: '0.2', maxBatchOperations: Number(value.maxBatchOperations), snapshotRequired: value.collection.snapshotRequired,
    conversionPolicy: { separator: value.conversionPolicy.separator as
      'native' | 'omit' | 'preserve_remote' | 'reject' },
    collection: { collectionId: string(value.collection.collectionId), serverCursor: string(value.collection.serverCursor),
      serverRevision: string(value.collection.serverRevision) },
    replicaLease: { leaseId: string(value.replicaLease.leaseId), generation: string(value.replicaLease.generation),
      state: 'active' as const, expiresAt: string(value.replicaLease.expiresAt),
      acknowledgedCursor: value.replicaLease.acknowledgedCursor === null ? null : string(value.replicaLease.acknowledgedCursor) },
    transportBudget: transportBudget ?? parseSyncTransportBudgetHeader(null) });
}

export async function credentialAuthorityDigest(accessToken: string): Promise<string> {
  if (typeof accessToken !== 'string' || accessToken.length < 1) throw new Error('credential_invalid');
  const authorityBinding = `known.session-credential-authority.v1\0${accessToken}`;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorityBinding)));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sessionMatchesCredentialAuthority(session: StoredSession,
  credential: Pick<StoredCredential, 'accessToken'>): Promise<boolean> {
  return typeof session.credentialAuthorityDigest === 'string'
    && /^[a-f0-9]{64}$/u.test(session.credentialAuthorityDigest)
    && session.credentialAuthorityDigest === await credentialAuthorityDigest(credential.accessToken);
}

/** `now` is this computer's clock; the Session and its lease expire in server time (W2B-P0-1). */
export function syncSessionNeedsRenewal(session: StoredSession, now = Date.now()): boolean {
  const server = serverNow(session, now);
  return Date.parse(session.expiresAt) <= server + REPLICA_LEASE_RENEWAL_MARGIN_MS
    || (session.replicaLease as { readonly state: unknown }).state !== 'active'
    || Date.parse(session.replicaLease.expiresAt) <= server + REPLICA_LEASE_RENEWAL_MARGIN_MS;
}

export async function retryStaleReplicaSession(session: StoredSession, error: unknown,
  renew: () => Promise<StoredSession>, now = Date.now()): Promise<StoredSession> {
  if (!(error instanceof Error) || error.message !== 'stale_replica'
      || Date.parse(session.expiresAt) <= serverNow(session, now)) throw error;
  return renew();
}

export function retainSessionAfterTransientRenewalFailure(session: StoredSession, error: unknown,
  now = Date.now()): boolean {
  const retryUntil = error instanceof SessionRequestError && error.code === 'rate_limited'
    && error.retryAfterMilliseconds !== undefined ? now + error.retryAfterMilliseconds : now;
  return localTimeOf(session, session.expiresAt) > retryUntil && localTimeOf(session, session.replicaLease.expiresAt) > retryUntil
    && transientRenewalFailure(error);
}

/**
 * The server or the network could not be asked, which says nothing about the Session in hand (W2B-P2-5): a 5xx, a
 * gateway timeout, a cut-off body, a deadline, a rate limit or a missing host permission. The failure table already
 * names these `transient`; a renewal that fails for one of them must not discard authority that is still valid.
 */
function transientRenewalFailure(error: unknown): boolean {
  if (error instanceof TypeError && error.message === 'Failed to fetch') return true;
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true;
  const code = error instanceof SessionRequestError ? error.code : error instanceof Error ? error.message : undefined;
  return classifySyncFailure(code)?.class === 'transient';
}
function mergeAbortSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([left, right]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (left.aborted || right.aborted) { controller.abort(); return controller.signal; }
  left.addEventListener('abort', abort, { once: true });
  right.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
function sessionRetryAfter(response: Response, problem: unknown): number | undefined {
  const header = positiveSeconds(response.headers.get('Retry-After'));
  const recovery = record(problem) && record(problem.recovery) ? problem.recovery : undefined;
  const body = record(problem) ? positiveSeconds(problem.retryAfterSeconds)
    ?? positiveSeconds(recovery?.retryAfterSeconds) : undefined;
  if (header === undefined || body !== undefined && body !== header) return undefined;
  return header * 1_000;
}
function positiveSeconds(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^[1-9][0-9]{0,3}$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && Number(parsed) >= 1 && Number(parsed) <= MAX_RETRY_AFTER_SECONDS
    ? Number(parsed) : undefined;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function hasUnknownSessionField(value: Record<string, unknown>): boolean {
  const unknown = (object: unknown, expected: ReadonlySet<string>) =>
    record(object) && Object.keys(object).some((key) => !expected.has(key));
  return unknown(value, SESSION_KEYS) || unknown(value.collection, COLLECTION_KEYS)
    || unknown(value.replicaLease, LEASE_KEYS) || unknown(value.conversionPolicy, CONVERSION_KEYS);
}
function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>) {
  const keys = Object.keys(value); return keys.length === expected.size && keys.every((key) => expected.has(key));
}
function string(value: unknown): string { if (typeof value !== 'string' || !value) throw new Error('session_invalid'); return value; }
function validDate(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
