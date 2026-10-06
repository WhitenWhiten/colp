import { isProxy } from 'node:util/types';

import LinkHeader from 'http-link-header';

import { cloneAndFreezeJsonData, createValidatorRegistry } from '../schema/index.js';
import { isRfc3986Uri } from '../schema/uri.js';
import type { CollectionLinks, CollectionMetadata } from '../types/index.js';
import { createPublicationJsonResponse } from './publication-http-utf8.js';

export const PUBLICATION_COLLECTION_METADATA_MEDIA_TYPE =
  'application/vnd.collection-protocol.collection+json' as const;
export const PUBLICATION_SNAPSHOT_MEDIA_TYPE =
  'application/vnd.collection-protocol.snapshot+json' as const;
export const PUBLICATION_FEED_MEDIA_TYPE =
  'application/vnd.collection-protocol.feed+json' as const;
export const PUBLICATION_JSON_FEED_MEDIA_TYPE = 'application/feed+json' as const;
export const PUBLICATION_ATOM_FEED_MEDIA_TYPE = 'application/atom+xml' as const;
export const PUBLICATION_SNAPSHOT_REL =
  'https://collectionprotocol.org/rels/snapshot' as const;
export const PUBLICATION_FEED_REL =
  'https://collectionprotocol.org/rels/feed' as const;

export interface PublicationCollectionMetadataResponseInit {
  readonly method: 'GET' | 'HEAD';
  readonly status?: number;
  readonly headers?: PublicationCollectionMetadataHeadersInit;
}

export type PublicationCollectionMetadataHeadersInit =
  ConstructorParameters<typeof Headers>[0];

interface CollectionMetadataLink {
  readonly target: string;
  readonly rel: string;
  readonly type: string;
  readonly exclusiveRelation: boolean;
}

const INVALID_METADATA_MESSAGE = 'Publication Collection Metadata is invalid.';
const METADATA_LIMIT_MESSAGE = 'Publication Collection Metadata resource limit exceeded.';
const INVALID_HEADERS_MESSAGE = 'Publication Collection Metadata headers are invalid.';
const INVALID_INIT_MESSAGE = 'Publication Collection Metadata response options are invalid.';
const MAX_LINK_TARGET_LENGTH = 4_096;
const MAX_LINK_HEADER_LENGTH = 64 * 1_024;
const MAX_HEADER_COUNT = 128;
const allowedLinkKeys = new Set<keyof CollectionLinks>([
  'self', 'canonical', 'snapshot', 'node', 'nodes', 'annotations', 'attachments',
  'relations', 'feed', 'releases', 'release', 'access', 'alternateJsonFeed', 'alternateAtom',
]);
const requiredLinkKeys = ['self', 'canonical', 'snapshot'] as const;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const httpUrl = /^https?:\/\/[^/?#\s]+(?:[/?#]|$)/iu;
const userInfo = /^https?:\/\/[^/?#]*@/iu;
const malformedPercentEscape = /%(?![0-9A-Fa-f]{2})/u;
const validators = createValidatorRegistry();
const metadataResourceRelations = Object.freeze([
  'self',
  'canonical',
  PUBLICATION_SNAPSHOT_REL,
  PUBLICATION_FEED_REL,
  'alternate',
]);

class CollectionMetadataLimitError extends Error {}

/** Create the RFC 8288 Link value for a validated Collection Metadata body. */
export function createPublicationCollectionMetadataLinkHeader(metadata: unknown): string {
  return prepareMetadata(metadata).links.map(formatLink).join(', ');
}

/** Copy adapter headers and merge the links derived from CollectionMetadata.links. */
export function mergePublicationCollectionMetadataLinkHeaders(
  metadata: unknown,
  headers?: PublicationCollectionMetadataHeadersInit,
): Headers {
  const prepared = prepareMetadata(metadata);
  const result = copyHeaders(headers);
  mergeLinks(result, prepared.links);
  return result;
}

/**
 * Build an adapter-ready GET or HEAD response. Success responses advertise
 * Collection Metadata links; non-success responses remove that resource Link
 * field so error bodies cannot accidentally reflect success navigation.
 */
export function createPublicationCollectionMetadataResponse(
  value: unknown,
  init: PublicationCollectionMetadataResponseInit,
): Response {
  const options = inspectResponseInit(init);
  const headers = copyHeaders(options.headers);
  const success = options.status === 200 || options.status === 304;
  let bodyValue: unknown = value;

  if (success) {
    const prepared = prepareMetadata(value);
    bodyValue = prepared.body;
    mergeLinks(headers, prepared.links);
  } else {
    removeMetadataResourceLinks(headers);
  }

  if (options.status === 304 || options.status === 204 || options.status === 205) {
    return new Response(null, { status: options.status, headers });
  }
  const response = createPublicationJsonResponse(bodyValue, { status: options.status, headers });
  if (options.method === 'GET') return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const createPublicationCollectionMetadataLinks =
  createPublicationCollectionMetadataLinkHeader;
export const applyPublicationCollectionMetadataLinkHeaders =
  mergePublicationCollectionMetadataLinkHeaders;

function prepareMetadata(metadata: unknown): {
  readonly body: Readonly<CollectionMetadata>;
  readonly links: readonly CollectionMetadataLink[];
} {
  try {
    assertSafeDataGraph(metadata);
    const body = cloneAndFreezeJsonData(metadata) as Readonly<CollectionMetadata>;
    if (!isExactObject(body, ['collection', 'links'])) throw new TypeError();
    const links = inspectCollectionLinks(body.links);
    if (!validators.validate('collectionMetadata', body).valid) throw new TypeError();
    return Object.freeze({ body, links });
  } catch (error) {
    if (error instanceof CollectionMetadataLimitError) throw new RangeError(METADATA_LIMIT_MESSAGE);
    throw new TypeError(INVALID_METADATA_MESSAGE);
  }
}

function inspectCollectionLinks(value: unknown): readonly CollectionMetadataLink[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowedLinkKeys.has(key as keyof CollectionLinks))) {
    throw new TypeError();
  }
  for (const required of requiredLinkKeys) if (!keys.includes(required)) throw new TypeError();

  const links = value as Readonly<CollectionLinks>;
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError();
    assertSafeLinkTarget(links[key as keyof CollectionLinks]);
  }

  const generated: CollectionMetadataLink[] = [
    link(links.self, 'self', PUBLICATION_COLLECTION_METADATA_MEDIA_TYPE, true),
    link(links.canonical, 'canonical', 'text/html', true),
    link(links.snapshot, PUBLICATION_SNAPSHOT_REL, PUBLICATION_SNAPSHOT_MEDIA_TYPE, true),
  ];
  if (links.feed !== undefined) {
    generated.push(link(links.feed, PUBLICATION_FEED_REL, PUBLICATION_FEED_MEDIA_TYPE, true));
  }
  if (links.alternateJsonFeed !== undefined) {
    generated.push(link(links.alternateJsonFeed, 'alternate', PUBLICATION_JSON_FEED_MEDIA_TYPE, false));
  }
  if (links.alternateAtom !== undefined) {
    generated.push(link(links.alternateAtom, 'alternate', PUBLICATION_ATOM_FEED_MEDIA_TYPE, false));
  }
  return Object.freeze(generated.map((item) => Object.freeze(item)));
}

