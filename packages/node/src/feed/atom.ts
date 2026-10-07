import { serializeBoundedAtom } from './atom-serializer.js';

import { isProxy } from 'node:util/types';

import { createValidatorRegistry, type ValidatorRegistry } from '../schema/index.js';
import { isHttpUrl } from '../schema/uri.js';
import { isRfc3339DateTime } from '../shared/date-time.js';
import { hasWellFormedUtf16 } from '../shared/utf16.js';
import {
  immutableJsonSnapshot,
  type DeepReadonly,
} from '../shared/immutable-json.js';
import { projectFeedBookmarkUrl } from './bookmark-url.js';
import { discriminateFeedEvent } from './event-contracts.js';

const ATOM_OPTION_KEYS = new Set(['emptyFeedUpdated']);
const COMPARABLE_RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/u;
const UNKNOWN_LOCAL_OFFSET = /-00:00$/u;
const DAYS_BEFORE_MONTH = Object.freeze([
  0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334,
]);

let defaultValidators: ValidatorRegistry | undefined;

function validators(): ValidatorRegistry {
  defaultValidators ??= createValidatorRegistry();
  return defaultValidators;
}

export interface AtomLink {
  readonly rel: 'alternate' | 'related' | 'self' | 'hub';
  readonly href: string;
  readonly type?: string;
}

export interface AtomEntry {
  readonly id: string;
  readonly title: string;
  readonly updated: string;
  readonly links: readonly AtomLink[];
  readonly summary?: string;
  readonly content?: string;
}

export interface AtomFeedDocument {
  readonly id: string;
  readonly title: string;
  readonly updated: string;
  readonly links: readonly AtomLink[];
  readonly entries: readonly AtomEntry[];
}

/** Options whose own data properties are snapshotted before Atom mapping. */
export interface AtomMapOptions {
  /** Trusted Feed update time required only when the source Feed has no events. */
  readonly emptyFeedUpdated?: string;
}

export type AtomMapErrorCode =
  | 'malformed_feed'
  | 'unsafe_url'
  | 'invalid_datetime'
  | 'invalid_xml'
  | 'missing_updated'
  | 'invalid_options';

export type AtomMapResult =
  | { readonly ok: true; readonly document: AtomFeedDocument; readonly xml: string }
  | { readonly ok: false; readonly code: AtomMapErrorCode };

interface ComparableRfc3339Instant {
  /** Whole nominal second; leap seconds share the preceding second's value. */
  readonly wholeSecond: bigint;
  readonly leapSecond: boolean;
  /** Original fractional digits; omitted digits compare as trailing zeroes. */
  readonly fraction: string;
}

type AtomEntryMapping =
  | {
      readonly ok: true;
      readonly entry: AtomEntry;
      readonly instant: ComparableRfc3339Instant;
    }
  | {
      readonly ok: false;
      readonly code: 'malformed_feed' | 'invalid_datetime' | 'invalid_xml';
    };

/**
 * Maps a COLP Feed document to Atom 1.0 (FEED-0006).
 *
 * Date-time policy:
 * - RFC 3339 `-00:00` is rejected because an unknown local offset cannot be
 *   placed on an absolute timeline.
 * - Valid leap seconds accepted by the protocol validator remain distinct from
 *   both `:59` and the following minute.
 * - Any non-empty fractional-second precision accepted by the protocol is
 *   compared without truncation; missing trailing digits are zeroes.
 * - Equivalent instants retain the first Event's original `time` spelling.
 *
 * Empty Feeds require {@link AtomMapOptions.emptyFeedUpdated}; a supplied
 * fallback is validated even for non-empty Feeds but never overrides the
 * latest Event time. Every emitted element text and attribute value must be a
 * well-formed UTF-16 XML 1.0 Fifth Edition `Char` before escaping.
 *
 * Entry IDs are stable Event IDs. Bookmark external URLs use `rel=related`;
 * event/collection pages use `rel=alternate`.
 */
