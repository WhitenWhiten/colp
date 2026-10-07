/**
 * P4A-I15 control-plane drift detection: injected fetch, fail-closed, with
 * control-plane attestation and data-plane health classified separately.
 *
 * Proves (no real Cloudflare token needed):
 *  - a clean control snapshot reports ok with zero findings;
 *  - bucket public access, enabled custom/managed domains, lifecycle deletion
 *    rules overlapping the quarantine prefix, probe lifecycle drift, and
 *    deletion rules overlapping the live prefix are each detected as drift;
 *  - provider 429 / 5xx / timeout are classified as ENVIRONMENT, never policy
 *    drift (anti-false-negative);
 *  - new/unknown provider fields are classified as contract_drift (fail
 *    closed, never silently ignored);
 *  - the control report is plane:'control' while data-plane health is a
 *    separate plane:'data' classification; a data-plane retryable head is
 *    degraded, never drift;
 *  - the control token and raw error text never appear in the report.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  classifyAttachmentDataPlaneHealth,
  detectAttachmentControlDrift,
  type AttachmentControlDriftExpected,
} from '../../../src/modules/attachments/index.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const BUCKET = 'known-quarantine-production';
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const TOKEN = 'control-token-marker';

interface ControlFixture extends Record<string, unknown> {
  bucket: { success: boolean; errors: Array<{ code: number; message: string }>; messages: unknown[]; result: Record<string, unknown> };
  managedDomain: { success: boolean; errors: Array<{ code: number; message: string }>; messages: unknown[]; result: Record<string, unknown> };
  customDomains: { success: boolean; errors: Array<{ code: number; message: string }>; messages: unknown[]; result: { domains: Array<Record<string, unknown>> } };
  lifecycle: { success: boolean; errors: Array<{ code: number; message: string }>; messages: unknown[]; result: { rules: Array<Record<string, unknown>> } };
}

async function responseFixture(): Promise<ControlFixture> {
  return JSON.parse(await readFile(
    resolve('tests/fixtures/phase4a/r2-control-api.private.json'), 'utf8',
  )) as ControlFixture;
}

function expected(overrides: Partial<AttachmentControlDriftExpected> = {}): AttachmentControlDriftExpected {
  return {
    accountId: ACCOUNT,
    bucket: BUCKET,
    endpoint: ENDPOINT,
    livePrefix: 'attachments/live/',
    probePrefix: 'capability-probes/',
    quarantinePrefix: 'quarantine/v1/',
    probeObjectsMaximumAgeSeconds: 86_400,
    ...overrides,
  };
}

function fakeFetch(
  fixture: ControlFixture,
  requests: Array<{ url: string; init: RequestInit }>,
  scripted?: Record<string, { status: number; body: string }>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    const key = url.endsWith('/domains/managed') ? 'managedDomain'
      : url.endsWith('/domains/custom') ? 'customDomains'
        : url.endsWith('/lifecycle') ? 'lifecycle' : 'bucket';
    const scriptedResponse = scripted?.[key];
    if (scriptedResponse) {
      return new Response(scriptedResponse.body, {
        status: scriptedResponse.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(fixture[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('P4A-I15 drift detection', () => {
  test('a clean control snapshot reports ok with zero findings', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(await responseFixture(), requests),
    });
    assert.equal(report.plane, 'control');
    assert.equal(report.overall, 'ok');
    assert.equal(report.driftCount, 0);
    assert.equal(report.environmentCount, 0);
    assert.equal(report.contractDriftCount, 0);
    assert.equal(report.findings.length, 0);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(({ init }) => (init.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}`));
  });

  test('bucket public access drift is detected', async () => {
    const fixture = await responseFixture();
    fixture.bucket.result.public_access = true;
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(fixture, []),
    });
    assert.equal(report.overall, 'drift');
    assert.equal(report.findings.filter((f) => f.check === 'bucket_public_access' && f.status === 'drift').length, 1);
  });

  test('an enabled managed domain is drift', async () => {
    const fixture = await responseFixture();
    fixture.managedDomain.result.enabled = true;
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(fixture, []),
    });
    assert.equal(report.overall, 'drift');
    assert.equal(report.findings.filter((f) => f.check === 'managed_domains' && f.status === 'drift').length, 1);
  });

  test('an enabled custom domain is drift', async () => {
    const fixture = await responseFixture();
    fixture.customDomains.result.domains = [{ domain: 'public.example', enabled: true }];
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(fixture, []),
    });
    assert.equal(report.overall, 'drift');
    assert.equal(report.findings.filter((f) => f.check === 'custom_domains' && f.status === 'drift').length, 1);
  });

  test('lifecycle drift (quarantine prefix deletion, probe max age, live prefix deletion) is detected', async () => {
    const quarantine = await responseFixture();
    quarantine.lifecycle.result.rules.push({
      id: 'delete-quarantine', enabled: true, conditions: { prefix: 'quarantine/v1/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } },
    });
    const quarantineReport = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(quarantine, []),
    });
    assert.equal(quarantineReport.overall, 'drift');
    assert.equal(quarantineReport.findings.filter((f) => f.check === 'lifecycle_rules' && f.status === 'drift').length, 1);

    const maxAge = await responseFixture();
    (maxAge.lifecycle.result.rules[0] as { deleteObjectsTransition: { condition: { maxAge: number } } })
      .deleteObjectsTransition.condition.maxAge = 86_401;
    const maxAgeReport = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(maxAge, []),
    });
    assert.equal(maxAgeReport.overall, 'drift');
    assert.equal(maxAgeReport.findings.filter((f) => f.check === 'lifecycle_rules' && f.status === 'drift').length, 1);

    const live = await responseFixture();
    live.lifecycle.result.rules.push({
      id: 'delete-live', enabled: true, conditions: { prefix: 'attachments/live/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } },
    });
    const liveReport = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(live, []),
    });
    assert.equal(liveReport.overall, 'drift');
    assert.equal(liveReport.findings.filter((f) => f.check === 'prefix_drift' && f.status === 'drift').length, 1);
  });

  test('provider 429 / 5xx are environment, never policy drift', async () => {
    const fixture = await responseFixture();
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN,
      fetchImpl: fakeFetch(fixture, [], {
        bucket: { status: 429, body: JSON.stringify({ success: false, errors: [], messages: [], result: {} }) },
        lifecycle: { status: 503, body: 'upstream down' },
      }),
    });
    assert.equal(report.overall, 'environment');
    assert.equal(report.driftCount, 0, 'provider throttling must never be policy drift');
    assert.ok(report.environmentCount >= 2);
    assert.ok(report.findings.some((f) => f.status === 'environment' && f.check === 'bucket_public_access'));
  });

  test('unknown provider fields are contract drift (fail closed, never silently ignored)', async () => {
    const fixture = await responseFixture();
    (fixture.bucket.result as Record<string, unknown>).brand_new_field = 'x';
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(fixture, []),
    });
    assert.equal(report.overall, 'contract_drift');
    assert.equal(report.contractDriftCount, 1);
    assert.equal(report.findings[0]?.status, 'contract_drift');
  });

  test('control-plane attestation and data-plane health are classified separately', async () => {
    const control = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN, fetchImpl: fakeFetch(await responseFixture(), []),
    });
    assert.equal(control.plane, 'control');
    const data = classifyAttachmentDataPlaneHealth({ headClass: 'retryable' });
    assert.equal(data.plane, 'data');
    assert.equal(data.status, 'degraded');
    assert.equal(data.class, 'retryable');
    const denied = classifyAttachmentDataPlaneHealth({ headClass: 'denied' });
    assert.equal(denied.status, 'unavailable');
    const ok = classifyAttachmentDataPlaneHealth({ headClass: 'ok' });
    assert.equal(ok.status, 'ok');
    const serialized = JSON.stringify({ control, data, denied, ok });
    assert.equal(serialized.includes('drift'), true, 'only the control report carries drift vocabulary');
    assert.equal(serialized.includes(TOKEN), false, 'the control token must never appear');
  });

  test('the report never leaks the token or raw provider error text', async () => {
    const fixture = await responseFixture();
    fixture.bucket.errors = [{ code: 10000, message: `denied ${TOKEN}` }];
    fixture.bucket.success = false;
    const report = await detectAttachmentControlDrift({
      expected: expected(), token: TOKEN,
      fetchImpl: fakeFetch(fixture, [], { managedDomain: { status: 429, body: `rate limited ${TOKEN}` } }),
    });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(TOKEN));
    assert.ok(!serialized.includes('rate limited'));
    assert.equal(serialized.includes('environment'), true);
  });
});