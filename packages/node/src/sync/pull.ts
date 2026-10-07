import { snapshotPullEventStorePage } from './pull-page-budget.js';

import { createValidatorRegistry } from '../schema/index.js';
import { principalTypes } from '../shared/protocol-vocabulary.js';
import { isPrivateOrLocalLiteralHostname } from '../shared/private-or-local-literal-host.js';
import type {
  AuthoritativeEffectPage,
  AuthoritativeEffectPageRef,
  PrincipalRef,
  Problem,
  SyncPull,
  SyncPullEvent,
  SyncPullEventV02,
  SyncPullV02,
} from '../types/index.js';
import {
  DEFAULT_IMMUTABLE_JSON_MAX_DEPTH, DEFAULT_IMMUTABLE_JSON_MAX_MEMBERS,
  immutableJsonData, immutableJsonSnapshot,
} from '../shared/immutable-json.js';
import {
  AUTHORITATIVE_EFFECT_MAX_BYTES,
  AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES,
  AUTHORITATIVE_EFFECT_MAX_DEPTH,
  AUTHORITATIVE_EFFECT_MAX_MEMBERS,
  AUTHORITATIVE_EFFECT_SERIES_MAX_MEMBERS,
  assertAuthoritativeEffectPageUrlSafe,
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  encodeCanonicalJson,
  expandAuthoritativeEffectPageUrl,
} from './canonical.js';
import { assertEffectBinding } from './authoritative-effect-kind.js';
import {
  nonEmptyString,
  requirePromise,
} from './internal-guards.js';
import {
  assertExactKeys,
  canonicalOrdinal,
  resolveEventCursorRecords,
  resolvePullStartCursor,
  sameCursorScope,
  type SyncPullCursorRecord,
  type SyncPullCursorStore,
} from './pull-cursor-lifecycle.js';

export type {
  SyncPullCursorBinding,
  SyncPullCursorHandoffAuthorization,
  SyncPullCursorHandoffRequest,
  SyncPullCursorRecord,
  SyncPullCursorState,
  SyncPullCursorStore,
  SyncPullInitialCursorRequest,
} from './pull-cursor-lifecycle.js';

export {
  AUTHORITATIVE_EFFECT_MAX_BYTES,
  AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES,
  AUTHORITATIVE_EFFECT_MAX_DEPTH,
  AUTHORITATIVE_EFFECT_MAX_MEMBERS,
  EFFECT_PAGE_TEMPLATE_VARIABLES,
  assertAuthoritativeEffectPageUrlSafe,
  canonicalAuthoritativeEffectDigest,
  canonicalAuthoritativeEffectPageDigest,
  canonicalAuthoritativeMemberDigest,
  canonicalOperationDigest,
  expandAuthoritativeEffectPageUrl,
} from './canonical.js';

/**
 * Largest page a Pull request may ask for.
 *
 * A host may clamp lower, but the schema has no `maximum`, so without this bound
 * a consumer that wires the coordinator directly could ask for a million events
 * and make it walk them one cursor lookup at a time.
 */
export const SYNC_PULL_MAX_LIMIT = 1_000;

export { SYNC_PULL_PAGE_MAX_MEMBERS, SYNC_PULL_PAGE_MAX_BYTES } from './pull-page-budget.js';

