/**
 * Pull cursor lifecycle: initial issuance, same-Session continuation, and
 * adapter-verified cross-Session authority handoff (03-sync.md §8).
 *
 * The coordinator never interprets cursor bytes. Lineage evidence (signatures,
 * durable issuance records, lease generations, policy revisions) lives behind
 * the trusted adapter boundary; this module only checks that the adapter's
 * answer is bound to the exact cursor, Sessions, and position it was asked about.
 * A matching principal, Collection, and protocol version is a precondition for
 * asking — never, on its own, an authorization.
 */

import type { PrincipalRef } from '../types/index.js';
import { immutableJsonData } from '../shared/immutable-json.js';
import { samePrincipal } from '../shared/protocol-vocabulary.js';
import { requirePromise } from './internal-guards.js';

/** Durable cursor state. Expired records are retained to distinguish expiry from invalid scope. */
export type SyncPullCursorState = 'active' | 'expired';

/**
 * Durable cursor metadata. Adapters must persist this record across processes and
 * retain expired records long enough to distinguish expiry from invalid scope.
 */
export interface SyncPullCursorRecord {
  readonly cursor: string;
  readonly sessionId: string;
  readonly principal: PrincipalRef;
  readonly collectionId: string;
  readonly protocolVersion: string;
  /** Canonical, non-negative base-10 integer without leading zeroes. */
  readonly commitOrdinal: string;
  readonly state: SyncPullCursorState;
  /**
   * Snapshot recovery hint published for `state: 'expired'` records. Optional
   * on the wire: when absent the 410 `sync_cursor_expired` Problem carries no
   * `snapshotUrl` (the client re-bootstraps instead of following a link).
   * When present it is transport-validated against the host URL policy.
   */
  readonly snapshotUrl?: string;
}

/** Binding of the current (already verified) Pull request. */
export interface SyncPullCursorBinding {
  readonly sessionId: string;
  readonly principal: PrincipalRef;
  readonly collectionId: string;
  readonly protocolVersion: string;
}

/** First Pull of a Session (`cursor: null`). */
export type SyncPullInitialCursorRequest = SyncPullCursorBinding;

/**
 * Question put to the adapter when a presented cursor was recorded under a
 * different Session with the same principal, Collection, and protocol version.
 */
export interface SyncPullCursorHandoffRequest {
  readonly cursor: string;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly principal: PrincipalRef;
  readonly collectionId: string;
  readonly protocolVersion: string;
  readonly commitOrdinal: string;
}

/**
 * Adapter proof that `toSessionId` durably succeeded `fromSessionId` for this
 * cursor. Every member must echo the request; the position is not rebased.
 */
export interface SyncPullCursorHandoffAuthorization {
  readonly cursor: string;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly commitOrdinal: string;
}

/**
 * Durable cursor adapter.
 *
 * - `resolveCursor` is required and must return the durable record (or null).
 * - `issueInitialCursor` serves `cursor: null` requests. It must persist and
 *   return an `active` record bound to the current Session whose
 *   `commitOrdinal` is the initial exclusive position (for example the purge
 *   boundary or the Bootstrap checkpoint). Later `resolveCursor` calls must
 *   return that same record. Omit it to refuse initial Pull.
 * - `authorizeCursorHandoff` verifies authority lineage for a cursor issued to
 *   an earlier Session. Return null unless durable evidence proves the lineage
 *   (same Replica, lease/policy continuity, unexpired issuance). Omit it to
 *   refuse every cross-Session cursor with `invalid_cursor_scope`.
 *
 * - `resolveCursors` resolves every event cursor of one page in a single
 *   call (at most the page `limit`, itself capped at `SYNC_PULL_MAX_LIMIT`).
 *   Return exactly one record per requested cursor, in any order. A missing,
 *   duplicate, unrequested, or mismatched record fails the page closed. When
 *   omitted, the coordinator falls back to one `resolveCursor` call per event
 *   (N+1 interface calls per page; the database round trips depend on the
 *   adapter). The fallback remains supported for compatibility.
 *
 * Session negotiation may alternatively rebase through an explicit
 * `serverCursor`, in which case the client presents a cursor already bound to
 * the new Session and no handoff is needed.
 */
export interface SyncPullCursorStore {
  resolveCursor(cursor: string): Promise<SyncPullCursorRecord | null>;
  resolveCursors?(cursors: readonly string[]): Promise<readonly SyncPullCursorRecord[]>;
  issueInitialCursor?(request: SyncPullInitialCursorRequest): Promise<SyncPullCursorRecord>;
  authorizeCursorHandoff?(
    request: SyncPullCursorHandoffRequest,
  ): Promise<SyncPullCursorHandoffAuthorization | null>;
}

