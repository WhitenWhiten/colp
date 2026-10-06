import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discriminateFeedEvent } from '../../src/feed/event-contracts.js';
import { projectFeedEvent } from '../../src/feed/projection.js';
import {
  buildReleasePublishedFeedEvent,
  isImmutableReleaseSnapshotUrl,
} from '../../src/feed/release-event.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = 'feed.release-snapshot';
const validators = createValidatorRegistry();
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

const DIGEST = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
const IMMUTABLE =
  'https://alice.example/collections/c/019b3ca2-8424-7cc2-9a61-4bf44c23f07a/releases/release-r_1042/snapshot';
const ENVELOPE_IMMUTABLE =
  'https://alice.example/collections/c/collection-1/releases/r1/snapshot';
const MUTABLE_COLLECTION_SNAPSHOT =
  'https://alice.example/collections/c/collection-1/snapshot';

function releasePublishedEnvelope(overrides: {
  snapshotUrl?: string;
  snapshotDigest?: string;
}): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
    source: 'https://alice.example/collections',
    type: 'org.collectionprotocol.release.published.v1',
    subject: 'collections/c/collection-1/releases/r1',
    time: '2026-07-16T06:30:00Z',
    datacontenttype: 'application/json',
    collectionprotocolversion: '0.1',
    data: {
      collectionId: 'collection-1',
      revision: 'r_1',
      changes: { created: 0, updated: 1, moved: 0, deleted: 0 },
      releaseId: 'r1',
      snapshotUrl: overrides.snapshotUrl ?? ENVELOPE_IMMUTABLE,
      snapshotDigest: overrides.snapshotDigest ?? DIGEST,
    },
  };
}

