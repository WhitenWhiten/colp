/**
 * P4A-P09 fixture helpers for the focused suites (not a vitest test file: it
 * matches no vitest test pattern and is never listed in a focused config).
 *
 * This file owns the REAL owner-private Product fixture:
 * `p09BuildProductFixture` drives the PRODUCTION HTTP product flow (issue ->
 * independent PUT -> complete -> verification -> finalize ->
 * replacement/retire) with unique private markers embedded in the REAL body
 * bytes, producing REAL `attachments` rows (attached_private / retired /
 * deleted) plus a quarantined generation — the anti-false-positive anchor for
 * P4A-P09 (a fixture without Product Attachment rows is never sufficient).
 *
 * The consumer runners live in `phase4a-p09-consumers.ts` and the PRODUCTION
 * HTTP composition + Publication Redis cache ports live in
 * `phase4a-p09-http-helpers.ts` (per-file line budget).
 *
 * Consumers only depend on the approved eligibility-port symbols and the
 * infrastructure shared-exposure facts port; no leg ever touches a physical
 * key or body (the markers live in the stored body bytes and the row facts,
 * so a leak would be observable in every consumer output).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AttachmentsFeatureConfig } from '../../src/modules/attachments/index.js';
import type { IdentityUnitOfWork } from '../../src/modules/identity/index.js';
import {
  issueTestSession,
  type AuthenticatedTestClient,
} from './product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from './better-auth-test-factory.js';
import {
  I12_SUBJECT_OWNER,
  controlMarker,
  privateMarker,
  seedControlCollection,
  seedProfile,
  seedSyncSession,
  type I12SyncSession,
} from './phase4a-i12-test-helpers.js';
import {
  p07Finalize,
  p07ReplaceAndVerify,
  p07Retire,
  p07UploadToStored,
  type P07UploadedGeneration,
} from './phase4a-p07-test-helpers.js';
import { P08ObjectServer, p08Config } from './phase4a-p08-test-helpers.js';
import { buildP03App, type P03AppBundle } from './phase4a-p03-test-helpers.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export const P09_ISSUER = 'https://issuer.example';
export const P09_ORIGIN = 'https://app.known.example';
export const P09_COLLECTION = 'p09-control-collection';
/** The unique media declaration outside the verification SAFE allowlist: the
 * fixture bodies are plain text markers, so text/plain never implies a clean
 * verdict while the product flow still accepts the declaration. */
export const P09_MEDIA_TYPE = 'text/plain';
export const P09_POLICY_VERSION = 'p09-policy-v1';
export const P09_SYNC_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const P09_MCP_SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
export const P09_MCP_AUDIENCE = 'https://collections.example.test/collections/-/mcp';
export const P09_MCP_OAUTH_ISSUER = 'https://issuer.example.test/realms/known';
export const P09_PROFILE_SUBJECT = 'p09-profile-subject';
export const P09_NOW = new Date('2026-08-08T12:00:00.000Z');

export interface P09Markers {
  readonly attached: string;
  readonly replacedOld: string;
  readonly replacedNew: string;
  readonly retired: string;
  readonly deleted: string;
  readonly quarantined: string;
}

export interface P09ProductFixture {
  readonly bundle: P03AppBundle;
  readonly objectServer: P08ObjectServer;
  /** The module `AttachmentsFeatureConfig` the fixture was built with. */
  readonly attachmentsConfig: AttachmentsFeatureConfig;
  readonly owner: AuthenticatedTestClient;
  readonly collectionId: string;
  readonly controlNodeTitle: string;
  /** The profile subject's OWN public control collection (profile leg control). */
  readonly profileHandle: string;
  readonly profileCollectionId: string;
  readonly markers: P09Markers;
  readonly blobs: {
    readonly attached: P07UploadedGeneration;
    readonly replacedOld: P07UploadedGeneration;
    readonly replacedNew: P07UploadedGeneration;
    readonly retired: P07UploadedGeneration;
    readonly deleted: P07UploadedGeneration;
    readonly quarantined: P07UploadedGeneration;
  };
  readonly session: I12SyncSession;
}

/** Unique private marker body bytes for one fixture blob (real bytes, real rows). */
export function p09Body(marker: string): Uint8Array {
  return new TextEncoder().encode(`p09-private-body:${marker}:${randomUUID()}`);
}

/**
 * Drives the REAL Product fixture through the PRODUCTION HTTP flow:
 * issue -> independent PUT -> complete -> production verification ->
 * finalize (attachments row) -> replacement (old retired / new active THEN
 * finalize binds the NEW current generation) / retire (attachments row
 * retired). Terminal facts (deleted attachment, quarantined generation) are
 * legal fixture flips on REAL product rows (the same practice R06/P07 use);
 * the marker always lives in the REAL body bytes.
 */