function link(target: string, rel: string, type: string, exclusiveRelation: boolean): CollectionMetadataLink {
  return { target, rel, type, exclusiveRelation };
}

function assertSafeLinkTarget(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u0020\u007f]/u.test(value)
    || malformedPercentEscape.test(value) || !httpUrl.test(value) || userInfo.test(value)
    || !isRfc3986Uri(value)) throw new TypeError();
  if (value.length > MAX_LINK_TARGET_LENGTH) throw new CollectionMetadataLimitError();
}

function mergeLinks(headers: Headers, generated: readonly CollectionMetadataLink[]): void {
  const existing = headers.get('link');
  const parsed = inspectExistingLinks(existing);
  const additions: CollectionMetadataLink[] = [];
  for (const candidate of generated) {
    const sameRelation = parsed.filter((item) => relationIncludes(item.rel, candidate.rel));
    const duplicate = sameRelation.some(
      (item) => item.uri === candidate.target && item.type === candidate.type,
    );
    if (duplicate) continue;
    if (candidate.exclusiveRelation && sameRelation.length > 0) {
      throw new TypeError(INVALID_HEADERS_MESSAGE);
    }
    additions.push(candidate);
  }
  if (additions.length === 0) return;
  const addition = additions.map(formatLink).join(', ');
  const combined = existing === null ? addition : `${existing}, ${addition}`;
  if (combined.length > MAX_LINK_HEADER_LENGTH) throw new RangeError(INVALID_HEADERS_MESSAGE);
  headers.set('link', combined);
}

function inspectExistingLinks(value: string | null): readonly LinkHeader.Reference[] {
  if (value === null) return [];
  try {
    if (value.length === 0 || value.length > MAX_LINK_HEADER_LENGTH || /[\r\n]/u.test(value)) throw new TypeError();
    const refs = LinkHeader.parse(value).refs;
    if (refs.length === 0) throw new TypeError();
    for (const reference of refs) {
      assertSafeLinkTarget(reference.uri);
      if (typeof reference.rel !== 'string' || reference.rel.trim().length === 0) throw new TypeError();
    }
    return refs;
  } catch (error) {
    if (error instanceof CollectionMetadataLimitError) throw new RangeError(INVALID_HEADERS_MESSAGE);
    throw new TypeError(INVALID_HEADERS_MESSAGE);
  }
}

