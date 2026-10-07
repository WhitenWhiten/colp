/**
 * MCP-0005: API key Tool structured results never return plaintext secrets to
 * model context. Only safe metadata plus host-owned reveal boundary remains.
 */

import { types as nodeTypes } from 'node:util';

import type { ApiKeyCreateResult, ApiKeyMetadata, HttpUrl } from '../types/generated.js';
import {
  authorizeMcpHttpUri,
  resolveMcpHttpUriPolicy,
  type McpHttpUriPolicyPort,
  type ResolvedMcpHttpUriPolicy,
} from './http-uri-policy.js';
import { snapshotMcpData } from './safe-data.js';

export class McpSecretRedactionError extends TypeError {
  readonly code = 'secret_redaction_failed' as const;

  constructor(message: string) {
    super(message);
    this.name = 'McpSecretRedactionError';
  }
}

export interface ApiKeyToolResultMetadata {
  readonly keyId: string;
  readonly name?: ApiKeyMetadata['name'];
  readonly type?: ApiKeyMetadata['type'];
  readonly scopes?: ReadonlyArray<ApiKeyMetadata['scopes'][number]>;
  readonly collections?: ReadonlyArray<ApiKeyMetadata['collections'][number]>;
  readonly createdAt?: ApiKeyMetadata['createdAt'];
  readonly expiresAt?: ApiKeyMetadata['expiresAt'];
  readonly lastUsedAt?: ApiKeyMetadata['lastUsedAt'];
  readonly lastUsedIp?: ApiKeyMetadata['lastUsedIp'];
  readonly status?: ApiKeyMetadata['status'];
  readonly secretAvailable: true;
  readonly revealUri: HttpUrl;
  readonly [field: string]: unknown;
}

/** Read-only canonical metadata accepted from an application adapter. */
export type McpCanonicalApiKeyMetadata = {
  readonly [Field in keyof ApiKeyMetadata]: ApiKeyMetadata[Field] extends readonly (infer Item)[]
    ? readonly Item[]
    : ApiKeyMetadata[Field];
};

/** Canonical application response used by apiKeyCreateResult/apiKeyRotateResult. */
export interface McpCanonicalApiKeyApplicationResult {
  readonly key: McpCanonicalApiKeyMetadata;
  readonly secret: ApiKeyCreateResult['secret'];
  readonly keyId?: never;
}

/**
 * Explicit legacy/internal application DTO. The host may remove `secret`
 * before crossing this adapter, but `keyId` and all non-secret metadata remain.
 */
export interface McpFlatApiKeyApplicationResult {
  readonly keyId: string;
  readonly secret?: string;
  readonly key?: never;
  readonly [metadata: string]: unknown;
}

/** Accepted application-side shapes; both map to one model-facing MCP DTO. */
export type McpApiKeyApplicationResult =
  | McpCanonicalApiKeyApplicationResult
  | McpFlatApiKeyApplicationResult;

/** Field names that must never appear in model-facing structured content. */
const SECRET_FIELD_NAMES = Object.freeze(new Set([
  'secret',
  'plaintextSecret',
  'plaintext',
  'apiKeySecret',
  'apiKey',
  'keySecret',
  'rawSecret',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'privateKey',
  'credential',
  'credentials',
]));

/**
 * Redacts any secret-bearing fields from an API key create/rotate application
 * result and attaches the host-owned reveal boundary.
 */
export function redactApiKeyToolResult(
  raw: McpApiKeyApplicationResult,
  options: Readonly<{ revealUri: string; uriPolicy: McpHttpUriPolicyPort }>,
): ApiKeyToolResultMetadata {
  if (typeof options !== 'object' || options === null || nodeTypes.isProxy(options)) {
    throw new McpSecretRedactionError('revealUri options must be an own-data object.');
  }
  const revealDescriptor = Object.getOwnPropertyDescriptor(options, 'revealUri');
  if (
    revealDescriptor === undefined
    || !('value' in revealDescriptor)
    || typeof revealDescriptor.value !== 'string'
    || revealDescriptor.value.length === 0
  ) {
    throw new McpSecretRedactionError('revealUri must be a non-empty string data property.');
  }
  const policy = readRequiredUriPolicy(options);
  const revealUri = authorizeRevealUri(revealDescriptor.value, policy);

  return adaptApiKeyApplicationResult(raw, revealUri);
}

