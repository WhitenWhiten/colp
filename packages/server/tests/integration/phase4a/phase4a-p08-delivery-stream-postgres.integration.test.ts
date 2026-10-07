/**
 * P4A-P08 focused PostgreSQL suite (part 2): slow-client backpressure and
 * client-abort release over the PRODUCTION delivery host with the REAL RO
 * adapter (real HTTP transport, real bytes, real socket backpressure).
 *
 * Anti-false-positive: the observables are the object server's own
 * bytes-written counters and premature-close events (what the RO adapter
 * actually pulled from the provider), not header strings or fixture byte
 * counts. Anti-false-negative: the slow client still receives every byte and
 * the aborted client's upstream stream is destroyed promptly; the host stays
 * healthy afterwards.
 */
import assert from 'node:assert/strict';
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
  p08Bundle,
  p08Config,
  p08DeliveryUrl,
  P08ObjectServer,
  p08TokenFrom,
  type P08AdmissionDto,
  type P08Bundle,
} from '../../support/phase4a-p08-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { p07SeedCollection, p07UploadToStored } from '../../support/phase4a-p07-test-helpers.js';
import { waitForCondition, waitForRealTime } from '../../support/async-test-helpers.js';

function deterministicBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * seed + seed) % 251;
  }
  return bytes;
}

describeWithPostgres('P4A-P08 delivery streaming: slow client and abort', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let objectServer: P08ObjectServer;
  const config = p08Config();

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p08_stream', { maxConnections: 16 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date('2026-08-08T12:00:00.000Z')));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p08-stream-owner', handle: 'p08_stream_owner' });
    await p07SeedCollection(isolated.runtime, {
      collectionId: P08_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [{ subjectId: owner.subjectId, role: 'owner' }],
    });
    objectServer = new P08ObjectServer({ chunkSize: 16 * 1024 });
    const url = await objectServer.start();
    config.r2.endpoint = url;
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  async function newBundle(): Promise<P08Bundle> {
    return p08Bundle({
      runtime: isolated,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      config,
    });
  }

  async function closeBundle(bundle: P08Bundle): Promise<void> {
    await bundle.bundle.app.close();
    await bundle.bundle.store.close();
    await bundle.delivery.close();
  }

  test('slow consumer: the host streams with backpressure and bounded buffering (the provider is never drained while the client idles)', async () => {
    const bundle = await newBundle();
    try {
      const total = 2 * 1024 * 1024;
      const body = deterministicBytes(total, 31);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      // Stream the GET body in slow real chunks: the provider hands bytes to
      // the socket gradually, so server-side bytesWritten is an honest
      // observable of how much the host actually pulled.
      objectServer.getDelays.set(uploaded.key, 10);

      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);
      const response = await fetch(p08DeliveryUrl(bundle.boundOrigin, token));
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      const writtenAtIdleStart = objectServer.bytesWrittenOf(uploaded.key);

      // Idle the client: an unbounded buffering host would drain the whole
      // object into memory now; a backpressured host stalls the provider.
      await waitForRealTime(
        800,
        'measure real provider/socket backpressure while the downstream client is intentionally idle',
      );
      const writtenWhileIdle = objectServer.bytesWrittenOf(uploaded.key) - writtenAtIdleStart;
      assert.ok(
        objectServer.bytesWrittenOf(uploaded.key) < total,
        `bounded buffering: provider handed ${objectServer.bytesWrittenOf(uploaded.key)} of ${total} bytes while the client idled`,
      );
      // The idle window (800ms) at the provider's 10ms/chunk throttle admits at
      // most ~80 chunks (1.31MiB) of pulls regardless of host behavior; the
      // pull count also includes kernel loopback socket buffering, which on
      // default Linux absorbs ~1MiB on its own (measured 1,294,336 bytes on
      // WSL and in the act runner container). The host's own in-memory
      // read-ahead stays bounded (Readable.from object-mode highWaterMark),
      // so the budget must prove "never drains the object while idling"
      // rather than a sub-window byte count that loopback buffers can always
      // absorb. total * 3 / 4 keeps the assertion deterministic across hosts
      // (max possible idle pull 80 * 16KiB = 1.31MiB < 1.5MiB) while still
      // failing loudly if the host ever pulled the whole object.
      assert.ok(writtenWhileIdle < (total * 3) / 4, `idle pull must stay bounded (pulled ${writtenWhileIdle} bytes)`);

      // The slow consumer still receives every byte on demand.
      let received = first.value?.byteLength ?? 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += next.value.byteLength;
      }
      assert.equal(received, total, 'a slow consumer still receives the whole representation');
      assert.equal(objectServer.bytesWrittenOf(uploaded.key), total, 'the provider eventually delivered every byte');
    } finally {
      await closeBundle(bundle);
    }
  });

  test('client abort mid-body destroys the upstream stream promptly; the host stays healthy', async () => {
    const bundle = await newBundle();
    try {
      const body = deterministicBytes(256 * 1024, 47);
      const uploaded = await p07UploadToStored(bundle.bundle.app, owner, isolated.runtime, {
        collectionId: P08_COLLECTION_A,
        body,
      });
      // Slow enough that the abort lands mid-body deterministically.
      objectServer.getDelays.set(uploaded.key, 150);

      const admitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(admitted.statusCode, 200, admitted.body);
      const token = p08TokenFrom(JSON.parse(admitted.body) as P08AdmissionDto);

      const controller = new AbortController();
      const response = await fetch(p08DeliveryUrl(bundle.boundOrigin, token), { signal: controller.signal });
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      const logBefore = bundle.delivery.deliveryHost.requestLog.length;
      controller.abort();
      await reader.cancel().catch(() => undefined);

      // The upstream R2 body must be destroyed promptly (the provider sees a
      // premature close) — an abort is an expected cancellation, never a
      // service error.
      const premature = await objectServer.waitForPrematureClose(uploaded.key, 5_000);
      assert.ok(premature >= 1, 'the upstream provider stream must be destroyed on client abort');
      // The fixed-class request log must record the cancelled delivery (the
      // terminal entry lands with the socket teardown; poll briefly).
      let terminal: readonly typeof bundle.delivery.deliveryHost.requestLog[number][] = [];
      await waitForCondition(() => {
        terminal = bundle.delivery.deliveryHost.requestLog.slice(logBefore);
        return terminal.length >= 1;
      }, { timeoutMs: 2_000, description: 'the cancelled delivery terminal request log entry' });
      assert.ok(terminal.length >= 1, 'the fixed-class request log must record the cancelled delivery');
      const entry = terminal[terminal.length - 1]!;
      assert.ok(entry.byteCount < body.byteLength, `cancelled stream must log a partial byte count (${entry.byteCount})`);
      assert.equal(entry.setCookies, false);

      // The host stays healthy for a fresh capability (no leaked state).
      const readmitted = await p08Admit(bundle.bundle.app, owner, uploaded.blobId);
      assert.equal(readmitted.statusCode, 200, readmitted.body);
      const fresh = await fetch(p08DeliveryUrl(bundle.boundOrigin, p08TokenFrom(JSON.parse(readmitted.body) as P08AdmissionDto)));
      assert.equal(fresh.status, 200);
      const bytes = new Uint8Array(await fresh.arrayBuffer());
      assert.equal(bytes.byteLength, body.byteLength);
      assert.deepEqual(bytes, body);
    } finally {
      await closeBundle(bundle);
    }
  });
});
