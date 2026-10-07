import { isHttpUrl } from '../schema/uri.js';
import { createValidatorRegistry, type ValidatorRegistry } from '../schema/index.js';
import { immutableJsonSnapshot } from '../shared/immutable-json.js';
import {
  discriminateFeedEvent,
  type VerifiedFeedEvent,
} from './event-contracts.js';
import {
  isImmutableReleaseSnapshotUrl,
  isReleaseSnapshotDigest,
  parseImmutableReleaseSnapshotPath,
} from './release-snapshot-guards.js';
import type { ChangeCounts, ReleasePublishedFeedEventData } from '../types/index.js';

export {
  isImmutableReleaseSnapshotUrl,
  isReleaseSnapshotDigest,
  parseImmutableReleaseSnapshotPath,
} from './release-snapshot-guards.js';

export interface ReleasePublishedEventInput {
  readonly id: string;
  readonly source: string;
  readonly subject: string;
  readonly time: string;
  readonly collectionId: string;
  readonly revision: string;
  readonly releaseId: string;
  /** Immutable Release Snapshot URL (must not be the mutable `/snapshot` alone). */
  readonly snapshotUrl: string;
  readonly snapshotDigest: string;
  readonly changes: ChangeCounts;
  readonly summary?: string;
  readonly collectionprotocolversion?: '0.1';
}

export type ReleasePublishedBuildResult =
  | { readonly ok: true; readonly event: VerifiedFeedEvent }
  | { readonly ok: false; readonly code: ReleasePublishedErrorCode };

export type ReleasePublishedErrorCode =
  | 'malformed_input'
  | 'mutable_snapshot_url'
  | 'snapshot_identity_mismatch'
  | 'missing_digest'
  | 'invalid_snapshot_url'
  | 'invalid_digest'
  | 'schema_invalid'
  | 'event_contract_failed';

let defaultValidators: ValidatorRegistry | undefined;

function validatorsOrDefault(validators?: ValidatorRegistry): ValidatorRegistry {
  if (validators !== undefined) return validators;
  defaultValidators ??= createValidatorRegistry();
  return defaultValidators;
}

/**
 * Builds a `com.know-n.colp.release.published.v1` Feed Event with an
 * immutable Snapshot URL + Digest (FEED-0004).
 */
export function buildReleasePublishedFeedEvent(
  input: ReleasePublishedEventInput,
  validators?: ValidatorRegistry,
): ReleasePublishedBuildResult {
  try {
    const snapshot = immutableJsonSnapshot(input, 'Release published Feed Event input');
    if (!isPlainObject(snapshot)) {
      return Object.freeze({ ok: false, code: 'malformed_input' });
    }

    if (typeof snapshot.snapshotDigest !== 'string' || snapshot.snapshotDigest.length === 0) {
      return Object.freeze({ ok: false, code: 'missing_digest' });
    }
    if (!isReleaseSnapshotDigest(snapshot.snapshotDigest)) {
      return Object.freeze({ ok: false, code: 'invalid_digest' });
    }
    if (!isHttpUrl(snapshot.snapshotUrl)) {
      return Object.freeze({ ok: false, code: 'invalid_snapshot_url' });
    }
    if (!isImmutableReleaseSnapshotUrl(snapshot.snapshotUrl)) {
      return Object.freeze({ ok: false, code: 'mutable_snapshot_url' });
    }
    const snapshotPathIds = parseImmutableReleaseSnapshotPath(snapshot.snapshotUrl);
    if (
      snapshotPathIds === undefined
      || snapshotPathIds.collectionId !== snapshot.collectionId
      || snapshotPathIds.releaseId !== snapshot.releaseId
    ) {
      return Object.freeze({ ok: false, code: 'snapshot_identity_mismatch' });
    }

    const data: ReleasePublishedFeedEventData = {
      collectionId: snapshot.collectionId,
      revision: snapshot.revision,
      changes: Object.freeze({ ...snapshot.changes }),
      releaseId: snapshot.releaseId,
      snapshotUrl: snapshot.snapshotUrl,
      snapshotDigest: snapshot.snapshotDigest,
      ...(snapshot.summary === undefined ? {} : { summary: snapshot.summary }),
    };

    const event = {
      specversion: '1.0' as const,
      id: snapshot.id,
      source: snapshot.source,
      type: 'com.know-n.colp.release.published.v1' as const,
      subject: snapshot.subject,
      time: snapshot.time,
      datacontenttype: 'application/json' as const,
      collectionprotocolversion: snapshot.collectionprotocolversion ?? '0.1',
      data,
    };

    const discriminated = discriminateFeedEvent(event, validatorsOrDefault(validators));
    if (!discriminated.valid) {
      return Object.freeze({
        ok: false,
        code: discriminated.code === 'schema_invalid'
          ? 'schema_invalid'
          : 'event_contract_failed',
      });
    }

    return Object.freeze({ ok: true, event: discriminated.event });
  } catch {
    return Object.freeze({ ok: false, code: 'malformed_input' });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
