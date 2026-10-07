/**
 * P4A-P06 focused PostgreSQL suite (part 2): finalize concealment, response
 * loss, API restart, consumer exclusion and the request gate.
 *
 * Same production composition as part 1
 * (phase4a-p06-finalize-http-postgres.integration.test.ts) but with a
 * DEDICATED isolated schema: the concealment matrix mutates collections
 * (revocation, soft-delete), so it must never share state with the
 * side-effect proofs.
 *
 * Covers the P06 test scope:
 * - concealment matrix: outsider / member non-owner / foreign Collection /
 *   revoked owner / deleted Collection all receive the BYTE-IDENTICAL 404
 *   (zero body variation, no redirect), anonymous is 401, and every denial
 *   leaves zero rows and zero ledger reservations;
 * - a member non-owner uploader can never finalize their own blob: concealed
 *   for the uploader AND the Collection owner;
 * - response loss (client abort while the canonical transaction commits) and
 *   API restart both converge to already_finalized with the original receipt;
 * - the finalize Operation never enters Sync/Publication outputs: the
 *   production sync stream gate (sync_wire_json IS NULL) holds, a REAL sync
 *   pull over the same Collection serves a visible control operation with
 *   zero Attachment markers, and the shared-exposure facts port (R06)
 *   returns the explicit ineligible verdict for the attached blob;
 * - missing or malformed Known-Command-Id and query parameters are rejected
 *   before any work.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import type { AddressInfo } from 'node:net';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  P03_ORIGIN,
  buildP03App,
  makeP03Config,
  type P03FinalizeSeams,
} from '../../support/phase4a-p03-test-helpers.js';
import {
  deleteP02Collection,
  readAttachmentRow,
  readLedgerIds,
  readOutboxRows,
} from '../../support/phase4a-p02-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { identityFor, BarrierGroup } from '../../support/phase4a-i07-test-helpers.js';
import {
  appendOperationWithPayload,
  createPostgresSharedExposureFactsPort,
} from '../../../src/infrastructure/database/index.js';
import { assessSharedExposureScope, assertSharedExposureScopeIneligible } from '../../../src/modules/attachments/index.js';
import { createPostgresSyncPullReadPort } from '../../../src/infrastructure/sync/index.js';
import { createSyncPullCursorKeyring } from '../../../src/modules/sync/index.js';
import { seedSyncSession, I12_SUBJECT_OWNER, controlMarker, assertControlVisible, assertMarkerAbsentFromJson } from '../../support/phase4a-i12-test-helpers.js';
import {
  P06_COLLECTION_A,
  P06_COLLECTION_B,
  P06_COLLECTION_C,
  P06_COLLECTION_OTHER,
  expectedP06AttachmentId,
  finalizeHeaders,
  p06BlobOwnerOf,
  p06BlobOutboxHandlerNames,
  p06FinalizeOperationCount,
  readP06FinalizeOperationByCommandId,
  seedP06Collection,
  seedP06StoredPrivate,
} from '../../support/phase4a-p06-test-helpers.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const CONFIG = makeP03Config();

interface FinalizeResultBody {
  kind: 'finalized' | 'already_finalized';
  blobId: string;
  logicalState: string;
}

interface FinalizeProblem {
  error: {
    code: string;
    message: string;
    requestId: string;
    recovery: string;
    sameRequestRetrySafe: boolean;
    precondition: unknown;
    currentEtag: unknown;
    retryAfterSeconds: unknown;
    fieldErrors: Array<{ path: string; code: string; message: string }>;
  };
}

const CONCEALED_404 = {
  code: 'resource_not_found',
  message: 'The requested Attachment resource was not found.',
  recovery: 'none',
  sameRequestRetrySafe: false,
  precondition: null,
  currentEtag: null,
  retryAfterSeconds: null,
  fieldErrors: [],
} as const;

function assertConcealed404(response: { statusCode: number; headers: Record<string, unknown>; body: string }): void {
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(typeof response.headers['x-request-id'], 'string');
  const problem = (JSON.parse(response.body) as FinalizeProblem).error;
  assert.deepEqual(
    {
      code: problem.code,
      message: problem.message,
      recovery: problem.recovery,
      sameRequestRetrySafe: problem.sameRequestRetrySafe,
      precondition: problem.precondition,
      currentEtag: problem.currentEtag,
      retryAfterSeconds: problem.retryAfterSeconds,
      fieldErrors: problem.fieldErrors,
    },
    CONCEALED_404,
    'every concealed 404 must carry the identical stable external Problem',
  );
}

function finalizeUrl(blobId: string): string {
  return `/api/v1/attachments/${encodeURIComponent(blobId)}/finalize`;
}

describeWithPostgres('P4A-P06 finalize concealment and recovery', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let otherOwner: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p06_finalize_concealment', { maxConnections: 12 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p06-owner', handle: 'p06_owner' });
    editor = await issueTestSession({
      factory,
      subject: 'p06-editor', handle: 'p06_editor' });
    outsider = await issueTestSession({
      factory,
      subject: 'p06-outsider', handle: 'p06_outsider' });
    otherOwner = await issueTestSession({
      factory,
      subject: 'p06-other-owner', handle: 'p06_other' });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: editor.subjectId, role: 'editor' },
      ],
    });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_B,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    // Dedicated collection for the revocation case (mutated by the
    // concealment matrix, never reused by later tests).
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_C,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    await seedP06Collection(isolated.runtime, {
      collectionId: P06_COLLECTION_OTHER,
      ownerSubjectId: otherOwner.subjectId,
      members: [{ subjectId: otherOwner.subjectId, role: 'owner' }],
    });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function newApp(seams?: P03FinalizeSeams) {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: 'http://127.0.0.1:1',
      attachmentsConfig: CONFIG,
      ...(seams === undefined ? {} : { finalizeSeams: seams }),
    });
  }

  test('concealment matrix: outsider, member non-owner, foreign Collection, revoked owner and deleted Collection all get the identical 404 with zero side effects', async () => {
    const id = identityFor(311);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const foreignId = identityFor(312);
    await seedP06StoredPrivate(isolated.runtime, foreignId, p06BlobOwnerOf(otherOwner), P06_COLLECTION_OTHER);
    const revokedId = identityFor(313);
    await seedP06StoredPrivate(isolated.runtime, revokedId, p06BlobOwnerOf(owner), P06_COLLECTION_C);
    const deletedId = identityFor(314);
    await seedP06StoredPrivate(isolated.runtime, deletedId, p06BlobOwnerOf(owner), P06_COLLECTION_B);
    // Revoke (P06_COLLECTION_C only): the collection is handed to another
    // owner AND the old owner's membership is removed — a real revocation,
    // not a membership-row shortcut the policy would ignore for the owner
    // subject. The dedicated collection keeps later tests on collection A
    // intact.
    await isolated.runtime.pool.query(
      `update collections set owner_subject_id = $1 where id = $2`,
      [otherOwner.subjectId, P06_COLLECTION_C],
    );
    await isolated.runtime.pool.query(
      `delete from collection_members where collection_id = $1 and subject_id = $2`,
      [P06_COLLECTION_C, owner.subjectId],
    );
    // Deleted collection (P06_COLLECTION_B): soft-deleted like production
    // (the root node and the collection row in ONE transaction — the deferred
    // collections_root_lifecycle_integrity constraint requires the pair).
    await deleteP02Collection(isolated.runtime, P06_COLLECTION_B);
    const ledgerBefore = await readLedgerIds(isolated.runtime);

    const bundle = newApp();
    try {
      const cases: Array<{ label: string; client: AuthenticatedTestClient | null; blobId: string }> = [
        { label: 'outsider', client: outsider, blobId: id.blobId },
        { label: 'member non-owner', client: editor, blobId: id.blobId },
        { label: 'owner of another Collection', client: owner, blobId: foreignId.blobId },
        { label: 'revoked owner', client: owner, blobId: revokedId.blobId },
        { label: 'deleted Collection owner', client: owner, blobId: deletedId.blobId },
        { label: 'nonexistent blob', client: owner, blobId: `p06-does-not-exist-${randomUUID()}` },
      ];
      for (const entry of cases) {
        const headers = entry.client === null ? { origin: P03_ORIGIN, 'content-type': 'application/json' }
          : finalizeHeaders(entry.client, randomUUID());
        const response = await bundle.app.inject({
          method: 'POST', url: finalizeUrl(entry.blobId), headers, payload: '{}',
        });
        assertConcealed404(response);
      }
      // Anonymous is an authentication boundary, not a resource answer.
      const anonymous = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId),
        headers: { origin: P03_ORIGIN, 'content-type': 'application/json', 'known-command-id': randomUUID() },
        payload: '{}',
      });
      assert.equal(anonymous.statusCode, 401);
      assert.equal((anonymous.json() as FinalizeProblem).error.code, 'authentication_required');

      // Zero side effects across every denial.
      assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null);
      assert.equal(await readAttachmentRow(isolated.runtime, foreignId.blobId), null);
      assert.equal(await readAttachmentRow(isolated.runtime, revokedId.blobId), null);
      assert.equal(await readAttachmentRow(isolated.runtime, deletedId.blobId), null);
      assert.deepEqual(await readLedgerIds(isolated.runtime), ledgerBefore, 'no denial may reserve any ledger id');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a member non-owner uploader can never finalize their own blob: concealed for the uploader AND the Collection owner', async () => {
    const id = identityFor(315);
    // The blob is OWNED by the editor (uploaded as a member); the canonical
    // contract requires the finalizer to be the Collection owner AND the blob
    // owner, so both identities are concealed.
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(editor));
    const bundle = newApp();
    try {
      for (const client of [editor, owner]) {
        const response = await bundle.app.inject({
          method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(client, randomUUID()), payload: '{}',
        });
        assertConcealed404(response);
      }
      assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('response loss: the canonical commit lands, the aborted client retry replays already_finalized', { timeout: 60_000 }, async () => {
    const id = identityFor(316);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const group = new BarrierGroup();
    const barrier = { arriveAndWait: (name: string) => group.arriveAndWait(`loss:${name}`) };
    const bundle = newApp({ barrier });
    try {
      await bundle.app.listen({ host: '127.0.0.1', port: 0 });
      const address = bundle.app.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      // The request parks sequentially through the canonical barriers (the
      // Collection lock, then the handoff lock AFTER the blob binding write)
      // so the abort happens while the transaction is still open; the commit
      // still lands afterwards.
      const controller = new AbortController();
      const attempt = fetch(`${baseUrl}${finalizeUrl(id.blobId)}`, {
        method: 'POST',
        headers: finalizeHeaders(owner, commandId),
        body: '{}',
        signal: controller.signal,
      }).then(
        () => undefined,
        () => undefined,
      );
      await group.waitArrived('loss:attachment_collection_locked');
      group.release('loss:attachment_collection_locked');
      await group.waitArrived('loss:after_finalize_handoff_lock');
      controller.abort();
      group.release('loss:after_finalize_handoff_lock');
      await attempt;

      // The commit landed despite the lost response: the retry replays the
      // original receipt with exactly one committed side-effect set.
      const retry = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(retry.statusCode, 200, retry.body);
      const body = retry.json() as FinalizeResultBody;
      assert.equal(body.kind, 'already_finalized');
      assert.equal(body.blobId, id.blobId);
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 1);
      assert.equal((await readOutboxRows(isolated.runtime, id.blobId)).length, 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('API restart: a finalize committed before restart replays identically afterwards', async () => {
    const id = identityFor(317);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const first = newApp();
    let firstBody: FinalizeResultBody;
    try {
      const response = await first.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(response.statusCode, 200);
      firstBody = response.json() as FinalizeResultBody;
    } finally {
      await first.app.close();
      await first.store.close();
    }
    const second = newApp();
    try {
      const replay = await second.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(replay.statusCode, 200, replay.body);
      const body = replay.json() as FinalizeResultBody;
      assert.equal(body.kind, 'already_finalized');
      assert.deepEqual({ blobId: body.blobId, logicalState: body.logicalState },
        { blobId: firstBody.blobId, logicalState: firstBody.logicalState });
      assert.equal(await p06FinalizeOperationCount(isolated.runtime, commandId), 1);
    } finally {
      await second.app.close();
      await second.store.close();
    }
  });

  test('the finalize Operation never enters Sync/Publication outputs while the control link stays visible', async () => {
    const id = identityFor(318);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const commandId = randomUUID();
    const bundle = newApp();
    try {
      const response = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId), headers: finalizeHeaders(owner, commandId), payload: '{}',
      });
      assert.equal(response.statusCode, 200);
      const attachmentId = expectedP06AttachmentId(owner.accountId, id.blobId, commandId);
      const operation = await readP06FinalizeOperationByCommandId(isolated.runtime, commandId);
      assert.ok(operation);

      // 1. The production sync-stream gate: the finalize Operation is written
      //    with no Sync wire payload, so the pull query can never select it.
      const syncRows = await sql<{ sync_wire_present: boolean }>`
        select sync_wire_present from operations where operation_id = ${operation.operationId}
      `.execute(isolated.runtime.db);
      assert.equal(syncRows.rows[0]?.sync_wire_present, false,
        'the finalize Operation must never be wired into the sync stream');

      // 2. A REAL sync pull over the SAME Collection: a visible control
      //    operation is served while every Attachment marker stays absent.
      await isolated.runtime.pool.query(
        `insert into collection_members (collection_id, subject_id, role, granted_at)
         values ($1, $2, 'viewer', now()) on conflict do nothing`,
        [P06_COLLECTION_A, I12_SUBJECT_OWNER],
      );
      const session = await seedSyncSession(isolated.runtime, {
        collectionId: P06_COLLECTION_A, suffix: randomUUID(),
      });
      const controlOpId = `p06-pull-op-${randomUUID()}`;
      const controlMarkerValue = controlMarker('p06-control');
      await isolated.runtime.pool.query(
        `insert into resource_id_ledger (resource_id, resource_type) values ($1, 'operation')`,
        [controlOpId],
      );
      const controlOrdinal = BigInt((await isolated.runtime.pool.query<{ ordinal: string }>(
        `select coalesce(max(commit_ordinal),0)+1 as ordinal from operations where collection_id=$1`,
        [P06_COLLECTION_A],
      )).rows[0]!.ordinal);
      await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(
        transaction, {
          operationId: controlOpId, collectionId: P06_COLLECTION_A,
          commitOrdinal: controlOrdinal, operationType: 'sync.node.update', payloadJson: {},
          actorPrincipalId: session.credential.subject, syncWireJson: {
          opId: controlOpId,
          replicaId: session.replicaId,
          sequence: 1,
          collectionId: P06_COLLECTION_A,
          type: 'update_node_content',
          targetId: `p06-pull-target-${randomUUID()}`,
          baseRevision: 'target-r1',
          occurredAt: '2026-08-08T12:00:00.000Z',
          payload: { base: { title: 'Root' }, value: { title: controlMarkerValue } },
          },
        },
      ));
      const keys = createSyncPullCursorKeyring({
        active: { id: `p06-pull-read-${randomUUID()}`, secret: Buffer.alloc(32, 88).toString('base64') },
        retained: [], ttlMs: 300_000,
      });
      try {
        const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys);
        const page = await port.read({
          credential: session.credential,
          sessionId: session.sessionId,
          collectionId: P06_COLLECTION_A,
          replicaId: session.replicaId,
          cursor: null,
          limit: 100,
        });
        const serialized = JSON.stringify(page.events);
        assertControlVisible(serialized, controlMarkerValue, 'sync pull');
        for (const marker of [attachmentId, operation.operationId, id.blobId]) {
          assertMarkerAbsentFromJson(page.events, marker, `sync pull events must never contain ${marker}`);
        }
      } finally {
        keys.destroy();
      }

      // 3. The shared-exposure facts port (R06): the attached blob is
      //    explicitly ineligible for every shared consumer.
      const factsPort = createPostgresSharedExposureFactsPort(isolated.runtime);
      const verdicts = await assessSharedExposureScope(factsPort, { collectionId: P06_COLLECTION_A, blobIds: [id.blobId] });
      assert.ok(verdicts.length >= 1, 'the facts port must resolve the real blob');
      assertSharedExposureScopeIneligible(verdicts);

      // 4. Publication output surface: the canonical mutation wrote NO
      //    projection-visible representation change (no node rows, no content
      //    revision, no publication outbox event).
      const nodes = await sql<{ count: string }>`
        select count(*)::text as count from nodes where collection_id = ${P06_COLLECTION_A}
      `.execute(isolated.runtime.db);
      assert.equal(Number(nodes.rows[0]!.count), 1, 'only the root node exists (no attachment projection)');
      const content = await sql<{ content_revision: string }>`
        select content_revision from collections where id = ${P06_COLLECTION_A}
      `.execute(isolated.runtime.db);
      assert.equal(content.rows[0]!.content_revision, 'content-p06-collection-a', 'finalize never bumps the content revision');
      const handlers = await p06BlobOutboxHandlerNames(isolated.runtime, id.blobId);
      assert.deepEqual(
        [...new Set(handlers)].sort(),
        ['attachments_finalize_attachment', 'attachments_verify_generation'],
        'only the finalize event and the pre-existing verification fence exist — no publication/purge/sync event',
      );
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('missing or malformed Known-Command-Id and query parameters are rejected before any work', async () => {
    const id = identityFor(319);
    await seedP06StoredPrivate(isolated.runtime, id, p06BlobOwnerOf(owner));
    const bundle = newApp();
    try {
      const missing = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId),
        headers: { cookie: owner.cookie, origin: P03_ORIGIN, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
        payload: '{}',
      });
      assert.equal(missing.statusCode, 400);
      assert.equal((missing.json() as FinalizeProblem).error.code, 'invalid_request');

      const malformed = await bundle.app.inject({
        method: 'POST', url: finalizeUrl(id.blobId),
        headers: finalizeHeaders(owner, 'not-a-uuid'), payload: '{}',
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal((malformed.json() as FinalizeProblem).error.code, 'invalid_request');

      const withQuery = await bundle.app.inject({
        method: 'POST', url: `${finalizeUrl(id.blobId)}?page=1`,
        headers: finalizeHeaders(owner, randomUUID()), payload: '{}',
      });
      assert.equal(withQuery.statusCode, 400);
      assert.equal((withQuery.json() as FinalizeProblem).error.code, 'invalid_request');

      assert.equal(await readAttachmentRow(isolated.runtime, id.blobId), null, 'no rejected request may finalize');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });
});
