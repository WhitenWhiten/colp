import { isHttpsNamespaceUri } from '../schema/uri.js';
import { createValidatorRegistry, type ValidatorRegistry } from '../schema/index.js';
import {
  immutableJsonSnapshot,
  type DeepReadonly,
} from '../shared/immutable-json.js';
import {
  isImmutableReleaseSnapshotUrl,
  isReleaseSnapshotDigest,
  parseImmutableReleaseSnapshotPath,
} from './release-snapshot-guards.js';
import {
  assertNonRedactedFeedBookmarkUrl,
  assertRedactedFeedBookmarkShape,
} from './bookmark-url.js';
import type { FeedEvent } from '../types/index.js';

/** Standard Feed Event types with exact `data` discriminants (FEED-0001). */
export const STANDARD_FEED_EVENT_TYPES = Object.freeze([
  'org.collectionprotocol.collection.created.v1',
  'org.collectionprotocol.collection.updated.v1',
  'org.collectionprotocol.collection.deleted.v1',
  'org.collectionprotocol.release.published.v1',
  'org.collectionprotocol.node.created.v1',
  'org.collectionprotocol.node.updated.v1',
  'org.collectionprotocol.node.moved.v1',
  'org.collectionprotocol.node.deleted.v1',
  'org.collectionprotocol.annotation.published.v1',
  'org.collectionprotocol.access.publication_changed.v1',
] as const);

export type StandardFeedEventType = (typeof STANDARD_FEED_EVENT_TYPES)[number];

export type FeedEventDiscriminationResult =
  | {
      readonly valid: true;
      readonly event: VerifiedFeedEvent;
      readonly kind: 'standard' | 'extension';
    }
  | { readonly valid: false; readonly code: FeedEventDiscriminationErrorCode; readonly path: string };

/** A detached Feed Event snapshot whose complete object graph is frozen. */
export type VerifiedFeedEvent = DeepReadonly<FeedEvent>;

export type FeedEventDiscriminationErrorCode =
  | 'malformed_event'
  | 'unknown_event_type'
  | 'invalid_extension_type'
  | 'schema_invalid'
  | 'excess_data_field'
  | 'access_private_payload'
  | 'missing_extensions'
  | 'unsafe_bookmark_url'
  | 'mutable_snapshot_url'
  | 'snapshot_identity_mismatch'
  | 'invalid_snapshot_digest';

const ACCESS_FORBIDDEN_KEYS = Object.freeze([
  'key',
  'keys',
  'apiKey',
  'apiKeys',
  'accessKey',
  'accessKeys',
  'principal',
  'principalId',
  'principals',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  'password',
  'privateRule',
  'privateRules',
  'policy',
  'acl',
]);

const standardTypeSet = new Set<string>(STANDARD_FEED_EVENT_TYPES);

const DATA_KEYS_BY_STANDARD_TYPE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'org.collectionprotocol.collection.created.v1',
    new Set(['collectionId', 'revision', 'summary']),
  ],
  [
    'org.collectionprotocol.collection.updated.v1',
    new Set(['collectionId', 'revision', 'summary']),
  ],
  [
    'org.collectionprotocol.collection.deleted.v1',
    new Set(['collectionId', 'revision', 'summary']),
  ],
  [
    'org.collectionprotocol.annotation.published.v1',
    new Set(['collectionId', 'revision', 'summary']),
  ],
  [
    'org.collectionprotocol.release.published.v1',
    new Set([
      'collectionId',
      'revision',
      'summary',
      'changes',
      'releaseId',
      'snapshotUrl',
      'snapshotDigest',
    ]),
  ],
  [
    'org.collectionprotocol.node.created.v1',
    new Set(['collectionId', 'revision', 'node']),
  ],
  [
    'org.collectionprotocol.node.updated.v1',
    new Set(['collectionId', 'revision', 'node']),
  ],
  [
    'org.collectionprotocol.node.moved.v1',
    new Set(['collectionId', 'revision', 'node']),
  ],
  [
    'org.collectionprotocol.node.deleted.v1',
    new Set(['collectionId', 'revision', 'nodeId', 'summary']),
  ],
  [
    'org.collectionprotocol.access.publication_changed.v1',
    new Set(['collectionId', 'revision', 'visibility']),
  ],
]);

let defaultValidators: ValidatorRegistry | undefined;

function validatorsOrDefault(validators?: ValidatorRegistry): ValidatorRegistry {
  if (validators !== undefined) return validators;
  defaultValidators ??= createValidatorRegistry();
  return defaultValidators;
}

