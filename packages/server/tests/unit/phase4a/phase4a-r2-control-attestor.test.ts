import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'vitest';
import {
  CONTROL_TOKEN_ENVIRONMENT,
  R2_CONTROL_ERROR_CODES,
  computeTargetBinding,
  parseAttestorArguments,
  runR2ControlAttestor,
  stableR2ControlErrorCode,
} from '../../../scripts/phase4a-r2-control-attestor.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const BUCKET = 'known-quarantine-production';
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const TOKEN = 'cloudflare-control-token-marker';

interface ControlFixture extends Record<string, unknown> {
  bucket: { success: boolean; errors: Array<{ code: number; message: string }>; result: { name: string } };
  managedDomain: { result: { enabled: boolean } };
  customDomains: { result: { domains: Array<{ domain: string; enabled: boolean }> } };
  lifecycle: { result: { rules: Array<{
    id: string;
    enabled: boolean;
    conditions: { prefix?: string };
    deleteObjectsTransition?: { condition: { type: string; maxAge: number } };
    abortMultipartUploadsTransition?: { condition: { type: string; maxAge: number } };
  }> } };
}

async function responseFixture(): Promise<ControlFixture> {
  return JSON.parse(await readFile(
    resolve('tests/fixtures/phase4a/r2-control-api.private.json'), 'utf8',
  )) as ControlFixture;
}

function args(overrides: Record<string, string> = {}): string[] {
  const values = {
    '--nonce': '018f6f7a-8f2a-7a3d-a123-123456789abc',
    '--source-revision': 'a'.repeat(40),
    '--account-id': ACCOUNT,
    '--bucket': BUCKET,
    '--endpoint': ENDPOINT,
    ...overrides,
  };
  return Object.entries(values).flat();
}

