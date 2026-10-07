/**
 * CS-02 community hot ranking: the listCommunityRanking application query.
 *
 * Pages come from durable `hot-v1` snapshots (written by the refresh worker);
 * the query never recomputes scores inline. Every page re-proves each
 * candidate's CURRENT visibility through the same resolve port as
 * resolveCommunityTarget, so a target that went private or changed shape
 * mid-pagination is concealed on the page it would have appeared on.
 *
 * Cursors are opaque `keyId.body.signature` tokens signed with a
 * purpose-derived HMAC key (`COMMUNITY_CURSOR_HMAC_KEY` →
 * `community.ranking`). They bind the endpoint, viewer, normalized filters,
 * limit, score version and snapshot id. A validly signed cursor whose
 * snapshot has been pruned maps to `snapshot_expired`; every other failure
 * maps to `invalid_cursor`.
 */
import {
  createKeyedCursorCodec,
  type KeyedCursorCodec,
} from '../../commands/index.js';
import {
  COMMUNITY_TARGET_KINDS,
  type CommunityTarget,
  type CommunityTargetKind,
  type CommunityTargetQuery,
} from './community-target.js';
import {
  COMMUNITY_HOT_SCORE_VERSION,
} from '../community-hot-score.js';
import type {
  CommunityTargetViewer,
  ResolvedCommunityTarget,
} from './community-target-query.js';

export const COMMUNITY_RANKING_ENDPOINT = 'community.ranking' as const;
export const COMMUNITY_RANKING_CURSOR_KEY_ID = 'crk-v1' as const;
export const COMMUNITY_RANKING_CURSOR_PURPOSE = 'community.ranking' as const;
export const COMMUNITY_RANKING_CURSOR_TTL_MS = 900_000;
export const COMMUNITY_RANKING_DEFAULT_LIMIT = 24;
export const COMMUNITY_RANKING_MAX_LIMIT = 100;
export const COMMUNITY_RANKING_PAGE_BYTE_BUDGET = 65_536;
/**
 * Serialized-page cursor accounting is EXACT, not reserved: for every
 * eligible candidate the scan loop measures the real `nextCursor` token
 * via `cursorCodec.encodedLength` on the very payload `sign` would emit
 * (same viewer, filters, snapshot, limit, and `pos` bound to that
 * entry's position). The `null` placeholder serialized by `pageBytes`
 * (4 bytes) is replaced by `"<token>"` (token + 2 quote bytes), so a
 * candidate fits iff `pageBytes + tokenBytes - 2 <= BUDGET`.
 */
const SCAN_BATCH = 64;
/**
 * Per-request scan budget: every scanned entry costs a live resolve, so a
 * page must not walk an arbitrarily deep run of concealed rows in one call.
 * At the cap the page stops early and the cursor resumes at `scanPosition`
 * — the skipped stretch was already proven dead, so nothing eligible is
 * lost and the next page never re-scans it.
 */
const MAX_SCAN_ENTRIES = SCAN_BATCH * 8;
const CURSOR_TEXT = /^[A-Za-z0-9._~-]{1,2048}$/u;
const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const BASE10 = /^[0-9]+$/u;

export type CommunityRankingErrorCode =
  | 'invalid_query'
  | 'invalid_cursor'
  | 'snapshot_expired';

export class CommunityRankingError extends Error {
  constructor(readonly code: CommunityRankingErrorCode, message: string) {
    super(message);
    this.name = 'CommunityRankingError';
  }
}

/** Normalized filters; `null` means "not supplied" (never undefined). */
export interface CommunityRankingFilters {
  readonly kind: CommunityTargetKind | null;
  readonly collectionId: string | null;
  readonly q: string | null;
  readonly tag: string | null;
  readonly language: string | null;
}

export interface CommunityRankingQuery extends CommunityRankingFilters {
  readonly limit: number;
  readonly cursor: string | null;
}

export interface CommunityRankingSnapshot {
  readonly snapshotId: string;
  readonly scoreVersion: string;
  readonly createdAt: Date;
  readonly itemCount: number;
}

/** One durable projection row; `position` is the snapshot sort order. */
export interface CommunityRankedEntry {
  readonly position: number;
  readonly target: CommunityTarget;
  readonly title: string;
  readonly href: string;
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly up: number;
  readonly down: number;
  readonly firstVoteAt: Date | null;
  readonly hot: number;
}

export interface CommunityRankingItemView {
  readonly target: CommunityTarget;
  readonly title: string;
  readonly href: string;
  readonly up: number;
  readonly down: number;
  readonly hot: number;
  readonly firstVoteAt: string | null;
}

