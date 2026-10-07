import {
  Ajv2020,
  type ErrorObject,
  type Options as AjvOptions,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import addFormatsImport, { type FormatsPlugin } from 'ajv-formats';
import { parseTemplate } from 'url-template';

import { isRfc3339DateTime } from '../shared/date-time.js';
import schema from './generated/v0.1/generated.js';
import schemaV02 from './generated/v0.2/generated.js';
import { parseIJson } from './json.js';
import type { IJsonParseLimits } from './json.js';
import { isRfc3986Uri } from './uri.js';

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

deepFreeze(schema);
deepFreeze(schemaV02);

export * from './json.js';
export * from './extensions.js';
export { isBookmarkUrl, isHttpUrl, preserveBookmarkUrl } from './uri.js';
export { formatCanonicalDateTime, isRfc3339DateTime } from '../shared/date-time.js';

export type DefinitionName = keyof typeof schema.$defs | keyof typeof schemaV02.$defs;

export interface ValidatorRegistry {
  readonly definitionNames: readonly DefinitionName[];
  get(name: DefinitionName): ValidateFunction;
  validate(name: DefinitionName, value: unknown): ValidationResult;
}

export type ValidationResult =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly ErrorObject[] };

export type SemanticValidationResultLike<Issue> =
  | { readonly valid: true; readonly issues: readonly [] }
  | { readonly valid: false; readonly issues: readonly Issue[] };

export type WireDocumentValidationResult<Value, Issue> =
  | { readonly valid: true; readonly value: Value }
  | { readonly valid: false; readonly stage: 'structural'; readonly errors: readonly ErrorObject[] }
  | { readonly valid: false; readonly stage: 'semantic'; readonly issues: readonly Issue[] };

export type WireJsonDocumentValidationResult<Value, Issue> =
  | { readonly valid: false; readonly stage: 'parse'; readonly error: Error }
  | WireDocumentValidationResult<Value, Issue>;

const uriTemplateExpression = /\{([^{}]+)\}/gu;
const uriTemplateVariable = /^(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})(?:(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})|\.(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2}))*$/u;
const uriTemplateLiteral = /^(?:[!#$&'()*+,\-./0-9:;=?@A-Z[\]_a-z~]|%[0-9A-Fa-f]{2})*$/u;
const addFormats = addFormatsImport as unknown as FormatsPlugin;
const trustedValidatorRegistries = new WeakSet<ValidatorRegistry>();
let canonicalValidators: ReadonlyMap<DefinitionName, ValidateFunction> | undefined;

/** The protocol bound shared by object-valued `uniqueItems` arrays. */
export const MAX_STRUCTURED_UNIQUE_ITEMS = 512;
const structuredUniqueArrayKeys = new Set(['creators', 'sourceRefs', 'hubs']);

/** Format-level assertion for RFC 6570 Level 1 templates. */
export function isLevelOneUriTemplate(value: string): boolean {
  const variables = new Set<string>();
  const literals = value.replace(uriTemplateExpression, (_match, expression: string) => {
    const expressionVariables = expression.split(',');
    if (!expressionVariables.every((variable) => uriTemplateVariable.test(variable))) {
      return '"';
    }
    expressionVariables.forEach((variable) => variables.add(variable));
    return '';
  });

  if (literals.includes('{') || literals.includes('}') || !uriTemplateLiteral.test(literals)) {
    return false;
  }

  try {
    const template = parseTemplate(value);
    const context = Object.fromEntries([...variables].map((variable) => [variable, 'value']));
    const expanded = new URL(template.expand(context));
    const loopback =
      expanded.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(expanded.hostname.toLowerCase());
    return (
      expanded.username === '' &&
      expanded.password === '' &&
      [...expanded.href].filter((character) => character === '#').length <= 1 &&
      (expanded.protocol === 'https:' || loopback)
    );
  } catch {
    return false;
  }
}

export function getLevelOneUriTemplateVariables(value: string): readonly string[] | null {
  if (!isLevelOneUriTemplate(value)) {
    return null;
  }
  const variables = [...value.matchAll(uriTemplateExpression)].flatMap((match) =>
    (match[1] ?? '').split(','),
  );
  return Object.freeze([...new Set(variables)].sort());
}

export function createAjv(options: AjvOptions = {}): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    // The canonical schema applies type-specific keywords inside composed branches.
    strictRequired: false,
    strictTypes: false,
    ...options,
    validateFormats: true,
  });
  installFormatAssertions(ajv);
  // Tool schemas use `x-mcp-header` as an MCP contract annotation. It is
  // validated separately by the MCP header scanner and must be inert during
  // JSON Schema input validation.
  ajv.addKeyword('x-mcp-header');
  return ajv;
}

