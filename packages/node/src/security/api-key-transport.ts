import { types as nodeTypes } from 'node:util';

import { CREDENTIAL_QUERY_PARAMETER_NAMES } from './credential-query-names.js';
import { inspectExactDenseArray } from './dense-array.js';

export type ApiKeyClassifier = (candidate: string) => boolean;

export interface ApiKeyTransportInput {
  /** The unmodified HTTP request target, before routing or query coercion. */
  readonly requestTarget: string;
  /** One value, or all raw Authorization field values when the transport exposes them separately. */
  readonly authorization?: string | readonly string[];
  /** Additional query names that are credentials regardless of their value. */
  readonly credentialQueryParameterNames?: readonly string[];
  /** Synchronous recognition hook for deployment-specific API key formats. */
  readonly classifyApiKey?: ApiKeyClassifier;
}

export type ApiKeyTransportDenialReason =
  | 'credential_in_query'
  | 'invalid_authorization'
  | 'query_limit_exceeded'
  | 'invalid_input'
  | 'classifier_failure';

export type ApiKeyTransportDecision =
  | {
      readonly allowed: true;
      readonly reason: 'allowed';
      readonly authorizationPresent: boolean;
    }
  | {
      readonly allowed: false;
      readonly reason: ApiKeyTransportDenialReason;
    };

const MAX_QUERY_ENTRIES = 256;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const token68 = /^[A-Za-z0-9\-._~+/]+={0,}$/u;
const builtInApiKey = /^colp_(?:live|test)_[A-Za-z0-9\-._~+/]+={0,}$/u;
const embeddedBuiltInApiKey = /colp_(?:live|test)_[A-Za-z0-9\-._~+/]+={0,}/u;
/** Built-in denylist; source of truth lives in credential-query-names.ts. */
const builtInCredentialParameterNames = CREDENTIAL_QUERY_PARAMETER_NAMES;

const allowedWithoutAuthorization = Object.freeze({
  allowed: true,
  reason: 'allowed',
  authorizationPresent: false,
} as const);
const allowedWithAuthorization = Object.freeze({
  allowed: true,
  reason: 'allowed',
  authorizationPresent: true,
} as const);
const denialDecisions = Object.freeze({
  credential_in_query: Object.freeze({ allowed: false, reason: 'credential_in_query' } as const),
  invalid_authorization: Object.freeze({ allowed: false, reason: 'invalid_authorization' } as const),
  query_limit_exceeded: Object.freeze({ allowed: false, reason: 'query_limit_exceeded' } as const),
  invalid_input: Object.freeze({ allowed: false, reason: 'invalid_input' } as const),
  classifier_failure: Object.freeze({ allowed: false, reason: 'classifier_failure' } as const),
});

interface InputSnapshot {
  readonly requestTarget: string;
  readonly authorizationValues: readonly string[];
  readonly credentialParameterNames: ReadonlySet<string>;
  readonly classifyApiKey: ApiKeyClassifier | undefined;
}

type ClassificationCache = Map<string, boolean | undefined>;

interface QueryViews {
  readonly formEntries: readonly (readonly [string, string])[];
  readonly plusPreservingEntries: readonly (readonly [string, string])[];
}

function denied(reason: ApiKeyTransportDenialReason): ApiKeyTransportDecision {
  return denialDecisions[reason];
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectProxy(value: unknown): void {
  if (nodeTypes.isProxy(value)) throw new TypeError('Proxies are not valid transport guard input');
}

function ownData(value: unknown, key: PropertyKey): unknown | undefined {
  if (!isRecord(value)) throw new TypeError('Transport guard input must be an object');
  rejectProxy(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new TypeError('Transport guard fields must be own data properties');
  return descriptor.value;
}

function denseArraySnapshot(value: unknown): readonly unknown[] {
  // Historical: Proxy rejected, custom prototypes allowed; extra own keys allowed.
  const result = inspectExactDenseArray(value, {
    allowExtraOwnKeys: true,
    requireStandardPrototype: false,
  });
  if (!result.ok) {
    switch (result.failure) {
      case 'not-array':
        throw new TypeError('Expected an array');
      case 'proxy':
        throw new TypeError('Proxies are not valid transport guard input');
      case 'custom-prototype':
        throw new TypeError('Proxies are not valid transport guard input');
      case 'invalid-length':
        throw new TypeError('Invalid array length');
      case 'not-dense':
      case 'extra-keys':
        throw new TypeError('Sparse arrays are not valid transport guard input');
      case 'non-data-entry':
        throw new TypeError('Array entries must be own data properties');
    }
  }
  return Object.freeze(result.values);
}

function snapshotStrings(value: unknown): readonly string[] {
  return Object.freeze(
    denseArraySnapshot(value).map((entry) => {
      if (typeof entry !== 'string' || entry.length === 0 || controlCharacters.test(entry)) {
        throw new TypeError('Expected non-empty strings without control characters');
      }
      return entry;
    }),
  );
}

function snapshotAuthorization(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (typeof value === 'string') return Object.freeze([value]);
  return Object.freeze(
    denseArraySnapshot(value).map((entry) => {
      if (typeof entry !== 'string') throw new TypeError('Authorization values must be strings');
      return entry;
    }),
  );
}

function snapshotClassifier(value: unknown): ApiKeyClassifier | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function' || nodeTypes.isProxy(value)) {
    throw new TypeError('classifyApiKey must be a non-Proxy function');
  }
  return value as ApiKeyClassifier;
}

