import { describe, expect, it } from 'vitest';

import { discriminateFeedEvent } from '../../src/feed/event-contracts.js';
import {
  buildReleasePublishedFeedEvent,
  isImmutableReleaseSnapshotUrl,
  type ReleasePublishedEventInput,
} from '../../src/feed/release-event.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = 'feed.release-snapshot';
const validators = createValidatorRegistry();
const DIGEST = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
const BASE = 'https://alice.example/collections';
const COLLECTION_ID = 'c1';
const RELEASE_ID = 'r1';
const IMMUTABLE = `${BASE}/c/${COLLECTION_ID}/releases/${RELEASE_ID}/snapshot`;

function releaseInput(snapshotUrl: string, ids = {
  collectionId: COLLECTION_ID,
  releaseId: RELEASE_ID,
}): ReleasePublishedEventInput {
  return {
    id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
    source: BASE,
    subject: `collections/c/${ids.collectionId}/releases/${ids.releaseId}`,
    time: '2026-07-16T06:30:00Z',
    collectionId: ids.collectionId,
    revision: 'r_1',
    releaseId: ids.releaseId,
    snapshotUrl,
    snapshotDigest: DIGEST,
    changes: { created: 0, updated: 1, moved: 0, deleted: 0 },
  };
}

function releaseEvent(snapshotUrl: string, ids = {
  collectionId: COLLECTION_ID,
  releaseId: RELEASE_ID,
}): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
    source: BASE,
    type: 'org.collectionprotocol.release.published.v1',
    subject: `collections/c/${ids.collectionId}/releases/${ids.releaseId}`,
    time: '2026-07-16T06:30:00Z',
    datacontenttype: 'application/json',
    collectionprotocolversion: '0.1',
    data: {
      collectionId: ids.collectionId,
      revision: 'r_1',
      changes: { created: 0, updated: 1, moved: 0, deleted: 0 },
      releaseId: ids.releaseId,
      snapshotUrl,
      snapshotDigest: DIGEST,
    },
  };
}

describe(`CFI-002 Release Snapshot URL identity and path canonicalization [evidence:${evidence}]`, () => {
  it(`[success] accepts an immutable URL with a signed query while ignoring query text for path identity [evidence:${evidence}]`, () => {
    const signed = `${IMMUTABLE}?expires=1780000000&sig=abc%2Fdef`;
    expect(isImmutableReleaseSnapshotUrl(signed)).toBe(true);

    const built = buildReleasePublishedFeedEvent(releaseInput(signed), validators);
    expect(built).toMatchObject({ ok: true });
    if (built.ok) {
      expect((built.event.data as Record<string, unknown>).snapshotUrl).toBe(signed);
    }

    const discriminated = discriminateFeedEvent(releaseEvent(signed), validators);
    expect(discriminated).toMatchObject({ valid: true, kind: 'standard' });
  });

  it(`[negative] rejects fragment injection and keeps fragments out of release identity [evidence:${evidence}]`, () => {
    const fragment = `${IMMUTABLE}#next=/c/${COLLECTION_ID}/releases/${RELEASE_ID}/snapshot`;
    expect(isImmutableReleaseSnapshotUrl(fragment)).toBe(false);

    const built = buildReleasePublishedFeedEvent(releaseInput(fragment), validators);
    expect(built).toEqual({ ok: false, code: 'mutable_snapshot_url' });

    const discriminated = discriminateFeedEvent(releaseEvent(fragment), validators);
    expect(discriminated).toEqual({
      valid: false,
      code: 'mutable_snapshot_url',
      path: '/data/snapshotUrl',
    });
  });

  it.each([
    `${BASE}/c/c1%2Freleases/r1/snapshot`,
    `${BASE}/c/c1%2freleases/r1/snapshot`,
    `${BASE}/c/c1%5Creleases/r1/snapshot`,
    `${BASE}/c/c%2E1/releases/r1/snapshot`,
    `${BASE}/c/c%2e1/releases/r1/snapshot`,
    `${BASE}/c/c1/releases/%2E1/snapshot`,
    `${BASE}/c/c1/releases/./snapshot`,
    `${BASE}/c/c1/releases/r1/../snapshot`,
    `${BASE}/c//c1/releases/r1/snapshot`,
    `${BASE}/c/c1//releases/r1/snapshot`,
    `${IMMUTABLE}/extra`,
    `${IMMUTABLE}/`,
    `${BASE}/C/c1/releases/r1/snapshot`,
    `${BASE}/c/c1/releases/r1/SNAPSHOT`,
  ])(`[negative] rejects non-canonical or case-altered path %s [evidence:${evidence}]`, (url) => {
    expect(isImmutableReleaseSnapshotUrl(url)).toBe(false);
    expect(buildReleasePublishedFeedEvent(releaseInput(url), validators)).toEqual({
      ok: false,
      code: 'mutable_snapshot_url',
    });
    expect(discriminateFeedEvent(releaseEvent(url), validators)).toEqual({
      valid: false,
      code: 'mutable_snapshot_url',
      path: '/data/snapshotUrl',
    });
  });

  it(`[negative] rejects a path segment containing an undecodable percent escape [evidence:${evidence}]`, () => {
    const url = `${BASE}/c/c1/releases/%ZZ/snapshot`;
    expect(isImmutableReleaseSnapshotUrl(url)).toBe(false);
    expect(buildReleasePublishedFeedEvent(releaseInput(url), validators)).toEqual({
      ok: false,
      code: 'invalid_snapshot_url',
    });
    expect(discriminateFeedEvent(releaseEvent(url), validators)).toEqual({
      valid: false,
      code: 'schema_invalid',
      path: '/data/snapshotUrl',
    });
  });

  it(`[negative] rejects mutable /snapshot URLs even when query parameters contain release paths or text [evidence:${evidence}]`, () => {
    const urls = [
      `${BASE}/c/${COLLECTION_ID}/snapshot?next=/c/${COLLECTION_ID}/releases/${RELEASE_ID}/snapshot`,
      `${BASE}/c/${COLLECTION_ID}/snapshot?resource=releases/${RELEASE_ID}/snapshot`,
    ];
    for (const url of urls) {
      expect(isImmutableReleaseSnapshotUrl(url)).toBe(false);
      expect(buildReleasePublishedFeedEvent(releaseInput(url), validators)).toEqual({
        ok: false,
        code: 'mutable_snapshot_url',
      });
      expect(discriminateFeedEvent(releaseEvent(url), validators)).toEqual({
        valid: false,
        code: 'mutable_snapshot_url',
        path: '/data/snapshotUrl',
      });
    }
  });

  it.each([
    { collectionId: 'c2', releaseId: RELEASE_ID },
    { collectionId: COLLECTION_ID, releaseId: 'r2' },
    { collectionId: 'C1', releaseId: RELEASE_ID },
    { collectionId: COLLECTION_ID, releaseId: 'R1' },
  ])(`[negative] rejects Builder and Discriminator when Event Data IDs differ from URL path IDs: %o [evidence:${evidence}]`, (ids) => {
    const built = buildReleasePublishedFeedEvent(releaseInput(IMMUTABLE, ids), validators);
    expect(built).toEqual({ ok: false, code: 'snapshot_identity_mismatch' });

    const discriminated = discriminateFeedEvent(releaseEvent(IMMUTABLE, ids), validators);
    expect(discriminated).toEqual({
      valid: false,
      code: 'snapshot_identity_mismatch',
      path: '/data/snapshotUrl',
    });
  });
});