function fail(
  code: FeedEventDiscriminationErrorCode,
  path: string,
): FeedEventDiscriminationResult {
  return Object.freeze({ valid: false, code, path });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataKeys(value: object): string[] {
  return Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string');
}

/**
 * Discriminates a Feed Event against standard type/`data` contracts and the
 * extension HTTPS + `extensions` rule (FEED-0001).
 *
 * Structural validation uses the canonical `feedEvent` Schema definition.
 * Additional runtime checks reject excess data fields, non-HTTPS extension
 * types, Access private payloads, unsafe Bookmark targets inside Node data,
 * and mutable Release Snapshot URLs / digests on release.published (FEED-0004).
 */
export function discriminateFeedEvent(
  input: unknown,
  validators?: ValidatorRegistry,
): FeedEventDiscriminationResult {
  let snapshot: DeepReadonly<unknown>;
  try {
    snapshot = immutableJsonSnapshot(input, 'Feed Event');
  } catch {
    return fail('malformed_event', '/');
  }

  if (!isPlainObject(snapshot)) {
    return fail('malformed_event', '/');
  }

  const typeValue = snapshot.type;
  if (typeof typeValue !== 'string' || typeValue.length === 0) {
    return fail('malformed_event', '/type');
  }

  const isStandard = standardTypeSet.has(typeValue);
  const isHttpsExtension = isHttpsNamespaceUri(typeValue);
  if (!isStandard && !isHttpsExtension) {
    const typeText: string = typeValue;
    if (typeText.startsWith('http://') || typeText.includes('://')) {
      return fail('invalid_extension_type', '/type');
    }
    return fail('unknown_event_type', '/type');
  }

  const structural = validatorsOrDefault(validators).validate('feedEvent', snapshot);
  if (!structural.valid) {
    return fail('schema_invalid', structural.errors[0]?.instancePath || '/');
  }

  const data = snapshot.data;
  if (!isPlainObject(data)) {
    return fail('malformed_event', '/data');
  }
  if (isStandard) {
    const allowed = DATA_KEYS_BY_STANDARD_TYPE.get(typeValue);
    if (allowed === undefined) {
      return fail('unknown_event_type', '/type');
    }
    for (const key of dataKeys(data)) {
      if (!allowed.has(key)) {
        return fail('excess_data_field', `/data/${key}`);
      }
    }

    if (typeValue === 'org.collectionprotocol.access.publication_changed.v1') {
      for (const key of dataKeys(data)) {
        const normalized = key.toLowerCase().replace(/[_\-\s]/gu, '');
        if (
          ACCESS_FORBIDDEN_KEYS.some(
            (forbidden) => forbidden.toLowerCase().replace(/[_\-\s]/gu, '') === normalized,
          )
        ) {
          return fail('access_private_payload', `/data/${key}`);
        }
      }
      // Access events describe public state change only: no nested secrets.
      for (const value of Object.values(data)) {
        if (value !== null && typeof value === 'object') {
          return fail('access_private_payload', '/data');
        }
      }
    }

    if (
      typeValue === 'org.collectionprotocol.node.created.v1'
      || typeValue === 'org.collectionprotocol.node.updated.v1'
      || typeValue === 'org.collectionprotocol.node.moved.v1'
    ) {
      const node = data.node;
      if (!isPlainObject(node)) {
        return fail('malformed_event', '/data/node');
      }
      try {
        assertRedactedFeedBookmarkShape(node);
        assertNonRedactedFeedBookmarkUrl(node);
      } catch {
        const targetField = ['url', 'canonicalUrl', 'urlHash'].find((field) =>
          Object.hasOwn(node, field),
        );
        return fail('unsafe_bookmark_url', `/data/node/${targetField ?? 'url'}`);
      }
    }

    // FEED-0004: release.published must carry an immutable Release Snapshot URL + digest.
    // This is enforced on the primary wire discrimination boundary (not only the builder).
    if (typeValue === 'org.collectionprotocol.release.published.v1') {
      const snapshotUrl = data.snapshotUrl;
      if (!isImmutableReleaseSnapshotUrl(snapshotUrl)) {
        return fail('mutable_snapshot_url', '/data/snapshotUrl');
      }
      const snapshotPathIds = parseImmutableReleaseSnapshotPath(snapshotUrl);
      if (
        snapshotPathIds === undefined
        || snapshotPathIds.collectionId !== data.collectionId
        || snapshotPathIds.releaseId !== data.releaseId
      ) {
        return fail('snapshot_identity_mismatch', '/data/snapshotUrl');
      }
      if (!isReleaseSnapshotDigest(data.snapshotDigest)) {
        return fail('invalid_snapshot_digest', '/data/snapshotDigest');
      }
    }
  } else {
    // Extension: data may only carry collectionId + extensions namespace bag.
    for (const key of dataKeys(data)) {
      if (key !== 'collectionId' && key !== 'extensions') {
        return fail('excess_data_field', `/data/${key}`);
      }
    }
    if (data.extensions === undefined || !isPlainObject(data.extensions)) {
      return fail('missing_extensions', '/data/extensions');
    }
  }

  return Object.freeze({
    valid: true,
    event: snapshot as VerifiedFeedEvent,
    kind: isStandard ? 'standard' : 'extension',
  });
}

/** Returns true when `type` is a registered standard Feed Event type. */
export function isStandardFeedEventType(type: string): type is StandardFeedEventType {
  return standardTypeSet.has(type);
}
