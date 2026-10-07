import { isProxy } from 'node:util/types';

/** JSON value emitted by the Publication public-projection boundary. */
export type PublicationPublicValue =
  | null
  | boolean
  | number
  | string
  | readonly PublicationPublicValue[]
  | { readonly [key: string]: PublicationPublicValue };

export interface PublicationPublicProjectionLimits {
  /** Maximum nesting below the root. Defaults to 64. */
  readonly maxDepth?: number;
  /** Maximum number of visited JSON values. Defaults to 100_000. */
  readonly maxNodes?: number;
}

export interface PublicationPublicProjectionOptions {
  /** Exact HTTPS extension namespaces audited as safe for public output. */
  readonly publicExtensionNamespaces: readonly string[];
  readonly limits?: PublicationPublicProjectionLimits;
}

/**
 * Optional wire-builder options for outbound public projection.
 *
 * Call sites that omit `publicExtensionNamespaces` receive fail-closed
 * `[]`: every extension is stripped unless the adapter explicitly allowlists
 * audited HTTPS namespaces. Projection failures throw
 * {@link PublicationPublicProjectionError} and must not be swallowed.
 */
export interface PublicationPublicWireOptions {
  /**
   * Exact HTTPS extension namespaces audited as safe for public outbound wire.
   * Defaults to `[]` (fail-closed) when omitted.
   */
  readonly publicExtensionNamespaces?: readonly string[];
  readonly limits?: PublicationPublicProjectionLimits;
}

export type PublicationPublicProjectionErrorCode =
  | 'invalid_policy'
  | 'malformed_input'
  | 'projection_limit_exceeded';

/** Stable, non-reflective error raised when a public projection cannot be made safely. */
export class PublicationPublicProjectionError extends TypeError {
  readonly code: PublicationPublicProjectionErrorCode;

  constructor(code: PublicationPublicProjectionErrorCode) {
    super(code === 'invalid_policy'
      ? 'Publication public projection policy is invalid.'
      : code === 'projection_limit_exceeded'
        ? 'Publication public projection limits were exceeded.'
        : 'Publication public projection input is malformed.');
    this.name = 'PublicationPublicProjectionError';
    this.code = code;
  }
}

/**
 * Resolve builder/wire options into a full projection policy.
 *
 * Missing `publicExtensionNamespaces` becomes `[]` (fail-closed). Unexpected
 * shapes, accessors, or unknown keys raise `invalid_policy`.
 */
export function resolvePublicationPublicProjectionOptions(
  options?: PublicationPublicWireOptions,
): PublicationPublicProjectionOptions {
  if (options === undefined) {
    return { publicExtensionNamespaces: [] };
  }
  if (!isPlainObject(options)) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => typeof key === 'symbol'
    || (key !== 'publicExtensionNamespaces' && key !== 'limits'))) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }

  const namespacesValue = readOptionalPolicyDataProperty(options, 'publicExtensionNamespaces');
  const limitsValue = readOptionalPolicyDataProperty(options, 'limits');
  const resolved: {
    publicExtensionNamespaces: readonly string[];
    limits?: PublicationPublicProjectionLimits;
  } = {
    publicExtensionNamespaces: namespacesValue === undefined ? [] : namespacesValue as readonly string[],
  };
  if (limitsValue !== undefined) {
    resolved.limits = limitsValue as PublicationPublicProjectionLimits;
  }
  return resolved;
}

/**
 * Project a value for public outbound wire with fail-closed default options.
 *
 * Equivalent to
 * `projectPublicationPublicValue(input, resolvePublicationPublicProjectionOptions(options))`
 * followed by {@link materializePublicationPublicWire}. Anonymous/public
 * builders call this before final serialization so adapters cannot skip the
 * boundary. Projection failures throw {@link PublicationPublicProjectionError}.
 */
export function projectPublicationPublicWire(
  input: unknown,
  options?: PublicationPublicWireOptions,
): PublicationPublicValue {
  return materializePublicationPublicWire(
    projectPublicationPublicValue(input, resolvePublicationPublicProjectionOptions(options)),
  );
}

/**
 * Convert a projected public value into ordinary, deeply frozen JSON objects
 * for adapter-facing wire emission.
 *
 * Projection builds null-prototype maps during redaction; materialization
 * restores ordinary prototypes via a JSON round-trip without reintroducing
 * aliases to the pre-projection input.
 */
export function materializePublicationPublicWire(
  projected: PublicationPublicValue,
): PublicationPublicValue {
  const materialized: unknown = JSON.parse(JSON.stringify(projected));
  return freezeJsonValue(materialized);
}