describe(`FEED-0004 release.published immutable snapshot [evidence:${evidence}]`, () => {
  it(`[success] builds release.published with immutable URL + digest [evidence:${evidence}]`, () => {
    const result = buildReleasePublishedFeedEvent(
      {
        id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
        source: 'https://alice.example/collections',
        subject: 'collections/c/019b3ca2-8424-7cc2-9a61-4bf44c23f07a/releases/release-r_1042',
        time: '2026-07-16T06:30:00Z',
        collectionId: '019b3ca2-8424-7cc2-9a61-4bf44c23f07a',
        revision: 'r_1042',
        releaseId: 'release-r_1042',
        snapshotUrl: IMMUTABLE,
        snapshotDigest: DIGEST,
        changes: { created: 2, updated: 1, moved: 3, deleted: 0 },
        summary: 'Added two component-system references.',
      },
      validators,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.type).toBe('org.collectionprotocol.release.published.v1');
      const data = result.event.data as unknown as Record<string, unknown>;
      expect(data.snapshotUrl).toBe(IMMUTABLE);
      expect(data.snapshotDigest).toBe(DIGEST);
      expect(data.releaseId).toBe('release-r_1042');
      expect(validators.validate('feedEvent', result.event)).toEqual({ valid: true, errors: [] });
      // Builder output must also pass the primary discrimination boundary.
      const disc = discriminateFeedEvent(result.event, validators);
      expect(disc.valid).toBe(true);
    }
  });

  it(`[success] accepts the public-feed.json release snapshot shape [evidence:${evidence}]`, async () => {
    const feed = JSON.parse(await readFile(resolve(fixturesRoot, 'public-feed.json'), 'utf8')) as {
      events: Array<Record<string, unknown> & { data: Record<string, unknown> }>;
    };
    const event = feed.events[0]!;
    const data = event.data;
    expect(isImmutableReleaseSnapshotUrl(data.snapshotUrl)).toBe(true);
    expect(typeof data.snapshotDigest).toBe('string');
    expect(String(data.snapshotDigest).length).toBeGreaterThan(0);
    const disc = discriminateFeedEvent(event, validators);
    expect(disc.valid).toBe(true);
  });

  it(`[negative] rejects mutable collection /snapshot alone [evidence:${evidence}]`, () => {
    expect(isImmutableReleaseSnapshotUrl(MUTABLE_COLLECTION_SNAPSHOT)).toBe(false);
    const result = buildReleasePublishedFeedEvent(
      {
        id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
        source: 'https://alice.example/collections',
        subject: 'collections/c/collection-1/releases/r1',
        time: '2026-07-16T06:30:00Z',
        collectionId: 'collection-1',
        revision: 'r_1',
        releaseId: 'r1',
        snapshotUrl: MUTABLE_COLLECTION_SNAPSHOT,
        snapshotDigest: DIGEST,
        changes: { created: 0, updated: 0, moved: 0, deleted: 0 },
      },
      validators,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('mutable_snapshot_url');
  });

  it(`[negative] discriminateFeedEvent rejects mutable collection /snapshot [evidence:${evidence}]`, () => {
    // Schema-valid release.published envelope with mutable /snapshot alone must fail the wire boundary.
    const event = releasePublishedEnvelope({ snapshotUrl: MUTABLE_COLLECTION_SNAPSHOT });
    expect(validators.validate('feedEvent', event).valid).toBe(true);
    const disc = discriminateFeedEvent(event, validators);
    expect(disc.valid).toBe(false);
    if (!disc.valid) {
      expect(disc.code).toBe('mutable_snapshot_url');
      expect(disc.path).toBe('/data/snapshotUrl');
    }
  });

  it(`[negative] projectFeedEvent rejects mutable collection /snapshot (no ok:true leak) [evidence:${evidence}]`, () => {
    const event = releasePublishedEnvelope({ snapshotUrl: MUTABLE_COLLECTION_SNAPSHOT });
    const projected = projectFeedEvent(event, { validators });
    expect(projected.ok).toBe(false);
    if (!projected.ok) expect(projected.code).toBe('event_contract_failed');
  });

  it(`[negative] discriminateFeedEvent rejects malformed snapshot digest [evidence:${evidence}]`, () => {
    const event = releasePublishedEnvelope({ snapshotDigest: 'not-a-digest' });
    const disc = discriminateFeedEvent(event, validators);
    expect(disc.valid).toBe(false);
    if (!disc.valid) {
      expect(disc.code).toBe('invalid_snapshot_digest');
      expect(disc.path).toBe('/data/snapshotDigest');
    }
  });

  it(`[negative] rejects missing or malformed digest [evidence:${evidence}]`, () => {
    const base = {
      id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
      source: 'https://alice.example/collections',
      subject: 'collections/c/c1/releases/r1',
      time: '2026-07-16T06:30:00Z',
      collectionId: 'collection-1',
      revision: 'r_1',
      releaseId: 'r1',
      snapshotUrl: IMMUTABLE,
      changes: { created: 0, updated: 0, moved: 0, deleted: 0 },
    } as const;
    expect(
      buildReleasePublishedFeedEvent({ ...base, snapshotDigest: '' }, validators).ok,
    ).toBe(false);
    const missing = buildReleasePublishedFeedEvent(
      { ...base, snapshotDigest: 'not-a-digest' },
      validators,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('invalid_digest');
  });

  it(`[negative] rejects userinfo snapshot URLs [evidence:${evidence}]`, () => {
    expect(
      isImmutableReleaseSnapshotUrl(
        'https://user:pass@alice.example/c/c1/releases/r1/snapshot',
      ),
    ).toBe(false);
    const disc = discriminateFeedEvent(
      releasePublishedEnvelope({
        snapshotUrl: 'https://user:pass@alice.example/c/c1/releases/r1/snapshot',
      }),
      validators,
    );
    expect(disc.valid).toBe(false);
    // Schema httpUrl rejects userinfo first; runtime guard also rejects if schema were bypassed.
    if (!disc.valid) expect(['schema_invalid', 'mutable_snapshot_url']).toContain(disc.code);
  });

  it(`[boundary] rejects malformed builder input fail closed [evidence:${evidence}]`, () => {
    expect(buildReleasePublishedFeedEvent(null as never, validators).ok).toBe(false);
  });
});