function relationIncludes(value: string, relation: string): boolean {
  const expected = relation.includes(':') ? relation : relation.toLowerCase();
  return value.trim().split(/\s+/u).some((item) => (
    relation.includes(':') ? item === expected : item.toLowerCase() === expected
  ));
}

function removeMetadataResourceLinks(headers: Headers): void {
  const existing = headers.get('link');
  if (existing === null) return;
  const parsed = inspectExistingLinks(existing);
  const retained = parsed.filter((reference) => !metadataResourceRelations.some(
    (relation) => relationIncludes(reference.rel, relation),
  ));
  if (retained.length === 0) {
    headers.delete('link');
    return;
  }
  const normalized = new LinkHeader();
  for (const reference of retained) normalized.setUnique(reference);
  headers.set('link', normalized.toString());
}

function copyHeaders(source: PublicationCollectionMetadataHeadersInit | undefined): Headers {
  if (source === undefined) return new Headers();
  try {
    if (isProxy(source)) throw new TypeError();
    let entries: readonly (readonly [string, string])[];
    if (source instanceof Headers) {
      entries = [...Headers.prototype.entries.call(source)];
    } else if (Array.isArray(source)) {
      entries = inspectHeaderTuples(source);
    } else {
      if (Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null) throw new TypeError();
      const keys = Reflect.ownKeys(source);
      if (keys.length > MAX_HEADER_COUNT) throw new TypeError();
      entries = keys.map((key) => {
        if (typeof key !== 'string' || forbiddenKeys.has(key)) throw new TypeError();
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)
          || typeof descriptor.value !== 'string') throw new TypeError();
        return [key, descriptor.value] as const;
      });
    }
    for (const [name, value] of entries) {
      if (!headerName.test(name) || /[\r\n]/u.test(value)) throw new TypeError();
    }
    return new Headers(entries as [string, string][]);
  } catch {
    throw new TypeError(INVALID_HEADERS_MESSAGE);
  }
}

function inspectHeaderTuples(source: readonly unknown[]): readonly (readonly [string, string])[] {
  if (source.length > MAX_HEADER_COUNT) throw new TypeError();
  return source.map((entry) => {
    if (isProxy(entry) || !Array.isArray(entry) || entry.length !== 2) throw new TypeError();
    const first = Object.getOwnPropertyDescriptor(entry, '0');
    const second = Object.getOwnPropertyDescriptor(entry, '1');
    if (first === undefined || second === undefined || !('value' in first) || !('value' in second)
      || typeof first.value !== 'string' || typeof second.value !== 'string') throw new TypeError();
    return [first.value, second.value] as const;
  });
}

function inspectResponseInit(init: PublicationCollectionMetadataResponseInit): {
  readonly method: 'GET' | 'HEAD';
  readonly status: number;
  readonly headers?: PublicationCollectionMetadataHeadersInit;
} {
  try {
    if (isProxy(init) || typeof init !== 'object' || init === null || Array.isArray(init)
      || (Object.getPrototypeOf(init) !== Object.prototype && Object.getPrototypeOf(init) !== null)) throw new TypeError();
    const keys = Reflect.ownKeys(init);
    if (keys.some((key) => typeof key !== 'string' || !['method', 'status', 'headers'].includes(key))) throw new TypeError();
    const method = ownDataValue(init, 'method');
    const status = keys.includes('status') ? ownDataValue(init, 'status') : 200;
    const headers = keys.includes('headers') ? ownDataValue(init, 'headers') : undefined;
    if ((method !== 'GET' && method !== 'HEAD') || !Number.isInteger(status)
      || (status as number) < 200 || (status as number) > 599) throw new TypeError();
    return {
      method,
      status: status as number,
      ...(headers === undefined ? {} : { headers: headers as PublicationCollectionMetadataHeadersInit }),
    };
  } catch {
    throw new TypeError(INVALID_INIT_MESSAGE);
  }
}

function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}

function isExactObject(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => typeof key === 'string' && expectedKeys.includes(key));
}

function assertSafeDataGraph(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    if (isProxy(current)) throw new TypeError();
    seen.add(current);
    count += 1;
    if (count > 100_000) throw new CollectionMetadataLimitError();
    const prototype = Object.getPrototypeOf(current) as unknown;
    if ((!Array.isArray(current) && prototype !== Object.prototype && prototype !== null)
      || (Array.isArray(current) && prototype !== Array.prototype)) throw new TypeError();
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (typeof key !== 'string' || forbiddenKeys.has(key)) throw new TypeError();
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
      pending.push(descriptor.value);
    }
  }
}

function formatLink(value: CollectionMetadataLink): string {
  return `<${value.target}>; rel="${value.rel}"; type="${value.type}"`;
}
