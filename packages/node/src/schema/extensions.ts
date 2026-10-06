import { isHttpsNamespaceUri } from './uri.js';

export type ExtensionMap = Readonly<Record<string, unknown>>;

export type ExtensionOverwritePolicy = 'reject' | 'replace';

export interface PlaceExtensionOptions {
  /** Existing namespace values are protected unless replacement is explicit. */
  readonly overwrite?: ExtensionOverwritePolicy;
}

export type ExtensionTransformationSurface =
  | 'relay'
  | 'page-assembly'
  | 'sync-server'
  | 'export-adapter';

export type ExtensionSecurityDecision =
  | { readonly action: 'preserve' }
  | { readonly action: 'remove'; readonly reason: string };

export interface ExtensionSecurityPolicy {
  /** Stable identifier written to every removal audit record. */
  readonly id: string;
  decide(input: {
    readonly namespace: string;
    readonly value: unknown;
    readonly path: string;
    readonly surface: ExtensionTransformationSurface;
  }): ExtensionSecurityDecision;
}

export interface ExtensionRemovalAudit {
  readonly namespace: string;
  readonly path: string;
  readonly surface: ExtensionTransformationSurface;
  readonly policyId: string;
  readonly reason: string;
}

export interface PreserveExtensionsOptions {
  readonly surface: ExtensionTransformationSurface;
  /** JSON Pointer to the object that owns the extensions member. */
  readonly path?: string;
  readonly securityPolicy?: ExtensionSecurityPolicy;
}

export interface PreservedExtensions {
  readonly extensions: ExtensionMap;
  readonly removals: readonly ExtensionRemovalAudit[];
}

export interface ExtensionCarrier {
  readonly extensions?: ExtensionMap;
}

export interface PreservedExtensionCarrier<Value extends object> {
  readonly value: Value;
  readonly removals: readonly ExtensionRemovalAudit[];
}

const forbiddenObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);

function cloneExtensionValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Extension numbers must be finite.');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError('Extension integers must be within the I-JSON safe integer range.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Extension values must be JSON values.');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Extension values must not contain cycles.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === 'symbol')) {
        throw new TypeError('Extension arrays must not have symbol members.');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('Extension arrays must not be sparse.');
        }
      }
      if (keys.some((key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key as string))) {
        throw new TypeError('Extension arrays must not have named members.');
      }
      const clone: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('Extension array items must be enumerable data properties.');
        }
        clone.push(cloneExtensionValue(descriptor.value, ancestors));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Extension objects must have a plain or null prototype.');
    }

    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new TypeError('Extension objects must not have symbol members.');
      }
      if (forbiddenObjectKeys.has(key)) {
        throw new TypeError(`Extension object member is not allowed: ${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Extension object members must be enumerable data properties.');
      }
      clone[key] = cloneExtensionValue(descriptor.value, ancestors);
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function freezeExtensionValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freezeExtensionValue);
  return value;
}

function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function assertExtensionNamespace(namespace: string): void {
  if (!isHttpsNamespaceUri(namespace)) {
    throw new TypeError('Extension namespace must be an absolute HTTPS URI with a non-empty host.');
  }
}

function assertExtensionMap(extensions: ExtensionMap): void {
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) {
    throw new TypeError('Extensions must be a namespace-keyed object.');
  }
  const prototype = Object.getPrototypeOf(extensions) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Extensions must have a plain or null prototype.');
  }
  for (const key of Reflect.ownKeys(extensions)) {
    if (typeof key === 'symbol') {
      throw new TypeError('Extensions must not have symbol members.');
    }
    if (forbiddenObjectKeys.has(key)) {
      throw new TypeError(`Extension namespace is not allowed: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(extensions, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Extension namespaces must be enumerable data properties.');
    }
    assertExtensionNamespace(key);
  }
}

function copyCarrierWithoutExtensions<Value extends object>(carrier: Value): Record<string, unknown> {
  if (typeof carrier !== 'object' || carrier === null || Array.isArray(carrier)) {
    throw new TypeError('Extension carriers must be plain objects.');
  }
  const prototype = Object.getPrototypeOf(carrier) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Extension carriers must have a plain or null prototype.');
  }

  const core: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(carrier)) {
    if (typeof key === 'symbol') {
      throw new TypeError('Extension carriers must not have symbol members.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(carrier, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Extension carrier members must be enumerable data properties.');
    }
    if (key !== 'extensions') core[key] = descriptor.value;
  }
  return core;
}

