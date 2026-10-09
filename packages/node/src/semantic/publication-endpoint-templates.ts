import { parseTemplate } from 'url-template';

import {
  getLevelOneUriTemplateVariables,
  type ValidatorRegistry,
} from '../schema/index.js';
import {
  endpointContracts,
  type EndpointKey,
  type HttpOperationContract,
  validateEndpointVariables,
} from './endpoint-contracts.js';
import { publicationRequiredEndpoints } from './publication-endpoints.js';

export type PublicationEndpointKey = (typeof publicationRequiredEndpoints)[number];

export interface PublicationEndpointTemplateContract {
  readonly endpoint: PublicationEndpointKey;
  readonly template: string;
  readonly variables: readonly `${string}Id`[];
  readonly operation: HttpOperationContract & {
    readonly method: 'GET';
    readonly profile: 'publication';
  };
}

/**
 * Manifest endpoint templates are small routing declarations, not payloads.
 * Keep malformed or hostile manifests from making URI-template parsing and
 * URL normalization allocate proportional to the client's full response cap.
 */
export const MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES = 65_536;

const publicationEndpointKeys = new Set<EndpointKey>(publicationRequiredEndpoints);
const absoluteHttpTemplate = /^(https?):\/\/([^/?#]*)(?:[/?#]|$)/iu;
const exactLoopbackHttpAuthority = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu;
const levelOneExpression = /\{([^{}]+)\}/gu;

export function assertPublicationEndpointKey(
  endpoint: unknown,
): asserts endpoint is PublicationEndpointKey {
  if (!publicationEndpointKeys.has(endpoint as EndpointKey)) {
    throw new RangeError(`Endpoint ${String(endpoint)} is not a Publication endpoint.`);
  }
}

/**
 * Binds a declared Publication template to its authoritative Endpoint Contract
 * Registry entry. URI-template parsing is shared with expansion through the
 * package's single RFC 6570 implementation.
 */
export function getPublicationEndpointTemplateContract(
  endpoint: PublicationEndpointKey,
  template: string,
): PublicationEndpointTemplateContract {
  assertPublicationEndpointKey(endpoint);
  assertPublicationEndpointTemplateSource(template);

  const contract = endpointContracts[endpoint];
  const variables = getLevelOneUriTemplateVariables(template);
  if (
    variables === null
    || !hasSafeLevelOneSourceText(template)
    || !hasSafePublicationEndpointAuthority(template)
    || variables.join('\u0000') !== [...contract.variables].sort().join('\u0000')
  ) {
    throw new TypeError(
      `Publication endpoint ${endpoint} is not an absolute Level 1 template with its registered variables.`,
    );
  }

  const operation = contract.operations.find(
    (candidate) => candidate.method === 'GET' && candidate.profile === 'publication',
  );
  if (operation === undefined) {
    throw new RangeError(`Endpoint Contract Registry has no publication GET contract for ${endpoint}.`);
  }

  return Object.freeze({
    endpoint,
    template,
    variables: contract.variables,
    operation,
  }) as PublicationEndpointTemplateContract;
}

function assertPublicationEndpointTemplateSource(template: string): void {
  if (typeof template !== 'string' || template.length > MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES
    || new TextEncoder().encode(template).byteLength > MAX_PUBLICATION_ENDPOINT_TEMPLATE_BYTES) {
    throw new TypeError('Publication endpoint template exceeds its byte budget.');
  }
}

/** Rejects URI components and repeated variables that generic template parsing normalizes away. */
function hasSafeLevelOneSourceText(template: string): boolean {
  if (template.includes('#')) return false;
  const variables = [...template.matchAll(levelOneExpression)].flatMap((match) =>
    (match[1] ?? '').split(','),
  );
  return new Set(variables).size === variables.length;
}

/**
 * Applies the Publication transport rule to the declaration before URL
 * normalization can canonicalize alternative numeric IPv4 spellings into
 * 127.0.0.1. HTTPS authorities remain unrestricted apart from the shared
 * absolute-Level-1 and user-information checks.
 */
function hasSafePublicationEndpointAuthority(template: string): boolean {
  const match = absoluteHttpTemplate.exec(template);
  if (match === null) return false;
  const scheme = match[1]?.toLowerCase();
  const authority = match[2];
  if (authority === undefined || authority.includes('{') || authority.includes('}')) return false;
  if (scheme === 'https') return true;
  return exactLoopbackHttpAuthority.test(authority);
}

/** Validates the concrete URL immediately before Publication request use. */
export function assertPublicationEndpointRequestUrl(url: URL): void {
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw invalidPublicationEndpointUrl();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidPublicationEndpointUrl();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback) {
    throw invalidPublicationEndpointUrl();
  }
}

function invalidPublicationEndpointUrl(): TypeError {
  return new TypeError('Publication endpoint URL violates the transport policy.');
}

/** Validates exact Registry bindings and expands one valid Publication template. */
export function expandPublicationEndpointTemplate(
  endpoint: PublicationEndpointKey,
  template: string,
  values: Readonly<Record<string, string>>,
  validators: ValidatorRegistry,
): URL {
  getPublicationEndpointTemplateContract(endpoint, template);
  const variableValidation = validateEndpointVariables(endpoint, values, validators);
  if (!variableValidation.valid) {
    throw new TypeError(variableValidation.errors.join(' '));
  }

  const url = new URL(parseTemplate(template).expand(variableValidation.value));
  assertPublicationEndpointRequestUrl(url);
  return url;
}
