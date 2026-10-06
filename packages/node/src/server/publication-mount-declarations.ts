import { isProxy } from 'node:util/types';

/** Maximum nesting accepted while inspecting Mount-scoped declarations. */
export const MAX_PUBLICATION_MOUNT_DECLARATION_DEPTH = 64;

/** Maximum aggregate JSON values accepted across Mount-scoped declarations. */
export const MAX_PUBLICATION_MOUNT_DECLARATION_VALUES = 100_000;

/** Maximum aggregate UTF-8 bytes accepted across declaration keys and strings. */
export const MAX_PUBLICATION_MOUNT_DECLARATION_BYTES = 65_536;

const INVALID_DECLARATIONS_MESSAGE = 'Publication Manifest Mount declarations are invalid.';
const DECLARATION_LIMIT_MESSAGE =
  'Publication Manifest Mount declaration resource limit exceeded.';
const declarationKeys = ['profiles', 'endpoints', 'auth', 'limits'] as const;
const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const controlCharacters = /[\u0000-\u001f\u007f]/u;

export interface PublicationMountDeclarationSnapshot {
  readonly profiles: readonly unknown[];
  readonly endpoints: Readonly<Record<string, unknown>>;
  readonly auth: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
}

interface DeclarationInspectionState {
  bytes: number;
  values: number;
  readonly ancestors: WeakSet<object>;
  readonly owners: WeakMap<object, string>;
}

class DeclarationLimitError extends Error {}

/**
 * Safely snapshots the four declarations that are scoped independently to
 * each Manifest Mount. The returned snapshots never retain caller references.
 */
export function snapshotPublicationMountDeclarations(
  manifest: unknown,
): readonly PublicationMountDeclarationSnapshot[] {
  try {
    const mounts = readMounts(manifest);
    const state: DeclarationInspectionState = {
      bytes: 0,
      values: 0,
      ancestors: new WeakSet<object>(),
      owners: new WeakMap<object, string>(),
    };
    const snapshots: PublicationMountDeclarationSnapshot[] = [];

    for (let mountIndex = 0; mountIndex < mounts.length; mountIndex += 1) {
      const mount = readArrayElement(mounts, mountIndex);
      assertPlainRecord(mount);
      const declarations: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

      for (const key of declarationKeys) {
        const value = readEnumerableDataProperty(mount, key);
        assertDeclarationRoot(key, value);
        declarations[key] = inspectDeclarationValue(value, 0, `${mountIndex}:${key}`, state);
      }

      snapshots.push(Object.freeze({
        profiles: declarations.profiles as readonly unknown[],
        endpoints: declarations.endpoints as Readonly<Record<string, unknown>>,
        auth: declarations.auth as Readonly<Record<string, unknown>>,
        limits: declarations.limits as Readonly<Record<string, unknown>>,
      }));
    }

    return Object.freeze(snapshots);
  } catch (error) {
    if (error instanceof DeclarationLimitError) throw new RangeError(DECLARATION_LIMIT_MESSAGE);
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
}

function readMounts(manifest: unknown): unknown[] {
  assertPlainRecord(manifest);
  const mounts = readEnumerableDataProperty(manifest, 'mounts');
  assertPlainArray(mounts);
  if (mounts.length > MAX_PUBLICATION_MOUNT_DECLARATION_VALUES) {
    throw new DeclarationLimitError();
  }
  assertDenseArray(mounts);
  return mounts;
}

function readArrayElement(array: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
  return descriptor.value;
}

function readEnumerableDataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
  return descriptor.value;
}

function assertDeclarationRoot(
  key: (typeof declarationKeys)[number],
  value: unknown,
): void {
  if (key === 'profiles') {
    assertPlainArray(value);
  } else {
    assertPlainRecord(value);
  }
}

function inspectDeclarationValue(
  value: unknown,
  depth: number,
  owner: string,
  state: DeclarationInspectionState,
): unknown {
  state.values += 1;
  if (
    state.values > MAX_PUBLICATION_MOUNT_DECLARATION_VALUES
    || depth > MAX_PUBLICATION_MOUNT_DECLARATION_DEPTH
  ) {
    throw new DeclarationLimitError();
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (controlCharacters.test(value)) throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
    addBytes(state, value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
    }
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
  if (isProxy(value)) throw new TypeError(INVALID_DECLARATIONS_MESSAGE);

  const previousOwner = state.owners.get(value);
  if (previousOwner !== undefined && previousOwner !== owner) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
  state.owners.set(value, owner);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertPlainArray(value);
      assertDenseArray(value);
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        result.push(inspectDeclarationValue(readArrayElement(value, index), depth + 1, owner, state));
      }
      return Object.freeze(result);
    }

    assertPlainRecord(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || prototypeKeys.has(key))) {
      throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
      addBytes(state, key);
      result[key] = inspectDeclarationValue(
        readEnumerableDataProperty(value, key),
        depth + 1,
        owner,
        state,
      );
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function assertPlainRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
}

function assertPlainArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
}

function assertDenseArray(value: unknown[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
  const keySet = new Set(keys);
  for (let index = 0; index < value.length; index += 1) {
    if (!keySet.has(String(index))) throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  }
}

function addBytes(state: DeclarationInspectionState, value: string): void {
  if (hasLoneSurrogate(value)) throw new TypeError(INVALID_DECLARATIONS_MESSAGE);
  state.bytes += Buffer.byteLength(value, 'utf8');
  if (state.bytes > MAX_PUBLICATION_MOUNT_DECLARATION_BYTES) {
    throw new DeclarationLimitError();
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
