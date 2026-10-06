import type { DefinitionName, ValidatorRegistry } from '../schema/index.js';
import {
  endpointContracts,
  type EndpointKey,
  type HttpOperationContract,
} from '../semantic/index.js';
import { parseProtocolQuery, type QueryContractName } from './query.js';
import { hasWellFormedUtf16 } from './utf16.js';

export type PublicationQueryEndpoint = 'directory' | 'collection' | 'snapshot' | 'node';

const utf8Encoder = new TextEncoder();

export const publicationQueryLimits = Object.freeze({
  maxRawBytes: 16 * 1024,
  maxParameters: 16,
  maxDtoProperties: 8,
  maxArrayItems: 8,
});

export type PublicationQueryOperationContract = HttpOperationContract & {
  readonly method: 'GET';
  readonly profile: 'publication';
};

export type PublicationQueryDecodeResult =
  | {
      readonly valid: true;
      readonly value: Readonly<Record<string, unknown>>;
      readonly contract: PublicationQueryOperationContract;
    }
  | {
      readonly valid: false;
      readonly status: 400;
      readonly code: 'invalid_query';
      readonly errors: readonly string[];
    };

/** Selects the authoritative Publication GET operation without duplicating query bindings. */
export function resolvePublicationQueryContract(
  endpoint: PublicationQueryEndpoint,
): PublicationQueryOperationContract {
  if (!Object.hasOwn(endpointContracts, endpoint)) {
    throw new RangeError(`Endpoint Contract Registry has no publication GET contract for ${String(endpoint)}.`);
  }
  const endpointContract = endpointContracts[endpoint as EndpointKey] as
    | (typeof endpointContracts)[EndpointKey]
    | undefined;
  const operation = endpointContract?.operations.find(
    (candidate) => candidate.method === 'GET' && candidate.profile === 'publication',
  );
  if (operation === undefined) {
    throw new RangeError(`Endpoint Contract Registry has no publication GET contract for ${endpoint}.`);
  }
  return operation as PublicationQueryOperationContract;
}

/** Strictly decodes a raw URL search component before applying its registered named $defs validator. */
export function decodePublicationQuery(
  endpoint: PublicationQueryEndpoint,
  rawSearch: string,
  validators: ValidatorRegistry,
): PublicationQueryDecodeResult {
  const contract = resolvePublicationQueryContract(endpoint);
  const parameters = parseRawSearch(rawSearch);
  if (!parameters.valid) return invalidQuery(parameters.error);

  if (contract.query === undefined) {
    return parameters.value.size === 0
      ? Object.freeze({ valid: true, value: Object.freeze({}), contract })
      : invalidQuery('This Publication endpoint does not accept a query.');
  }

  let parsed;
  try {
    parsed = parseProtocolQuery(
      contract.query as QueryContractName,
      parameters.value,
      validators,
    );
  } catch {
    // A Registry binding without a registered decoder is a deployment error, not caller input.
    throw new RangeError(`Publication query contract ${contract.query} has no registered decoder.`);
  }
  if (!parsed.valid) {
    return invalidQuery(...parsed.errors.map(sanitizeQueryError));
  }

  // parseProtocolQuery already creates fresh scalars/arrays and freezes its result.
  const structural = validators.validate(contract.query as DefinitionName, parsed.value);
  if (!structural.valid) return invalidQuery('Publication query does not satisfy its registered schema.');
  return Object.freeze({ valid: true, value: parsed.value, contract });
}

type RawSearchResult =
  | { readonly valid: true; readonly value: URLSearchParams }
  | { readonly valid: false; readonly error: string };

function parseRawSearch(rawSearch: string): RawSearchResult {
  if (typeof rawSearch !== 'string') {
    return { valid: false, error: 'Publication query must be a raw URL search string.' };
  }
  if (!hasWellFormedUtf16(rawSearch)) {
    return { valid: false, error: 'Publication query encoding is invalid.' };
  }
  const source = rawSearch.startsWith('?') ? rawSearch.slice(1) : rawSearch;
  if (source.length === 0) return { valid: true, value: new URLSearchParams() };
  if (
    source.length > publicationQueryLimits.maxRawBytes
    || utf8Encoder.encode(source).byteLength > publicationQueryLimits.maxRawBytes
  ) {
    return { valid: false, error: 'Publication query exceeds the supported byte limit.' };
  }
  if (source.includes('#')) return { valid: false, error: 'Publication query syntax is invalid.' };

  const parameters = new URLSearchParams();
  const fields = source.split('&');
  if (fields.length > publicationQueryLimits.maxParameters) {
    return { valid: false, error: 'Publication query has too many parameters.' };
  }
  for (const field of fields) {
    if (field.length === 0) return { valid: false, error: 'Publication query syntax is invalid.' };
    const separator = field.indexOf('=');
    const rawName = separator < 0 ? field : field.slice(0, separator);
    const rawValue = separator < 0 ? '' : field.slice(separator + 1);
    try {
      parameters.append(decodeFormComponent(rawName), decodeFormComponent(rawValue));
    } catch {
      return { valid: false, error: 'Publication query encoding is invalid.' };
    }
  }
  return { valid: true, value: parameters };
}

function decodeFormComponent(value: string): string {
  // decodeURIComponent rejects truncated escapes, invalid UTF-8, and lone UTF-16 surrogates.
  const decoded = decodeURIComponent(value.replace(/\+/gu, ' '));
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(decoded)) {
    throw new URIError('URL query components must not contain control characters.');
  }
  return decoded;
}

function sanitizeQueryError(error: string): string {
  if (error.startsWith('Unknown query parameter:')) return 'Unknown query parameter.';
  if (error.includes('must appear once')) return 'Query parameter must appear once.';
  if (error.includes('must not be empty')) return 'Publication query parameters must not be empty.';
  if (error.includes('safe integer range')) return 'Publication query integer is outside the safe range.';
  if (error.includes('non-negative decimal integer')) return 'Publication query integer encoding is invalid.';
  if (error.includes('true or false')) return 'Publication query boolean encoding is invalid.';
  return 'Publication query does not satisfy its registered schema.';
}

function invalidQuery(...errors: string[]): PublicationQueryDecodeResult {
  return Object.freeze({
    valid: false,
    status: 400,
    code: 'invalid_query',
    errors: Object.freeze(errors),
  });
}
