import { isProxy } from 'node:util/types';

import type { ManifestMount } from '../types/index.js';

const publicationTransportBoundaryBrand: unique symbol = Symbol('PublicationTransportBoundary');

interface PublicationTransportState {
  readonly trustedOrigin: string;
  readonly protocol: 'http:' | 'https:';
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

  const boundary = Object.freeze({}) as PublicationTransportBoundary;
  publicationTransportStates.set(boundary, Object.freeze({
    trustedOrigin: baseUrl.origin,
    protocol,
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
