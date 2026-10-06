import {
  createValidatorRegistry,
  validateWireDocument,
  type DefinitionName,
  type ValidatorRegistry,
  type WireDocumentValidationResult,
} from '../schema/index.js';
import { endpointContracts, type EndpointKey, type HttpMethod, type HttpOperationContract } from '../semantic/index.js';
import type { PublicationQueryEndpoint } from '../shared/publication-query.js';

const validators = createValidatorRegistry();
const publicationEndpoints = new Set<EndpointKey>(['directory', 'collection', 'snapshot', 'node']);

export interface PublicationEndpointDtoValidationOptions<Issue> {
  readonly validators?: ValidatorRegistry;
  readonly validateSemantics?: (value: unknown) => { readonly valid: true; readonly issues: readonly [] } | { readonly valid: false; readonly issues: readonly Issue[] };
}

/** Validates a Publication endpoint DTO against its Registry-bound named $defs. */
export function validatePublicationEndpointDto<Value, Issue = never>(
  endpoint: EndpointKey,
  method: HttpMethod,
  kind: 'query' | 'request' | 'response',
  value: unknown,
  options: PublicationEndpointDtoValidationOptions<Issue> = {},
): WireDocumentValidationResult<Value, Issue> {
  const operation = publicationOperation(endpoint, method);
  const definition = kind === 'query' ? operation.query : kind === 'request' ? operation.request : operation.response;
  if (definition === undefined) throw new TypeError(`Publication ${kind} is not defined for ${method} ${endpoint}.`);
  if (kind === 'query' && !publicationEndpoints.has(endpoint)) throw new RangeError('Unsupported Publication endpoint.');
  return validateWireDocument(
    options.validators ?? validators,
    definition as DefinitionName,
    value,
    (candidate) => options.validateSemantics?.(candidate) ?? { valid: true, issues: [] },
  );
}

export function validatePublicationEndpointQuery<Value = unknown, Issue = never>(endpoint: PublicationQueryEndpoint, value: unknown, options?: PublicationEndpointDtoValidationOptions<Issue>) {
  return validatePublicationEndpointDto<Value, Issue>(endpoint, 'GET', 'query', value, options);
}

export function validatePublicationEndpointRequest<Value = unknown, Issue = never>(endpoint: EndpointKey, method: HttpMethod, value: unknown, options?: PublicationEndpointDtoValidationOptions<Issue>) {
  return validatePublicationEndpointDto<Value, Issue>(endpoint, method, 'request', value, options);
}

export function validatePublicationEndpointResponse<Value = unknown, Issue = never>(endpoint: EndpointKey, method: HttpMethod, value: unknown, options?: PublicationEndpointDtoValidationOptions<Issue>) {
  return validatePublicationEndpointDto<Value, Issue>(endpoint, method, 'response', value, options);
}

function publicationOperation(endpoint: EndpointKey, method: HttpMethod): HttpOperationContract {
  const contract = endpointContracts[endpoint];
  const operation = contract?.operations.find(
    (candidate) => candidate.profile === 'publication' && candidate.method === method,
  );
  if (operation === undefined) throw new RangeError(`Endpoint Contract Registry has no Publication ${method} contract for ${endpoint}.`);
  return operation;
}