function freezeJsonValue(value: unknown, seen = new WeakSet<object>()): PublicationPublicValue {
  if (value === null || typeof value !== 'object') {
    return value as PublicationPublicValue;
  }
  if (seen.has(value)) return value as PublicationPublicValue;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = freezeJsonValue(value[index], seen);
    }
    return Object.freeze(value) as PublicationPublicValue;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const record = value as Record<string, unknown>;
    record[key] = freezeJsonValue(record[key], seen);
  }
  return Object.freeze(value) as PublicationPublicValue;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 100_000;
const forbiddenObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);
/**
 * Exact secret field names after {@link normalizeFieldKey}.
 * Only names not already matched by the suffix rules in {@link isSecretField}.
 */
const secretKeys = new Set([
  'accesskeys',
  'apikeys',
  'authorization',
  'cookies',
  'pwd',
  'secretkeys',
  'secrets',
  'session',
  'signingkey',
  'tokens',
]);
const localPathKeys = new Set([
  'absolutepath',
  'filepath',
  'filesystempath',
  'localpath',
  'nativepath',
]);
const crawledBodyKeys = new Set([
  'crawlcontent',
  'crawledbody',
  'crawledcontent',
  'extractedbody',
  'extractedcontent',
  'fetchedbody',
  'rawbody',
  'responsebody',
]);
/**
 * Canonical Annotation `type` values from the Collection Protocol schema.
 * Used for semantic recognition outside the standard `annotations` carrier.
 */
const annotationTypeValues = new Set([
  'note',
  'summary',
  'tldr',
  'highlight',
  'reading_state',
  'rating',
  'custom',
]);
/**
 * Node / collection `kind` values that must never be treated as annotations
 * merely because they also carry `visibility`.
 */
const nonAnnotationKindValues = new Set([
  'alias',
  'bookmark',
  'bookmarks',
  'folder',
  'knowledge_collection',
  'mixed',
  'reading_path',
  'root',
  'separator',
]);
/** Content-bearing fields that appear on annotation-shaped note objects. */
const annotationContentKeys = ['value', 'text', 'body'] as const;

/**
 * Normalize a JSON field name for secret/path/policy matching.
 * Lowercases and strips `_`, `-`, and whitespace so `api_key`, `api-key`, and
 * `apiKey` all collapse to `apikey`.
 */
function normalizeFieldKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/gu, '');
}

interface ProjectionState {
  readonly allowedExtensions: ReadonlySet<string>;
  readonly ancestors: WeakSet<object>;
  readonly maxDepth: number;
  readonly maxNodes: number;
  visited: number;
}

interface ProjectionContext {
  readonly parentKey?: string;
  readonly inConflict: boolean;
  readonly inPrincipal: boolean;
  readonly inCrawl: boolean;
}

const rootContext: ProjectionContext = {
  inConflict: false,
  inPrincipal: false,
  inCrawl: false,
};

/**
 * Creates the final JSON value for a Publication response.
 *
 * The boundary rejects non-data objects, accessors, symbols, cycles, sparse
 * arrays, unsafe numbers, and excessive nesting. The result shares no mutable
 * object with the input and is deeply frozen.
 *
 * `options.publicExtensionNamespaces` is required here (no silent default).
 * Outbound builders should use {@link projectPublicationPublicWire} or
 * {@link resolvePublicationPublicProjectionOptions}, which default the
 * allowlist to `[]` (fail-closed).
 */
export function projectPublicationPublicValue(
  input: unknown,
  options: PublicationPublicProjectionOptions,
): PublicationPublicValue {
  try {
    const state = createState(options);
    return projectValue(input, state, 0, rootContext);
  } catch (error) {
    if (error instanceof PublicationPublicProjectionError) throw error;
    throw new PublicationPublicProjectionError('malformed_input');
  }
}

