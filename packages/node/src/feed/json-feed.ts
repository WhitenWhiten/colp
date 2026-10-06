import { isProxy } from 'node:util/types';

import { createValidatorRegistry, type ValidatorRegistry } from '../schema/index.js';
import { isHttpUrl } from '../schema/uri.js';
import {
  immutableJsonSnapshot,
  type DeepReadonly,
} from '../shared/immutable-json.js';
import type { Feed } from '../types/index.js';
import { projectFeedBookmarkUrl } from './bookmark-url.js';
import {
  discriminateFeedEvent,
  type VerifiedFeedEvent,
} from './event-contracts.js';

export const JSON_FEED_MAX_AUTHORS = 32;
export const JSON_FEED_MAX_TAGS = 128;
export const JSON_FEED_MAX_ATTACHMENTS_PER_EVENT = 32;
export const JSON_FEED_MAX_TITLE_LENGTH = 1_024;
export const JSON_FEED_MAX_AUTHOR_NAME_LENGTH = 256;
export const JSON_FEED_MAX_TAG_LENGTH = 256;
export const JSON_FEED_MAX_ATTACHMENT_TITLE_LENGTH = 1_024;
export const JSON_FEED_MAX_MIME_TYPE_LENGTH = 255;
export const JSON_FEED_MAX_URL_LENGTH = 4_096;
export const JSON_FEED_MAX_ATTACHMENT_SIZE_IN_BYTES = Number.MAX_SAFE_INTEGER;

const OPTION_KEYS = Object.freeze([
  'authors',
  'tags',
  'titleOverride',
  'attachmentsByEventId',
] as const);
const AUTHOR_KEYS = Object.freeze(['name', 'url'] as const);
const ATTACHMENT_KEYS = Object.freeze(['url', 'mime_type', 'title', 'size_in_bytes'] as const);
const MIME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export interface JsonFeedAuthor {
  readonly name?: string;
  readonly url?: string;
}

export interface JsonFeedItem {
  readonly id: string;
  readonly url?: string;
  readonly external_url?: string;
  readonly title?: string;
  readonly content_text?: string;
  readonly summary?: string;
  readonly date_published?: string;
  readonly tags?: readonly string[];
  readonly attachments?: readonly JsonFeedAttachment[];
  readonly _collection_protocol: {
    readonly type: string;
    readonly subject: string;
    readonly collectionprotocolversion: string;
  };
}

export interface JsonFeedAttachment {
  readonly url: string;
  readonly mime_type: string;
  readonly title?: string;
  readonly size_in_bytes?: number;
}

export interface JsonFeedDocument {
  readonly version: 'https://jsonfeed.org/version/1.1';
  readonly title: string;
  readonly home_page_url?: string;
  readonly feed_url: string;
  readonly authors?: readonly JsonFeedAuthor[];
  readonly items: readonly JsonFeedItem[];
  readonly _collection_protocol: {
    readonly protocolVersion: string;
    readonly nextCursor: string;
    readonly hasMore: boolean;
  };
}

export type JsonFeedMapErrorCode =
  | 'malformed_feed'
  | 'unsafe_url'
  | 'invalid_subject'
  | 'invalid_options'
  | 'invalid_attachment';

export type JsonFeedMapResult =
  | { readonly ok: true; readonly document: JsonFeedDocument }
  | { readonly ok: false; readonly code: JsonFeedMapErrorCode };

export interface JsonFeedMapOptions {
  readonly authors?: readonly JsonFeedAuthor[];
  readonly tags?: readonly string[];
  readonly titleOverride?: string;
  readonly attachmentsByEventId?: Readonly<
    Record<string, readonly JsonFeedAttachment[]>
  >;
}

interface ValidatedJsonFeedOptions {
  readonly authors?: readonly JsonFeedAuthor[];
  readonly tags?: readonly string[];
  readonly titleOverride?: string;
  readonly attachmentsByEventId?: Readonly<
    Record<string, readonly JsonFeedAttachment[]>
  >;
}

let defaultValidators: ValidatorRegistry | undefined;

function validators(): ValidatorRegistry {
  defaultValidators ??= createValidatorRegistry();
  return defaultValidators;
}

