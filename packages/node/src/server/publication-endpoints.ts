import {
  getPublicationEndpointTemplateContract,
  type PublicationEndpointKey,
  type PublicationEndpointTemplateContract,
} from '../semantic/publication-endpoint-templates.js';
import { publicationRequiredEndpoints } from '../semantic/publication-endpoints.js';
import type { ManifestMount } from '../types/index.js';

export type { PublicationEndpointKey } from '../semantic/publication-endpoint-templates.js';
export type PublicationEndpointDeclaration = PublicationEndpointTemplateContract;

/**
 * Produces the server's Publication route declarations from one selected Mount.
 * The mapping neither invents conventional paths nor resolves against baseUrl.
 */
export function declarePublicationEndpoints(
  mount: ManifestMount,
): readonly PublicationEndpointDeclaration[] {
  if (!mount.profiles.includes('core') || !mount.profiles.includes('publication')) {
    throw new RangeError(`Mount ${mount.id} does not support core + publication.`);
  }

  return Object.freeze(publicationRequiredEndpoints.map((endpoint) => {
    const template = mount.endpoints[endpoint];
    if (typeof template !== 'string') {
      throw new RangeError(`Selected Mount ${mount.id} does not declare endpoint ${endpoint}.`);
    }

    return getPublicationEndpointTemplateContract(endpoint, template);
  }));
}