function fakeFetch(
  fixture: Record<string, unknown>,
  requests: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    const key = url.endsWith('/domains/managed') ? 'managedDomain'
      : url.endsWith('/domains/custom') ? 'customDomains'
        : url.endsWith('/lifecycle') ? 'lifecycle' : 'bucket';
    return new Response(JSON.stringify(fixture[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('P4A-I01 Cloudflare R2 control-plane attestor', () => {
  test('accepts the exact probe argv once and rejects missing, duplicate, unknown, or mismatched targets', () => {
    assert.deepEqual(parseAttestorArguments(args()), {
      nonce: '018f6f7a-8f2a-7a3d-a123-123456789abc',
      sourceRevision: 'a'.repeat(40), accountId: ACCOUNT, bucket: BUCKET, endpoint: ENDPOINT,
    });
    assert.throws(() => parseAttestorArguments(args().slice(0, -2)), /attestor_argument_missing/);
    assert.throws(() => parseAttestorArguments([...args(), '--bucket', BUCKET]), /attestor_argument_duplicate/);
    assert.throws(() => parseAttestorArguments([...args(), '--extra', 'x']), /attestor_argument_unknown/);
    assert.throws(() => parseAttestorArguments(args({ '--endpoint': 'https://example.com' })), /attestor_target_mismatch/);
    assert.throws(() => parseAttestorArguments(args({ '--account-id': 'f'.repeat(32) })), /attestor_target_mismatch/);
  });

  test('queries the live bucket, managed domain, custom domains, and lifecycle with one token', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const output = await runR2ControlAttestor(args(), {
      environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN },
      fetchImplementation: fakeFetch(await responseFixture(), requests),
    });
    assert.deepEqual(output, {
      schemaVersion: 3,
      nonce: '018f6f7a-8f2a-7a3d-a123-123456789abc',
      sourceRevision: 'a'.repeat(40),
      targetBinding: computeTargetBinding(ACCOUNT, BUCKET, ENDPOINT),
      verdictSource: 'cloudflare-control-api-live-query',
      provider: 'cloudflare-r2',
      accessMode: 'direct-object-api',
      bucketPrivate: true,
      customDomainEnabled: false,
      r2DevEnabled: false,
      managedEncryptionAtRest: 'cloudflare-provider-invariant',
      tlsRequired: true,
      writeCredentialScope: 'bucket-object-read-write',
      readCredentialScope: 'bucket-object-read-only',
      conditionalCreateContractRequired: true,
      providerPreventsUnconditionalOverwrite: false,
      retention: { probeObjectsMaximumAgeSeconds: 86400, quarantineAutomaticDeletion: false },
    });
    assert.equal(requests.length, 4);
    assert.ok(requests.every(({ init }) => init.method === 'GET'));
    assert.ok(requests.every(({ init }) => (init.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}`));
    assert.ok(requests.every(({ init }) => init.signal instanceof AbortSignal));
    assert.ok(requests.every(({ url }) => !url.includes(TOKEN)));
    const serialized = JSON.stringify(output);
    assert.equal([ACCOUNT, BUCKET, ENDPOINT, TOKEN].some((value) => serialized.includes(value)), false);
  });

  test('queries the fixed live Cloudflare endpoints for the bound target', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await runR2ControlAttestor(args(), {
      environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN },
      fetchImplementation: fakeFetch(await responseFixture(), requests),
    });
    const expected = [
      `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`,
      `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/managed`,
      `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/domains/custom`,
      `/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/lifecycle`,
    ];
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname).sort(), [...expected].sort());
    assert.ok(requests.every(({ url }) => url.startsWith('https://api.cloudflare.com/client/v4')));
    assert.ok(requests.every(({ init }) => (init.headers as Record<string, string>).Accept === 'application/json'));
  });

  test('fails closed on public exposure, active custom domains, lifecycle drift, or wrong bucket binding', async () => {
    for (const mutate of [
      (fixture: ControlFixture) => { fixture.managedDomain.result.enabled = true; },
      (fixture: ControlFixture) => { fixture.customDomains.result.domains = [{ domain: 'public.example', enabled: true }]; },
      (fixture: ControlFixture) => { fixture.lifecycle.result.rules[0]!.deleteObjectsTransition!.condition.maxAge = 86401; },
      (fixture: ControlFixture) => { fixture.lifecycle.result.rules.push({
        id: 'delete-quarantine', enabled: true, conditions: { prefix: 'quarantine/v1/' },
        deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604800 } },
      }); },
      (fixture: ControlFixture) => { fixture.bucket.result.name = 'wrong-bucket'; },
    ]) {
      const fixture = await responseFixture();
      mutate(fixture);
      await assert.rejects(() => runR2ControlAttestor(args(), {
        environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN }, fetchImplementation: fakeFetch(fixture, []),
      }));
    }
  });

  test('reports new Cloudflare API fields as contract drift, not provider rejection', async () => {
    const driftMutations = [
      (fixture: ControlFixture) => {
        (fixture.bucket.result as Record<string, unknown>).account_id = 'new-field';
      },
      (fixture: ControlFixture) => {
        (fixture.managedDomain.result as Record<string, unknown>).zone_id = 'new-field';
      },
      (fixture: ControlFixture) => {
        (fixture.lifecycle.result.rules[0] as Record<string, unknown>).new_rule_field = 'new-field';
      },
      (fixture: ControlFixture) => {
        (fixture.customDomains.result as { domains: Array<Record<string, unknown>> }).domains = [
          { domain: 'cdn.example', enabled: false, extra: 1 },
        ];
      },
    ];
    for (const mutate of driftMutations) {
      const fixture = await responseFixture();
      mutate(fixture);
      await assert.rejects(() => runR2ControlAttestor(args(), {
        environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN }, fetchImplementation: fakeFetch(fixture, []),
      }), /control_contract_drift/);
    }
    const envelope = await responseFixture();
    (envelope.bucket as Record<string, unknown>).next_page_cursor = 'abc';
    await assert.rejects(() => runR2ControlAttestor(args(), {
      environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN }, fetchImplementation: fakeFetch(envelope, []),
    }), /control_contract_drift/);
  });

  test('rejects API errors, malformed envelopes, pagination, timeout, and unknown response fields', async () => {
    const fixture = await responseFixture();
    fixture.bucket.success = false;
    fixture.bucket.errors = [{ code: 10000, message: `denied ${TOKEN}` }];
    await assert.rejects(() => runR2ControlAttestor(args(), {
      environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN }, fetchImplementation: fakeFetch(fixture, []),
    }), /control_api_unsuccessful/);

    for (const body of [
      '{',
      JSON.stringify({ success: true, errors: [], messages: [], result: {}, result_info: { total_pages: 2 } }),
      JSON.stringify({ success: true, errors: [], messages: [], result: {}, unexpected: true }),
    ]) {
      const malformedFetch = (async () => new Response(body, {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
      await assert.rejects(() => runR2ControlAttestor(args(), {
        environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN }, fetchImplementation: malformedFetch,
      }));
    }

    const timeoutFetch = (async () => { throw new DOMException(`aborted ${TOKEN}`, 'AbortError'); }) as typeof fetch;
    await assert.rejects(() => runR2ControlAttestor(args(), {
      environment: { [CONTROL_TOKEN_ENVIRONMENT]: TOKEN }, fetchImplementation: timeoutFetch,
    }), /control_api_timeout/);
  });

  test('requires only the dedicated control token and reduces errors to stable redacted codes', async () => {
    assert.equal(CONTROL_TOKEN_ENVIRONMENT, 'P4A_CLOUDFLARE_CONTROL_API_TOKEN');
    const fixture = await responseFixture();
    await assert.rejects(() => runR2ControlAttestor(args(), {
      environment: { P4A_R2_ACCESS_KEY_ID: 'must-not-be-consumed' },
      fetchImplementation: fakeFetch(fixture, []),
    }), /control_token_missing/);
    await assert.rejects(() => runR2ControlAttestor(args(), {
      environment: { [CONTROL_TOKEN_ENVIRONMENT]: 'short' },
      fetchImplementation: fakeFetch(fixture, []),
    }), /control_token_missing/);
    assert.ok(R2_CONTROL_ERROR_CODES.has(stableR2ControlErrorCode(new Error(`unknown ${TOKEN}`))));
    assert.equal(stableR2ControlErrorCode(new Error(`unknown ${TOKEN}`)), 'control_attestation_failed');
    assert.equal(stableR2ControlErrorCode(new Error('control_contract_drift')), 'control_contract_drift');
    assert.equal(JSON.stringify(fixture).includes(TOKEN), false);
  });
});