export function mapFeedToAtom(
  feed: unknown,
  options: AtomMapOptions = {},
): AtomMapResult {
  let feedSnapshot: DeepReadonly<unknown>;
  try {
    feedSnapshot = immutableJsonSnapshot(feed, 'Atom source Feed', { maxBytes: 1024 * 1024 });
  } catch {
    return fail('malformed_feed');
  }

  const optionsSnapshot = snapshotAtomOptions(options);
  if (optionsSnapshot === null) {
    return fail('invalid_options');
  }
  if (
    optionsSnapshot.emptyFeedUpdated !== undefined
    && parseComparableRfc3339Instant(optionsSnapshot.emptyFeedUpdated) === null
  ) {
    return fail('invalid_datetime');
  }

  if (!isPlainObject(feedSnapshot)) {
    return fail('malformed_feed');
  }
  const feedUrl = feedSnapshot.feedUrl;
  const collectionUrl = feedSnapshot.collectionUrl;
  const title = feedSnapshot.title;
  const events = feedSnapshot.events;
  if (
    typeof feedUrl !== 'string'
    || typeof collectionUrl !== 'string'
    || typeof title !== 'string'
    || !Array.isArray(events)
  ) {
    return fail('malformed_feed');
  }
  if (
    !isXml10String(feedUrl)
    || !isXml10String(collectionUrl)
    || !isXml10String(title)
  ) {
    return fail('invalid_xml');
  }
  if (!isHttpUrl(feedUrl) || !isHttpUrl(collectionUrl)) {
    return fail('unsafe_url');
  }

  const entries: AtomEntry[] = [];
  let latest: {
    readonly updated: string;
    readonly instant: ComparableRfc3339Instant;
  } | undefined;
  for (const event of events) {
    if (!isPlainObject(event)) {
      return fail('malformed_feed');
    }
    const mapped = mapEventToAtomEntry(event, collectionUrl);
    if (!mapped.ok) {
      return fail(mapped.code);
    }
    // Atom is a representation of a COLP Feed, so each source event must
    // cross the same strict CloudEvent/data discriminator as other Feed
    // adapters. Unsafe Bookmark targets are deliberately sanitized only for
    // validation: Atom mapping omits their related link per FEED-0010.
    if (!validateAtomEvent(event, validators())) {
      return fail('malformed_feed');
    }
    entries.push(mapped.entry);
    if (latest === undefined || compareInstants(mapped.instant, latest.instant) > 0) {
      latest = { updated: mapped.entry.updated, instant: mapped.instant };
    }
  }

  let updated: string;
  if (latest === undefined) {
    if (optionsSnapshot.emptyFeedUpdated === undefined) {
      return fail('missing_updated');
    }
    updated = optionsSnapshot.emptyFeedUpdated;
  } else {
    updated = latest.updated;
  }

  const links: AtomLink[] = [
    Object.freeze({ rel: 'self', href: feedUrl, type: 'application/atom+xml' }),
    Object.freeze({
      rel: 'alternate',
      href: collectionUrl,
      type: 'text/html',
    }),
  ];

  const document: AtomFeedDocument = Object.freeze({
    id: feedUrl,
    title,
    updated,
    links: Object.freeze(links),
    entries: Object.freeze(entries),
  });
  if (!isAtomDocumentXmlSafe(document)) {
    return fail('invalid_xml');
  }

  try {
    return Object.freeze({ ok: true, document, xml: serializeBoundedAtom(document) });
  } catch (error) {
    if (error instanceof RangeError) return fail('malformed_feed');
    throw error;
  }
}

function validateAtomEvent(event: Readonly<Record<string, unknown>>, registry: ValidatorRegistry): boolean {
  const candidate = sanitizeUnsafeBookmarkTarget(event);
  const result = discriminateFeedEvent(candidate, registry);
  return result.valid;
}

function sanitizeUnsafeBookmarkTarget(
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const data = event.data;
  if (!isPlainObject(data)) return event;
  const node = data.node;
  if (
    !isPlainObject(node)
    || node.kind !== 'bookmark'
    || node.redacted === true
    || typeof node.url !== 'string'
    || isHttpUrl(node.url)
  ) {
    return event;
  }

  // FeedNode's redacted form must not retain target-derived fields. Keep the
  // original event for Atom mapping so the unsafe target is simply omitted.
  const { url: _url, canonicalUrl: _canonicalUrl, urlHash: _urlHash, ...safeNode } = node;
  return {
    ...event,
    data: {
      ...data,
      node: { ...safeNode, redacted: true },
    },
  };
}

function mapEventToAtomEntry(
  event: Readonly<Record<string, unknown>>,
  collectionUrl: string,
): AtomEntryMapping {
  const id = event.id;
  const time = event.time;
  if (typeof id !== 'string' || id.length === 0 || typeof time !== 'string') {
    return { ok: false, code: 'malformed_feed' };
  }
  const instant = parseComparableRfc3339Instant(time);
  if (instant === null) {
    return { ok: false, code: 'invalid_datetime' };
  }

  const data: Readonly<Record<string, unknown>> = isPlainObject(event.data)
    ? event.data
    : Object.freeze({});
  const summary = typeof data.summary === 'string' ? data.summary : undefined;
  const eventType = typeof event.type === 'string' ? event.type : undefined;
  const title = summary ?? eventType ?? 'Feed event';
  if (
    !isXml10String(id)
    || !isXml10String(title)
    || (eventType !== undefined && !isXml10String(eventType))
    || (summary !== undefined && !isXml10String(summary))
  ) {
    return { ok: false, code: 'invalid_xml' };
  }

  const links: AtomLink[] = [
    Object.freeze({
      rel: 'alternate',
      href: collectionUrl,
      type: 'text/html',
    }),
  ];

  const node = data.node;
  if (isPlainObject(node) && node.kind === 'bookmark' && node.redacted !== true) {
    if (typeof node.url === 'string' && !isXml10String(node.url)) {
      return { ok: false, code: 'invalid_xml' };
    }
    const projection = projectFeedBookmarkUrl(node.url);
    if (projection.outcome === 'keep') {
      links.push(Object.freeze({ rel: 'related', href: projection.url }));
    }
  }

  return {
    ok: true,
    instant,
    entry: Object.freeze({
      id: `urn:collectionprotocol:event:${id}`,
      title,
      updated: time,
      links: Object.freeze(links),
      ...(summary === undefined ? {} : { summary, content: summary }),
    }),
  };
}