export interface SyncPullRequestContext {
  readonly sessionId: string;
  readonly principal: PrincipalRef;
  readonly collectionId: string;
  /** Session-accepted version; only `'0.1'` and `'0.2'` are served. */
  readonly protocolVersion: AuthoritativePullProtocolVersion | (string & {});
  /** Trusted Manifest authority required when a COLP 0.2 event uses effectRef. */
  readonly effectPageAuthority?: string;
  /** Exact Manifest syncEffectPages URI template required when a 0.2 event uses effectRef. */
  readonly effectPageTemplate?: string;
  /**
   * Opaque wire cursor, never interpreted by the coordinator. `null` is the
   * first Pull of a Session: the Cursor store issues a cursor bound to that
   * Session at its initial exclusive position.
   */
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * Host policy hook for expired-cursor Snapshot URLs after transport checks pass.
 *
 * Invoked only for protocol- and userinfo-valid URLs. Throw to reject; return
 * void. Non-void returns are ignored (void-only contract).
 */
export type SyncPullSnapshotUrlSafetyAssert = (url: URL, raw: string) => void;

/**
 * Snapshot URL transport + optional host policy for expired-cursor recovery
 *.
 *
 * Default (omitted / false): only absolute `https:` Snapshot URLs are accepted.
 * Set `allowInsecureSnapshotUrl: true` to also accept `http:`. Credentials
 * embedded in the URL (`userinfo`) are always rejected.
 *
 * Optional `assertSnapshotUrlSafe` runs after those transport checks so hosts
 * can reject private/local IPs, metadata endpoints, or enforce allowlists
 * without DNS I/O in this package.
 *
 * **Bare** {@link coordinateSyncPull}: omitted hook leaves host policy
 * transport-only (backward compatible).
 *
 * **Session-bound** {@link coordinateSessionBoundPull}: when the hook is
 * omitted, the library installs {@link rejectPrivateOrLocalSnapshotUrl} by
 * default. Hosts that fetch recovery Snapshot URLs should keep that default
 * or pass a stricter allowlist. Pass an explicit no-op / custom hook only when
 * intentionally opting out of the private/local rejector.
 */
export interface SyncPullSnapshotUrlOptions {
  readonly allowInsecureSnapshotUrl?: boolean;
  /**
   * Optional fail-closed host / SSRF policy. Called after scheme and userinfo
   * validation. Throw to reject the Snapshot URL; exceptions propagate.
   */
  readonly assertSnapshotUrlSafe?: SyncPullSnapshotUrlSafetyAssert;
}

export interface SyncPullCommittedEvent {
  /** Canonical, non-negative base-10 integer without leading zeroes. */
  readonly commitOrdinal: string;
  readonly event: SyncPullEvent | SyncPullEventV02;
}

export interface SyncPullEventReadRequest {
  readonly sessionId: string;
  readonly principal: PrincipalRef;
  readonly collectionId: string;
  readonly protocolVersion: string;
  readonly afterCommitOrdinal: string;
  readonly limit: number;
}

export interface SyncPullEventPage {
  /** Already committed entries in authoritative commit order. */
  readonly entries: readonly SyncPullCommittedEvent[];
  readonly hasMore: boolean;
  readonly collectionRevision: string;
  readonly recommendedPullAfterSeconds: number;
}

/**
 * Thrown by {@link SyncPullEventStore.readCommittedAfter} when the log no
 * longer retains every event after `afterCommitOrdinal` (retention or a
 * Tombstone purge advanced past it after the start cursor was resolved). The
 * coordinator answers `410 sync_cursor_expired` instead of returning a page
 * with a silent gap.
 */
export class SyncPullLogTruncatedError extends Error {
  /** Optional Snapshot recovery hint, validated like an expired cursor's. */
  readonly snapshotUrl: string | undefined;

