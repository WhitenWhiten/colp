import { principalTypes, scopeNames } from '../shared/protocol-vocabulary.js';
import { types as nodeTypes } from 'node:util';

import type { AccessPolicy, PrincipalRef, ScopeName } from '../types/index.js';
import { inspectExactDenseArray } from './dense-array.js';
import {
  isPlainRecord,
  readOwnDataProperty,
} from './input-snapshot.js';
import {
  serializeRateLimitFields,
  type RateLimitBucketId,
  type RateLimitFields,
} from './rate-limit.js';

export type PrincipalType =
  | 'user'
  | 'group'
  | 'oauth_client'
  | 'api_key'
  | 'service'
  | 'ai_agent'
  | 'public';

export interface Principal {
  readonly id: string;
  readonly type: PrincipalType;
  readonly scopes: ReadonlySet<string>;
}

const anonymousReadScopes = new Set<ScopeName>([
  'collections:list',
  'collections:read',
  'nodes:read',
  'annotations:read',
  'attachments:read',
  'relations:read',
  'feed:read',
]);

const syntheticPublicPrincipal: PrincipalRef = Object.freeze({ type: 'public', id: 'public' });
const anonymousIdentitySet: readonly PrincipalRef[] = Object.freeze([syntheticPublicPrincipal]);

interface EffectiveScopeInputBase {
  readonly grantedScopes: ReadonlySet<ScopeName>;
  readonly policyChain: EffectivePolicyChain;
}

export type IdentityResolution =
  | { readonly status: 'anonymous'; readonly identities: readonly PrincipalRef[] }
  | { readonly status: 'authenticated'; readonly identities: readonly PrincipalRef[] }
  | { readonly credentialEstablished: false; readonly identities: readonly PrincipalRef[] }
  | { readonly credentialEstablished: true; readonly identities: readonly PrincipalRef[] };

/**
 * `identityResolution` is the authoritative runtime contract. The legacy
 * `identities` form remains supported for callers that have not yet separated
 * authentication from identity resolution.
 */
export type EffectiveScopeInput = EffectiveScopeInputBase &
  (
    | { readonly identityResolution: IdentityResolution; readonly identities?: never }
    | { readonly identityResolution?: never; readonly identities: readonly PrincipalRef[] }
  );

export interface EffectivePolicyChain {
  readonly serverDefault: AccessPolicy;
  readonly collection: AccessPolicy;
  readonly ancestors: readonly AccessPolicy[];
  readonly object: AccessPolicy;
}

function principalKey(principal: PrincipalRef): string {
  return `${principal.type}\u0000${principal.id}`;
}

