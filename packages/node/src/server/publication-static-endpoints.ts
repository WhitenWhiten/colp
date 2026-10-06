import { isProxy } from 'node:util/types';

import {
  declarePublicationEndpoints,
  type PublicationEndpointDeclaration,
} from './publication-endpoints.js';
import type { ManifestMount } from '../types/index.js';

const INVALID = 'Static Publication endpoint declarations are invalid.';
const MAX_VALUES = 10_000;

export interface PublicationStaticFeedEndpointDeclaration {
  readonly endpoint: 'instanceFeed' | 'collectionFeed';
  readonly template: string;
  readonly variables: readonly `${string}Id`[];
}

export interface PublicationStaticEndpointSnapshot {
  readonly mountId: string;
  readonly declarations: readonly PublicationEndpointDeclaration[];
  readonly feed: readonly PublicationStaticFeedEndpointDeclaration[];
}

export type PublicationStaticEndpointDeclaration =
  | PublicationEndpointDeclaration
  | PublicationStaticFeedEndpointDeclaration;

/** Validates and snapshots one static Publication Mount independently. */
export function snapshotPublicationStaticEndpoints(mount: unknown): PublicationStaticEndpointSnapshot {
  try {
    const detached = clonePlain(mount, new WeakSet<object>(), { count: 0 }) as ManifestMount;
    if (
      typeof detached.id !== 'string'
      || !Array.isArray(detached.profiles)
      || !detached.profiles.includes('core')
      || !detached.profiles.includes('publication')
    ) {
      throw new TypeError(INVALID);
    }
    const declarations = declarePublicationEndpoints(detached).map((declaration) => {
      const suffix = declaration.endpoint === 'directory'
        ? '/collections/index.json'
        : declaration.endpoint === 'collection'
          ? '/collections/items/{collectionId}/index.json'
          : '/collections/items/{collectionId}/snapshot.json';
      assertStaticPath(declaration.template, suffix);
      return Object.freeze({ ...declaration, variables: Object.freeze([...declaration.variables]) });
    });
    const endpoints = detached.endpoints as Record<string, unknown>;
    const hasInstance = Object.hasOwn(endpoints, 'instanceFeed');
    const hasCollection = Object.hasOwn(endpoints, 'collectionFeed');
    const hasFeedProfile = detached.profiles.includes('feed');
    const features = detached.features as unknown as Record<string, unknown>;
    const hasFeedFeature = Object.hasOwn(features, 'feed');
    if (
      hasInstance !== hasCollection
      || hasInstance !== hasFeedProfile
      || hasInstance !== hasFeedFeature
    ) throw new TypeError(INVALID);
    const feed: PublicationStaticFeedEndpointDeclaration[] = [];
    if (hasInstance) {
      const instanceFeed = endpoints.instanceFeed;
      const collectionFeed = endpoints.collectionFeed;
      if (typeof instanceFeed !== 'string' || typeof collectionFeed !== 'string') throw new TypeError(INVALID);
      assertStaticPath(instanceFeed, '/collections/-/feed.json', []);
      assertStaticPath(collectionFeed, '/collections/items/{collectionId}/feed.json', ['collectionId']);
      feed.push(Object.freeze({ endpoint: 'instanceFeed', template: instanceFeed, variables: Object.freeze([]) }));
      feed.push(Object.freeze({ endpoint: 'collectionFeed', template: collectionFeed, variables: Object.freeze(['collectionId'] as const) }));
    }
    return Object.freeze({
      mountId: detached.id,
      declarations: Object.freeze(declarations),
      feed: Object.freeze(feed),
    });
  } catch {
    throw new TypeError(INVALID);
  }
}

/** Alias returning only the detached endpoint declarations for one Mount. */
export function declarePublicationStaticEndpoints(mount: unknown): readonly PublicationStaticEndpointDeclaration[] {
  const snapshot = snapshotPublicationStaticEndpoints(mount);
  return Object.freeze([
    ...snapshot.declarations,
    ...snapshot.feed,
  ]);
}

function assertStaticPath(template: string, expected: string, variables?: readonly string[]): void {
  if (template.includes('#') || template.includes('?') || template.includes('..')) throw new TypeError(INVALID);
  const url = new URL(template);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new TypeError(INVALID);
  }
  // Compare the original pathname so URL normalization cannot turn encoded
  // bytes into a valid layout or encode URI-template braces on inspection.
  const source = /^(?:https?):\/\/[^/?#]+([^?#]*)$/iu.exec(template);
  const actual = source?.[1];
  if (variables === undefined) {
    if (actual !== expected) throw new TypeError(INVALID);
  } else if (actual !== expected || [...template.matchAll(/\{([^{}]+)\}/gu)].map((m) => m[1]) .join('\0') !== variables.join('\0')) {
    throw new TypeError(INVALID);
  }
  if (/[{}]/u.test(url.host)) throw new TypeError(INVALID);
}

function isLoopback(hostname: string): boolean {
  return hostname.toLowerCase() === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function clonePlain(value: unknown, seen: WeakSet<object>, state: { count: number }, depth = 0): unknown {
  state.count += 1;
  if (state.count > MAX_VALUES || depth > 64 || value === null || typeof value !== 'object' || isProxy(value) || seen.has(value)) {
    if (value === null || typeof value !== 'object') return value;
    throw new TypeError(INVALID);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(INVALID);
    const result = value.map((_, i) => cloneProperty(value, String(i), seen, state, depth + 1));
    return Object.freeze(result);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new TypeError(INVALID);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(INVALID);
    result[key] = cloneProperty(value, key, seen, state, depth + 1);
  }
  return Object.freeze(result);
}

function cloneProperty(owner: object, key: string, seen: WeakSet<object>, state: { count: number }, depth: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(INVALID);
  return clonePlain(descriptor.value, seen, state, depth);
}

export const validatePublicationStaticEndpoints = snapshotPublicationStaticEndpoints;
