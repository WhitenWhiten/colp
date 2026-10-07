/**
 * P4A-I12 PostgreSQL integration: Profile/Manifest generation projection
 * exclusion + shared-link registry absence.
 *
 * With a REAL private blob seeded through the production ledger (unique marker
 * inside the physical generation key rows and stored bytes) plus a visible
 * public profile with a control collection, every Profile/Manifest public
 * entry — Publication Manifest generation
 * (`createPublicationManifestCandidate`) and the public Profile projection
 * (`getPublicProfileProjection` over the production PostgreSQL ports) — must:
 *   (a) actually execute (the manifest/control profile+collection are served);
 *   (b) NEVER contain any private marker.
 *
 * The shared-link consumer surface does not exist in the production
 * composition, so the contract is proven at the eligibility gate: every
 * REAL seeded blob (stored_private / attached_private / retired / expired /
 * quarantined) is explicitly denied for `shared_link` exposure.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresPublicProfileFactsReadPort,
} from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresPublicationDirectoryReadPort,
} from '../../../src/infrastructure/publication/index.js';
import { createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import {
  assessSharedExposureEligibility,
  SHARED_EXPOSURE_PROJECTION_KINDS,
} from '../../../src/modules/attachments/index.js';
import {
  createPublicationCursorKeyring,
  createPublicationManifestCandidate,
} from '../../../src/modules/publication/index.js';
import { getPublicProfileProjection } from '../../../src/bootstrap/public-profile-projection.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  I12_SUBJECT_OWNER,
  assertControlVisible,
  assertMarkerAbsentFromJson,
  controlMarker,
  i12BlobIdentity,
  privateMarker,
  seedAttachedPrivate,
  seedControlCollection,
  seedExpiredBlob,
  seedProfile,
  seedQuarantinedGeneration,
  seedRetiredGeneration,
  seedStoredPrivate,
} from '../../support/phase4a-i12-test-helpers.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';

describeWithPostgres('P4A-I12 Profile/Manifest generation + shared-link absence', () => {
  let isolated: I07MigrationRuntime;
  let controlCollectionId: string;
  const privateMarkers = {
    stored: privateMarker('i12-profile-stored'),
    attached: privateMarker('i12-profile-attached'),
    retiredOld: privateMarker('i12-profile-retired-old'),
    retiredNew: privateMarker('i12-profile-retired-new'),
    expired: privateMarker('i12-profile-expired'),
    quarantined: privateMarker('i12-profile-quarantined'),
  };

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_i12_profile', { maxConnections: 10 });
    await seedProfile(isolated.runtime, { subjectId: I12_SUBJECT_OWNER, handle: 'i12_owner' });
    controlCollectionId = `i12-profile-control-${randomUUID().slice(0, 8)}`;
    await seedControlCollection(isolated.runtime, {
      collectionId: controlCollectionId,
      ownerSubjectId: I12_SUBJECT_OWNER,
      title: controlMarker('i12-profile-control-title'),
      controlNodeTitle: controlMarker('i12-profile-control-node'),
    });

    let slot = 0;
    const next = () => { slot += 1; return slot; };
    await seedStoredPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.stored));
    await seedAttachedPrivate(isolated.runtime, i12BlobIdentity(next(), privateMarkers.attached));
    await seedRetiredGeneration(
      isolated.runtime,
      i12BlobIdentity(next(), privateMarkers.retiredOld),
      i12BlobIdentity(next(), privateMarkers.retiredNew),
    );
    await seedExpiredBlob(isolated.runtime, i12BlobIdentity(next(), privateMarkers.expired));
    await seedQuarantinedGeneration(isolated.runtime, i12BlobIdentity(next(), privateMarkers.quarantined));
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('Publication Manifest generation serves its fixed control fields with zero private marker', () => {
    const config = {
      origin: 'https://known.example',
      mountPath: '/colp/v0.1/',
      serverUuid: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      title: 'I12 Manifest',
      maxPageSize: 100,
      maxSnapshotNodes: 200,
      endpoints: {
        directory: 'https://known.example/colp/v0.1/directory',
        collection: 'https://known.example/colp/v0.1/collections/{collectionId}',
        snapshot: 'https://known.example/colp/v0.1/collections/{collectionId}/snapshot',
      },
    };
    const candidate = createPublicationManifestCandidate(config, ['directory', 'collection', 'snapshot']);
    const serialized = JSON.stringify(candidate.manifest);
    assert.equal(serialized.includes('I12 Manifest'), true, 'manifest control title must be served');
    assert.equal(serialized.includes('https://known.example'), true);
    for (const marker of Object.values(privateMarkers)) {
      assert.equal(serialized.includes(marker), false, `manifest must never contain ${marker}`);
    }
  });

  test('public Profile generation serves the control profile + collection with zero private marker', async () => {
    const cursors = createPublicationCursorKeyring({
      active: { id: `i12-profile-${randomUUID()}`, secret: Buffer.alloc(32, 71).toString('base64') },
      retained: [],
    });
    try {
      const result = await getPublicProfileProjection({
        profiles: createPostgresPublicProfileFactsReadPort(isolated.runtime),
        collections: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors,
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      }, { handle: 'i12_owner', limit: 50 });
      assert.equal(result.profile.handle, 'i12_owner', 'control profile must be served');
      assert.equal(result.profile.displayName, 'I12 Owner');
      assert.ok(result.collections.some((collection) => collection.id === controlCollectionId),
        'control public collection must be served (link executed)');
      const serialized = JSON.stringify(result);
      for (const marker of Object.values(privateMarkers)) {
        assert.equal(serialized.includes(marker), false, `profile projection must never contain ${marker}`);
      }
    } finally {
      cursors.destroy();
    }
  });

  test('shared-link creation has no production surface; every REAL seeded blob is denied at the eligibility gate', async () => {
    // There is no shared-link registry module (verified by the architecture
    // scan). While that consumer surface does not exist, the contract is the
    // explicit deny-by-default eligibility verdict for the shared_link kind.
    assert.ok(SHARED_EXPOSURE_PROJECTION_KINDS.includes('shared_link'));
    const rows = await isolated.runtime.pool.query<{
      blob_id: string; logical_state: string; generation_state: string | null;
    }>(
      `select b.blob_id, b.logical_state, g.generation_state
         from blob_records b
         left join blob_generations g on g.generation_id = b.current_generation_id
        order by b.blob_id`,
    );
    assert.ok(rows.rows.length >= 5, 'the real seed must contain every state variant (5 blob records)');
    for (const row of rows.rows) {
      const verdict = assessSharedExposureEligibility({
        blobId: row.blob_id,
        logicalState: row.logical_state as 'stored_private',
        currentGenerationState: row.generation_state as 'active' | null,
      });
      assert.equal(verdict.eligible, false, `shared-link must deny blob ${row.blob_id} (${row.logical_state}/${row.generation_state})`);
      assert.equal(verdict.reason, 'no_content_safety_evidence');
      assert.equal(verdict.exposureMode, 'owner-private-unscanned');
    }
  });

  test('Profile generation handles a missing handle normally while the control profile still works', async () => {
    const cursors = createPublicationCursorKeyring({
      active: { id: `i12-profile-missing-${randomUUID()}`, secret: Buffer.alloc(32, 72).toString('base64') },
      retained: [],
    });
    try {
      const ports = {
        profiles: createPostgresPublicProfileFactsReadPort(isolated.runtime),
        collections: createPostgresPublicationDirectoryReadPort(isolated.runtime),
        cursors,
        sharedExposure: createPostgresSharedExposureFactsPort(isolated.runtime),
      };
      await assert.rejects(
        () => getPublicProfileProjection(ports, { handle: 'i12_missing_handle', limit: 20 }),
        /not found|resource_not_found/iu,
      );
      const still = await getPublicProfileProjection(ports, { handle: 'i12_owner', limit: 20 });
      assert.equal(still.profile.handle, 'i12_owner');
      assertControlVisible(still, controlCollectionId, 'profile after normal not-found');
    } finally {
      cursors.destroy();
    }
  });
});