function snapshotInput(input: ApiKeyTransportInput): InputSnapshot {
  const requestTarget = ownData(input, 'requestTarget');
  if (typeof requestTarget !== 'string' || requestTarget.length === 0 || controlCharacters.test(requestTarget)) {
    throw new TypeError('requestTarget must be a non-empty string without control characters');
  }
  const authorizationValues = snapshotAuthorization(ownData(input, 'authorization'));
  const additionalNamesValue = ownData(input, 'credentialQueryParameterNames');
  const additionalNames =
    additionalNamesValue === undefined ? Object.freeze([]) : snapshotStrings(additionalNamesValue);
  const credentialParameterNames = new Set<string>(builtInCredentialParameterNames);
  for (const name of additionalNames) credentialParameterNames.add(name.toLowerCase());

  return Object.freeze({
    requestTarget,
    authorizationValues,
    credentialParameterNames,
    classifyApiKey: snapshotClassifier(ownData(input, 'classifyApiKey')),
  });
}

function queryEntries(query: string): readonly (readonly [string, string])[] {
  return Object.freeze(
    Array.from(new URLSearchParams(query), ([name, value]) => Object.freeze([name, value] as const)),
  );
}

function parseQuery(requestTarget: string): QueryViews {
  if (requestTarget.includes('\\') || requestTarget.includes(' ')) {
    throw new TypeError('requestTarget contains characters that are not valid in raw HTTP targets');
  }

  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(requestTarget);
  } catch {
    throw new TypeError('requestTarget contains malformed percent encoding');
  }
  if (controlCharacters.test(decodedTarget)) {
    throw new TypeError('requestTarget decodes to control characters');
  }

  if (requestTarget === '*') {
    return Object.freeze({ formEntries: Object.freeze([]), plusPreservingEntries: Object.freeze([]) });
  }
  if (requestTarget.startsWith('/')) {
    new URL(requestTarget, 'http://transport.invalid');
  } else if (/^https?:\/\//iu.test(requestTarget)) {
    new URL(requestTarget);
  } else {
    throw new TypeError('requestTarget must use origin-form, absolute-form, or asterisk-form');
  }

  const fragmentIndex = requestTarget.indexOf('#');
  const queryIndex = requestTarget.indexOf('?');
  if (queryIndex === -1 || (fragmentIndex !== -1 && fragmentIndex < queryIndex)) {
    return Object.freeze({ formEntries: Object.freeze([]), plusPreservingEntries: Object.freeze([]) });
  }
  const queryEnd = fragmentIndex === -1 ? requestTarget.length : fragmentIndex;
  const rawQuery = requestTarget.slice(queryIndex + 1, queryEnd);
  const formEntries = queryEntries(rawQuery);
  const plusPreservingEntries = queryEntries(rawQuery.replaceAll('+', '%2B'));
  if (formEntries.length !== plusPreservingEntries.length) {
    throw new TypeError('requestTarget query has inconsistent parsing semantics');
  }
  return Object.freeze({ formEntries, plusPreservingEntries });
}

function classify(
  candidate: string,
  classifier: ApiKeyClassifier | undefined,
  cache: ClassificationCache,
): boolean | undefined {
  if (builtInApiKey.test(candidate)) return true;
  if (classifier === undefined) return false;
  if (cache.has(candidate)) return cache.get(candidate);
  try {
    const result: unknown = classifier(candidate);
    const classification = typeof result === 'boolean' ? result : undefined;
    cache.set(candidate, classification);
    return classification;
  } catch {
    cache.set(candidate, undefined);
    return undefined;
  }
}