export interface CommunityRankingPageView {
  readonly items: readonly CommunityRankingItemView[];
  readonly nextCursor: string | null;
  readonly asOf: string;
  readonly scoreVersion: typeof COMMUNITY_HOT_SCORE_VERSION;
}

export interface CommunityRankingQueryPorts {
  readonly rankings: {
    latestSnapshot(): Promise<CommunityRankingSnapshot | null>;
    findSnapshot(snapshotId: string): Promise<CommunityRankingSnapshot | null>;
    /** Entries with position > afterPosition, ordered by position. */
    scanEntries(
      snapshotId: string,
      afterPosition: number,
      limit: number,
    ): Promise<readonly CommunityRankedEntry[]>;
  };
  readonly targets: {
    resolve(query: CommunityTargetQuery): Promise<ResolvedCommunityTarget | null>;
    /**
     * Resolve a batch of targets positionally (`null` where the target is not
     * resolvable). One statement per target kind instead of one per target;
     * `resolve` remains the fallback for a host that does not provide it.
     */
    resolveMany?(queries: readonly CommunityTargetQuery[]):
      Promise<readonly (ResolvedCommunityTarget | null)[]>;
  };
  readonly clock: { now(): Promise<Date> };
}

export type CommunityRankingCursorCodec = KeyedCursorCodec<CommunityRankingCursorPayload>;

interface CommunityRankingCursorPayload {
  readonly v: 1;
  readonly ep: typeof COMMUNITY_RANKING_ENDPOINT;
  readonly vw: string;
  readonly sn: string;
  readonly pos: number;
  readonly lm: number;
  readonly sv: typeof COMMUNITY_HOT_SCORE_VERSION;
  readonly f: {
    readonly k: CommunityTargetKind | null;
    readonly c: string | null;
    readonly q: string | null;
    readonly t: string | null;
    readonly l: string | null;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function invalidQuery(message: string): CommunityRankingError {
  return new CommunityRankingError('invalid_query', message);
}
function invalidCursor(): CommunityRankingError {
  return new CommunityRankingError('invalid_cursor', 'The community ranking cursor is invalid.');
}

/** Purpose-derived HMAC cursor codec; single active `crk-v1` key. */
export function createCommunityRankingCursorCodec(
  cursorHmacKey: Buffer,
): CommunityRankingCursorCodec {
  if (!(cursorHmacKey instanceof Buffer) || cursorHmacKey.length < 16) {
    throw new TypeError('community ranking cursor requires a configured HMAC key');
  }
  return createKeyedCursorCodec<CommunityRankingCursorPayload>({
    mode: 'hmac-sha256',
    hmac: { variant: 'derived', purpose: COMMUNITY_RANKING_CURSOR_PURPOSE },
    ttlMs: COMMUNITY_RANKING_CURSOR_TTL_MS,
    keys: { current: { id: COMMUNITY_RANKING_CURSOR_KEY_ID, key: cursorHmacKey.toString('base64') } },
    invalid: invalidCursor,
    validate: validateCursorPayload,
    messages: {
      invalidCurrent: 'community ranking cursor key is invalid',
      uniqueIds: 'community ranking cursor key ids must be unique',
      invalidRetainUntil: 'community ranking cursor retainUntil is invalid',
    },
  });
}

const PAYLOAD_KEYS = ['ep', 'expiresAt', 'f', 'issuedAt', 'lm', 'pos', 'sn', 'sv', 'v', 'vw'] as const;
const FILTER_KEYS = ['c', 'k', 'l', 'q', 't'] as const;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

function validateCursorPayload(value: unknown): CommunityRankingCursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== PAYLOAD_KEYS.length
      || !PAYLOAD_KEYS.every((key, index) => keys[index] === key)) throw new Error();
  if (record.v !== 1 || record.ep !== COMMUNITY_RANKING_ENDPOINT
      || record.sv !== COMMUNITY_HOT_SCORE_VERSION) throw new Error();
  if (typeof record.vw !== 'string' || record.vw.length < 1 || record.vw.length > 128) throw new Error();
  if (typeof record.sn !== 'string' || !DECIMAL.test(record.sn)) throw new Error();
  if (!Number.isSafeInteger(record.pos) || (record.pos as number) < 0) throw new Error();
  if (!Number.isInteger(record.lm) || (record.lm as number) < 1
      || (record.lm as number) > COMMUNITY_RANKING_MAX_LIMIT) throw new Error();
  for (const name of ['issuedAt', 'expiresAt'] as const) {
    const stamp = record[name];
    if (typeof stamp !== 'string' || !RFC3339_MILLIS.test(stamp)
        || !Number.isFinite(Date.parse(stamp))) throw new Error();
  }
  const filters = record.f;
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) throw new Error();
  const fkeys = Object.keys(filters).sort();
  if (fkeys.length !== FILTER_KEYS.length
      || !FILTER_KEYS.every((key, index) => fkeys[index] === key)) throw new Error();
  const f = filters as Record<string, unknown>;
  if (f.k !== null && !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(f.k as string)) {
    throw new Error();
  }
  for (const name of ['c', 'q', 't', 'l'] as const) {
    if (f[name] !== null && typeof f[name] !== 'string') throw new Error();
  }
  return value as CommunityRankingCursorPayload;
}