export function evaluateEffectiveScopes(input: EffectiveScopeInput): ReadonlySet<ScopeName> {
  let effective = readGrantedScopes(input);
  const identityResult = readIdentities(input);
  const identities = identityResult.identities;
  if (!identityResult.valid) {
    effective.clear();
  }

  // Untrusted evaluator input fails closed to an empty immutable scope set.
  // Catch converts TypeErrors from chain snapshot helpers (missing required own
  // layers, accessors, sparse/Proxy/custom-prototype ancestor arrays) so this
  // API never throws for malformed input. resolveRequestIdentities remains a
  // throwing public helper when called directly; identity failures here are
  // already converted by readIdentities.
  try {
    const policyChainField = readOwnDataProperty(input, 'policyChain');
    const chain = policyChainField.value;
    // L-5 / SEC-0011 container gate (deliberate fail-closed deny-all — do not throw):
    // - missing / null / undefined policyChain (own data property absent or nullish)
    // - non-record / non-object chain
    // - Proxy chain (nodeTypes.isProxy; traps never invoked)
    // - non-plain prototype (prototype not Object.prototype|null), e.g. Object.create(complete)
    // Plain own-data chains that omit required own layers, expose accessors, or
    // carry hostile ancestor arrays are converted below via this try/catch to
    // the same empty immutable set (never invoke accessors/Proxy traps).
    if (!policyChainField.found || !isPlainRecord(chain)) {
      effective.clear();
      return immutableSetSnapshot(effective);
    }

    const serverDefault = readRequiredObjectField(chain, 'serverDefault');
    const collection = readRequiredObjectField(chain, 'collection');
    const ancestors = snapshotDenseArray(readRequiredObjectField(chain, 'ancestors'));
    const object = readRequiredObjectField(chain, 'object');

    const evaluatePolicy = (policy: unknown): void => {
      const allowed = new Set<ScopeName>();
      const denied = new Set<ScopeName>();

      try {
        if (!isRecord(policy)) {
          effective.clear();
          return;
        }
        const visibility = readObjectField(policy, 'visibility');
        if (
          visibility !== 'public' &&
          visibility !== 'unlisted' &&
          visibility !== 'protected' &&
          visibility !== 'private'
        ) {
          effective.clear();
          return;
        }
        if (visibility === 'public' || visibility === 'unlisted') {
          anonymousReadScopes.forEach((scope) => allowed.add(scope));
        }

        const entries = snapshotDenseArray(readObjectField(policy, 'entries'));
        for (const entry of entries) {
          const principal = readObjectField(entry, 'principal');
          const scopes = snapshotDenseArray(readObjectField(entry, 'scopes'));
          const parsedPrincipal = readPrincipal(principal);
          if (!isRecord(entry) || parsedPrincipal === undefined) {
            effective.clear();
            return;
          }
          const effect = readObjectField(entry, 'effect');
          if ((effect !== 'allow' && effect !== 'deny') || scopes.length === 0) {
            effective.clear();
            return;
          }
          if (!scopes.every(isScopeName)) {
            effective.clear();
            return;
          }
          if (identities.has(parsedPrincipal.key)) {
            const target = effect === 'deny' ? denied : allowed;
            scopes.forEach((scope) => target.add(scope));
          }
        }
      } catch {
        effective.clear();
        return;
      }
      effective = new Set([...effective].filter((scope) => allowed.has(scope) && !denied.has(scope)));
    };

    evaluatePolicy(serverDefault);
    evaluatePolicy(collection);
    for (let index = 0; index < ancestors.length; index += 1) {
      evaluatePolicy(ancestors[index]);
    }
    evaluatePolicy(object);
    return immutableSetSnapshot(effective);
  } catch {
    effective.clear();
    return immutableSetSnapshot(effective);
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function readObjectField(value: unknown, key: PropertyKey): unknown {
  try {
    const field = readOwnDataProperty(value, key);
    return field.found ? field.value : undefined;
  } catch {
    return undefined;
  }
}

function readRequiredObjectField(value: unknown, key: PropertyKey): unknown {
  const field = readOwnDataProperty(value, key);
  if (!field.found) {
    throw new TypeError(`Missing required policy-chain field: ${String(key)}`);
  }
  return field.value;
}

/**
 * Policy-chain dense arrays: same density / Proxy / prototype rules as the
 * shared helper, but deliberately does **not** reject extra own keys and does
 * not freeze (historical SEC-0001/0002 semantics — leave local).
 */
function snapshotDenseArray(value: unknown): readonly unknown[] {
  const result = inspectExactDenseArray(value, {
    allowExtraOwnKeys: true,
    requireStandardPrototype: true,
  });
  if (!result.ok) {
    switch (result.failure) {
      case 'not-array':
      case 'proxy':
        throw new TypeError('Expected a dense array');
      case 'custom-prototype':
        throw new TypeError('Array input must not inherit from a custom prototype');
      case 'invalid-length':
        throw new TypeError('Invalid array length');
      case 'not-dense':
      case 'extra-keys':
        throw new TypeError('Sparse arrays or mismatched array lengths are not valid policy input');
      case 'non-data-entry':
        throw new TypeError('Array entries must be own data properties');
    }
  }
  // Deliberately not frozen (historical SEC-0001/0002 semantics).
  return result.values;
}

function isScopeName(value: unknown): value is ScopeName {
  return typeof value === 'string' && scopeNames.has(value as ScopeName);
}

function readPrincipal(
  value: unknown,
): { readonly type: PrincipalType; readonly key: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    const type = readObjectField(value, 'type');
    const id = readObjectField(value, 'id');
    if (
      typeof type === 'string' &&
      principalTypes.has(type as PrincipalType) &&
      typeof id === 'string' &&
      id.length > 0
    ) {
      return { type: type as PrincipalType, key: principalKey({ type: type as PrincipalType, id }) };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readPrincipalSnapshot(
  value: unknown,
): { readonly principal: PrincipalRef; readonly type: PrincipalType; readonly key: string } | undefined {
  try {
    if (nodeTypes.isProxy(value)) {
      return undefined;
    }
    const typeField = readOwnDataProperty(value, 'type');
    const idField = readOwnDataProperty(value, 'id');
    const type = typeField.value;
    const id = idField.value;
    if (
      typeField.found &&
      idField.found &&
      typeof type === 'string' &&
      principalTypes.has(type as PrincipalType) &&
      typeof id === 'string' &&
      id.length > 0
    ) {
      const principal = { type: type as PrincipalType, id };
      return { principal, type: type as PrincipalType, key: principalKey(principal) };
    }
  } catch {
    // Identity input is untrusted and fails closed below.
  }
  return undefined;
}

function readGrantedScopes(input: EffectiveScopeInput): Set<ScopeName> {
  try {
    const grantedField = readOwnDataProperty(input, 'grantedScopes');
    const grantedScopes = grantedField.value;
    if (!grantedField.found || !(grantedScopes instanceof Set)) {
      return new Set();
    }
    const sizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get;
    if (sizeGetter === undefined) {
      return new Set();
    }
    const initialSize = sizeGetter.call(grantedScopes) as number;
    const granted = [...Set.prototype.values.call(grantedScopes) as SetIterator<unknown>];
    const finalSize = sizeGetter.call(grantedScopes) as number;
    if (initialSize !== finalSize || granted.length !== initialSize) {
      return new Set();
    }
    return granted.every(isScopeName) ? new Set(granted) : new Set();
  } catch {
    return new Set();
  }
}

function snapshotIdentityArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Identity resolution must provide a dense array');
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError('Identity resolution cannot safely snapshot a Proxy array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError('Invalid identity array length');
  }
  const length = lengthDescriptor.value as number;
  const indexes = Reflect.ownKeys(value).filter(
    (key): key is string =>
      typeof key === 'string' && /^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < 4_294_967_295,
  );
  if (indexes.length !== length) {
    throw new TypeError('Sparse identity arrays are not valid security input');
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('Identity entries must be own data properties');
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function snapshotAuthenticatedIdentities(value: unknown): readonly PrincipalRef[] {
  const identities = new Map<string, PrincipalRef>();
  for (const identity of snapshotIdentityArray(value)) {
    const parsed = readPrincipalSnapshot(identity);
    if (parsed === undefined) {
      throw new TypeError('Authenticated identity resolution contains an invalid principal');
    }
    if (parsed.type !== 'public') {
      identities.set(parsed.key, Object.freeze({ ...parsed.principal }));
    }
  }
  const snapshot = Object.freeze([...identities.values()]);
  if (snapshot.length === 0) {
    throw new TypeError('Authenticated identity resolution must contain a non-public principal');
  }
  return snapshot;
}

export function resolveRequestIdentities(resolution: IdentityResolution): readonly PrincipalRef[] {
  const statusField = readOwnDataProperty(resolution, 'status');
  const credentialEstablishedField = readOwnDataProperty(resolution, 'credentialEstablished');
  const identitiesField = readOwnDataProperty(resolution, 'identities');
  if (statusField.found === credentialEstablishedField.found) {
    throw new TypeError('Identity resolution must have exactly one credential-state discriminator');
  }
  const credentialEstablished = statusField.found
    ? statusField.value === 'authenticated'
      ? true
      : statusField.value === 'anonymous'
        ? false
        : undefined
    : credentialEstablishedField.value;
  if (typeof credentialEstablished !== 'boolean') {
    throw new TypeError('Identity resolution credential state is required');
  }
  if (!identitiesField.found) {
    throw new TypeError('Identity resolution identities are required');
  }
  if (!credentialEstablished) {
    if (snapshotIdentityArray(identitiesField.value).length !== 0) {
      throw new TypeError('Anonymous identity resolution cannot supply identities');
    }
    return anonymousIdentitySet;
  }
  return snapshotAuthenticatedIdentities(identitiesField.value);
}

function readIdentities(input: EffectiveScopeInput): {
  readonly identities: ReadonlySet<string>;
  readonly valid: boolean;
} {
  try {
    const resolutionField = readOwnDataProperty(input, 'identityResolution');
    const legacyIdentitiesField = readOwnDataProperty(input, 'identities');
    if (resolutionField.found) {
      if (legacyIdentitiesField.found) {
        return { identities: new Set(), valid: false };
      }
      const resolution = resolutionField.value as IdentityResolution;
      const resolvedIdentities = resolveRequestIdentities(resolution);
      const identities = new Set(resolvedIdentities.map(principalKey));
      return { identities, valid: identities.size > 0 };
    }

    if (!legacyIdentitiesField.found) {
      return { identities: new Set(), valid: false };
    }
    const suppliedIdentities = snapshotIdentityArray(legacyIdentitiesField.value);
    if (suppliedIdentities.length === 0) {
      return {
        identities: new Set([principalKey({ type: 'public', id: 'public' })]),
        valid: true,
      };
    }
    const resolvedIdentities = snapshotAuthenticatedIdentities(suppliedIdentities);
    return { identities: new Set(resolvedIdentities.map(principalKey)), valid: true };
  } catch {
    return { identities: new Set(), valid: false };
  }
}

function immutableSetSnapshot<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  const snapshot = new Set(source);
  let result: ReadonlySet<T>;
  result = Object.freeze({
    size: snapshot.size,
    has: (value: T) => snapshot.has(value),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
    forEach: (callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      snapshot.forEach((value) => callback.call(thisArg, value, value, result));
    },
  });
  return result;
}

export function hasEffectiveScope(input: EffectiveScopeInput, scope: ScopeName): boolean {
  return evaluateEffectiveScopes(input).has(scope);
}

export interface AuthorizationAction {
  readonly scope: string;
  readonly collectionId?: string;
  readonly nodeId?: string;
}

/**
 * Host adapter shape accepted by the NestJS module options. It is not a
 * Security decision API: authorization decisions come from
 * {@link evaluateEffectiveScopes} / {@link hasEffectiveScope} with credential
 * adapters at the request boundary.
 */
export interface AuthorizationAdapter {
  authenticate(request: unknown): Promise<Principal | null>;
  authorize(principal: Principal | null, action: AuthorizationAction): Promise<boolean>;
}