function inspectQuery(
  query: QueryViews,
  credentialParameterNames: ReadonlySet<string>,
  classifier: ApiKeyClassifier | undefined,
  cache: ClassificationCache,
): ApiKeyTransportDenialReason | undefined {
  for (let index = 0; index < query.formEntries.length; index += 1) {
    if (index >= MAX_QUERY_ENTRIES) return 'query_limit_exceeded';
    const entryViews = [query.formEntries[index]!, query.plusPreservingEntries[index]!] as const;
    for (const [name, value] of entryViews) {
      if (credentialParameterNames.has(name.toLowerCase())) return 'credential_in_query';

      for (const candidate of [name, value]) {
        if (embeddedBuiltInApiKey.test(candidate)) return 'credential_in_query';
        const direct = classify(candidate, classifier, cache);
        if (direct === undefined) return 'classifier_failure';
        if (direct) return 'credential_in_query';

        const bearerMatch = /^Bearer ([^\s]+)$/iu.exec(candidate);
        if (bearerMatch !== null) {
          const bearerCandidate = bearerMatch[1]!;
          const bearer = token68.test(bearerCandidate)
            ? classify(bearerCandidate, classifier, cache)
            : false;
          if (bearer === undefined) return 'classifier_failure';
          if (bearer) return 'credential_in_query';
        }
      }
    }
  }
  return undefined;
}

function inspectAuthorization(
  values: readonly string[],
  classifier: ApiKeyClassifier | undefined,
  cache: ClassificationCache,
): { readonly present: boolean; readonly denial?: ApiKeyTransportDenialReason } {
  if (values.length === 0) return Object.freeze({ present: false });
  if (values.length !== 1) return Object.freeze({ present: true, denial: 'invalid_authorization' });
  const value = values[0]!;
  if (value.length === 0 || controlCharacters.test(value)) {
    return Object.freeze({ present: true, denial: 'invalid_authorization' });
  }
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/iu.exec(value);
  if (match === null || !token68.test(match[1]!)) {
    return Object.freeze({ present: true, denial: 'invalid_authorization' });
  }
  const result = classify(match[1]!, classifier, cache);
  if (result === undefined) return Object.freeze({ present: true, denial: 'classifier_failure' });
  if (!result) return Object.freeze({ present: true, denial: 'invalid_authorization' });
  return Object.freeze({ present: true });
}

/**
 * Enforce the **API-key-only** transport boundary before routing, logging, or
 * authentication (SEC-0008).
 *
 * Accepts credentials only as a single `Authorization: Bearer` value that is a
 * built-in `colp_live_` / `colp_test_` key or is accepted by
 * {@link ApiKeyTransportInput.classifyApiKey}. Non-API-key Bearer tokens
 * (including OAuth access tokens) are rejected with `invalid_authorization`.
 *
 * **Do not** install this as global middleware in front of OAuth routes.
 * OAuth Bearer transport must use `enforceOAuth21Profile` on those routes.
 * Prefer the explicit alias {@link enforceApiKeyOnlyTransport} at call sites
 * that want the API-key-only intent in the name.
 *
 * Query denylist names are shared with the OAuth profile (see
 * `credential-query-names.ts`); additional names may be supplied via
 * `credentialQueryParameterNames`. Bearer acceptance is intentionally not
 * loosened to arbitrary tokens.
 */
export function enforceApiKeyTransport(input: ApiKeyTransportInput): ApiKeyTransportDecision {
  let snapshot: InputSnapshot;
  try {
    snapshot = snapshotInput(input);
  } catch {
    return denied('invalid_input');
  }

  let query: QueryViews;
  try {
    query = parseQuery(snapshot.requestTarget);
  } catch {
    return denied('invalid_input');
  }

  const classificationCache: ClassificationCache = new Map();
  const queryDenial = inspectQuery(
    query,
    snapshot.credentialParameterNames,
    snapshot.classifyApiKey,
    classificationCache,
  );
  if (queryDenial !== undefined) return denied(queryDenial);
  const authorization = inspectAuthorization(
    snapshot.authorizationValues,
    snapshot.classifyApiKey,
    classificationCache,
  );
  if (authorization.denial !== undefined) return denied(authorization.denial);
  return authorization.present ? allowedWithAuthorization : allowedWithoutAuthorization;
}

/**
 * Explicit alias of {@link enforceApiKeyTransport}. Use this name when wiring
 * API-key routes so the API-key-only Bearer classification is obvious and is
 * not mistaken for a global auth transport guard.
 */
export const enforceApiKeyOnlyTransport = enforceApiKeyTransport;