function createState(options: PublicationPublicProjectionOptions): ProjectionState {
  if (!isPlainObject(options)) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  const namespaces = readPolicyDataProperty(options, 'publicExtensionNamespaces');
  if (!Array.isArray(namespaces) || isProxy(namespaces)) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  const limitsValue = readOptionalPolicyDataProperty(options, 'limits');
  if (limitsValue !== undefined && !isPlainObject(limitsValue)) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  const maxDepth = readLimit(
    limitsValue === undefined ? undefined : readOptionalPolicyDataProperty(limitsValue, 'maxDepth'),
    DEFAULT_MAX_DEPTH,
  );
  const maxNodes = readLimit(
    limitsValue === undefined ? undefined : readOptionalPolicyDataProperty(limitsValue, 'maxNodes'),
    DEFAULT_MAX_NODES,
  );
  const allowedExtensions = new Set<string>();
  if (Reflect.ownKeys(namespaces).some((key) => typeof key === 'symbol'
    || (key !== 'length' && !isArrayIndex(key)))) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  for (let index = 0; index < namespaces.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(namespaces, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new PublicationPublicProjectionError('invalid_policy');
    }
    const namespace = descriptor.value;
    if (typeof namespace !== 'string' || !isHttpsNamespace(namespace)) {
      throw new PublicationPublicProjectionError('invalid_policy');
    }
    allowedExtensions.add(namespace);
  }
  return {
    allowedExtensions,
    ancestors: new WeakSet<object>(),
    maxDepth,
    maxNodes,
    visited: 0,
  };
}

function readPolicyDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  return descriptor.value;
}

function readOptionalPolicyDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  return descriptor.value;
}

function readLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new PublicationPublicProjectionError('invalid_policy');
  }
  return value;
}

function isHttpsNamespace(namespace: string): boolean {
  try {
    const parsed = new URL(namespace);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
function chargeInputBudget(state: ProjectionState, amount = 1): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || state.visited > state.maxNodes - amount) {
    throw new PublicationPublicProjectionError('projection_limit_exceeded');
  }
  state.visited += amount;
}
function projectValue(
  value: unknown,
  state: ProjectionState,
  depth: number,
  context: ProjectionContext,
): PublicationPublicValue {
  chargeInputBudget(state);
  if (depth > state.maxDepth) {
    throw new PublicationPublicProjectionError('projection_limit_exceeded');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  if (state.ancestors.has(value)) throw new PublicationPublicProjectionError('malformed_input');
  state.ancestors.add(value);
  try {
    return Array.isArray(value)
      ? projectArray(value, state, depth, context)
      : projectObject(value, state, depth, context);
  } finally {
    state.ancestors.delete(value);
  }
}
function projectArray(
  value: readonly unknown[],
  state: ProjectionState,
  depth: number,
  context: ProjectionContext,
): PublicationPublicValue {
  const keys = Reflect.ownKeys(value);
  chargeInputBudget(state, Math.max(0, value.length - keys.filter((key) => isArrayIndex(key)).length));
  if (keys.some((key) => typeof key === 'symbol' || (key !== 'length' && !isArrayIndex(key)))) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  const output: PublicationPublicValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    if (context.parentKey === 'annotations') {
      // Standard annotations: retain public/unlisted; drop private/protected.
      if (isPrivateAnnotation(descriptor.value)) { chargeInputBudget(state); continue; }
    } else if (isNonPublicAnnotationObject(descriptor.value)) {
      // Filter annotation-shaped objects nested under other carriers.
      chargeInputBudget(state); continue;
    }
    if (context.parentKey === 'attachments' && !isExplicitlyPublicAttachment(descriptor.value)) { chargeInputBudget(state); continue; }
    output.push(projectValue(descriptor.value, state, depth + 1, context));
  }
  return Object.freeze(output);
}
function isArrayIndex(key: PropertyKey): boolean {
  if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index <= 0xffff_fffe;
}
function isPrivateAnnotation(value: unknown): boolean {
  const visibility = readDataProperty(value, 'visibility');
  if (visibility !== 'public' && visibility !== 'unlisted'
    && visibility !== 'protected' && visibility !== 'private') {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  return visibility === 'private' || visibility === 'protected';
}
/**
 * True when `value` is structurally an Annotation-shaped object (not a node,
 * collection, attachment, or relation that happens to carry `visibility`).
 *
 * Recognition is intentionally multi-signal and fail-closed for known
 * non-annotation discriminators:
 * - `kind === 'annotation'` is accepted;
 * - known node/collection `kind` values are rejected;
 * - attachment shape (`rel` + `url`) and relation shape (`fromNodeId` /
 *   `toNodeId`) are rejected;
 * - node/collection structural markers (`rootNodeId`, `parentId`, `urlHash`,
 *   `targetNodeId`, `folderRole`) are rejected;
 * - otherwise, a known Annotation `type`, or a content field
 *   (`value` / `text` / `body`) together with own `visibility`, qualifies.
 *
 * Ordinary `{ visibility: 'private' }` access/policy or incomplete node
 * stubs without annotation discriminators are not treated as annotations.
 */
function looksLikeAnnotationObject(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOwnVisibility(value)) return false;

  const kind = readOptionalStringOwnDataProperty(value, 'kind');
  if (kind === 'annotation') return true;
  if (kind !== undefined && nonAnnotationKindValues.has(kind)) return false;

  if (hasOwnDataProperty(value, 'rel') && hasOwnDataProperty(value, 'url')) return false;
  if (hasOwnDataProperty(value, 'fromNodeId') || hasOwnDataProperty(value, 'toNodeId')) return false;
  if (hasOwnDataProperty(value, 'rootNodeId')
    || hasOwnDataProperty(value, 'parentId')
    || hasOwnDataProperty(value, 'urlHash')
    || hasOwnDataProperty(value, 'targetNodeId')
    || hasOwnDataProperty(value, 'folderRole')) {
    return false;
  }

  const type = readOptionalStringOwnDataProperty(value, 'type');
  if (type !== undefined && annotationTypeValues.has(type)) return true;

  for (const key of annotationContentKeys) {
    if (hasOwnDataProperty(value, key)) return true;
  }
  return false;
}