function installFormatAssertions(ajv: Ajv2020): void {
  if (ajv.opts.validateFormats !== true) {
    throw new TypeError('Collection Protocol schema validation requires format assertions.');
  }
  addFormats(ajv, { keywords: false });
  ajv.addFormat('date-time', { type: 'string', validate: isRfc3339DateTime });
  ajv.addFormat('uri', { type: 'string', validate: isRfc3986Uri });
  ajv.addFormat('uri-template', { type: 'string', validate: isLevelOneUriTemplate });
}

function compileSchemaValidators(ajv: Ajv2020): Map<DefinitionName, ValidateFunction> {
  const schemaId = schema.$id;
  const schemaV02Id = schemaV02.$id;
  const definitionNames = Object.freeze([
    ...Object.keys(schema.$defs),
    ...Object.keys(schemaV02.$defs),
  ] as DefinitionName[]);
  const validators = new Map<DefinitionName, ValidateFunction>();

  installFormatAssertions(ajv);
  // A supplied Ajv may already hold a schema compiled against weaker formats.
  // Replace it, then eagerly compile every public definition before the caller
  // can mutate that Ajv again.
  ajv.removeSchema(schemaId);
  ajv.removeSchema(schemaV02Id);
  ajv.addSchema(schema, schemaId);
  ajv.addSchema(schemaV02, schemaV02Id);

  for (const name of definitionNames) {
    const owner = name in schemaV02.$defs ? schemaV02Id : schemaId;
    validators.set(name, ajv.compile({ $ref: `${owner}#/$defs/${name}` }));
  }
  return validators;
}

function getCanonicalValidators(): ReadonlyMap<DefinitionName, ValidateFunction> {
  if (canonicalValidators === undefined) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictRequired: false,
      strictTypes: false,
      validateFormats: true,
    });
    canonicalValidators = compileSchemaValidators(ajv);
  }
  return canonicalValidators;
}

export function createValidatorRegistry(ajv?: Ajv2020): ValidatorRegistry {
  // Compile a caller-supplied instance after reinstalling assertions. This
  // verifies compatibility eagerly, while the inaccessible canonical map
  // remains the final trust root even for subclassed or code-processed Ajv.
  if (ajv !== undefined) {
    compileSchemaValidators(ajv);
  }
  const validators = getCanonicalValidators();
  const definitionNames = Object.freeze([
    ...Object.keys(schema.$defs),
    ...Object.keys(schemaV02.$defs),
  ] as DefinitionName[]);

  function get(name: DefinitionName): ValidateFunction {
    const existing = validators.get(name);
    if (existing !== undefined) {
      return existing;
    }

    if (!(name in schema.$defs) && !(name in schemaV02.$defs)) {
      throw new RangeError(`Unknown Collection Protocol schema definition: ${name}`);
    }

    throw new Error(`Collection Protocol validator was not compiled: ${name}`);
  }

  const registry: ValidatorRegistry = Object.freeze({
    definitionNames,
    get,
    validate(name: DefinitionName, value: unknown): ValidationResult {
      const bounded = findStructuredUniqueArrayLimit(value);
      if (bounded !== undefined) return { valid: false, errors: [bounded] };
      const validator = get(name);
      if (validator(value)) {
        return { valid: true, errors: [] };
      }
      return { valid: false, errors: Object.freeze([...(validator.errors ?? [])]) };
    },
  });
  trustedValidatorRegistries.add(registry);
  return registry;
}

function validateWithCanonicalRegistry(
  validators: ValidatorRegistry,
  definition: DefinitionName,
  value: unknown,
): ValidationResult {
  const bounded = findStructuredUniqueArrayLimit(value);
  if (bounded !== undefined) return { valid: false, errors: [bounded] };
  const validator = getCanonicalValidators().get(definition);
  if (validator === undefined) {
    throw new RangeError(`Unknown Collection Protocol schema definition: ${definition}`);
  }
  if (trustedValidatorRegistries.has(validators)) {
    return normalizeStructuralResult(validators.validate(definition, value));
  }

  const canonicalResult = (): ValidationResult => validator(value)
    ? { valid: true, errors: [] }
    : { valid: false, errors: Object.freeze([...(validator.errors ?? [])]) };
  const before = canonicalResult();
  if (!before.valid) return before;

  const supplied = normalizeStructuralResult(validators.validate(definition, value));
  if (!supplied.valid) return supplied;

  // A structurally compatible wrapper is useful for instrumentation, but it is
  // untrusted code and may mutate the candidate while validating it.
  return canonicalResult();
}