function fail(code: JsonFeedMapErrorCode): JsonFeedMapResult {
  return Object.freeze({ ok: false, code });
}

/**
 * Maps a validated COLP Feed document to JSON Feed 1.1 (FEED-0005).
 *
 * Relative CloudEvents Subjects are resolved against the validated Event
 * Source. Attachment metadata has no FeedEvent field, so callers provide it
 * explicitly by Event ID through `attachmentsByEventId`.
 */
export function mapFeedToJsonFeed(
  feed: unknown,
  options: JsonFeedMapOptions = {},
): JsonFeedMapResult {
  let feedSnapshot: DeepReadonly<unknown>;
  try {
    feedSnapshot = immutableJsonSnapshot(feed, 'JSON Feed source Feed');
  } catch {
    return fail('malformed_feed');
  }

  if (!isPlainObject(feedSnapshot)) {
    return fail('malformed_feed');
  }
  if (!isHttpUrl(feedSnapshot.feedUrl) || !isHttpUrl(feedSnapshot.collectionUrl)) {
    return fail('unsafe_url');
  }
  const feedUrl = feedSnapshot.feedUrl;
  const collectionUrl = feedSnapshot.collectionUrl;

  const registry = validators();
  const structural = registry.validate('feed', feedSnapshot);
  if (!structural.valid) {
    return fail('malformed_feed');
  }

  const verifiedEvents: VerifiedFeedEvent[] = [];
  for (const event of (feedSnapshot as DeepReadonly<Feed>).events) {
    const discriminated = discriminateFeedEvent(event, registry);
    if (!discriminated.valid) {
      return fail('malformed_feed');
    }
    verifiedEvents.push(discriminated.event);
  }

  const optionsSnapshot = snapshotOptions(options);
  if (optionsSnapshot.code !== undefined) {
    return fail(optionsSnapshot.code);
  }
  const validatedOptions = validateOptions(optionsSnapshot.value, verifiedEvents);
  if (validatedOptions.code !== undefined) {
    return fail(validatedOptions.code);
  }

  const items: JsonFeedItem[] = [];
  for (const event of verifiedEvents) {
    const item = mapEventToJsonFeedItem(event, validatedOptions.value);
    if (item === undefined) {
      return fail('invalid_subject');
    }
    items.push(item);
  }

  const validatedFeed = feedSnapshot as DeepReadonly<Feed>;
  const document: {
    version: 'https://jsonfeed.org/version/1.1';
    title: string;
    home_page_url: string;
    feed_url: string;
    authors?: readonly JsonFeedAuthor[];
    items: readonly JsonFeedItem[];
    _collection_protocol: {
      protocolVersion: string;
      nextCursor: string;
      hasMore: boolean;
    };
  } = {
    version: 'https://jsonfeed.org/version/1.1',
    title: validatedOptions.value.titleOverride ?? validatedFeed.title,
    home_page_url: collectionUrl,
    feed_url: feedUrl,
    items: Object.freeze(items),
    _collection_protocol: Object.freeze({
      protocolVersion: validatedFeed.protocolVersion,
      nextCursor: validatedFeed.nextCursor,
      hasMore: validatedFeed.hasMore,
    }),
  };
  if (validatedOptions.value.authors !== undefined) {
    document.authors = validatedOptions.value.authors;
  }

  return Object.freeze({ ok: true, document: Object.freeze(document) });
}

type OptionsValidationResult =
  | { readonly value: ValidatedJsonFeedOptions; readonly code?: undefined }
  | { readonly code: 'invalid_options' | 'invalid_attachment'; readonly value?: undefined };

type OptionsSnapshotResult =
  | { readonly value: DeepReadonly<unknown>; readonly code?: undefined }
  | { readonly code: 'invalid_options' | 'invalid_attachment'; readonly value?: undefined };

