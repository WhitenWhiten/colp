/**
 * P4A-P04 focused PostgreSQL suite (part 2): the status DTO across every
 * reachable logical/generation state.
 *
 * Every blob is driven through the PRODUCTION ledger ports (allocate ->
 * completeUploadCas -> claimVerification -> completeVerification /
 * quarantineVerification / finalizeHandoff) against REAL PostgreSQL, then read
 * through the production HTTP route as the owner. Terminal attachment
 * metadata (retired/deleted) is prepared as a legal precondition row (the
 * mutations belong to P07) to pin the frozen concealment contract.
 *
 * Anti-false-positive: no state is produced by direct SQL writes to the
 * target state; the owner always reads a REAL blob that the fixture actually
 * drove into the asserted state.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  buildP03App,
  makeP03Config,
  seedP03Collection,
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { identityFor } from '../../support/phase4a-i07-test-helpers.js';
import {
  P04_COLLECTION_A,
  P04_DECLARED_SIZE,
  seedP04AttachedPrivate,
  seedP04Expired,
  seedP04Issued,
  seedP04Quarantined,
  seedP04StoredPrivate,
  seedP04TerminalAttachmentMetadata,
  seedP04Uploaded,
  seedP04Verifying,
} from '../../support/phase4a-p04-test-helpers.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

interface StatusDto {
  blobId: string;
  logicalState: string;
  verificationStatus: string;
  availability: string;
  size: number;
  mediaType: string | null;
  createdAt: string;
  updatedAt: string;
  allowedActions: string[];
}

function assertTimeFacts(dto: StatusDto): void {
  assert.match(dto.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.match(dto.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.ok(Number.isFinite(Date.parse(dto.createdAt)));
  assert.ok(Number.isFinite(Date.parse(dto.updatedAt)));
  assert.ok(dto.createdAt <= dto.updatedAt, 'createdAt must never follow updatedAt');
  assert.ok(Date.parse(dto.createdAt) >= Date.parse('2026-08-01T00:00:00.000Z'),
    'createdAt must be a real DB-clock time, not a fabricated wall clock');
  const nowMs = Date.now();
  assert.ok(Date.parse(dto.updatedAt) <= nowMs + 60_000,
    'updatedAt must not drift more than a minute into the future');
}

describeWithPostgres('P4A-P04 production status route: state matrix', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p04_states', { maxConnections: 12 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p04-owner', handle: 'p04_owner' });
    await seedP03Collection(isolated.runtime, {
      collectionId: P04_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function newApp(): ReturnType<typeof buildP03App> {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: 'http://127.0.0.1:1',
      attachmentsConfig: makeP03Config(),
    });
  }

  const ownerFacts = () => ({ subjectId: owner.subjectId, principalId: owner.accountId });

  async function readStatus(bundle: ReturnType<typeof buildP03App>, blobId: string): Promise<StatusDto> {
    const response = await bundle.app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${encodeURIComponent(blobId)}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    return response.json() as StatusDto;
  }

  test('issued: the owner observes the declared facts and the complete action only', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(201);
      await seedP04Issued(isolated.runtime, id, { owner: ownerFacts(), declaredSize: P04_DECLARED_SIZE });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.blobId, id.blobId);
      assert.equal(dto.logicalState, 'issued');
      assert.equal(dto.verificationStatus, 'pending');
      assert.equal(dto.availability, 'unavailable');
      assert.equal(dto.size, 2048, 'the declared size is the only size fact before verification');
      assert.equal(dto.mediaType, 'image/png', 'the media hint is the only media fact before verification');
      assert.deepEqual(dto.allowedActions, ['complete']);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('uploaded: complete converges, verification has not started', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(202);
      await seedP04Uploaded(isolated.runtime, id, { owner: ownerFacts() });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.logicalState, 'uploaded');
      assert.equal(dto.verificationStatus, 'pending');
      assert.equal(dto.availability, 'unavailable');
      assert.deepEqual(dto.allowedActions, ['complete']);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('verifying: the verification lease progress is observable mid-pipeline', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(203);
      await seedP04Verifying(isolated.runtime, id, { owner: ownerFacts() });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.logicalState, 'verifying');
      assert.equal(dto.verificationStatus, 'verifying');
      assert.equal(dto.availability, 'unavailable');
      assert.deepEqual(dto.allowedActions, ['complete']);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('stored_private: the owner observes the REAL verified size and media', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(204);
      const { body, digest } = await seedP04StoredPrivate(isolated.runtime, id, { owner: ownerFacts() });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.logicalState, 'stored_private');
      assert.equal(dto.verificationStatus, 'verified');
      assert.equal(dto.availability, 'available');
      assert.equal(dto.size, body.byteLength, 'the verified size must be the REAL verified byte count');
      assert.equal(dto.mediaType, 'image/png');
      assert.deepEqual(dto.allowedActions, ['finalize', 'download', 'replace']);
      // verified NEVER implies malware-safety and the digest is never echoed.
      const serialized = JSON.stringify(dto);
      assert.equal(serialized.includes(digest), false, 'the DTO must never echo the digest');
      assert.equal(serialized.includes('clean'), false);
      assert.equal(serialized.includes('safe'), false);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('attached_private: the finalized binding is downloadable and retireable', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(205);
      await seedP04AttachedPrivate(isolated.runtime, id, { owner: ownerFacts() });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.logicalState, 'attached_private');
      assert.equal(dto.verificationStatus, 'verified');
      assert.equal(dto.availability, 'available');
      assert.deepEqual(dto.allowedActions, ['download', 'retire']);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('quarantined: failed verification, unavailable, zero actions, zero capability claims', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(206);
      await seedP04Quarantined(isolated.runtime, id, { owner: ownerFacts() });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.logicalState, 'quarantined');
      assert.equal(dto.verificationStatus, 'failed');
      assert.equal(dto.availability, 'unavailable');
      assert.deepEqual(dto.allowedActions, []);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('expired: never verified, unavailable, zero actions', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(207);
      await seedP04Expired(isolated.runtime, id, { owner: ownerFacts() });
      const dto = await readStatus(bundle, id.blobId);
      assert.equal(dto.logicalState, 'expired');
      assert.equal(dto.verificationStatus, 'pending');
      assert.equal(dto.availability, 'unavailable');
      assert.deepEqual(dto.allowedActions, []);
      assertTimeFacts(dto);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('retired attachment metadata is concealed as the stable 404 even for the owner', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(208);
      await seedP04TerminalAttachmentMetadata(isolated.runtime, id, {
        owner: ownerFacts(),
        terminalState: 'retired',
      });
      const response = await bundle.app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${encodeURIComponent(id.blobId)}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, 404);
      const problem = (response.json() as { error: { code: string; message: string; recovery: string } }).error;
      assert.equal(problem.code, 'resource_not_found');
      assert.equal(problem.message, 'The requested Attachment resource was not found.');
      assert.equal(problem.recovery, 'none');
      assert.equal(response.headers['cache-control'], 'private, no-store');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('deleted attachment metadata (tombstone) is concealed as the stable 404', async () => {
    const bundle = newApp();
    try {
      const id = identityFor(209);
      await seedP04TerminalAttachmentMetadata(isolated.runtime, id, {
        owner: ownerFacts(),
        terminalState: 'deleted',
      });
      const response = await bundle.app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${encodeURIComponent(id.blobId)}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, 404);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
      assert.equal(response.headers['cache-control'], 'private, no-store');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('the same-request fixture shows one owner-visible and one owner-invisible blob', async () => {
    const bundle = newApp();
    try {
      const visible = identityFor(210);
      const invisible = identityFor(211);
      await seedP04StoredPrivate(isolated.runtime, visible, { owner: ownerFacts() });
      await seedP04Issued(isolated.runtime, invisible, {
        owner: { subjectId: 'someone-else', principalId: 'someone-else-account' },
      });
      // Owner requests BOTH in the same fixture: the visible blob returns the
      // real verified facts, the invisible one returns the identical
      // concealed 404 — one request stream proves the read is per-blob.
      const visibleDto = await readStatus(bundle, visible.blobId);
      assert.equal(visibleDto.logicalState, 'stored_private');
      const concealed = await bundle.app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${encodeURIComponent(invisible.blobId)}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(concealed.statusCode, 404);
      assert.equal((concealed.json() as { error: { code: string } }).error.code, 'resource_not_found');
      assert.equal(concealed.headers['cache-control'], 'private, no-store');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });
});