/** Private/protected annotation-shaped object under a non-`annotations` carrier. */
function isNonPublicAnnotationObject(value: unknown): boolean {
  if (!looksLikeAnnotationObject(value)) return false;
  return isPrivateAnnotation(value);
}

function hasOwnDataProperty(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return false;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  return true;
}

function readOptionalStringOwnDataProperty(value: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

function isExplicitlyPublicAttachment(value: unknown): boolean {
  if (!isPlainObject(value)) throw new PublicationPublicProjectionError('malformed_input');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'visibility');
  if (descriptor === undefined) return false;
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  const visibility = descriptor.value;
  return visibility === 'public' || visibility === 'unlisted';
}

function readDataProperty(value: unknown, key: string): unknown {
  if (!isPlainObject(value)) throw new PublicationPublicProjectionError('malformed_input');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  return descriptor.value;
}

function projectObject(
  value: object,
  state: ProjectionState,
  depth: number,
  context: ProjectionContext,
): PublicationPublicValue {
  if (!isPlainObject(value)) throw new PublicationPublicProjectionError('malformed_input');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  if (ownKeys.length > state.maxNodes) throw new PublicationPublicProjectionError('projection_limit_exceeded');
  const descriptors = Object.getOwnPropertyDescriptors(value);

  const conflictObject = context.inConflict || looksLikeConflict(descriptors);
  const output: Record<string, PublicationPublicValue> = Object.create(null) as Record<string, PublicationPublicValue>;
  for (const key of ownKeys as string[]) {
    if (forbiddenObjectKeys.has(key)) throw new PublicationPublicProjectionError('malformed_input');
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    const normalized = normalizeFieldKey(key);
    if (isCredentialContainer(normalized)) {
      // Manifest auth capabilities use boolean apiKeys/accessKeys fields;
      // they advertise support and contain no credential material.
      if (typeof descriptor.value === 'boolean') { chargeInputBudget(state); output[key] = descriptor.value; continue; }
      const hint = projectCredentialHint(descriptor.value, state);
      if (hint !== undefined) output[key] = hint;
      continue;
    }
    if (normalized === 'annotation' && hasOwnVisibility(descriptor.value) && isPrivateAnnotation(descriptor.value)) { chargeInputBudget(state); continue; }
    // Drop private/protected annotation-shaped values on any object key
    // (items/notes/sidecars/etc.), without key-name matching.
    if (normalized !== 'annotation' && isNonPublicAnnotationObject(descriptor.value)) { chargeInputBudget(state); continue; }
    if (normalized === 'attachment' && hasOwnVisibility(descriptor.value) && !isExplicitlyPublicAttachment(descriptor.value)) { chargeInputBudget(state); continue; }
    if (shouldRemoveField(key, normalized, descriptors, context, conflictObject)) { chargeInputBudget(state); continue; }
    if (key === 'extensions') {
      const projected = projectExtensions(descriptor.value, state, depth + 1);
      if (projected !== undefined) output[key] = projected;
      continue;
    }
    const childContext: ProjectionContext = {
      parentKey: key,
      inConflict: conflictObject || normalized === 'conflict' || normalized === 'conflicts',
      inPrincipal: normalized === 'principal' || normalized === 'principals',
      inCrawl: context.inCrawl || normalized.includes('crawl') || normalized.includes('fetch'),
    };
    output[key] = projectValue(descriptor.value, state, depth + 1, childContext);
  }
  return Object.freeze(output);
}

