import {
  validateWireDocument,
  type DefinitionName,
  type IJsonParseLimits,
  type SemanticValidationResultLike,
  type ValidatorRegistry,
  type WireDocumentValidationResult,
} from '../schema/index.js';
import { parseIJson as parseCoreIJson } from '../schema/json.js';

export type ServerWireDocumentValidationResult<Value, Issue> =
  | { readonly valid: false; readonly stage: 'parse'; readonly error: Error }
  | WireDocumentValidationResult<Value, Issue>;

/**
 * Parses untrusted server input with the shared I-JSON parser.
 * That parser rejects prohibited member names in its single budget scan.
 * This boundary only removes echoed names from that SyntaxError.
 */
export function parseIJson(source: string, limits: IJsonParseLimits = {}): unknown {
  try {
    return parseCoreIJson(source, limits);
  } catch (error) {
    throw sanitizeProhibitedMemberError(error);
  }
}

/** Parses and validates an inbound JSON document before request dispatch. */
export function validateServerWireDocument<Value, Issue>(
  validators: ValidatorRegistry,
  definition: DefinitionName,
  source: string,
  validateSemantics: (value: Value) => SemanticValidationResultLike<Issue>,
  limits: IJsonParseLimits = {},
): ServerWireDocumentValidationResult<Value, Issue> {
  let value: unknown;
  try {
    value = parseIJson(source, limits);
  } catch (error) {
    return {
      valid: false,
      stage: 'parse',
      error: error instanceof Error ? error : new TypeError(String(error)),
    };
  }
  return validateWireDocument(validators, definition, value, validateSemantics);
}

function sanitizeProhibitedMemberError(error: unknown): unknown {
  if (
    error instanceof SyntaxError &&
    /I-JSON member name is not allowed/u.test(error.message)
  ) {
    return new SyntaxError('I-JSON member name is not allowed.');
  }
  return error;
}