function normalizeText(value: unknown, name: string, maxLength: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw invalidQuery(`The community ranking ${name} is invalid.`);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw invalidQuery(`The community ranking ${name} is invalid.`);
  }
  return normalized;
}

function normalizeLanguage(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw invalidQuery('The community ranking language is invalid.');
  const trimmed = value.trim().normalize('NFC');
  if (trimmed.length < 1 || trimmed.length > 35) {
    throw invalidQuery('The community ranking language is invalid.');
  }
  try {
    const canonical = Intl.getCanonicalLocales(trimmed)[0];
    if (typeof canonical !== 'string' || canonical.length < 1 || canonical.length > 35) {
      throw new Error();
    }
    return canonical;
  } catch {
    throw invalidQuery('The community ranking language is invalid.');
  }
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return COMMUNITY_RANKING_DEFAULT_LIMIT;
  let parsed: number;
  if (typeof value === 'string') {
    if (!BASE10.test(value)) throw invalidQuery('The community ranking limit is invalid.');
    parsed = Number.parseInt(value, 10);
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    parsed = value;
  } else {
    throw invalidQuery('The community ranking limit is invalid.');
  }
  if (parsed < 1 || parsed > COMMUNITY_RANKING_MAX_LIMIT) {
    throw invalidQuery('The community ranking limit is invalid.');
  }
  return parsed;
}

const QUERY_KEYS = ['collectionId', 'cursor', 'kind', 'language', 'limit', 'q', 'tag'] as const;

/**
 * Parse the closed ranking query object. Unknown keys, duplicate semantics
 * (HTTP layer) and null-for-missing are all rejected before this returns;
 * every stored value is normalized (trim + NFC, canonical BCP47).
 */
export function parseCommunityRankingQuery(
  raw: Readonly<Record<string, unknown>>,
): CommunityRankingQuery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidQuery('The community ranking query is invalid.');
  }
  for (const key of Object.keys(raw)) {
    if (!(QUERY_KEYS as readonly string[]).includes(key)) {
      throw invalidQuery('The community ranking query is invalid.');
    }
  }
  let kind: CommunityTargetKind | null = null;
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== 'string'
        || !(COMMUNITY_TARGET_KINDS as readonly string[]).includes(raw.kind)) {
      throw invalidQuery('The community ranking kind is invalid.');
    }
    kind = raw.kind as CommunityTargetKind;
  }
  let collectionId: string | null = null;
  if (raw.collectionId !== undefined) {
    if (typeof raw.collectionId !== 'string' || !OPAQUE_ID.test(raw.collectionId)) {
      throw invalidQuery('The community ranking collectionId is invalid.');
    }
    collectionId = raw.collectionId;
  }
  if (collectionId !== null && kind !== 'bookmark') {
    throw invalidQuery('The community ranking collectionId requires kind=bookmark.');
  }
  const q = normalizeText(raw.q, 'q', 256);
  const tag = normalizeText(raw.tag, 'tag', 64);
  const language = normalizeLanguage(raw.language);
  const limit = normalizeLimit(raw.limit);
  let cursor: string | null = null;
  if (raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string' || !CURSOR_TEXT.test(raw.cursor)) {
      throw invalidCursor();
    }
    cursor = raw.cursor;
  }
  return Object.freeze<CommunityRankingQuery>({
    kind, collectionId, q, tag, language, limit, cursor,
  });
}

function canonicalLanguageOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}

function filtersMatch(entry: CommunityRankedEntry, filters: CommunityRankingFilters): boolean {
  if (filters.kind !== null && entry.target.kind !== filters.kind) return false;
  if (filters.collectionId !== null && entry.target.collectionId !== filters.collectionId) return false;
  if (filters.q !== null
      && !entry.title.normalize('NFC').toLowerCase().includes(filters.q.toLowerCase())) return false;
  if (filters.tag !== null
      && !entry.tags.some((tag) => tag.normalize('NFC') === filters.tag)) return false;
  if (filters.language !== null
      && canonicalLanguageOrNull(entry.language) !== filters.language) return false;
  return true;
}

