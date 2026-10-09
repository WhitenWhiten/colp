import { createValidatorRegistry } from '../schema/index.js';
import {
  assertPublicationEndpointRequestUrl,
  assertPublicationEndpointKey,
  expandPublicationEndpointTemplate,
  type PublicationEndpointKey,
} from '../semantic/publication-endpoint-templates.js';
import type { ManifestMount } from '../types/index.js';
import {
  assertPublicationTransportBoundary,
  createPublicationTransportBoundary,
  publicationTransportRoute,
  publicationTransportProtocol,
  type PublicationTransportBoundary,
} from './publication-transport-boundary.js';

export type { PublicationEndpointKey } from '../semantic/publication-endpoint-templates.js';
const validators = createValidatorRegistry();

/**
 * Expands one Publication URL exclusively from the selected Mount declaration.
 * `baseUrl` is consulted only as a transport-security boundary and is never a
 * resolution base or a source of conventional object paths.
 */
export function resolvePublicationEndpoint(
  mount: ManifestMount,
  endpoint: PublicationEndpointKey,
  variables: Readonly<Record<string, string>>,
  boundary: PublicationTransportBoundary = createPublicationTransportBoundary(mount),
): URL {
  assertPublicationTransportBoundary(boundary, mount);
  const route = publicationTransportRoute(boundary);
  return resolvePublicationRoute(route, boundary, endpoint, variables);
}

interface PublicationRouteDeclaration {
  readonly id: string;
  readonly profiles: readonly string[];
  readonly endpoints: ManifestMount['endpoints'];
}

function resolvePublicationRoute(
  mount: PublicationRouteDeclaration,
  boundary: PublicationTransportBoundary,
  endpoint: PublicationEndpointKey,
  variables: Readonly<Record<string, string>>,
): URL {
  if (!mount.profiles.includes('core') || !mount.profiles.includes('publication')) {
    throw new RangeError(`Mount ${mount.id} does not support core + publication.`);
  }
  assertPublicationEndpointKey(endpoint);
  const template = mount.endpoints[endpoint];
  if (typeof template !== 'string') {
    throw new RangeError(`Selected Mount ${mount.id} does not declare endpoint ${endpoint}.`);
  }

  const url = expandPublicationEndpointTemplate(endpoint, template, variables, validators);
  assertPublicationEndpointRequestUrl(url);

  if (publicationTransportProtocol(boundary) === 'https:' && url.protocol === 'http:') {
    throw new TypeError('Publication endpoint URL violates the transport policy.');
  }
  return url;
}
