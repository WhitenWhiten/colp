/**
 * C-03: only a server-issued whole-page nextCursor is an Ack boundary.
 * currentPullMapping page-local facts are unpublished shadow.
 *
 * Opaque `spc2` cursors are ordered by their packed commit ordinal, never by
 * byte order: the base36 fields (`<expiresAt>` then `<commitOrdinal>`) sort
 * differently from their numeric value, so a lexicographic comparison reports
 * forward motion for a genuine rewind.
 */
export type PullAckCursorKind = 'server_page' | 'event';
export type PullAckClass =
  | 'allow'
  | 'refuse_event_cursor'
  | 'refuse_incomplete_page'
  | 'refuse_missing_evidence'
  | 'refuse_rewind'
  | 'refuse_unordered';
export type PullMappingAuthority = 'published' | 'applied_locally_unpublished';
export type PullCursorOrder = 'before' | 'equal' | 'after' | 'incomparable';
/** Durable cursor publication verdict for `completePullPage`. */
export type PullCursorWriteClass = 'allow' | 'refuse_rewind' | 'refuse_stale_chain';
export type SyncWaitReasonKind =
  | 'unknown'
  | 'parent'
  | 'anchor'
  | 'create_order'
  | 'range_boundary'
  | 'known_pending'
  | 'local_pending_edits'
  | 'native_result_unknown'
  | 'generation'
  | 'mount'
  | 'occupancy';

export interface PullAckFacts {
  readonly cursorKind: PullAckCursorKind;
  readonly pageComplete: boolean;
  readonly backendPageEvidence: boolean;
  readonly publishedCursor: string | null;
  readonly nextCursor: string | null;
}

export interface PullCursorWriteFacts {
  /** Durable cursor/checkpoint the page would overwrite. */
  readonly publishedCursor: string | null;
  /** Chain head the staged page was built on. */
  readonly previousCursor: string;
  /** Chain tail the page wants to publish. */
  readonly nextCursor: string;
}

export interface PullMappingAuthorityFacts {
  readonly fromCommittedPageEvents: boolean;
  readonly pageComplete: boolean;
  readonly cursorPublished: boolean;
}

const SPC2 = /^spc2\.([A-Za-z0-9_-]+)\.([0-9a-z]+)\.([0-9a-z]+)\.([oc])\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** The signed anchor packed into a Sync Pull cursor, or null when unparseable. */
function spc2Anchor(cursor: string) {
  const match = SPC2.exec(cursor); if (!match) return null;
  const ordinal = base36(match[3]!); if (ordinal === null) return null;
  return { ordinal, stream: match[4] as 'o' | 'c', stableIdHash: match[5]! };
}

function base36(text: string): bigint | null {
  if (!/^(?:0|[1-9a-z][0-9a-z]*)$/u.test(text)) return null;
  let value = 0n;
  for (const character of text) {
    const digit = BASE36.indexOf(character); if (digit < 0) return null;
    value = value * 36n + BigInt(digit);
  }
  return value.toString(36) === text ? value : null;
}

/**
 * Canonical order of two Sync Pull cursors. The commit ordinal is the primary
 * tuple key, then the operation/conflict stream kind, exactly like the server's
 * `compareTuple`. The truncated stable-id hash is not order preserving, so equal
 * ordinals with different hashes stay incomparable instead of being guessed.
 */
export function pullCursorOrder(left: string, right: string): PullCursorOrder {
  const first = spc2Anchor(left); const second = spc2Anchor(right);
  if (!first || !second) return 'incomparable';
  if (first.ordinal !== second.ordinal) return first.ordinal < second.ordinal ? 'before' : 'after';
  if (first.stream !== second.stream) return first.stream === 'o' ? 'before' : 'after';
  return first.stableIdHash === second.stableIdHash ? 'equal' : 'incomparable';
}

export function classifyPullAck(input: PullAckFacts): PullAckClass {
  if (input.cursorKind === 'event') return 'refuse_event_cursor';
  if (!input.pageComplete) return 'refuse_incomplete_page';
  if (!input.backendPageEvidence) return 'refuse_missing_evidence';
  if (input.publishedCursor !== null && input.nextCursor !== null
      && input.nextCursor !== input.publishedCursor) {
    const order = pullCursorOrder(input.publishedCursor, input.nextCursor);
    if (order === 'incomparable') return 'refuse_unordered';
    if (order === 'after') return 'refuse_rewind';
  }
  return 'allow';
}

/**
 * Guard the durable cursor write in `completePullPage`. A page whose chain head
 * still equals the durable cursor is the normal continuation. A detached chain
 * only publishes when the canonical order proves it moves forward; a rewind is
 * named, and an unprovable order fails closed as a stale chain.
 */
export function classifyDurablePullCursorWrite(input: PullCursorWriteFacts): PullCursorWriteClass {
  const { publishedCursor, previousCursor, nextCursor } = input;
  if (publishedCursor === null || previousCursor === publishedCursor) return 'allow';
  const ack = classifyPullAck({ cursorKind: 'server_page', pageComplete: true, backendPageEvidence: true,
    publishedCursor, nextCursor });
  if (ack === 'refuse_rewind') return 'refuse_rewind';
  if (ack === 'refuse_unordered') return 'refuse_stale_chain';
  const order = pullCursorOrder(publishedCursor, nextCursor);
  return order === 'before' || order === 'equal' ? 'allow' : 'refuse_stale_chain';
}

export function classifyPullMappingAuthority(input: PullMappingAuthorityFacts): PullMappingAuthority {
  return input.cursorPublished && input.pageComplete && !input.fromCommittedPageEvents
    ? 'published'
    : 'applied_locally_unpublished';
}

/** Durable evidence row for a refused cursor write or a replayed blocked page. */
export function pullPageDiagnosticRow(input: { readonly scopeKey: string; readonly kind: 'pull_page_blocked' | 'pull_page_retry';
  readonly code: string; readonly pageId: string; readonly previousCursor: unknown; readonly nextCursor: unknown;
  readonly publishedCursor?: unknown; readonly eventCount?: number; readonly at?: number }) {
  return { id: `${input.kind}:${input.scopeKey}:${input.pageId}`, scopeKey: input.scopeKey, kind: input.kind,
    code: input.code, pageId: input.pageId, previousCursor: input.previousCursor, nextCursor: input.nextCursor,
    ...(input.publishedCursor === undefined ? {} : { publishedCursor: input.publishedCursor }),
    ...(input.eventCount === undefined ? {} : { eventCount: input.eventCount }), at: input.at ?? Date.now() };
}
