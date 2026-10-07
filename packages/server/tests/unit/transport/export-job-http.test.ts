import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createNeverCalledExportObjectStore,
  EXPORT_JOB_COMMAND_SCOPE,
  ExportJobConflictError,
  type ExportJob,
  type ExportJobRecord,
  type ExportJobReceiptPort,
  type ExportJobStatus,
  type ExportObjectStore,
} from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  assertProductErrorEnvelope,
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  createMemoryProductCommandReceiptPort,
  issueTestSession,
  productCommandReceiptKey,
  type MemoryProductCommandReceipts,
} from '../../support/product-http-harness.js';

const NOW = new Date('2026-08-23T08:00:00.000Z');
const LIST = '/api/v1/me/export-jobs';
const baseEnv = {
  DATABASE_URL: 'postgres://localhost/export_job_http_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example/realms/known',
  OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
};
const dummyExportR2 = {
  EXPORT_R2_ENDPOINT: 'https://export.example.test',
  EXPORT_R2_REGION: 'auto',
  EXPORT_R2_BUCKET: 'export-private',
  EXPORT_R2_ACCESS_KEY_ID: 'export-key',
  EXPORT_R2_SECRET_ACCESS_KEY: 'export-secret',
};

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function mutationHeaders(
  client: { cookie: string; csrfToken: string },
  commandId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: 'https://app.example.test',
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
    ...extra,
  };
}

function exportReceipts(receipts: MemoryProductCommandReceipts): ExportJobReceiptPort {
  const base = createMemoryProductCommandReceiptPort(receipts);
  return {
    claim: (binding, fingerprint) => base.claim(binding, fingerprint),
    complete: (binding, fingerprint, result) => base.complete(binding, fingerprint, result),
    async lookup(binding, fingerprint) {
      const existing = receipts.get(productCommandReceiptKey(binding));
      if (!existing) return { kind: 'absent' };
      if (existing.fingerprint !== fingerprint) return { kind: 'reused' };
      if (existing.expired) {
        return { kind: 'expired', resultDigest: existing.resultDigest ?? null };
      }
      if (existing.status === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: 1 };
      }
      assert.ok(existing.result, 'completed receipt must retain result');
      return {
        kind: 'replay',
        result: {
          status: existing.result.status,
          body: existing.result.body.slice(),
          stableHeaders: { ...existing.result.stableHeaders },
          mediaType: existing.result.mediaType,
          contractVersion: existing.result.contractVersion,
          targetIdentity: existing.result.targetIdentity,
        },
      };
    },
  };
}

async function harness(input: {
  readonly enabled: boolean;
  readonly store?: ExportObjectStore;
}) {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    KNOWN_FEATURE_EXPORT_JOBS: input.enabled ? 'true' : 'false',
    ...(input.enabled ? dummyExportR2 : {}),
  };
  // Flag-off compositions must start with zero EXPORT_R2_* keys.
  if (!input.enabled) {
    for (const key of Object.keys(dummyExportR2)) delete env[key];
  }
  const config = loadConfig(env);
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const owner = await issueTestSession({
    factory, subject: 'owner-subject', displayName: 'Owner', handle: 'exjowner',
  });
  const outsider = await issueTestSession({
    factory, subject: 'outsider-subject', displayName: 'Outsider', handle: 'exjout',
  });
  const jobs: ExportJobRecord[] = [];
  const receipts: MemoryProductCommandReceipts = new Map();
  const objects = new Map<string, Buffer>();
  const putCalls: string[] = [];
  const memoryStore: ExportObjectStore = {
    async put(jobId, body) {
      putCalls.push(jobId);
      objects.set(jobId, body);
    },
    async get(jobId) {
      return objects.get(jobId) ?? null;
    },
    async delete(jobId) {
      objects.delete(jobId);
    },
  };
  const store = input.store ?? (input.enabled ? memoryStore : createNeverCalledExportObjectStore());
  const app = buildApiApp({
    config,
    identityUnitOfWork: identity,
    browserSessionAuthority: factory.authority,
    exportJobReads: {
      async listByOwner(ownerSubjectId, limit) {
        return jobs
          .filter((job) => job.ownerSubjectId === ownerSubjectId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .slice(0, limit);
      },
      async getById(jobId) {
        return jobs.find((job) => job.jobId === jobId) ?? null;
      },
    },
    exportJobEnqueue: {
      execute: async (work) => work({
        receipts: exportReceipts(receipts),
        jobs: {
          async findActive(ownerSubjectId) {
            return jobs.find((job) =>
              job.ownerSubjectId === ownerSubjectId
              && (job.status === 'pending' || job.status === 'running')) ?? null;
          },
          async insertPending(row) {
            if (jobs.some((job) =>
              job.ownerSubjectId === row.ownerSubjectId
              && (job.status === 'pending' || job.status === 'running'))) {
              throw new ExportJobConflictError();
            }
            jobs.push({
              jobId: row.jobId,
              ownerSubjectId: row.ownerSubjectId,
              status: 'pending',
              objectKey: null,
              byteSize: null,
              createdAt: row.createdAt,
              readyAt: null,
              expiresAt: row.expiresAt,
              errorClass: null,
            });
          },
        },
        clock: { now: () => NOW },
      }),
    },
    exportJobStore: store,
  });
  apps.push(app);
  return { app, owner, outsider, jobs, receipts, objects, putCalls, store };
}