function snapshotOptions(input: unknown): OptionsSnapshotResult {
  if (!isPlainObject(input)) {
    return { code: 'invalid_options' };
  }

  const keys = Reflect.ownKeys(input);
  if (
    keys.some(
      (key) => typeof key !== 'string' || !OPTION_KEYS.some((allowed) => allowed === key),
    )
  ) {
    return { code: 'invalid_options' };
  }

  const descriptors = new Map<string, PropertyDescriptor>();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return { code: key === 'attachmentsByEventId' ? 'invalid_attachment' : 'invalid_options' };
    }
    descriptors.set(key, descriptor);
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of descriptors) {
    try {
      snapshot[key] = immutableJsonSnapshot(
        descriptor.value,
        `JSON Feed mapper option ${key}`,
      );
    } catch {
      return { code: key === 'attachmentsByEventId' ? 'invalid_attachment' : 'invalid_options' };
    }
  }
  return { value: Object.freeze(snapshot) };
}

function validateOptions(
  value: DeepReadonly<unknown>,
  events: readonly VerifiedFeedEvent[],
): OptionsValidationResult {
  if (!isExactPlainObject(value, OPTION_KEYS)) {
    return { code: 'invalid_options' };
  }

  const titleOverride = value.titleOverride;
  if (
    titleOverride !== undefined
    && !isBoundedString(titleOverride, JSON_FEED_MAX_TITLE_LENGTH)
  ) {
    return { code: 'invalid_options' };
  }

  let authors: readonly JsonFeedAuthor[] | undefined;
  if (value.authors !== undefined) {
    if (!Array.isArray(value.authors) || value.authors.length > JSON_FEED_MAX_AUTHORS) {
      return { code: 'invalid_options' };
    }
    const mappedAuthors: JsonFeedAuthor[] = [];
    for (const candidate of value.authors) {
      if (!isExactPlainObject(candidate, AUTHOR_KEYS)) {
        return { code: 'invalid_options' };
      }
      const name = candidate.name;
      const url = candidate.url;
      if (
        (name === undefined && url === undefined)
        || (name !== undefined && !isBoundedString(name, JSON_FEED_MAX_AUTHOR_NAME_LENGTH))
        || (url !== undefined && !isSafeJsonFeedUrl(url))
      ) {
        return { code: 'invalid_options' };
      }
      mappedAuthors.push(Object.freeze({
        ...(name === undefined ? {} : { name }),
        ...(url === undefined ? {} : { url }),
      }));
    }
    authors = Object.freeze(mappedAuthors);
  }

  let tags: readonly string[] | undefined;
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > JSON_FEED_MAX_TAGS) {
      return { code: 'invalid_options' };
    }
    const mappedTags: string[] = [];
    for (const tag of value.tags) {
      if (!isBoundedString(tag, JSON_FEED_MAX_TAG_LENGTH)) {
        return { code: 'invalid_options' };
      }
      mappedTags.push(tag);
    }
    tags = Object.freeze(mappedTags);
  }

  const attachments = validateAttachments(value.attachmentsByEventId, events);
  if (attachments.code !== undefined) {
    return attachments;
  }

  return {
    value: Object.freeze({
      ...(authors === undefined ? {} : { authors }),
      ...(tags === undefined ? {} : { tags }),
      ...(titleOverride === undefined ? {} : { titleOverride }),
      ...(attachments.value === undefined
        ? {}
        : { attachmentsByEventId: attachments.value }),
    }),
  };
}

type AttachmentsValidationResult =
  | {
      readonly value: Readonly<Record<string, readonly JsonFeedAttachment[]>> | undefined;
      readonly code?: undefined;
    }
  | { readonly code: 'invalid_attachment'; readonly value?: undefined };