/** Reads the key identity without allowing canonical/flat shape ambiguity. */
export function readApiKeyApplicationResultKeyId(raw: McpApiKeyApplicationResult): string {
  const shape = classifyApiKeyApplicationResult(raw);
  if (shape === 'canonical') {
    const key = readRequiredOwnData(raw, 'key', 'Canonical API key result');
    const secret = readRequiredOwnData(raw, 'secret', 'Canonical API key result');
    if (typeof secret !== 'string') {
      throw new McpSecretRedactionError('Canonical API key result must own a string secret.');
    }
    assertOnlyOwnDataKeys(raw, Object.freeze(['key', 'secret']), 'Canonical API key result');
    assertPlainDataObject(key, 'Canonical API key metadata');
    const entries = ownEnumerableDataEntries(key, 'Canonical API key metadata');
    if (entries.some(([name]) => SECRET_FIELD_NAMES.has(name) || isSecretLikeFieldName(name))) {
      throw new McpSecretRedactionError('Canonical API key metadata must not contain secret fields.');
    }
    return readNonEmptyOwnString(key, 'id', 'Canonical API key metadata');
  }
  ownEnumerableDataEntries(raw, 'Flat API key result');
  return readNonEmptyOwnString(raw, 'keyId', 'Flat API key result');
}

/**
 * Returns true when a structured content object still contains a forbidden
 * secret field (used by tests and gateway post-conditions).
 */
export function structuredContentContainsSecret(value: unknown): boolean {
  return containsSecretField(value, new WeakSet<object>());
}

/**
 * Deep-strips secret-bearing fields from any model-facing structured content
 * (Plan/Commit operation results, nested envelopes). API key results fail
 * closed because this generic helper has no host reveal boundary.
 */
export function redactModelFacingStructuredContent(value: unknown): unknown {
  return snapshotMcpData(stripSecretsDeep(value));
}

/**
 * Redacts Commit Tool results so create_key / rotate_key outcomes never leak
 * plaintext secrets into model context. Key-shaped results require
 * `revealUriForKey` and receive secretAvailable + revealUri.
 */
export function redactCommitStructuredContent(
  commitResult: unknown,
  options?: Readonly<{
    revealUriForKey?: (keyId: string) => string;
    uriPolicy?: McpHttpUriPolicyPort;
  }>,
): unknown {
  if (options !== undefined
    && (typeof options !== 'object' || options === null || nodeTypes.isProxy(options))) {
    throw new McpSecretRedactionError('Reveal URI options must be a non-Proxy own-data object.');
  }
  const revealUriForKey = options !== undefined
    ? readOptionalRevealBuilder(options)
    : undefined;
  const uriPolicy = revealUriForKey !== undefined
    ? readRequiredUriPolicy(options as object)
    : undefined;
  return snapshotMcpData(stripSecretsDeep(commitResult, revealUriForKey, uriPolicy));
}