function seedJob(
  jobs: ExportJobRecord[],
  input: {
    readonly jobId: string;
    readonly ownerSubjectId: string;
    readonly status?: ExportJobStatus;
    readonly expiresAt?: Date;
  },
): ExportJobRecord {
  const job: ExportJobRecord = {
    jobId: input.jobId,
    ownerSubjectId: input.ownerSubjectId,
    status: input.status ?? 'ready',
    objectKey: input.jobId,
    byteSize: 2,
    createdAt: NOW,
    readyAt: NOW,
    expiresAt: input.expiresAt ?? new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    errorClass: null,
  };
  jobs.push(job);
  return job;
}

describe('GET/POST /api/v1/me/export-jobs', () => {
  test('flag off four paths 404 resource_not_found without EXPORT_R2 env', async () => {
    const { app, owner } = await harness({ enabled: false });
    const routes = app.printRoutes();
    assert.match(routes, /export-jobs/u);
    const headers = { cookie: owner.cookie };
    for (const [method, url] of [
      ['GET', LIST],
      ['POST', LIST],
      ['GET', `${LIST}/job-1`],
      ['GET', `${LIST}/job-1/download`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: method === 'POST'
          ? mutationHeaders(owner, randomUUID())
          : headers,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      assertProductErrorEnvelope(response, 404, 'resource_not_found');
      assert.notEqual(response.json().error?.code, 'feature_temporarily_unavailable');
    }
  });

  test('anonymous requests are 401 before CSRF', async () => {
    const { app } = await harness({ enabled: true });
    const response = await app.inject({
      method: 'POST', url: LIST,
      headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      payload: {},
    });
    assertProductErrorEnvelope(response, 401, 'authentication_required');
    const list = await app.inject({ method: 'GET', url: LIST });
    assertProductErrorEnvelope(list, 401, 'authentication_required');
    const item = await app.inject({ method: 'GET', url: `${LIST}/job-1` });
    assertProductErrorEnvelope(item, 401, 'authentication_required');
    const download = await app.inject({ method: 'GET', url: `${LIST}/job-1/download` });
    assertProductErrorEnvelope(download, 401, 'authentication_required');
  });

  test('missing CSRF is csrf_failed', async () => {
    const { app, owner } = await harness({ enabled: true });
    const response = await app.inject({
      method: 'POST', url: LIST,
      headers: {
        cookie: owner.cookie,
        origin: 'https://app.example.test',
        'known-command-id': randomUUID(),
        'content-type': 'application/json',
      },
      payload: {},
    });
    assertProductErrorEnvelope(response, 403, 'csrf_failed');
  });

  test('second concurrent job with a new command id is command_in_progress without a receipt for B', async () => {
    const { app, owner, receipts } = await harness({ enabled: true });
    const commandA = randomUUID();
    const commandB = randomUUID();
    const first = await app.inject({
      method: 'POST', url: LIST, headers: mutationHeaders(owner, commandA), payload: {},
    });
    assert.equal(first.statusCode, 201);
    const created = first.json() as ExportJob;
    assert.equal(created.status, 'pending');
    assert.equal(Object.hasOwn(created, 'downloadUrl'), false);
    const second = await app.inject({
      method: 'POST', url: LIST, headers: mutationHeaders(owner, commandB), payload: {},
    });
    assertProductErrorEnvelope(second, 409, 'command_in_progress');
    assert.equal(second.headers['retry-after'], '5');
    assert.equal(receipts.has(productCommandReceiptKey({
      principalId: owner.accountId,
      commandScope: EXPORT_JOB_COMMAND_SCOPE,
      commandId: commandB,
    })), false);
    const replay = await app.inject({
      method: 'POST', url: LIST, headers: mutationHeaders(owner, commandA), payload: {},
    });
    assert.equal(replay.statusCode, 201);
    assert.equal((replay.json() as ExportJob).jobId, created.jobId);
  });

  test('owner can list and get their job; outsider is 404; download is 404 until ready', async () => {
    const { app, owner, outsider, jobs, objects } = await harness({ enabled: true });
    const created = await app.inject({
      method: 'POST', url: LIST, headers: mutationHeaders(owner, randomUUID()), payload: {},
    });
    const job = created.json() as ExportJob;
    const listed = await app.inject({
      method: 'GET', url: LIST, headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as { items: ExportJob[] }).items[0]?.jobId, job.jobId);
    const got = await app.inject({
      method: 'GET', url: `${LIST}/${job.jobId}`, headers: { cookie: owner.cookie },
    });
    assert.equal(got.statusCode, 200);
    const foreign = await app.inject({
      method: 'GET', url: `${LIST}/${job.jobId}`, headers: { cookie: outsider.cookie },
    });
    assertProductErrorEnvelope(foreign, 404, 'resource_not_found');
    const pendingDownload = await app.inject({
      method: 'GET', url: `${LIST}/${job.jobId}/download`, headers: { cookie: owner.cookie },
    });
    assertProductErrorEnvelope(pendingDownload, 404, 'resource_not_found');
    const record = jobs.find((row) => row.jobId === job.jobId);
    assert.ok(record);
    // A ready export carries the same metadata persisted by the worker.  The
    // enqueue fixture starts pending with null readyAt/object size; populate
    // those fields before exercising the owner download contract so the route
    // is admitted instead of correctly returning its concealed 404.
    Object.assign(record, {
      status: 'ready' as ExportJobStatus,
      objectKey: job.jobId,
      byteSize: 2,
      readyAt: NOW,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    objects.set(job.jobId, Buffer.from(JSON.stringify({
      exportedAt: '2026-08-23T08:00:00.000Z', collections: [],
    }), 'utf8'));
    const download = await app.inject({
      method: 'GET', url: `${LIST}/${job.jobId}/download`, headers: { cookie: owner.cookie },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(download.headers['cache-control'], 'private, no-store');
    assert.deepEqual(download.json(), {
      exportedAt: '2026-08-23T08:00:00.000Z', collections: [],
    });
  });
});