  constructor(snapshotUrl?: string) {
    super('The Sync log no longer retains every event after the requested position.');
    this.name = 'SyncPullLogTruncatedError';
    this.snapshotUrl = snapshotUrl;
  }
}

/**
 * Document/database adapters must provide a durable total commit order and a
 * coherent page. This module deliberately provides no process-local store.
 *
 * The start cursor is resolved by a separate Cursor store call, so the log can
 * be truncated between that call and this read. The adapter MUST compare
 * `afterCommitOrdinal` with its earliest retained position inside the same
 * read and throw {@link SyncPullLogTruncatedError} when events after it are
 * gone. Returning the remaining events would skip the purged ones silently.
 */
export interface SyncPullEventStore {
  readCommittedAfter(request: SyncPullEventReadRequest): Promise<SyncPullEventPage>;
}

export type SyncPullProblem = Problem & {
  readonly status: 400 | 410;
  readonly code: 'invalid_cursor_scope' | 'sync_cursor_expired';
};

export interface SyncPullCoordinatorSuccess {
  readonly ok: true;
  readonly status: 200;
  readonly body: SyncPull | SyncPullV02;
}

export interface SyncPullCoordinatorFailure {
  readonly ok: false;
  readonly status: 400 | 410;
  readonly problem: SyncPullProblem;
}

export type SyncPullCoordinatorResult = SyncPullCoordinatorSuccess | SyncPullCoordinatorFailure;

function immutableData<Value>(value: Value, label: string, seen = new Set<object>()): Value {
  return immutableJsonData(value, label, seen);
}

function invalidCursorScope(): SyncPullCoordinatorFailure {
  const problem = immutableData({
    type: 'https://collectionprotocol.org/problems/invalid-cursor-scope',
    title: 'Invalid cursor scope',
    status: 400 as const,
    code: 'invalid_cursor_scope' as const,
    detail: 'The cursor is not valid for this sync context.',
    retryable: false,
  }, 'invalid_cursor_scope Problem') as SyncPullProblem;
  return Object.freeze({ ok: false, status: 400, problem });
}

function cursorExpired(snapshotUrl: string | undefined): SyncPullCoordinatorFailure {
  const problem = immutableData({
    type: 'https://collectionprotocol.org/problems/sync-cursor-expired',
    title: 'Sync cursor expired',
    status: 410 as const,
    code: 'sync_cursor_expired' as const,
    detail: 'The sync log represented by this cursor is no longer available.',
    // The wire `problem` schema keeps snapshotUrl optional: a host that cannot
    // publish a Snapshot still answers a deterministic 410.
    ...(snapshotUrl === undefined ? {} : { snapshotUrl }),
    retryable: false,
  }, 'sync_cursor_expired Problem') as SyncPullProblem;
  return Object.freeze({ ok: false, status: 410, problem });
}

type NormalizedSnapshotUrlOptions = {
  readonly allowInsecureSnapshotUrl: boolean;
  readonly assertSnapshotUrlSafe?: SyncPullSnapshotUrlSafetyAssert;
};

function validateSnapshotUrl(
  value: unknown,
  options: NormalizedSnapshotUrlOptions,
): string {
  const snapshotUrl = nonEmptyString(value, 'Expired Sync Cursor snapshotUrl');
  let parsed: URL;
  try {
    parsed = new URL(snapshotUrl);
  } catch {
    throw new TypeError(
      options.allowInsecureSnapshotUrl
        ? 'Expired Sync Cursor snapshotUrl must be an absolute HTTP(S) URL.'
        : 'Expired Sync Cursor snapshotUrl must be an absolute HTTPS URL.',
    );
  }
  if (options.allowInsecureSnapshotUrl) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('Expired Sync Cursor snapshotUrl must be an absolute HTTP(S) URL.');
    }
  } else if (parsed.protocol !== 'https:') {
    throw new TypeError('Expired Sync Cursor snapshotUrl must be an absolute HTTPS URL.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Expired Sync Cursor snapshotUrl must not embed credentials.');
  }
  // Host / SSRF policy sees only transport-valid URLs (scheme + no userinfo).
  if (options.assertSnapshotUrlSafe !== undefined) {
    options.assertSnapshotUrlSafe(parsed, snapshotUrl);
  }
  return snapshotUrl;
}

/**
 * literal hosts only; fetching party still owns resolved-address SSRF.
 *
 * Built-in Snapshot URL host policy: reject common SSRF targets using pure
 * hostname / IP-literal checks (no DNS or network I/O).
 *
 * Blocks:
 * - hostname `localhost` and `*.localhost` (case-insensitive via URL hostname)
 * - IPv4 loopback `127.0.0.0/8`, unspecified `0.0.0.0/8`
 * - private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 * - CGNAT / shared address space `100.64.0.0/10`
 * - link-local `169.254.0.0/16` (includes cloud metadata `169.254.169.254`)
 * - decimal / `0x`-hex single-number IPv4 host forms of the above
 * - IPv6 `::1`, `::`, link-local `fe80::/10`, ULA `fc00::/7`
 * - IPv4-mapped IPv6 (`::ffff:x.x.x.x`) when the embedded IPv4 is blocked
 *
 * Non-literal hostnames other than localhost forms are allowed (no resolution).
 * This is **not** a complete SSRF control: DNS rebinding and non-literal names
 * that resolve to private addresses remain host responsibilities (prefer
 * allowlists when the host actually fetches the Snapshot URL).
 *
 * Pass as `assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl` (or wrap for
 * allowlists). Session-bound Pull installs this by default when the hook is
 * omitted; bare `coordinateSyncPull` does not.
 */
export function rejectPrivateOrLocalSnapshotUrl(url: URL): void {
  if (!(url instanceof URL)) {
    throw new TypeError('rejectPrivateOrLocalSnapshotUrl expects a URL instance.');
  }
  if (isPrivateOrLocalLiteralHostname(url.hostname)) {
    throw new TypeError(
      'Expired Sync Cursor snapshotUrl must not target localhost or a private/local address.',
    );
  }
}

