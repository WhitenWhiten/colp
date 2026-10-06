import { isProxy } from 'node:util/types';

import { createValidatorRegistry, validateWireDocument } from '../schema/index.js';
import { validateManifestSemantics } from '../semantic/manifest.js';
import type { Manifest, ManifestFeatures } from '../types/index.js';

/** Maximum nesting accepted while snapshotting a static Publication Manifest. */
export const MAX_PUBLICATION_STATIC_MANIFEST_DEPTH = 64;

/** Maximum aggregate values accepted while snapshotting a static Publication Manifest. */
export const MAX_PUBLICATION_STATIC_MANIFEST_VALUES = 100_000;

/** Maximum aggregate UTF-8 bytes accepted across Manifest keys and strings. */
export const MAX_PUBLICATION_STATIC_MANIFEST_BYTES = 65_536;

const INVALID_STATIC_MANIFEST_MESSAGE =
  'Static Publication Manifest profile declarations are invalid.';
const STATIC_MANIFEST_LIMIT_MESSAGE =
  'Static Publication Manifest profile declaration resource limit exceeded.';
const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const controlCharacters = /[\u0000-\u001f\u007f]/u;
const validators = createValidatorRegistry();

export type PublicationStaticProfiles =
  | readonly ['core', 'publication']
  | readonly ['core', 'publication', 'feed'];

export interface PublicationStaticFeedDeclaration {
  readonly instanceFeed: string;
  readonly collectionFeed: string;
  readonly feature: NonNullable<ManifestFeatures['feed']>;
}

export interface PublicationStaticMountProfileDeclaration {
  readonly mountId: string;
  readonly profiles: PublicationStaticProfiles;
  readonly feed: PublicationStaticFeedDeclaration | null;
}

export interface PublicationStaticManifestProfileSnapshot {
  readonly declarations: readonly PublicationStaticMountProfileDeclaration[];
  /**
   * Detached canonical input for an adapter's later claim-authorization step.
   * This value is not a verified Manifest and does not bypass assertProfileClaims.
   */
  readonly unverifiedCanonicalCandidate: Manifest;
}

interface InspectionState {
  bytes: number;
  values: number;
  readonly seen: WeakSet<object>;
}

class StaticManifestLimitError extends Error {}

/**
 * Snapshots a Manifest and verifies the exact static Publication profile
 * declaration for every selected Mount. Omitting mount IDs selects all Mounts.
 * This is a declaration boundary only; it does not authorize profile claims.
 */
export function snapshotPublicationStaticManifestProfiles(
  manifest: unknown,
  selectedMountIds?: unknown,
): PublicationStaticManifestProfileSnapshot {
  try {
    const snapshot = inspectValue(manifest, 0, {
      bytes: 0,
      values: 0,
      seen: new WeakSet<object>(),
    });
    const validation = validateWireDocument<Manifest, unknown>(
      validators,
      'manifest',
      snapshot,
      validateManifestSemantics,
    );
    if (!validation.valid) throw invalidStaticManifest();

    const candidate = validation.value;
    const selected = selectedMountIds === undefined
      ? new Set(candidate.mounts.map((mount) => mount.id))
      : inspectSelectedMountIds(selectedMountIds);
    const mountIds = new Set(candidate.mounts.map((mount) => mount.id));
    for (const mountId of selected) {
      if (!mountIds.has(mountId)) throw invalidStaticManifest();
    }

    const declarations: PublicationStaticMountProfileDeclaration[] = [];
    for (const mount of candidate.mounts) {
      if (!selected.has(mount.id)) continue;
      const hasInstanceFeed = Object.hasOwn(mount.endpoints, 'instanceFeed');
      const hasCollectionFeed = Object.hasOwn(mount.endpoints, 'collectionFeed');
      const hasFeedFeature = Object.hasOwn(mount.features, 'feed');
      if (hasInstanceFeed !== hasCollectionFeed || hasInstanceFeed !== hasFeedFeature) {
        throw invalidStaticManifest();
      }

      const expected = hasInstanceFeed
        ? (['core', 'publication', 'feed'] as const)
        : (['core', 'publication'] as const);
      if (!hasExactProfiles(mount.profiles, expected)) throw invalidStaticManifest();

      const profiles = Object.freeze([...expected]) as PublicationStaticProfiles;
      let feed: PublicationStaticFeedDeclaration | null = null;
      if (hasInstanceFeed) {
        const instanceFeed = mount.endpoints.instanceFeed;
        const collectionFeed = mount.endpoints.collectionFeed;
        const feature = mount.features.feed;
        if (
          typeof instanceFeed !== 'string'
          || typeof collectionFeed !== 'string'
          || feature === undefined
        ) {
          throw invalidStaticManifest();
        }
        feed = Object.freeze({ instanceFeed, collectionFeed, feature });
      }
      declarations.push(Object.freeze({ mountId: mount.id, profiles, feed }));
    }

    return Object.freeze({
      declarations: Object.freeze(declarations),
      unverifiedCanonicalCandidate: candidate,
    });
  } catch (error) {
    if (error instanceof StaticManifestLimitError) {
      throw new RangeError(STATIC_MANIFEST_LIMIT_MESSAGE);
    }
    throw invalidStaticManifest();
  }
}