function stripSecretsDeep(
  value: unknown,
  revealUriForKey?: (keyId: string) => string,
  uriPolicy?: ResolvedMcpHttpUriPolicy,
  operationTransform = false,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'object') {
    throw new McpSecretRedactionError('Structured content must contain only JSON data.');
  }
  if (Array.isArray(value)) {
    return operationTransform
      ? Object.freeze([])
      : value.map((item) => stripSecretsDeep(item, revealUriForKey, uriPolicy));
  }

  // A result may pass through this helper more than once (the durable
  // Change Plan store and the model gateway both redact). Preserve the
  // already-redacted key projection on subsequent passes.
  if (operationTransform
    && Object.getOwnPropertyDescriptor(value, 'keyId') !== undefined
    && Object.getOwnPropertyDescriptor(value, 'secretAvailable') !== undefined
    && (value as Record<string, unknown>).secretAvailable === true
    && typeof (value as Record<string, unknown>).revealUri === 'string') {
    const revealUri = revealUriForKey !== undefined && uriPolicy !== undefined
      ? buildRevealUri(revealUriForKey, readNonEmptyOwnString(value, 'keyId', 'MCP API key Tool output'), uriPolicy)
      : readNonEmptyOwnString(value, 'revealUri', 'MCP API key Tool output') as HttpUrl;
    return projectOperationKeyResult(value, revealUri);
  }

  if (isSecretBearingApiKeyResult(value)) {
    if (revealUriForKey === undefined || uriPolicy === undefined) {
      throw new McpSecretRedactionError(
        'API key Commit results require a host-owned revealUriForKey boundary.',
      );
    }
    const keyId = readApiKeyApplicationResultKeyId(value as McpApiKeyApplicationResult);
    const revealUri = buildRevealUri(revealUriForKey, keyId, uriPolicy);
    const redacted = adaptApiKeyApplicationResult(value as McpApiKeyApplicationResult, revealUri);
    return operationTransform ? projectOperationKeyResult(redacted, revealUri) : redacted;
  }

  // OperationResult.transform is an executor-owned provenance boundary. The
  // wire schema historically left it open, so arbitrary values could carry a
  // plaintext secret under a harmless-looking key (for example `value`).
  // Preserve only the explicitly recognized API-key projection above; unknown
  // transform shapes are withheld as an empty object.
  if (operationTransform) return Object.freeze({});

  const out: Record<string, unknown> = {};
  let hadSecretField = false;
  let keyId: string | undefined;

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      continue;
    }
    if (SECRET_FIELD_NAMES.has(key) || isSecretLikeFieldName(key)) {
      hadSecretField = true;
      continue;
    }
    if (key === 'keyId' && typeof descriptor.value === 'string') {
      keyId = descriptor.value;
    }
    out[key] = stripSecretsDeep(
      descriptor.value,
      revealUriForKey,
      uriPolicy,
      key === 'transform',
    );
  }

  if (hadSecretField && typeof keyId === 'string' && keyId.length > 0) {
    if (revealUriForKey === undefined || uriPolicy === undefined) {
      throw new McpSecretRedactionError(
        'API key Commit results require a host-owned revealUriForKey boundary.',
      );
    }
    out.secretAvailable = true;
    out.revealUri = buildRevealUri(revealUriForKey, keyId, uriPolicy);
  }

  return out;
}

/** Only declared key metadata may cross an executor-owned transform boundary. */
function projectOperationKeyResult(value: object, revealUri: HttpUrl): ApiKeyToolResultMetadata {
  const fields = new Set([
    'keyId', 'name', 'type', 'scopes', 'collections', 'createdAt',
    'expiresAt', 'lastUsedAt', 'lastUsedIp', 'status',
  ]);
  const projected = Object.fromEntries(
    ownEnumerableDataEntries(value, 'MCP API key Tool output').filter(([key]) => fields.has(key)),
  );
  // Preserve the stored reveal URI so idempotent replay does not consult a
  // mutable reveal builder. Arbitrary extra fields never inherit that trust.
  return validateApiKeyToolResultOutput(snapshotMcpData({
    ...projected, secretAvailable: true, revealUri,
  }));
}

function readOptionalRevealBuilder(
  options: Readonly<{ revealUriForKey?: (keyId: string) => string }>,
): ((keyId: string) => string) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'revealUriForKey');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new McpSecretRedactionError('revealUriForKey must be an own-data function when provided.');
  }
  if (typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new McpSecretRedactionError('revealUriForKey must be a function when provided.');
  }
  return descriptor.value as (keyId: string) => string;
}