/**
 * Recommended Snapshot URL options for hosts that **fetch** expired-cursor
 * recovery URLs: keep transport defaults and install
 * {@link rejectPrivateOrLocalSnapshotUrl} unless the host supplies its own
 * `assertSnapshotUrlSafe` (allowlist / stricter policy / intentional no-op).
 *
 * Used by {@link coordinateSessionBoundPull} when options omit the hook.
 */
export function withRecommendedSnapshotUrlHostPolicy(
  options?: SyncPullSnapshotUrlOptions,
): SyncPullSnapshotUrlOptions {
  if (options?.assertSnapshotUrlSafe !== undefined) {
    return options;
  }
  if (options?.allowInsecureSnapshotUrl !== undefined) {
    return Object.freeze({
      allowInsecureSnapshotUrl: options.allowInsecureSnapshotUrl,
      assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl,
    });
  }
  return Object.freeze({
    assertSnapshotUrlSafe: rejectPrivateOrLocalSnapshotUrl,
  });
}

function immutableRequest(candidate: SyncPullRequestContext): SyncPullRequestContext {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError('Sync Pull request must be a plain object.');
  }
  assertExactKeys(
    candidate,
    new Set(['sessionId', 'principal', 'collectionId', 'protocolVersion', 'effectPageAuthority', 'effectPageTemplate', 'cursor', 'limit']),
    'Sync Pull request',
  );
  const principal = immutableData(candidate.principal, 'Sync Pull principal');
  assertExactKeys(principal, new Set(['type', 'id']), 'Sync Pull principal');
  if (!principalTypes.has(principal.type)) throw new TypeError('Sync Pull principal type is invalid.');
  nonEmptyString(principal.id, 'Sync Pull principal id');
  if (!Number.isSafeInteger(candidate.limit) || candidate.limit < 1
      || candidate.limit > SYNC_PULL_MAX_LIMIT) {
    throw new RangeError(`Sync Pull limit must be a positive safe integer no greater than ${SYNC_PULL_MAX_LIMIT}.`);
  }
  return Object.freeze({
    sessionId: nonEmptyString(candidate.sessionId, 'Sync Pull sessionId'),
    principal,
    collectionId: nonEmptyString(candidate.collectionId, 'Sync Pull collectionId'),
    protocolVersion: nonEmptyString(candidate.protocolVersion, 'Sync Pull protocolVersion'),
    ...(candidate.effectPageAuthority === undefined
      ? {}
      : { effectPageAuthority: normalizeEffectPageAuthority(candidate.effectPageAuthority) }),
    ...(candidate.effectPageTemplate === undefined
      ? {}
      : { effectPageTemplate: normalizeEffectPageTemplate(candidate.effectPageTemplate) }),
    cursor: candidate.cursor === null ? null : nonEmptyString(candidate.cursor, 'Sync Pull cursor'),
    limit: candidate.limit,
  });
}

function immutableSnapshotUrlOptions(
  candidate: SyncPullSnapshotUrlOptions | undefined,
): NormalizedSnapshotUrlOptions {
  if (candidate === undefined) {
    return Object.freeze({ allowInsecureSnapshotUrl: false });
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError('Sync Pull Snapshot URL options must be a plain object.');
  }
  assertExactKeys(
    candidate,
    new Set(['allowInsecureSnapshotUrl', 'assertSnapshotUrlSafe']),
    'Sync Pull Snapshot URL options',
  );
  if (
    candidate.allowInsecureSnapshotUrl !== undefined
    && typeof candidate.allowInsecureSnapshotUrl !== 'boolean'
  ) {
    throw new TypeError('Sync Pull allowInsecureSnapshotUrl must be a boolean when present.');
  }
  if (
    candidate.assertSnapshotUrlSafe !== undefined
    && typeof candidate.assertSnapshotUrlSafe !== 'function'
  ) {
    throw new TypeError('Sync Pull assertSnapshotUrlSafe must be a function when present.');
  }
  return Object.freeze({
    allowInsecureSnapshotUrl: candidate.allowInsecureSnapshotUrl === true,
    ...(candidate.assertSnapshotUrlSafe !== undefined
      ? { assertSnapshotUrlSafe: candidate.assertSnapshotUrlSafe }
      : {}),
  });
}

