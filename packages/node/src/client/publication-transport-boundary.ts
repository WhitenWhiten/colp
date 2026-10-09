import { isProxy } from 'node:util/types';

import type { ManifestMount } from '../types/index.js';

const publicationTransportBoundaryBrand: unique symbol = Symbol('PublicationTransportBoundary');

interface PublicationTransportState {
  readonly trustedOrigin: string;
  readonly protocol: 'http:' | 'https:';
  readonly mountRoute: {
    readonly id: string;
    readonly profiles: readonly string[];
    readonly endpoints: ManifestMount['endpoints'];
  };
}

const publicationTransportStates = new WeakMap<object, PublicationTransportState>();
const publicationTransportOwners = new WeakMap<ManifestMount, WeakSet<object>>();

/** An opaque transport policy derived from a selected Publication Mount's base URL. */
export interface PublicationTransportBoundary {
  readonly [publicationTransportBoundaryBrand]: true;
}

/**
 * Reduces baseUrl to transport-only origin and scheme state. Its path, query,
 * and fragment never cross this boundary into Publication URL routing.
 */
export function createPublicationTransportBoundary(
  mount: ManifestMount,
): PublicationTransportBoundary {
  let baseUrl: URL;
  try {
    baseUrl = new URL(publicationBaseUrl(mount));
  } catch {
    throw invalidBaseUrl();
  }

  const protocol = baseUrl.protocol;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname.toLowerCase());
  if (
    (protocol !== 'https:' && protocol !== 'http:')
    || baseUrl.username !== ''
    || baseUrl.password !== ''
    || (protocol === 'http:' && !loopback)
  ) {
    throw invalidBaseUrl();
  }
  if (!baseUrl.pathname.endsWith('/')) {
    throw new TypeError('Publication Mount baseUrl path must end with /.');
  }

  const mountRoute = snapshotMountRoute(mount);

  const boundary = Object.freeze({}) as PublicationTransportBoundary;
  publicationTransportStates.set(boundary, Object.freeze({
    trustedOrigin: baseUrl.origin,
    protocol,
    mountRoute,
  }));
  const owners = publicationTransportOwners.get(mount) ?? new WeakSet<object>();
  owners.add(boundary);
  publicationTransportOwners.set(mount, owners);
  return boundary;
}

function publicationBaseUrl(mount: ManifestMount): string {
  if (typeof mount !== 'object' || mount === null || isProxy(mount)) throw invalidBaseUrl();
  const descriptor = Object.getOwnPropertyDescriptor(mount, 'baseUrl');
  if (
    descriptor === undefined
    || !descriptor.enumerable
    || !('value' in descriptor)
    || typeof descriptor.value !== 'string'
  ) {
    throw invalidBaseUrl();
  }
  return descriptor.value;
}

/** Returns the only baseUrl-derived value available to Publication transport policy. */
export function publicationTrustedOrigin(boundary: PublicationTransportBoundary): string {
  return transportState(boundary).trustedOrigin;
}

export function assertPublicationTransportBoundary(
  boundary: PublicationTransportBoundary,
  mount: ManifestMount,
): void {
  transportState(boundary);
  if (!publicationTransportOwners.get(mount)?.has(boundary)) {
    throw new TypeError('Publication transport boundary does not belong to the selected Mount.');
  }
}

export function publicationTransportProtocol(
  boundary: PublicationTransportBoundary,
): 'http:' | 'https:' {
  return transportState(boundary).protocol;
}

/** Returns the route declaration captured at the same trust boundary as the origin. */
export function publicationTransportRoute(
  boundary: PublicationTransportBoundary,
): {
  readonly id: string;
  readonly profiles: readonly string[];
  readonly endpoints: ManifestMount['endpoints'];
} {
  return transportState(boundary).mountRoute;
}

function snapshotMountRoute(mount: ManifestMount): PublicationTransportState['mountRoute'] {
  const id = readOwnData(mount, 'id');
  const profiles = readOwnData(mount, 'profiles');
  const endpoints = readOwnData(mount, 'endpoints');
  if (typeof id !== 'string' || !Array.isArray(profiles) || !isPlainArray(profiles)
    || typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)
    || isProxy(endpoints)) {
    throw new TypeError('Publication Mount route declaration is invalid.');
  }
  for (let index = 0; index < profiles.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(profiles, String(index));
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new TypeError('Publication Mount route declaration is invalid.');
    }
  }
  const endpointSnapshot: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(endpoints)) {
    if (typeof key !== 'string') throw new TypeError('Publication Mount endpoints must use string keys.');
    const value = readOwnData(endpoints, key);
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError('Publication Mount endpoint declarations must be strings.');
    }
    endpointSnapshot[key] = value;
  }
  return Object.freeze({
    id,
    profiles: Object.freeze([...profiles]),
    endpoints: Object.freeze(endpointSnapshot) as ManifestMount['endpoints'],
  });
}

function readOwnData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw invalidBaseUrl();
  }
  return descriptor.value;
}

function isPlainArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every((key, index) => key === (index < value.length ? String(index) : 'length'));
}

function transportState(boundary: PublicationTransportBoundary): PublicationTransportState {
  const state = publicationTransportStates.get(boundary);
  if (state === undefined) {
    throw new TypeError('Publication transport boundary is invalid.');
  }
  return state;
}

function invalidBaseUrl(): TypeError {
  return new TypeError(
    'Publication Mount baseUrl must be HTTPS or loopback HTTP without user information.',
  );
}
