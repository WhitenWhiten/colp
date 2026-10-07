/**
 * P4A-P08 focused PostgreSQL suite (part 1): owner-private download admission
 * + isolated delivery over the PRODUCTION composition.
 *
 * Boots the PRODUCTION app (`buildApiApp` with the download route port) with
 * REAL PostgreSQL attachments ports, the REAL R2 adapter over a local
 * create-only/GET object server, and the PRODUCTION delivery composition
 * (`composeAttachmentDelivery`: PostgreSQL admission closure + RO-only host
 * with the version-fenced generation resolver). Blobs reach `stored_private`
 * through the REAL routes (issue -> INDEPENDENT HTTP PUT -> complete ->
 * production verification).
 *
 * Covers the P08 test scope (plan §4 anti-false-positive / anti-false-negative):
 * - owner download: the frozen DTO (kind/blobId/generationId/method/
 *   deliveryOrigin/downloadUrl/issuedAt/expiresAt), private,no-store on the
 *   admission response, exact bytes + forced-download/security/cache headers
 *   from the isolated host, and a fresh PostgreSQL admission on EVERY call
 *   (two admissions -> two distinct capabilities, same generation);
 * - range/HEAD/If-None-Match/416 raw HTTP facts;
 * - non-owner/member/outsider/cross-Collection/anonymous/CSRF/Origin zero
 *   leakage (no capability, no key, no downloadUrl in any error body);
 * - revocation: retire after admission -> old capability fails at the host
 *   (version fence) and a new admission is concealed 404;
 * - replacement: old capability can NEVER serve the new generation and fails
 *   by version policy; a fresh admission binds the new generation;
 * - fixed short window: expiry via the shared deterministic clock and replay
 *   bounded by the TTL (replay never extends the window);
 * - cache/credential isolation: delivery responses are private,no-store with
 *   no set-cookie/no redirect; Cookie/Authorization/Referer sent to the host
 *   are observed but NEVER forwarded upstream; the capability cannot be
 *   consumed on the Known application origin.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  p08Admit,
  P08_COLLECTION_A,
  P08_COLLECTION_B,
  P08_COLLECTION_OTHER,
  P08_DELIVERY_ORIGIN,
  p08Body,
  p08Bundle,
  p08Config,
  p08DeliveryUrl,
  P08ObjectServer,
  p08TokenFrom,
  type P08AdmissionDto,
  type P08Bundle,
} from '../../support/phase4a-p08-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { P03_ORIGIN } from '../../support/phase4a-p03-test-helpers.js';
import {
  p07Finalize,
  p07ReplaceAndVerify,
  p07Retire,
  p07SeedCollection,
  p07UploadToStored,
} from '../../support/phase4a-p07-test-helpers.js';

interface ProblemBody {
  error: {
    code: string;
    message: string;
    recovery: string;
    retryAfterSeconds: number | null;
    fieldErrors: Array<{ path: string; code: string; message: string }>;
  };
}

function assertProblem(response: { statusCode: number; body: string }, code: string): ProblemBody['error'] {
  assert.equal(response.statusCode >= 400, true);
  const problem = (JSON.parse(response.body) as ProblemBody).error;
  assert.equal(problem.code, code);
  return problem;
}

/** Decodes the signed capability payload (structure only; verification is the host's job). */
function decodeCapabilityClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describeWithPostgres('P4A-P08 owner-private download admission + isolated delivery', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let otherOwner: AuthenticatedTestClient;
  let objectServer: P08ObjectServer;
  const config = p08Config();

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p08_download', { maxConnections: 16 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z')));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p08-owner', handle: 'p08_owner' });
    editor = await issueTestSession({
      factory,
      subject: 'p08-editor', handle: 'p08_editor' });
    outsider = await issueTestSession({
      factory,
      subject: 'p08-outsider', handle: 'p08_outsider' });
    otherOwner = await issueTestSession({
      factory,
      subject: 'p08-other', handle: 'p08_other' });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P08_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: editor.subjectId, role: 'editor' },
      ],
    });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P08_COLLECTION_B,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P08_COLLECTION_OTHER,
      ownerSubjectId: otherOwner.subjectId,
      members: [{ subjectId: otherOwner.subjectId, role: 'owner' }],
    });
    objectServer = new P08ObjectServer();
    const url = await objectServer.start();
    // Point the module config at the REAL local transport (same bucket/prefix
    // contract the production loader would validate).
    config.r2.endpoint = url;
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  async function newBundle(): Promise<P08Bundle> {
    const bundle = await p08Bundle({
      runtime: isolated,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      config,
    });
    return bundle;
  }

  async function closeBundle(bundle: P08Bundle): Promise<void> {
    await bundle.bundle.app.close();
    await bundle.bundle.store.close();
    await bundle.delivery.close();
  }

  test('owner download end to end: frozen DTO, fresh PostgreSQL admission every time, exact bytes over the isolated host', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(1);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });

      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      assert.equal(admitted.headers['cache-control'], 'private, no-store', 'admission must never be cached');
      const dto = JSON.parse(admitted.body) as P08AdmissionDto;
      assert.equal(dto.kind, 'granted');
      assert.equal(dto.blobId, uploaded.blobId);
      assert.equal(dto.generationId, uploaded.generationId);
      assert.equal(dto.method, 'GET');
      assert.equal(dto.deliveryOrigin, P08_DELIVERY_ORIGIN);
      assert.equal(dto.downloadUrl.startsWith(`${P08_DELIVERY_ORIGIN}/d/`), true);
      const issuedMs = Date.parse(dto.issuedAt);
      const expiresMs = Date.parse(dto.expiresAt);
      assert.equal(expiresMs - issuedMs, 60_000, 'capability window must equal the fixed config TTL');
      const token = p08TokenFrom(dto);
      const claims = decodeCapabilityClaims(token);
      assert.equal(claims.audience, P08_DELIVERY_ORIGIN);
      assert.equal(claims.method, 'GET');
      assert.equal(claims.generationId, uploaded.generationId);
      // Anti-false-positive: the token carries no physical key and no URL.
      assert.equal('key' in claims, false);
      assert.equal('url' in claims, false);

      // A second admission reads PostgreSQL again: distinct nonce, same binding.
      const again = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(again.statusCode, 200, again.body);
      const dto2 = JSON.parse(again.body) as P08AdmissionDto;
      assert.equal(dto2.generationId, uploaded.generationId);
      assert.notEqual(p08TokenFrom(dto2), token, 'each admission must issue a fresh capability');

      // Delivery through the host's ACTUAL bound origin: exact bytes + headers.
      const response = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), { redirect: 'error' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.ok(response.headers.get('content-disposition')?.startsWith('attachment;'), 'forced download');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
      assert.equal(response.headers.get('set-cookie'), null, 'the isolated host never sets a cookie');
      assert.equal(response.headers.get('location'), null, 'never redirects to an R2 URL');
      assert.ok(response.headers.get('etag'), 'exact-key identity is exposed');
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.byteLength, body.byteLength);
      assert.deepEqual(bytes, body, 'the owner receives the exact generation bytes');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('raw HTTP delivery facts: single range 206, unsatisfiable 416, HEAD, If-None-Match 304', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(2);
      assert.ok(body.byteLength > 16, 'fixture must be large enough for range probes');
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);

      const ranged = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), {
        headers: { range: 'bytes=0-3' },
      });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${body.byteLength}`);
      const slice = new Uint8Array(await ranged.arrayBuffer());
      assert.equal(slice.byteLength, 4);
      assert.deepEqual(slice, body.subarray(0, 4));

      const suffix = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), {
        headers: { range: 'bytes=-4' },
      });
      assert.equal(suffix.status, 206);
      const suffixSlice = new Uint8Array(await suffix.arrayBuffer());
      assert.deepEqual(suffixSlice, body.subarray(body.byteLength - 4));

      const unsatisfiable = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), {
        headers: { range: 'bytes=999999999-' },
      });
      assert.equal(unsatisfiable.status, 416);
      assert.equal(await unsatisfiable.text(), '');
      assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${body.byteLength}`);

      const head = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '', 'HEAD must carry no body');
      assert.equal(head.headers.get('content-length'), String(body.byteLength));
      assert.equal(head.headers.get('accept-ranges'), 'bytes');

      const notModified = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), {
        headers: { 'if-none-match': head.headers.get('etag') ?? '' },
      });
      assert.equal(notModified.status, 304);
      assert.equal(await notModified.text(), '');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('non-owner/member/outsider/cross-Collection/anonymous/CSRF/Origin: zero capability, zero key, stable problem', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(3);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      const blobId = uploaded.blobId;

      for (const client of [editor, outsider, otherOwner]) {
        const response = await p08Admit(bundle.bundle.app, client, blobId);
        const problem = assertProblem(response, 'resource_not_found');
        assert.equal(problem.retryAfterSeconds, null);
        assert.doesNotMatch(response.body, /grant|downloadUrl|credential|"key"|token/i, 'concealment body must be clean');
      }

      // Anonymous: the session gate fails closed before any database work.
      const anonymous = await bundle.bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(blobId)}/download`,
        headers: { origin: P03_ORIGIN },
      });
      assertProblem(anonymous, 'authentication_required');

      // Missing CSRF / wrong Origin with a real session: 403 csrf_failed.
      const noCsrf = await bundle.bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(blobId)}/download`,
        headers: { cookie: owner.cookie, origin: P03_ORIGIN },
      });
      assertProblem(noCsrf, 'csrf_failed');
      const wrongOrigin = await bundle.bundle.app.inject({
        method: 'POST',
        url: `/api/v1/attachments/${encodeURIComponent(blobId)}/download`,
        headers: { cookie: owner.cookie, origin: 'https://evil.example', 'x-csrf-token': owner.csrfToken },
      });
      assertProblem(wrongOrigin, 'csrf_failed');

      // The capability cannot be consumed on the Known application origin.
      const admitted = await p08Admit(bundle.bundle.app, owner, blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);
      const appOriginAttempt = await bundle.bundle.app.inject({
        method: 'GET',
        url: `/d/${token}`,
      });
      assert.equal(appOriginAttempt.statusCode, 404, 'the app origin must never serve delivery URLs');
      assert.doesNotMatch(appOriginAttempt.body, /p08-body/, 'no object bytes may leak through the app origin');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('revocation: retire after admission makes the old capability fail at the host and a new admission concealed', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(4);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);

      // Delivery BEFORE revocation works (sanity).
      const before = await fetch(p08DeliveryUrl(bundle.boundOrigin, token));
      assert.equal(before.status, 200);

      // Canonical revocation path: finalize (stored_private -> attached_private),
      // then the retire command (attached_private -> retired, pointer cleared).
      // Finalize ALONE must not revoke an in-window capability; only the
      // retirement does. The OLD capability then fails by version policy.
      const finalized = await p07Finalize(bundle.bundle.app, owner, uploaded.blobId, randomUUID());
      assert.equal(finalized.statusCode, 200, finalized.body);
      const afterFinalize = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), { redirect: 'error' });
      assert.equal(afterFinalize.status, 200, 'finalize must not revoke an in-window capability');
      const retired = await p07Retire(bundle.bundle.app, owner, uploaded.blobId, randomUUID());
      assert.equal(retired.statusCode, 200, retired.body);
      const after = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), { redirect: 'error' });
      assert.equal(after.status, 404, 'revoked capability must resolve to nothing');
      assert.equal(await after.text(), '');
      assert.equal(after.headers.get('location'), null);

      // A fresh admission re-reads PostgreSQL and is concealed.
      const readmitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assertProblem(readmitted, 'resource_not_found');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('replacement: the old capability fails by version policy and never serves the new generation; a fresh admission binds the new generation', async () => {
    const bundle = await newBundle();
    try {
      const oldBody = p08Body(5);
      const newBody = p08Body(6);
      assert.notEqual(oldBody.byteLength, newBody.byteLength);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body: oldBody,
      });
      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const oldToken = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);

      // Replacement: new generation + new physical key, old generation retired.
      const replaced = await p07ReplaceAndVerify(bundle.bundle.app, owner, isolated.runtime, uploaded.blobId, newBody);
      assert.notEqual(replaced.generationId, uploaded.generationId);

      // The OLD capability cannot serve ANY bytes (version fence: the old
      // generation is no longer current/active) — and never the new bytes.
      const oldAttempt = await fetch(p08DeliveryUrl(bundle.boundOrigin, oldToken), { redirect: 'error' });
      assert.equal(oldAttempt.status, 404, 'old capability fails by version policy after replacement');
      assert.equal(await oldAttempt.text(), '');

      // A fresh admission resolves the CURRENT generation and serves its bytes.
      const readmitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(readmitted.statusCode, 200, readmitted.body);
      const dto = JSON.parse(readmitted.body) as P08AdmissionDto;
      assert.equal(dto.generationId, replaced.generationId, 'admission always resolves the current generation');
      const newToken = p08TokenFrom(dto);
      const newAttempt = await fetch(p08DeliveryUrl(bundle.boundOrigin, newToken));
      assert.equal(newAttempt.status, 200);
      const bytes = new Uint8Array(await newAttempt.arrayBuffer());
      assert.deepEqual(bytes, newBody, 'the new capability serves exactly the new generation bytes');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('fixed short window: expiry via the shared deterministic clock; replay is bounded by the TTL and never extends it', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(7);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);

      // Replay WITHIN the fixed short window is inherently valid (the max
      // exposure window IS the TTL) — same token, same bytes.
      const first = await fetch(p08DeliveryUrl(bundle.boundOrigin, token));
      assert.equal(first.status, 200);
      const second = await fetch(p08DeliveryUrl(bundle.boundOrigin, token));
      assert.equal(second.status, 200, 'replay within the TTL serves the same representation');
      const firstBytes = new Uint8Array(await first.arrayBuffer());
      const secondBytes = new Uint8Array(await second.arrayBuffer());
      assert.deepEqual(firstBytes, secondBytes);

      // Advance the shared clock past the fixed window: the SAME capability
      // is now expired — replay does not extend the window.
      bundle.clock.advance(61_000);
      const expired = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), { redirect: 'error' });
      assert.equal(expired.status, 404, 'a replayed capability must fail once the fixed short window passes');
      assert.equal(await expired.text(), '');

      // A FRESH admission (still within the fixed policy) issues a new
      // capability that the host accepts at the advanced time.
      const readmitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(readmitted.statusCode, 200, readmitted.body);
      const fresh = await fetch(p08DeliveryUrl(bundle.boundOrigin, p08TokenFrom(JSON.parse(readmitted.body) as P08AdmissionDto)));
      assert.equal(fresh.status, 200, 'a fresh admission restores delivery under the fixed policy');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('credential/cache isolation: Cookie/Authorization/Referer are observed but never forwarded; responses are no-store with no set-cookie', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(8);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);
      const key = uploaded.key;
      const upstreamBefore = objectServer.requests.filter((r) => r.method === 'GET').length;

      const response = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), {
        headers: {
          cookie: 'known_session=p08-leak-attempt',
          authorization: 'Bearer p08-bearer',
          referer: 'http://127.0.0.1/p08',
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
      assert.equal(response.headers.get('location'), null);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(bytes, body);

      // The host OBSERVED the credentials (fixed request log)...
      const logEntry = bundle.delivery.deliveryHost.requestLog[bundle.delivery.deliveryHost.requestLog.length - 1];
      assert.ok(logEntry);
      assert.equal(logEntry.receivedCookies, true);
      assert.equal(logEntry.receivedAuthorization, true);
      assert.equal(logEntry.receivedReferer, true);
      assert.equal(logEntry.setCookies, false);
      // ...but the UPSTREAM GET carries none of them (the RO adapter signs
      // its own headers only; cookie/auth/referer are never forwarded).
      const upstreamGets = objectServer.requests.slice(upstreamBefore).filter((r) => r.method === 'GET' && r.path.includes(key));
      assert.ok(upstreamGets.length >= 1, 'the RO adapter must read the exact key');
      for (const upstream of upstreamGets) {
        assert.equal(upstream.headers.cookie, undefined, 'application cookie must never reach the object store');
        assert.equal(upstream.headers.referer, undefined, 'Referer must never reach the object store');
        // The RO adapter signs its OWN SigV4 requests (that is the RO
        // credential doing its job); the application's Authorization (the
        // Bearer token the client sent to the delivery host) must never be
        // forwarded upstream.
        const authorization = upstream.headers.authorization;
        assert.equal(
          typeof authorization === 'string' && authorization.startsWith('AWS4-HMAC-SHA256'),
          true,
          'the only Authorization at the object store is the RO adapter own SigV4 signature',
        );
        assert.equal(
          String(authorization).includes('p08-bearer'),
          false,
          'the application Bearer token must never reach the object store',
        );
      }
    } finally {
      await closeBundle(bundle);
    }
  });

  test('attached_private blobs stay downloadable; finalize does not open the body to non-owners', async () => {
    const bundle = await newBundle();
    try {
      const body = p08Body(9);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      const finalized = await p07Finalize(bundle.bundle.app, owner, uploaded.blobId, randomUUID());
      assert.equal(finalized.statusCode, 200, finalized.body);

      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const response = await fetch(p08DeliveryUrl(bundle.boundOrigin, p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto)));
      assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(bytes, body);

      // Finalize never widens the admission: a member non-owner stays 404.
      const denied = await p08Admit(bundle.bundle.app, editor, uploaded.blobId);
      assertProblem(denied, 'resource_not_found');
    } finally {
      await closeBundle(bundle);
    }
  });
});