export type AuthoritativePullProtocolVersion = '0.1' | '0.2';

function normalizeEffectPageAuthority(raw: string): string {
  let authority: URL;
  try {
    authority = new URL(raw);
  } catch {
    throw new TypeError('Authoritative Pull effect page authority must be an absolute HTTPS origin.');
  }
  if (authority.protocol !== 'https:' || authority.username !== '' || authority.password !== ''
    || authority.pathname !== '/' || authority.search !== '' || authority.hash !== '') {
    throw new TypeError('Authoritative Pull effect page authority must be a credential-free HTTPS origin.');
  }
  rejectPrivateOrLocalSnapshotUrl(authority);
  return authority.origin;
}

function assertEffectPageAuthority(raw: string, expectedAuthority: string | undefined): void {
  assertAuthoritativeEffectPageUrlSafe(raw);
  if (expectedAuthority === undefined) {
    throw new TypeError('Paged Authoritative Pull effects require a trusted Manifest authority.');
  }
  if (new URL(raw).origin !== normalizeEffectPageAuthority(expectedAuthority)) {
    throw new TypeError('Authoritative Pull effect page URL crosses the trusted Manifest authority.');
  }
}

/** Canonical effect-page request. Session identity is header-only, not a URL variable. */
export interface EffectPageRequest {
  readonly effectId: string;
  readonly pageNumber: number;
}

function normalizeEffectPageTemplate(raw: string): string {
  expandAuthoritativeEffectPageUrl(raw, 'effect-id', 1);
  return raw;
}

function assertEffectPageTemplate(
  effectId: string,
  template: string | undefined,
  expectedAuthority: string | undefined,
): void {
  if (template === undefined || expectedAuthority === undefined) {
    throw new TypeError('Paged Authoritative Pull effects require a trusted Manifest effect page template.');
  }
  assertEffectPageAuthority(
    expandAuthoritativeEffectPageUrl(template, effectId, 1),
    expectedAuthority,
  );
}

/** Version-selecting N/N-1 validator for immutable Pull events. */
export function validateAuthoritativePullEvent(
  candidate: SyncPullEvent | SyncPullEventV02,
  protocolVersion: AuthoritativePullProtocolVersion,
  options: { readonly effectPageAuthority?: string; readonly effectPageTemplate?: string } = {},
): SyncPullEvent | SyncPullEventV02 {
  return validateImmutablePullEvent(snapshotPullEvent(candidate, protocolVersion), protocolVersion, options);
}

function snapshotPullEvent<Value extends SyncPullEvent | SyncPullEventV02>(
  candidate: Value,
  protocolVersion: string,
): Value {
  if (protocolVersion !== '0.2') return immutableData(candidate, 'Sync Pull event');
  // Operation and effect retain their own budgets in assertEffectBinding.
  // Their combined envelope must accommodate both plus its four own fields.
  const event = immutableJsonSnapshot(candidate, 'Sync Pull event', {
    maxMembers: DEFAULT_IMMUTABLE_JSON_MAX_MEMBERS + AUTHORITATIVE_EFFECT_MAX_MEMBERS + 4,
    maxDepth: DEFAULT_IMMUTABLE_JSON_MAX_DEPTH + 1,
  }) as Value;
  return event.kind === 'operation' ? event : immutableData(event, 'Sync Pull event');
}

/** Validation core for an event that is already an isolated frozen snapshot. */
function validateImmutablePullEvent(
  event: SyncPullEvent | SyncPullEventV02,
  protocolVersion: AuthoritativePullProtocolVersion,
  options: { readonly effectPageAuthority?: string; readonly effectPageTemplate?: string },
): SyncPullEvent | SyncPullEventV02 {
  if (protocolVersion !== '0.1' && protocolVersion !== '0.2') {
    throw new TypeError('Unsupported Pull protocol version.');
  }
  const definition = protocolVersion === '0.2' ? 'syncPullEventV02' : 'syncPullEvent';
  const structural = pullEventValidators.validate(definition, event);
  if (!structural.valid) {
    const kind = event.kind === 'conflict' ? 'Conflict' : event.kind === 'operation' ? 'Operation' : 'event';
    throw new TypeError(`Sync Pull ${kind} is invalid for COLP ${protocolVersion}.`);
  }
  if (protocolVersion === '0.1') return event;
  if (event.kind === 'operation') {
    const authoritativeEvent = event as Extract<SyncPullEventV02, { kind: 'operation' }>;
    assertEffectBinding(
      authoritativeEvent.operation,
      authoritativeEvent.effect,
      options.effectPageAuthority,
      options.effectPageTemplate,
      assertEffectPageTemplate,
    );
  }
  return event;
}