function readRequiredUriPolicy(options: object): ResolvedMcpHttpUriPolicy {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'uriPolicy');
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new McpSecretRedactionError('A uriPolicy data property is required for reveal URIs.');
  }
  try {
    return resolveMcpHttpUriPolicy(descriptor.value);
  } catch {
    throw new McpSecretRedactionError('uriPolicy must be a safe own-data policy port.');
  }
}

function buildRevealUri(
  revealUriForKey: (keyId: string) => string,
  keyId: string,
  policy: ResolvedMcpHttpUriPolicy,
): HttpUrl {
  let candidate: unknown;
  try {
    candidate = Reflect.apply(revealUriForKey, undefined, [keyId]);
  } catch {
    throw new McpSecretRedactionError('revealUriForKey failed to produce a safe URI.');
  }
  return authorizeRevealUri(candidate, policy);
}

function authorizeRevealUri(candidate: unknown, policy: ResolvedMcpHttpUriPolicy): HttpUrl {
  try {
    return authorizeMcpHttpUri(candidate, 'secret_reveal', policy);
  } catch {
    throw new McpSecretRedactionError(
      'Reveal URI must be a host-authorized canonical HTTP(S) URL without userinfo or fragment.',
    );
  }
}

function redactNested(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'object') {
    throw new McpSecretRedactionError('API key Tool result must contain only JSON data.');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactNested(item));
  }
  const nested: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      continue;
    }
    if (SECRET_FIELD_NAMES.has(key) || isSecretLikeFieldName(key)) continue;
    nested[key] = redactNested(descriptor.value);
  }
  return nested;
}

function adaptApiKeyApplicationResult(
  raw: McpApiKeyApplicationResult,
  revealUri: HttpUrl,
): ApiKeyToolResultMetadata {
  const shape = classifyApiKeyApplicationResult(raw);
  const redacted: Record<string, unknown> = {};

  if (shape === 'canonical') {
    const rawKey = readRequiredOwnData(raw, 'key', 'Canonical API key result');
    const rawSecret = readRequiredOwnData(raw, 'secret', 'Canonical API key result');
    if (typeof rawSecret !== 'string') {
      throw new McpSecretRedactionError('Canonical API key result must own a string secret.');
    }
    assertOnlyOwnDataKeys(raw, Object.freeze(['key', 'secret']), 'Canonical API key result');
    assertPlainDataObject(rawKey, 'Canonical API key metadata');
    for (const [key, value] of ownEnumerableDataEntries(rawKey, 'Canonical API key metadata')) {
      if (SECRET_FIELD_NAMES.has(key) || isSecretLikeFieldName(key)) {
        throw new McpSecretRedactionError('Canonical API key metadata must not contain secret fields.');
      }
      redacted[key === 'id' ? 'keyId' : key] = redactNested(value);
    }
  } else {
    for (const [key, value] of ownEnumerableDataEntries(raw, 'Flat API key result')) {
      if (SECRET_FIELD_NAMES.has(key) || isSecretLikeFieldName(key)) continue;
      redacted[key] = redactNested(value);
    }
  }

  if (typeof redacted.keyId !== 'string' || redacted.keyId.length === 0) {
    throw new McpSecretRedactionError('API key Tool result must include a non-empty key id.');
  }
  redacted.secretAvailable = true;
  redacted.revealUri = revealUri;

  // This is the local runtime output validator until the dedicated generated
  // MCP output schema is introduced. It validates the only model-visible shape.
  return validateApiKeyToolResultOutput(snapshotMcpData(redacted));
}

