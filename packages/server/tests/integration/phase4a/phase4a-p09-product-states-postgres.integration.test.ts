/**
 * P4A-P09 PostgreSQL suite (part 1): the REAL Product fixture is REAL.
 *
 * The P4A-P09 anti-false-positive contract says a fixture WITHOUT Product
 * Attachment rows is never sufficient. This suite proves the fixture produced
 * by `p09BuildProductFixture` is genuine owner-private Product data:
 * - every private blob reached its state through the PRODUCTION HTTP flow
 *   (issue -> independent PUT -> complete -> production verification ->
 *   finalize -> replacement / retire), never through direct target-row SQL;
 * - REAL `attachments` rows exist with the terminal logical states
 *   (`attached_private` / `retired` / `deleted`), DB-clock bind times and
 *   retirement/deletion facts;
 * - REAL blob binding facts (`attachment_binding_id`, binding generation,
 *   verified size/digest/media) and generation states (active / retired /
 *   quarantined) exist in the ledger;
 * - the unique private markers live in the REAL stored body bytes on the
 *   object server, so a zero-marker consumer scan is a meaningful deny proof.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  P09_COLLECTION,
  P09_MEDIA_TYPE,
  p09BuildProductFixture,
  type P09Markers,
  type P09ProductFixture,
} from '../../support/phase4a-p09-test-helpers.js';

interface AttachmentRow {
  attachment_id: string;
  blob_id: string;
  collection_id: string;
  logical_state: string;
  retired_at: Date | null;
  deleted_at: Date | null;
}

interface BlobRow {
  blob_id: string;
  logical_state: string;
  current_generation_id: string | null;
  attachment_binding_id: string | null;
  attachment_binding_generation_id: string | null;
  verified_size: string | null;
  media_type: string | null;
}

interface GenerationRow {
  generation_id: string;
  generation_state: string;
  quarantined_at: Date | null;
  retired_at: Date | null;
}

describeWithPostgres('P4A-P09 real Product fixture (attachments rows + ledger facts)', () => {
  let isolated: I07MigrationRuntime;
  let fixture: P09ProductFixture;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p09_product_states', { maxConnections: 14 });
    fixture = await p09BuildProductFixture({
      runtime: isolated,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z'))),
    });
  }, 180_000);

  afterAll(async () => {
    await fixture?.bundle.app.close();
    await fixture?.bundle.store.close();
    await fixture?.objectServer.close();
    await isolated?.dropSchema();
  });

  async function attachmentRow(blobId: string): Promise<AttachmentRow> {
    const rows = await isolated.runtime.pool.query<AttachmentRow>(
      `select attachment_id, blob_id, collection_id, logical_state, retired_at, deleted_at
         from attachments where blob_id = $1`,
      [blobId],
    );
    assert.equal(rows.rowCount, 1, `exactly one attachments row for ${blobId}`);
    return rows.rows[0]!;
  }

  async function blobRow(blobId: string): Promise<BlobRow> {
    const rows = await isolated.runtime.pool.query<BlobRow>(
      `select blob_id, logical_state, current_generation_id, attachment_binding_id,
              attachment_binding_generation_id, verified_size::text, media_type
         from blob_records where blob_id = $1`,
      [blobId],
    );
    assert.equal(rows.rowCount, 1, `exactly one blob_records row for ${blobId}`);
    return rows.rows[0]!;
  }

  async function generationRow(generationId: string): Promise<GenerationRow> {
    const rows = await isolated.runtime.pool.query<GenerationRow>(
      `select generation_id, generation_state, quarantined_at, retired_at
         from blob_generations where generation_id = $1`,
      [generationId],
    );
    assert.equal(rows.rowCount, 1, `exactly one blob_generations row for ${generationId}`);
    return rows.rows[0]!;
  }

  test('REAL attachments rows exist for every finalized private blob with the terminal product states', async () => {
    const markers: P09Markers = fixture.markers;
    const expectations: ReadonlyArray<{ readonly key: keyof P09Markers; readonly state: string }> = [
      { key: 'attached', state: 'attached_private' },
      { key: 'replacedOld', state: 'attached_private' },
      { key: 'replacedNew', state: 'attached_private' },
      { key: 'retired', state: 'retired' },
      { key: 'deleted', state: 'deleted' },
      { key: 'quarantined', state: 'attached_private' },
    ];
    for (const expectation of expectations) {
      const blob = fixture.blobs[expectation.key];
      const row = await attachmentRow(blob.blobId);
      assert.equal(row.collection_id, P09_COLLECTION, `${expectation.key} must bind the control collection`);
      assert.equal(row.logical_state, expectation.state,
        `${expectation.key} attachments row must be ${expectation.state}`);
      if (expectation.state === 'retired') {
        assert.ok(row.retired_at !== null, 'retired attachments row must carry a DB-clock retired_at');
        assert.equal(row.deleted_at, null);
      }
      if (expectation.state === 'deleted') {
        assert.ok(row.deleted_at !== null, 'deleted attachments row must carry a DB-clock deleted_at');
      }
      // The marker lives in the REAL stored body bytes (never in any shared projection).
      const stored = fixture.objectServer.objects.get(blob.key);
      assert.ok(stored, `${expectation.key} real object must exist on the object server`);
      assert.equal(stored.body.includes(markers[expectation.key]), true,
        `${expectation.key} marker must exist in the REAL stored body`);
    }
  });

  test('REAL blob binding + verification facts exist for every fixture blob', async () => {
    const rows = await isolated.runtime.pool.query<{ blob_id: string }>(
      `select blob_id from upload_intents where collection_id = $1`,
      [P09_COLLECTION],
    );
    assert.ok(rows.rowCount !== null && rows.rowCount >= 6, 'the product flow must have issued REAL upload intents for every blob');
    // The replaced blob's row facts describe the CURRENT (new) generation:
    // replacement activates a NEW generation and finalize binds the current
    // generation, so binding/verification facts follow the NEW body while the
    // old generation stays retired. Every other blob binds its own generation.
    const expectedSizeByBlobId = new Map<string, number>();
    const expectedGenerationByBlobId = new Map<string, string>();
    for (const blob of Object.values(fixture.blobs)) {
      expectedSizeByBlobId.set(blob.blobId, blob.body.byteLength);
      expectedGenerationByBlobId.set(blob.blobId, blob.generationId);
    }
    expectedSizeByBlobId.set(fixture.blobs.replacedOld.blobId, fixture.blobs.replacedNew.body.byteLength);
    expectedGenerationByBlobId.set(fixture.blobs.replacedOld.blobId, fixture.blobs.replacedNew.generationId);
    for (const blob of Object.values(fixture.blobs)) {
      const row = await blobRow(blob.blobId);
      const attachment = await attachmentRow(blob.blobId);
      assert.equal(row.attachment_binding_id, attachment.attachment_id,
        `${blob.blobId} blob binding must reference the committed attachments row`);
      assert.ok(row.attachment_binding_id.length > 0,
        `${blob.blobId} must carry a committed attachment binding`);
      assert.equal(row.attachment_binding_generation_id, expectedGenerationByBlobId.get(blob.blobId),
        `${blob.blobId} binding must reference the committed (current) generation`);
      assert.equal(row.verified_size, String(expectedSizeByBlobId.get(blob.blobId)),
        `${blob.blobId} verified size must match the REAL stored bytes of the bound generation`);
      assert.equal(row.media_type, P09_MEDIA_TYPE,
        `${blob.blobId} verified media must be the declared text/plain (never implies clean)`);
    }
  });

  test('REAL generation states: replacement old retired / new active, retire retired, quarantined quarantined', async () => {
    const oldGen = await generationRow(fixture.blobs.replacedOld.generationId);
    assert.equal(oldGen.generation_state, 'retired', 'the old replacement generation must be retired');
    assert.ok(oldGen.retired_at !== null, 'the old replacement generation must carry a DB-clock retired_at');
    const newGen = await generationRow(fixture.blobs.replacedNew.generationId);
    assert.equal(newGen.generation_state, 'active', 'the new replacement generation must be active');
    const retiredGen = await generationRow(fixture.blobs.retired.generationId);
    assert.equal(retiredGen.generation_state, 'retired', 'the retired attachment generation must be retired');
    const quarantinedGen = await generationRow(fixture.blobs.quarantined.generationId);
    assert.equal(quarantinedGen.generation_state, 'quarantined', 'the quarantined generation must be quarantined');
    assert.ok(quarantinedGen.quarantined_at !== null);
    const retiredBlob = await blobRow(fixture.blobs.retired.blobId);
    assert.equal(retiredBlob.current_generation_id, null,
      'the retired attachment must have its current pointer cleared (cleanup candidate)');
    const newBlob = await blobRow(fixture.blobs.replacedNew.blobId);
    assert.equal(newBlob.current_generation_id, fixture.blobs.replacedNew.generationId,
      'the replacement current pointer must point at the NEW generation');
  });

  test('the fixture bodies differ (real bytes per state) and every marker is unique', async () => {
    const markers = Object.values(fixture.markers);
    assert.equal(new Set(markers).size, markers.length, 'every private marker must be unique');
    const bodyTexts = Object.values(fixture.blobs).map((blob) => new TextDecoder().decode(blob.body));
    assert.equal(new Set(bodyTexts).size, bodyTexts.length, 'every stored body must be distinct');
    for (const [key, marker] of Object.entries(fixture.markers)) {
      const blob = fixture.blobs[key as keyof typeof fixture.blobs];
      assert.equal(new TextDecoder().decode(blob.body).includes(marker), true,
        `${key} body bytes must embed the private marker`);
    }
  });
});