export interface AuthoritativeEffectPageExpectation {
  readonly effectId: string;
  readonly expectedPageNumber: number;
  readonly pageCount: number;
  readonly previousPageDigest: string | null;
}

/** Validates one immutable, Session-authenticated subtree effect page and its digest chain. */
export function validateAuthoritativePullEventPage(
  candidate: AuthoritativeEffectPage,
  expected: AuthoritativeEffectPageExpectation,
): AuthoritativeEffectPage {
  const page = immutableJsonSnapshot(candidate, 'Authoritative Pull effect page', {
    maxDepth: AUTHORITATIVE_EFFECT_MAX_DEPTH,
    maxMembers: AUTHORITATIVE_EFFECT_MAX_MEMBERS,
  }) as AuthoritativeEffectPage;
  const structural = createValidatorRegistry().validate('authoritativeEffectPage', page);
  if (!structural.valid) throw new TypeError('Authoritative Pull effect page is structurally invalid.');
  if (page.effectId !== expected.effectId || page.pageNumber !== expected.expectedPageNumber
    || page.pageCount !== expected.pageCount || page.previousPageDigest !== expected.previousPageDigest) {
    throw new TypeError('Authoritative Pull effect page previous digest chain or binding is invalid.');
  }
  if (page.pageNumber > page.pageCount
    || (page.pageNumber === 1) !== (page.previousPageDigest === null)) {
    throw new TypeError('Authoritative Pull effect page chain position is invalid.');
  }
  if (page.members.length !== page.memberCount) {
    throw new TypeError('Authoritative Pull effect page memberCount is invalid.');
  }
  if (page.pageDigest !== canonicalAuthoritativeEffectPageDigest(page)) {
    throw new TypeError('Authoritative Pull effect page digest is invalid.');
  }
  if (Buffer.byteLength(encodeCanonicalJson(page, 'Canonical JSON input'), 'utf8') > AUTHORITATIVE_EFFECT_PAGE_MAX_BYTES) {
    throw new RangeError('Authoritative Pull effect page exceeds its byte budget.');
  }
  return page;
}

/** Validates a complete page series, including the deleted root from its bound effect. */
export function validateAuthoritativePullEventPages(
  candidates: readonly AuthoritativeEffectPage[],
  reference: AuthoritativeEffectPageRef & { readonly effectId: string; readonly rootId: string },
): readonly AuthoritativeEffectPage[] {
  const rootId = nonEmptyString(reference.rootId, 'Authoritative Pull effect deleted root');
  if (!Number.isSafeInteger(reference.pageCount) || reference.pageCount < 1 || reference.pageCount > 1_024
    || !Number.isSafeInteger(reference.memberCount) || reference.memberCount < 1
    || reference.memberCount > AUTHORITATIVE_EFFECT_SERIES_MAX_MEMBERS) {
    throw new RangeError('Authoritative Pull effect page series exceeds its page or member budget.');
  }
  if (candidates.length !== reference.pageCount) {
    throw new TypeError('Authoritative Pull effect page series is incomplete.');
  }
  const pages: AuthoritativeEffectPage[] = [];
  const members: string[] = [];
  const seenMembers = new Set<string>();
  let previousPageDigest: string | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const page = validateAuthoritativePullEventPage(candidates[index]!, {
      effectId: reference.effectId,
      expectedPageNumber: index + 1,
      pageCount: reference.pageCount,
      previousPageDigest,
    });
    if (index === 0 && page.pageDigest !== reference.firstPageDigest) {
      throw new TypeError('Authoritative Pull effect first page digest is invalid.');
    }
    if (page.members.some((member) => seenMembers.has(member))) {
      throw new TypeError('Authoritative Pull effect page series contains duplicate members.');
    }
    page.members.forEach((member) => seenMembers.add(member));
    pages.push(page);
    members.push(...page.members);
    previousPageDigest = page.pageDigest;
  }
  if (members.length !== reference.memberCount
    || canonicalAuthoritativeMemberDigest(members) !== reference.memberDigest) {
    throw new TypeError('Authoritative Pull effect page series member digest or count is invalid.');
  }
  if (!seenMembers.has(rootId)) {
    throw new TypeError('Authoritative Pull effect exact members must include the deleted root.');
  }
  return Object.freeze(pages);
}

