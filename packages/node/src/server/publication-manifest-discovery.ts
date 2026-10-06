import canonicalize from 'canonicalize';
import { isProxy } from 'node:util/types';

import { createValidatorRegistry, validateWireDocument } from '../schema/index.js';
import { validateManifestSemantics } from '../semantic/manifest.js';
import type { Manifest } from '../types/index.js';
import { snapshotPublicationMountDeclarations } from './publication-mount-declarations.js';
import { mergePublicationDiscoveryHeaders } from './publication-discovery-links.js';
import { createPublicationRepresentationEtag } from './publication-representation-etag.js';

/** The single well-known discovery target defined by Collection Protocol 0.1. */
export const PUBLICATION_MANIFEST_DISCOVERY_PATH: string = '/.well-known/collection-protocol';

/** Media type emitted by the framework-neutral discovery response. */
export const PUBLICATION_MANIFEST_MEDIA_TYPE: string =
  'application/vnd.collection-protocol.manifest+json;version=0.1';

/** Maximum UTF-8 size of a serialized discovery Manifest. */
export const MAX_PUBLICATION_MANIFEST_BYTES = 65_536;

const MAX_MANIFEST_JSON_DEPTH = 64;
const MAX_MANIFEST_JSON_VALUES = 100_000;
const MANIFEST_CACHE_CONTROL = 'public, max-age=300';
const INVALID_MANIFEST_MESSAGE = 'Publication Manifest is invalid.';
const MANIFEST_LIMIT_MESSAGE = 'Publication Manifest resource limit exceeded.';
const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const controlCharacters = /[\u0000-\u001f\u007f]/u;
const validators = createValidatorRegistry();

export interface PublicationManifestDiscoveryRequest {
  readonly method: string;
  readonly path: string;
}

export interface PublicationManifestDiscoveryResponse {
  readonly status: 200;
  readonly headers: Readonly<Record<string, string>>;
  /** HEAD has the same representation metadata as GET but no response body. */
  readonly body: string | null;
}

export type PublicationManifestDiscoveryHandler = (
  request: PublicationManifestDiscoveryRequest,
) => PublicationManifestDiscoveryResponse | null;

interface JsonInspectionState {
  bytes: number;
  values: number;
  readonly ancestors: WeakSet<object>;
}

class ManifestLimitError extends Error {}

/**
 * Validate and snapshot a Manifest once, then expose an adapter-ready GET/HEAD
 * handler for the exact well-known discovery target. A null result is a
 * fail-closed route miss and must not be converted into a discovery response.
 */
export function createPublicationManifestDiscoveryHandler(
  manifest: unknown,
): PublicationManifestDiscoveryHandler {
  const body = prepareManifestBody(manifest);

  return Object.freeze((request: PublicationManifestDiscoveryRequest) => {
    const route = inspectRequest(request);
    if (route === null || !matchesDiscoveryRoute(route)) return null;
    return createResponse(body, route.method === 'HEAD');
  });
}

/** Validate a Manifest and handle one discovery request. */
export function handlePublicationManifestDiscoveryRequest(
  manifest: unknown,
  request: PublicationManifestDiscoveryRequest,
): PublicationManifestDiscoveryResponse | null {
  const route = inspectRequest(request);
  if (route === null || !matchesDiscoveryRoute(route)) return null;
  return createResponse(prepareManifestBody(manifest), route.method === 'HEAD');
}

function matchesDiscoveryRoute(route: PublicationManifestDiscoveryRequest): boolean {
  return route.path === PUBLICATION_MANIFEST_DISCOVERY_PATH
    && (route.method === 'GET' || route.method === 'HEAD');
}

function createResponse(body: string, head: boolean): PublicationManifestDiscoveryResponse {
  const headers = mergePublicationDiscoveryHeaders({
    'cache-control': MANIFEST_CACHE_CONTROL,
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    'content-type': PUBLICATION_MANIFEST_MEDIA_TYPE,
    etag: createPublicationRepresentationEtag({
      representation: body,
      revision: 'manifest',
      projectionKey: 'manifest-discovery',
      queryContract: 'none',
      query: {},
      negotiatedMediaType: PUBLICATION_MANIFEST_MEDIA_TYPE,
      protocolVersion: '0.1',
    }),
  });
  return Object.freeze({ status: 200 as const, headers, body: head ? null : body });
}