function shouldRemoveField(
  key: string,
  normalized: string,
  descriptors: PropertyDescriptorMap,
  context: ProjectionContext,
  conflictObject: boolean,
): boolean {
  if ((context.parentKey === 'sourceRefs' && normalized === 'nativeid')
    || normalized === 'profileid' || localPathKeys.has(normalized)) return true;
  if (normalized === 'principalid' || (context.inPrincipal && normalized === 'id')) return true;
  if (isSecretField(normalized)) return true;
  if ((normalized === 'key' || normalized === 'keys')
    && (hasSecretSibling(descriptors) || isSecurityContext(context.parentKey))) return true;
  if (conflictObject && (normalized === 'base' || normalized === 'server' || normalized === 'incoming' || normalized === 'value')) {
    return true;
  }
  if (crawledBodyKeys.has(normalized)) return true;
  if (normalized === 'body' && context.inCrawl) return true;
  return false;
}

function hasOwnVisibility(value: unknown): boolean {
  return isPlainObject(value) && Object.getOwnPropertyDescriptor(value, 'visibility') !== undefined;
}

function isSecurityContext(parentKey: string | undefined): boolean {
  if (parentKey === undefined) return false;
  const normalized = normalizeFieldKey(parentKey);
  return normalized === 'security' || normalized === 'auth' || normalized === 'authentication'
    || normalized === 'authorization' || normalized === 'credential' || normalized === 'credentials';
}

function hasSecretSibling(descriptors: PropertyDescriptorMap): boolean {
  return Object.keys(descriptors).some((key) => isSecretField(normalizeFieldKey(key)));
}

/**
 * @param normalized Field name already passed through {@link normalizeFieldKey}.
 * `keyHint` is the only intentional public credential-adjacent field.
 */
function isSecretField(normalized: string): boolean {
  if (normalized === 'keyhint') return false;
  return secretKeys.has(normalized)
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('passwordhash')
    || normalized.endsWith('passwd')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('secretkey')
    || normalized.endsWith('sessionkey')
    || normalized.endsWith('sessionid')
    || normalized.endsWith('cookie');
}

/**
 * @param normalized Field name already passed through {@link normalizeFieldKey}.
 */
function isCredentialContainer(normalized: string): boolean {
  return normalized === 'apikey'
    || normalized === 'apikeys'
    || normalized === 'accesskey'
    || normalized === 'accesskeys'
    || normalized === 'credential'
    || normalized === 'credentials';
}

function projectCredentialHint(value: unknown, state: ProjectionState): PublicationPublicValue | undefined {
  // Unsupported credential values still consume one input-budget unit.
  if (!isPlainObject(value)) {
    chargeInputBudget(state);
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === 'symbol' || forbiddenObjectKeys.has(key))) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  if (keys.length > state.maxNodes) throw new PublicationPublicProjectionError('projection_limit_exceeded');
  let hint: string | undefined;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    chargeInputBudget(state);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    if (key === 'keyHint') {
      if (typeof descriptor.value !== 'string') {
        throw new PublicationPublicProjectionError('malformed_input');
      }
      hint = descriptor.value;
    }
  }
  if (hint === undefined) return undefined;
  return Object.freeze(Object.assign(Object.create(null) as Record<string, PublicationPublicValue>, { keyHint: hint }));
}

function looksLikeConflict(descriptors: PropertyDescriptorMap): boolean {
  return Object.hasOwn(descriptors, 'allowedResolutions')
    && (Object.hasOwn(descriptors, 'targetId') || Object.hasOwn(descriptors, 'incomingOpId'));
}

function projectExtensions(
  value: unknown,
  state: ProjectionState,
  depth: number,
): PublicationPublicValue | undefined {
  if (!isPlainObject(value)) throw new PublicationPublicProjectionError('malformed_input');
  const keys = Reflect.ownKeys(value);
  if (keys.length > state.maxNodes) throw new PublicationPublicProjectionError('projection_limit_exceeded');
  const output: Record<string, PublicationPublicValue> = Object.create(null) as Record<string, PublicationPublicValue>;
  for (const key of keys) {
    if (typeof key === 'symbol' || forbiddenObjectKeys.has(key)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    chargeInputBudget(state);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    if (!state.allowedExtensions.has(key)) { chargeInputBudget(state); continue; }
    output[key] = projectValue(descriptor.value, state, depth, rootContext);
  }
  // Preserve an explicitly empty extension map required by wire schemas.
  return keys.length === 0 || Object.keys(output).length !== 0 ? Object.freeze(output) : undefined;
}

function isPlainObject(value: unknown): value is object & Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
