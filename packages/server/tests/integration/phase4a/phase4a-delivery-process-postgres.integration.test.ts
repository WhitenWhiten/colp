/**
 * P4A-V4A-04 focused PostgreSQL suite: the REAL isolated delivery process.
 *
 * Spawns `src/bootstrap/delivery-main.ts` (or the `dist` build when present)
 * as an independent OS child process and drives it ONLY through its
 * discovery/readiness protocol:
 *
 *  - no fixed ports: the child binds `ATTACHMENTS_DELIVERY_PORT=0` and prints
 *    `delivery_listening <bound-origin>`; the suite waits for that line and
 *    then polls the readiness route with a deadline (no wall-clock sleeps);
 *  - no Fastify.inject / no in-process composition: every delivery request is
 *    a real HTTP GET over the child's listening socket;
 *  - the child runs the REAL R2 read-only adapter over the local
 *    create-only/GET object server, the REAL version-fenced PostgreSQL
 *    generation resolver over a dedicated READ-ONLY role, and the production
 *    `composeProductionDeliveryHost` composition;
 *  - secrets travel only through the child environment — never argv or
 *    artifacts — and the suite asserts the captured stdout/stderr never
 *    contains a secret value.
 *
 * Covers the V4A-04 test contract: real startup + readiness + valid GET,
 * replacement version fence (old capability 404), missing secret/DSN startup
 * failure, DB write rejection under the read-only role, and SIGTERM resource
 * close (socket + pg pool + R2 store) with observable exit codes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, test } from 'vitest';
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
import {
  DELIVERY_PROCESS_READINESS_PATH,
  startDeliveryProcess,
  stopDeliveryProcess,
  waitForDeliveryExit,
  waitForDeliveryListening,
  waitForDeliveryReadiness,
  type DeliveryProcessHandle,
} from '../../support/phase4a-delivery-process-helpers.js';

const OWNER_SUBJECT_ID = 'v4a04-owner';
const ROLE_PASSWORD = 'delivery_ro_test_only';

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function structuredLogRecords(output: string): ReadonlyArray<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith('{')) continue;
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records.push(parsed as Record<string, unknown>);
    }
  }
  return records;
}

describeWithPostgres('P4A-V4A-04 isolated delivery process (real child process)', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P08ObjectServer;
  let administrator: Pool;
  let roleName: string;
  let readOnlyDatabaseUrl: string;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_delivery_process', { maxConnections: 16 });
    objectServer = new P08ObjectServer();
    await objectServer.start();

    // Read-only delivery role contract (ops SQL): CONNECT + schema USAGE +
    // SELECT on exactly the two resolver tables — never the migration
    // owner/RW role, never any DML.
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

  /** Child environment: ALL secrets arrive via env; the dedicated read-only DSN. */
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

  /** Creates the object in the local object server; returns the provider ETag. */
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

  /** Seeds an ACTIVE generation + current pointer in the ledger (deferred FK order). */
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

  /** Signs a short-lived capability for the configured delivery audience. */
  function capabilityFor(blobId: string, generationId: string): string {
    return createHmacOwnerDeliveryCapabilitySigner({
      secret: P08_DELIVERY_SECRET,
      audienceOrigin: P08_DELIVERY_ORIGIN,
    }).sign({ blobId, generationId, ownerSubject: OWNER_SUBJECT_ID, ttlSeconds: 60 }).token;
  }

  async function startReadyProcess(): Promise<{ handle: DeliveryProcessHandle; origin: string }> {
    const handle = startDeliveryProcess(deliveryEnv());
    const origin = await waitForDeliveryListening(handle);
    await waitForDeliveryReadiness(`${origin}${DELIVERY_PROCESS_READINESS_PATH}`, 15_000);
    return { handle, origin };
  }

  test('real child process: startup, readiness, valid capability GET, secret-free output, clean SIGTERM exit 0', { timeout: 60_000 }, async () => {
    const blobId = randomUUID();
    const generationId = randomUUID();
    const key = `${P08_LIVE_PREFIX}v4a04-ok-${randomUUID()}`;
    const body = new TextEncoder().encode(`v4a04-delivery-body-${randomUUID()}-${'z'.repeat(128)}`);
    const etag = await uploadObject(key, body);
    await seedActiveGeneration({ blobId, generationId, key, etag, body });

    const { handle, origin } = await startReadyProcess();
    try {
      const token = capabilityFor(blobId, generationId);
      const response = await fetch(`${origin}/d/${token}`);
      assert.equal(response.status, 200);
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body, 'the delivery process must stream the exact bytes');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'private,no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

      // Secrets travel only through env: never argv, and never observable in
      // the process output.
      const secretValues = [
        P08_DELIVERY_SECRET.toString('utf8'),
        P03_RO_CREDENTIAL.accessKeyId,
        P03_RO_CREDENTIAL.secretAccessKey,
      ];
      for (const secret of secretValues) {
        assert.ok(!handle.stdout.includes(secret), 'stdout must not contain a secret value');
        assert.ok(!handle.stderr.includes(secret), 'stderr must not contain a secret value');
      }
      assert.ok(handle.stdout.includes('delivery_listening '), 'stdout must carry only the low-sensitivity discovery line');
    } finally {
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0, 'clean SIGTERM shutdown must exit 0');
    }
  });

  test('replacement: the old capability fails by version fence (404) while a fresh capability serves the new generation', { timeout: 60_000 }, async () => {
    const blobId = randomUUID();
    const oldGenerationId = randomUUID();
    const newGenerationId = randomUUID();
    const oldKey = `${P08_LIVE_PREFIX}v4a04-old-${randomUUID()}`;
    const newKey = `${P08_LIVE_PREFIX}v4a04-new-${randomUUID()}`;
    const oldBody = new TextEncoder().encode(`v4a04-old-body-${randomUUID()}`);
    const newBody = new TextEncoder().encode(`v4a04-new-body-${randomUUID()}-${'n'.repeat(96)}`);
    const oldEtag = await uploadObject(oldKey, oldBody);
    await seedActiveGeneration({ blobId, generationId: oldGenerationId, key: oldKey, etag: oldEtag, body: oldBody });

    const { handle, origin } = await startReadyProcess();
    try {
      const oldToken = capabilityFor(blobId, oldGenerationId);
      const before = await fetch(`${origin}/d/${oldToken}`);
      assert.equal(before.status, 200, 'the current active generation must serve before replacement');

      // Commit the replacement: new physical key + new generation becomes the
      // current ACTIVE generation; the old generation retires.
      const newEtag = await uploadObject(newKey, newBody);
      const newFingerprint = sha256Hex(newKey);
      const client = await isolated.runtime.pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
           values ($1, $2, $3, $4, 'replacement')`,
          [newGenerationId, newKey, newFingerprint, blobId],
        );
        await client.query(
          `insert into blob_generations
             (generation_id, blob_id, bucket, key, key_fingerprint, generation_state,
              observed_etag, observed_size, observed_content_type)
           values ($1, $2, $3, $4, $5, 'retired', $6, $7, 'application/octet-stream')`,
          [newGenerationId, blobId, P03_BUCKET, newKey, newFingerprint, newEtag, newBody.byteLength],
        );
        await client.query(
          'update blob_records set current_generation_id = $2 where blob_id = $1',
          [blobId, newGenerationId],
        );
        await client.query(
          `update blob_generations set generation_state = 'retired', retire_reason = 'replaced', retired_at = now()
            where generation_id = $1`,
          [oldGenerationId],
        );
        await client.query(
          `update blob_generations set generation_state = 'active' where generation_id = $1`,
          [newGenerationId],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      const after = await fetch(`${origin}/d/${oldToken}`);
      assert.equal(after.status, 404, 'the old capability must resolve to nothing (zero-body 404) after replacement');
      const freshToken = capabilityFor(blobId, newGenerationId);
      const fresh = await fetch(`${origin}/d/${freshToken}`);
      assert.equal(fresh.status, 200);
      assert.deepEqual(new Uint8Array(await fresh.arrayBuffer()), newBody, 'a fresh admission binds the new generation');
    } finally {
      const code = await stopDeliveryProcess(handle);
      assert.equal(code, 0);
    }
  });

  test('fail closed: missing DSN / missing secrets / unreachable DSN exit non-zero without listening', { timeout: 120_000 }, async () => {
    const cases: ReadonlyArray<{ name: string; env: NodeJS.ProcessEnv; expectedVar?: string }> = [
      {
        name: 'missing ATTACHMENTS_DELIVERY_DATABASE_URL',
        env: deliveryEnv({ ATTACHMENTS_DELIVERY_DATABASE_URL: '' }),
        expectedVar: 'ATTACHMENTS_DELIVERY_DATABASE_URL',
      },
      {
        name: 'missing delivery capability HMAC secret',
        env: deliveryEnv({ ATTACHMENTS_DELIVERY_CAPABILITY_HMAC: '' }),
        expectedVar: 'ATTACHMENTS_DELIVERY_CAPABILITY_HMAC',
      },
      {
        name: 'missing R2 RO secret',
        env: deliveryEnv({ ATTACHMENTS_R2_RO_ACCESS_KEY_ID: '', ATTACHMENTS_R2_RO_SECRET_ACCESS_KEY: '' }),
        expectedVar: 'ATTACHMENTS_R2_RO_ACCESS_KEY_ID',
      },
      {
        name: 'unreachable delivery DSN',
        env: deliveryEnv({ ATTACHMENTS_DELIVERY_DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/known' }),
      },
    ];
    for (const item of cases) {
      const handle = startDeliveryProcess(item.env);
      const code = await waitForDeliveryExit(handle, 30_000);
      assert.notEqual(code, 0, `${item.name}: startup must fail closed with a non-zero exit`);
      assert.ok(!handle.stdout.includes('delivery_listening '), `${item.name}: the process must never listen`);
      const fatal = structuredLogRecords(handle.stdout)
        .find((record) => record.event === 'startup_failure');
      assert.ok(fatal, `${item.name}: stdout must contain the structured startup fatal record`);
      assert.equal(fatal.msg, 'fatal process error');
      if (item.expectedVar !== undefined) {
        assert.ok(
          typeof fatal.error === 'string' && fatal.error.includes(item.expectedVar),
          `${item.name}: the structured fatal error must name the failing variable`,
        );
      }
    }
  });

  test('DB role contract: the dedicated read-only delivery role can SELECT but every INSERT is rejected', async () => {
    const client = new Client({ connectionString: readOnlyDatabaseUrl });
    await client.connect();
    try {
      const selected = await client.query('select count(*)::int as n from blob_records');
      assert.ok(Number.isSafeInteger(selected.rows[0]?.n), 'the read-only role must be able to SELECT the resolver tables');
      await assert.rejects(
        client.query(
          `insert into blob_records (blob_id, owner_subject_id, logical_state)
           values ($1, $2, 'issued')`,
          ['should-never-insert', OWNER_SUBJECT_ID],
        ),
        (error: unknown) => (error as { code?: string }).code === '42501',
        'the read-only delivery role must be rejected on INSERT (insufficient_privilege)',
      );
      await assert.rejects(
        client.query(
          `insert into blob_generations (generation_id, blob_id, bucket, key, key_fingerprint)
           values ('g', 'b', 'bucket', 'key', 'fingerprint')`,
        ),
        (error: unknown) => (error as { code?: string }).code === '42501',
        'the read-only delivery role must be rejected on INSERT into blob_generations',
      );
    } finally {
      await client.end();
    }
  });

  test('SIGTERM: bounded drain closes the HTTP socket, the pg pool and the R2 store; exit code 0 observable', { timeout: 60_000 }, async () => {
    const { handle, origin } = await startReadyProcess();
    const code = await stopDeliveryProcess(handle);
    assert.equal(code, 0, 'a clean bounded drain must exit 0 (host.close + pool.end + store.close completed)');
    // The listening socket is gone: a fresh request cannot connect.
    await assert.rejects(
      fetch(`${origin}${DELIVERY_PROCESS_READINESS_PATH}`, { signal: AbortSignal.timeout(2_000) }),
      /fetch failed|ECONNREFUSED|terminated|aborted/iu,
      'the delivery socket must be closed after SIGTERM',
    );
    // The pg pool is fully closed: no 'known-delivery' sessions remain.
    const sessions = await administrator.query(
      `select count(*)::int as n from pg_stat_activity where application_name = 'known-delivery'`,
    );
    assert.equal(sessions.rows[0]?.n, 0, 'no delivery database sessions may survive the drain');
    // R2 store close is part of host.close(): exit 0 proves the awaited close
    // completed (the RO S3 client is destroyed before the process exits).
  });

  test('repeated signal during an in-flight drain forces a non-zero exit', { timeout: 60_000 }, async () => {
    // Hold the drain open with a REAL in-flight GET (slow upstream chunks + a
    // client that stops reading): fastify close must wait for the active
    // request, so the second signal deterministically lands mid-drain.
    const blobId = randomUUID();
    const generationId = randomUUID();
    const key = `${P08_LIVE_PREFIX}v4a04-force-${randomUUID()}`;
    const body = new TextEncoder().encode(`v4a04-force-body-${randomUUID()}-${'f'.repeat(256 * 1024)}`);
    const etag = await uploadObject(key, body);
    await seedActiveGeneration({ blobId, generationId, key, etag, body });

    const { handle, origin } = await startReadyProcess();
    try {
      objectServer.getDelays.set(key, 500);
      const controller = new AbortController();
      const response = await fetch(`${origin}/d/${capabilityFor(blobId, generationId)}`, {
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false, 'the delivery stream must be primed and in flight');
      // SIGTERM starts the bounded drain (which must wait for the active
      // request); the second signal then forces exit(1).
      handle.child.kill('SIGTERM');
      handle.child.kill('SIGINT');
      const code = await waitForDeliveryExit(handle, 15_000);
      assert.equal(code, 1, 'the second signal must force exit(1)');
      assert.equal(code, 1, 'the second signal must force exit(1)');
      assert.ok(handle.stderr.includes('forced exit'), handle.stderr);
      await reader.cancel().catch(() => undefined);
      controller.abort();
    } finally {
      objectServer.getDelays.delete(key);
      await stopDeliveryProcess(handle).catch(() => undefined);
    }
  });
});
