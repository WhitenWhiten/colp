/**
 * P4A-V4A-05 focused real-HTTP suite (plan §4 V4A-05): the delivery
 * capability URL is a bearer secret.
 *
 * Child-process part: the REAL isolated delivery executable
 * (`src/bootstrap/delivery-main.ts` / `dist` build when present) as an
 * independent OS process driven ONLY through its discovery/readiness
 * protocol (same helper pattern as V4A-04). Every delivery request is a real
 * HTTP request over the child's listening socket. The suite asserts that the
 * full status matrix — success (200/206/304/HEAD), denials
 * (404/403/405/413/416), upstream failure (503), Fastify 404 fallback and
 * framework-level 400/414 — carries `Referrer-Policy: no-referrer`,
 * `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` with
 * zero-body errors, then scans the child stdout/stderr and every response
 * body for a unique marker capability (zero hits). Corner cases: URL-encoded
 * tokens, double slashes, query/fragment, and proxy raw-URI fields.
 *
 * In-process part: the production `composeDeliveryHost` over a real
 * listening socket with fixture dependencies, covering the paths the child
 * cannot reach deterministically: a 500 from a throwing resolver and a 503
 * whose upstream error carries a deep cause chain (marker-shaped), plus the
 * fixed-class request-log serialization scan.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  describeWithPostgres,
  requireTestDatabaseUrl,
} from '../../support/postgres-test-runtime.js';
import { P03_BUCKET, P03_RO_CREDENTIAL } from '../../support/phase4a-p03-test-helpers.js';
import {
  P08_DELIVERY_ORIGIN,
  P08_DELIVERY_SECRET,
  P08_LIVE_PREFIX,
  P08ObjectServer,
  sha256Hex,
} from '../../support/phase4a-p08-test-helpers.js';
import { createHmacOwnerDeliveryCapabilitySigner } from '../../../src/modules/attachments/index.js';
import type {
  DeliveryGenerationResolver,
  GenerationHeadOutcome,
  GenerationObjectHandle,
  GenerationObjectStorePort,
} from '../../../src/modules/attachments/index.js';
import {
  DELIVERY_PROCESS_READINESS_PATH,
  startDeliveryProcess,
  stopDeliveryProcess,
  waitForDeliveryListening,
  waitForDeliveryReadiness,
  type DeliveryProcessHandle,
} from '../../support/phase4a-delivery-process-helpers.js';
import { composeDeliveryHost, type DeliveryHost } from '../../../src/bootstrap/delivery.js';
import {
  FixtureDeliveryObjectStore,
  fixtureResolver,
  i11Config,
  plainBytes,
} from '../../support/phase4a-i11-test-helpers.js';

const OWNER_SUBJECT_ID = 'v4a05-owner';
const ROLE_PASSWORD = 'delivery_ro_test_only';

/** The three URL-secret headers every delivery response must carry. */
function assertUrlSecretHeaders(response: Response): void {
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.get('cache-control')?.includes('no-store'),
    `cache-control must include no-store (got ${response.headers.get('cache-control')})`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

/** The three URL-secret headers plus a zero body (denial responses). */
async function assertUrlSecretZeroBody(response: Response, expectedStatus: number): Promise<void> {
  assert.equal(response.status, expectedStatus);
  assertUrlSecretHeaders(response);
  assert.equal(await response.text(), '', `${expectedStatus} must be zero-body`);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

describeWithPostgres('P4A-V4A-05 delivery capability URL security (real child process + real HTTP)', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P08ObjectServer;
  let administrator: Pool;
  let roleName: string;
  let readOnlyDatabaseUrl: string;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_delivery_url_security', { maxConnections: 16 });
    objectServer = new P08ObjectServer();
    await objectServer.start();

    const databaseUrl = requireTestDatabaseUrl();
    const dbName = new URL(databaseUrl).pathname.slice(1);
    roleName = `delivery_ro_${randomUUID().replaceAll('-', '_')}`;
    administrator = new Pool({ connectionString: databaseUrl, max: 1 });
    await administrator.query(`create role ${roleName} login password '${ROLE_PASSWORD}'`);
    await administrator.query(`grant connect on database ${quoteIdent(dbName)} to ${roleName}`);
    await administrator.query(`grant usage on schema ${quoteIdent(isolated.schema)} to ${roleName}`);
    await administrator.query(
      `grant select on ${quoteIdent(isolated.schema)}.blob_records, `
      + `${quoteIdent(isolated.schema)}.blob_generations to ${roleName}`,
    );
    const readOnly = new URL(isolated.databaseUrl);
    readOnly.username = roleName;
    readOnly.password = ROLE_PASSWORD;
    readOnlyDatabaseUrl = readOnly.toString();
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    if (administrator) {
      await administrator.query(`drop role if exists ${roleName}`).catch(() => undefined);
      await administrator.end();
    }
    await isolated?.dropSchema();
  });

  /** Child environment: ALL secrets via env; dedicated read-only DSN. */
  function deliveryEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      PRODUCT_ORIGIN: 'http://127.0.0.1:3000',
      ATTACHMENTS_ENABLED: 'true',
      ATTACHMENTS_R2_ENDPOINT: objectServer.url,
      ATTACHMENTS_R2_REGION: 'auto',
      ATTACHMENTS_R2_BUCKET: P03_BUCKET,
      ATTACHMENTS_R2_LIVE_PREFIX: P08_LIVE_PREFIX,
      ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/',
      ATTACHMENTS_R2_RW_SECRET_REF: 'known/p08/r2/rw',
      ATTACHMENTS_R2_RO_SECRET_REF: 'known/p08/r2/ro',
      ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: P08_DELIVERY_ORIGIN,
      ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/p08/delivery/hmac',
      ATTACHMENTS_R2_RO_ACCESS_KEY_ID: P03_RO_CREDENTIAL.accessKeyId,
      ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY: P03_RO_CREDENTIAL.secretAccessKey,
      ATTACHMENTS_DELIVERY_CAPABILITY_HMAC: P08_DELIVERY_SECRET.toString('utf8'),
      ATTACHMENTS_DELIVERY_DATABASE_URL: readOnlyDatabaseUrl,
      ATTACHMENTS_DELIVERY_HOST: '127.0.0.1',
      ATTACHMENTS_DELIVERY_PORT: '0',
      ATTACHMENTS_DELIVERY_SHUTDOWN_TIMEOUT_MS: '10000',
      ...overrides,
    };
  }

  async function uploadObject(key: string, body: Uint8Array): Promise<string> {
    const response = await fetch(`${objectServer.url}/${P03_BUCKET}/${key}`, {
      method: 'PUT',
      headers: { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' },
      body,
    });
    assert.equal(response.status, 200, await response.text());
    const etag = response.headers.get('etag');
    assert.ok(etag, 'object PUT must return an ETag');
    return etag;
  }

  async function seedActiveGeneration(input: {
    blobId: string;
    generationId: string;
    key: string;
    etag: string;
    body: Uint8Array;
  }): Promise<void> {
    const fingerprint = sha256Hex(input.key);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
         values ($1, $2, $3, $4, 'allocate')`,
        [input.generationId, input.key, fingerprint, input.blobId],
      );
      await client.query(
        `insert into blob_records
           (blob_id, owner_subject_id, logical_state, current_generation_id,
            verified_size, verified_sha256, media_type, verification_policy_version)
         values ($1, $2, 'stored_private', $3, $4, $5, 'application/octet-stream', $6)`,
        [input.blobId, OWNER_SUBJECT_ID, input.generationId, input.body.byteLength, sha256Hex(input.body),
          'phase4a-i09-policy-v1'],
      );
      await client.query(
        `insert into blob_generations
           (generation_id, blob_id, bucket, key, key_fingerprint, generation_state,
            observed_etag, observed_size, observed_content_type)
         values ($1, $2, $3, $4, $5, 'active', $6, $7, 'application/octet-stream')`,
        [input.generationId, input.blobId, P03_BUCKET, input.key, fingerprint, input.etag, input.body.byteLength],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  function capabilityFor(
    blobId: string,
    generationId: string,
    options: { ttlSeconds?: number; now?: Date; audience?: string; nonce?: string } = {},
  ): string {
    return createHmacOwnerDeliveryCapabilitySigner({
      secret: P08_DELIVERY_SECRET,
      audienceOrigin: options.audience ?? P08_DELIVERY_ORIGIN,
    }).sign({
      blobId,
      generationId,
      ownerSubject: OWNER_SUBJECT_ID,
      ttlSeconds: options.ttlSeconds ?? 60,
      now: options.now,
      nonce: options.nonce,
    }).token;
  }

  async function startReadyProcess(env: NodeJS.ProcessEnv = deliveryEnv()): Promise<{ handle: DeliveryProcessHandle; origin: string }> {
    const handle = startDeliveryProcess(env);
    const origin = await waitForDeliveryListening(handle);
    await waitForDeliveryReadiness(`${origin}${DELIVERY_PROCESS_READINESS_PATH}`, 15_000);
    return { handle, origin };
  }

  /** Seeds an object and returns its capability-bound identity + token. */
  async function seedServedObject(marker: string): Promise<{
    blobId: string;
    generationId: string;
    key: string;
    body: Uint8Array;
    token: string;
  }> {
    const blobId = `blob-${marker}`;
    const generationId = `gen-${marker}`;
    const key = `${P08_LIVE_PREFIX}v4a05-${marker}-${randomUUID()}`;
    const body = new TextEncoder().encode(`v4a05-body-${marker}-${'z'.repeat(128)}`);
    const etag = await uploadObject(key, body);
    await seedActiveGeneration({ blobId, generationId, key, etag, body });
    return { blobId, generationId, key, body, token: capabilityFor(blobId, generationId) };
  }

  test('success matrix: 200, 206, 304 and HEAD all carry no-referrer/no-store/nosniff over real HTTP', { timeout: 60_000 }, async () => {
    const marker = `ok-${randomUUID()}`;
    const object = await seedServedObject(marker);
    const { handle, origin } = await startReadyProcess();
    try {
      const base = `${origin}/d/${object.token}`;

      const full = await fetch(base);
      assert.equal(full.status, 200);
      assertUrlSecretHeaders(full);
      assert.deepEqual(new Uint8Array(await full.arrayBuffer()), object.body);

      const ranged = await fetch(base, { headers: { range: 'bytes=0-9' } });
      assert.equal(ranged.status, 206);
      assertUrlSecretHeaders(ranged);
      assert.equal(await ranged.text(), new TextDecoder().decode(object.body.subarray(0, 10)));

      const notModified = await fetch(base, { headers: { 'if-none-match': '*' } });
      assert.equal(notModified.status, 304);
      assertUrlSecretHeaders(notModified);
      assert.equal(await notModified.text(), '', '304 must be zero-body');

      const head = await fetch(`${base}?filename=head.bin`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assertUrlSecretHeaders(head);
      assert.equal(await head.text(), '', 'HEAD must be zero-body');
      assert.equal(head.headers.get('content-length'), String(object.body.byteLength));

      // The child process output stays secret-free after the whole success
      // matrix: only the discovery line on stdout, nothing on stderr.
      assert.ok(handle.stdout.includes('delivery_listening '));
      assert.ok(!handle.stdout.includes(object.token));
      assert.equal(handle.stderr, '');
    } finally {
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0);
    }
  });

  test('error matrix: 404/403/405/413/416/400/414/503 and the Fastify 404 fallback all carry no-referrer/no-store/nosniff, zero-body', { timeout: 60_000 }, async () => {
    const marker = `err-${randomUUID()}`;
    const object = await seedServedObject(marker);
    const { handle, origin } = await startReadyProcess();
    try {
      const base = `${origin}/d/${object.token}`;

      // Invalid credentials: tampered / expired / wrong-audience -> 404.
      const [version, payload, signature] = object.token.split('.') as [string, string, string];
      const tampered = `${version}.${payload!.slice(0, -2)}AA.${signature}`;
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/${tampered}`), 404);

      const expired = capabilityFor(object.blobId, object.generationId, {
        ttlSeconds: 60,
        now: new Date(Date.now() - 61_000),
      });
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/${expired}`), 404);

      const wrongAudience = capabilityFor(object.blobId, object.generationId, {
        audience: 'https://wrong-audience.invalid',
      });
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/${wrongAudience}`), 404);

      // Fastify 404 fallback: unknown paths and empty-token paths.
      await assertUrlSecretZeroBody(await fetch(`${origin}/not-a-route`), 404);
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/`), 404);
      await assertUrlSecretZeroBody(await fetch(`${origin}/`), 404);

      // Method allowlist: POST is 405 with Allow; other methods on /d/:token
      // stay 404 (unregistered) with the same headers.
      const post = await fetch(base, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
      await assertUrlSecretZeroBody(post, 405);

      // Body over the 1-byte limit -> 413 via the error handler.
      await assertUrlSecretZeroBody(await fetch(base, { method: 'PUT', body: 'xx' }), 413);

      // Unsatisfiable range -> 416.
      await assertUrlSecretZeroBody(await fetch(base, { headers: { range: 'bytes=999999-' } }), 416);

      // Framework-level errors: invalid URL component -> 400, token over
      // maxParamLength -> 414; zero body (the raw path is never echoed).
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/v1%zz`), 400);
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/${'x'.repeat(2000)}`), 414);

      // Upstream failure (HEAD 500 from the object server) -> stable 503.
      const failingKey = `${P08_LIVE_PREFIX}v4a05-failing-${randomUUID()}`;
      const failingBody = new TextEncoder().encode(`v4a05-failing-${randomUUID()}`);
      const failingEtag = await uploadObject(failingKey, failingBody);
      const failingBlobId = `blob-failing-${randomUUID()}`;
      const failingGenerationId = `gen-failing-${randomUUID()}`;
      await seedActiveGeneration({
        blobId: failingBlobId,
        generationId: failingGenerationId,
        key: failingKey,
        etag: failingEtag,
        body: failingBody,
      });
      objectServer.headFailures.add(failingKey);
      const failingToken = capabilityFor(failingBlobId, failingGenerationId);
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/${failingToken}`), 503);

      // No response in the whole matrix leaked the token: zero-body denials
      // carry nothing and the child output stays secret-free.
      assert.ok(!handle.stdout.includes(object.token));
      assert.ok(!handle.stdout.includes(tampered));
      assert.ok(!handle.stdout.includes(expired));
      assert.ok(!handle.stdout.includes(wrongAudience));
      assert.equal(handle.stderr, '');
    } finally {
      objectServer.headFailures.clear();
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0);
    }
  });

  test('403: an object above the delivery byte budget is denied zero-body with the URL-secret headers', { timeout: 60_000 }, async () => {
    const marker = `big-${randomUUID()}`;
    const blobId = `blob-${marker}`;
    const generationId = `gen-${marker}`;
    const key = `${P08_LIVE_PREFIX}v4a05-${marker}-${randomUUID()}`;
    const body = new TextEncoder().encode(`v4a05-over-budget-${marker}-${'b'.repeat(2048)}`);
    const etag = await uploadObject(key, body);
    await seedActiveGeneration({ blobId, generationId, key, etag, body });

    // A 1 KiB delivery budget makes the 2 KiB+ object fail closed (403).
    const { handle, origin } = await startReadyProcess(
      deliveryEnv({ ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '1024' }),
    );
    try {
      const token = capabilityFor(blobId, generationId);
      await assertUrlSecretZeroBody(await fetch(`${origin}/d/${token}`), 403);
      assert.ok(!handle.stdout.includes(token));
      assert.equal(handle.stderr, '');
    } finally {
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0);
    }
  });

  test('marker capability: zero hits in child stdout/stderr across success and every error path', { timeout: 60_000 }, async () => {
    const marker = `V4A05-MARKER-${randomUUID().replaceAll('-', '')}-${randomUUID().replaceAll('-', '')}`;
    const object = await seedServedObject(marker);
    const nonce = `nonce-${marker}`;
    const token = capabilityFor(object.blobId, object.generationId, { nonce });
    const { handle, origin } = await startReadyProcess();
    try {
      const base = `${origin}/d/${token}`;
      // Success path.
      const ok = await fetch(base);
      assert.equal(ok.status, 200);
      await ok.arrayBuffer();
      // Denial paths: tampered, expired, wrong audience, 405, 413, 416,
      // framework 400/414, upstream 503, Fastify fallback.
      const [version, payload, signature] = token.split('.') as [string, string, string];
      await fetch(`${origin}/d/${version}.${payload!.slice(0, -2)}AA.${signature}`);
      await fetch(`${origin}/d/${capabilityFor(object.blobId, object.generationId, {
        ttlSeconds: 60, now: new Date(Date.now() - 61_000), nonce: `expired-${marker}`,
      })}`);
      await fetch(`${origin}/d/${capabilityFor(object.blobId, object.generationId, {
        audience: 'https://wrong-audience.invalid', nonce: `audience-${marker}`,
      })}`);
      await fetch(base, { method: 'POST' });
      await fetch(base, { method: 'PUT', body: 'xx' });
      await fetch(base, { headers: { range: 'bytes=999999-' } });
      await fetch(`${origin}/d/v1%zz`);
      await fetch(`${origin}/d/${'y'.repeat(2000)}`);
      await fetch(`${origin}/unknown-route`);
      await fetch(`${origin}/d//${token}`);

      // The marker, the full capability URL and the token must never appear
      // anywhere in the process output; stderr must stay empty.
      const combinedOutput = `${handle.stdout}\n${handle.stderr}`;
      for (const needle of [marker, token, `/d/${token}`, token.slice(0, 32)]) {
        assert.ok(!combinedOutput.includes(needle),
          `the child output must not contain the capability marker/token (needle length ${needle.length})`);
      }
      assert.equal(handle.stderr, '', 'the delivery process must never write to stderr during requests');
      assert.ok(handle.stdout.includes('delivery_listening '), 'stdout carries only the discovery line');
    } finally {
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0);
    }
  });

  test('corner cases: URL-encoded token, double slash, query/fragment and proxy raw-URI fields', { timeout: 60_000 }, async () => {
    const marker = `corner-${randomUUID()}`;
    const object = await seedServedObject(marker);
    const { handle, origin } = await startReadyProcess();
    try {
      const base = `${origin}/d/${object.token}`;

      // URL-encoded token: percent-encoded dots decode to the exact token and
      // are served identically (200 with the URL-secret headers).
      const encodedToken = object.token.replaceAll('.', '%2E');
      const encoded = await fetch(`${origin}/d/${encodedToken}`);
      assert.equal(encoded.status, 200, 'an URL-encoded capability token must verify identically');
      assertUrlSecretHeaders(encoded);
      await encoded.arrayBuffer();

      // Double slash: `/d//<token>` is not the capability route -> 404
      // fallback with headers, zero body.
      await assertUrlSecretZeroBody(await fetch(`${origin}/d//${object.token}`), 404);

      // Query and fragment: the filename query is honored, unknown query
      // params and the fragment never reach the server and never leak.
      const withQuery = await fetch(`${base}?filename=report.txt&token=${marker}#fragment=${marker}`);
      assert.equal(withQuery.status, 200);
      assertUrlSecretHeaders(withQuery);
      assert.equal(withQuery.headers.get('content-disposition')?.startsWith('attachment; filename="report.txt"'), true);
      await withQuery.arrayBuffer();

      // Proxy raw-URI fields: X-Forwarded-URI / X-Original-URL carrying the
      // marker must not affect the response and must never leak into output.
      const proxied = await fetch(base, {
        headers: {
          'x-forwarded-uri': `/d/${object.token}?token=${marker}`,
          'x-original-url': `${origin}/d/${object.token}`,
        },
      });
      assert.equal(proxied.status, 200);
      assertUrlSecretHeaders(proxied);
      await proxied.arrayBuffer();

      const combinedOutput = `${handle.stdout}\n${handle.stderr}`;
      for (const needle of [marker, object.token, `/d/${object.token}`]) {
        assert.ok(!combinedOutput.includes(needle),
          'corner-case requests must never leak the capability into process output');
      }
      assert.equal(handle.stderr, '');
    } finally {
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// In-process real-HTTP suite (production composition over a real socket)
// ---------------------------------------------------------------------------

describe('P4A-V4A-05 in-process real-HTTP security details', () => {
  const SECRET = Buffer.from('v4a05-inprocess-capability-hmac-secret-0123456789abcdef', 'utf8');

  async function startHarness(options: {
    resolver?: DeliveryGenerationResolver;
    objectStore?: GenerationObjectStorePort;
  } = {}): Promise<{ host: DeliveryHost; origin: string }> {
    const host = await composeDeliveryHost({
      config: i11Config(),
      objectStore: options.objectStore,
      capabilitySecret: SECRET,
      resolveGeneration: options.resolver ?? fixtureResolver([]),
      hostname: '127.0.0.1',
    });
    const origin = await host.start();
    return { host, origin };
  }

  test('500 from a throwing resolver and 503 with an error cause chain stay zero-body, carry the URL-secret headers and never leak', async () => {
    const marker = `V4A05-INPROC-${randomUUID().replaceAll('-', '')}`;
    const blobId = `blob-${marker}`;
    const generationId = `gen-${marker}`;

    // 500: the generation resolver throws with a deep cause chain whose leaf
    // carries the marker. The error handler must answer zero-body 500 with
    // the URL-secret headers and must not surface the marker.
    const throwingResolver: DeliveryGenerationResolver = async () => {
      throw new Error('resolver boom', {
        cause: new Error('nested resolver failure', {
          cause: new Error(`leaf: /d/v1.${marker}.payload`),
        }),
      });
    };
    const fiveHundred = await startHarness({
      resolver: throwingResolver,
      objectStore: new FixtureDeliveryObjectStore() as GenerationObjectStorePort,
    });
    try {
      const token = createHmacOwnerDeliveryCapabilitySigner({
        secret: SECRET,
        audienceOrigin: fiveHundred.origin,
      }).sign({ blobId, generationId, ownerSubject: OWNER_SUBJECT_ID, ttlSeconds: 60 }).token;
      const response = await fetch(`${fiveHundred.origin}/d/${token}`);
      assert.equal(response.status, 500);
      assertUrlSecretHeaders(response);
      assert.equal(await response.text(), '', 'the 500 must be zero-body (no error text, no cause chain, no path echo)');
    } finally {
      await fiveHundred.host.close();
    }

    // 503: the object store HEAD throws with a cause chain containing the
    // marker; the route maps it to a stable zero-body 503.
    class CauseChainStore extends FixtureDeliveryObjectStore {
      override async headExact(
        _handle: GenerationObjectHandle,
        _options: { expectedEtag?: string } = {},
      ): Promise<GenerationHeadOutcome> {
        throw new Error('upstream head failed', {
          cause: new Error('provider transport error', {
            cause: new Error(`requested /d/v1.${marker}.payload.sig`),
          }),
        });
      }
    }
    const store = new CauseChainStore();
    const fiveOhThree = await startHarness({
      objectStore: store as GenerationObjectStorePort,
      resolver: fixtureResolver([{
        blobId,
        generationId,
        key: `attachments/live/v4a05-cause-${marker}`,
        ownerSubject: OWNER_SUBJECT_ID,
        bytes: plainBytes(`v4a05-cause-${marker}`),
        etag: `"v4a05-cause-etag-${marker}"`,
      }]),
    });
    try {
      const token = createHmacOwnerDeliveryCapabilitySigner({
        secret: SECRET,
        audienceOrigin: fiveOhThree.origin,
      }).sign({ blobId, generationId, ownerSubject: OWNER_SUBJECT_ID, ttlSeconds: 60 }).token;
      const response = await fetch(`${fiveOhThree.origin}/d/${token}`);
      assert.equal(response.status, 503);
      assertUrlSecretHeaders(response);
      assert.equal(await response.text(), '', 'the 503 must be zero-body (the cause chain never reaches the response)');
      const serializedLog = JSON.stringify(fiveOhThree.host.requestLog);
      assert.ok(!serializedLog.includes(marker), 'the cause-chain marker must never reach the request log');
      assert.ok(!serializedLog.includes(token), 'the capability token must never reach the request log');
    } finally {
      await fiveOhThree.host.close();
    }
  });

  test('the fixed-class request log never contains tokens, URLs, keys or filenames across the whole matrix', async () => {
    const marker = `V4A05-LOG-${randomUUID().replaceAll('-', '')}`;
    const object = {
      blobId: `blob-${marker}`,
      generationId: `gen-${marker}`,
      key: `attachments/live/v4a05-${marker}`,
      ownerSubject: OWNER_SUBJECT_ID,
      bytes: plainBytes(`v4a05-log-body-${marker}`),
      etag: `"v4a05-etag-${marker}"`,
    };
    const store = new FixtureDeliveryObjectStore();
    store.seed(object);
    const { host, origin } = await startHarness({
      objectStore: store as GenerationObjectStorePort,
      resolver: fixtureResolver([object]),
    });
    try {
      const signer = createHmacOwnerDeliveryCapabilitySigner({ secret: SECRET, audienceOrigin: origin });
      const token = signer.sign({
        blobId: object.blobId,
        generationId: object.generationId,
        ownerSubject: object.ownerSubject,
        ttlSeconds: 60,
      }).token;
      const base = `${origin}/d/${token}`;
      await fetch(`${base}?filename=secret-name.txt`);
      await fetch(`${base}`, { headers: { range: 'bytes=0-1' } });
      await fetch(`${base}`, { method: 'POST' });
      await fetch(`${origin}/d/not-a-token`);
      await fetch(`${origin}/d/v1%zz`);

      const serialized = JSON.stringify(host.requestLog);
      for (const needle of [token, marker, object.key, origin, 'secret-name.txt', '/d/']) {
        assert.ok(!serialized.includes(needle),
          `the fixed-class request log must never contain ${needle}`);
      }
      // The log shape stays fixed-class: every entry has only the allowed
      // fields, none of which is a URL/token/key.
      assert.ok(host.requestLog.length >= 4, 'every route-level request must be recorded');
      const allowedKeys = ['status', 'byteCount', 'receivedCookies', 'receivedAuthorization',
        'receivedReferer', 'setCookies', 'range'];
      for (const entry of host.requestLog) {
        const keys = Object.keys(entry).sort();
        assert.ok(keys.every((key) => allowedKeys.includes(key)),
          'the request-log entry shape is fixed and non-sensitive');
        for (const required of ['status', 'byteCount', 'receivedCookies', 'receivedAuthorization',
          'receivedReferer', 'setCookies']) {
          assert.ok(keys.includes(required), `missing ${required}`);
        }
      }
    } finally {
      await host.close();
    }
  });
});