export type SyncPullStartCursor =
  | {
    readonly kind: 'active';
    readonly cursor: string;
    readonly ordinal: CanonicalOrdinal;
  }
  | { readonly kind: 'invalid_scope' }
  | { readonly kind: 'expired'; readonly snapshotUrl: unknown };

export interface CanonicalOrdinal {
  readonly wire: string;
  readonly order: bigint;
}

const ordinalPattern = /^(?:0|[1-9][0-9]*)$/;
// This is an input-resource bound, not a Number/safe-integer ordering bound.
// 4,096 decimal digits leaves an effectively unbounded durable log lifetime.
const maxOrdinalDigits = 4_096;
const cursorRecordKeys = new Set([
  'cursor', 'sessionId', 'principal', 'collectionId', 'protocolVersion',
  'commitOrdinal', 'state', 'snapshotUrl',
]);
const handoffKeys = new Set(['cursor', 'fromSessionId', 'toSessionId', 'commitOrdinal']);

export function assertExactKeys(
  value: object,
  allowedKeys: ReadonlySet<string>,
  label: string,
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    || Object.keys(value).length !== keys.length
  ) {
    throw new TypeError(`${label} contains an unknown or non-data member.`);
  }
}

export function canonicalOrdinal(value: unknown, label: string): CanonicalOrdinal {
  if (
    typeof value !== 'string'
    || value.length > maxOrdinalDigits
    || !ordinalPattern.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical non-negative decimal string.`);
  }
  return Object.freeze({ wire: value, order: BigInt(value) });
}

/** Principal, Collection, and protocol match — the Session is compared separately. */
function sameNonSessionBinding(record: SyncPullCursorRecord, binding: SyncPullCursorBinding): boolean {
  return samePrincipal(record.principal, binding.principal)
    && record.collectionId === binding.collectionId
    && record.protocolVersion === binding.protocolVersion;
}

export function sameCursorScope(record: SyncPullCursorRecord, binding: SyncPullCursorBinding): boolean {
  return record.sessionId === binding.sessionId && sameNonSessionBinding(record, binding);
}

/** Snapshot an adapter cursor record and reject unknown or accessor members. */
export function parseCursorRecord(raw: unknown): SyncPullCursorRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('Sync Pull Cursor store returned an invalid record.');
  }
  const record = immutableJsonData(raw, 'Sync Pull Cursor record', new Set<object>()) as SyncPullCursorRecord;
  assertExactKeys(record, cursorRecordKeys, 'Sync Pull Cursor record');
  if (typeof record.principal !== 'object' || record.principal === null) {
    throw new TypeError('Sync Pull Cursor principal must be an object.');
  }
  assertExactKeys(record.principal, new Set(['type', 'id']), 'Sync Pull Cursor principal');
  return record;
}

function bindingOf(request: SyncPullCursorBinding): SyncPullCursorBinding {
  return Object.freeze({
    sessionId: request.sessionId,
    principal: request.principal,
    collectionId: request.collectionId,
    protocolVersion: request.protocolVersion,
  });
}

async function issueInitial(
  binding: SyncPullCursorBinding,
  cursorStore: SyncPullCursorStore,
): Promise<SyncPullStartCursor> {
  if (typeof cursorStore.issueInitialCursor !== 'function') {
    throw new TypeError('Initial Sync Pull requires a Cursor store with issueInitialCursor.');
  }
  const record = parseCursorRecord(await requirePromise(
    cursorStore.issueInitialCursor(binding),
    'Sync Pull Cursor store issueInitialCursor',
  ));
  if (typeof record.cursor !== 'string' || record.cursor.length === 0
      || !sameCursorScope(record, binding) || record.state !== 'active') {
    throw new TypeError('Issued initial Sync Pull Cursor must be active and bound to the current Session.');
  }
  return Object.freeze({
    kind: 'active',
    cursor: record.cursor,
    ordinal: canonicalOrdinal(record.commitOrdinal, 'Issued initial Sync Pull Cursor commitOrdinal'),
  });
}

async function authorizeHandoff(
  record: SyncPullCursorRecord,
  binding: SyncPullCursorBinding,
  cursorStore: SyncPullCursorStore,
): Promise<boolean> {
  if (typeof cursorStore.authorizeCursorHandoff !== 'function') return false;
  const handoffRequest: SyncPullCursorHandoffRequest = Object.freeze({
    cursor: record.cursor,
    fromSessionId: record.sessionId,
    toSessionId: binding.sessionId,
    principal: binding.principal,
    collectionId: binding.collectionId,
    protocolVersion: binding.protocolVersion,
    commitOrdinal: record.commitOrdinal,
  });
  const raw = await requirePromise(
    cursorStore.authorizeCursorHandoff(handoffRequest),
    'Sync Pull Cursor store authorizeCursorHandoff',
  );
  if (raw === null) return false;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Sync Pull Cursor handoff authorization must be an object or null.');
  }
  const authorization = immutableJsonData(raw, 'Sync Pull Cursor handoff authorization', new Set<object>());
  assertExactKeys(authorization, handoffKeys, 'Sync Pull Cursor handoff authorization');
  if (authorization.cursor !== handoffRequest.cursor
      || authorization.fromSessionId !== handoffRequest.fromSessionId
      || authorization.toSessionId !== handoffRequest.toSessionId
      || authorization.commitOrdinal !== handoffRequest.commitOrdinal) {
    throw new TypeError('Sync Pull Cursor handoff authorization does not match the requested lineage.');
  }
  return true;
}

/**
 * Resolve the exclusive start position for a Pull page.
 *
 * `cursor: null` issues an initial cursor. A presented cursor must resolve to
 * the same principal, Collection, and protocol version; a different Session is
 * accepted only after the adapter authorizes the handoff. Expiry is disclosed
 * only once scope (or handoff lineage) is established.
 */
export async function resolvePullStartCursor(
  request: SyncPullCursorBinding & { readonly cursor: string | null },
  cursorStore: SyncPullCursorStore,
): Promise<SyncPullStartCursor> {
  const binding = bindingOf(request);
  if (request.cursor === null) return issueInitial(binding, cursorStore);
  const raw = await requirePromise(
    cursorStore.resolveCursor(request.cursor),
    'Sync Pull Cursor store resolve',
  );
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze({ kind: 'invalid_scope' });
  }
  const record = parseCursorRecord(raw);
  if (record.cursor !== request.cursor || !sameNonSessionBinding(record, binding)) {
    return Object.freeze({ kind: 'invalid_scope' });
  }
  const ordinal = canonicalOrdinal(record.commitOrdinal, 'Sync Pull Cursor commitOrdinal');
  if (record.sessionId !== binding.sessionId && !await authorizeHandoff(record, binding, cursorStore)) {
    return Object.freeze({ kind: 'invalid_scope' });
  }
  if (record.state === 'expired') {
    return Object.freeze({ kind: 'expired', snapshotUrl: record.snapshotUrl });
  }
  if (record.state !== 'active') throw new TypeError('Sync Pull Cursor record has an invalid state.');
  return Object.freeze({ kind: 'active', cursor: request.cursor, ordinal });
}

/**
 * Resolve the durable records for one page's event cursors, keyed by cursor.
 *
 * Uses one bounded `resolveCursors` call when available, otherwise sequential
 * `resolveCursor` calls. Every requested cursor must map to exactly one record
 * whose `cursor` echoes it; scope, state and position are checked by the caller.
 */
export async function resolveEventCursorRecords(
  cursorStore: SyncPullCursorStore,
  cursors: readonly string[],
): Promise<ReadonlyMap<string, SyncPullCursorRecord>> {
  const requested = new Set(cursors);
  if (requested.size !== cursors.length) {
    throw new TypeError('Sync Pull page repeats an event Cursor.');
  }
  const records = new Map<string, SyncPullCursorRecord>();
  if (cursors.length === 0) return records;
  if (typeof cursorStore.resolveCursors !== 'function') {
    for (const cursor of cursors) {
      const raw = await requirePromise(cursorStore.resolveCursor(cursor), 'Sync Pull Cursor store resolve');
      if (raw === null) throw new TypeError('Committed Sync Pull event has no durable Cursor record.');
      const record = parseCursorRecord(raw);
      if (record.cursor !== cursor) {
        throw new TypeError('Committed Sync Pull event does not match its durable Cursor record.');
      }
      records.set(cursor, record);
    }
    return records;
  }
  const raw = await requirePromise(
    cursorStore.resolveCursors(Object.freeze([...cursors])),
    'Sync Pull Cursor store batch resolve',
  );
  if (!Array.isArray(raw)) throw new TypeError('Sync Pull Cursor store batch resolve must return an array.');
  if (raw.length > cursors.length) {
    throw new TypeError('Sync Pull Cursor store batch resolve returned more records than requested.');
  }
  for (const candidate of raw as readonly unknown[]) {
    const record = parseCursorRecord(candidate);
    if (!requested.has(record.cursor)) {
      throw new TypeError('Sync Pull Cursor store batch resolve returned an unrequested Cursor.');
    }
    if (records.has(record.cursor)) {
      throw new TypeError('Sync Pull Cursor store batch resolve returned a duplicate Cursor.');
    }
    records.set(record.cursor, record);
  }
  if (records.size !== cursors.length) {
    throw new TypeError('Committed Sync Pull event has no durable Cursor record.');
  }
  return records;
}