function validateAttachments(
  value: unknown,
  events: readonly VerifiedFeedEvent[],
): AttachmentsValidationResult {
  if (value === undefined) {
    return { value: undefined };
  }
  if (!isPlainObject(value)) {
    return { code: 'invalid_attachment' };
  }

  const eventIds = new Set(events.map((event) => event.id));
  const output = Object.create(null) as Record<string, readonly JsonFeedAttachment[]>;
  for (const eventId of Object.keys(value)) {
    if (!eventIds.has(eventId)) {
      return { code: 'invalid_attachment' };
    }
    const candidates = value[eventId];
    if (
      !Array.isArray(candidates)
      || candidates.length > JSON_FEED_MAX_ATTACHMENTS_PER_EVENT
    ) {
      return { code: 'invalid_attachment' };
    }

    const mapped: JsonFeedAttachment[] = [];
    for (const candidate of candidates) {
      if (!isExactPlainObject(candidate, ATTACHMENT_KEYS)) {
        return { code: 'invalid_attachment' };
      }
      const url = candidate.url;
      const mimeType = candidate.mime_type;
      const title = candidate.title;
      const size = candidate.size_in_bytes;
      if (
        !isSafeJsonFeedUrl(url)
        || !isBoundedString(mimeType, JSON_FEED_MAX_MIME_TYPE_LENGTH)
        || !MIME_TOKEN.test(mimeType)
        || /[\r\n]/u.test(mimeType)
        || (
          title !== undefined
          && !isBoundedString(title, JSON_FEED_MAX_ATTACHMENT_TITLE_LENGTH)
        )
        || (
          size !== undefined
          && (
            typeof size !== 'number'
            || !Number.isSafeInteger(size)
            || size < 0
            || size > JSON_FEED_MAX_ATTACHMENT_SIZE_IN_BYTES
          )
        )
      ) {
        return { code: 'invalid_attachment' };
      }
      mapped.push(Object.freeze({
        url,
        mime_type: mimeType,
        ...(title === undefined ? {} : { title }),
        ...(size === undefined ? {} : { size_in_bytes: size }),
      }));
    }
    output[eventId] = Object.freeze(mapped);
  }
  return { value: Object.freeze(output) };
}

function mapEventToJsonFeedItem(
  event: VerifiedFeedEvent,
  options: ValidatedJsonFeedOptions,
): JsonFeedItem | undefined {
  const subjectUrl = resolveEventSubject(event.subject, event.source);
  if (subjectUrl === undefined) {
    return undefined;
  }

  const summary = 'summary' in event.data && typeof event.data.summary === 'string'
    ? event.data.summary
    : undefined;

  let externalUrl: string | undefined;
  if (
    event.type === 'org.collectionprotocol.node.created.v1'
    || event.type === 'org.collectionprotocol.node.updated.v1'
    || event.type === 'org.collectionprotocol.node.moved.v1'
  ) {
    const node = event.data.node;
    if (node.kind === 'bookmark' && node.redacted !== true) {
      const projection = projectFeedBookmarkUrl(node.url);
      if (projection.outcome === 'keep') {
        externalUrl = projection.url;
      }
    }
  }

  const attachments = options.attachmentsByEventId?.[event.id];
  return Object.freeze({
    id: event.id,
    url: subjectUrl,
    date_published: event.time,
    ...(summary === undefined ? {} : { content_text: summary, summary }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(externalUrl === undefined ? {} : { external_url: externalUrl }),
    _collection_protocol: Object.freeze({
      type: event.type,
      subject: event.subject,
      collectionprotocolversion: event.collectionprotocolversion,
    }),
  });
}

function resolveEventSubject(subject: string, source: string): string | undefined {
  if (
    subject.length > JSON_FEED_MAX_URL_LENGTH
    || /[\u0000-\u001F\u007F]/u.test(subject)
  ) {
    return undefined;
  }
  try {
    // An absolute Subject is validated and preserved without URL reserialization.
    new URL(subject);
    return isSafeJsonFeedUrl(subject) ? subject : undefined;
  } catch {
    // A relative Subject is meaningful only when Source is a usable HTTP(S) base.
  }

  if (!isSafeJsonFeedUrl(source)) {
    return undefined;
  }
  try {
    const resolved = new URL(subject, source);
    return isSafeJsonFeedUrl(resolved.href) ? resolved.href : undefined;
  } catch {
    return undefined;
  }
}

function isSafeJsonFeedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > JSON_FEED_MAX_URL_LENGTH || !isHttpUrl(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === ''
    );
  } catch {
    return false;
  }
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength;
}

function isExactPlainObject(
  value: unknown,
  allowedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

/** Type guard helper for Feed-shaped values without full Schema validation. */
export function isFeedLike(value: unknown): value is Feed {
  return (
    isPlainObject(value)
    && typeof value.feedUrl === 'string'
    && typeof value.collectionUrl === 'string'
    && typeof value.title === 'string'
    && Array.isArray(value.events)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
