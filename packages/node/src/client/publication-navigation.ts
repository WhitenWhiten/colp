import type { ValidatorRegistry } from '../schema/index.js';
import type { ManifestMount } from '../types/index.js';
import {
  resolvePublicationEndpoint,
  type PublicationEndpointKey,
} from './publication-endpoints.js';
import {
  assertPublicationQueryUrlText,
  preparePublicationQuery,
} from './publication-query.js';
import {
  publicationSnapshotNextUrl,
  type PublicationSnapshotNextLinkInput,
} from './publication-snapshot-pagination.js';
import type { PublicationTransportBoundary } from './publication-transport-boundary.js';

const publicationNavigationTargetBrand: unique symbol = Symbol('PublicationNavigationTarget');

interface PublicationNavigationState {
  readonly href: string;
  readonly source: PublicationNavigationSource;
}

const publicationNavigationStates = new WeakMap<object, PublicationNavigationState>();

export type PublicationNavigationSource =
  | Readonly<{
      readonly kind: 'manifest-endpoint';
      readonly mountId: string;
      readonly endpoint: PublicationEndpointKey;
    }>
  | Readonly<{
      readonly kind: 'response-link';
      readonly rel: 'next';
      readonly responseUrl: string;
    }>;

/** An immutable URL whose Publication navigation source has been established. */
export interface PublicationNavigationTarget {
  readonly [publicationNavigationTargetBrand]: true;
}

export interface PublicationEndpointNavigationInput {
  readonly mount: ManifestMount;
  readonly transportBoundary?: PublicationTransportBoundary;
  readonly endpoint: PublicationEndpointKey;
  readonly variables: Readonly<Record<string, string>>;
  readonly query: object;
  readonly validators: ValidatorRegistry;
}

function navigationTarget(url: URL, source: PublicationNavigationSource): PublicationNavigationTarget {
  const target = Object.freeze({}) as PublicationNavigationTarget;
  publicationNavigationStates.set(target, Object.freeze({
    href: url.href,
    source: Object.freeze(source),
  }));
  return target;
}

function navigationState(target: PublicationNavigationTarget): PublicationNavigationState {
  const state = publicationNavigationStates.get(target);
  if (state === undefined) {
    throw new TypeError('Publication request requires an established navigation target.');
  }
  return state;
}

/** Establishes an initial Publication target exclusively from a selected Manifest Endpoint. */
export function createPublicationEndpointNavigationTarget(
  input: PublicationEndpointNavigationInput,
): PublicationNavigationTarget {
  const endpointSource = input.mount.endpoints[input.endpoint];
  if (typeof endpointSource === 'string') assertPublicationQueryUrlText(endpointSource);
  const endpoint = input.transportBoundary === undefined
    ? resolvePublicationEndpoint(input.mount, input.endpoint, input.variables)
    : resolvePublicationEndpoint(
        input.mount,
        input.endpoint,
        input.variables,
        input.transportBoundary,
      );
  const url = preparePublicationQuery(
    input.endpoint,
    endpoint,
    input.query,
    input.validators,
  );
  return navigationTarget(url, {
    kind: 'manifest-endpoint',
    mountId: input.mount.id,
    endpoint: input.endpoint,
  });
}

/** Establishes a continuation target exclusively from the current response's rel=next Link. */
export function createPublicationSnapshotNextNavigationTarget(
  input: PublicationSnapshotNextLinkInput,
): PublicationNavigationTarget | undefined {
  const url = publicationSnapshotNextUrl(input);
  if (url === undefined) return undefined;
  return navigationTarget(url, {
    kind: 'response-link',
    rel: 'next',
    responseUrl: input.currentUrl.href,
  });
}

/** Returns a fresh URL so callers cannot mutate the established target. */
export function publicationNavigationUrl(target: PublicationNavigationTarget): URL {
  return new URL(navigationState(target).href);
}

/** Returns the frozen business source associated with an established target. */
export function publicationNavigationSource(
  target: PublicationNavigationTarget,
): PublicationNavigationSource {
  return navigationState(target).source;
}