function validateEvent(
  candidate: SyncPullEvent | SyncPullEventV02,
  expectedCursor: string,
  protocolVersion: string,
  expectedCollectionId: string,
  effectPageAuthority?: string,
  effectPageTemplate?: string,
): SyncPullEvent | SyncPullEventV02 {
  const event = snapshotPullEvent(candidate, protocolVersion);
  if (event.cursor !== expectedCursor) throw new TypeError('Sync Pull event Cursor does not match its Cursor record.');
  if (protocolVersion !== '0.1' && protocolVersion !== '0.2') {
    throw new TypeError('Sync Pull protocolVersion must be 0.1 or 0.2.');
  }
  if (event.kind === 'operation') {
    const keys = protocolVersion === '0.2'
      ? new Set(['cursor', 'kind', 'operation', 'effect'])
      : new Set(['cursor', 'kind', 'operation']);
    assertExactKeys(event, keys, 'Operation Sync Pull event');
  } else if (event.kind === 'conflict') {
    assertExactKeys(event, new Set(['cursor', 'kind', 'conflict']), 'Conflict Sync Pull event');
    if (event.conflict === undefined || event.operation !== undefined) {
      throw new TypeError('Conflict Sync Pull event must contain only a Conflict payload.');
    }
  } else {
    throw new TypeError('Sync Pull event has an invalid kind.');
  }
  const validated = validateImmutablePullEvent(
    event,
    protocolVersion,
    {
      ...(effectPageAuthority === undefined ? {} : { effectPageAuthority }),
      ...(effectPageTemplate === undefined ? {} : { effectPageTemplate }),
    },
  );
  const collectionId = validated.kind === 'operation'
    ? validated.operation?.collectionId : validated.conflict?.collectionId;
  if (collectionId !== expectedCollectionId) {
    throw new TypeError('Sync Pull event payload does not match the requested Collection.');
  }
  return validated;
}

function validatePageMetadata(page: SyncPullEventPage, limit: number): void {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    throw new TypeError('Sync Pull event store page must be a plain object.');
  }
  assertExactKeys(
    page,
    new Set(['entries', 'hasMore', 'collectionRevision', 'recommendedPullAfterSeconds']),
    'Sync Pull event store page',
  );
  if (!Array.isArray(page.entries)) throw new TypeError('Sync Pull event store entries must be an array.');
  if (page.entries.length > limit) throw new RangeError('Sync Pull event store returned more entries than requested.');
  if (typeof page.hasMore !== 'boolean') throw new TypeError('Sync Pull hasMore must be boolean.');
  if (page.hasMore && page.entries.length === 0) {
    throw new TypeError('Sync Pull hasMore cannot be true for an empty authoritative page.');
  }
  nonEmptyString(page.collectionRevision, 'Sync Pull collectionRevision');
  if (
    !Number.isSafeInteger(page.recommendedPullAfterSeconds)
    || page.recommendedPullAfterSeconds < 0
  ) {
    throw new RangeError('Sync Pull recommendedPullAfterSeconds must be a non-negative safe integer.');
  }
}

/**
 * Authoritative Pull coordinator.
 *
 * **Composition:** does not call `verifySyncSessionContext`. The
 * request `principal` / `sessionId` / `collectionId` fields are self-asserted
 * scope for cursor binding only. Prefer `coordinateSessionBoundPull` (or verify
 * the Session first) on HTTP surfaces so principal/collection match a durable
 * Session record.
 *
 * **Cursor lifecycle (03-sync.md §8):** `cursor: null` asks the Cursor store to
 * issue a cursor bound to the current Session and its initial exclusive
 * position. A cursor recorded under another Session continues only after the
 * store's `authorizeCursorHandoff` verifies lineage. Empty pages echo the start
 * cursor exactly; nonempty pages end with the final event cursor, which must be
 * bound to the current Session.
 */