function inspectSelectedMountIds(value: unknown): Set<string> {
  assertPlainArray(value);
  assertDenseArray(value);
  if (value.length === 0) throw invalidStaticManifest();
  const selected = new Set<string>();
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const mountId = readArrayElement(value, index);
    if (
      typeof mountId !== 'string'
      || controlCharacters.test(mountId)
      || hasLoneSurrogate(mountId)
      || selected.has(mountId)
    ) {
      throw invalidStaticManifest();
    }
    bytes += Buffer.byteLength(mountId, 'utf8');
    if (bytes > MAX_PUBLICATION_STATIC_MANIFEST_BYTES) throw new StaticManifestLimitError();
    selected.add(mountId);
  }
  return selected;
}

function hasExactProfiles(
  actual: readonly unknown[],
  expected: PublicationStaticProfiles,
): boolean {
  return actual.length === expected.length
    && expected.every((profile, index) => actual[index] === profile);
}

function inspectValue(value: unknown, depth: number, state: InspectionState): unknown {
  state.values += 1;
  if (
    state.values > MAX_PUBLICATION_STATIC_MANIFEST_VALUES
    || depth > MAX_PUBLICATION_STATIC_MANIFEST_DEPTH
  ) {
    throw new StaticManifestLimitError();
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (controlCharacters.test(value)) throw invalidStaticManifest();
    addBytes(state, value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw invalidStaticManifest();
    }
    return value;
  }
  if (typeof value !== 'object' || state.seen.has(value) || isProxy(value)) {
    throw invalidStaticManifest();
  }

  state.seen.add(value);
  if (Array.isArray(value)) {
    assertPlainArray(value);
    assertDenseArray(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      result.push(inspectValue(readArrayElement(value, index), depth + 1, state));
    }
    return Object.freeze(result);
  }

  assertPlainRecord(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || prototypeKeys.has(key))) {
    throw invalidStaticManifest();
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') throw invalidStaticManifest();
    addBytes(state, key);
    result[key] = inspectValue(readEnumerableDataProperty(value, key), depth + 1, state);
  }
  return Object.freeze(result);
}

function readArrayElement(array: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw invalidStaticManifest();
  }
  return descriptor.value;
}

function readEnumerableDataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw invalidStaticManifest();
  }
  return descriptor.value;
}

function assertPlainRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw invalidStaticManifest();
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw invalidStaticManifest();
}

function assertPlainArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidStaticManifest();
  }
}

function assertDenseArray(value: unknown[]): void {
  if (value.length > MAX_PUBLICATION_STATIC_MANIFEST_VALUES) {
    throw new StaticManifestLimitError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) throw invalidStaticManifest();
  const keySet = new Set<PropertyKey>(keys);
  for (let index = 0; index < value.length; index += 1) {
    if (!keySet.has(String(index))) throw invalidStaticManifest();
  }
}

function addBytes(state: InspectionState, value: string): void {
  if (hasLoneSurrogate(value)) throw invalidStaticManifest();
  state.bytes += Buffer.byteLength(value, 'utf8');
  if (state.bytes > MAX_PUBLICATION_STATIC_MANIFEST_BYTES) {
    throw new StaticManifestLimitError();
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

function invalidStaticManifest(): TypeError {
  return new TypeError(INVALID_STATIC_MANIFEST_MESSAGE);
}