export async function p09BuildProductFixture(input: {
  readonly runtime: I07MigrationRuntime;
  readonly databaseUrl: string;
  readonly identityUnitOfWork: IdentityUnitOfWork;
}): Promise<P09ProductFixture> {
  const { runtime, databaseUrl, identityUnitOfWork } = input;
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const objectServer = new P08ObjectServer();
  const objectServerUrl = await objectServer.start();
  const baseConfig = p08Config();
  const config: AttachmentsFeatureConfig = {
    ...baseConfig,
    r2: { ...baseConfig.r2, endpoint: objectServerUrl },
  };
  const bundle = buildP03App({
    runtime: runtime.runtime,
    databaseUrl,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    objectServerUrl,
    attachmentsConfig: config,
  });
  const owner = await issueTestSession({
    factory,
    subject: I12_SUBJECT_OWNER,
    handle: `p09_owner_${randomUUID().slice(0, 8)}`,
  });
  const collectionId = P09_COLLECTION;
  // The collection owner must be the uploader's ACCOUNT subject id (the OIDC
  // callback maps the provider subject to a fresh opaque local subject_id):
  // the canonical finalize/retire mutations check
  // `collections.owner_subject_id === actor.subjectId` directly. The sync
  // account (`seedSyncSession`, subject I12_SUBJECT_OWNER) then needs its own
  // membership row, since the sync session issuer and the replica scope
  // resolve role from owner-match OR `collection_members`.
  const seeded = await seedControlCollection(runtime.runtime, {
    collectionId,
    ownerSubjectId: owner.subjectId,
    controlNodeTitle: controlMarker('p09-control'),
  });
  // Legal fixture pre-data: the collection owner's own membership row plus
  // the sync account's membership row (the i12 control-collection seed only
  // creates the collection + control node; the product upload/finalize/retire
  // routes and the sync session issuer/replica scope gate on
  // `collection_members` / owner-subject).
  await runtime.runtime.pool.query(
    `insert into collection_members (collection_id, subject_id, role, granted_at)
     values ($1, $2, 'owner', now()), ($1, $3, 'owner', now())`,
    [collectionId, owner.subjectId, I12_SUBJECT_OWNER],
  );
  const profile = await seedProfile(runtime.runtime, {
    subjectId: P09_PROFILE_SUBJECT,
    handle: `p09_profile_${randomUUID().slice(0, 8)}`,
    displayName: 'P09 Profile Owner',
  });
  const profileCollectionId = `p09-profile-col-${randomUUID().slice(0, 12)}`;
  await seedControlCollection(runtime.runtime, {
    collectionId: profileCollectionId,
    ownerSubjectId: P09_PROFILE_SUBJECT,
    controlNodeTitle: controlMarker('p09-profile-control'),
  });

  const markers: P09Markers = {
    attached: privateMarker('p09-attached'),
    replacedOld: privateMarker('p09-retired-old'),
    replacedNew: privateMarker('p09-retired-new'),
    retired: privateMarker('p09-retired'),
    deleted: privateMarker('p09-deleted'),
    quarantined: privateMarker('p09-quarantined'),
  };
  const uploadToStored = async (marker: string): Promise<P07UploadedGeneration> => {
    const uploaded = await p07UploadToStored(bundle.app, owner, runtime.runtime, {
      collectionId,
      body: p09Body(marker),
      mediaType: P09_MEDIA_TYPE,
    });
    return uploaded;
  };
  const uploadAndFinalize = async (marker: string): Promise<P07UploadedGeneration> => {
    const uploaded = await uploadToStored(marker);
    const finalized = await p07Finalize(bundle.app, owner, uploaded.blobId, randomUUID());
    assert.equal(finalized.statusCode, 200, finalized.body);
    return uploaded;
  };

  const attached = await uploadAndFinalize(markers.attached);
  // Replacement old/new: upload -> replace (old generation retired, new
  // generation active) -> finalize. The finalize is part of the canonical
  // Product flow (P07 retire suite: upload -> replace -> finalize -> retire)
  // and binds the NEW current generation, so the REAL `attachments` row for
  // this blob is `attached_private` while the old generation stays retired.
  const replacedOld = await uploadToStored(markers.replacedOld);
  const replacedNew = await p07ReplaceAndVerify(
    bundle.app, owner, runtime.runtime, replacedOld.blobId, p09Body(markers.replacedNew), P09_MEDIA_TYPE,
  );
  const replacedFinalize = await p07Finalize(bundle.app, owner, replacedOld.blobId, randomUUID());
  assert.equal(replacedFinalize.statusCode, 200, replacedFinalize.body);
  const retired = await uploadAndFinalize(markers.retired);
  const retiredResult = await p07Retire(bundle.app, owner, retired.blobId, randomUUID());
  assert.equal(retiredResult.statusCode, 200, retiredResult.body);
  const deleted = await uploadAndFinalize(markers.deleted);
  const deletedFlip = await runtime.runtime.pool.query(
    `update attachments
        set logical_state = 'deleted', deleted_at = now(), updated_at = now()
      where blob_id = $1 and logical_state = 'attached_private'`,
    [deleted.blobId],
  );
  assert.equal(deletedFlip.rowCount, 1, 'the deleted terminal attachment must exist on a REAL product row');
  const quarantined = await uploadAndFinalize(markers.quarantined);
  const quarantineFlip = await runtime.runtime.pool.query(
    `update blob_generations
        set generation_state = 'quarantined', quarantined_at = now(),
            quarantined_reason = 'p09-contract-corruption-fixture'
      where generation_id = $1`,
    [quarantined.generationId],
  );
  assert.equal(quarantineFlip.rowCount, 1, 'the quarantined generation must exist on a REAL generation row');

  const session = await seedSyncSession(runtime.runtime, { collectionId, suffix: randomUUID() });
  return {
    bundle,
    objectServer,
    attachmentsConfig: config,
    owner,
    collectionId,
    controlNodeTitle: seeded.controlNodeTitle,
    profileHandle: profile.handle,
    profileCollectionId,
    markers,
    blobs: {
      attached,
      replacedOld,
      replacedNew,
      retired,
      deleted,
      quarantined,
    },
    session,
  };
}