export async function coordinateSyncPull(
  candidate: SyncPullRequestContext,
  cursorStore: SyncPullCursorStore,
  eventStore: SyncPullEventStore,
  snapshotUrlOptions?: SyncPullSnapshotUrlOptions,
): Promise<SyncPullCoordinatorResult> {
  const request = immutableRequest(candidate);
  const urlPolicy = immutableSnapshotUrlOptions(snapshotUrlOptions);
  const start = await resolvePullStartCursor(request, cursorStore);
  if (start.kind === 'invalid_scope') return invalidCursorScope();
  if (start.kind === 'expired') {
    return cursorExpired(start.snapshotUrl === undefined
      ? undefined
      : validateSnapshotUrl(start.snapshotUrl, urlPolicy));
  }
  const startOrdinal = start.ordinal;

  const readRequest = Object.freeze({
    sessionId: request.sessionId,
    principal: request.principal,
    collectionId: request.collectionId,
    protocolVersion: request.protocolVersion,
    afterCommitOrdinal: startOrdinal.wire,
    limit: request.limit,
  });
  let pageRaw: SyncPullEventPage;
  try {
    pageRaw = await requirePromise(
      eventStore.readCommittedAfter(readRequest),
      'Sync Pull event store read',
    );
  } catch (error) {
    if (!(error instanceof SyncPullLogTruncatedError)) throw error;
    return cursorExpired(error.snapshotUrl === undefined
      ? undefined
      : validateSnapshotUrl(error.snapshotUrl, urlPolicy));
  }
  // Select and copy a bounded prefix from this same cut before resolving cursors.
  const page = snapshotPullEventStorePage(pageRaw, request.limit);
  validatePageMetadata(page, request.limit);

  const events: Array<SyncPullEvent | SyncPullEventV02> = [];
  let previousOrder = startOrdinal.order;
  // Empty pages echo the start cursor byte for byte, including after an
  // authorized handoff; only a nonempty page enters the current Session.
  let nextCursor = start.cursor;
  // First pass: page shape, order and cursors, before any Cursor store call.
  const ordered = page.entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError('Sync Pull event store returned an invalid entry.');
    }
    assertExactKeys(entry, new Set(['commitOrdinal', 'event']), 'Sync Pull committed event');
    const ordinal = canonicalOrdinal(entry.commitOrdinal, 'Sync Pull event commitOrdinal');
    if (ordinal.order <= previousOrder) {
      throw new TypeError('Sync Pull events must be unique and strictly increasing after the requested Cursor.');
    }
    previousOrder = ordinal.order;
    return { entry, ordinal, eventCursor: nonEmptyString(entry.event?.cursor, 'Sync Pull event cursor') };
  });
  // One bounded batch call (or the sequential compatibility fallback).
  const cursorRecords = await resolveEventCursorRecords(cursorStore, ordered.map(item => item.eventCursor));
  for (const { entry, ordinal, eventCursor } of ordered) {
    const cursorRecord = cursorRecords.get(eventCursor)!;
    if (
      cursorRecord.cursor !== eventCursor
      || !sameCursorScope(cursorRecord, request)
      || cursorRecord.state !== 'active'
      || canonicalOrdinal(cursorRecord.commitOrdinal, 'Sync Pull event Cursor commitOrdinal').order !== ordinal.order
    ) {
      throw new TypeError('Committed Sync Pull event does not match its durable Cursor record.');
    }
    events.push(validateEvent(
      entry.event,
      eventCursor,
      request.protocolVersion,
      request.collectionId,
      request.effectPageAuthority,
      request.effectPageTemplate,
    ));
    nextCursor = eventCursor;
  }

  // Every event is already a frozen copy taken under the per-event and
  // whole-page budgets, and the response drops the per-entry frames, so it is
  // assembled without walking and copying the page again.
  const body = Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, {
    events: Object.freeze(events),
    nextCursor,
    hasMore: page.hasMore,
    collectionRevision: page.collectionRevision,
    recommendedPullAfterSeconds: page.recommendedPullAfterSeconds,
  })) as unknown as SyncPull | SyncPullV02;
  if (request.protocolVersion === '0.2'
    && !createValidatorRegistry().validate('syncPullV02', body).valid) {
    throw new TypeError('Sync Pull response is invalid for COLP 0.2.');
  }
  return Object.freeze({ ok: true, status: 200, body });
}

const pullEventValidators = createValidatorRegistry();