/**
 * Checks the small set of object-valued unique arrays before Ajv sees them.
 * Ajv's `allErrors` mode can continue to its deep `uniqueItems` comparison
 * after reporting `maxItems`, so relying on the schema keyword alone still
 * permits quadratic work for an oversized input. The parser already rejects
 * cycles and accessors on wire data; this traversal is deliberately bounded
 * to the protocol's named structured unique arrays and visits each container
 * once.
 */
function findStructuredUniqueArrayLimit(value: unknown): ErrorObject | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const seen = new WeakSet<object>();
  const stack: Array<{ readonly value: object; readonly path: string }> = [{
    value: value as object,
    path: '',
  }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
        if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== null
          && typeof descriptor.value === 'object') {
          stack.push({ value: descriptor.value, path: `${current.path}/${index}` });
        }
      }
      continue;
    }
    for (const key of Object.keys(current.value)) {
      // Extension payloads are intentionally opaque and may use these names
      // without inheriting the core schema's unique-array contract.
      if (key === 'extensions') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const child = descriptor.value;
      const childPath = `${current.path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (structuredUniqueArrayKeys.has(key) && Array.isArray(child)
        && child.length > MAX_STRUCTURED_UNIQUE_ITEMS) {
        return {
          instancePath: childPath,
          schemaPath: `#/properties/${key}/maxItems`,
          keyword: 'maxItems',
          params: { limit: MAX_STRUCTURED_UNIQUE_ITEMS },
          message: `must NOT have more than ${MAX_STRUCTURED_UNIQUE_ITEMS} items`,
        };
      }
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, path: childPath });
      }
    }
  }
  return undefined;
}

function normalizeStructuralResult(candidate: unknown): ValidationResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError('Schema validator must return a validation result object.');
  }
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  const keys = Reflect.ownKeys(candidate);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.length !== 2
    || !keys.includes('valid')
    || !keys.includes('errors')
    || keys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError('Schema validation result must contain only valid and errors.');
  }
  const validDescriptor = Object.getOwnPropertyDescriptor(candidate, 'valid');
  const errorsDescriptor = Object.getOwnPropertyDescriptor(candidate, 'errors');
  if (
    validDescriptor === undefined
    || errorsDescriptor === undefined
    || !validDescriptor.enumerable
    || !errorsDescriptor.enumerable
    || !('value' in validDescriptor)
    || !('value' in errorsDescriptor)
    || typeof validDescriptor.value !== 'boolean'
    || !Array.isArray(errorsDescriptor.value)
  ) {
    throw new TypeError('Schema validation result must contain a boolean valid and an errors array.');
  }
  const valid = validDescriptor.value;
  const errors = Object.freeze([...errorsDescriptor.value] as ErrorObject[]);
  if (valid === (errors.length !== 0)) {
    throw new TypeError('Schema validation result valid flag contradicts its errors.');
  }
  return valid
    ? Object.freeze({ valid: true, errors: [] as const })
    : Object.freeze({ valid: false, errors });
}

/** Runs semantic validation only after the wire value satisfies its JSON Schema definition. */
export function validateWireDocument<Value, Issue>(
  validators: ValidatorRegistry,
  definition: DefinitionName,
  value: unknown,
  validateSemantics: (value: Value) => SemanticValidationResultLike<Issue>,
): WireDocumentValidationResult<Value, Issue> {
  const structural = validateWithCanonicalRegistry(validators, definition, value);
  if (!structural.valid) {
    return { valid: false, stage: 'structural', errors: structural.errors };
  }

  const semantic = validateSemantics(value as Value);
  if (!semantic.valid) {
    return { valid: false, stage: 'semantic', issues: semantic.issues };
  }
  return { valid: true, value: value as Value };
}

/** Parses I-JSON, then runs schema/format and semantic validation exactly once. */
export function validateWireJsonDocument<Value, Issue>(
  validators: ValidatorRegistry,
  definition: DefinitionName,
  source: string,
  validateSemantics: (value: Value) => SemanticValidationResultLike<Issue>,
  limits: IJsonParseLimits = {},
): WireJsonDocumentValidationResult<Value, Issue> {
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

export const collectionProtocolSchema = schema;
export const collectionProtocolSchemaV02 = schemaV02;
export const collectionProtocolSchemas = Object.freeze({ '0.1': schema, '0.2': schemaV02 });