function validateApiKeyToolResultOutput(value: unknown): ApiKeyToolResultMetadata {
  assertPlainDataObject(value, 'MCP API key Tool output');
  if (readNonEmptyOwnString(value, 'keyId', 'MCP API key Tool output').length === 0) {
    throw new McpSecretRedactionError('MCP API key Tool output keyId is invalid.');
  }
  if (readRequiredOwnData(value, 'secretAvailable', 'MCP API key Tool output') !== true) {
    throw new McpSecretRedactionError('MCP API key Tool output must mark secretAvailable true.');
  }
  readNonEmptyOwnString(value, 'revealUri', 'MCP API key Tool output');
  assertNoSecretCarrier(value);
  return value as ApiKeyToolResultMetadata;
}

function classifyApiKeyApplicationResult(raw: McpApiKeyApplicationResult): 'canonical' | 'flat' {
  assertPlainDataObject(raw, 'API key application result');
  const key = Object.getOwnPropertyDescriptor(raw, 'key');
  const keyId = Object.getOwnPropertyDescriptor(raw, 'keyId');
  if (key !== undefined && keyId !== undefined) {
    throw new McpSecretRedactionError('API key application result must not mix canonical and flat shapes.');
  }
  if (key !== undefined) return 'canonical';
  if (keyId !== undefined) return 'flat';
  throw new McpSecretRedactionError('API key application result must own key or keyId.');
}

function isSecretBearingApiKeyResult(value: object): boolean {
  const hasCanonicalIdentity = Object.getOwnPropertyDescriptor(value, 'key') !== undefined;
  const hasFlatIdentity = Object.getOwnPropertyDescriptor(value, 'keyId') !== undefined;
  if (!hasCanonicalIdentity && !hasFlatIdentity) return false;
  if (Object.getOwnPropertyDescriptor(value, 'secret') !== undefined) return true;
  return Reflect.ownKeys(value).some((key) =>
    typeof key === 'string' && (SECRET_FIELD_NAMES.has(key) || isSecretLikeFieldName(key)),
  );
}

function assertPlainDataObject(value: unknown, label: string): asserts value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new McpSecretRedactionError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new McpSecretRedactionError(`${label} must use an ordinary data prototype.`);
  }
}

function ownEnumerableDataEntries(value: object, label: string): readonly (readonly [string, unknown])[] {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new McpSecretRedactionError(`${label} must not contain symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new McpSecretRedactionError(`${label} must contain only enumerable data properties.`);
    }
    entries.push(Object.freeze([key, descriptor.value] as const));
  }
  return Object.freeze(entries);
}

function readRequiredOwnData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    throw new McpSecretRedactionError(`${label} must own enumerable data property ${key}.`);
  }
  return descriptor.value;
}

function readNonEmptyOwnString(value: object, key: string, label: string): string {
  const candidate = readRequiredOwnData(value, key, label);
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new McpSecretRedactionError(`${label}.${key} must be a non-empty string.`);
  }
  return candidate;
}

function assertOnlyOwnDataKeys(value: object, allowed: readonly string[], label: string): void {
  const entries = ownEnumerableDataEntries(value, label);
  if (entries.length !== allowed.length || entries.some(([key]) => !allowed.includes(key))) {
    throw new McpSecretRedactionError(`${label} must contain only ${allowed.join(' and ')}.`);
  }
}

function isSecretLikeFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'secretavailable' || lower === 'revealuri') return false;
  return (
    lower.includes('secret')
    || lower.includes('password')
    || lower === 'token'
    || lower.endsWith('token')
    || lower.includes('privatekey')
  );
}

function containsSecretField(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretField(item, seen));
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    if (SECRET_FIELD_NAMES.has(key) || isSecretLikeFieldName(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) continue;
    if (containsSecretField(descriptor.value, seen)) return true;
  }
  return false;
}

function assertNoSecretCarrier(value: unknown): void {
  if (containsSecretField(value, new WeakSet<object>())) {
    throw new McpSecretRedactionError('Redacted API key Tool result still contains secret fields.');
  }
}