/**
 * Places forward-compatible data only at `extensions[namespace]`.
 *
 * The returned carrier, extension map, and every extension payload are detached
 * and frozen. Merge-patch callers must pass the complete current namespace map
 * when preserving namespaces because the protocol replaces `extensions` as one
 * field; `null` remains the separate operation for deleting that field.
 */
export function placeExtension<Value extends object>(
  carrier: Value & ExtensionCarrier,
  namespace: string,
  payload: unknown,
  options: PlaceExtensionOptions = {},
): Readonly<Value & Required<ExtensionCarrier>> {
  assertExtensionNamespace(namespace);
  const core = copyCarrierWithoutExtensions(carrier);
  const extensionDescriptor = Object.getOwnPropertyDescriptor(carrier, 'extensions');
  const existing = extensionDescriptor === undefined ? {} : extensionDescriptor.value as ExtensionMap;
  assertExtensionMap(existing);
  const overwrite = options.overwrite ?? 'reject';
  if (overwrite !== 'reject' && overwrite !== 'replace') {
    throw new TypeError('Extension overwrite policy must be reject or replace.');
  }
  if (Object.hasOwn(existing, namespace) && overwrite === 'reject') {
    throw new TypeError(`Extension namespace already exists: ${namespace}`);
  }

  const extensions = Object.create(null) as Record<string, unknown>;
  for (const [existingNamespace, existingPayload] of Object.entries(existing)) {
    extensions[existingNamespace] = freezeExtensionValue(cloneExtensionValue(existingPayload));
  }
  extensions[namespace] = freezeExtensionValue(cloneExtensionValue(payload));

  return Object.freeze({
    ...core,
    extensions: Object.freeze(extensions),
  }) as Readonly<Value & Required<ExtensionCarrier>>;
}

/**
 * Copies every extension namespace and payload by default. A namespace can be
 * removed only by a named policy decision, which is returned as an audit record.
 */
export function preserveExtensions(
  extensions: ExtensionMap,
  options: PreserveExtensionsOptions,
): PreservedExtensions {
  assertExtensionMap(extensions);
  const ownerPath = options.path ?? '';
  const extensionPath = `${ownerPath}/extensions`;
  const policy = options.securityPolicy;
  if (policy !== undefined && policy.id.trim() === '') {
    throw new TypeError('Extension security policies must have a non-empty id.');
  }

  const preserved: Record<string, unknown> = {};
  const removals: ExtensionRemovalAudit[] = [];
  for (const [namespace, originalValue] of Object.entries(extensions)) {
    assertExtensionNamespace(namespace);
    const path = `${extensionPath}/${pointerSegment(namespace)}`;
    const decision = policy?.decide({
      namespace,
      value: freezeExtensionValue(cloneExtensionValue(originalValue)),
      path,
      surface: options.surface,
    }) ?? { action: 'preserve' as const };

    if (decision.action === 'remove') {
      if (decision.reason.trim() === '') {
        throw new TypeError('Extension removal decisions must include a non-empty reason.');
      }
      removals.push({
        namespace,
        path,
        surface: options.surface,
        policyId: policy!.id,
        reason: decision.reason,
      });
      continue;
    }
    preserved[namespace] = freezeExtensionValue(cloneExtensionValue(originalValue));
  }

  return {
    extensions: Object.freeze(preserved),
    removals: Object.freeze(removals),
  };
}

/** Copies an extension-bearing protocol object without mutating either input. */
export function preserveExtensionCarrier<
  Source extends object,
  Target extends object,
>(
  source: Source & ExtensionCarrier,
  target: Target,
  options: PreserveExtensionsOptions,
): PreservedExtensionCarrier<Target & ExtensionCarrier> {
  const { extensions: _discarded, ...targetWithoutExtensions } = target as Target & ExtensionCarrier;
  if (source.extensions === undefined) {
    return { value: targetWithoutExtensions as Target & ExtensionCarrier, removals: [] };
  }

  const result = preserveExtensions(source.extensions, options);
  return {
    value: { ...targetWithoutExtensions, extensions: result.extensions } as Target & ExtensionCarrier,
    removals: result.removals,
  };
}