function prepareManifestBody(source: unknown): string {
  try {
    try {
      snapshotPublicationMountDeclarations(source);
    } catch (error) {
      if (error instanceof RangeError) throw new ManifestLimitError();
      throw error;
    }
    const snapshot = snapshotJson(source);
    const validation = validateWireDocument<Manifest, unknown>(
      validators,
      'manifest',
      snapshot,
      validateManifestSemantics,
    );
    if (!validation.valid) throw new TypeError(INVALID_MANIFEST_MESSAGE);
    if (!validation.value.mounts.some(
      (mount) => mount.profiles.includes('core') && mount.profiles.includes('publication'),
    )) {
      throw new TypeError(INVALID_MANIFEST_MESSAGE);
    }

    const body = canonicalize(validation.value);
    if (body === undefined) throw new TypeError(INVALID_MANIFEST_MESSAGE);
    if (Buffer.byteLength(body, 'utf8') > MAX_PUBLICATION_MANIFEST_BYTES) {
      throw new ManifestLimitError();
    }
    return body;
  } catch (error) {
    if (error instanceof ManifestLimitError) throw new RangeError(MANIFEST_LIMIT_MESSAGE);
    throw new TypeError(INVALID_MANIFEST_MESSAGE);
  }
}

function inspectRequest(request: unknown): PublicationManifestDiscoveryRequest | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request) || isProxy(request)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(request) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(request);
  if (
    keys.length !== 2
    || keys.some((key) => typeof key !== 'string' || prototypeKeys.has(key))
    || !keys.includes('method')
    || !keys.includes('path')
  ) {
    return null;
  }

  const method = Object.getOwnPropertyDescriptor(request, 'method');
  const path = Object.getOwnPropertyDescriptor(request, 'path');
  if (
    method === undefined
    || path === undefined
    || !method.enumerable
    || !path.enumerable
    || !('value' in method)
    || !('value' in path)
    || typeof method.value !== 'string'
    || typeof path.value !== 'string'
    || method.value.length > 16
    || path.value.length > 256
    || controlCharacters.test(method.value)
    || controlCharacters.test(path.value)
  ) {
    return null;
  }
  return { method: method.value, path: path.value };
}

function snapshotJson(value: unknown): unknown {
  const state: JsonInspectionState = { bytes: 0, values: 0, ancestors: new WeakSet<object>() };
  return inspectJsonValue(value, 0, state);
}

function inspectJsonValue(value: unknown, depth: number, state: JsonInspectionState): unknown {
  state.values += 1;
  if (state.values > MAX_MANIFEST_JSON_VALUES || depth > MAX_MANIFEST_JSON_DEPTH) {
    throw new ManifestLimitError();
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (controlCharacters.test(value)) throw new TypeError(INVALID_MANIFEST_MESSAGE);
    addJsonBytes(state, value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(INVALID_MANIFEST_MESSAGE);
    }
    return value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) {
    throw new TypeError(INVALID_MANIFEST_MESSAGE);
  }
  if (isProxy(value)) throw new TypeError(INVALID_MANIFEST_MESSAGE);

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if ((isArray && prototype !== Array.prototype) || (!isArray && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(INVALID_MANIFEST_MESSAGE);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || prototypeKeys.has(key))) {
    throw new TypeError(INVALID_MANIFEST_MESSAGE);
  }

  state.ancestors.add(value);
  try {
    if (isArray) return inspectJsonArray(value, keys, depth, state);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError(INVALID_MANIFEST_MESSAGE);
      addJsonBytes(state, key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(INVALID_MANIFEST_MESSAGE);
      }
      result[key] = inspectJsonValue(descriptor.value, depth + 1, state);
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function inspectJsonArray(
  value: unknown[],
  keys: readonly PropertyKey[],
  depth: number,
  state: JsonInspectionState,
): readonly unknown[] {
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > MAX_MANIFEST_JSON_VALUES) throw new ManifestLimitError();
  if (keys.length !== length + 1 || !keys.includes('length')) {
    throw new TypeError(INVALID_MANIFEST_MESSAGE);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) throw new TypeError(INVALID_MANIFEST_MESSAGE);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(INVALID_MANIFEST_MESSAGE);
    }
    result.push(inspectJsonValue(descriptor.value, depth + 1, state));
  }
  return result;
}

function addJsonBytes(state: JsonInspectionState, value: string): void {
  if (hasLoneSurrogate(value)) throw new TypeError(INVALID_MANIFEST_MESSAGE);
  state.bytes += Buffer.byteLength(value, 'utf8');
  if (state.bytes > MAX_PUBLICATION_MANIFEST_BYTES) throw new ManifestLimitError();
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