function targetQueryFor(entry: CommunityRankedEntry): CommunityTargetQuery {
  const target = entry.target;
  switch (target.kind) {
    case 'bookmark':
      return { kind: 'bookmark', id: target.id, collectionId: target.collectionId };
    case 'digest_edition':
      return { kind: 'digest_edition', id: target.id, seriesId: target.seriesId };
    default:
      return { kind: target.kind, id: target.id };
  }
}

function viewerKey(viewer: CommunityTargetViewer): string {
  return viewer.accountId ?? 'anonymous';
}

function cursorFilters(query: CommunityRankingQuery): CommunityRankingCursorPayload['f'] {
  return {
    k: query.kind,
    c: query.collectionId,
    q: query.q,
    t: query.tag,
    l: query.language,
  };
}

function boundCursorPayload(
  payload: CommunityRankingCursorPayload,
  query: CommunityRankingQuery,
  viewer: CommunityTargetViewer,
): boolean {
  const f = cursorFilters(query);
  return payload.vw === viewerKey(viewer)
    && payload.lm === query.limit
    && payload.f.k === f.k && payload.f.c === f.c && payload.f.q === f.q
    && payload.f.t === f.t && payload.f.l === f.l;
}

function toRfc3339Millis(value: Date): string {
  return value.toISOString();
}

function itemView(
  entry: CommunityRankedEntry,
  resolved: ResolvedCommunityTarget,
): CommunityRankingItemView {
  return Object.freeze<CommunityRankingItemView>({
    target: resolved.target,
    title: resolved.title,
    href: resolved.href,
    up: entry.up,
    down: entry.down,
    hot: entry.hot,
    firstVoteAt: entry.firstVoteAt === null ? null : toRfc3339Millis(entry.firstVoteAt),
  });
}

function pageBytes(asOf: string, items: readonly CommunityRankingItemView[]): number {
  // Envelope with a null cursor; the exact encoded cursor allowance for
  // the candidate's own `pos` is added per item by the scan loop.
  return Buffer.byteLength(JSON.stringify({
    items, nextCursor: null, asOf, scoreVersion: COMMUNITY_HOT_SCORE_VERSION,
  }), 'utf8');
}

/**
 * Exact UTF-8 size of the page if `cursorTokenBytes` replaces the `null`
 * placeholder: `null` is 4 bytes, `"<token>"` is token + 2 bytes.
 */
function pageBytesWithCursor(
  asOf: string,
  items: readonly CommunityRankingItemView[],
  cursorTokenBytes: number,
): number {
  return pageBytes(asOf, items) + cursorTokenBytes - 2;
}

/**
 * Serve one ranking page from a durable snapshot. Filtering precedes page
 * selection; candidates that fail current visibility are concealed (never
 * counted toward the page); the page fills until the item limit or the
 * 65,536-byte page budget is reached.
 */
