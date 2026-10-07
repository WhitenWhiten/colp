import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { AliyunDirectMailAdapter } from '../../../src/infrastructure/email/aliyun-directmail-adapter.js';
import {
  EMAIL_ENTRY_FIXTURE_TAGS,
  loadEmailEntryReplayManifest,
  startEmailEntryFixture,
  type StartedEmailEntryFixture,
} from '../../../scripts/evidence/phase5-email-entry-fixture.js';
import { EMAIL_ADAPTER_PROBE_REQUIRED_ENV } from '../../../scripts/evidence/phase5-email-adapter-target-probe.js';
import { waitForCondition } from '../../support/async-test-helpers.js';

const backendRoot = resolve(import.meta.dirname, '../../..');
const probePath = resolve(backendRoot, 'scripts/evidence/phase5-email-adapter-target-probe.ts');

const CALLBACK_SECRET = `p528_callback_${'s'.repeat(8)}`;

describe('P5-28 email provider adapter against the P5-27 controlled fixture', () => {
  let fixture!: StartedEmailEntryFixture;
  let manifest!: ReturnType<typeof loadEmailEntryReplayManifest>;



  afterAll(async () => {
    await fixture.close();
  });

  function adapter(options: {
    readonly tagPrefix?: string;
    readonly timeoutMs?: number;
    readonly accessKeySecret?: string;
    readonly callbackHmacSecret?: string | null;
  } = {}): AliyunDirectMailAdapter {
    return new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: options.accessKeySecret ?? manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: options.timeoutMs ?? 2_000,
      tagPrefix: options.tagPrefix ?? 'p527-delivery-',
      maxTagChars: 128,
      fixtureTls: true,
      callbackHmacSecret: 'callbackHmacSecret' in options ? options.callbackHmacSecret : null,
      mnsCertificateFetcher: undefined,
    });
  }

  let message!: {
    to: string;
    subject: string;
    textBody: string;
  };

  beforeAll(async () => {
    manifest = loadEmailEntryReplayManifest();
    message = {
      to: manifest.fixedInputs.recipient,
      subject: manifest.fixedInputs.subjectMarker,
      textBody: manifest.fixedInputs.textBodyMarker,
    };
    fixture = await startEmailEntryFixture({
      accessKeyId: manifest.fixedInputs.accessKeyId,
      signingKeyMaterial: manifest.fixedInputs.signingKeyMaterial,
      sender: manifest.fixedInputs.sender,
      recipient: manifest.fixedInputs.recipient,
    });
  });

  test('adapter.send success returns EnvId classified success over real HTTPS', async () => {
    const client = adapter();
    try {
      const result = await client.send({ idempotencyKey: 'success', message });
      assert.equal(result.classification, 'success');
      assert.ok(result.providerMessageId && result.providerMessageId.startsWith('env-'));
      assert.ok(result.requestId && result.requestId.startsWith('req-'));
      assert.equal(result.errorCategory, null);
      assert.equal(fixture.sentTagCounts.get('p527-delivery-success'), 1);
    } finally {
      await client.close();
    }
  });

  test('frozen error scenarios classify through the adapter', async () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['throttling', 'retryable', 'dependency'],
      ['rateLimit429', 'retryable', 'dependency'],
      ['internalError', 'retryable', 'provider_unavailable'],
      ['serviceUnavailable', 'retryable', 'provider_unavailable'],
      ['invalidRecipient', 'permanent', 'invalid_contract'],
      ['senderNotFound', 'permanent', 'invalid_contract'],
    ];
    for (const [scenario, classification, category] of cases) {
      const client = adapter();
      try {
        // Adapter prepends tagPrefix to the idempotencyKey; feed the fixture tag
        // minus the prefix so the final TagName equals the fixture scenario tag.
        const fixtureTag = EMAIL_ENTRY_FIXTURE_TAGS[scenario as keyof typeof EMAIL_ENTRY_FIXTURE_TAGS];
        const result = await client.send({
          idempotencyKey: fixtureTag.slice('p527-delivery-'.length),
          message,
        });
        assert.equal(result.classification, classification, scenario);
        assert.equal(result.errorCategory, category, scenario);
        assert.equal(result.providerMessageId, null, scenario);
        assert.ok(result.redactedError && result.redactedError.length > 0, scenario);
      } finally {
        await client.close();
      }
    }
  });

  test('SignatureDoesNotMatch from a wrong signing key is permanent invalid_contract', async () => {
    const client = adapter({ accessKeySecret: 'P528-WRONG-SIGNING-KEY' });
    try {
      const result = await client.send({ idempotencyKey: 'success', message });
      assert.equal(result.classification, 'permanent');
      assert.equal(result.errorCategory, 'invalid_contract');
      assert.match(result.redactedError ?? '', /SignatureDoesNotMatch/u);
    } finally {
      await client.close();
    }
  });

  test('timeout against the fixture classifies retryable provider_unavailable', async () => {
    const slow = await startEmailEntryFixture({
      accessKeyId: manifest.fixedInputs.accessKeyId,
      signingKeyMaterial: manifest.fixedInputs.signingKeyMaterial,
      sender: manifest.fixedInputs.sender,
      recipient: manifest.fixedInputs.recipient,
      timeoutDelayMs: 5_000,
    });
    const client = new AliyunDirectMailAdapter({
      endpoint: slow.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 500,
      tagPrefix: 'p527-delivery-',
      maxTagChars: 128,
      fixtureTls: true,
    });
    try {
      const result = await client.send({ idempotencyKey: 'timeout', message });
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
      assert.match(result.redactedError ?? '', /timeout/iu);
    } finally {
      await client.close();
      await slow.close();
    }
  }, 20_000);

  test('provider unavailable: closed client and refused connection are retryable', async () => {
    const closed = adapter();
    await closed.close();
    const afterClose = await closed.send({ idempotencyKey: 'success', message });
    assert.equal(afterClose.classification, 'retryable');
    assert.equal(afterClose.errorCategory, 'provider_unavailable');

    const refused = new AliyunDirectMailAdapter({
      endpoint: 'https://127.0.0.1:1',
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 500,
      tagPrefix: 'p527-delivery-',
      maxTagChars: 128,
    });
    try {
      const result = await refused.send({ idempotencyKey: 'success', message });
      assert.equal(result.classification, 'retryable');
      assert.equal(result.errorCategory, 'provider_unavailable');
    } finally {
      await refused.close();
    }
  }, 20_000);

  test('reused idempotency key performs a retry attempt per the frozen contract', async () => {
    const client = adapter({ tagPrefix: 'p528-retry-' });
    try {
      const first = await client.send({ idempotencyKey: 'same', message });
      const second = await client.send({ idempotencyKey: 'same', message });
      assert.equal(first.classification, 'success');
      assert.equal(second.classification, 'success');
      assert.equal(fixture.sentTagCounts.get('p528-retry-same'), 2);
    } finally {
      await client.close();
    }
  });

  test('lookup reconciles Status 0 to delivered and unknown tags stay unknown', async () => {
    const client = adapter();
    try {
      const reconciled = await client.lookup({ idempotencyKey: 'reconciliation' });
      assert.equal(reconciled.classification, 'success');
      assert.equal(reconciled.outcome, 'delivered');
      assert.equal(reconciled.errorCategory, null);
      assert.equal(reconciled.errorClassification, 'SendOk');

      const noRow = await client.lookup({ idempotencyKey: 'success' });
      assert.equal(noRow.classification, 'unknown');
      assert.equal(noRow.outcome, 'unknown');
      assert.equal(noRow.errorCategory, null);
    } finally {
      await client.close();
    }
  });

  test('lookup aggregates ALL rows: conflict -> conflicting_facts, latest failure wins, paging completes delivered', async () => {
    const client = adapter();
    try {
      // Same TagName carries a delivered row AND a failed row with no provider
      // event time: order-independent aggregation must refuse to act (dead-letter
      // review) instead of suppressing the recipient on an unproven failure.
      const conflict = await client.lookup({ idempotencyKey: 'lookup-conflict' });
      assert.equal(conflict.classification, 'success');
      assert.equal(conflict.outcome, 'conflicting_facts');
      assert.equal(conflict.errorCategory, null);

      // Multiple failure rows with reliable times: the latest terminal wins
      // regardless of the provider array order.
      const multiFailure = await client.lookup({ idempotencyKey: 'lookup-multifailure' });
      assert.equal(multiFailure.classification, 'success');
      assert.equal(multiFailure.outcome, 'bounced');
      assert.equal(multiFailure.errorClassification, 'SmtpNxBox');

      // A full first page with a continuation token: the adapter must follow
      // the NextStart pagination and aggregate both pages.
      const paged = await client.lookup({ idempotencyKey: 'lookup-paged' });
      assert.equal(paged.classification, 'success');
      assert.equal(paged.outcome, 'delivered');
      assert.equal(paged.errorClassification, 'SendOk');
    } finally {
      await client.close();
    }
  });

  test('callback replay: the same EventBridge event verifies twice to identical stable facts', async () => {
    const client = adapter({ callbackHmacSecret: CALLBACK_SECRET });
    try {
      const raw = await fixture.readText('/__fixture/events/deliver-success');
      assert.equal(raw.status, 200);
      const body = raw.bodyText;
      const timestamp = new Date(Date.now() - 60_000).toISOString();
      const nonce = 'fixture-nonce-1';
      const signature = createHmac('sha256', CALLBACK_SECRET)
        .update(`${body}\n${timestamp}\n${nonce}`).digest('base64');
      const headers = {
        'x-known-dm-signature': signature,
        'x-known-dm-timestamp': timestamp,
        'x-known-dm-nonce': nonce,
        'content-type': 'application/json',
      };
      const first = await client.verifyCallback({ method: 'POST', url: 'https://dm.example/events', headers, body });
      const second = await client.verifyCallback({ method: 'POST', url: 'https://dm.example/events', headers, body });
      assert.deepEqual(first, second);
      assert.equal(first.kind, 'delivered');
      assert.equal(first.providerMessageId, '60000success');
      assert.equal(first.recipient, manifest.fixedInputs.recipient);
      assert.equal(first.tag, 'p527-delivery-success');

      const bounceRaw = await fixture.readText('/__fixture/events/deliver-bounce');
      const bounceBody = bounceRaw.bodyText;
      const bounceSignature = createHmac('sha256', CALLBACK_SECRET)
        .update(`${bounceBody}\n${timestamp}\n${nonce}`).digest('base64');
      const bounce = await client.verifyCallback({
        method: 'POST', url: 'https://dm.example/events',
        headers: { ...headers, 'x-known-dm-signature': bounceSignature },
        body: bounceBody,
      });
      assert.equal(bounce.kind, 'bounced');
    } finally {
      await client.close();
    }
  }, 20_000);

  test('client shutdown mid-request aborts cleanly and the send classifies provider_unavailable', async () => {
    const slow = await startEmailEntryFixture({
      accessKeyId: manifest.fixedInputs.accessKeyId,
      signingKeyMaterial: manifest.fixedInputs.signingKeyMaterial,
      sender: manifest.fixedInputs.sender,
      recipient: manifest.fixedInputs.recipient,
      timeoutDelayMs: 5_000,
    });
    const client = new AliyunDirectMailAdapter({
      endpoint: slow.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 10_000,
      tagPrefix: 'p527-delivery-',
      maxTagChars: 128,
      fixtureTls: true,
    });
    const started = performance.now();
    const pending = client.send({ idempotencyKey: 'timeout', message });
    await waitForCondition(
      () => (slow.sentTagCounts.get(EMAIL_ENTRY_FIXTURE_TAGS.timeout) ?? 0) > 0,
      { timeoutMs: 2_000, description: 'the controlled email fixture to receive the in-flight request' },
    );
    await client.close();
    const result = await pending;
    assert.equal(result.classification, 'retryable');
    assert.equal(result.errorCategory, 'provider_unavailable');
    assert.match(result.redactedError ?? '', /closed/iu);
    assert.ok(performance.now() - started < 4_000, 'close() must abort in-flight requests promptly');
    await slow.close();
  }, 20_000);

  test('adapter outputs and fixture records never leak secret or PII markers', async () => {
    const markerSecret = `p528_AKSECRET_${'x'.repeat(16)}`;
    const markerRecipient = 'p528-redaction@example.invalid';
    const markerSender = 'p528-sender@example.invalid';
    const isolated = await startEmailEntryFixture({
      accessKeyId: 'P528REDACTFIXTUREAK',
      signingKeyMaterial: markerSecret,
      sender: markerSender,
      recipient: markerRecipient,
    });
    const client = new AliyunDirectMailAdapter({
      endpoint: isolated.origin,
      regionId: 'cn-hangzhou',
      accountName: markerSender,
      accessKeyId: 'P528REDACTFIXTUREAK',
      accessKeySecret: markerSecret,
      timeoutMs: 1_000,
      tagPrefix: 'p528-redact-',
      maxTagChars: 128,
      fixtureTls: true,
      callbackHmacSecret: `p528_hmac_${'y'.repeat(12)}`,
    });
    try {
      const sendResult = await client.send({
        idempotencyKey: 'send', message: { to: markerRecipient, subject: 'P528-SUBJECT', textBody: 'P528-BODY' },
      });
      const lookupResult = await client.lookup({ idempotencyKey: 'send' });
      const serialized = JSON.stringify({ sendResult, lookupResult });
      for (const marker of [markerSecret, markerRecipient, markerSender, 'P528-SUBJECT', 'P528-BODY', 'P528REDACTFIXTUREAK']) {
        assert.doesNotMatch(serialized, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), marker);
      }
      const records = JSON.stringify(isolated.requestRecords);
      for (const marker of [markerSecret, markerRecipient, markerSender, 'P528-SUBJECT', 'P528-BODY', 'P528REDACTFIXTUREAK']) {
        assert.doesNotMatch(records, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), marker);
      }
    } finally {
      await client.close();
      await isolated.close();
    }
  }, 20_000);
});

describe('P5-28 real-target adapter probe CLI', () => {
  test('target mode fails closed (non-zero) without provider credentials', () => {
    const environment = { ...process.env };
    for (const name of EMAIL_ADAPTER_PROBE_REQUIRED_ENV) delete environment[name];
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', probePath, '--mode', 'target'],
      { cwd: backendRoot, env: environment, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    for (const name of EMAIL_ADAPTER_PROBE_REQUIRED_ENV) {
      assert.match(output, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
        `must name missing env ${name}`);
    }
    assert.doesNotMatch(output, /"classification"\s*:\s*"success"/u);
  }, 90_000);
});