function snapshotAtomOptions(value: unknown): Readonly<AtomMapOptions> | null {
  let snapshot: DeepReadonly<unknown>;
  try {
    snapshot = immutableJsonSnapshot(value, 'Atom map options');
  } catch {
    return null;
  }
  if (!isPlainObject(snapshot)) {
    return null;
  }
  for (const key of Reflect.ownKeys(snapshot)) {
    if (typeof key !== 'string' || !ATOM_OPTION_KEYS.has(key)) {
      return null;
    }
  }
  const emptyFeedUpdated = snapshot.emptyFeedUpdated;
  if (emptyFeedUpdated !== undefined && typeof emptyFeedUpdated !== 'string') {
    return null;
  }
  return Object.freeze({
    ...(emptyFeedUpdated === undefined ? {} : { emptyFeedUpdated }),
  });
}

function parseComparableRfc3339Instant(value: string): ComparableRfc3339Instant | null {
  if (!isRfc3339DateTime(value) || UNKNOWN_LOCAL_OFFSET.test(value)) {
    return null;
  }
  const match = COMPARABLE_RFC3339.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetSign = match[9] === '-' ? -1 : match[9] === '+' ? 1 : 0;
  const offsetSeconds = offsetSign
    * (Number(match[10] ?? 0) * 60 + Number(match[11] ?? 0))
    * 60;
  const dayOrdinal = daysBeforeYear(year)
    + (DAYS_BEFORE_MONTH[month - 1] ?? 0)
    + (month > 2 && isLeapYear(year) ? 1 : 0)
    + day - 1;
  const localWholeSecond = BigInt(dayOrdinal) * 86_400n
    + BigInt(hour * 3_600 + minute * 60 + Math.min(second, 59));

  return Object.freeze({
    wholeSecond: localWholeSecond - BigInt(offsetSeconds),
    leapSecond: second === 60,
    fraction: match[7] ?? '',
  });
}

function compareInstants(
  left: ComparableRfc3339Instant,
  right: ComparableRfc3339Instant,
): -1 | 0 | 1 {
  if (left.wholeSecond < right.wholeSecond) return -1;
  if (left.wholeSecond > right.wholeSecond) return 1;
  if (left.leapSecond !== right.leapSecond) {
    return left.leapSecond ? 1 : -1;
  }
  return compareFractionalDigits(left.fraction, right.fraction);
}

function compareFractionalDigits(left: string, right: string): -1 | 0 | 1 {
  const maximumLength = Math.max(left.length, right.length);
  for (let index = 0; index < maximumLength; index += 1) {
    const leftDigit = index < left.length ? left.charCodeAt(index) - 48 : 0;
    const rightDigit = index < right.length ? right.charCodeAt(index) - 48 : 0;
    if (leftDigit < rightDigit) return -1;
    if (leftDigit > rightDigit) return 1;
  }
  return 0;
}

function daysBeforeYear(year: number): number {
  if (year === 0) return 0;
  return year * 365
    + Math.floor((year - 1) / 4)
    - Math.floor((year - 1) / 100)
    + Math.floor((year - 1) / 400)
    + 1;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isAtomDocumentXmlSafe(document: AtomFeedDocument): boolean {
  return isXml10String(document.id)
    && isXml10String(document.title)
    && isXml10String(document.updated)
    && document.links.every(isAtomLinkXmlSafe)
    && document.entries.every((entry) =>
      isXml10String(entry.id)
      && isXml10String(entry.title)
      && isXml10String(entry.updated)
      && entry.links.every(isAtomLinkXmlSafe)
      && (entry.summary === undefined || isXml10String(entry.summary))
      && (entry.content === undefined || isXml10String(entry.content)),
    );
}

function isAtomLinkXmlSafe(link: AtomLink): boolean {
  return isXml10String(link.rel)
    && isXml10String(link.href)
    && (link.type === undefined || isXml10String(link.type));
}

/** XML 1.0 Fifth Edition `Char`, with well-formed UTF-16 required first. */
function isXml10String(value: string): boolean {
  if (!hasWellFormedUtf16(value)) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x09
      && codePoint !== 0x0a
      && codePoint !== 0x0d
      && !(codePoint >= 0x20 && codePoint <= 0xd7ff)
      && !(codePoint >= 0xe000 && codePoint <= 0xfffd)
      && !(codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      return false;
    }
  }
  return true;
}

function fail(code: AtomMapErrorCode): AtomMapResult {
  return Object.freeze({ ok: false, code });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (
    value === null
    || typeof value !== 'object'
    || isProxy(value)
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