export async function listCommunityRanking(
  ports: CommunityRankingQueryPorts,
  input: {
    readonly viewer: CommunityTargetViewer;
    readonly query: CommunityRankingQuery;
    readonly cursorCodec: CommunityRankingCursorCodec;
  },
): Promise<CommunityRankingPageView> {
  const { query } = input;
  const now = await ports.clock.now();
  let snapshot: CommunityRankingSnapshot | null;
  let afterPosition = 0;
  if (query.cursor !== null) {
    let payload: CommunityRankingCursorPayload;
    try {
      payload = input.cursorCodec.verify(query.cursor, now);
    } catch {
      throw invalidCursor();
    }
    if (!boundCursorPayload(payload, query, input.viewer)) throw invalidCursor();
    snapshot = await ports.rankings.findSnapshot(payload.sn);
    if (snapshot === null) {
      throw new CommunityRankingError(
        'snapshot_expired',
        'The community ranking snapshot expired; restart from the first page.',
      );
    }
    afterPosition = payload.pos;
  } else {
    snapshot = await ports.rankings.latestSnapshot();
  }
  if (snapshot === null) {
    return Object.freeze<CommunityRankingPageView>({
      items: Object.freeze([]),
      nextCursor: null,
      asOf: toRfc3339Millis(now),
      scoreVersion: COMMUNITY_HOT_SCORE_VERSION,
    });
  }
  if (snapshot.scoreVersion !== COMMUNITY_HOT_SCORE_VERSION) {
    // A snapshot written by another algorithm version is never served as
    // hot-v1; the refresh worker replaces it on the next pass.
    return Object.freeze<CommunityRankingPageView>({
      items: Object.freeze([]),
      nextCursor: null,
      asOf: toRfc3339Millis(snapshot.createdAt),
      scoreVersion: COMMUNITY_HOT_SCORE_VERSION,
    });
  }
  const asOf = toRfc3339Millis(snapshot.createdAt);
  // One payload builder feeds both the exact byte measurement and `sign`,
  // so the budget check can never drift from the emitted token.
  const cursorPayload = (position: number): CommunityRankingCursorPayload => ({
    v: 1,
    ep: COMMUNITY_RANKING_ENDPOINT,
    vw: viewerKey(input.viewer),
    sn: snapshot.snapshotId,
    pos: position,
    lm: query.limit,
    sv: COMMUNITY_HOT_SCORE_VERSION,
    f: cursorFilters(query),
    issuedAt: toRfc3339Millis(now),
    expiresAt: toRfc3339Millis(new Date(now.getTime() + COMMUNITY_RANKING_CURSOR_TTL_MS)),
  });
  const items: CommunityRankingItemView[] = [];
  let lastEmittedPosition = afterPosition;
  let scanPosition = afterPosition;
  let scanned = 0;
  let exhausted = false;
  let stoppedByBudget = false;
  scan: while (items.length < query.limit && scanned < MAX_SCAN_ENTRIES) {
    const batch = await ports.rankings.scanEntries(snapshot.snapshotId, scanPosition, SCAN_BATCH);
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    scanned += batch.length;
    let batchConsumed = true;
    // Current visibility is re-proven on every page: concealed/private/changed
    // targets are skipped, never emitted and never counted. The whole scan batch
    // is re-proven at once where the host supports it — one statement per target
    // kind instead of one per candidate, which is what made a page cost up to
    // MAX_SCAN_ENTRIES sequential round trips.
    const eligible = batch.filter((entry) => filtersMatch(entry, query));
    const preResolved = ports.targets.resolveMany === undefined
      ? null
      : await ports.targets.resolveMany(eligible.map(targetQueryFor));
    for (const entry of batch) {
      scanPosition = entry.position;
      if (!filtersMatch(entry, query)) continue;
      const resolved = preResolved === null
        ? await ports.targets.resolve(targetQueryFor(entry))
        : preResolved[eligible.indexOf(entry)] ?? null;
      if (resolved === null) continue;
      const candidate = [...items, itemView(entry, resolved)];
      // The page must fit WITH the cursor it would carry if this entry
      // were the last emitted one — measure the token for this entry's
      // own position, exactly as `sign` would emit it. The FIRST eligible
      // item is admitted unconditionally: an empty page stopped on budget
      // would resume at this entry's position and livelock, so the budget
      // bounds only candidates after the first.
      if (items.length > 0 && pageBytesWithCursor(asOf, candidate,
        input.cursorCodec.encodedLength(cursorPayload(entry.position)))
        > COMMUNITY_RANKING_PAGE_BYTE_BUDGET) {
        // The first unconsumed eligible item stays claimable: nextCursor
        // resumes at lastEmittedPosition so this item leads the next page.
        stoppedByBudget = true;
        break scan;
      }
      items.push(candidate[candidate.length - 1]!);
      lastEmittedPosition = entry.position;
      if (items.length >= query.limit) {
        batchConsumed = false;
        break;
      }
    }
    if (batchConsumed && batch.length < SCAN_BATCH) {
      exhausted = true;
      break;
    }
  }
  // Positions are contiguous 1..itemCount; an unconsumed candidate remains
  // whenever the scan stopped before the snapshot tail (item limit hit
  // mid-batch, the byte budget left an eligible entry unclaimed, or the
  // scan budget cut a concealed stretch short).
  const more = stoppedByBudget || (!exhausted && scanPosition < snapshot.itemCount);
  // A byte-budget stop must resume BEFORE the unclaimed eligible entry, so
  // it leads the next page. Any other stop left only proven-dead entries
  // between lastEmitted and scanPosition — resuming at scanPosition keeps
  // the stream in position order without re-scanning them.
  const resumePosition = stoppedByBudget ? lastEmittedPosition : scanPosition;
  const nextCursor = !more
    ? null
    : input.cursorCodec.sign(cursorPayload(resumePosition));
  return Object.freeze<CommunityRankingPageView>({
    items: Object.freeze(items),
    nextCursor,
    asOf,
    scoreVersion: COMMUNITY_HOT_SCORE_VERSION,
  });
}
